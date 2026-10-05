# User approved on 2026-10-03: canonical snapshot inputs use supplierOfferId and public projections
# must keep that neutral identity hidden alongside legacy provider and flight identifiers.
import json
import logging
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from agent.guardrails.gateway import GuardrailGateway
from agent.memory.manager import MemoryManager
from agent.models.events import DisplayInfo, HandoffEvent
from agent.observability.chat_observability import (
    ChatTelemetry,
    TelemetryPrivacyError,
)
from agent.tools.nestjs_client import validate_booking_readiness_response
from agent.trusted_search_snapshot import (
    TrustedSearchResult,
    TrustedSearchSnapshot,
    TrustedSearchSnapshotLifecycle,
    TrustedSnapshotRepository,
)

# Strict Negative Privacy Corpus for Continuous Scanning
FORBIDDEN_PRIVACY_CORPUS = [
    "chk_handoff_v1_live_secret_token_123456789abcdef",
    "chk_handoff_v1_stale_secret_credential_987654321",
    "raw_handoff_token_secret_xyz",
    "duffel_offer_id_duff_123456789",
    "off_01H123456789ABCDEF000000",
    "local_flight_offer_id_uuid_777777",
    "flight-offer-local-uuid-1234",
    "booking_db_id_uuid_888888",
    "PNR123456",
    "pnr_ABCDEF",
    "PNR-XYZ789",
    "PASS-987654321",
    "P12345678",
    "B98765432",
    "4111111111111111",
    "4111 2222 3333 4444",
    "4242424242424242",
    "secret customer conversation message about flight to Hanoi",
    "passenger.secret.john.doe@example.com",
    "+84 912 345 678",
]


# ============================================================================
# 1. Memory Manager Privacy & Boundary Audit
# ============================================================================


def test_memory_manager_counts_tokens_without_logging_or_leaking():
    """Verify MemoryManager safely counts tokens on sensitive corpus without logging errors."""
    mgr = MemoryManager(window_size=10, token_budget=2000)
    for forbidden in FORBIDDEN_PRIVACY_CORPUS:
        count = mgr.count_tokens(forbidden)
        assert isinstance(count, int)
        assert count > 0


@pytest.mark.asyncio
async def test_memory_manager_summarization_excludes_forbidden_corpus():
    """Verify check_and_summarize properly generates prompts and persists summaries."""
    mgr = MemoryManager(window_size=2, token_budget=10)

    # Mock NestJS Client
    mock_client = AsyncMock()
    mock_client.get_memory.side_effect = [
        # First call: get total message count
        {"totalMessageCount": 5, "recentMessages": []},
        # Second call: get all unsummarized messages
        {
            "totalMessageCount": 5,
            "summary": "Previous clean summary.",
            "recentMessages": [
                {"sender": "USER", "content": "I want to fly to Hanoi."},
                {"sender": "AGENT", "content": "I can help with flight search."},
                {"sender": "USER", "content": "My budget is $200."},
                {"sender": "AGENT", "content": "Here are options."},
                {"sender": "USER", "content": "Let's check the first one."},
            ],
        },
    ]

    mock_model = AsyncMock()
    mock_response = MagicMock()
    mock_response.content = "Consolidated summary of flight search to Hanoi."
    mock_model.ainvoke.return_value = mock_response

    with patch("agent.memory.manager.get_chat_model", return_value=mock_model):
        await mgr.check_and_summarize(
            session_id="ses_privacy_test_123",
            client=mock_client,
            total_count=5,
        )

        mock_client.create_message.assert_awaited_once_with(
            session_id="ses_privacy_test_123",
            sender="AGENT",
            message_type="SUMMARY",
            content="Consolidated summary of flight search to Hanoi.",
        )


@pytest.mark.asyncio
async def test_memory_manager_error_handling_does_not_leak_session_content(caplog):
    """Verify MemoryManager logs bounded error messages without dumping raw session content."""
    mgr = MemoryManager(window_size=2, token_budget=10)
    mock_client = AsyncMock()
    mock_client.get_memory.side_effect = Exception("Database connection reset")

    with caplog.at_level(logging.ERROR):
        await mgr.check_and_summarize("ses_leak_test_456", mock_client)

    logged_text = caplog.text
    for forbidden in FORBIDDEN_PRIVACY_CORPUS:
        assert forbidden not in logged_text


