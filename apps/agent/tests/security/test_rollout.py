"""
apps.agent.tests.security.test_rollout
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Task T047 [US5]: Fail-Closed Rollout, Rollback & Startup Tests.

Covers:
1. Fail-Closed Startup Verification:
   - Invalid guardrail layer composition: GuardrailGateway with invalid config or
     missing compulsory layers raises LayerOrderError or TypeError and fails fast.
   - Corrupted or invalid regex rules: corrupted or catastrophic patterns fail closed
     at startup / layer initialization and never fall back to pass-through.
   - Missing HMAC keys (JWT_SECRET, CLAIM_TOKEN_SECRET): unauthenticated or forged requests
     fail closed (401/403) and are never permitted to reach runner or tools.
   - Zero Fail-Open Bypass Invariant: under NO condition (gateway exception, layer check()
     failure, invalid context) does the system fall back to unguarded execution (all return BLOCK).
2. Rollout & Rollback Rehearsal:
   - Rehearse feature flag toggles: NEXT_PUBLIC_FEATURE_FLAG_CHAT_HANDOFF,
     FEATURE_FLAG_CHAT_MULTI_AGENT, NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS.
   - Test complete rollout cycle: enabled -> disabled -> re-enabled.
   - Verify disabling handoff or rolling back preserves safe error states without leaking
     sensitive context or executing unauthorized tools.
3. Health Verification Probes:
   - Verify /health/live probe succeeds without model inference or heavy I/O.
   - Verify /health accurately reports dependency status (guardrails: deterministic,
     redis, nestjsApi).
"""

import asyncio
import secrets
import time
from typing import Any, ClassVar, Literal, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import jwt
import pydantic
import pytest
from fastapi.testclient import TestClient
from langchain_core.runnables import RunnableConfig

from agent.chat_turn import ChatTurnCommand, ChatTurnRunner, TokenEvent
from agent.config import Settings
from agent.graph.graph import router_node
from agent.graph.nodes import create_handoff_token
from agent.graph.state import AgentState
from agent.guardrails.base import (
    GUARDRAIL_INPUT_INJECTION,
    GUARDRAIL_TOOL_SCHEMA,
    AdmissionContext,
    PipelineDecision,
    TurnCapabilities,
)
from agent.guardrails.gateway import GuardrailGateway
from agent.guardrails.layers.input import (
    InjectionDetector,
    LengthValidator,
    PIIDetector,
    TopicBoundary,
)
from agent.main import app
from agent.models.requests import RouteDecision
from agent.queue.message_queue import MessageQueueManager
from agent.repositories.session_lock_repository import SessionLockRepository
from agent.tools.nestjs_client import NestJSClient

pytestmark = pytest.mark.security

TEST_JWT_SECRET = secrets.token_hex(32)
TEST_CLAIM_SECRET = secrets.token_hex(32)


