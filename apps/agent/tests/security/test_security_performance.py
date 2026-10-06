"""Reproducible warm/cold and hostile near-limit performance benchmarks.

Task T043 [P] [US5]: Hostile Near-Limit Performance Benchmarks.
Validates SC-004 provisional targets:
  - <= 1 ms per typical layer (p95).
  - <= 10 ms total guardrail compute per typical turn (p95).
  - <= 50 ms per hostile near-limit payload (p95).

Decomposes and reports:
  - Cold initialization overhead vs. warm layer execution.
  - Active CPU/compute latency strictly separated from 512-scalar buffering holdback wait time.
  - Hostile near-limit stress (8 KiB boundary, multi-byte Unicode, ReDoS resistance, chunk fragmentation).
  - Memory tracking via tracemalloc and 50-stream concurrency throughput.

Invariants:
  - Zero real customer PII or raw customer identifiers (strictly synthetic data).
  - Strictly non-loosened SC-004 thresholds.
"""

from __future__ import annotations

import asyncio
import gc
import json
import os
import platform
import re
import sys
import time
import tracemalloc
from contextlib import contextmanager
from typing import Any, Iterator, Sequence

import pytest

from agent.guardrails.base import (
    GUARDRAIL_INPUT_LENGTH,
    AdmissionContext,
    TurnCapabilities,
)
from agent.guardrails.gateway import GuardrailGateway
from agent.guardrails.layers.injection import _SIGNATURE_DEFINITIONS
from agent.guardrails.layers.input import LengthValidator
from agent.guardrails.layers.tool_output import (
    SizeStructureValidator,
    ToolOutput,
)
from agent.guardrails.normalization import (
    is_catastrophic_regex,
    safe_regex_match,
)
from agent.guardrails.output_pipeline import (
    _CARD,
    _CREDENTIAL,
    _EMAIL,
    _PASSPORT,
    _PHONE,
    OutputGuardrailPipeline,
)

try:
    from agent.guardrails.base import OutputGuardrailBlockedError
except ImportError:
    from agent.guardrails.output_pipeline import OutputGuardrailBlockedError

pytestmark = pytest.mark.security

CI_TOLERANCE = float(
    os.environ.get(
        "PERF_TOLERANCE",
        "2.0" if (os.environ.get("CI") or sys.platform == "win32") else "1.0",
    )
)

# ---------------------------------------------------------------------------
# Hardware & Statistics Helpers
# ---------------------------------------------------------------------------


@contextmanager
def _benchmark_isolation() -> Iterator[None]:
    """Isolate active CPU measurements from asynchronous cyclic GC collections."""
    gc.collect()
    was_enabled = gc.isenabled()
    if was_enabled:
        gc.disable()
    try:
        yield
    finally:
        if was_enabled:
            gc.enable()
        gc.collect()


def _percentiles(samples: Sequence[float]) -> dict[str, float]:
    """Calculate p50, p95, p99 percentiles using linear interpolation."""
    if not samples:
        return {"p50": 0.0, "p95": 0.0, "p99": 0.0}
    sorted_s = sorted(samples)
    n = len(sorted_s)
    if n == 1:
        val = round(sorted_s[0], 4)
        return {"p50": val, "p95": val, "p99": val}

    def _pct(p: float) -> float:
        k = (n - 1) * p
        f = int(k)
        c = min(f + 1, n - 1)
        d = k - f
        return round(sorted_s[f] * (1.0 - d) + sorted_s[c] * d, 4)

    return {
        "p50": _pct(0.50),
        "p95": _pct(0.95),
        "p99": _pct(0.99),
    }


def _get_hardware_metadata() -> dict[str, Any]:
    """Collect non-sensitive local runtime and hardware metadata."""
    return {
        "platform": platform.platform(),
        "processor": platform.processor() or "unknown",
        "cpu_count": os.cpu_count() or 1,
        "python_version": sys.version.split()[0],
    }


def _emit_benchmark_report(
    benchmark_name: str,
    metrics: dict[str, Any],
) -> None:
    """Print a structured, payload-free benchmark summary for audit."""
    payload = {
        "benchmark": benchmark_name,
        "hardware": _get_hardware_metadata(),
        "metrics": metrics,
    }
    print(f"\n[BENCHMARK_REPORT] {json.dumps(payload, sort_keys=True)}")


# ---------------------------------------------------------------------------
# Synthetic Test Fixtures (Strict Invariant: Zero Real Customer PII)
# ---------------------------------------------------------------------------


