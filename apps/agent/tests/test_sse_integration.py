import json
import logging
import time
from typing import Any, AsyncIterator, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import jwt
import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from pydantic import Field

from agent.config import get_settings
from agent.main import app
from agent.models.requests import RouteDecision
from agent.tools.nestjs_client import NestJSClient


class MockStreamingLLM(BaseChatModel):
    responses: List[Any] = Field(default_factory=list)

    def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
        return self

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        resp = self.responses.pop(0) if self.responses else AIMessage(content="Hello")
        return ChatResult(generations=[ChatGeneration(message=resp)])

    async def _astream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        resp = self.responses.pop(0) if self.responses else AIMessage(content="Hello")
        if resp.tool_calls:
            yield ChatGenerationChunk(
                message=AIMessageChunk(content=resp.content, tool_calls=resp.tool_calls, id=resp.id)
            )
        else:
            content = resp.content
            if content:
                words = content.split(" ")
                for i, word in enumerate(words):
                    space = " " if i < len(words) - 1 else ""
                    yield ChatGenerationChunk(message=AIMessageChunk(content=word + space))
            else:
                yield ChatGenerationChunk(message=AIMessageChunk(content=""))

    @property
    def _llm_type(self) -> str:
        return "mock-streaming-llm"


def parse_sse(lines):
    events = []
    current_event = {}
    for line in lines:
        if isinstance(line, bytes):
            line = line.decode("utf-8")
        line = line.strip()
        if not line:
            if current_event:
                events.append(current_event)
                current_event = {}
            continue
        if ":" in line:
            key, val = line.split(":", 1)
            key = key.strip()
            val = val.strip()
            if key == "event":
                current_event["event"] = val
            elif key == "data":
                try:
                    current_event["data"] = json.loads(val)
                except Exception:
                    current_event["data"] = val
    if current_event:
        events.append(current_event)
    return events


JWT_SECRET = "testsecret_must_be_at_least_32_bytes_long_for_security_reasons"


def get_auth_headers():
    payload = {
        "sub": "12345",
        "iss": "booking-systems-api",
        "aud": "booking-systems-clients",
        "jti": "jti-test-uuid",
        "email": "test@example.com",
        "exp": int(time.time()) + 100,
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def mock_nestjs_client():
    client = MagicMock(spec=NestJSClient)
    client.check_user_access = AsyncMock(return_value={"allowed": True})
    client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    client.create_message_batch = AsyncMock(
        return_value={
            "messages": [
                {"id": "msg-user-123", "sender": "USER"},
                {"id": "msg-agent-456", "sender": "AGENT"},
            ]
        }
    )
    client.get_gateway_flights_search = AsyncMock()
    client.post_gateway_flights_search_v2 = AsyncMock()
    return client


@pytest.fixture(autouse=True)
def mock_guardrails(monkeypatch):
    mock_gr = MagicMock()
    mock_gr.is_healthy.return_value = True
    mock_gr.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_gr, raising=False)
    return mock_gr


@pytest.fixture
def multi_agent_enabled():
    """Isolate checkout tests from the independent single-agent rollback default."""
    settings = get_settings().model_copy(update={"FEATURE_FLAG_CHAT_MULTI_AGENT": True})
    with patch("agent.graph.graph.agent_config.get_settings", return_value=settings):
        yield


@pytest.mark.asyncio
async def test_sse_simple_chat(mock_nestjs_client):
    headers = get_auth_headers()
    llm = MockStreamingLLM(responses=[AIMessage(content="Hello there! How can I help you today?")])

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False),
        ),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "hello", "sessionId": "session-simple"},
                headers=headers,
            )
            assert response.status_code == 200

            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)

            token_events = [e for e in events if e["event"] == "token"]
            done_events = [e for e in events if e["event"] == "done"]

            assert len(token_events) > 0
            assert (
                "".join([e["data"]["content"] for e in token_events])
                == "Hello there! How can I help you today?"
            )
            assert len(done_events) == 1
            assert done_events[0]["data"]["sessionId"] == "session-simple"