def generate_valid_jwt(
    user_id: str = "usr-12345",
    secret: str = TEST_JWT_SECRET,
    exp_offset: int = 300,
) -> str:
    payload = {
        "sub": user_id,
        "iss": "booking-systems-api",
        "aud": "booking-systems-clients",
        "jti": f"jti-{user_id}-uuid",
        "email": "traveler@example.com",
        "exp": int(time.time()) + exp_offset,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


class DegradedGateway(GuardrailGateway):
    def __init__(self) -> None:
        super().__init__()

    def is_healthy(self) -> bool:
        return False


# ---------------------------------------------------------------------------
# Area A: Fail-Closed Startup Verification
# ---------------------------------------------------------------------------


def test_startup_fails_closed_on_invalid_gateway_layers() -> None:
    """Initializing GuardrailGateway with invalid keyword seams must fail fast."""
    with pytest.raises((ValueError, TypeError)):
        GuardrailGateway(_input_layers=())  # type: ignore[arg-type]

    with pytest.raises((ValueError, TypeError)):
        GuardrailGateway(_input_layers=(LengthValidator(),))  # type: ignore[arg-type]

    with pytest.raises((ValueError, TypeError)):
        GuardrailGateway(_input_layers="not-a-tuple")  # type: ignore[arg-type]

    with pytest.raises((ValueError, TypeError)):
        GuardrailGateway(_tool_layers=())  # type: ignore[arg-type]

    with pytest.raises((ValueError, TypeError)):
        GuardrailGateway(_tool_layers="not-a-tuple")  # type: ignore[arg-type]


def test_startup_fails_closed_on_disabled_compulsory_layers() -> None:
    """Initializing GuardrailGateway with missing compulsory layers must raise ValueError."""
    # Missing compulsory layers via empty or partial tuple
    with pytest.raises((ValueError, TypeError)):
        GuardrailGateway(_input_layers=(LengthValidator(), PIIDetector()))  # type: ignore[arg-type]

    gateway = GuardrailGateway()
    assert gateway.is_healthy() is True
    assert len(gateway._input_layers) == 4
    assert len(gateway._tool_layers) == 4


def test_corrupted_or_invalid_regex_rules_fail_closed_at_startup() -> None:
    """Corrupted, malformed, or catastrophic regex rules must fail closed at initialization and never pass through."""
    with pytest.raises((ValueError, Exception)):
        TopicBoundary(patterns=[r"[unclosed-regex-bracket("])

    catastrophic_pattern = r"(a+)+$"
    with pytest.raises(ValueError):
        TopicBoundary(patterns=[catastrophic_pattern])

    valid_boundary = TopicBoundary()
    decision = valid_boundary.check(
        AdmissionContext(
            user_id="u1",
            chat_session_id="s1",
            trace_id="t1",
            correlation_id=None,
            policy_version="2026-09-05",
        ),
        "write python script to exploit vulnerability",
    )
    import asyncio

    res = asyncio.run(decision)
    assert res.status == "BLOCK"


def test_missing_or_forged_hmac_keys_fail_closed() -> None:
    """Missing HMAC secrets in settings or forged JWT/claims must fail closed with 401/403 and never reach runner."""
    with pytest.raises(pydantic.ValidationError):
        Settings(
            JWT_SECRET="",
            CLAIM_TOKEN_SECRET=TEST_CLAIM_SECRET,
            AGENT_SERVICE_API_KEY="test_key",
            NESTJS_API_URL="http://localhost:3001",
        )

    with pytest.raises(pydantic.ValidationError):
        Settings(
            JWT_SECRET=TEST_JWT_SECRET,
            CLAIM_TOKEN_SECRET="",
            AGENT_SERVICE_API_KEY="test_key",
            NESTJS_API_URL="http://localhost:3001",
        )

    with pytest.raises(pydantic.ValidationError):
        Settings(
            JWT_SECRET=TEST_JWT_SECRET,
            CLAIM_TOKEN_SECRET=TEST_CLAIM_SECRET,
            AGENT_SERVICE_API_KEY="",
            NESTJS_API_URL="http://localhost:3001",
        )

    client = TestClient(app)

    resp_no_auth = client.post(
        "/chat/stream",
        json={"message": "hello", "sessionId": "sess-1"},
        headers={"Origin": "http://localhost:3000"},
    )
    assert resp_no_auth.status_code == 401
    assert "authorization" in resp_no_auth.json().get("detail", "").lower()

    forged_token = generate_valid_jwt(secret="wrong_unauthorized_hmac_secret_key_32b")
    resp_forged = client.post(
        "/chat/stream",
        json={"message": "hello", "sessionId": "sess-1"},
        headers={
            "Authorization": f"Bearer {forged_token}",
            "Origin": "http://localhost:3000",
        },
    )
    assert resp_forged.status_code == 401
    assert "invalid token" in resp_forged.json().get("detail", "").lower()

    valid_token = generate_valid_jwt(secret=TEST_JWT_SECRET)
    with patch("agent.main.settings") as mock_settings:
        mock_settings.FRONTEND_URL = "http://localhost:3000"
        mock_settings.JWT_SECRET = TEST_JWT_SECRET
        mock_settings.jwt_secret_ring = [TEST_JWT_SECRET]
        resp_bad_origin = client.post(
            "/chat/stream",
            json={"message": "hello", "sessionId": "sess-1"},
            headers={
                "Authorization": f"Bearer {valid_token}",
                "Origin": "http://evil-attacker.example.com",
            },
        )
        assert resp_bad_origin.status_code == 403
        assert resp_bad_origin.json() == {"detail": "ORIGIN_NOT_ALLOWED"}


def test_chat_stream_rejected_when_guardrail_gateway_uninitialized_or_degraded() -> None:
    """Fail-closed check: when guardrail_gateway is None or degraded (is_healthy returns False), POST /chat/stream returns 503 with zero runner/model turns."""
    from agent.config import get_settings
    from agent.tools.nestjs_client import NestJSClient

    client = TestClient(app)
    app_settings = get_settings()
    valid_token = generate_valid_jwt(secret=app_settings.JWT_SECRET)

    mock_nestjs = MagicMock(spec=NestJSClient)
    mock_nestjs.check_user_access = AsyncMock(return_value={"allowed": True})

    mock_redis = MagicMock()
    mock_budget_repo = MagicMock()
    mock_budget_repo.admit_request = AsyncMock(return_value=True)

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs),
        patch("agent.streaming.sse.get_redis_client", return_value=mock_redis),
        patch("agent.streaming.sse.ChatBudgetRepository", return_value=mock_budget_repo),
        patch(
            "agent.streaming.sse.chat_budget_repository.ChatBudgetRepository",
            return_value=mock_budget_repo,
        ),
        patch("agent.streaming.sse.ChatTurnRunner") as mock_runner,
    ):
        with patch.object(app.state, "guardrail_gateway", None, create=True):
            resp1 = client.post(
                "/chat/stream",
                json={"message": "hello", "sessionId": "sess-1"},
                headers={
                    "Authorization": f"Bearer {valid_token}",
                    "Origin": "http://localhost:3000",
                },
            )
            assert resp1.status_code == 503
            assert "GUARDRAIL_GATEWAY_UNAVAILABLE" in resp1.json().get("detail", "")
            mock_runner.assert_not_called()

        degraded_gateway = DegradedGateway()
        with patch.object(app.state, "guardrail_gateway", degraded_gateway, create=True):
            resp2 = client.post(
                "/chat/stream",
                json={"message": "hello", "sessionId": "sess-1"},
                headers={
                    "Authorization": f"Bearer {valid_token}",
                    "Origin": "http://localhost:3000",
                },
            )
            assert resp2.status_code == 503
            assert "GUARDRAIL_GATEWAY_UNAVAILABLE" in resp2.json().get("detail", "")
            mock_runner.assert_not_called()