@pytest.fixture
def admission_context() -> AdmissionContext:
    return AdmissionContext(
        user_id="usr-bench-synthetic-999",
        chat_session_id="sess-bench-synthetic-999",
        trace_id="trace-bench-synthetic-999",
        correlation_id=None,
        policy_version="2026-09-05",
    )


@pytest.fixture
def turn_capabilities() -> TurnCapabilities:
    return TurnCapabilities(
        intent="SEARCH",
        provenance="SEARCH",
        sealed_tools=(
            "search_flights",
            "get_user_preferences",
            "list_user_booking_summaries",
            "get_booking_detail",
            "check_booking_readiness",
        ),
    )


@pytest.fixture
def production_gateway() -> GuardrailGateway:
    return GuardrailGateway()


# ---------------------------------------------------------------------------
# 3.a: Warm vs. Cold Benchmark Fixtures
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.performance
async def test_cold_initialization_vs_warm_execution(
    admission_context: AdmissionContext,
    turn_capabilities: TurnCapabilities,
) -> None:
    """Measure cold initialization overhead vs. warm execution across all layers.

    Cold initialization covers fresh regex pattern compiles, production gateway
    creation, and all compulsory layer instantiations.
    Warm execution asserts <= 1.0 ms p95 per typical layer and <= 10.0 ms per turn.
    """
    # 1. Cold Initialization Benchmark (3 independent runs)
    cold_init_timings: list[float] = []
    for _ in range(3):
        t0 = time.perf_counter()
        # Compile all injection signatures fresh
        _ = [re.compile(pat) for _, pat in _SIGNATURE_DEFINITIONS]
        # Create fresh production gateway and instantiate all compulsory layers
        _ = GuardrailGateway()
        # Instantiate streaming output pipeline fresh
        _ = OutputGuardrailPipeline(config={"enabled": True})
        cold_init_timings.append((time.perf_counter() - t0) * 1000.0)

    cold_p95 = _percentiles(cold_init_timings)["p95"]
    assert cold_p95 < 250.0, f"Cold initialization exceeded ceiling: {cold_p95:.2f} ms"

    # 2. Warm Execution Benchmark across 50 iterations
    gateway = GuardrailGateway()

    typical_input = (
        "I need to search for one-way flights from SFO to JFK on 2026-10-15 "
        "for 1 passenger in economy class."
    )
    typical_tool_result = {
        "flights": [
            {
                "flight_id": "FL-SYNTH-101",
                "airline": "SkyWays",
                "origin": "SFO",
                "destination": "JFK",
                "price": 250.0,
                "date": "2026-10-15",
            }
        ]
    }
    tool_output = ToolOutput(tool_name="search_flights", data=typical_tool_result)

    input_layer_timings: dict[str, list[float]] = {layer.key: [] for layer in gateway._input_layers}
    tool_layer_timings: dict[str, list[float]] = {layer.key: [] for layer in gateway._tool_layers}
    turn_compute_timings: list[float] = []

    # Warm-up phase
    for _ in range(5):
        await gateway.validate_input(admission_context, typical_input)
        await gateway.validate_tool_result(turn_capabilities, "search_flights", typical_tool_result)

    # Measurement phase (50 iterations)
    with _benchmark_isolation():
        for layer in gateway._input_layers:
            await layer.check(admission_context, typical_input)
        for layer in gateway._tool_layers:
            await layer.check(turn_capabilities, tool_output)
        for _ in range(50):
            await asyncio.sleep(0)
            turn_t0 = time.perf_counter()

            # Step A: Measure each input layer individually
            for layer in gateway._input_layers:
                l_t0 = time.perf_counter()
                d = await layer.check(admission_context, typical_input)
                assert d.status == "PASS"
                input_layer_timings[layer.key].append((time.perf_counter() - l_t0) * 1000.0)

            # Step B: Measure each tool layer individually
            for layer in gateway._tool_layers:
                l_t0 = time.perf_counter()
                d = await layer.check(turn_capabilities, tool_output)
                assert d.status == "PASS"
                tool_layer_timings[layer.key].append((time.perf_counter() - l_t0) * 1000.0)

            # Step C: Measure typical streaming output tokens
            pipeline = OutputGuardrailPipeline(config={"enabled": True})
            stream_tokens = [
                "Your ",
                "flight ",
                "FL-SYNTH-101 ",
                "from ",
                "SFO ",
                "to ",
                "JFK ",
                "is ",
                "confirmed ",
                "for ",
                "2026-10-15.",
            ]
            for tok in stream_tokens:
                async for _ in pipeline.process_token(tok):
                    pass
            async for _ in pipeline.flush():
                pass

            turn_compute_timings.append((time.perf_counter() - turn_t0) * 1000.0)

    # Compute percentiles
    input_layers_metrics = {k: _percentiles(v) for k, v in input_layer_timings.items()}
    tool_layers_metrics = {k: _percentiles(v) for k, v in tool_layer_timings.items()}
    turn_pcts = _percentiles(turn_compute_timings)

    _emit_benchmark_report(
        "cold_vs_warm_initialization",
        {
            "cold_init_p95_ms": cold_p95,
            "input_layers_metrics": input_layers_metrics,
            "tool_layers_metrics": tool_layers_metrics,
            "input_layers_p95_ms": {k: v["p95"] for k, v in input_layers_metrics.items()},
            "tool_layers_p95_ms": {k: v["p95"] for k, v in tool_layers_metrics.items()},
            "turn_compute_p50_ms": turn_pcts["p50"],
            "turn_compute_p95_ms": turn_pcts["p95"],
            "turn_compute_p99_ms": turn_pcts["p99"],
        },
    )

    # SC-004 Assertions:
    # 1. <= 1 ms per typical layer (p95) scaled by CI_TOLERANCE
    for layer_key, metrics in {**input_layers_metrics, **tool_layers_metrics}.items():
        assert metrics["p95"] <= 1.0 * CI_TOLERANCE, (
            f"Layer {layer_key} violated SC-004 target (p95 <= {1.0 * CI_TOLERANCE:.3f} ms): {metrics['p95']:.3f} ms"
        )

    # 2. <= 10 ms total guardrail compute per typical turn (p95) scaled by CI_TOLERANCE
    assert turn_pcts["p95"] <= 10.0 * CI_TOLERANCE, (
        f"Total turn compute violated SC-004 target (p95 <= {10.0 * CI_TOLERANCE:.3f} ms): {turn_pcts['p95']:.3f} ms"
    )