@pytest.mark.asyncio
async def test_sse_readonly_tool(mock_nestjs_client):
    headers = get_auth_headers()

    mock_nestjs_client.post_gateway_flights_search_v2.return_value = {
        "snapshotVersion": 1,
        "snapshotExpiresAt": "2027-08-15T10:00:00Z",
        "selectionAttestation": "mock_attestation",
        "results": [
            {
                "flightOfferId": "offer-1",
                "duffelOfferId": "duffel-1",
                "airline": "VN",
                "flightNumber": "VN310",
                "departureAirport": "HAN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-07-15T08:30:00Z",
                "arrivalTime": "2026-07-15T15:00:00Z",
                "currency": "USD",
                "price": "452.00",
            }
        ],
    }

    llm = MockStreamingLLM(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "search_flights",
                        "args": {"origin": "HAN", "destination": "NRT", "date": "2026-07-15"},
                        "id": "call_search_1",
                    }
                ],
            ),
            AIMessage(content="I found flight VN310 for $452.0."),
        ]
    )

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False),
        ),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "search flights to NRT", "sessionId": "session-readonly"},
                headers=headers,
            )
            assert response.status_code == 200

            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)

            tool_call_events = [e for e in events if e["event"] == "tool_call"]
            tool_result_events = [e for e in events if e["event"] == "tool_result"]
            token_events = [e for e in events if e["event"] == "token"]
            done_events = [e for e in events if e["event"] == "done"]

            assert len(tool_call_events) == 1
            assert tool_call_events[0]["data"]["name"] == "search_flights"

            assert len(tool_result_events) == 1
            assert tool_result_events[0]["data"]["name"] == "search_flights"
            assert "flights" in tool_result_events[0]["data"]["result"]

            assert len(token_events) > 0
            assert (
                "".join([e["data"]["content"] for e in token_events])
                == "I found flight VN310 for $452.0."
            )
            assert len(done_events) == 1


@pytest.mark.asyncio
async def test_sse_gateway_error(mock_nestjs_client):
    headers = get_auth_headers()

    mock_nestjs_client.post_gateway_flights_search_v2.side_effect = Exception("Gateway Timeout")

    llm = MockStreamingLLM(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "search_flights",
                        "args": {"origin": "HAN", "destination": "NRT", "date": "2026-07-15"},
                        "id": "call_err_1",
                    }
                ],
            ),
            AIMessage(content="I encountered a gateway error."),
        ]
    )

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False),
        ),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "search flights to NRT", "sessionId": "session-error-gate"},
                headers=headers,
            )
            assert response.status_code == 200

            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)

            tool_call_events = [e for e in events if e["event"] == "tool_call"]
            tool_result_events = [e for e in events if e["event"] == "tool_result"]
            token_events = [e for e in events if e["event"] == "token"]
            done_events = [e for e in events if e["event"] == "done"]

            assert len(tool_call_events) == 1
            assert len(tool_result_events) == 1
            assert "temporarily unavailable" in tool_result_events[0]["data"]["result"]

            assert len(token_events) > 0
            assert len(done_events) == 1