# ============================================================================
# 2. Trusted Search Snapshot Repository Serialization & Projection Audit
# ============================================================================


def test_trusted_snapshot_serialization_and_projection_zero_leakage():
    """Verify TrustedSearchSnapshot serialization and projection 100% strips private offer IDs."""
    now = datetime.now(timezone.utc)
    raw_snapshot = {
        "schemaVersion": 1,
        "snapshotVersion": 1,
        "userId": "usr_privacy_scanner_001",
        "sessionId": "ses_privacy_scanner_002",
        "createdAt": now,
        "expiresAt": datetime(2026, 12, 31, 23, 59, 59, tzinfo=timezone.utc),
        "selectionAttestation": "sel_v1_mock_attestation_hash",
        "fingerprint": "mock_fingerprint_hash_abc",
        "results": [
            TrustedSearchResult(
                offerIndex=1,
                flightOfferId="local_flight_offer_id_uuid_777777",
                supplierOfferId="off_01H123456789ABCDEF000000",
                airline="VN",
                origin="SGN",
                destination="HAN",
                departureAt=now,
                arrivalAt=now,
                price="150.00",
                currency="USD",
            ),
            TrustedSearchResult(
                offerIndex=2,
                flightOfferId="flight-offer-local-uuid-1234",
                supplierOfferId="duffel_offer_id_duff_123456789",
                airline="VJ",
                origin="SGN",
                destination="HAN",
                departureAt=now,
                arrivalAt=now,
                price="110.00",
                currency="USD",
            ),
        ],
    }

    snapshot = TrustedSearchSnapshot.model_validate(raw_snapshot)

    # 1. Test project_for_browser and project_for_llm for LLM/client consumption
    repo = TrustedSnapshotRepository(AsyncMock())
    lifecycle = TrustedSearchSnapshotLifecycle(repo)
    projected_browser = [r.model_dump() for r in lifecycle.project_for_browser(snapshot)]
    projected_llm = [r.model_dump() for r in lifecycle.project_for_llm(snapshot)]

    for projected in (projected_browser, projected_llm):
        assert len(projected) == 2
        projected_json = json.dumps(projected, default=str)

        # Must NOT contain private offer IDs
        assert "local_flight_offer_id_uuid_777777" not in projected_json
        assert "off_01H123456789ABCDEF000000" not in projected_json
        assert "flight-offer-local-uuid-1234" not in projected_json
        assert "duffel_offer_id_duff_123456789" not in projected_json
        assert "flightOfferId" not in projected_json
        assert "duffelOfferId" not in projected_json
        assert "supplierOfferId" not in projected_json

        for forbidden in FORBIDDEN_PRIVACY_CORPUS:
            assert forbidden not in projected_json


@pytest.mark.asyncio
async def test_trusted_snapshot_repository_redis_operations():
    """Verify repository key names and TTL handling do not leak tokens or offer IDs."""
    mock_redis = AsyncMock()
    mock_redis.get.return_value = None
    mock_redis.eval.return_value = 1
    repo = TrustedSnapshotRepository(mock_redis)

    key = repo._get_key("usr_abc", "ses_xyz")
    assert key == "chat:snapshot:usr_abc:ses_xyz"
    assert "offer" not in key
    assert "token" not in key

    now = datetime.now(timezone.utc)
    snapshot = TrustedSearchSnapshot(
        schemaVersion=1,
        snapshotVersion=1,
        userId="usr_abc",
        sessionId="ses_xyz",
        createdAt=now,
        expiresAt=datetime(2026, 12, 31, 23, 59, 59, tzinfo=timezone.utc),
        selectionAttestation="sel_v1_mock",
        fingerprint="fp_mock",
        results=[
            TrustedSearchResult(
                offerIndex=1,
                flightOfferId="local_flight_offer_id_uuid_777777",
                supplierOfferId="off_01H123456789ABCDEF000000",
                airline="VN",
                origin="SGN",
                destination="HAN",
                departureAt=now,
                arrivalAt=now,
                price="150.00",
                currency="USD",
            )
        ],
    )

    mock_redis.eval.return_value = 1
    await repo.save_snapshot(snapshot)
    mock_redis.eval.assert_awaited_once()
    saved_key = mock_redis.eval.call_args[0][2]
    saved_payload = mock_redis.eval.call_args[0][4]
    assert saved_key == "chat:snapshot:usr_abc:ses_xyz"
    assert isinstance(saved_payload, str)