def test_gateway_failure_does_not_consume_quota() -> None:
    """Assert that when app.state.guardrail_gateway is None or degraded, sending /chat/stream returns HTTP 503 and ChatBudgetRepository.admit_request is NOT called (0 calls)."""
    from agent.config import get_settings
    from agent.tools.nestjs_client import NestJSClient

    client = TestClient(app)
    app_settings = get_settings()
    valid_token = generate_valid_jwt(secret=app_settings.JWT_SECRET)

    mock_nestjs = MagicMock(spec=NestJSClient)
    mock_nestjs.check_user_access = AsyncMock(return_value={"allowed": True})

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs),
        patch(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request",
            new_callable=AsyncMock,
        ) as mock_admit,
    ):
        with patch.object(app.state, "guardrail_gateway", None, create=True):
            resp1 = client.post(
                "/chat/stream",
                json={"message": "hello", "sessionId": "sess-1"},
                headers={
                    "Authorization": f"Bearer {valid_token}",
                    "Origin": "http://localhost:3000",
                },
            )
            assert resp1.status_code == 503
            assert "GUARDRAIL_GATEWAY_UNAVAILABLE" in resp1.json().get("detail", "")
            assert mock_admit.call_count == 0
            mock_admit.assert_not_called()

        degraded_gateway = DegradedGateway()
        with patch.object(app.state, "guardrail_gateway", degraded_gateway, create=True):
            resp2 = client.post(
                "/chat/stream",
                json={"message": "hello", "sessionId": "sess-1"},
                headers={
                    "Authorization": f"Bearer {valid_token}",
                    "Origin": "http://localhost:3000",
                },
            )
            assert resp2.status_code == 503
            assert "GUARDRAIL_GATEWAY_UNAVAILABLE" in resp2.json().get("detail", "")
            assert mock_admit.call_count == 0
            mock_admit.assert_not_called()


@pytest.mark.asyncio
async def test_zero_fail_open_bypass_invariant_input_validation() -> None:
    """Under NO condition (crash, unhandled exception, invalid context) does gateway fail open on input."""
    gateway = GuardrailGateway()

    d1 = await gateway.validate_input(None, "Search flights to Tokyo")  # type: ignore[arg-type]
    assert d1.status == "BLOCK"
    assert d1.response_key == GUARDRAIL_INPUT_INJECTION

    d2 = await gateway.validate_input("not-context", "Search flights")  # type: ignore[arg-type]
    assert d2.status == "BLOCK"

    class ExplodingLayer(InjectionDetector):
        key: ClassVar[str] = "input.exploding"
        stage: ClassVar[Literal["input"]] = "input"
        prerequisites: ClassVar[tuple[str, ...]] = ("input.length", "input.pii")

        async def check(self, context: Any, data: Any) -> PipelineDecision[Any]:
            raise RuntimeError("Catastrophic internal crash inside layer!")

    chaos_gateway = GuardrailGateway(
        _input_layers=(
            LengthValidator(),
            PIIDetector(),
            ExplodingLayer(),
            TopicBoundary(),
        )
    )

    valid_context = AdmissionContext(
        user_id="usr-123",
        chat_session_id="sess-456",
        trace_id="tr-789",
        correlation_id=None,
        policy_version="2026-09-05",
    )
    d3 = await chaos_gateway.validate_input(valid_context, "Benign travel inquiry")
    assert d3.status == "BLOCK"
    assert "failed closed" in (d3.reason or "").lower()