@pytest.mark.asyncio
async def test_sse_readiness_action_required(mock_nestjs_client):
    headers = get_auth_headers()

    llm = MockStreamingLLM(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "check_booking_readiness",
                        "args": {
                            "flight_offer_id": "offer-123",
                            "passengers": [
                                {
                                    "passengerType": "ADULT",
                                    "passengerOrdinal": 1,
                                    "sourceType": "inline",
                                }
                            ],
                        },
                        "id": "call_readiness_1",
                    }
                ],
            )
        ]
    )

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False),
        ),
    ):
        # Override the mock's behavior to return readiness data
        mock_nestjs_client.check_booking_readiness = AsyncMock(
            return_value={
                "ready": False,
                "scope": "DOMESTIC",
                "nextAction": "CONTINUE_CHECKOUT",
                "passengers": [
                    {
                        "passengerType": "ADULT",
                        "passengerOrdinal": 1,
                        "sections": [
                            {
                                "name": "identity",
                                "fields": [
                                    {"name": "givenName", "status": "missing", "reason": "REQUIRED"}
                                ],
                            }
                        ],
                    }
                ],
            }
        )

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "check readiness", "sessionId": "session-readiness"},
                headers=headers,
            )
            assert response.status_code == 200

            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)

            action_events = [e for e in events if e["event"] == "ACTION_REQUIRED"]

            assert len(action_events) == 1
            action_data = action_events[0]["data"]
            assert action_data["action"] == "CONTINUE_CHECKOUT"
            assert action_data["target"] == "/checkout/passengers"
            assert len(action_data["passengers"]) == 1
            assert action_data["passengers"][0]["sections"][0]["fields"][0]["name"] == "givenName"


@pytest.mark.asyncio
async def test_sse_readiness_with_value_bearing_reason_fails_closed(mock_nestjs_client):
    headers = get_auth_headers()
    mock_nestjs_client.check_booking_readiness = AsyncMock(
        return_value={
            "ready": False,
            "scope": "DOMESTIC",
            "nextAction": "COMPLETE_PROFILE",
            "passengers": [
                {
                    "passengerType": "ADULT",
                    "passengerOrdinal": 1,
                    "sections": [
                        {
                            "name": "identity",
                            "fields": [
                                {
                                    "name": "givenName",
                                    "status": "missing",
                                    "reason": "Ada Lovelace",
                                }
                            ],
                        }
                    ],
                }
            ],
        }
    )
    llm = MockStreamingLLM(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "check_booking_readiness",
                        "args": {
                            "flight_offer_id": "offer-123",
                            "passengers": [
                                {
                                    "passengerType": "ADULT",
                                    "passengerOrdinal": 1,
                                    "sourceType": "inline",
                                }
                            ],
                        },
                        "id": "call_readiness_invalid",
                    }
                ],
            )
        ]
    )

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False),
        ),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "check readiness", "sessionId": "session-readiness-invalid"},
                headers=headers,
            )

    events = parse_sse([line async for line in response.aiter_lines()])
    assert not [event for event in events if event["event"] == "ACTION_REQUIRED"]
    error_events = [event for event in events if event["event"] == "error"]
    assert len(error_events) == 1
    assert error_events[0]["data"]["message"] == "Booking readiness could not be verified safely."
    assert "Ada Lovelace" not in json.dumps(events)


@pytest.mark.asyncio
async def test_sse_complete_profile_handoff_stops_without_persistence(mock_nestjs_client):
    headers = get_auth_headers()
    mock_nestjs_client.check_booking_readiness = AsyncMock(
        return_value={
            "ready": False,
            "scope": "INTERNATIONAL",
            "nextAction": "COMPLETE_PROFILE",
            "passengers": [
                {
                    "passengerType": "ADULT",
                    "passengerOrdinal": 1,
                    "sections": [
                        {
                            "name": "travel_document",
                            "fields": [
                                {
                                    "name": "passportExpiry",
                                    "status": "missing",
                                    "reason": "REQUIRED",
                                }
                            ],
                        }
                    ],
                }
            ],
        }
    )
    llm = MockStreamingLLM(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "check_booking_readiness",
                        "args": {
                            "flight_offer_id": "offer-123",
                            "passengers": [
                                {
                                    "passengerType": "ADULT",
                                    "passengerOrdinal": 1,
                                    "sourceType": "traveler_profile",
                                }
                            ],
                        },
                        "id": "call_readiness_handoff",
                    }
                ],
            ),
            AIMessage(content="This response must never be generated."),
        ]
    )

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False),
        ),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "check readiness", "sessionId": "session-readiness-handoff"},
                headers=headers,
            )

    events = parse_sse([line async for line in response.aiter_lines()])
    action_events = [event for event in events if event["event"] == "ACTION_REQUIRED"]
    assert len(action_events) == 1
    assert action_events[0]["data"]["target"] == "/profile"
    assert not [event for event in events if event["event"] == "done"]
    assert not [event for event in events if event["event"] == "token"]
    assert mock_nestjs_client.create_message_batch.call_count == 1
    assert mock_nestjs_client.create_message_batch.mock_calls[0].args[1][0]["sender"] == "USER"
    # Publication now waits for the validated tools-node projection. LangGraph
    # may already schedule the following model turn, but its content must never
    # be emitted or persisted after ACTION_REQUIRED closes the stream.
    assert "This response must never be generated." not in json.dumps(events)
    assert "This response must never be generated." not in str(
        mock_nestjs_client.create_message_batch.mock_calls
    )


