"""Exhaustive Intent vs Tool Authority Table Tests (T023 / SEC13 / SEC27).

Validates:
1. Full capability sealing truth table across all intents, fallbacks, gates, and flags.
2. Whole batch denial rule on mixed or forged multi-tool call proposals (0 invocations).
3. TurnCapabilities immutability, non-expansion during transitions, and model node intersection binding.
"""

import inspect
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import ValidationError

from agent.agents.checkout_orchestrator import checkout_orchestrator_node
from agent.agents.general_agent import general_agent_node
from agent.agents.travel_assistant import travel_assistant_node
from agent.graph.graph import route_after_tools, router_node
from agent.graph.nodes import custom_tool_node, final_answer_node
from agent.graph.state import AgentState
from agent.guardrails.base import (
    GUARDRAIL_TOOL_PII,
    GUARDRAIL_TOOL_SCHEMA,
    TurnCapabilities,
)
from agent.guardrails.gateway import GuardrailGateway
from agent.guardrails.layers.input import (
    InjectionDetector,
    LengthValidator,
    PIIDetector,
    TopicBoundary,
)
from agent.models.requests import RouteDecision
from agent.tools.registry import (
    get_tools,
)
from agent.trusted_search_snapshot import (
    TrustedSearchResult,
    TrustedSearchSnapshot,
)

pytestmark = pytest.mark.security


def _make_gateway() -> GuardrailGateway:
    """Instantiate GuardrailGateway with keyword seam for tool authority tests."""
    return GuardrailGateway(
        _input_layers=(
            LengthValidator(),
            PIIDetector(),
            InjectionDetector(),
            TopicBoundary(),
        )
    )


# User approved on 2026-10-03: internal trusted snapshots use supplierOfferId; legacy wire fields
# remain covered by gateway-specific tests.
TRAVEL_TOOL_NAMES: tuple[str, ...] = (
    "search_flights",
    "get_user_preferences",
    "list_user_booking_summaries",
    "get_booking_detail",
    "check_booking_readiness",
)
CHECKOUT_TOOL_NAMES: tuple[str, ...] = ("signal_checkout_intent",)
GENERAL_TOOL_NAMES: tuple[str, ...] = ()
ALL_REGISTERED_TOOL_NAMES: tuple[str, ...] = tuple(t.name for t in get_tools())


def test_trusted_result_rejects_duffel_alias_with_neutral_identity() -> None:
    now = datetime.now(timezone.utc)
    with pytest.raises(ValidationError):
        TrustedSearchResult.model_validate(
            {
                "offerIndex": 1,
                "flightOfferId": "flight-neutral-1",
                "supplierOfferId": "supplier-neutral-1",
                "duffelOfferId": "duffel-legacy-1",
                "airline": "Sky Airline",
                "origin": "SFO",
                "destination": "JFK",
                "departureAt": now,
                "arrivalAt": now + timedelta(hours=6),
                "price": "420.00",
                "currency": "USD",
            }
        )


def _create_active_snapshot(num_offers: int = 2) -> TrustedSearchSnapshot:
    """Helper to create an active, unexpired search snapshot for checkout tests."""
    now = datetime.now(timezone.utc)
    results = [
        TrustedSearchResult(
            offerIndex=i,
            flightOfferId=f"fl_offer_{i}",
            supplierOfferId=f"supplier_offer_{i}",
            airline="Sky Airline",
            origin="SFO",
            destination="JFK",
            departureAt=now + timedelta(days=2),
            arrivalAt=now + timedelta(days=2, hours=6),
            price="420.00",
            currency="USD",
        )
        for i in range(1, num_offers + 1)
    ]
    return TrustedSearchSnapshot(
        schemaVersion=1,
        snapshotVersion=1,
        userId="user-test-456",
        sessionId="session-test-789",
        createdAt=now,
        expiresAt=now + timedelta(minutes=15),
        fingerprint="fp-snapshot-valid-001",
        selectionAttestation="attest-snapshot-valid-001",
        results=results,
    )


def _create_expired_snapshot() -> TrustedSearchSnapshot:
    """Helper to create an expired snapshot for checkout downgrade tests."""
    now = datetime.now(timezone.utc)
    results = [
        TrustedSearchResult(
            offerIndex=1,
            flightOfferId="fl_offer_expired",
            supplierOfferId="supplier_offer_expired",
            airline="Sky Airline",
            origin="SFO",
            destination="JFK",
            departureAt=now + timedelta(days=1),
            arrivalAt=now + timedelta(days=1, hours=5),
            price="300.00",
            currency="USD",
        )
    ]
    return TrustedSearchSnapshot(
        schemaVersion=1,
        snapshotVersion=1,
        userId="user-test-456",
        sessionId="session-test-789",
        createdAt=now - timedelta(minutes=30),
        expiresAt=now - timedelta(minutes=10),
        fingerprint="fp-snapshot-expired-001",
        selectionAttestation="attest-snapshot-expired-001",
        results=results,
    )