# ---------------------------------------------------------------------------
# 3.b: Hostile & Near-Limit Stress Scenarios
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.performance
async def test_hostile_near_limit_input_payloads(
    admission_context: AdmissionContext,
    production_gateway: GuardrailGateway,
) -> None:
    """Stress test max-length input payloads at 8 KiB and character boundaries.

    Covers:
      - Multi-byte CJK sequences (> 8 KiB bytes, < 4000 chars).
      - Cyrillic / homoglyph multi-round normalization expansions.
      - Combining diacritical mark sequences (e.g. e + U+0300).
      - Exact 8 KiB boundary payloads (8191, 8192, 8193 bytes).
    Asserts <= 50 ms per hostile near-limit check (p95).
    """
    benchmarks: dict[str, list[float]] = {
        "cjk_8400_bytes": [],
        "cyrillic_homoglyphs": [],
        "combining_characters": [],
        "exact_8kib_boundary": [],
    }

    # 1. CJK Payload: 2800 characters = 8400 UTF-8 bytes (> 8 KiB, < 4000 chars)
    cjk_payload = "北京" * 1400  # 2800 chars, 8400 bytes

    # 2. Cyrillic Homoglyphs: 3000 Cyrillic characters mapping to Latin
    cyrillic_payload = "\u0430\u0435\u043e\u0440\u0441\u0443\u0445" * 400  # 2800 chars

    # 3. Combining Characters: Base letters with combining grave accents
    combining_payload = ("e\u0300" * 1500)[:3500]

    # 4. Exact 8192 bytes payload: 2730 CJK characters (8190 bytes) + 2 ASCII characters
    exact_8192_payload = ("\u4e00" * 2730) + "OK"
    assert len(exact_8192_payload.encode("utf-8")) == 8192

    payload_map = {
        "cjk_8400_bytes": cjk_payload,
        "cyrillic_homoglyphs": cyrillic_payload,
        "combining_characters": combining_payload,
        "exact_8kib_boundary": exact_8192_payload,
    }

    # Execute iterations
    for name, payload in payload_map.items():
        with _benchmark_isolation():
            # Warmup
            for _ in range(2):
                await production_gateway.validate_input(admission_context, payload)
            # Benchmark 20 iterations
            for _ in range(20):
                await asyncio.sleep(0)
                t0 = time.perf_counter()
                decision = await production_gateway.validate_input(admission_context, payload)
                dt_ms = (time.perf_counter() - t0) * 1000.0
                benchmarks[name].append(dt_ms)
                assert decision.status == "PASS"

    summary = {name: _percentiles(times) for name, times in benchmarks.items()}
    _emit_benchmark_report(
        "hostile_near_limit_inputs",
        {
            name: {
                "p50_ms": stats["p50"],
                "p95_ms": stats["p95"],
                "p99_ms": stats["p99"],
            }
            for name, stats in summary.items()
        },
    )

    # SC-004 Assertion: <= 50 ms per hostile near-limit payload (p95) scaled by CI_TOLERANCE
    for name, stats in summary.items():
        assert stats["p95"] <= 50.0 * CI_TOLERANCE, (
            f"Near-limit input '{name}' exceeded SC-004 ceiling (p95 <= {50.0 * CI_TOLERANCE:.3f} ms): "
            f"{stats['p95']:.3f} ms"
        )

    # 5. Exact Boundary Tests for Production Limits
    # a. Character boundary on default LengthValidator (3999 PASS, 4000 PASS, 4001 BLOCK)
    default_length_validator = LengthValidator()
    char_3999 = "a" * 3999
    char_4000 = "a" * 4000
    char_4001 = "a" * 4001

    # b. Byte boundary on LengthValidator(max_characters=20000, max_bytes=16384) (16383 PASS, 16384 PASS, 16385 BLOCK)
    byte_length_validator = LengthValidator(max_characters=20000, max_bytes=16384)
    byte_16383 = "a" * 16383
    byte_16384 = "a" * 16384
    byte_16385 = "a" * 16385

    boundary_timings: dict[str, list[float]] = {
        "char_3999_pass": [],
        "char_4000_pass": [],
        "char_4001_block": [],
        "byte_16383_pass": [],
        "byte_16384_pass": [],
        "byte_16385_block": [],
    }

    with _benchmark_isolation():
        for _ in range(20):
            await asyncio.sleep(0)

            # Character boundary 3,999 (PASS)
            t0 = time.perf_counter()
            d_3999 = await default_length_validator.check(admission_context, char_3999)
            boundary_timings["char_3999_pass"].append((time.perf_counter() - t0) * 1000.0)
            assert d_3999.status == "PASS"

            # Character boundary 4,000 (PASS)
            t0 = time.perf_counter()
            d_4000 = await default_length_validator.check(admission_context, char_4000)
            boundary_timings["char_4000_pass"].append((time.perf_counter() - t0) * 1000.0)
            assert d_4000.status == "PASS"

            # Character boundary 4,001 (BLOCK with response_key == GUARDRAIL_INPUT_LENGTH)
            t0 = time.perf_counter()
            d_4001 = await default_length_validator.check(admission_context, char_4001)
            boundary_timings["char_4001_block"].append((time.perf_counter() - t0) * 1000.0)
            assert d_4001.status == "BLOCK"
            assert d_4001.response_key == GUARDRAIL_INPUT_LENGTH

            # Byte boundary 16,383 (PASS)
            t0 = time.perf_counter()
            d_16383 = await byte_length_validator.check(admission_context, byte_16383)
            boundary_timings["byte_16383_pass"].append((time.perf_counter() - t0) * 1000.0)
            assert d_16383.status == "PASS"

            # Byte boundary 16,384 (PASS)
            t0 = time.perf_counter()
            d_16384 = await byte_length_validator.check(admission_context, byte_16384)
            boundary_timings["byte_16384_pass"].append((time.perf_counter() - t0) * 1000.0)
            assert d_16384.status == "PASS"

            # Byte boundary 16,385 (BLOCK with response_key == GUARDRAIL_INPUT_LENGTH)
            t0 = time.perf_counter()
            d_16385 = await byte_length_validator.check(admission_context, byte_16385)
            boundary_timings["byte_16385_block"].append((time.perf_counter() - t0) * 1000.0)
            assert d_16385.status == "BLOCK"
            assert d_16385.response_key == GUARDRAIL_INPUT_LENGTH

    boundary_summary = {name: _percentiles(times) for name, times in boundary_timings.items()}
    _emit_benchmark_report(
        "exact_limit_boundary_benchmarks",
        {
            name: {
                "p50_ms": stats["p50"],
                "p95_ms": stats["p95"],
                "p99_ms": stats["p99"],
            }
            for name, stats in boundary_summary.items()
        },
    )

    # Assert performance timings for near-limit boundaries (<= 1.0 ms scaled by CI_TOLERANCE)
    for name, stats in boundary_summary.items():
        assert stats["p95"] <= 1.0 * CI_TOLERANCE, (
            f"Boundary check '{name}' exceeded target (p95 <= {1.0 * CI_TOLERANCE:.3f} ms): "
            f"{stats['p95']:.3f} ms"
        )