@pytest.mark.asyncio
async def test_sse_action_handoff_ordering_and_schema(mock_nestjs_client, multi_agent_enabled):
    headers = get_auth_headers()

    trusted_snapshot = {
        # User approved on 2026-10-03: rename only this internal handoff snapshot fixture to the
        # canonical identity field; gateway and SSE contract fixtures remain legacy-shaped.
        # User-approved CI fixture correction (2026-09-09): trusted snapshots
        # must identify the authenticated owner and session for handoff validation.
        "userId": "12345",
        "sessionId": "session-handoff",
        "version": 1,
        "attestation": "test_attestation",
        "fingerprint": "test_fingerprint",
        "results": [
            {
                "flightOfferId": "offer-123",
                "supplierOfferId": "duffel-secret-456",
                "airline": "VN",
                "flightNumber": "VN310",
                "departureAirport": "HAN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-07-15T08:30:00Z",
                "arrivalTime": "2026-07-15T15:00:00Z",
                "price": "452.00",
                "currency": "USD",
            }
        ],
    }

    mock_nestjs_client.create_handoff_token = AsyncMock(
        return_value={
            "handoffToken": "chk_handoff_v1_secret_token_12345678901234567890123",
            "expiresAt": "2026-08-07T12:00:00Z",
        }
    )
    mock_nestjs_client.create_handoff = mock_nestjs_client.create_handoff_token

    llm = MockStreamingLLM(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "signal_checkout_intent",
                        "args": {"offer_index": 1},
                        "id": "call_signal_1",
                    }
                ],
            ),
            AIMessage(content="Proceeding to checkout with flight VN310."),
        ]
    )

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(
                intent="CHECKOUT",
                confidence=1.0,
                isCommitment=True,
                selectionIndex=1,
            ),
        ),
        patch("agent.graph.nodes.get_settings") as mock_settings,
    ):
        mock_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = True
        mock_snapshot_obj = MagicMock()
        mock_snapshot_obj.model_dump.return_value = trusted_snapshot

        with patch(
            "agent.streaming.sse.TrustedSnapshotRepository.get_snapshot", new_callable=AsyncMock
        ) as mock_get_snapshot:
            mock_get_snapshot.return_value = mock_snapshot_obj
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.post(
                    "/chat/stream",
                    json={
                        "message": "I want to book the first flight",
                        "sessionId": "session-handoff",
                    },
                    headers=headers,
                )
                assert response.status_code == 200

                lines = [line async for line in response.aiter_lines()]
                events = parse_sse(lines)

                # Check sequence of event types
                event_types = [e["event"] for e in events]
                assert "tool_call" in event_types
                assert "tool_result" in event_types
                assert "ACTION_HANDOFF" in event_types
                assert "done" in event_types

                # Assert ordering: tool_call -> tool_result -> ACTION_HANDOFF -> done
                tool_call_idx = event_types.index("tool_call")
                tool_result_idx = event_types.index("tool_result")
                action_idx = event_types.index("ACTION_HANDOFF")
                done_idx = event_types.index("done")
                assert tool_call_idx < tool_result_idx < action_idx < done_idx

                action_events = [e for e in events if e["event"] == "ACTION_HANDOFF"]
                assert len(action_events) == 1

                data = action_events[0]["data"]
                assert data["action"] == "begin_checkout"
                assert data["handoffToken"] == "chk_handoff_v1_secret_token_12345678901234567890123"
                assert data["expiresAt"] == "2026-08-07T12:00:00Z"
                assert "display" in data

                display = data["display"]
                assert display["airline"] == "VN"
                assert display["price"] == "452.00"
                assert display["origin"] == "HAN"
                assert display["destination"] == "NRT"

                # Assert no supplier offer IDs in display or ACTION_HANDOFF payload
                assert "flightNumber" not in display
                assert "flightOfferId" not in display
                assert "duffelOfferId" not in display
                assert "offer-123" not in json.dumps(data)
                assert "duffel-secret-456" not in json.dumps(data)

                # Negative privacy assertion: assert raw token is NOT in any token/content text
                token_events = [e for e in events if e["event"] == "token"]
                for te in token_events:
                    assert "chk_handoff_v1_secret_token_12345678901234567890123" not in str(
                        te.get("data", "")
                    )

                # Negative privacy assertion: assert raw token is NOT in persisted message payloads
                assert mock_nestjs_client.create_message_batch.call_count >= 1
                for call in mock_nestjs_client.create_message_batch.mock_calls:
                    assert "chk_handoff_v1_secret_token_12345678901234567890123" not in str(call)