@pytest.mark.asyncio
async def test_zero_fail_open_bypass_invariant_tool_execution() -> None:
    """Tool gateway must fail closed under every failure mode: bad caps, unsealed tools, tool crashes."""
    gateway = GuardrailGateway()

    caps = TurnCapabilities(
        intent="SEARCH",
        provenance="trusted_router",
        sealed_tools=("search_flights",),
    )

    res_bad_context = await gateway.execute_tool(
        None,  # type: ignore[arg-type]
        {"name": "search_flights"},
        AsyncMock(return_value={"flights": []}),
    )
    assert res_bad_context.status == "BLOCK"
    assert res_bad_context.response_key == GUARDRAIL_TOOL_SCHEMA

    invoke_spy = AsyncMock(return_value={"unauthorized": "mutation"})
    res_unauthorized = await gateway.execute_tool(
        caps,
        {"name": "signal_checkout_intent"},
        invoke_spy,
    )
    assert res_unauthorized.status == "BLOCK"
    assert "not in sealed capabilities" in (res_unauthorized.reason or "")
    invoke_spy.assert_not_called()

    failing_invoke = AsyncMock(side_effect=RuntimeError("Database connection lost"))
    res_crash = await gateway.execute_tool(
        caps,
        {"name": "search_flights"},
        failing_invoke,
    )
    assert res_crash.status == "BLOCK"
    assert res_crash.response_key == GUARDRAIL_TOOL_SCHEMA
    assert "failed closed" in (res_crash.reason or "").lower()


@pytest.mark.asyncio
async def test_zero_fail_open_bypass_invariant_tool_batch_and_result() -> None:
    """Tool batch and result validations must fail closed without partial unauthorized leaks."""
    gateway = GuardrailGateway()

    caps = TurnCapabilities(
        intent="SEARCH",
        provenance="trusted_router",
        sealed_tools=("search_flights", "get_user_preferences"),
    )

    call1 = {"name": "search_flights"}
    call2 = {"name": "signal_checkout_intent"}
    spy1 = AsyncMock(return_value={"flights": []})
    spy2 = AsyncMock(return_value={"intent": "checkout"})

    batch_decision = await gateway.execute_tool_batch(
        caps,
        [call1, call2],
        [spy1, spy2],
    )
    assert batch_decision.status == "BLOCK"
    spy1.assert_not_called()
    spy2.assert_not_called()

    res_unsealed = await gateway.validate_tool_result(
        caps,
        "signal_checkout_intent",
        {"intent": "unauthorized"},
    )
    assert res_unsealed.status == "BLOCK"
    assert res_unsealed.response_key == GUARDRAIL_TOOL_SCHEMA


# ---------------------------------------------------------------------------
# Area B: Rollout & Rollback Rehearsal
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rollout_rollback_rehearsal_multi_agent_cycle() -> None:
    """
    Rehearses complete rollout cycle: enabled -> disabled (rollback) -> re-enabled.
    Verifies FEATURE_FLAG_CHAT_MULTI_AGENT toggle transitions safely without leaking authority.
    """
    base_state: AgentState = {
        "messages": [],
        "session_id": "sess-rollout-1",
        "user_id": "usr-rollout-1",
    }

    # Phase 1: Enabled (Multi-Agent Active)
    with (
        patch("agent.graph.graph.agent_config.get_settings") as mock_settings,
        patch("agent.graph.graph.invoke_router", new_callable=AsyncMock) as mock_router,
        patch("agent.graph.graph.evaluate_checkout_gate") as mock_gate,
    ):
        mock_settings.return_value.FEATURE_FLAG_CHAT_MULTI_AGENT = True
        mock_router.return_value = RouteDecision(
            intent="SEARCH",
            confidence=0.95,
            reasoning="User desires flights",
            isCommitment=False,
        )
        mock_gate.return_value = {
            "route": "travel",
            "disambiguation": "none",
            "routing_provenance": "trusted_router",
        }

        res_enabled = await router_node(base_state)
        assert res_enabled["route"] == "travel"
        assert res_enabled["routing_provenance"] == "trusted_router"
        assert "search_flights" in res_enabled["turn_capabilities"].sealed_tools
        assert "signal_checkout_intent" not in res_enabled["turn_capabilities"].sealed_tools

    # Phase 2: Rollback (Multi-Agent Disabled -> Single Agent Fallback)
    with patch("agent.graph.graph.agent_config.get_settings") as mock_settings_disabled:
        mock_settings_disabled.return_value.FEATURE_FLAG_CHAT_MULTI_AGENT = False

        res_rolled_back = await router_node(base_state)
        assert res_rolled_back["route"] == "travel"
        assert res_rolled_back["routing_provenance"] == "single_agent"
        # Sealed tools must NOT include checkout signal capability in single agent mode
        assert "signal_checkout_intent" not in res_rolled_back["turn_capabilities"].sealed_tools
        assert "search_flights" in res_rolled_back["turn_capabilities"].sealed_tools

    # Phase 3: Re-enabled (Multi-Agent Restored)
    with (
        patch("agent.graph.graph.agent_config.get_settings") as mock_settings_recheck,
        patch("agent.graph.graph.invoke_router", new_callable=AsyncMock) as mock_router,
        patch("agent.graph.graph.evaluate_checkout_gate") as mock_gate,
    ):
        mock_settings_recheck.return_value.FEATURE_FLAG_CHAT_MULTI_AGENT = True
        mock_router.return_value = RouteDecision(
            intent="CHECKOUT",
            confidence=0.98,
            reasoning="Ready to book flight",
            isCommitment=True,
        )
        mock_gate.return_value = {
            "route": "checkout",
            "disambiguation": "none",
            "routing_provenance": "trusted_router",
        }

        res_re_enabled = await router_node(base_state)
        assert res_re_enabled["route"] == "checkout"
        assert res_re_enabled["routing_provenance"] == "trusted_router"
        assert "signal_checkout_intent" in res_re_enabled["turn_capabilities"].sealed_tools