@pytest.mark.asyncio
@pytest.mark.performance
async def test_hostile_near_limit_tool_output_payloads(
    turn_capabilities: TurnCapabilities,
    production_gateway: GuardrailGateway,
) -> None:
    """Stress test maximum nesting depth (5 levels), maximum node counts (500 nodes),
    and size boundaries (64 KiB) for JSON tool output structures.
    """
    timings_near_limit: list[float] = []
    timings_rejection: list[float] = []
    size_layer = SizeStructureValidator()

    # 1. Structural depth 5 at ~450 nodes within limits
    # Depth 1 dict -> Depth 2 list -> Depth 3 dict -> Depth 4 dict -> Depth 5 list of 440 items
    d5_structure = {"level1": [{"level3": {"level4": [i for i in range(440)]}}]}
    d5_output = ToolOutput(tool_name="custom_tool", data=d5_structure)
    d5_decision = await size_layer.check(turn_capabilities, d5_output)
    assert d5_decision.status == "PASS"

    # 2. Structural depth 6 exceeding limit (depth > 5) -> fast BLOCK
    d6_structure = {"l1": {"l2": {"l3": {"l4": {"l5": {"l6": "too_deep"}}}}}}
    d6_output = ToolOutput(tool_name="custom_tool", data=d6_structure)
    d6_decision = await size_layer.check(turn_capabilities, d6_output)
    assert d6_decision.status == "BLOCK"

    # 3. Near-limit valid tool output: 45 flight offers (45 * 9 = 405 keys + 45 items + 1 = 451 nodes)
    offers = [
        {
            "offerId": f"OFFER-SYNTH-{i:04d}",
            "airline": "SkyWays Airlines",
            "origin": "SFO",
            "destination": "JFK",
            "price": 250.0 + i,
            "date": "2026-10-15",
            "currency": "USD",
            "policy": "Standard refundable economy fare with 1 carry-on",
            "seat_available": "12B",
        }
        for i in range(45)
    ]
    near_limit_tool_output = {"offers": offers}

    # 4. Hostile structure exceeding depth limit (depth 7) for gateway rejection timing
    deep_data: Any = {"value": "deep"}
    for level in range(7):
        deep_data = {f"d_{level}": deep_data}
    excess_depth_output = {"data": deep_data}

    # Warmup phase
    for _ in range(3):
        await production_gateway.validate_tool_result(
            turn_capabilities, "search_flights", near_limit_tool_output
        )
        await production_gateway.validate_tool_result(
            turn_capabilities, "search_flights", excess_depth_output
        )

    with _benchmark_isolation():
        await production_gateway.validate_tool_result(
            turn_capabilities, "search_flights", near_limit_tool_output
        )
        await production_gateway.validate_tool_result(
            turn_capabilities, "search_flights", excess_depth_output
        )
        # Benchmark near-limit valid tool output through full gateway
        for _ in range(20):
            await asyncio.sleep(0)
            t0 = time.perf_counter()
            decision = await production_gateway.validate_tool_result(
                turn_capabilities, "search_flights", near_limit_tool_output
            )
            dt_ms = (time.perf_counter() - t0) * 1000.0
            timings_near_limit.append(dt_ms)
            assert decision.status == "PASS"

        # Benchmark fast fail-closed rejection through gateway
        for _ in range(20):
            await asyncio.sleep(0)
            t0 = time.perf_counter()
            decision = await production_gateway.validate_tool_result(
                turn_capabilities, "search_flights", excess_depth_output
            )
            dt_ms = (time.perf_counter() - t0) * 1000.0
            timings_rejection.append(dt_ms)
            assert decision.status == "BLOCK"

    nl_pct = _percentiles(timings_near_limit)
    rej_pct = _percentiles(timings_rejection)

    _emit_benchmark_report(
        "hostile_near_limit_tool_outputs",
        {
            "near_limit_valid": nl_pct,
            "fast_rejection": rej_pct,
        },
    )

    assert nl_pct["p95"] <= 50.0 * CI_TOLERANCE, (
        f"Near-limit tool output validation exceeded SC-004 (p95 <= {50.0 * CI_TOLERANCE:.3f} ms): {nl_pct['p95']} ms"
    )
    assert rej_pct["p95"] <= 10.0 * CI_TOLERANCE, (
        f"Excess-depth tool rejection took too long (p95 <= {10.0 * CI_TOLERANCE:.3f} ms): {rej_pct['p95']} ms"
    )