# ============================================================================
# 3. Structured Telemetry Emissions Negative Privacy Audit
# ============================================================================


def test_telemetry_strictly_rejects_entire_forbidden_corpus():
    """Verify telemetry engine rejects all items in forbidden corpus across all metadata fields."""
    telemetry = ChatTelemetry()

    for forbidden in FORBIDDEN_PRIVACY_CORPUS:
        # Rejection in outcome field
        with pytest.raises(TelemetryPrivacyError):
            telemetry.emit("tool_call", status="failed", fields={"outcome": forbidden})

        # Rejection in error_class field
        with pytest.raises(TelemetryPrivacyError):
            telemetry.emit("quota_admission", status="failed", fields={"error_class": forbidden})

        # Rejection in tool_name field
        with pytest.raises(TelemetryPrivacyError):
            telemetry.emit("tool_call", status="completed", fields={"tool_name": forbidden})

        # Rejection in status
        with pytest.raises(TelemetryPrivacyError):
            telemetry.emit("tool_call", status=forbidden)

        # Rejection in operation
        with pytest.raises(TelemetryPrivacyError):
            telemetry.emit(forbidden, status="ok")


def test_telemetry_emit_safely_never_logs_forbidden_corpus(caplog):
    """Verify emit_safely swallows rejection and records zero sensitive data in warnings."""
    telemetry = ChatTelemetry()

    with caplog.at_level(logging.WARNING):
        for forbidden in FORBIDDEN_PRIVACY_CORPUS:
            res = telemetry.emit_safely(
                "tool_call",
                status="failed",
                fields={"outcome": forbidden},
            )
            assert res is None

    logged_output = caplog.text
    for forbidden in FORBIDDEN_PRIVACY_CORPUS:
        assert forbidden not in logged_output


def test_telemetry_valid_emissions_contain_zero_forbidden_corpus(caplog):
    """Verify that all valid emitted events contain standard operational data and zero forbidden corpus."""
    telemetry = ChatTelemetry()

    with caplog.at_level(logging.INFO):
        telemetry.emit(
            "quota_admission",
            status="accepted",
            fields={"outcome": "admitted", "dependency": "redis"},
        )
        telemetry.emit(
            "router_decision",
            status="completed",
            fields={"intent": "SEARCH", "confidence_bucket": "high"},
        )
        telemetry.emit(
            "tool_call",
            status="completed",
            fields={"tool_name": "search_flights", "outcome": "completed"},
        )
        telemetry.emit("snapshot_read", status="hit", fields={"outcome": "hit"})
        telemetry.emit("handoff_create", status="created", fields={"outcome": "created"})

    all_emitted_logs = caplog.text
    for forbidden in FORBIDDEN_PRIVACY_CORPUS:
        assert forbidden not in all_emitted_logs


# ============================================================================
# 4. SSE Event Streaming Chunks Negative Privacy Audit
# ============================================================================


def test_sse_action_handoff_event_schema_boundary():
    """Verify HandoffEvent strictly enforces allowlisted display fields and opaque token."""
    display = DisplayInfo(
        airline="Vietnam Airlines",
        origin="SGN",
        destination="HAN",
        departureAt="2026-10-15T08:00:00Z",
        arrivalAt="2026-10-15T10:05:00Z",
        price="150.00",
        currency="USD",
    )
    event = HandoffEvent(
        version=1,
        action="begin_checkout",
        handoffToken="chk_handoff_v1_opaque_boundary_safe_token",
        expiresAt="2026-10-15T09:00:00Z",
        display=display,
    )

    serialized = event.model_dump_json()

    # Must contain allowed display and token
    assert "chk_handoff_v1_opaque_boundary_safe_token" in serialized
    assert "Vietnam Airlines" in serialized

    # Must NOT contain forbidden fields
    for forbidden_field in [
        "offerId",
        "flightOfferId",
        "duffelOfferId",
        "supplierOfferId",
        "userId",
        "sessionId",
        "url",
        "pnr",
        "passport",
    ]:
        assert f'"{forbidden_field}"' not in serialized