@pytest.mark.asyncio
async def test_rollout_rollback_rehearsal_handoff_cycle() -> None:
    """
    Rehearses handoff flag rollout & rollback: enabled -> disabled -> re-enabled.
    Verifies disabling handoff issuance preserves safe error states without executing NestJS mutations.
    """
    # User approved on 2026-10-03: this handoff state is canonical internal data; external search
    # response fields remain covered by their legacy wire fixtures.
    valid_state: AgentState = {
        "messages": [],
        "signal": {"action": "ACTION_HANDOFF", "offer_index": 1},
        "trusted_snapshot": {
            "version": 1,
            "attestation": "test_attestation",
            "fingerprint": "fp_test_123",
            "results": [
                {
                    "flightOfferId": "off_123",
                    "supplierOfferId": "supplier_123",
                    "airline": "Vietnam Airlines",
                    "origin": "HAN",
                    "destination": "NRT",
                    "departureAt": "2026-08-15T08:30:00Z",
                    "arrivalAt": "2026-08-15T15:00:00Z",
                    "price": "452.00",
                    "currency": "USD",
                }
            ],
        },
    }
    config = RunnableConfig(configurable={"user_id": "usr-123"})

    # Phase 1: Enabled -> create_handoff_token calls NestJS client
    with (
        patch("agent.graph.nodes.get_settings") as mock_settings,
        patch("agent.graph.nodes.get_nestjs_client") as mock_client_factory,
    ):
        mock_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = True
        mock_client = MagicMock()
        mock_client.create_handoff_token = AsyncMock(
            return_value={
                "handoffToken": "hnd_token_valid_xyz",
                "expiresAt": "2026-08-15T20:00:00Z",
            }
        )
        mock_client_factory.return_value = mock_client

        res_enabled = await create_handoff_token(valid_state, config)
        assert "action" in res_enabled
        assert res_enabled["action"].get("handoffToken") == "hnd_token_valid_xyz"
        mock_client.create_handoff_token.assert_called_once()

    # Phase 2: Rolled back (Disabled) -> returns clean error, NEVER calls NestJS
    with (
        patch("agent.graph.nodes.get_settings") as mock_settings_disabled,
        patch("agent.graph.nodes.get_nestjs_client") as mock_client_factory_disabled,
    ):
        mock_settings_disabled.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = False
        mock_client_disabled = MagicMock()
        mock_client_factory_disabled.return_value = mock_client_disabled

        res_disabled = await create_handoff_token(valid_state, config)
        assert res_disabled == {"action": {"error": "Chat handoff issuance is disabled."}}
        mock_client_disabled.create_handoff_token.assert_not_called()

    # Phase 3: Re-enabled -> works cleanly again
    with (
        patch("agent.graph.nodes.get_settings") as mock_settings_re_enabled,
        patch("agent.graph.nodes.get_nestjs_client") as mock_client_factory_re,
    ):
        mock_settings_re_enabled.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = True
        mock_client_re = MagicMock()
        mock_client_re.create_handoff_token = AsyncMock(
            return_value={
                "handoffToken": "hnd_token_restored_abc",
                "expiresAt": "2026-08-15T20:00:00Z",
            }
        )
        mock_client_factory_re.return_value = mock_client_re

        res_re = await create_handoff_token(valid_state, config)
        assert res_re["action"].get("handoffToken") == "hnd_token_restored_abc"
        mock_client_re.create_handoff_token.assert_called_once()