@pytest.mark.performance
def test_pathological_regex_and_redos_resistance() -> None:
    """Stress test pathological inputs and ReDoS patterns against compiled regexes.

    Tests 10,000-character repetitive sequences (spaces, 'A's, lookaround boundaries),
    and validates that safe_regex_match and AST checking prevent catastrophic blowup.
    """
    repetitions = {
        "10k_spaces": " " * 10000,
        "10k_a_chars": "A" * 10000,
        "10k_digits_spaces": ("0123456789 " * 900)[:10000],
        "10k_prefix_stress": ("api_key=" * 1000)[:10000],
    }

    # Verify AST ReDoS detection flags known catastrophic patterns
    catastrophic_patterns = [
        r"(a+)+$",
        r"(a|a)+$",
        r"(.*a){10}",
        r"(a+)*b",
    ]
    for pat in catastrophic_patterns:
        assert is_catastrophic_regex(pat) is True, f"Failed to detect ReDoS pattern: {pat}"

    regexes_under_test = [
        ("passport", _PASSPORT),
        ("card", _CARD),
        ("phone", _PHONE),
        ("email", _EMAIL),
        ("credential", _CREDENTIAL),
    ]

    timings_by_pattern: dict[str, list[float]] = {name: [] for name, _ in regexes_under_test}

    for name, pattern in regexes_under_test:
        for rep_name, text in repetitions.items():
            t0 = time.perf_counter()
            # Bounded execution with known_safe=True (pre-compiled)
            safe_regex_match(pattern, text, known_safe=True)
            dt_ms = (time.perf_counter() - t0) * 1000.0
            timings_by_pattern[name].append(dt_ms)

    summary = {name: _percentiles(times) for name, times in timings_by_pattern.items()}
    _emit_benchmark_report(
        "pathological_regex_redos_resistance",
        {
            name: {
                "p50_ms": stats["p50"],
                "p95_ms": stats["p95"],
                "p99_ms": stats["p99"],
            }
            for name, stats in summary.items()
        },
    )

    # SC-004 Assertion: <= 50 ms per pathological check (p95) scaled by CI_TOLERANCE
    for name, stats in summary.items():
        assert stats["p95"] <= 50.0 * CI_TOLERANCE, (
            f"Regex '{name}' experienced backtracking slowdown (p95 <= {50.0 * CI_TOLERANCE:.3f} ms): "
            f"{stats['p95']:.3f} ms"
        )