def _resolve_capabilities_from_sealer(
    decision: RouteDecision | None,
    gate_result: Dict[str, str] | None = None,
    multi_agent: bool = True,
    provenance: str = "trusted_router",
) -> TurnCapabilities:
    """Attempt to invoke the pure capability sealer function to be introduced in T026."""
    candidate_modules = (
        "agent.graph.checkout_gate",
        "agent.graph.router",
        "agent.guardrails.gateway",
        "agent.guardrails.capabilities",
    )
    for mod_path in candidate_modules:
        try:
            mod = __import__(mod_path, fromlist=["seal_turn_capabilities", "seal_capabilities"])
            for fn_name in ("seal_turn_capabilities", "seal_capabilities"):
                if hasattr(mod, fn_name):
                    fn = getattr(mod, fn_name)
                    return fn(
                        decision,
                        gate_result=gate_result,
                        multi_agent=multi_agent,
                        provenance=provenance,
                    )
        except (ImportError, AttributeError):
            continue
    pytest.fail("Capability sealer function not implemented in codebase (pending T026)")


class _CapturingModel:
    """Mock model that records bound tools and invocations."""

    def __init__(self, response: Any = None) -> None:
        self.response = response or AIMessage(content="Stub response")
        self.bound_tools: List[Any] = []
        self.invocations: List[Any] = []

    def bind_tools(self, tools: Any) -> "_CapturingModel":
        self.bound_tools = list(tools)
        return self

    async def ainvoke(self, messages: Any, config: Any = None, **kwargs: Any) -> Any:
        self.invocations.append((messages, config))
        return self.response


# ===========================================================================
# 1. Full Capability Sealing Truth Table Tests
# ===========================================================================