@pytest.mark.asyncio
async def test_rollout_rollback_rehearsal_booking_readiness_cycle() -> None:
    """
    Rehearses booking readiness flag rollout & rollback: FEATURE_FLAG_BOOKING_READINESS.
    When disabled, readiness checks fall back safely without executing unauthorized mutations or leaking PII.
    """
    from agent.config import get_settings
    from agent.guardrails.schemas.tools import PassengerToolInput
    from agent.tools.check_booking_readiness import check_booking_readiness

    passengers = [
        PassengerToolInput(
            passengerType="ADULT",
            passengerOrdinal=1,
            sourceType="traveler_profile",
        )
    ]

    mock_client = MagicMock()
    mock_client.check_booking_readiness = AsyncMock(
        return_value={
            "scope": "DOMESTIC",
            "ready": True,
            "passengers": [
                {
                    "passengerType": "ADULT",
                    "passengerOrdinal": 1,
                    "issues": [],
                }
            ],
            "nextAction": "CONTINUE_CHECKOUT",
        }
    )
    config = RunnableConfig(configurable={"nestjs_client": mock_client})

    # Phase 1: Enabled -> readiness executes NestJS client check
    with patch.object(get_settings(), "FEATURE_FLAG_BOOKING_READINESS", True):
        res1 = await check_booking_readiness.ainvoke(
            {"flight_offer_id": "off_123", "passengers": passengers},
            config=config,
        )
        assert res1.get("ready") is True
        mock_client.check_booking_readiness.assert_called_once()

    # Phase 2: Rollback / Disabled -> patch FEATURE_FLAG_BOOKING_READINESS = False
    mock_client.check_booking_readiness.reset_mock()
    with patch.object(get_settings(), "FEATURE_FLAG_BOOKING_READINESS", False):
        res2 = await check_booking_readiness.ainvoke(
            {"flight_offer_id": "off_123", "passengers": passengers},
            config=config,
        )
        mock_client.check_booking_readiness.assert_not_called()
        assert res2 == {"error": "Booking readiness feature is currently disabled."}
        # Confirm passengers or PII are not echoed back in error
        assert "Alice" not in str(res2)
        assert "Smith" not in str(res2)

    # Phase 3: Re-enabled -> toggle back to True
    mock_client.check_booking_readiness.reset_mock()
    with patch.object(get_settings(), "FEATURE_FLAG_BOOKING_READINESS", True):
        res3 = await check_booking_readiness.ainvoke(
            {"flight_offer_id": "off_123", "passengers": passengers},
            config=config,
        )
        assert res3.get("ready") is True
        mock_client.check_booking_readiness.assert_called_once()