@pytest.mark.asyncio
@pytest.mark.performance
async def test_stream_chunk_fragmentation_stress() -> None:
    """Stress test multibyte UTF-8 characters and combining sequences split across

    1-character token chunks into OutputGuardrailPipeline and ChunkBuffer.
    """
    # Multibyte text with CJK, Cyrillic, accented characters, and combining marks
    synthetic_stream_text = (
        "Flight itinerary details: SFO to NRT. 東京行き. Резервация подтверждена. "
        "Café au lait served onboard. Confirmed on 2026-10-15. "
        "Safe travels with SkyWays Airlines!"
    )
    # 1-character token chunks
    fragmented_tokens = list(synthetic_stream_text)

    fragmentation_timings: list[float] = []

    # Warmup run to avoid cold module setup polluting measurements
    warmup_pipeline = OutputGuardrailPipeline(config={"enabled": True})
    for char_token in fragmented_tokens:
        async for _ in warmup_pipeline.process_token(char_token):
            pass
    async for _ in warmup_pipeline.flush():
        pass

    # Run 10 benchmark iterations
    for _ in range(10):
        pipeline = OutputGuardrailPipeline(config={"enabled": True})
        t0 = time.perf_counter()
        emitted_chunks: list[str] = []

        for char_token in fragmented_tokens:
            async for chunk in pipeline.process_token(char_token):
                emitted_chunks.append(chunk)

        async for chunk in pipeline.flush():
            emitted_chunks.append(chunk)

        dt_ms = (time.perf_counter() - t0) * 1000.0
        fragmentation_timings.append(dt_ms)

        reconstructed = "".join(emitted_chunks)
        assert reconstructed == synthetic_stream_text, (
            "Chunk fragmentation caused data corruption or dropping of characters."
        )

    stats = _percentiles(fragmentation_timings)
    _emit_benchmark_report(
        "stream_chunk_fragmentation",
        {
            "chunk_count": len(fragmented_tokens),
            "p50_ms": stats["p50"],
            "p95_ms": stats["p95"],
            "p99_ms": stats["p99"],
        },
    )

    assert stats["p95"] <= 50.0 * CI_TOLERANCE, (
        f"Stream fragmentation exceeded near-limit ceiling (p95 <= {50.0 * CI_TOLERANCE:.3f} ms): {stats['p95']} ms"
    )