@pytest.mark.asyncio
async def test_sse_action_handoff_validation_failure_emits_error(
    mock_nestjs_client, multi_agent_enabled
):
    headers = get_auth_headers()

    # Snapshot expired failure triggers validate_handoff error event
    trusted_snapshot = {
        "version": 1,
        "attestation": "test_attestation",
        "fingerprint": "test_fingerprint",
        "expiresAt": "2020-01-01T00:00:00Z",
        "results": [
            {
                "flightOfferId": "offer-123",
                "airline": "VN",
                "departureAirport": "HAN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-07-15T08:30:00Z",
                "arrivalTime": "2026-07-15T15:00:00Z",
                "price": "452.00",
                "currency": "USD",
            }
        ],
    }

    mock_nestjs_client.create_handoff_token = AsyncMock()
    mock_nestjs_client.create_handoff = mock_nestjs_client.create_handoff_token

    llm = MockStreamingLLM(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "signal_checkout_intent",
                        "args": {"offer_index": 1},
                        "id": "call_signal_exp",
                    }
                ],
            )
        ]
    )

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(
                intent="CHECKOUT",
                confidence=1.0,
                isCommitment=True,
                selectionIndex=1,
            ),
        ),
        # User-authorized CI fixture correction (2026-09-08): isolate the
        # downstream validation defense; the normal router gate already
        # rejects an expired snapshot before checkout execution.
        patch(
            "agent.graph.graph.evaluate_checkout_gate",
            return_value={"route": "checkout", "disambiguation": "none"},
        ),
        patch("agent.graph.nodes.get_settings") as mock_settings,
    ):
        mock_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = True
        mock_snapshot_obj = MagicMock()
        mock_snapshot_obj.model_dump.return_value = trusted_snapshot

        with patch(
            "agent.streaming.sse.TrustedSnapshotRepository.get_snapshot", new_callable=AsyncMock
        ) as mock_get_snapshot:
            mock_get_snapshot.return_value = mock_snapshot_obj
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.post(
                    "/chat/stream",
                    json={"message": "book flight 1", "sessionId": "session-exp-fail"},
                    headers=headers,
                )
                assert response.status_code == 200

                lines = [line async for line in response.aiter_lines()]
                events = parse_sse(lines)

                action_events = [e for e in events if e["event"] == "ACTION_HANDOFF"]
                error_events = [e for e in events if e["event"] == "error"]

                assert len(action_events) == 0
                assert len(error_events) >= 1
                assert error_events[0]["data"]["code"] in ("HANDOFF_FAILED", "HANDOFF_ERROR")
                assert (
                    "expired" in error_events[0]["data"]["message"].lower()
                    or "error" in error_events[0]["data"]
                )

                # Ensure no token creation was attempted
                assert mock_nestjs_client.create_handoff_token.call_count == 0