@pytest.mark.asyncio
async def test_emergency_rollback_mid_stream_terminates_cleanly_and_purges_locks() -> None:
    """
    Simulate active streaming turn holding distributed session lease in MessageQueueManager.
    Trigger emergency mid-stream rollback/cancellation (e.g. generator close / server shutdown).
    Assert:
    1. Active turn terminates cleanly without hanging.
    2. Session lease/lock is purged/released via queue_manager.release so no orphan lock remains in Redis/manager.
    3. Zero unauthenticated mutations occur on NestJSClient (no booking creation or unauthorized message creation with invalid fence).
    """
    user_id = "usr-rollout-emer"
    session_id = "sess-rollout-emer"

    redis_store: dict[str, dict[str, str]] = {}

    async def mock_eval(script: str, numkeys: int, *args: Any) -> int:
        if "HSET" in script:  # acquire_lock
            lock_key = str(args[0])
            req_id = str(args[2])
            redis_store[lock_key] = {"req_id": req_id, "fence": "1"}
            return 1
        if "DEL" in script:  # release_lock
            lock_key = str(args[0])
            req_id = str(args[1])
            fence = str(args[2])
            entry = redis_store.get(lock_key)
            if entry and entry.get("req_id") == req_id and entry.get("fence") == fence:
                redis_store.pop(lock_key, None)
                return 1
            return 0
        return 1

    async def mock_hget(key: str, field: str) -> Optional[str]:
        return redis_store.get(key, {}).get(field)

    mock_redis = MagicMock()
    mock_redis.eval = AsyncMock(side_effect=mock_eval)
    mock_redis.hget = AsyncMock(side_effect=mock_hget)

    mock_client = MagicMock(spec=NestJSClient)
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg-agent-emer", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()
    mock_client.create_booking = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args: Any, **kwargs: Any) -> Any:
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Planning emergency itinerary...")},
        }
        # Simulate long-running in-flight turn waiting for model stream
        await asyncio.sleep(60)

    mock_graph.astream_events = mock_astream_events

    with patch(
        "agent.repositories.session_lock_repository.get_redis_client",
        return_value=mock_redis,
    ):
        queue_manager = MessageQueueManager()
        queue_manager.repo = SessionLockRepository()
        runner = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=queue_manager,
            client_factory=lambda **kwargs: mock_client,
            redis_client=mock_redis,
        )

        command = ChatTurnCommand(
            user_id=user_id,
            session_id=session_id,
            message="Search flights to Tokyo",
            token="jwt.mock.token",
        )

        gen = runner.run(command)

        event = await anext(gen)
        assert isinstance(event, TokenEvent)
        assert "Planning emergency" in event.data.content

        assert session_id in queue_manager.active_fences
        assert queue_manager.depths.get(session_id) == 1
        assert queue_manager.get_fence(session_id) == 1
        mock_client.set_fencing_token.assert_called_with(1)
        expected_lock_key = f"chat:session-lock:{user_id}:{session_id}"
        assert expected_lock_key in redis_store

        await asyncio.wait_for(gen.aclose(), timeout=5.0)

        assert await anext(gen, None) is None
        assert session_id not in queue_manager.active_fences
        assert session_id not in queue_manager.depths
        assert expected_lock_key not in redis_store
        mock_client.create_booking.assert_not_called()

        session_id_stale = "sess-rollout-stale"
        mock_client_stale = MagicMock(spec=NestJSClient)
        mock_client_stale.get_memory = AsyncMock(
            return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
        )
        mock_client_stale.create_message_batch = AsyncMock()
        mock_client_stale.set_fencing_token = MagicMock()
        mock_client_stale.create_booking = AsyncMock()

        runner_stale = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=queue_manager,
            client_factory=lambda **kwargs: mock_client_stale,
            redis_client=mock_redis,
        )
        cmd_stale = ChatTurnCommand(
            user_id=user_id,
            session_id=session_id_stale,
            message="Second search flight",
            token="jwt.mock.token",
        )

        gen_stale = runner_stale.run(cmd_stale)
        event_stale = await anext(gen_stale)
        assert isinstance(event_stale, TokenEvent)

        stale_lock_key = f"chat:session-lock:{user_id}:{session_id_stale}"
        redis_store[stale_lock_key] = {"req_id": "stolen-req-id", "fence": "999"}

        await asyncio.wait_for(gen_stale.aclose(), timeout=5.0)

        assert await anext(gen_stale, None) is None
        assert session_id_stale not in queue_manager.active_fences
        assert session_id_stale not in queue_manager.depths

        for call_args in mock_client_stale.create_message_batch.call_args_list:
            persisted_messages = call_args[0][1] if len(call_args[0]) > 1 else call_args.args[1]
            assert all(m.get("sender") != "AGENT" for m in persisted_messages)

        mock_client_stale.create_booking.assert_not_called()

        session_id_rejected = "sess-rollout-rejected"
        mock_client_rejected = MagicMock(spec=NestJSClient)
        mock_client_rejected.create_message_batch = AsyncMock()
        mock_client_rejected.create_booking = AsyncMock()

        queue_manager.depths[session_id_rejected] = queue_manager.max_depth
        runner_rejected = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=queue_manager,
            client_factory=lambda **kwargs: mock_client_rejected,
            redis_client=mock_redis,
        )
        cmd_rejected = ChatTurnCommand(
            user_id=user_id,
            session_id=session_id_rejected,
            message="Third attempt rejected",
            token="jwt.mock.token",
        )
        gen_rejected = runner_rejected.run(cmd_rejected)
        rej_event = await anext(gen_rejected)
        assert rej_event.event == "error"
        assert rej_event.data.code == "PERSISTENCE_ERROR"
        mock_client_rejected.create_message_batch.assert_not_called()
        mock_client_rejected.create_booking.assert_not_called()


# ---------------------------------------------------------------------------
# Area C: Health Verification Probes
# ---------------------------------------------------------------------------


def test_health_live_probe_guarantees() -> None:
    """Verify /health/live probe succeeds with status ok without model inference, guardrails, or heavy I/O."""
    client = TestClient(app)

    with (
        patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_http_get,
        patch("agent.infrastructure.redis.get_redis_client") as mock_redis,
    ):
        response = client.get("/health/live")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

        mock_http_get.assert_not_called()
        mock_redis.assert_not_called()