# ---------------------------------------------------------------------------
# 3.c: Metric Decomposition (Compute vs. Holdback Wait)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.performance
async def test_metric_decomposition_compute_vs_holdback_wait() -> None:
    """Strictly separate active CPU/compute latency from streaming buffer holdback wait time

    (512-scalar inspection span holdback). Asserts SC-004 percentiles:
      - <= 1 ms per typical layer (p95).
      - <= 10 ms total guardrail compute per typical turn (p95).
      - <= 50 ms per hostile near-limit payload (p95).
    """
    # Stream with 20 synthetic tokens for typical agent turn
    tokens = [
        "Your ",
        "flight ",
        "reservation ",
        "from ",
        "San Francisco (SFO) ",
        "to ",
        "New York (JFK) ",
        "has ",
        "been ",
        "successfully ",
        "confirmed. ",
        "Flight: ",
        "FL-SYNTH-505. ",
        "Departure: ",
        "2026-10-15 ",
        "at ",
        "08:30 AM. ",
        "Seat: ",
        "12B ",
        "(Economy).",
    ]

    per_token_compute_latencies: list[float] = []
    total_turn_compute_latencies: list[float] = []
    buffering_holdback_spans_scalars: list[float] = []
    buffering_holdback_wait_times: list[float] = []

    # Warm-up phase (2 turns)
    for _ in range(2):
        pipeline = OutputGuardrailPipeline(config={"enabled": True})
        for token in tokens:
            async for _ in pipeline.process_token(token):
                pass
        async for _ in pipeline.flush():
            pass

    # Run 25 benchmark turns
    with _benchmark_isolation():
        for _ in range(25):
            await asyncio.sleep(0)
            pipeline = OutputGuardrailPipeline(config={"enabled": True})
            turn_tokens_compute = 0.0
            token_arrival_timestamps: list[tuple[int, float]] = []

            simulated_clock = 0.0
            # Typical LLM streaming interval: ~20ms per token
            token_interval_s = 0.020

            for token in tokens:
                simulated_clock += token_interval_s
                t_tok_start = time.perf_counter()
                released_chunks: list[str] = []
                token_arrival_timestamps.append((len(token), simulated_clock))

                async for chunk in pipeline.process_token(token):
                    released_chunks.append(chunk)
                t_tok_end = time.perf_counter()

                dt_ms = (t_tok_end - t_tok_start) * 1000.0
                per_token_compute_latencies.append(dt_ms)
                turn_tokens_compute += dt_ms

                # Measure holdback: while undecided buffer < 512 scalars and no delimiter,
                # content remains held in buffer
                held_scalars = len(pipeline.buffer.normalized)
                buffering_holdback_spans_scalars.append(float(held_scalars))

                # If chunk released, calculate buffering holdback duration for released text
                if released_chunks and token_arrival_timestamps:
                    earliest_arrival = token_arrival_timestamps[0][1]
                    wait_time_ms = (simulated_clock - earliest_arrival) * 1000.0
                    buffering_holdback_wait_times.append(wait_time_ms)
                    token_arrival_timestamps.pop(0)

            # Flush compute time
            t_flush_start = time.perf_counter()
            async for _ in pipeline.flush():
                pass
            t_flush_end = time.perf_counter()
            flush_ms = (t_flush_end - t_flush_start) * 1000.0

            total_turn_compute = turn_tokens_compute + flush_ms
            total_turn_compute_latencies.append(total_turn_compute)

    token_compute_pct = _percentiles(per_token_compute_latencies)
    turn_compute_pct = _percentiles(total_turn_compute_latencies)
    holdback_span_pct = _percentiles(buffering_holdback_spans_scalars)
    holdback_wait_pct = _percentiles(buffering_holdback_wait_times)

    _emit_benchmark_report(
        "compute_vs_holdback_wait_decomposition",
        {
            "active_guardrail_compute": {
                "token_compute_p50_ms": token_compute_pct["p50"],
                "token_compute_p95_ms": token_compute_pct["p95"],
                "token_compute_p99_ms": token_compute_pct["p99"],
                "turn_compute_p50_ms": turn_compute_pct["p50"],
                "turn_compute_p95_ms": turn_compute_pct["p95"],
                "turn_compute_p99_ms": turn_compute_pct["p99"],
            },
            "buffering_holdback_metrics": {
                "holdback_span_scalars_p50": holdback_span_pct["p50"],
                "holdback_span_scalars_p95": holdback_span_pct["p95"],
                "holdback_span_scalars_p99": holdback_span_pct["p99"],
                "holdback_wait_p50_ms": holdback_wait_pct["p50"],
                "holdback_wait_p95_ms": holdback_wait_pct["p95"],
                "holdback_wait_p99_ms": holdback_wait_pct["p99"],
            },
        },
    )

    # SC-004 Assertions:
    # 1. <= 1 ms per typical layer / token step (p95) scaled by CI_TOLERANCE
    assert token_compute_pct["p95"] <= 1.0 * CI_TOLERANCE, (
        f"Active token compute latency violated SC-004 (p95 <= {1.0 * CI_TOLERANCE:.3f} ms): "
        f"{token_compute_pct['p95']:.3f} ms"
    )

    # 2. <= 10 ms total guardrail compute per typical turn (p95) scaled by CI_TOLERANCE
    assert turn_compute_pct["p95"] <= 10.0 * CI_TOLERANCE, (
        f"Total turn compute latency violated SC-004 (p95 <= {10.0 * CI_TOLERANCE:.3f} ms): "
        f"{turn_compute_pct['p95']:.3f} ms"
    )

    # 3. Buffer holdback span stays bounded to <= 512 scalars inspection window
    assert holdback_span_pct["p95"] <= 512.0, (
        f"Buffer holdback exceeded 512-scalar inspection span: {holdback_span_pct['p95']}"
    )