class TestCapabilitySealingTruthTable:
    """Truth table verification: intent, gate, provenance, and flags -> sealed tools."""

    @pytest.fixture(autouse=True)
    def enable_multi_agent_for_truth_table(self) -> Any:
        """Truth-table cases exercise enabled routing unless a case overrides the flag."""
        with patch("agent.config.get_settings") as settings:
            settings.return_value.FEATURE_FLAG_CHAT_MULTI_AGENT = True
            settings.return_value.ROUTER_CONFIDENCE_THRESHOLD = 0.7
            yield

    @pytest.mark.asyncio
    async def test_general_intent_seals_empty_tool_tuple(self) -> None:
        """GENERAL intent must seal empty tools () with zero authority."""
        state: AgentState = {
            "messages": [HumanMessage(content="Hello, what can you do?")],
        }
        decision = RouteDecision(intent="GENERAL", confidence=0.99, isCommitment=False)

        with patch("agent.graph.graph.invoke_router", AsyncMock(return_value=decision)):
            result = await router_node(state)

        assert "turn_capabilities" in result, "router_node must produce sealed turn_capabilities"
        caps: TurnCapabilities = result["turn_capabilities"]
        assert isinstance(caps, TurnCapabilities)
        assert caps.intent == "GENERAL"
        assert caps.sealed_tools == ()
        assert caps.is_sealed is True

    @pytest.mark.asyncio
    @pytest.mark.parametrize("intent", ["SEARCH", "BOOKING_INQUIRY"])
    async def test_search_and_booking_inquiry_seal_exact_five_travel_tools(
        self, intent: str
    ) -> None:
        """SEARCH and BOOKING_INQUIRY intents must seal exactly the 5 travel tools."""
        state: AgentState = {
            "messages": [HumanMessage(content="Find flights from SFO to JFK on Friday")],
        }
        decision = RouteDecision(intent=intent, confidence=0.95, isCommitment=False)

        with patch("agent.graph.graph.invoke_router", AsyncMock(return_value=decision)):
            result = await router_node(state)

        assert "turn_capabilities" in result, "router_node must produce sealed turn_capabilities"
        caps: TurnCapabilities = result["turn_capabilities"]
        assert isinstance(caps, TurnCapabilities)
        assert caps.intent == intent
        assert set(caps.sealed_tools) == set(TRAVEL_TOOL_NAMES)
        assert len(caps.sealed_tools) == 5
        assert "signal_checkout_intent" not in caps.sealed_tools
        assert caps.is_sealed is True

    @pytest.mark.asyncio
    async def test_checkout_with_passing_gates_seals_signal_checkout_intent_only(self) -> None:
        """CHECKOUT with passing commitment, snapshot, and selection seals signal tool only."""
        snapshot = _create_active_snapshot(num_offers=2)
        state: AgentState = {
            "messages": [HumanMessage(content="I want to book option 1")],
            "trusted_snapshot": snapshot,
        }
        decision = RouteDecision(
            intent="CHECKOUT",
            confidence=0.95,
            isCommitment=True,
            selectionIndex=1,
        )

        with patch("agent.graph.graph.invoke_router", AsyncMock(return_value=decision)):
            result = await router_node(state)

        assert "turn_capabilities" in result, "router_node must produce sealed turn_capabilities"
        caps: TurnCapabilities = result["turn_capabilities"]
        assert isinstance(caps, TurnCapabilities)
        assert caps.intent == "CHECKOUT"
        assert caps.sealed_tools == ("signal_checkout_intent",)
        assert not any(tool in caps.sealed_tools for tool in TRAVEL_TOOL_NAMES)
        assert caps.is_sealed is True

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "gate_failure_kwargs,description",
        [
            ({"isCommitment": False}, "commitment_not_confirmed"),
            ({"selectionIndex": None}, "missing_selection_index"),
            ({"selectionIndex": 99}, "selection_index_out_of_bounds"),
            ({"confidence": 0.4}, "confidence_below_threshold"),
        ],
    )
    async def test_checkout_downgraded_by_gate_seals_travel_set_only(
        self, gate_failure_kwargs: Dict[str, Any], description: str
    ) -> None:
        """CHECKOUT downgraded by deterministic gate must seal travel set with no checkout signal."""
        snapshot = _create_active_snapshot(num_offers=2)
        state: AgentState = {
            "messages": [HumanMessage(content="Book a flight")],
            "trusted_snapshot": snapshot,
        }
        base_decision = {
            "intent": "CHECKOUT",
            "confidence": 0.95,
            "isCommitment": True,
            "selectionIndex": 1,
        }
        base_decision.update(gate_failure_kwargs)
        decision = RouteDecision(**base_decision)

        with patch("agent.graph.graph.invoke_router", AsyncMock(return_value=decision)):
            result = await router_node(state)

        assert "turn_capabilities" in result, (
            f"router_node must produce turn_capabilities ({description})"
        )
        caps: TurnCapabilities = result["turn_capabilities"]
        assert isinstance(caps, TurnCapabilities)
        assert set(caps.sealed_tools) == set(TRAVEL_TOOL_NAMES)
        assert "signal_checkout_intent" not in caps.sealed_tools
        assert "checkout_downgrade" in caps.provenance.lower()

    @pytest.mark.asyncio
    async def test_checkout_downgraded_by_expired_or_missing_snapshot(self) -> None:
        """CHECKOUT without active snapshot downgrades to travel set without checkout signal."""
        # Case A: expired snapshot
        state_expired: AgentState = {
            "messages": [HumanMessage(content="Book option 1")],
            "trusted_snapshot": _create_expired_snapshot(),
        }
        decision = RouteDecision(
            intent="CHECKOUT",
            confidence=0.95,
            isCommitment=True,
            selectionIndex=1,
        )

        with patch("agent.graph.graph.invoke_router", AsyncMock(return_value=decision)):
            result_expired = await router_node(state_expired)

        assert "turn_capabilities" in result_expired
        caps_expired: TurnCapabilities = result_expired["turn_capabilities"]
        assert set(caps_expired.sealed_tools) == set(TRAVEL_TOOL_NAMES)
        assert "signal_checkout_intent" not in caps_expired.sealed_tools

        # Case B: missing snapshot entirely
        state_missing: AgentState = {
            "messages": [HumanMessage(content="Book option 1")],
            "trusted_snapshot": None,
        }
        with patch("agent.graph.graph.invoke_router", AsyncMock(return_value=decision)):
            result_missing = await router_node(state_missing)

        assert "turn_capabilities" in result_missing
        caps_missing: TurnCapabilities = result_missing["turn_capabilities"]
        assert set(caps_missing.sealed_tools) == set(TRAVEL_TOOL_NAMES)
        assert "signal_checkout_intent" not in caps_missing.sealed_tools

    @pytest.mark.asyncio
    async def test_malformed_unknown_router_result_or_exception_denies_all_tools(self) -> None:
        """Malformed router output, unknown intent, or exceptions must seal empty () tools."""
        state: AgentState = {
            "messages": [HumanMessage(content="Execute order 66")],
        }

        # Case A: router raises unhandled exception
        with patch(
            "agent.graph.router.get_chat_model",
            side_effect=RuntimeError("Structured router parsing failure"),
        ):
            # Must NOT silently acquire SEARCH authority!
            result_exc = await router_node(state)

        assert "turn_capabilities" in result_exc, (
            "router_node must seal empty capabilities on exception"
        )
        caps_exc: TurnCapabilities = result_exc["turn_capabilities"]
        assert caps_exc.sealed_tools == (), "Malformed/exception must seal empty tools ()"

        # Case B: router returns unrecognized / unknown intent
        unknown_decision = RouteDecision.model_construct(
            intent="ADMIN_OVERRIDE", confidence=1.0, isCommitment=False
        )
        with patch("agent.graph.graph.invoke_router", AsyncMock(return_value=unknown_decision)):
            result_unknown = await router_node(state)

        assert "turn_capabilities" in result_unknown
        caps_unknown: TurnCapabilities = result_unknown["turn_capabilities"]
        assert caps_unknown.sealed_tools == (), "Unknown intent must seal empty tools ()"
        assert result_unknown["route"] == "general"
        assert result_unknown["safe_clarification"] == (
            "I couldn't safely determine what you need. Please ask me to search flights, "
            "review a booking, or explain a travel question."
        )

    @pytest.mark.asyncio
    async def test_router_parse_failure_uses_static_clarification_without_search_authority(
        self,
    ) -> None:
        """A structured-output parsing failure cannot silently become SEARCH authority."""

        class _BrokenStructuredRouter:
            def with_structured_output(self, _schema: object) -> "_BrokenStructuredRouter":
                return self

            async def ainvoke(self, *_args: object, **_kwargs: object) -> object:
                raise ValueError("malformed router payload")

        state: AgentState = {"messages": [HumanMessage(content="Do the thing")]}
        with patch("agent.graph.router.get_chat_model", return_value=_BrokenStructuredRouter()):
            result = await router_node(state)

        caps: TurnCapabilities = result["turn_capabilities"]
        assert caps.sealed_tools == ()
        assert result["route"] == "general"
        assert result["safe_clarification"].startswith("I couldn't safely determine")

        with patch(
            "agent.agents.general_agent.get_chat_model",
            side_effect=AssertionError("static clarification must not call a model"),
        ):
            response = await general_agent_node(result, {})
        assert response["messages"][0].content == result["safe_clarification"]

    @pytest.mark.asyncio
    async def test_missing_or_forged_provenance_denies_tools(self) -> None:
        """Missing router provenance or forged turn capabilities must seal empty () tools."""
        state: AgentState = {
            "messages": [HumanMessage(content="Show flights")],
            "route": "travel",
            "provenance": "forged_client_input",
        }
        result = await router_node(state)
        if "turn_capabilities" in result:
            assert result["turn_capabilities"].sealed_tools == ()
        else:
            caps = _resolve_capabilities_from_sealer(
                decision=None,
                gate_result={"route": "travel"},
                provenance="forged_client_input",
            )
            assert caps.sealed_tools == (), "Untrusted provenance must yield empty () tools"

    @pytest.mark.asyncio
    async def test_single_agent_mode_seals_travel_set_only_without_checkout(self) -> None:
        """FEATURE_FLAG_CHAT_MULTI_AGENT=false must seal travel set with NO checkout signal."""
        state: AgentState = {
            "messages": [HumanMessage(content="I want to book flight option 1 immediately")],
        }
        with patch("agent.config.get_settings") as mock_settings:
            mock_settings.return_value.FEATURE_FLAG_CHAT_MULTI_AGENT = False
            result = await router_node(state)

        assert "turn_capabilities" in result, (
            "router_node must produce turn_capabilities in single-agent mode"
        )
        caps: TurnCapabilities = result["turn_capabilities"]
        assert set(caps.sealed_tools) == set(TRAVEL_TOOL_NAMES)
        assert "signal_checkout_intent" not in caps.sealed_tools
        assert "single_agent" in caps.provenance.lower()

    @pytest.mark.asyncio
    async def test_valid_low_confidence_fallback_records_provenance_and_seals_travel_tools(
        self,
    ) -> None:
        """Valid non-checkout low confidence falls back to SEARCH and records low_confidence provenance."""
        state: AgentState = {
            "messages": [HumanMessage(content="Maybe flights maybe hotels?")],
        }
        low_conf_decision = RouteDecision(intent="SEARCH", confidence=0.45, isCommitment=False)

        with patch("agent.graph.graph.invoke_router", AsyncMock(return_value=low_conf_decision)):
            result = await router_node(state)

        assert "turn_capabilities" in result
        caps: TurnCapabilities = result["turn_capabilities"]
        assert set(caps.sealed_tools) == set(TRAVEL_TOOL_NAMES)
        assert "low_confidence" in caps.provenance.lower()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("tool_name", ALL_REGISTERED_TOOL_NAMES)
    async def test_exhaustive_general_authority_blocks_every_registered_tool(
        self, tool_name: str
    ) -> None:
        """In GENERAL intent, all 6 registered tools must be BLOCKED with 0 invocations."""
        caps = TurnCapabilities(
            intent="GENERAL",
            provenance="trusted_router",
            sealed_tools=(),
        )
        gateway = _make_gateway()
        invoked = False

        async def dummy_invoke() -> Dict[str, Any]:
            nonlocal invoked
            invoked = True
            return {"status": "success"}

        call = {"name": tool_name, "args": {}}
        decision = await gateway.execute_tool(caps, call, dummy_invoke)

        assert decision.status == "BLOCK"
        assert decision.response_key == GUARDRAIL_TOOL_SCHEMA
        assert invoked is False, f"Tool '{tool_name}' must NOT be invoked under GENERAL authority"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("tool_name", ALL_REGISTERED_TOOL_NAMES)
    async def test_exhaustive_general_authority_validate_tool_result_blocks_every_tool(
        self, tool_name: str
    ) -> None:
        """validate_tool_result under GENERAL authority blocks every registered tool."""
        caps = TurnCapabilities(
            intent="GENERAL",
            provenance="trusted_router",
            sealed_tools=(),
        )
        gateway = _make_gateway()
        decision = await gateway.validate_tool_result(caps, tool_name, {"status": "ok"})
        assert decision.status == "BLOCK"
        assert decision.response_key == GUARDRAIL_TOOL_SCHEMA
        assert decision.validated_data is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize("tool_name", ALL_REGISTERED_TOOL_NAMES)
    async def test_exhaustive_search_authority_permits_only_travel_tools(
        self, tool_name: str
    ) -> None:
        """In SEARCH intent, only 5 travel tools are permitted; checkout signal is BLOCKED."""
        caps = TurnCapabilities(
            intent="SEARCH",
            provenance="trusted_router",
            sealed_tools=TRAVEL_TOOL_NAMES,
        )
        gateway = _make_gateway()
        invoked = False

        async def dummy_invoke() -> Dict[str, Any]:
            nonlocal invoked
            invoked = True
            return {"status": "success"}

        call = {"name": tool_name, "args": {}}
        decision = await gateway.execute_tool(caps, call, dummy_invoke)

        if tool_name in TRAVEL_TOOL_NAMES:
            assert decision.status == "PASS"
            assert invoked is True
        else:
            assert decision.status == "BLOCK"
            assert decision.response_key == GUARDRAIL_TOOL_SCHEMA
            assert invoked is False, f"Tool '{tool_name}' must be blocked under SEARCH authority"

    @pytest.mark.asyncio
    async def test_validate_tool_result_blocks_unsealed_checkout_in_search_authority(
        self,
    ) -> None:
        """validate_tool_result under SEARCH authority blocks signal_checkout_intent."""
        caps = TurnCapabilities(
            intent="SEARCH",
            provenance="trusted_router",
            sealed_tools=TRAVEL_TOOL_NAMES,
        )
        gateway = _make_gateway()
        decision = await gateway.validate_tool_result(
            caps, "signal_checkout_intent", {"signal": "ok"}
        )
        assert decision.status == "BLOCK"
        assert decision.response_key == GUARDRAIL_TOOL_SCHEMA
        assert decision.validated_data is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize("tool_name", ALL_REGISTERED_TOOL_NAMES)
    async def test_exhaustive_checkout_authority_permits_only_signal_tool(
        self, tool_name: str
    ) -> None:
        """In CHECKOUT intent, only signal_checkout_intent is permitted; travel tools are BLOCKED."""
        caps = TurnCapabilities(
            intent="CHECKOUT",
            provenance="trusted_router",
            sealed_tools=CHECKOUT_TOOL_NAMES,
        )
        gateway = _make_gateway()
        invoked = False

        async def dummy_invoke() -> Dict[str, Any]:
            nonlocal invoked
            invoked = True
            return {"status": "success"}

        call = {"name": tool_name, "args": {}}
        decision = await gateway.execute_tool(caps, call, dummy_invoke)

        if tool_name == "signal_checkout_intent":
            assert decision.status == "PASS"
            assert invoked is True
        else:
            assert decision.status == "BLOCK"
            assert decision.response_key == GUARDRAIL_TOOL_SCHEMA
            assert invoked is False, f"Tool '{tool_name}' must be blocked under CHECKOUT authority"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("travel_tool", TRAVEL_TOOL_NAMES)
    async def test_validate_tool_result_blocks_unsealed_travel_in_checkout_authority(
        self, travel_tool: str
    ) -> None:
        """validate_tool_result under CHECKOUT authority blocks travel tools."""
        caps = TurnCapabilities(
            intent="CHECKOUT",
            provenance="trusted_router",
            sealed_tools=CHECKOUT_TOOL_NAMES,
        )
        gateway = _make_gateway()
        decision = await gateway.validate_tool_result(caps, travel_tool, {"status": "ok"})
        assert decision.status == "BLOCK"
        assert decision.response_key == GUARDRAIL_TOOL_SCHEMA
        assert decision.validated_data is None


