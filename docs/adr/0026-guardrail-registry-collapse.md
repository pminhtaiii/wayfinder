# Grilling Session — Collapse Guardrail Registry Indirection

> Captured from grilling session on 2026-09-22.
> Source: architecture-review-2026-09-13.html (Candidate #5: Collapse guardrail registry indirection).

---

## Context

The guardrail system implements a `GuardrailRegistry` with DAG topological sorting (Kahn's algorithm) to order 9 hardcoded layers across three stages (input, tool, output). The dynamic machinery is speculative — no plugin hooks, no runtime registration, no user-configured layers exist. Multiple bypasses and dead code paths undermine the registry's supposed guarantees:

- `InputGuardrailPipeline` — 111 lines, 0 production callers (dead code)
- `OutputPIILayer` — registered as compulsory but never invoked at runtime
- `gateway.stream_output()` — no-op stub that passes tokens unchanged
- `ToolOutputGuardrailPipeline` — hardcodes `_EXPECTED_LAYER_TYPES` and uses `self._layers[2]` positional magic, nullifying the registry's DAG sort
- `ChatTurnRunner` — bypasses the gateway entirely for output guardrails, directly instantiating `OutputGuardrailPipeline`
- `sse.py` — duplicates length and PII checks before the gateway runs

After this refactor, the `GuardrailGateway` becomes the single orchestration boundary with three fixed, typed methods. The registry, dead pipelines, and bypass paths are eliminated.

---

## Decision 1 — Gateway owns `stream_output()`, delegates to `OutputGuardrailPipeline` ✅

**Problem**: `ChatTurnRunner` directly instantiates `OutputGuardrailPipeline`, bypassing `gateway.stream_output()` (which is a no-op stub). The registered `OutputPIILayer` is dead code — never invoked at runtime. The gateway claims to handle output but doesn't.

**Considered options**:

1. **Absorb `OutputGuardrailPipeline` chunk-buffer logic entirely into `gateway.stream_output()`** — gateway becomes the sole implementation.
2. **Make `gateway.stream_output()` the authoritative entry point, delegating to `OutputGuardrailPipeline` internally** — gateway owns lifecycle, pipeline stays as internal implementation detail.

**Decision**: Option 2. `gateway.stream_output(context, *, config, session_id)` is an async context-manager factory returning a per-turn facade. It owns one pipeline for the complete turn, exposes `process_token()` across all three runner output branches, a one-shot `flush()`, and an idempotent non-flushing `close()`; `__aexit__` always calls `close()`. `OutputGuardrailBlockedError` moves to stable `guardrails.base`; the facade never suppresses it or changes `partial_response`. External callers MUST NOT import or construct `OutputGuardrailPipeline`, or import its block error, from `output_pipeline.py`; the retained stateless `payload_free_config` remains intentionally importable from that module.

**What changes**:

| Component | Before | After |
|-----------|--------|-------|
| `ChatTurnRunner` | Directly imports and instantiates `OutputGuardrailPipeline` | Enters one gateway stream session per turn and uses it in all output branches |
| `gateway.stream_output()` | No-op stub (yields tokens unchanged) | Creates the persistent async context-managed stream-session facade |
| `OutputPIILayer` (in registry) | Registered as compulsory, never invoked | Deleted |
| `OutputGuardrailPipeline` | Public, instantiated by runner | Class is internal to gateway; stable block error comes from `guardrails.base`; only `payload_free_config` remains externally importable from `output_pipeline.py` |

**Desired flow**:
```
ChatTurnRunner → gateway.stream_output(...).__aenter__() → OutputStreamSession
  → process_token() in branches 1/2/3 → one OutputGuardrailPipeline → ChunkBuffer
  → flush() exactly once on success
  → close() is idempotent and non-flushing
  → __aexit__() calls close and propagates block/cancel/error
```

Runner cleanup order at `_finalize_cleanup`, normal, block, early/error, cancellation, and final defensive sites remains: persist approved partial response → close effectively once → release the lease. Early exits never flush buffered undecided content.

---

## Decision 2 — Kill `GuardrailRegistry`, hardcode layer sequences, add startup assertions ✅

**Problem**: `GuardrailRegistry` (267 lines) implements DAG topological sorting via Kahn's algorithm for a completely static, known-at-import-time layer set. The sort always produces the same result. `COMPULSORY_PRODUCTION_LAYERS` checks your own homework. `allowed_keys` is never used. Stage-rank validation never triggers (all prereqs are within-stage).

**Considered options**:

1. **Kill the registry outright** — gateway hardcodes layer tuples directly.
2. **Keep a stripped-down registry** — typed container without DAG/sort/compulsory machinery.
3. **Kill the registry, add startup assertions** — hardcode sequences but verify prereq contracts at boot time.

**Decision**: Option 3. Production calls `GuardrailGateway()` with no registry argument and receives the fixed layer sequences. Tests may use keyword-only private tuple injection. A one-time `assert_layer_order(stage, layers, expected_types)` requires exact count/type/order, unique layer keys, and every declared prerequisite key earlier in the same stage; missing, duplicate, reordered, wrong-type, unknown, or later prerequisites raise during construction. This provides the safety net without dynamic DAG machinery.

**Key constraint**: The assertion is a fail-fast constructor guard, not a runtime dependency resolver. If it fails, the service refuses to start; no invalid gateway object exists for `is_healthy()` to recover. `is_healthy()` reports post-construction runtime readiness only. `main.py` uses one idempotent canonical factory/get-or-create path so module load and lifespan resolve the same gateway rather than construct duplicates.

**What is deleted**:

- `registry.py` (267 lines) — entire file
- `create_production_registry()` factory
- `COMPULSORY_PRODUCTION_LAYERS` enforcement
- `allowed_keys` restriction (never used)
- Stage-rank validation (never triggered)
- Kahn's topological sort

**What replaces it**:

```python
class GuardrailGateway:
    def __init__(self, *, _input_layers=None, _tool_layers=None):
        self._input_layers = (
            (LengthValidator(), PIIDetector(), InjectionDetector(), TopicBoundary())
            if _input_layers is None else tuple(_input_layers)
        )
        self._tool_layers = (
            (SizeStructureValidator(), SchemaValidator(), PIIScanner(),
             UntrustedContentInjectionDetector())
            if _tool_layers is None else tuple(_tool_layers)
        )
        assert_layer_order("input", self._input_layers, EXPECTED_INPUT_TYPES)
        assert_layer_order("tool", self._tool_layers, EXPECTED_TOOL_TYPES)
```

**`is_healthy()`** moves to the gateway (trivial check: layers are non-empty and correctly typed).

---

## Decision 3 — Absorb `ToolOutputGuardrailPipeline` into `gateway.validate_tool_result()` ✅

**Problem**: `ToolOutputGuardrailPipeline` (84 lines) has two bypasses that nullify the registry:
1. `_EXPECTED_LAYER_TYPES` hardcodes the exact 4 layer types and validates `len(self._layers) == 4` — any change, reordering, or substitution causes hard failure.
2. `self._layers[2]` — when `SchemaValidator` blocks, it jumps to index 2 (`PIIScanner`) via magic numeric index. This prioritizes `GUARDRAIL_TOOL_PII` over `GUARDRAIL_TOOL_SCHEMA` when both apply.

**Considered options**:

1. **Keep `ToolOutputGuardrailPipeline` with named references** (`pii_scanner=...`) instead of positional access.
2. **Absorb into the gateway** — inline the tool validation logic with explicit PII-priority branch.

**Decision**: Option 2. The gateway already hardcodes the tool layers. The pipeline exists solely to iterate over them and handle the PII-priority branch. Absorbing it into the existing canonical `validate_tool_result` method makes the logic explicit: if schema blocks, run the named `PIIScanner` against the original raw tool result—including schema-invalid extra fields—before returning; PII wins when both block. No alias is added.

---

## Decision 4 — Extract `approved_model_content()` to thin `guardrails/pii.py` utility ✅

**Problem**: `OutputGuardrailPipeline` exports `approved_model_content()` — a stateless batch PII check used by 5 modules (`graph/nodes.py`, `travel_assistant.py`, `general_agent.py`, `checkout_orchestrator.py`, `memory/manager.py`). These callers bypass the gateway entirely.

**Considered options**:

1. **Move to `guardrails/pii.py`** — thin utility module, gateway and callers import from there.
2. **Expose as `gateway.check_content()`** — gateway becomes sole PII entry point.

**Decision**: Option 1. `guardrails/pii.py` owns the only definitions of `deterministic_pii_match`, `_is_output_guardrail_disabled`, and `approved_model_content()`. `output_pipeline.py` imports both matcher and predicate and retains `payload_free_config`; this direction is acyclic and preserves disabled batch and streaming behavior. Tests cover every disabled shape, enabled/default PII, safe/non-string content, cross-token behavior, zero duplicate definitions, import-cycle absence, and lint.

**Architectural principle established**: Gateway = orchestration boundary, not universal entry point. Stateless utilities live as importable functions outside the gateway.

---

## Decision 5 — Remove duplicate PII pre-check from `sse.py`, keep length guard ✅

**Problem**: `sse.py` duplicates two guardrail checks before the gateway runs:
1. Length check (`len(message) > MAX_LENGTH`) → HTTP 400
2. PII check (`detect_pii(message)`) → SSE ErrorEvent

Both are re-checked by the gateway's `LengthValidator` and `PIIDetector` layers.

**Decision**: Keep the length check. After it, `sse.py` obtains/type/health-checks the gateway, builds the existing admission context, and calls `validate_input` exactly once before any Redis/quota work. Unavailable/degraded gateway retains its existing 503 precedence. With a healthy gateway, `GUARDRAIL_INPUT_PII` immediately returns the exact first-and-only legacy event—`error`, code `GUARDRAIL_BLOCKED`, message `Your message contains protected personal information and cannot be processed.`, `partialMessageId: null`—with zero Redis/quota calls, so PII beats Redis failure. For non-PII, SSE passes the stored decision/data to `ChatController.stream(..., admission_decision=decision)`; controller does not revalidate and preserves existing safe mappings.

---

## Decision 6 — Delete `InputGuardrailPipeline` as dead code, do not port normalization ✅

**Problem**: `InputGuardrailPipeline` (111 lines, 0 production callers) does one thing the gateway doesn't: it calls `bounded_normalize(content)` on accepted messages before returning them. This strips zero-width characters, normalizes Unicode (NFKC), decodes nested URL encoding, and maps homoglyphs to Latin equivalents.

**Investigation findings**:
- `InjectionDetector` already calls `bounded_normalize` internally for detection, but returns a pass/block decision — it does not modify the downstream message.
- The gateway returns raw `ValidatedInput(content=message)` — no normalization.
- The system has been running without post-validation normalization with no reported issues.
- Adding normalization would change message content for non-Latin scripts (homoglyph table maps some legitimate characters).

**Decision**: Delete `InputGuardrailPipeline` without porting normalization. No evidence that post-validation normalization improves PII detection or security in the current system. `normalization.py` survives (used by `InjectionDetector` internally). Post-validation normalization is a future investigation with measured performance reporting, not part of this collapse.

---

## Post-Refactor Structure

```
apps/agent/src/agent/guardrails/
├── base.py                    (unchanged — layer base classes, decision types)
├── capabilities.py            (unchanged — sealed tool capabilities)
├── gateway.py                 (GROWS — absorbs tool validation, adds stream_output delegation,
│                                startup assertions, is_healthy)
├── normalization.py           (unchanged — used by InjectionDetector)
├── output_pipeline.py         (KEPT — internal delegate; imports matcher/predicate
│                                from pii.py and retains payload_free_config)
├── pii.py                     (NEW — deterministic_pii_match,
│                                _is_output_guardrail_disabled, approved_model_content)
├── layers/
│   ├── __init__.py
│   ├── injection.py           (unchanged)
│   ├── input.py               (unchanged)
│   └── tool_output.py         (unchanged)
├── schemas/
│   ├── __init__.py
│   └── tools.py               (unchanged)
│
│   DELETED:
│   ├── registry.py            ✗ (267 lines)
│   ├── input_pipeline.py      ✗ (111 lines)
│   ├── tool_output_pipeline.py ✗ (84 lines)
│   └── tool_schemas.py        (6 lines — verify if still needed)
```

## Post-Refactor Dependency Graph

```
GuardrailGateway (deep orchestration module)
├── validate_input()       → [LengthValidator, PIIDetector, InjectionDetector, TopicBoundary]
├── validate_tool_result() → [SizeStructureValidator, SchemaValidator, PIIScanner, UntrustedContentInjectionDetector]
│                            (explicit PII-priority branch when schema blocks)
├── stream_output()        → per-turn OutputStreamSession
│                            → one OutputGuardrailPipeline → ChunkBuffer
│                            → deterministic_pii_match() and disabled predicate imported from pii.py
└── is_healthy()           → checks layers non-empty + correctly typed

guardrails/pii.py (thin utility)
└── approved_model_content() → deterministic_pii_match()
    (imported by: graph/nodes.py, travel_assistant.py, general_agent.py,
     checkout_orchestrator.py, memory/manager.py)
```

**Dependency direction**: All arrows flow inward. Callers depend on the gateway or the thin utility. No internal module is imported directly by external consumers except `pii.py`.

---

## What does NOT change

- **Layer implementations**: All 8 surviving layer classes (4 input, 4 tool) keep their exact behavior, `check()` signatures, and internal logic.
- **Normalization module**: `normalization.py` survives unchanged — `InjectionDetector` uses `bounded_normalize` internally.
- **Security guarantees**: Same layers run in the same order. Startup assertions verify prereq contracts.
- **API contract**: No changes to HTTP endpoints, SSE event formats, or guardrail block response keys.
- **Fail-closed behavior**: Gateway fails closed on all error paths (preserved from current implementation).

## Deletion Summary

| File | Lines | Reason |
|------|-------|--------|
| `registry.py` | 267 | Replaced by hardcoded tuples + startup assertion |
| `input_pipeline.py` | 111 | Dead code — 0 production callers |
| `tool_output_pipeline.py` | 84 | Absorbed into `gateway.validate_tool_result()` |
| `OutputPIILayer` (in registry.py) | ~30 | Dead — never invoked at runtime |
| SSE duplicate PII check | ~8 | Gateway is authoritative for PII |
| **Total** | **~500 lines deleted** | |