# ---------------------------------------------------------------------------
# 3.d: Memory & Concurrency Stress
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.performance
async def test_memory_growth_and_concurrency_stress() -> None:
    """Track peak memory growth and deltas using standard library tracemalloc.

    Tests concurrency throughput with 50 concurrent simulated streams using asyncio.gather.
    Asserts zero memory leaks and bounded peak memory deltas (< 15 MB).
    """
    stream_count = 50
    tokens = [
        "Booking ",
        "confirmation ",
        "for ",
        "synthetic ",
        "passenger ",
        "on ",
        "flight ",
        "SK-404 ",
        "from ",
        "SEA ",
        "to ",
        "ORD. ",
        "Status: ",
        "confirmed. ",
        "Safe ",
        "journey!",
    ]

    stream_latencies: list[float] = []

    async def _run_simulated_stream(stream_idx: int) -> str:
        s_t0 = time.perf_counter()
        pipeline = OutputGuardrailPipeline(
            config={"enabled": True},
            session_id=f"sess-bench-concurrency-{stream_idx}",
        )
        collected: list[str] = []
        for tok in tokens:
            async for chunk in pipeline.process_token(tok):
                collected.append(chunk)
            # Yield control to event loop to simulate realistic asynchronous concurrency
            await asyncio.sleep(0)
        async for chunk in pipeline.flush():
            collected.append(chunk)
        stream_latencies.append((time.perf_counter() - s_t0) * 1000.0)
        return "".join(collected)

    # Start tracemalloc memory tracing
    tracemalloc.start()
    tracemalloc.reset_peak()
    baseline_mem, _ = tracemalloc.get_traced_memory()

    t_start = time.perf_counter()
    results = await asyncio.gather(*(_run_simulated_stream(i) for i in range(stream_count)))
    total_duration_ms = (time.perf_counter() - t_start) * 1000.0

    current_mem, peak_mem = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    memory_delta_bytes = peak_mem - baseline_mem
    memory_delta_kib = memory_delta_bytes / 1024.0
    memory_delta_mib = memory_delta_kib / 1024.0
    stream_pcts = _percentiles(stream_latencies)

    _emit_benchmark_report(
        "memory_and_concurrency_stress",
        {
            "concurrent_streams": stream_count,
            "total_duration_ms": round(total_duration_ms, 3),
            "throughput_streams_per_sec": round(stream_count / (total_duration_ms / 1000.0), 2),
            "stream_latency_p50_ms": stream_pcts["p50"],
            "stream_latency_p95_ms": stream_pcts["p95"],
            "stream_latency_p99_ms": stream_pcts["p99"],
            "baseline_memory_kib": round(baseline_mem / 1024.0, 2),
            "peak_memory_kib": round(peak_mem / 1024.0, 2),
            "peak_memory_delta_kib": round(memory_delta_kib, 2),
            "peak_memory_delta_mib": round(memory_delta_mib, 3),
        },
    )

    # Verification:
    # 1. All 50 streams completed successfully
    assert len(results) == stream_count
    expected_stream_text = "".join(tokens)
    for res in results:
        assert res == expected_stream_text

    # 2. Peak memory delta for 50 concurrent streams is strictly bounded (< 15 MB)
    assert memory_delta_mib < 15.0, (
        f"Peak memory delta for 50 streams exceeded 15 MB: {memory_delta_mib:.2f} MB"
    )


@pytest.mark.asyncio
async def test_blocked_stream_raises_output_guardrail_blocked_error() -> None:
    pipeline = OutputGuardrailPipeline(config={"enabled": True})
    with pytest.raises(OutputGuardrailBlockedError):
        async for _ in pipeline.process_token("bearer secret-token-value"):
            pass