# ===========================================================================
# 2. Whole Batch Denial Rule Tests
# ===========================================================================


class TestWholeBatchDenialRule:
    """If a proposed batch contains even one forbidden or forged tool, the ENTIRE batch is denied (0 invocations)."""

    @pytest.mark.asyncio
    async def test_mixed_batch_allowed_and_forbidden_registered_tool_denies_entire_batch(
        self,
    ) -> None:
        """Batch [search_flights (allowed), signal_checkout_intent (forbidden)] under SEARCH authority: 0 invocations."""
        caps = TurnCapabilities(
            intent="SEARCH",
            provenance="trusted_router",
            sealed_tools=TRAVEL_TOOL_NAMES,
        )
        invocations: List[str] = []

        state: AgentState = {
            "messages": [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "search_flights",
                            "args": {
                                "origin": "SFO",
                                "destination": "JFK",
                                "departure_date": "2026-10-01",
                            },
                            "id": "call_search_1",
                        },
                        {
                            "name": "signal_checkout_intent",
                            "args": {"offer_index": 1},
                            "id": "call_checkout_1",
                        },
                    ],
                )
            ],
            "turn_capabilities": caps,
        }

        config = {
            "configurable": {
                "guardrail_gateway": _make_gateway(),
                "turn_capabilities": caps,
                "thread_id": "session-batch-test",
                "user_id": "user-batch-test",
            }
        }

        # User-authorized correction (2026-09-08): assert the registered-tool
        # resolver is never reached after whole-batch authorization rejects.
        with patch("agent.graph.nodes.get_tool_by_name") as resolve_tool:
            await custom_tool_node(state, config)
        resolve_tool.assert_not_called()

        assert len(invocations) == 0, (
            f"Whole batch denial violated: {invocations} were invoked when batch contained forbidden tool"
        )

    @pytest.mark.asyncio
    async def test_mixed_batch_allowed_and_forged_tool_name_denies_entire_batch(self) -> None:
        """Batch [search_flights (allowed), forged_system_cmd (forged)]: 0 invocations."""
        caps = TurnCapabilities(
            intent="SEARCH",
            provenance="trusted_router",
            sealed_tools=TRAVEL_TOOL_NAMES,
        )
        invocations: List[str] = []

        state: AgentState = {
            "messages": [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "search_flights",
                            "args": {
                                "origin": "SFO",
                                "destination": "JFK",
                                "departure_date": "2026-10-01",
                            },
                            "id": "call_search_2",
                        },
                        {
                            "name": "forged_system_cmd",
                            "args": {"cmd": "whoami"},
                            "id": "call_forged_1",
                        },
                    ],
                )
            ],
            "turn_capabilities": caps,
        }
        config = {
            "configurable": {
                "guardrail_gateway": _make_gateway(),
                "turn_capabilities": caps,
                "thread_id": "session-batch-test",
                "user_id": "user-batch-test",
            }
        }

        # User-authorized correction (2026-09-08): forged names are rejected
        # before registry resolution or any tool invocation.
        with patch("agent.graph.nodes.get_tool_by_name") as resolve_tool:
            await custom_tool_node(state, config)
        resolve_tool.assert_not_called()

        assert len(invocations) == 0, (
            f"Whole batch denial violated: {invocations} were invoked when batch contained forged tool name"
        )

    @pytest.mark.asyncio
    async def test_gateway_execute_tool_batch_denies_mixed_batches(self) -> None:
        """GuardrailGateway.execute_tool_batch must fail closed (BLOCK) if any call is unauthorized."""
        gateway = _make_gateway()
        caps = TurnCapabilities(
            intent="SEARCH",
            provenance="trusted_router",
            sealed_tools=TRAVEL_TOOL_NAMES,
        )
        calls = [
            {"name": "search_flights", "args": {}},
            {"name": "signal_checkout_intent", "args": {}},
        ]
        invoked_tools: List[str] = []

        async def invoke_search() -> Dict[str, Any]:
            invoked_tools.append("search_flights")
            return {}

        async def invoke_signal() -> Dict[str, Any]:
            invoked_tools.append("signal_checkout_intent")
            return {}

        if not hasattr(gateway, "execute_tool_batch"):
            pytest.fail("GuardrailGateway.execute_tool_batch is not implemented (pending T026)")

        execute_batch_fn: Callable[..., Any] = getattr(gateway, "execute_tool_batch")
        decision = await execute_batch_fn(
            caps,
            calls,
            [invoke_search, invoke_signal],
        )

        assert decision.status == "BLOCK"
        assert decision.response_key == GUARDRAIL_TOOL_SCHEMA
        assert len(invoked_tools) == 0, "Zero tool invocations allowed on whole-batch denial"

    @pytest.mark.asyncio
    async def test_batch_denial_in_checkout_authority_with_travel_tool(self) -> None:
        """In CHECKOUT authority, a batch [signal_checkout_intent, search_flights] executes 0 tools."""
        caps = TurnCapabilities(
            intent="CHECKOUT",
            provenance="trusted_router",
            sealed_tools=CHECKOUT_TOOL_NAMES,
        )
        invocations: List[str] = []

        state: AgentState = {
            "messages": [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "signal_checkout_intent",
                            "args": {"offer_index": 1},
                            "id": "call_checkout_2",
                        },
                        {
                            "name": "search_flights",
                            "args": {
                                "origin": "SFO",
                                "destination": "JFK",
                                "departure_date": "2026-10-01",
                            },
                            "id": "call_search_3",
                        },
                    ],
                )
            ],
            "turn_capabilities": caps,
        }
        config = {
            "configurable": {
                "guardrail_gateway": _make_gateway(),
                "turn_capabilities": caps,
                "thread_id": "session-batch-test",
                "user_id": "user-batch-test",
            }
        }

        # User-authorized correction (2026-09-08): checkout batches cannot
        # resolve a travel tool when whole-batch authorization fails.
        with patch("agent.graph.nodes.get_tool_by_name") as resolve_tool:
            await custom_tool_node(state, config)
        resolve_tool.assert_not_called()

        assert len(invocations) == 0, (
            f"Whole batch denial violated in checkout turn: {invocations} were invoked"
        )

    @pytest.mark.asyncio
    async def test_direct_checkout_tool_receives_injected_state_and_publishes_validated_signal(
        self,
    ) -> None:
        """The gateway executor must preserve InjectedState semantics without ToolNode."""
        caps = TurnCapabilities(
            intent="CHECKOUT",
            provenance="trusted_router",
            sealed_tools=CHECKOUT_TOOL_NAMES,
        )
        state: AgentState = {
            "messages": [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "signal_checkout_intent",
                            "args": {"offer_index": 1},
                            "id": "call-checkout-state-injection",
                        }
                    ],
                )
            ],
            "trusted_snapshot": {"results": [{"offerIndex": 1}]},
            "turn_capabilities": caps,
        }
        config = {
            "callbacks": [MagicMock()],
            "configurable": {
                "guardrail_gateway": _make_gateway(),
                "thread_id": "session-checkout-state-injection",
                "user_id": "user-checkout-state-injection",
            },
        }

        result = await custom_tool_node(state, config)

        assert result["signal"] == {
            "intent": "checkout",
            "offer_index": 1,
            "selected_index": 1,
        }
        assert result["messages"][0].content == "Checkout intent registered successfully."
        assert result["messages"][0].additional_kwargs["guardrail_validated"] is True

    @pytest.mark.asyncio
    async def test_gateway_execute_tool_batch_mismatched_lengths_fails_closed(self) -> None:
        """execute_tool_batch fails closed when calls and invokes lengths differ."""
        gateway = _make_gateway()
        caps = TurnCapabilities(
            intent="SEARCH",
            provenance="trusted_router",
            sealed_tools=TRAVEL_TOOL_NAMES,
        )
        calls = [{"name": "search_flights", "args": {}}]
        invokes: list[Callable[..., Any]] = []

        decision = await gateway.execute_tool_batch(caps, calls, invokes)
        assert decision.status == "BLOCK"
        assert decision.response_key == GUARDRAIL_TOOL_SCHEMA
        assert decision.validated_data is None

    @pytest.mark.asyncio
    async def test_gateway_execute_tool_batch_invalid_context_fails_closed(self) -> None:
        """execute_tool_batch fails closed when context is not TurnCapabilities."""
        gateway = _make_gateway()
        decision = await gateway.execute_tool_batch(
            None,  # type: ignore[arg-type]
            [{"name": "search_flights", "args": {}}],
            [AsyncMock()],
        )
        assert decision.status == "BLOCK"
        assert decision.response_key == GUARDRAIL_TOOL_SCHEMA
        assert decision.validated_data is None

    @pytest.mark.asyncio
    async def test_gateway_execute_tool_batch_fails_closed_when_tool_raises_exception(
        self,
    ) -> None:
        """execute_tool_batch fails closed without leaking exception details when an invoke crashes."""
        gateway = _make_gateway()
        caps = TurnCapabilities(
            intent="SEARCH",
            provenance="trusted_router",
            sealed_tools=TRAVEL_TOOL_NAMES,
        )
        calls = [{"name": "search_flights", "args": {}}]

        async def crashing_invoke() -> None:
            raise RuntimeError("Database connection string leaked: secret_batch_crash_canary")

        decision = await gateway.execute_tool_batch(caps, calls, [crashing_invoke])
        assert decision.status == "BLOCK"
        assert decision.response_key == GUARDRAIL_TOOL_SCHEMA
        assert decision.validated_data is None
        assert "secret_batch_crash_canary" not in (decision.reason or "")

    @pytest.mark.asyncio
    async def test_gateway_execute_tool_batch_pii_priority_in_batch(self) -> None:
        """execute_tool_batch blocks with GUARDRAIL_TOOL_PII when a tool result contains PII in extra fields."""
        gateway = GuardrailGateway()
        caps = TurnCapabilities(
            intent="SEARCH",
            provenance="trusted_router",
            sealed_tools=TRAVEL_TOOL_NAMES,
        )
        calls = [{"name": "search_flights", "args": {}}]

        async def invoke_with_pii_extra_fields() -> dict[str, Any]:
            return {
                "flights": "INVALID_SCHEMA_NOT_LIST",
                "extra_leak": "4532015112830366",
            }

        decision = await gateway.execute_tool_batch(caps, calls, [invoke_with_pii_extra_fields])
        assert decision.status == "BLOCK"
        assert decision.response_key == GUARDRAIL_TOOL_PII
        assert decision.validated_data is None

    def test_gateway_tool_authority_sole_public_method(self) -> None:
        """GuardrailGateway sole public result method is validate_tool_result without aliases."""
        gateway = _make_gateway()
        assert hasattr(gateway, "validate_tool_result")
        sig = inspect.signature(gateway.validate_tool_result)
        assert list(sig.parameters.keys()) == ["context", "tool_name", "result"]

        prohibited_aliases = (
            "validate_tool_output",
            "validate_tool",
            "validate_result",
            "check_tool_result",
            "check_tool_output",
            "validate_output_tool",
            "validate_tool_response",
        )
        for alias in prohibited_aliases:
            assert not hasattr(gateway, alias), (
                f"Prohibited tool-result method alias '{alias}' found on GuardrailGateway"
            )