@pytest.mark.asyncio
async def test_sse_action_handoff_index_out_of_bounds_no_token(
    mock_nestjs_client, multi_agent_enabled
):
    headers = get_auth_headers()

    trusted_snapshot = {
        "version": 1,
        "attestation": "test_attestation",
        "fingerprint": "test_fingerprint",
        "results": [
            {
                "flightOfferId": "offer-123",
                "airline": "VN",
                "departureAirport": "HAN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-07-15T08:30:00Z",
                "arrivalTime": "2026-07-15T15:00:00Z",
                "price": "452.00",
                "currency": "USD",
            }
        ],
    }

    mock_nestjs_client.create_handoff_token = AsyncMock()
    mock_nestjs_client.create_handoff = mock_nestjs_client.create_handoff_token

    llm = MockStreamingLLM(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "signal_checkout_intent",
                        "args": {"offer_index": 99},
                        "id": "call_signal_oob",
                    }
                ],
            ),
            AIMessage(content="Offer index 99 is invalid. Please pick an available flight."),
        ]
    )

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(
                intent="CHECKOUT",
                confidence=1.0,
                isCommitment=True,
                selectionIndex=1,
            ),
        ),
        patch("agent.graph.nodes.get_settings") as mock_settings,
    ):
        mock_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = True
        mock_snapshot_obj = MagicMock()
        mock_snapshot_obj.model_dump.return_value = trusted_snapshot

        with patch(
            "agent.streaming.sse.TrustedSnapshotRepository.get_snapshot", new_callable=AsyncMock
        ) as mock_get_snapshot:
            mock_get_snapshot.return_value = mock_snapshot_obj
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.post(
                    "/chat/stream",
                    json={"message": "book flight 99", "sessionId": "session-val-fail"},
                    headers=headers,
                )
                assert response.status_code == 200

                lines = [line async for line in response.aiter_lines()]
                events = parse_sse(lines)

                action_events = [e for e in events if e["event"] == "ACTION_HANDOFF"]
                assert len(action_events) == 0

                # Stream closes cleanly with done
                done_events = [e for e in events if e["event"] == "done"]
                assert len(done_events) == 1

                # Ensure no token creation was attempted
                assert mock_nestjs_client.create_handoff_token.call_count == 0


@pytest.mark.asyncio
async def test_sse_action_handoff_disabled_flag(mock_nestjs_client, multi_agent_enabled):
    headers = get_auth_headers()

    trusted_snapshot = {
        "version": 1,
        "attestation": "test_attestation",
        "fingerprint": "test_fingerprint",
        "results": [
            {
                "flightOfferId": "offer-123",
                "airline": "VN",
                "departureAirport": "HAN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-07-15T08:30:00Z",
                "arrivalTime": "2026-07-15T15:00:00Z",
                "price": "452.00",
                "currency": "USD",
            }
        ],
    }

    mock_nestjs_client.create_handoff_token = AsyncMock()
    mock_nestjs_client.create_handoff = mock_nestjs_client.create_handoff_token

    llm = MockStreamingLLM(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "signal_checkout_intent",
                        "args": {"offer_index": 1},
                        "id": "call_signal_flag",
                    }
                ],
            )
        ]
    )

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(
                intent="CHECKOUT",
                confidence=1.0,
                isCommitment=True,
                selectionIndex=1,
            ),
        ),
        patch("agent.graph.nodes.get_settings") as mock_settings,
    ):
        mock_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = False
        mock_snapshot_obj = MagicMock()
        mock_snapshot_obj.model_dump.return_value = trusted_snapshot

        with patch(
            "agent.streaming.sse.TrustedSnapshotRepository.get_snapshot", new_callable=AsyncMock
        ) as mock_get_snapshot:
            mock_get_snapshot.return_value = mock_snapshot_obj
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.post(
                    "/chat/stream",
                    json={"message": "book flight 1", "sessionId": "session-disabled-flag"},
                    headers=headers,
                )
                assert response.status_code == 200

                lines = [line async for line in response.aiter_lines()]
                events = parse_sse(lines)

                action_events = [e for e in events if e["event"] == "ACTION_HANDOFF"]
                error_events = [e for e in events if e["event"] == "error"]

                assert len(action_events) == 0
                assert len(error_events) >= 1
                assert error_events[0]["data"]["code"] in ("HANDOFF_FAILED", "HANDOFF_ERROR")
                assert (
                    "disabled" in error_events[0]["data"]["message"].lower()
                    or "error" in error_events[0]["data"]
                )

                # Ensure no token creation was attempted
                assert mock_nestjs_client.create_handoff_token.call_count == 0