def test_health_probe_dependency_reporting_matrix() -> None:
    """Verify /health accurately reports dependency status (guardrails: deterministic, redis, nestjsApi)."""
    client = TestClient(app)

    mock_redis_ok = MagicMock()
    mock_redis_ok.ping = AsyncMock(return_value=True)

    with (
        patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get,
        patch("agent.main.settings") as mock_settings,
        patch("agent.infrastructure.redis.get_redis_client", return_value=mock_redis_ok),
    ):
        mock_settings.NESTJS_API_URL = "http://localhost:3001"
        mock_get.return_value = httpx.Response(
            200,
            json={"status": "ok"},
            request=httpx.Request("GET", "http://localhost:3001/api/health"),
        )

        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["dependencies"]["guardrails"] == {"status": "deterministic"}
        assert data["dependencies"]["nestjsApi"]["status"] == "ok"
        assert data["dependencies"]["redis"]["status"] == "ok"

    with (
        patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get_down,
        patch("agent.main.settings") as mock_settings,
        patch("agent.infrastructure.redis.get_redis_client", return_value=mock_redis_ok),
    ):
        mock_settings.NESTJS_API_URL = "http://localhost:3001"
        mock_get_down.side_effect = httpx.RequestError("NestJS unreachable")

        resp_down = client.get("/health")
        assert resp_down.status_code == 200
        data_down = resp_down.json()
        assert data_down["status"] == "degraded"
        assert data_down["dependencies"]["nestjsApi"]["status"] == "down"
        assert data_down["dependencies"]["guardrails"] == {"status": "deterministic"}
        assert data_down["dependencies"]["redis"]["status"] == "ok"

    mock_redis_down = MagicMock()
    mock_redis_down.ping = AsyncMock(side_effect=RuntimeError("Redis disconnected"))

    with (
        patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get_ok,
        patch("agent.main.settings") as mock_settings,
        patch("agent.infrastructure.redis.get_redis_client", return_value=mock_redis_down),
    ):
        mock_settings.NESTJS_API_URL = "http://localhost:3001"
        mock_get_ok.return_value = httpx.Response(
            200,
            json={"status": "ok"},
            request=httpx.Request("GET", "http://localhost:3001/api/health"),
        )

        resp_redis_down = client.get("/health")
        assert resp_redis_down.status_code == 200
        data_redis_down = resp_redis_down.json()
        assert data_redis_down["status"] == "degraded"
        assert data_redis_down["dependencies"]["redis"]["status"] == "down"
        assert data_redis_down["dependencies"]["nestjsApi"]["status"] == "ok"
        assert data_redis_down["dependencies"]["guardrails"] == {"status": "deterministic"}


def test_health_probe_reports_down_when_guardrails_or_keys_missing() -> None:
    """Verify /health reports guardrails down and overall degraded when gateway or keys are missing."""
    client = TestClient(app)
    mock_redis = MagicMock()
    mock_redis.ping = AsyncMock(return_value=True)

    with (
        patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get,
        patch("agent.infrastructure.redis.get_redis_client", return_value=mock_redis),
        patch("agent.main.settings") as mock_settings,
    ):
        mock_settings.NESTJS_API_URL = "http://localhost:3001"
        mock_settings.AGENT_SERVICE_API_KEY = "test-agent-key"
        mock_settings.JWT_SECRET = TEST_JWT_SECRET
        mock_settings.CLAIM_TOKEN_SECRET = TEST_CLAIM_SECRET
        mock_get.return_value = httpx.Response(
            200,
            json={"status": "ok"},
            request=httpx.Request("GET", "http://localhost:3001/api/health"),
        )

        base_resp = client.get("/health")
        assert base_resp.status_code == 200
        assert base_resp.json()["status"] == "ok"
        assert base_resp.json()["dependencies"]["guardrails"]["status"] == "deterministic"

        with patch.object(app.state, "guardrail_gateway", None, create=True):
            resp = client.get("/health")
            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "degraded"
            assert data["dependencies"]["guardrails"]["status"] == "down"

        degraded_gateway = DegradedGateway()
        with patch.object(app.state, "guardrail_gateway", degraded_gateway, create=True):
            resp = client.get("/health")
            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "degraded"
            assert data["dependencies"]["guardrails"]["status"] == "down"

        mock_settings.AGENT_SERVICE_API_KEY = ""
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "degraded"
        assert data["dependencies"]["guardrails"]["status"] == "down"
        mock_settings.AGENT_SERVICE_API_KEY = "test-agent-key"

        mock_settings.JWT_SECRET = ""
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "degraded"
        assert data["dependencies"]["guardrails"]["status"] == "down"
        mock_settings.JWT_SECRET = TEST_JWT_SECRET

        mock_settings.CLAIM_TOKEN_SECRET = ""
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "degraded"
        assert data["dependencies"]["guardrails"]["status"] == "down"
        mock_settings.CLAIM_TOKEN_SECRET = TEST_CLAIM_SECRET