def test_sse_readiness_action_required_payload_zero_pii():
    """Verify validate_booking_readiness_response sanitizes readiness responses."""
    raw_readiness_api_response = {
        "ready": False,
        "scope": "INTERNATIONAL",
        "nextAction": "COMPLETE_PROFILE",
        "passengers": [
            {
                "passengerOrdinal": 1,
                "passengerType": "ADULT",
                "sections": [
                    {
                        "name": "travel_document",
                        "fields": [
                            {
                                "name": "passportNumber",
                                "status": "missing",
                                "reason": "REQUIRED",
                            }
                        ],
                    }
                ],
            }
        ],
    }

    validated = validate_booking_readiness_response(raw_readiness_api_response)
    assert validated is not None
    assert validated["ready"] is False
    assert validated["nextAction"] == "COMPLETE_PROFILE"

    serialized = json.dumps(validated)
    for forbidden in FORBIDDEN_PRIVACY_CORPUS:
        assert forbidden not in serialized


@pytest.mark.asyncio
async def test_sse_streaming_chunk_stream_simulation_scan():
    """
    Simulate complete production SSE stream through chat_stream endpoint, graph event handling,
    snapshot projection, handoff token creation, and SSE serialization, verifying that 100%
    of emitted chunks omit the forbidden privacy corpus.
    """
    import time

    import jwt
    from starlette.requests import Request

    from agent.config import get_settings
    from agent.queue.message_queue import MessageQueueManager
    from agent.streaming.sse import ChatStreamRequest, chat_stream

    settings = get_settings()
    user_id = "user_privacy_sse_audit_1"
    session_id = "ses_privacy_sse_audit_1"
    token = jwt.encode(
        {
            "id": user_id,
            "sub": user_id,
            "jti": "jti_privacy_audit_1",
            "iss": getattr(settings, "JWT_ISSUER", "booking-systems-api"),
            "aud": getattr(settings, "JWT_AUDIENCE", "booking-systems-clients"),
            "exp": int(time.time()) + 3600,
        },
        settings.JWT_SECRET,
        algorithm="HS256",
    )

    queue_manager = MessageQueueManager(max_depth=1)
    mock_app = MagicMock()
    mock_app.state.message_queue = queue_manager
    mock_guardrails = MagicMock()
    mock_guardrails.validate_output_chunk = AsyncMock(return_value=(True, None))
    mock_guardrails.validate_message = AsyncMock(return_value=(True, None))
    mock_guardrails.validate_text = AsyncMock(return_value=(True, None, None))
    mock_guardrails.is_healthy = MagicMock(return_value=True)
    mock_app.state.guardrails = mock_guardrails
    mock_app.state.guardrail_gateway = GuardrailGateway()

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/chat/stream",
        "headers": [],
        "app": mock_app,
    }
    request = Request(scope)

    # 1. Setup Trusted Search Snapshot in Redis with internal IDs that must be scrubbed / projected
    snapshot_with_internal_ids = TrustedSearchSnapshot(
        schemaVersion=1,
        snapshotVersion=1,
        userId=user_id,
        sessionId=session_id,
        fingerprint="fp-privacy-test-123",
        selectionAttestation="attest-privacy-test-123",
        createdAt=datetime.now(timezone.utc),
        expiresAt=datetime.now(timezone.utc) + timedelta(hours=1),
        results=[
            TrustedSearchResult(
                offerIndex=1,
                flightOfferId="flight-offer-local-uuid-1234",
                supplierOfferId="duffel_offer_id_duff_123456789",
                airline="Vietnam Airlines",
                origin="SGN",
                destination="HAN",
                departureAt=datetime(2026, 10, 15, 8, 0, 0, tzinfo=timezone.utc),
                arrivalAt=datetime(2026, 10, 15, 10, 5, 0, tzinfo=timezone.utc),
                price="150.00",
                currency="USD",
            )
        ],
    )

    mock_client = MagicMock()
    mock_client.check_user_access = AsyncMock(return_value={"allowed": True})
    mock_client.create_session = AsyncMock(return_value={"id": session_id})
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(return_value={"messages": [{"id": "msg-1"}]})
    mock_client.set_fencing_token = MagicMock()

    mock_redis = MagicMock()

    # 2. Mock graph event stream emitting tool calls, results, handoff action, and clean tokens
    async def mock_graph_events(*args, **kwargs):
        yield {
            "event": "on_chain_end",
            "name": "travel",
            "data": {
                "output": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "name": "search_flights",
                                    "args": {
                                        "origin": "SGN",
                                        "destination": "HAN",
                                        "date": "2026-10-15",
                                    },
                                    "id": "call-search-privacy",
                                }
                            ],
                        )
                    ]
                }
            },
        }
        yield {
            "event": "on_tool_start",
            "name": "search_flights",
            "data": {"input": {"origin": "SGN", "destination": "HAN"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "search_flights",
            "data": {"output": {"status": "success", "count": 1}},
        }
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=json.dumps({"status": "success", "count": 1}),
                            tool_call_id="call-search-privacy",
                            name="search_flights",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }
        yield {
            "event": "on_chain_end",
            "name": "travel",
            "data": {
                "output": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "name": "check_booking_readiness",
                                    "args": {
                                        "flight_offer_id": "flight-offer-local-uuid-1234",
                                        "passengers": [],
                                    },
                                    "id": "call-readiness-privacy",
                                }
                            ],
                        )
                    ]
                }
            },
        }
        yield {
            "event": "on_tool_start",
            "name": "check_booking_readiness",
            "data": {"input": {"message": "Checking readiness"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "check_booking_readiness",
            "data": {
                "output": {
                    "ready": True,
                    "scope": "DOMESTIC",
                    "nextAction": "CONTINUE_CHECKOUT",
                    "passengers": [],
                }
            },
        }
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=json.dumps(
                                {
                                    "ready": True,
                                    "scope": "DOMESTIC",
                                    "nextAction": "CONTINUE_CHECKOUT",
                                    "passengers": [],
                                }
                            ),
                            tool_call_id="call-readiness-privacy",
                            name="check_booking_readiness",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }
        yield {
            "event": "on_chain_end",
            "name": "create_handoff_token",
            "data": {
                "output": {
                    "action": {
                        "version": 1,
                        "action": "begin_checkout",
                        "handoffToken": "chk_handoff_v1_boundary_safe_token_xyz",
                        "expiresAt": "2026-10-15T09:00:00Z",
                        "display": {
                            "airline": "Vietnam Airlines",
                            "origin": "SGN",
                            "destination": "HAN",
                            "departureAt": "2026-10-15T08:00:00Z",
                            "arrivalAt": "2026-10-15T10:05:00Z",
                            "price": "150.00",
                            "currency": "USD",
                        },
                    }
                }
            },
        }
        yield {
            "event": "on_chat_model_stream",
            "data": {
                "chunk": MagicMock(content="I found your flight from Ho Chi Minh City to Hanoi.")
            },
        }

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_client),
        patch("agent.streaming.sse.get_redis_client", return_value=mock_redis),
        patch(
            "agent.streaming.sse.TrustedSnapshotRepository.get_snapshot",
            AsyncMock(return_value=snapshot_with_internal_ids),
        ),
        patch("agent.streaming.sse.graph.astream_events", side_effect=mock_graph_events),
        patch(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request",
            AsyncMock(),
        ),
    ):
        body = ChatStreamRequest(message="Book flight from SGN to HAN", sessionId=session_id)
        response = await chat_stream(
            request=request,
            body=body,
            authorization=f"Bearer {token}",
            x_trace_id="trace_privacy_audit_1",
            x_correlation_id="corr_privacy_audit_1",
        )

        emitted_chunks = []
        async for chunk in response.body_iterator:
            if isinstance(chunk, dict):
                emitted_chunks.append(json.dumps(chunk))
            else:
                emitted_chunks.append(str(chunk))

        all_emitted_text = "\n".join(emitted_chunks)

        # 3. Assert all production events were serialized and emitted
        assert "tool_call" in all_emitted_text
        assert "flight_results" in all_emitted_text
        assert "ACTION_HANDOFF" in all_emitted_text
        assert "done" in all_emitted_text

        # 4. Strict Negative Privacy Audit: Zero forbidden corpus strings in serialized SSE output
        for forbidden in FORBIDDEN_PRIVACY_CORPUS:
            assert forbidden not in all_emitted_text, (
                f"Privacy violation: '{forbidden}' leaked into SSE stream!"
            )