@pytest.mark.asyncio
async def test_sse_action_handoff_disconnect_retry(mock_nestjs_client, multi_agent_enabled):
    headers = get_auth_headers()

    trusted_snapshot = {
        "version": 1,
        "attestation": "test_attestation",
        "fingerprint": "test_fingerprint",
        "results": [
            {
                "flightOfferId": "offer-123",
                "airline": "VN",
                "departureAirport": "HAN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-07-15T08:30:00Z",
                "arrivalTime": "2026-07-15T15:00:00Z",
                "price": "452.00",
                "currency": "USD",
            }
        ],
    }

    mock_nestjs_client.create_handoff_token = AsyncMock(side_effect=Exception("Timeout"))
    mock_nestjs_client.create_handoff = mock_nestjs_client.create_handoff_token

    llm = MockStreamingLLM(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "signal_checkout_intent",
                        "args": {"offer_index": 1},
                        "id": "call_signal_2",
                    }
                ],
            )
        ]
    )

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(
                intent="CHECKOUT",
                confidence=1.0,
                isCommitment=True,
                selectionIndex=1,
            ),
        ),
    ):
        mock_snapshot_obj = MagicMock()
        mock_snapshot_obj.model_dump.return_value = trusted_snapshot

        with patch(
            "agent.streaming.sse.TrustedSnapshotRepository.get_snapshot", new_callable=AsyncMock
        ) as mock_get_snapshot:
            mock_get_snapshot.return_value = mock_snapshot_obj
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.post(
                    "/chat/stream",
                    json={"message": "book the first one", "sessionId": "session-handoff-retry"},
                    headers=headers,
                )
                assert response.status_code == 200

                lines = [line async for line in response.aiter_lines()]
                events = parse_sse(lines)

                error_events = [e for e in events if e["event"] == "error"]
                assert len(error_events) >= 1
                assert (
                    "Timeout" in error_events[0]["data"].get("message", "")
                    or "failed" in error_events[0]["data"].get("message", "").lower()
                    or error_events[0]["data"].get("code") in ("HANDOFF_ERROR", "HANDOFF_FAILED")
                )


@pytest.mark.asyncio
async def test_sse_snapshot_lookup_failure_redacts_redis_error(mock_nestjs_client, caplog):
    caplog.set_level(logging.DEBUG)
    headers = get_auth_headers()
    llm = MockStreamingLLM(responses=[AIMessage(content="Hello world")])

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False),
        ),
        patch(
            "agent.streaming.sse.TrustedSnapshotRepository.get_snapshot",
            side_effect=RuntimeError("redis://secret_user:secret_pass@10.0.0.1:6379 failed"),
        ),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "hello", "sessionId": "session-redis-err"},
                headers=headers,
            )
            assert response.status_code == 200
            _ = [line async for line in response.aiter_lines()]

    assert "secret_pass" not in caplog.text
    assert "10.0.0.1:6379" not in caplog.text
    assert "trusted_snapshot_lookup_failed" in caplog.text