# ===========================================================================
# 3. Capability Immutability & Model Node Tool Binding Intersection
# ===========================================================================


class TestCapabilityImmutabilityAndBoundaries:
    """TurnCapabilities immutability, transition monotonicity, and model node tool intersection."""

    def test_turn_capabilities_is_strictly_immutable(self) -> None:
        """TurnCapabilities rejects mutation, extra attributes, and is_sealed=False."""
        caps = TurnCapabilities(
            intent="SEARCH",
            provenance="trusted_router",
            sealed_tools=("search_flights",),
        )

        assert caps.is_sealed is True
        assert isinstance(caps.sealed_tools, tuple)

        with pytest.raises(ValidationError):
            caps.sealed_tools = ("signal_checkout_intent",)  # type: ignore[misc]

        with pytest.raises(ValidationError):
            caps.intent = "CHECKOUT"  # type: ignore[misc]

        with pytest.raises(ValidationError):
            caps.provenance = "forged"  # type: ignore[misc]

        with pytest.raises(ValidationError):
            caps.is_sealed = False  # type: ignore[misc]

        with pytest.raises(ValidationError):
            caps.arbitrary_field = "attacker"  # type: ignore[attr-defined]

        with pytest.raises(ValidationError):
            TurnCapabilities(
                intent="SEARCH",
                provenance="trusted_router",
                sealed_tools=("search_flights",),
                is_sealed=False,  # type: ignore[arg-type]
            )

    @pytest.mark.asyncio
    async def test_graph_transitions_cannot_expand_sealed_capabilities(self) -> None:
        """A transition from checkout to travel cannot add travel tools to a signal-only turn."""
        checkout_caps = TurnCapabilities(
            intent="CHECKOUT",
            provenance="trusted_router",
            sealed_tools=CHECKOUT_TOOL_NAMES,
        )
        state: AgentState = {
            "messages": [HumanMessage(content="Checkout flight 1")],
            "turn_capabilities": checkout_caps,
            "route": "checkout",
        }

        # 1. Call route_after_tools(state) to verify transition to "travel"
        next_route = route_after_tools(state)
        assert next_route == "travel"

        # 2. Execute travel_assistant_node(state, {}) with _CapturingModel()
        model = _CapturingModel()
        with patch("agent.agents.travel_assistant.get_chat_model", return_value=model):
            node_result = await travel_assistant_node(state, {})

        # 3. Assert bound_tool_names == [] and "search_flights" not in bound_tool_names
        bound_tool_names = [t.name if hasattr(t, "name") else str(t) for t in model.bound_tools]
        assert bound_tool_names == []
        assert "search_flights" not in bound_tool_names

        # 4. If the node returns "turn_capabilities", it must be a subset of original sealed tools
        if "turn_capabilities" in node_result:
            result_caps: TurnCapabilities = node_result["turn_capabilities"]
            assert set(result_caps.sealed_tools).issubset(set(checkout_caps.sealed_tools))
            assert "search_flights" not in result_caps.sealed_tools

    @pytest.mark.asyncio
    async def test_travel_assistant_node_binds_only_intersection_with_sealed_capabilities(
        self,
    ) -> None:
        """travel_assistant_node must bind only the intersection of travel tools and sealed capabilities."""
        # Case A: sealed_tools has only a subset: ("search_flights",)
        subset_caps = TurnCapabilities(
            intent="SEARCH",
            provenance="trusted_router",
            sealed_tools=("search_flights",),
        )
        state_subset: AgentState = {
            "messages": [HumanMessage(content="Find flights")],
            "turn_capabilities": subset_caps,
        }
        model_a = _CapturingModel()
        with patch("agent.agents.travel_assistant.get_chat_model", return_value=model_a):
            await travel_assistant_node(state_subset, {})

        bound_names_a = [t.name if hasattr(t, "name") else str(t) for t in model_a.bound_tools]
        assert bound_names_a == ["search_flights"], (
            f"Expected only intersection ['search_flights'], but got {bound_names_a}"
        )

        # Case B: sealed_tools is signal-only: ("signal_checkout_intent",)
        signal_caps = TurnCapabilities(
            intent="CHECKOUT",
            provenance="trusted_router",
            sealed_tools=CHECKOUT_TOOL_NAMES,
        )
        state_signal: AgentState = {
            "messages": [HumanMessage(content="Find flights")],
            "turn_capabilities": signal_caps,
        }
        model_b = _CapturingModel()
        with patch("agent.agents.travel_assistant.get_chat_model", return_value=model_b):
            await travel_assistant_node(state_signal, {})

        bound_names_b = [t.name if hasattr(t, "name") else str(t) for t in model_b.bound_tools]
        assert bound_names_b == [], (
            f"Expected empty tools bound for disjoint intersection, but got {bound_names_b}"
        )

        # Case C: sealed_tools is empty () (e.g. GENERAL intent)
        empty_caps = TurnCapabilities(
            intent="GENERAL",
            provenance="trusted_router",
            sealed_tools=(),
        )
        state_empty: AgentState = {
            "messages": [HumanMessage(content="Find flights")],
            "turn_capabilities": empty_caps,
        }
        model_c = _CapturingModel()
        with patch("agent.agents.travel_assistant.get_chat_model", return_value=model_c):
            await travel_assistant_node(state_empty, {})

        bound_names_c = [t.name if hasattr(t, "name") else str(t) for t in model_c.bound_tools]
        assert bound_names_c == [], (
            f"Expected empty tools bound for empty sealed capabilities, but got {bound_names_c}"
        )

    @pytest.mark.asyncio
    async def test_checkout_orchestrator_node_binds_only_intersection_with_sealed_capabilities(
        self,
    ) -> None:
        """checkout_orchestrator_node must bind only the intersection of checkout tools and sealed capabilities."""
        # Case A: sealed_tools has ("signal_checkout_intent",) -> binds signal_checkout_intent
        valid_caps = TurnCapabilities(
            intent="CHECKOUT",
            provenance="trusted_router",
            sealed_tools=CHECKOUT_TOOL_NAMES,
        )
        state_valid: AgentState = {
            "messages": [HumanMessage(content="Proceed to book option 1")],
            "turn_capabilities": valid_caps,
        }
        model_a = _CapturingModel()
        with patch("agent.agents.checkout_orchestrator.get_chat_model", return_value=model_a):
            await checkout_orchestrator_node(state_valid, {})

        bound_names_a = [t.name if hasattr(t, "name") else str(t) for t in model_a.bound_tools]
        assert bound_names_a == ["signal_checkout_intent"]

        # Case B: sealed_tools is travel tools only -> intersection is empty!
        travel_caps = TurnCapabilities(
            intent="SEARCH",
            provenance="trusted_router",
            sealed_tools=TRAVEL_TOOL_NAMES,
        )
        state_travel: AgentState = {
            "messages": [HumanMessage(content="Proceed to book option 1")],
            "turn_capabilities": travel_caps,
        }
        model_b = _CapturingModel()
        with patch("agent.agents.checkout_orchestrator.get_chat_model", return_value=model_b):
            await checkout_orchestrator_node(state_travel, {})

        bound_names_b = [t.name if hasattr(t, "name") else str(t) for t in model_b.bound_tools]
        assert bound_names_b == [], (
            f"Expected empty tools bound in checkout orchestrator with travel capabilities, got {bound_names_b}"
        )

    @pytest.mark.asyncio
    async def test_final_answer_node_has_zero_tools_bound(self) -> None:
        """final_answer_node must never bind any tools under any capability state."""
        state: AgentState = {
            "messages": [HumanMessage(content="Summarize flight search results")],
            "turn_capabilities": TurnCapabilities(
                intent="SEARCH",
                provenance="trusted_router",
                sealed_tools=TRAVEL_TOOL_NAMES,
            ),
        }
        model = _CapturingModel()
        with patch("agent.graph.nodes.get_chat_model", return_value=model):
            await final_answer_node(state, {})

        assert model.bound_tools == [], "final_answer_node must never bind any tools"

    @pytest.mark.asyncio
    async def test_general_agent_node_has_zero_tools_bound(self) -> None:
        """general_agent_node must never bind any tools under any capability state."""
        state: AgentState = {
            "messages": [HumanMessage(content="What are the airline policies?")],
            "turn_capabilities": TurnCapabilities(
                intent="GENERAL",
                provenance="trusted_router",
                sealed_tools=(),
            ),
        }
        model = _CapturingModel()
        with patch("agent.agents.general_agent.get_chat_model", return_value=model):
            await general_agent_node(state, {})

        assert model.bound_tools == [], "general_agent_node must never bind any tools"
