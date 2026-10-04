import asyncio
import json
from typing import AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from pydantic import ValidationError

from agent.chat_turn import (
    ActionHandoffEvent,
    ActionRequiredEvent,
    ChatTurnCommand,
    ChatTurnRunner,
    DoneEvent,
    ErrorEvent,
    FlightResultsEvent,
    TokenEvent,
    ToolCallEvent,
    ToolResultEvent,
)
from agent.chat_turn.resolver import ToolResolution
from agent.guardrails.base import AdmissionContext, ValidatedInput
from agent.guardrails.gateway import GuardrailGateway
from agent.trusted_search_snapshot import SnapshotOwner

try:
    from agent.guardrails.base import OutputGuardrailBlockedError
except ImportError:
    from agent.guardrails.output_pipeline import OutputGuardrailBlockedError

from agent.chat_turn.runner import background_tasks
from agent.memory.conversation import (
    ContextBlockedException,
    ConversationMemory,
    MemoryPersistenceException,
    SessionNotFoundException,
    ValidatedConversationContext,
)


def test_chat_turn_command_valid_and_extra_forbid():
    cmd = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Search flights to NYC",
        action_required=True,
        action_type="begin_checkout",
        action_payload={"offer_id": "off_1"},
        token="jwt.token.val",
        trace_id="chat_0123456789abcdef0123456789abcdef",
        correlation_id="chat_fedcba9876543210fedcba9876543210",
    )
    assert cmd.user_id == "user-123"
    assert cmd.session_id == "session-456"
    assert cmd.message == "Search flights to NYC"
    assert cmd.action_required is True
    assert cmd.action_type == "begin_checkout"
    assert cmd.action_payload == {"offer_id": "off_1"}
    assert cmd.token == "jwt.token.val"
    assert cmd.trace_id == "chat_0123456789abcdef0123456789abcdef"
    assert cmd.correlation_id == "chat_fedcba9876543210fedcba9876543210"

    # Defaults
    cmd_min = ChatTurnCommand(user_id="u1", token="tok1")
    assert cmd_min.session_id is None
    assert cmd_min.message is None
    assert cmd_min.action_required is False
    assert cmd_min.action_type is None
    assert cmd_min.action_payload is None
    assert cmd_min.trace_id is None
    assert cmd_min.correlation_id is None

    # Extra fields forbidden
    with pytest.raises(ValidationError):
        ChatTurnCommand(user_id="u1", token="t1", extra_invalid_key="fail")


@pytest.mark.asyncio
async def test_runner_happy_path_streaming():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_1", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-123")
    mock_queue.get_fence = MagicMock(return_value=42)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Hello! How can I help?")},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Hello",
        token="mock_token",
    )

    events = []
    async for event in runner.run(command):
        events.append(event)

    # Monotonic fencing token set
    mock_client.set_fencing_token.assert_called_with(42)

    # Queue lease acquired and released
    mock_queue.acquire.assert_awaited_once_with("session-456", user_id="user-123")
    mock_queue.release.assert_awaited_once_with("session-456", "req-123")

    # Tokens and DoneEvent
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    assert len(token_events) > 0
    assert any("Hello" in e.data.content for e in token_events)

    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 1
    assert done_events[0].data.messageId == "msg_agent_1"
    assert done_events[0].data.sessionId == "session-456"


@pytest.mark.asyncio
async def test_production_runner_passes_mandatory_gateway_into_graph_config() -> None:
    """The live graph must receive the same production gateway used at admission."""
    captured: dict[str, object] = {}
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg-agent", "sender": "AGENT"}]}
    )
    mock_graph = MagicMock()

    async def capture_astream_events(initial_state, *, config, version):
        captured.update(initial_state=initial_state, config=config, version=version)
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Safe response")},
        }

    mock_graph.astream_events = capture_astream_events
    gateway = GuardrailGateway()
    runner = ChatTurnRunner(
        graph=mock_graph,
        client_factory=lambda **_kwargs: mock_client,
        redis_client=None,
        gateway=gateway,
        require_gateway=True,
    )

    events = [
        event
        async for event in runner.run(
            ChatTurnCommand(
                user_id="user-production-gateway",
                session_id="session-production-gateway",
                message="Hello",
                token="token",
            ),
            validated_input=ValidatedInput(content="Hello"),
        )
    ]

    assert any(isinstance(event, DoneEvent) for event in events)
    configurable = captured["config"]["configurable"]
    assert configurable["guardrail_gateway"] is gateway
    assert configurable["guardrail_gateway"].registry is gateway.registry
    assert "turn_capabilities" not in configurable
    assert "turn_capabilities" not in captured["initial_state"]


@pytest.mark.asyncio
async def test_runner_session_auto_creation_when_none():
    mock_client = MagicMock()
    mock_client.create_session = AsyncMock(return_value={"id": "auto-created-session-999"})
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_1", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Hi")},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id=None,
        message="Hi",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]
    mock_client.create_session.assert_awaited_once_with(title=None)

    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 1
    assert done_events[0].data.sessionId == "auto-created-session-999"


@pytest.mark.asyncio
async def test_runner_tool_calls_and_flight_results():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
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
                                        "origin": "SFO",
                                        "destination": "JFK",
                                        "date": "2026-09-01",
                                    },
                                    "id": "call-search-1",
                                }
                            ],
                        )
                    ]
                }
            },
        }
        yield {
            "event": "on_tool_end",
            "name": "search_flights",
            "data": {"output": json.dumps({"status": "found", "count": 2})},
        }
        # Raw callbacks are telemetry-only; public results come from the
        # gateway-validated ToolMessage emitted by the tools node.
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=json.dumps({"status": "found", "count": 2}),
                            tool_call_id="call-search-1",
                            name="search_flights",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Found 2 flights.")},
        }

    mock_graph.astream_events = mock_astream_events

    mock_projected_item = MagicMock()
    mock_projected_item.model_dump = MagicMock(
        return_value={
            "index": 1,
            "airline": "United Airlines",
            "origin": "SFO",
            "destination": "JFK",
            "departureAt": "2026-09-01T08:00:00Z",
            "arrivalAt": "2026-09-01T16:00:00Z",
            "price": "350.00",
            "currency": "USD",
        }
    )
    mock_snapshot = MagicMock()
    mock_lifecycle = MagicMock()
    mock_lifecycle.load_active = AsyncMock(return_value=mock_snapshot)
    mock_lifecycle.project_for_browser = MagicMock(return_value=[mock_projected_item])

    with patch(
        "agent.chat_turn.runner.TrustedSearchSnapshotLifecycle",
        return_value=mock_lifecycle,
    ):
        runner = ChatTurnRunner(
            graph=mock_graph,
            client_factory=lambda **kwargs: mock_client,
            redis_client=MagicMock(),
        )

        command = ChatTurnCommand(
            user_id="user-123",
            session_id="session-456",
            message="Flights to NYC",
            token="mock_token",
        )

        events = [e async for e in runner.run(command)]

        tool_calls = [e for e in events if isinstance(e, ToolCallEvent)]
        assert len(tool_calls) == 1
        assert tool_calls[0].data.name == "search_flights"
        assert tool_calls[0].data.inputs == {
            "origin": "SFO",
            "destination": "JFK",
            "date": "2026-09-01",
        }

        tool_results = [e for e in events if isinstance(e, ToolResultEvent)]
        assert len(tool_results) == 1
        assert tool_results[0].data.name == "search_flights"

        flight_results = [e for e in events if isinstance(e, FlightResultsEvent)]
        assert len(flight_results) == 1
        assert len(flight_results[0].data.results) == 1
        result_data = flight_results[0].data.results[0]
        assert result_data["index"] == 1
        assert result_data["airline"] == "United Airlines"
        assert result_data["price"] == "350.00"
        # User approved on 2026-10-03: neutral supplier IDs remain forbidden in public tool output.
        for forbidden in [
            "score",
            "matchScore",
            "matchLevel",
            "matchResult",
            "flightOfferId",
            "duffelOfferId",
            "supplierOfferId",
        ]:
            assert forbidden not in result_data


@pytest.mark.asyncio
async def test_runner_check_booking_readiness_sanitized_and_action_required():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-1")
    mock_queue.get_fence = MagicMock(return_value=1)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    raw_readiness = {
        "scope": "INTERNATIONAL",
        "ready": False,
        "nextAction": "COMPLETE_PASSENGERS",
        "passengers": [],
        "canary": "raw-callback-must-not-drive-action",
    }
    validated_readiness = {
        "scope": "DOMESTIC",
        "ready": False,
        "nextAction": "COMPLETE_PROFILE",
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

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
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
                                        "flight_offer_id": "secret_offer_123",
                                        "passengers": [
                                            {
                                                "passengerType": "ADULT",
                                                "passengerOrdinal": 1,
                                                "sourceType": "traveler_profile",
                                            }
                                        ],
                                    },
                                    "id": "call-readiness-1",
                                }
                            ],
                        )
                    ]
                }
            },
        }
        # Raw tool input with sensitive information must NOT leak
        yield {
            "event": "on_tool_start",
            "name": "check_booking_readiness",
            "data": {
                "input": {"flight_offer_id": "secret_offer_123", "passengers": [{"name": "PII"}]}
            },
        }
        yield {
            "event": "on_tool_end",
            "name": "check_booking_readiness",
            "data": {"output": raw_readiness},
        }
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=json.dumps(validated_readiness),
                            tool_call_id="call-readiness-1",
                            name="check_booking_readiness",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Book this flight",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    # Tool call event sanitized
    tool_calls = [e for e in events if isinstance(e, ToolCallEvent)]
    assert len(tool_calls) == 1
    assert tool_calls[0].data.name == "check_booking_readiness"
    assert tool_calls[0].data.inputs == {"message": "Checking booking readiness..."}
    assert "secret_offer_123" not in str(tool_calls[0].data.inputs)

    # ActionRequiredEvent yielded
    act_required = [e for e in events if isinstance(e, ActionRequiredEvent)]
    assert len(act_required) == 1
    assert act_required[0].data.action == "COMPLETE_PROFILE"
    assert act_required[0].data.target == "/profile"
    assert act_required[0].data.scope == "DOMESTIC"
    assert act_required[0].data.passengers is not None
    assert act_required[0].data.passengers[0]["passengerType"] == "ADULT"
    assert "raw-callback-must-not-drive-action" not in repr(events)

    # Queue lease released upon action required
    mock_queue.release.assert_awaited_once_with("session-456", "req-1")


@pytest.mark.asyncio
async def test_runner_tool_block_emits_static_guardrail_error_without_raw_callbacks():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-block")
    mock_queue.get_fence = MagicMock(return_value=1)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_tool_start",
            "name": "search_flights",
            "data": {"input": {"secret": "raw callback must not publish"}},
        }
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "tool_blocked": True,
                    "tool_block_response_key": "GUARDRAIL_TOOL_PII",
                }
            },
        }

    mock_graph.astream_events = mock_astream_events
    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    events = [
        event
        async for event in runner.run(
            ChatTurnCommand(
                user_id="user-123",
                session_id="session-block",
                message="Search safely",
                token="mock_token",
            )
        )
    ]

    assert not [event for event in events if isinstance(event, ToolCallEvent)]
    errors = [event for event in events if isinstance(event, ErrorEvent)]
    assert len(errors) == 1
    assert errors[0].data.code == "GUARDRAIL_TOOL_PII"
    assert errors[0].data.message == "Tool execution was blocked for safety reasons."
    assert "raw callback must not publish" not in repr(events)


@pytest.mark.asyncio
async def test_runner_action_handoff_event():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_2", "sender": "AGENT"}]}
    )

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-2")
    mock_queue.get_fence = MagicMock(return_value=2)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chain_end",
            "name": "create_handoff_token",
            "data": {
                "output": {
                    "action": {
                        "action": "begin_checkout",
                        "handoffToken": "chk_tok_abc",
                        "expiresAt": "2026-08-30T12:00:00Z",
                        "display": {"airline": "Delta", "price": "400"},
                    }
                }
            },
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Confirm booking",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    handoff_events = [e for e in events if isinstance(e, ActionHandoffEvent)]
    assert len(handoff_events) == 1
    assert handoff_events[0].data.handoffToken == "chk_tok_abc"
    assert handoff_events[0].data.action == "begin_checkout"
    assert handoff_events[0].data.display == {"airline": "Delta", "price": "400"}

    # DoneEvent emitted because force_persistence was set
    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 1


@pytest.mark.asyncio
async def test_runner_causal_failure_cleanup_on_guardrail_block():
    import agent.chat_turn.runner as runner_mod

    if hasattr(runner_mod, "OutputGuardrailPipeline"):
        pytest.skip(
            "ChatTurnRunner gateway stream_output delegation pending implementation in T026"
        )

    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "partial_msg_id", "sender": "AGENT"}]}
    )

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-gr")
    mock_queue.get_fence = MagicMock(return_value=3)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    call_order = []

    class FakeGatewayStreamSession:
        """Fake gateway stream-session returning stable OutputGuardrailBlockedError."""

        def __init__(self, *args, **kwargs):
            self.partial_response = "Safe part "
            self.closed = False

        async def process_token(self, token):
            call_order.append("process_token")
            yield "Safe part "
            raise OutputGuardrailBlockedError(
                partial_response="Safe part ",
                layer="nemo",
                rule="unsafe",
                message="Violated guardrail policy",
            )

        async def aclose(self):
            call_order.append("aclose")
            self.closed = True

        def close(self):
            call_order.append("close")
            self.closed = True

        async def flush(self):
            call_order.append("flush")
            if False:
                yield ""

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            await self.aclose()
            return False

    fake_session = FakeGatewayStreamSession()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Safe part Unsafe content")},
        }

    mock_graph.astream_events = mock_astream_events

    mock_gateway = MagicMock(spec=GuardrailGateway)
    mock_gateway.stream_output = MagicMock(return_value=fake_session)
    mock_gateway.validate_input = AsyncMock(
        return_value=MagicMock(
            status="PASS", validated_data=ValidatedInput(content="Tell me something")
        )
    )

    with patch.object(GuardrailGateway, "stream_output", return_value=fake_session):
        # Instrument persist_response and queue_release to track order
        orig_persist = mock_client.create_message_batch

        async def tracked_persist(s_id, messages, *args, **kwargs):
            if any(m.get("sender") == "USER" for m in messages):
                call_order.append("user_pre_persist")
            else:
                call_order.append("partial_persist")
            return await orig_persist(s_id, messages, *args, **kwargs)

        mock_client.create_message_batch = tracked_persist

        orig_release = mock_queue.release

        async def tracked_release(*args, **kwargs):
            call_order.append("release")
            return await orig_release(*args, **kwargs)

        mock_queue.release = tracked_release

        runner = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=mock_queue,
            client_factory=lambda **kwargs: mock_client,
            redis_client=MagicMock(),
            gateway=mock_gateway,
        )

        command = ChatTurnCommand(
            user_id="user-123",
            session_id="session-456",
            message="Tell me something",
            token="mock_token",
        )

        events = [e async for e in runner.run(command)]

        # Assert that the runner delegated to the gateway-owned stream_output session
        mock_gateway.stream_output.assert_called_once()

        # Verify causal ordering: partial_persist -> aclose/close -> release
        close_action = "aclose" if "aclose" in call_order else "close"
        assert call_order == [
            "user_pre_persist",
            "process_token",
            "partial_persist",
            close_action,
            "release",
        ]

        error_events = [e for e in events if isinstance(e, ErrorEvent)]
        assert len(error_events) == 1
        assert error_events[0].data.code == "OUTPUT_GUARDRAIL_BLOCKED"
        assert error_events[0].data.partialMessageId == "partial_msg_id"


@pytest.mark.asyncio
async def test_stream_session_covers_all_three_runner_branches_per_turn():
    """Assert stream session covers all three runner branches per turn:
    1. token streaming (on_chat_model_stream)
    2. non-streamed final response text (on_chat_model_end)
    3. tool call arguments / chain completion (on_chain_end)
    and verifies causal cleanup sequence: persist -> aclose/close -> release.
    """
    import agent.chat_turn.runner as runner_mod

    if hasattr(runner_mod, "OutputGuardrailPipeline"):
        pytest.skip(
            "ChatTurnRunner gateway stream_output delegation pending implementation in T026"
        )

    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_complete", "sender": "AGENT"}]}
    )

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-three-branches")
    mock_queue.get_fence = MagicMock(return_value=10)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    call_order = []
    processed_tokens = []

    class MultiBranchTrackingSession:
        def __init__(self, *args, **kwargs):
            self.partial_response = ""
            self.closed = False
            self.flushed = False

        async def process_token(self, token):
            call_order.append("process_token")
            processed_tokens.append(token)
            self.partial_response += token
            yield token

        async def flush(self):
            call_order.append("flush")
            self.flushed = True
            if False:
                yield ""

        async def aclose(self):
            call_order.append("aclose")
            self.closed = True

        def close(self):
            call_order.append("close")
            self.closed = True

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            await self.aclose()
            return False

    session = MultiBranchTrackingSession()

    msg_streamed = AIMessage(
        content="Streaming chunk. ",
        tool_calls=[{"id": "call_1", "name": "search_flights", "args": {"origin": "JFK"}}],
    )
    msg_unstreamed = AIMessage(content="Unstreamed text. ")
    msg_chain_end = AIMessage(content="Chain completed.")
    tool_msg = ToolMessage(
        content='{"results": ["Flight 1"]}',
        name="search_flights",
        tool_call_id="call_1",
        additional_kwargs={"guardrail_validated": True},
    )

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # Branch 1: Token streaming in travel node
        yield {"event": "on_chain_start", "name": "travel"}
        yield {
            "event": "on_chat_model_stream",
            "run_id": "run-branch-1",
            "data": {"chunk": MagicMock(content="Streaming chunk. ")},
        }
        yield {
            "event": "on_chat_model_end",
            "run_id": "run-branch-1",
            "data": {"output": msg_streamed},
        }
        yield {
            "event": "on_chain_end",
            "name": "travel",
            "data": {"output": {"messages": [msg_streamed]}},
        }
        # Branch 2: Tool execution and tool result message
        yield {
            "event": "on_tool_start",
            "name": "search_flights",
            "data": {"input": {"origin": "JFK"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "search_flights",
            "data": {"output": '{"results": ["Flight 1"]}'},
        }
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {"output": {"messages": [tool_msg]}},
        }
        # Branch 3: Non-streamed chat model completion in final_answer node
        yield {"event": "on_chain_start", "name": "final_answer"}
        yield {
            "event": "on_chat_model_end",
            "run_id": "run-branch-2",
            "data": {"output": msg_unstreamed},
        }
        yield {
            "event": "on_chain_end",
            "name": "final_answer",
            "data": {"output": {"messages": [msg_unstreamed]}},
        }
        # Branch 4: Unstreamed chain completion message in general node
        yield {"event": "on_chain_start", "name": "general"}
        yield {
            "event": "on_chain_end",
            "name": "general",
            "data": {"output": {"messages": [msg_chain_end]}},
        }

    mock_graph.astream_events = mock_astream_events

    orig_persist = mock_client.create_message_batch

    async def tracked_persist(s_id, messages, *args, **kwargs):
        if any(m.get("sender") == "USER" for m in messages):
            call_order.append("user_pre_persist")
        else:
            call_order.append("persist")
        return await orig_persist(s_id, messages, *args, **kwargs)

    mock_client.create_message_batch = tracked_persist

    orig_release = mock_queue.release

    async def tracked_release(*args, **kwargs):
        call_order.append("release")
        return await orig_release(*args, **kwargs)

    mock_queue.release = tracked_release

    mock_gateway = MagicMock(spec=GuardrailGateway)
    mock_gateway.stream_output = MagicMock(return_value=session)
    mock_gateway.validate_input = AsyncMock(
        return_value=MagicMock(
            status="PASS", validated_data=ValidatedInput(content="Test branches")
        )
    )

    with patch.object(GuardrailGateway, "stream_output", return_value=session):
        runner = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=mock_queue,
            client_factory=lambda **kwargs: mock_client,
            redis_client=MagicMock(),
            gateway=mock_gateway,
        )

        command = ChatTurnCommand(
            user_id="user-123",
            session_id="session-branches",
            message="Test branches",
            token="mock_token",
        )

        events = [e async for e in runner.run(command)]

        # Assert that the runner delegated to the gateway-owned stream_output session
        mock_gateway.stream_output.assert_called_once()

    # Assert stream session covers all three branches
    assert "Streaming chunk. " in processed_tokens
    assert "Unstreamed text. " in processed_tokens
    assert "Chain completed." in processed_tokens

    # Assert tool call event from branch 3 was emitted with safe projected inputs
    tool_events = [e for e in events if isinstance(e, ToolCallEvent)]
    assert len(tool_events) == 1
    assert tool_events[0].data.name == "search_flights"

    # Assert causal cleanup ordering: persist -> aclose/close -> release
    close_action = "aclose" if "aclose" in call_order else "close"
    assert "persist" in call_order
    assert close_action in call_order
    assert "release" in call_order

    persist_idx = call_order.index("persist")
    close_idx = call_order.index(close_action)
    release_idx = call_order.index("release")
    assert persist_idx < close_idx < release_idx


@pytest.mark.asyncio
async def test_runner_causal_failure_cleanup_on_llm_error():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "partial_msg_2", "sender": "AGENT"}]}
    )

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-llm")
    mock_queue.get_fence = MagicMock(return_value=4)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Partial content before crash ")},
        }
        raise RuntimeError("LLM service unavailable")

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Tell me something",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    error_events = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(error_events) == 1
    assert error_events[0].data.code == "LLM_ERROR"
    assert error_events[0].data.partialMessageId == "partial_msg_2"
    mock_queue.release.assert_awaited_once_with("session-456", "req-llm")


@pytest.mark.asyncio
async def test_runner_stale_fence_aborts_persistence():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-stale")
    mock_queue.get_fence = MagicMock(return_value=5)
    # Lost lock during generation
    mock_queue.validate_active_fence = AsyncMock(return_value=False)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Completed message")},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Hello",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    error_events = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(error_events) == 1
    assert error_events[0].data.code == "PERSISTENCE_ERROR"


@pytest.mark.asyncio
async def test_runner_cancellation_shielded_persistence():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "partial_cancel_id", "sender": "AGENT"}]}
    )

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-cancel")
    mock_queue.get_fence = MagicMock(return_value=6)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Some partial response")},
        }
        raise asyncio.CancelledError()

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Cancel me",
        token="mock_token",
    )

    with pytest.raises(asyncio.CancelledError):
        async for _ in runner.run(command):
            pass

    # Partial turn was persisted and lock was released
    assert mock_client.create_message_batch.await_count >= 1
    mock_queue.release.assert_awaited_once_with("session-456", "req-cancel")


@pytest.mark.asyncio
async def test_runner_generator_exit_shielded_persistence():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "partial_gen_exit_id", "sender": "AGENT"}]}
    )

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-gen-exit")
    mock_queue.get_fence = MagicMock(return_value=7)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Partial response before close")},
        }
        # Simulate further processing or sleep if not closed
        await asyncio.sleep(10)

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Close early",
        token="mock_token",
    )

    gen = runner.run(command)
    # Receive first token
    event = await anext(gen)
    assert isinstance(event, TokenEvent)

    # Early exit generator (sends GeneratorExit)
    await gen.aclose()

    # Partial turn was persisted and lock was released
    assert mock_client.create_message_batch.await_count >= 1
    mock_queue.release.assert_awaited_once_with("session-456", "req-gen-exit")


@pytest.mark.asyncio
async def test_runner_cancellation_bounded_timeout_on_stuck_dependency():
    """Ensure runner cancellation does not hang if persistence or queue release is stuck."""
    pytest.skip("Legacy shielded-persistence drill superseded by deterministic Phase 3 cleanup")
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})

    # create_message_batch hangs indefinitely
    async def mock_hanging_persist(*args, **kwargs):
        await asyncio.sleep(100)
        return {}

    mock_client.create_message_batch = mock_hanging_persist

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-hang")
    mock_queue.get_fence = MagicMock(return_value=1)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)

    # release hangs indefinitely
    async def mock_hanging_release(*args, **kwargs):
        await asyncio.sleep(100)

    mock_queue.release = mock_hanging_release

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Token before cancel")},
        }
        raise asyncio.CancelledError()

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Cancel with stuck deps",
        token="mock_token",
    )

    # Must complete cancellation within ~6s (well before 100s) despite stuck dependencies
    with pytest.raises(asyncio.CancelledError):
        async for _ in runner.run(command):
            pass


@pytest.mark.asyncio
async def test_on_chat_model_end_prevents_duplicate_on_chain_end():
    mock_client = MagicMock()
    mock_client.create_session = AsyncMock(return_value={"id": "session-123"})
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_usr_1"}, {"id": "msg_agent_1"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-123")
    mock_queue.get_fence = MagicMock(return_value=42)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    msg = MagicMock(content="Hello traveler!")
    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # Model completes without streaming chunks
        yield {
            "event": "on_chat_model_end",
            "data": {"output": msg},
        }
        # Followed by on_chain_end containing the same message
        yield {
            "event": "on_chain_end",
            "name": "travel",
            "data": {"output": {"messages": [msg]}},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Hello",
        token="mock_token",
    )

    events = [event async for event in runner.run(command)]
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    emitted_text = "".join(e.data.content for e in token_events)

    # Content should be emitted exactly once, not duplicated
    assert emitted_text == "Hello traveler!"


@pytest.mark.asyncio
async def test_multiple_model_invocations_emit_later_model_output_without_duplication():
    mock_client = MagicMock()
    mock_client.create_session = AsyncMock(return_value={"id": "session-123"})
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_usr_1"}, {"id": "msg_agent_1"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-123")
    mock_queue.get_fence = MagicMock(return_value=42)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    msg1 = MagicMock(content="Thinking: checking flights...")
    msg2 = MagicMock(content="Here are your flights: Flight 101...")
    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # Event 1: on_chat_model_end with msg1
        yield {
            "event": "on_chat_model_end",
            "data": {"output": msg1},
        }
        # Event 2: on_chain_end for travel node with messages: [msg1]
        yield {
            "event": "on_chain_end",
            "name": "travel",
            "data": {"output": {"messages": [msg1]}},
        }
        # Event 3: on_tool_start / on_tool_end
        yield {
            "event": "on_tool_start",
            "name": "search_flights",
            "data": {"input": {"destination": "NYC"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "search_flights",
            "data": {"output": '{"flights": ["Flight 101"]}'},
        }
        # Event 4: on_chat_model_end with msg2
        yield {
            "event": "on_chat_model_end",
            "data": {"output": msg2},
        }
        # Event 5: on_chain_end for final_answer node with messages: [msg2]
        yield {
            "event": "on_chain_end",
            "name": "final_answer",
            "data": {"output": {"messages": [msg2]}},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Find flights",
        token="mock_token",
    )

    events = [event async for event in runner.run(command)]
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    emitted_text = "".join(e.data.content for e in token_events)

    # Both msg1 and msg2 must be emitted without duplication
    assert "Thinking: checking flights..." in emitted_text
    assert "Here are your flights: Flight 101..." in emitted_text
    assert emitted_text == "Thinking: checking flights...Here are your flights: Flight 101..."


@pytest.mark.asyncio
async def test_streaming_first_model_and_non_streaming_second_model_with_run_ids():
    mock_client = MagicMock()
    mock_client.create_session = AsyncMock(return_value={"id": "session-123"})
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_usr_1"}, {"id": "msg_agent_1"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-123")
    mock_queue.get_fence = MagicMock(return_value=42)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    msg1 = MagicMock(content="Thinking: checking flights...")
    msg2 = MagicMock(content="Here are your flights: Flight 101...")
    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # Event 1: Model 1 streams chunks
        yield {
            "event": "on_chat_model_stream",
            "run_id": "run-model-1",
            "data": {"chunk": MagicMock(content="Thinking: checking flights...")},
        }
        # Event 2: Model 1 ends
        yield {
            "event": "on_chat_model_end",
            "run_id": "run-model-1",
            "data": {"output": msg1},
        }
        # Event 3: travel node ends
        yield {
            "event": "on_chain_end",
            "name": "travel",
            "data": {"output": {"messages": [msg1]}},
        }
        # Event 4: tool executes
        yield {
            "event": "on_tool_start",
            "name": "search_flights",
            "data": {"input": {"destination": "NYC"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "search_flights",
            "data": {"output": '{"flights": ["Flight 101"]}'},
        }
        # Event 5: Model 2 completes non-streaming
        yield {
            "event": "on_chat_model_end",
            "run_id": "run-model-2",
            "data": {"output": msg2},
        }
        # Event 6: final_answer node ends
        yield {
            "event": "on_chain_end",
            "name": "final_answer",
            "data": {"output": {"messages": [msg1, msg2]}},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Find flights",
        token="mock_token",
    )

    events = [event async for event in runner.run(command)]
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    emitted_text = "".join(e.data.content for e in token_events)

    assert "Thinking: checking flights..." in emitted_text
    assert "Here are your flights: Flight 101..." in emitted_text
    assert emitted_text == "Thinking: checking flights...Here are your flights: Flight 101..."


@pytest.mark.asyncio
async def test_t004_tools_chain_end_requires_guardrail_validated():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t004-1")
    mock_queue.get_fence = MagicMock(return_value=1)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # travel node emits tool call
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
                                    "args": {"destination": "NYC"},
                                    "id": "call-unvalidated-1",
                                }
                            ],
                        )
                    ]
                }
            },
        }
        # tools node emits ToolMessage WITHOUT additional_kwargs={"guardrail_validated": True}
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content='{"flights": []}',
                            tool_call_id="call-unvalidated-1",
                            name="search_flights",
                            # Missing additional_kwargs={"guardrail_validated": True}
                        )
                    ]
                }
            },
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Search flights",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    # Must fail closed with GUARDRAIL_TOOL_SCHEMA error
    errors = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(errors) == 1
    assert errors[0].data.code == "GUARDRAIL_TOOL_SCHEMA"
    assert errors[0].data.message == "Tool result was blocked for safety reasons."

    # Wire domain events must not be emitted
    tool_results = [e for e in events if isinstance(e, ToolResultEvent)]
    assert len(tool_results) == 0
    flight_results = [e for e in events if isinstance(e, FlightResultsEvent)]
    assert len(flight_results) == 0


@pytest.mark.asyncio
async def test_t004_on_tool_end_is_strictly_timing_only():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_t004", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t004-2")
    mock_queue.get_fence = MagicMock(return_value=2)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # Tool start and tool end are present in the stream
        yield {
            "event": "on_tool_start",
            "name": "search_flights",
            "data": {"input": {"destination": "NYC"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "search_flights",
            "data": {"output": '{"flights": ["Flight 101"]}'},
        }
        # But NO on_chain_end for "tools" is yielded.
        # Instead, model produces output directly.
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Here are the results.")},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Find flights",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    # Strictly NO wire domain events for tools are emitted
    assert not [e for e in events if isinstance(e, ToolCallEvent)]
    assert not [e for e in events if isinstance(e, ToolResultEvent)]
    assert not [e for e in events if isinstance(e, FlightResultsEvent)]

    # Model tokens were emitted normally
    tokens = [e for e in events if isinstance(e, TokenEvent)]
    assert len(tokens) > 0
    assert any("Here are the results." in t.data.content for t in tokens)


@pytest.mark.asyncio
async def test_t004_flight_search_ordering_tool_result_before_flight_results():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_t004_3", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t004-3")
    mock_queue.get_fence = MagicMock(return_value=3)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # 1. travel node ends with tool call
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
                                        "origin": "SFO",
                                        "destination": "JFK",
                                        "date": "2026-09-01",
                                    },
                                    "id": "call-search-t004",
                                }
                            ],
                        )
                    ]
                }
            },
        }
        # 2. Timing events
        yield {
            "event": "on_tool_start",
            "name": "search_flights",
            "data": {"input": {"origin": "SFO", "destination": "JFK"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "search_flights",
            "data": {"output": '{"status": "found"}'},
        }
        # 3. Validated tools node
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=json.dumps({"status": "found", "count": 1}),
                            tool_call_id="call-search-t004",
                            name="search_flights",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }
        # 4. Model stream finishes turn
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Here are flights.")},
        }

    mock_graph.astream_events = mock_astream_events

    mock_projected_item = MagicMock()
    mock_projected_item.model_dump = MagicMock(
        return_value={
            "index": 1,
            "airline": "United Airlines",
            "origin": "SFO",
            "destination": "JFK",
            "departureAt": "2026-09-01T08:00:00Z",
            "arrivalAt": "2026-09-01T16:00:00Z",
            "price": "350.00",
            "currency": "USD",
        }
    )
    mock_snapshot = MagicMock()
    mock_lifecycle = MagicMock()
    mock_lifecycle.load_active = AsyncMock(return_value=mock_snapshot)
    mock_lifecycle.project_for_browser = MagicMock(return_value=[mock_projected_item])

    with patch(
        "agent.chat_turn.runner.TrustedSearchSnapshotLifecycle",
        return_value=mock_lifecycle,
    ):
        runner = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=mock_queue,
            client_factory=lambda **kwargs: mock_client,
            redis_client=MagicMock(),
        )

        command = ChatTurnCommand(
            user_id="user-123",
            session_id="session-456",
            message="Search flights",
            token="mock_token",
        )

        events = [e async for e in runner.run(command)]

        # Verify exact emission order: ToolCallEvent -> ToolResultEvent -> FlightResultsEvent
        domain_events = [
            e for e in events if isinstance(e, (ToolCallEvent, ToolResultEvent, FlightResultsEvent))
        ]
        assert len(domain_events) == 3
        assert isinstance(domain_events[0], ToolCallEvent)
        assert isinstance(domain_events[1], ToolResultEvent)
        assert isinstance(domain_events[2], FlightResultsEvent)

        assert domain_events[0].data.name == "search_flights"
        assert domain_events[1].data.name == "search_flights"
        assert len(domain_events[2].data.results) == 1
        assert domain_events[2].data.results[0]["airline"] == "United Airlines"


@pytest.mark.asyncio
async def test_t004_booking_readiness_ordering_tool_result_before_action_required():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t004-4")
    mock_queue.get_fence = MagicMock(return_value=4)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    validated_readiness = {
        "scope": "DOMESTIC",
        "ready": False,
        "nextAction": "COMPLETE_PROFILE",
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

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # 1. travel node ends with tool call
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
                                        "flight_offer_id": "offer-123",
                                    },
                                    "id": "call-readiness-t004",
                                }
                            ],
                        )
                    ]
                }
            },
        }
        # 2. Timing events
        yield {
            "event": "on_tool_start",
            "name": "check_booking_readiness",
            "data": {"input": {"flight_offer_id": "offer-123"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "check_booking_readiness",
            "data": {"output": validated_readiness},
        }
        # 3. Validated tools node
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=json.dumps(validated_readiness),
                            tool_call_id="call-readiness-t004",
                            name="check_booking_readiness",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Check readiness",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    # Verify exact emission order: ToolCallEvent -> ToolResultEvent -> ActionRequiredEvent
    domain_events = [
        e for e in events if isinstance(e, (ToolCallEvent, ToolResultEvent, ActionRequiredEvent))
    ]
    assert len(domain_events) == 3
    assert isinstance(domain_events[0], ToolCallEvent)
    assert isinstance(domain_events[1], ToolResultEvent)
    assert isinstance(domain_events[2], ActionRequiredEvent)

    assert domain_events[0].data.name == "check_booking_readiness"
    assert domain_events[1].data.name == "check_booking_readiness"
    assert domain_events[2].data.action == "COMPLETE_PROFILE"
    assert domain_events[2].data.target == "/profile"

    # Queue lease released on early return
    mock_queue.release.assert_awaited_once_with("session-456", "req-t004-4")


@pytest.mark.asyncio
async def test_t004_invalid_readiness_fail_closed_no_tool_result():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t004-5")
    mock_queue.get_fence = MagicMock(return_value=5)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    invalid_readiness = {
        "scope": "UNKNOWN",
        "error": "Upstream readiness verification service failure",
        "ready": False,
    }

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # 1. travel node ends with tool call
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
                                        "flight_offer_id": "offer-123",
                                    },
                                    "id": "call-readiness-err",
                                }
                            ],
                        )
                    ]
                }
            },
        }
        # 2. Timing events
        yield {
            "event": "on_tool_start",
            "name": "check_booking_readiness",
            "data": {"input": {"flight_offer_id": "offer-123"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "check_booking_readiness",
            "data": {"output": invalid_readiness},
        }
        # 3. Tools node emits tool message with invalid readiness response
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=json.dumps(invalid_readiness),
                            tool_call_id="call-readiness-err",
                            name="check_booking_readiness",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Check readiness",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    # ToolCallEvent WAS emitted before readiness validation
    tool_calls = [e for e in events if isinstance(e, ToolCallEvent)]
    assert len(tool_calls) == 1
    assert tool_calls[0].data.name == "check_booking_readiness"

    # Strictly NO ToolResultEvent or ActionRequiredEvent emitted
    tool_results = [e for e in events if isinstance(e, ToolResultEvent)]
    assert len(tool_results) == 0
    action_required = [e for e in events if isinstance(e, ActionRequiredEvent)]
    assert len(action_required) == 0

    # Fails closed with READINESS_RESPONSE_INVALID error
    errors = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(errors) == 1
    assert errors[0].data.code == "READINESS_RESPONSE_INVALID"
    assert errors[0].data.message == "Booking readiness could not be verified safely."

    # Queue lease released on error cleanup
    mock_queue.release.assert_awaited_once_with("session-456", "req-t004-5")


@pytest.mark.asyncio
async def test_t005_token_stream_processing():
    """T005: Incremental tokens arriving via on_chat_model_stream emit TokenEvent chunks to the client."""
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_t005_1", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t005-1")
    mock_queue.get_fence = MagicMock(return_value=1)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    tokens = ["Hello", " world", "!", " How can I help you today?"]
    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        for tok in tokens:
            yield {
                "event": "on_chat_model_stream",
                "run_id": "run-stream-t005-1",
                "data": {"chunk": MagicMock(content=tok)},
            }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Hello",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    # Verify each chunk is emitted as a TokenEvent in exact arrival order
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    assert len(token_events) == len(tokens)
    assert [e.data.content for e in token_events] == tokens

    # Verify DoneEvent is emitted with message ID and session ID
    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 1
    assert done_events[0].data.messageId == "msg_agent_t005_1"
    assert done_events[0].data.sessionId == "session-456"

    # Verify persisted agent message matches concatenated stream content
    mock_client.create_message_batch.assert_awaited()
    agent_msgs = [
        m
        for call in mock_client.create_message_batch.await_args_list
        for m in call.args[1]
        if m.get("sender") == "AGENT"
    ]
    assert len(agent_msgs) == 1
    assert agent_msgs[0]["content"] == "".join(tokens)


@pytest.mark.asyncio
async def test_t005_model_end_fallback_when_stream_empty():
    """T005: When on_chat_model_stream emits no tokens, verify fallback to full message content in on_chat_model_end."""
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_t005_2", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t005-2")
    mock_queue.get_fence = MagicMock(return_value=2)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    fallback_text = "Full non-streamed response from on_chat_model_end."
    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # Model starts, but no on_chat_model_stream tokens are emitted
        yield {
            "event": "on_chat_model_start",
            "run_id": "run-model-end-fallback",
            "data": {},
        }
        # on_chat_model_end provides the full response message
        yield {
            "event": "on_chat_model_end",
            "run_id": "run-model-end-fallback",
            "data": {"output": AIMessage(content=fallback_text)},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Non-streamed query",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    # Verify fallback emitted TokenEvent with full message content
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    assert len(token_events) == 1
    assert token_events[0].data.content == fallback_text

    # Verify DoneEvent emitted
    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 1
    assert done_events[0].data.messageId == "msg_agent_t005_2"

    # Verify persistence received full fallback content
    agent_msgs = [
        m
        for call in mock_client.create_message_batch.await_args_list
        for m in call.args[1]
        if m.get("sender") == "AGENT"
    ]
    assert len(agent_msgs) == 1
    assert agent_msgs[0]["content"] == fallback_text


@pytest.mark.asyncio
async def test_t005_final_node_fallback_when_stream_and_model_end_empty():
    """T005: When both stream and model-end yield no text, fallback to the final graph node's output message content."""
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_t005_3", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t005-3")
    mock_queue.get_fence = MagicMock(return_value=3)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    node_fallback_text = "Fallback output from final_answer node execution."
    final_msg = AIMessage(
        content=node_fallback_text,
        id="final-answer-node-msg-t005",
    )
    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # final_answer node starts
        yield {"event": "on_chain_start", "name": "final_answer"}
        # Model starts and ends without emitting any text
        yield {
            "event": "on_chat_model_start",
            "run_id": "run-empty-model-t005",
            "data": {},
        }
        yield {
            "event": "on_chat_model_end",
            "run_id": "run-empty-model-t005",
            "data": {"output": AIMessage(content="", id="empty-model-msg-t005")},
        }
        # final_answer node ends with the final node message in output
        yield {
            "event": "on_chain_end",
            "name": "final_answer",
            "data": {"output": {"messages": [final_msg]}},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Final node query",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    # Verify fallback emitted TokenEvent with final node message content
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    assert len(token_events) == 1
    assert token_events[0].data.content == node_fallback_text

    # Verify DoneEvent emitted
    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 1
    assert done_events[0].data.messageId == "msg_agent_t005_3"

    # Verify persistence received final node content
    agent_msgs = [
        m
        for call in mock_client.create_message_batch.await_args_list
        for m in call.args[1]
        if m.get("sender") == "AGENT"
    ]
    assert len(agent_msgs) == 1
    assert agent_msgs[0]["content"] == node_fallback_text


@pytest.mark.asyncio
async def test_t005_chunk_deduplication_prevents_duplicate_emission():
    """T005: If tokens already emitted via stream, model-end and final-node fallbacks MUST NOT duplicate tokens."""
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_t005_4", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t005-4")
    mock_queue.get_fence = MagicMock(return_value=4)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    full_text = "Flight SFO to JFK is confirmed."
    completed_msg = AIMessage(
        content=full_text,
        id="msg-completed-dedup-t005",
    )
    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # 1. Node starts
        yield {"event": "on_chain_start", "name": "final_answer"}
        # 2. Model starts
        yield {
            "event": "on_chat_model_start",
            "run_id": "run-dedup-t005",
            "data": {},
        }
        # 3. Stream emits incremental tokens
        stream_chunks = ["Flight SFO ", "to JFK is ", "confirmed."]
        for chunk in stream_chunks:
            yield {
                "event": "on_chat_model_stream",
                "run_id": "run-dedup-t005",
                "data": {"chunk": MagicMock(content=chunk)},
            }
        # 4. Model ends with the full aggregated message
        yield {
            "event": "on_chat_model_end",
            "run_id": "run-dedup-t005",
            "data": {"output": completed_msg},
        }
        # 5. Final node completes with that same message in output
        yield {
            "event": "on_chain_end",
            "name": "final_answer",
            "data": {"output": {"messages": [completed_msg]}},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Status of flight",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    # Verify only the 3 original stream chunks were emitted, with NO duplicate from model-end or node-end
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    assert len(token_events) == 3
    assert [e.data.content for e in token_events] == [
        "Flight SFO ",
        "to JFK is ",
        "confirmed.",
    ]
    total_text = "".join(e.data.content for e in token_events)
    assert total_text == full_text

    # Verify single DoneEvent
    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 1

    # Verify persisted message contains exactly the non-duplicated text
    agent_msgs = [
        m
        for call in mock_client.create_message_batch.await_args_list
        for m in call.args[1]
        if m.get("sender") == "AGENT"
    ]
    assert len(agent_msgs) == 1
    assert agent_msgs[0]["content"] == full_text


@pytest.mark.asyncio
async def test_t005_single_output_guardrail_session_routed():
    """T005: Confirm that all model output paths route through the single per-turn OutputStreamSession before external emission or persistence."""
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_t005_5", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t005-5")
    mock_queue.get_fence = MagicMock(return_value=5)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    created_sessions = []

    class SpyOutputStreamSession:
        def __init__(self, context=None, config=None, session_id=None, **kwargs):
            self.context = context
            self.config = config
            self.session_id = session_id
            self.call_log = []
            self.processed_tokens = []
            self.closed = False
            self.flushed = False
            created_sessions.append(self)

        async def process_token(self, token: str):
            self.call_log.append(("process_token", token))
            self.processed_tokens.append(token)
            yield f"[GUARDED]{token}"

        async def flush(self):
            self.call_log.append(("flush",))
            self.flushed = True
            yield "[GUARDED_FLUSH]"

        async def aclose(self):
            self.call_log.append(("aclose",))
            self.closed = True

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # Branch 1: Streamed token
        yield {"event": "on_chain_start", "name": "travel"}
        yield {
            "event": "on_chat_model_stream",
            "run_id": "run-gw-1",
            "data": {"chunk": MagicMock(content="TokenA ")},
        }
        yield {
            "event": "on_chat_model_end",
            "run_id": "run-gw-1",
            "data": {"output": AIMessage(content="TokenA ")},
        }
        yield {"event": "on_chain_end", "name": "travel", "data": {"output": {}}}

        # Branch 2: Non-streamed model-end fallback
        yield {"event": "on_chain_start", "name": "checkout"}
        yield {
            "event": "on_chat_model_end",
            "run_id": "run-gw-2",
            "data": {"output": AIMessage(content="TokenB ")},
        }
        yield {
            "event": "on_chain_end",
            "name": "checkout",
            "data": {"output": {"messages": [AIMessage(content="TokenB ")]}},
        }

        # Branch 3: Final-node output fallback
        yield {"event": "on_chain_start", "name": "final_answer"}
        yield {
            "event": "on_chain_end",
            "name": "final_answer",
            "data": {"output": {"messages": [AIMessage(content="TokenC")]}},
        }

    mock_graph.astream_events = mock_astream_events

    with patch("agent.chat_turn.runner.OutputStreamSession", SpyOutputStreamSession):
        runner = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=mock_queue,
            client_factory=lambda **kwargs: mock_client,
            redis_client=MagicMock(),
        )

        command = ChatTurnCommand(
            user_id="user-123",
            session_id="session-456",
            message="Check routing",
            token="mock_token",
        )

        events = [e async for e in runner.run(command)]

    # 1. Exactly one OutputStreamSession was created for the entire turn
    assert len(created_sessions) == 1
    session = created_sessions[0]

    # 2. All 3 model output paths routed through the single session's process_token
    assert session.processed_tokens == ["TokenA ", "TokenB ", "TokenC"]

    # 3. Flushed and closed on the same session
    assert session.flushed is True
    assert session.closed is True
    assert [entry[0] for entry in session.call_log] == [
        "process_token",
        "process_token",
        "process_token",
        "flush",
        "aclose",
    ]

    # 4. External emission received strictly the session-transformed chunks (never raw tokens)
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    assert [e.data.content for e in token_events] == [
        "[GUARDED]TokenA ",
        "[GUARDED]TokenB ",
        "[GUARDED]TokenC",
        "[GUARDED_FLUSH]",
    ]

    # 5. Persistence received the exact combined output routed through the session
    agent_msgs = [
        m
        for call in mock_client.create_message_batch.await_args_list
        for m in call.args[1]
        if m.get("sender") == "AGENT"
    ]
    assert len(agent_msgs) == 1
    assert (
        agent_msgs[0]["content"] == "[GUARDED]TokenA [GUARDED]TokenB [GUARDED]TokenC[GUARDED_FLUSH]"
    )


@pytest.mark.asyncio
async def test_runner_delegates_to_graph_event_interpreter():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_1", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-123")
    mock_queue.get_fence = MagicMock(return_value=42)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(
        *args: object, **kwargs: object
    ) -> AsyncIterator[dict[str, object]]:
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
                                    "id": "call_delegate_1",
                                    "name": "check_booking_readiness",
                                    "args": {},
                                }
                            ],
                        )
                    ]
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
                                    "scope": "DOMESTIC",
                                    "ready": True,
                                    "nextAction": "CONTINUE_CHECKOUT",
                                    "passengers": [],
                                }
                            ),
                            tool_call_id="call_delegate_1",
                            name="check_booking_readiness",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Hello via interpreter!")},
        }

    mock_graph.astream_events = mock_astream_events

    mock_redis = MagicMock()
    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=mock_redis,
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Hello",
        token="jwt.token.val",
        trace_id="chat_0123456789abcdef0123456789abcdef",
        correlation_id="chat_fedcba9876543210fedcba9876543210",
    )

    events = [e async for e in runner.run(command)]

    # 1. Verify ToolCallEvent input projection via GraphEventInterpreter -> ToolResultResolver
    tool_calls = [e for e in events if isinstance(e, ToolCallEvent)]
    assert len(tool_calls) == 1
    assert tool_calls[0].data.name == "check_booking_readiness"
    assert tool_calls[0].data.inputs == {"message": "Checking booking readiness..."}

    # 2. Verify ToolResultEvent summary override via GraphEventInterpreter -> ToolResultResolver
    tool_results = [e for e in events if isinstance(e, ToolResultEvent)]
    assert len(tool_results) == 1
    assert tool_results[0].data.name == "check_booking_readiness"
    assert tool_results[0].data.result == "Successfully checked booking readiness."

    # 3. Verify TokenEvent streaming through output guardrail pipeline
    tokens = [e for e in events if isinstance(e, TokenEvent)]
    assert len(tokens) == 1
    assert tokens[0].data.content == "Hello via interpreter!"

    # 4. Verify DoneEvent emitted and queue lease released
    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 1
    assert done_events[0].data.sessionId == "session-456"
    mock_queue.release.assert_awaited_once_with("session-456", "req-123")


@pytest.mark.asyncio
async def test_runner_delegates_to_conversation_memory_and_schedules_compaction() -> None:
    mock_client = MagicMock()
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_1", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-123")
    mock_queue.get_fence = MagicMock(return_value=42)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(
        *args: object, **kwargs: object
    ) -> AsyncIterator[dict[str, object]]:
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Hello!")},
        }

    mock_graph.astream_events = mock_astream_events

    mock_memory = MagicMock(spec=ConversationMemory)
    mock_memory.get_context = AsyncMock(
        return_value=ValidatedConversationContext(
            history=[],
            summary=None,
            total_message_count=10,
        )
    )
    mock_memory.schedule_compaction = MagicMock()

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **_kwargs: mock_client,
        redis_client=MagicMock(),
        conversation_memory=mock_memory,
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Hello",
        token="jwt.token.val",
        trace_id="trace-123",
        correlation_id="corr-456",
    )

    events = [e async for e in runner.run(command)]

    assert any(isinstance(e, DoneEvent) for e in events)

    mock_memory.get_context.assert_awaited_once()
    get_ctx_kwargs = mock_memory.get_context.await_args.kwargs
    assert get_ctx_kwargs["session_id"] == "session-456"
    assert get_ctx_kwargs["client"] is mock_client
    admission_ctx = get_ctx_kwargs["admission_context"]
    assert admission_ctx.user_id == "user-123"
    assert admission_ctx.chat_session_id == "session-456"
    assert admission_ctx.trace_id == "trace-123"
    assert admission_ctx.correlation_id == "corr-456"

    mock_memory.schedule_compaction.assert_called_once_with(
        session_id="session-456",
        client=mock_client,
        total_count=10,
        background_tasks=background_tasks,
    )


@pytest.mark.asyncio
async def test_runner_memory_session_not_found_cleanup() -> None:
    mock_client = MagicMock()
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-not-found")
    mock_queue.get_fence = MagicMock(return_value=1)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    mock_memory = MagicMock(spec=ConversationMemory)
    mock_memory.get_context = AsyncMock(
        side_effect=SessionNotFoundException("Chat session not found.")
    )

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **_kwargs: mock_client,
        redis_client=MagicMock(),
        conversation_memory=mock_memory,
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Hello",
        token="jwt.token.val",
    )

    events = [e async for e in runner.run(command)]

    error_events = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(error_events) == 1
    assert error_events[0].data.code == "CHAT_SESSION_NOT_FOUND"
    assert error_events[0].data.message == "Chat session not found."
    mock_queue.release.assert_awaited_once_with("session-456", "req-not-found")


@pytest.mark.asyncio
async def test_runner_memory_persistence_error_cleanup() -> None:
    mock_client = MagicMock()
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-persist-err")
    mock_queue.get_fence = MagicMock(return_value=1)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    mock_memory = MagicMock(spec=ConversationMemory)
    mock_memory.get_context = AsyncMock(
        side_effect=MemoryPersistenceException("Failed to fetch chat session memory.")
    )

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **_kwargs: mock_client,
        redis_client=MagicMock(),
        conversation_memory=mock_memory,
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Hello",
        token="jwt.token.val",
    )

    events = [e async for e in runner.run(command)]

    error_events = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(error_events) == 1
    assert error_events[0].data.code == "PERSISTENCE_ERROR"
    assert error_events[0].data.message == "Failed to fetch chat session memory."
    mock_queue.release.assert_awaited_once_with("session-456", "req-persist-err")


@pytest.mark.asyncio
async def test_runner_memory_context_blocked_cleanup() -> None:
    mock_client = MagicMock()
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-blocked")
    mock_queue.get_fence = MagicMock(return_value=1)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    mock_memory = MagicMock(spec=ConversationMemory)
    mock_memory.get_context = AsyncMock(
        side_effect=ContextBlockedException(error_code="GUARDRAIL_PROMPT_INJECTION")
    )

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **_kwargs: mock_client,
        redis_client=MagicMock(),
        conversation_memory=mock_memory,
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Hello",
        token="jwt.token.val",
    )

    events = [e async for e in runner.run(command)]

    error_events = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(error_events) == 1
    assert error_events[0].data.code == "GUARDRAIL_PROMPT_INJECTION"
    assert (
        error_events[0].data.message == "Historical conversation context contains unsafe content."
    )
    mock_queue.release.assert_awaited_once_with("session-456", "req-blocked")


# ---------------------------------------------------------------------------
# T022 Turn Runner Lifecycle and Failure Cleanup Characterization Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_t022_normal_turn_execution_lifecycle_ordering() -> None:
    """Requirement 1: Normal Turn Execution Flow
    - Distributed lease acquired via queue_manager.acquire(session_id, user_id=...).
    - Active search snapshot loaded via TrustedSearchSnapshotLifecycle.
    - Conversation context retrieved via ConversationMemory.get_context().
    - Graph stream translated via GraphEventInterpreter and ToolResultResolver.
    - Raw tokens chunk-buffered and analyzed by single per-turn OutputStreamSession.
    - User + Agent batch persisted via _persist_response.
    - Single output-session flush via pipeline.flush().
    - Background compaction scheduled via ConversationMemory.schedule_compaction with totalMessageCount + 2 and GC-safe tracking in background_tasks.
    - Session lease released via queue_manager.release(session_id, req_id).
    """
    call_order: list[str] = []

    mock_queue = MagicMock()

    async def tracked_acquire(session_id: str, user_id: str | None = None) -> str:
        call_order.append("queue_acquire")
        return "req-t022-normal"

    mock_queue.acquire = AsyncMock(side_effect=tracked_acquire)
    mock_queue.get_fence = MagicMock(return_value=42)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)

    async def tracked_release(session_id: str, req_id: str) -> None:
        call_order.append("queue_release")

    mock_queue.release = AsyncMock(side_effect=tracked_release)

    mock_memory = MagicMock(spec=ConversationMemory)

    async def tracked_get_context(
        session_id: str,
        client: object,
        admission_context: AdmissionContext,
    ) -> ValidatedConversationContext:
        call_order.append("get_context")
        return ValidatedConversationContext(
            history=[],
            summary=None,
            total_message_count=8,
        )

    mock_memory.get_context = AsyncMock(side_effect=tracked_get_context)

    real_mem = ConversationMemory(window_size=20, token_budget=4000)

    def tracked_schedule_compaction(
        session_id: str,
        client: object,
        total_count: int | None = None,
        background_tasks: set[asyncio.Task[object]] | set[asyncio.Task[None]] | None = None,
        **kwargs: object,
    ) -> asyncio.Task[None]:
        call_order.append("schedule_compaction")
        return real_mem.schedule_compaction(
            session_id=session_id,
            client=client,  # type: ignore[arg-type]
            total_count=total_count,
            background_tasks=background_tasks,
        )

    mock_memory.schedule_compaction = MagicMock(side_effect=tracked_schedule_compaction)

    mock_client = MagicMock()
    mock_client.set_fencing_token = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 8}
    )

    async def tracked_create_batch(
        session_id: str,
        messages: list[dict[str, object]],
    ) -> dict[str, object]:
        if any(m.get("sender") == "USER" for m in messages) and not any(
            m.get("sender") == "AGENT" for m in messages
        ):
            call_order.append("user_pre_persist")
        else:
            call_order.append("persist_response")
        return {"messages": [{"id": "msg-agent-t022", "sender": "AGENT"}]}

    mock_client.create_message_batch = AsyncMock(side_effect=tracked_create_batch)

    class TrackingOutputStreamSession:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self.closed = False
            self.flushed = False

        async def process_token(self, token: str) -> AsyncIterator[str]:
            call_order.append("process_token")
            yield token

        async def flush(self) -> AsyncIterator[str]:
            call_order.append("pipeline_flush")
            self.flushed = True
            if False:
                yield ""

        async def aclose(self) -> None:
            call_order.append("pipeline_aclose")
            self.closed = True

        def close(self) -> None:
            call_order.append("pipeline_close")
            self.closed = True

    tracking_pipeline = TrackingOutputStreamSession()

    mock_graph = MagicMock()

    async def mock_astream_events(
        *args: object, **kwargs: object
    ) -> AsyncIterator[dict[str, object]]:
        call_order.append("graph_astream_events")
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Hello flight world!")},
        }

    mock_graph.astream_events = mock_astream_events

    mock_redis = MagicMock()

    async def tracked_load_active(owner: SnapshotOwner) -> None:
        call_order.append("snapshot_load")
        return None

    with (
        patch(
            "agent.chat_turn.runner.TrustedSearchSnapshotLifecycle.load_active",
            side_effect=tracked_load_active,
        ),
        patch(
            "agent.chat_turn.runner.OutputStreamSession",
            return_value=tracking_pipeline,
        ),
    ):
        runner = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=mock_queue,
            client_factory=lambda **_kwargs: mock_client,
            redis_client=mock_redis,
            conversation_memory=mock_memory,
        )

        command = ChatTurnCommand(
            user_id="user-t022",
            session_id="session-t022",
            message="Find flights to JFK",
            token="jwt.token.val",
            trace_id="trace-t022-normal",
            correlation_id="corr-t022-normal",
        )

        events = [e async for e in runner.run(command)]

    # 1. Distributed lease acquired via queue_manager.acquire(session_id, user_id=...)
    mock_queue.acquire.assert_awaited_once_with("session-t022", user_id="user-t022")
    mock_client.set_fencing_token.assert_called_once_with(42)

    # 2. Conversation context retrieved via ConversationMemory.get_context()
    mock_memory.get_context.assert_awaited_once()

    # 3. Active search snapshot loaded via TrustedSearchSnapshotLifecycle
    assert "snapshot_load" in call_order

    # 4. Stream token processed through single OutputStreamSession
    tokens = [e for e in events if isinstance(e, TokenEvent)]
    assert len(tokens) == 1
    assert tokens[0].data.content == "Hello flight world!"
    assert "process_token" in call_order

    # 5. Flush occurred on single output session
    assert tracking_pipeline.flushed is True
    assert "pipeline_flush" in call_order

    # 6. Response persisted via create_message_batch
    assert "persist_response" in call_order

    # 7. Pipeline closed
    assert tracking_pipeline.closed is True
    assert "pipeline_aclose" in call_order

    # 8. Session lease released via queue_manager.release(session_id, req_id)
    mock_queue.release.assert_awaited_once_with("session-t022", "req-t022-normal")
    assert "queue_release" in call_order

    # 9. Terminal DoneEvent emitted
    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 1
    assert done_events[0].data.messageId == "msg-agent-t022"
    assert done_events[0].data.sessionId == "session-t022"

    # 10. Background compaction scheduled via ConversationMemory.schedule_compaction
    mock_memory.schedule_compaction.assert_called_once_with(
        session_id="session-t022",
        client=mock_client,
        total_count=8,
        background_tasks=background_tasks,
    )
    assert "schedule_compaction" in call_order

    # Verify lifecycle sequential ordering invariants:
    # acquire -> context -> snapshot -> stream -> process -> flush -> persist -> close -> release -> compaction
    acquire_idx = call_order.index("queue_acquire")
    ctx_idx = call_order.index("get_context")
    snap_idx = call_order.index("snapshot_load")
    process_idx = call_order.index("process_token")
    flush_idx = call_order.index("pipeline_flush")
    persist_idx = call_order.index("persist_response")
    close_idx = call_order.index("pipeline_aclose")
    release_idx = call_order.index("queue_release")
    compact_idx = call_order.index("schedule_compaction")

    assert (
        acquire_idx
        < ctx_idx
        < snap_idx
        < process_idx
        < flush_idx
        < persist_idx
        < close_idx
        < release_idx
        <= compact_idx
    )


@pytest.mark.asyncio
async def test_t022_invalid_readiness_block_cleanup_ordering() -> None:
    """Requirement 2: Invalid-Readiness Block Cleanup
    - ProjectionBlockedException(error_code="READINESS_RESPONSE_INVALID", error_message="Booking readiness projection failed.")
    - Enforce 4-step causal failure cleanup: partial persist (if tokens emitted) -> pipeline close (non-flushing) -> lease release.
    - Emits terminal ErrorEvent(READINESS_RESPONSE_INVALID).
    - Strictly zero ActionRequiredEvent emitted.
    """
    call_order: list[str] = []

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t022-readiness")
    mock_queue.get_fence = MagicMock(return_value=12)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)

    async def tracked_release(session_id: str, req_id: str) -> None:
        call_order.append("queue_release")

    mock_queue.release = AsyncMock(side_effect=tracked_release)

    mock_client = MagicMock()
    mock_client.set_fencing_token = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )

    async def tracked_create_batch(
        session_id: str,
        messages: list[dict[str, object]],
    ) -> dict[str, object]:
        if any(m.get("sender") == "USER" for m in messages) and not any(
            m.get("sender") == "AGENT" for m in messages
        ):
            call_order.append("user_pre_persist")
        else:
            call_order.append("partial_persist")
        return {"messages": [{"id": "partial-readiness-id", "sender": "AGENT"}]}

    mock_client.create_message_batch = AsyncMock(side_effect=tracked_create_batch)

    class TrackingOutputStreamSession:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self.closed = False
            self.flushed = False

        async def process_token(self, token: str) -> AsyncIterator[str]:
            call_order.append("process_token")
            yield token

        async def flush(self) -> AsyncIterator[str]:
            call_order.append("pipeline_flush")
            self.flushed = True
            if False:
                yield ""

        async def aclose(self) -> None:
            call_order.append("pipeline_aclose")
            self.closed = True

        def close(self) -> None:
            call_order.append("pipeline_close")
            self.closed = True

    tracking_pipeline = TrackingOutputStreamSession()

    mock_graph = MagicMock()

    async def mock_astream_events(
        *args: object, **kwargs: object
    ) -> AsyncIterator[dict[str, object]]:
        # 1. Tokens emitted before failure
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Checking booking readiness... ")},
        }
        # 2. Tool result chain end with invalid booking readiness data
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=json.dumps({"invalid_field": "corrupted payload"}),
                            name="check_booking_readiness",
                            tool_call_id="call-readiness-1",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }

    mock_graph.astream_events = mock_astream_events

    with (
        patch(
            "agent.chat_turn.runner.OutputStreamSession",
            return_value=tracking_pipeline,
        ),
        patch(
            "agent.chat_turn.resolver.ToolResultResolver.resolve",
            return_value=ToolResolution(
                is_blocked=True,
                error_code="READINESS_RESPONSE_INVALID",
                error_message="Booking readiness projection failed.",
            ),
        ),
    ):
        runner = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=mock_queue,
            client_factory=lambda **_kwargs: mock_client,
            redis_client=MagicMock(),
        )

        command = ChatTurnCommand(
            user_id="user-t022",
            session_id="session-t022-readiness",
            message="Check readiness",
            token="jwt.token.val",
        )

        events = [e async for e in runner.run(command)]

    # Enforce 4-step causal failure cleanup:
    # 1. partial persist (since tokens were emitted)
    # 2. pipeline close (non-flushing)
    # 3. lease release
    # 4. terminal ErrorEvent
    assert "partial_persist" in call_order
    assert "pipeline_aclose" in call_order
    assert "queue_release" in call_order
    assert tracking_pipeline.flushed is False
    assert "pipeline_flush" not in call_order

    persist_idx = call_order.index("partial_persist")
    close_idx = call_order.index("pipeline_aclose")
    release_idx = call_order.index("queue_release")
    assert persist_idx < close_idx < release_idx

    mock_queue.release.assert_awaited_once_with("session-t022-readiness", "req-t022-readiness")

    # Emits terminal ErrorEvent(READINESS_RESPONSE_INVALID)
    errors = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(errors) == 1
    assert errors[0].data.code == "READINESS_RESPONSE_INVALID"
    assert errors[0].data.message == "Booking readiness projection failed."
    assert errors[0].data.partialMessageId == "partial-readiness-id"

    # Strictly zero ActionRequiredEvent emitted
    action_events = [e for e in events if isinstance(e, ActionRequiredEvent)]
    assert len(action_events) == 0

    # Strictly zero DoneEvent emitted
    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 0


@pytest.mark.asyncio
async def test_t022_handoff_node_failure_cleanup_ordering() -> None:
    """Requirement 3: Handoff Node Failure Cleanup
    - ProjectionBlockedException(error_code="HANDOFF_FAILED", error_message="Handoff token creation failed.")
    - Enforce 4-step causal failure cleanup with force_persist=True.
    - Emits terminal ErrorEvent(HANDOFF_FAILED).
    - Strictly zero ActionHandoffEvent emitted.
    """
    call_order: list[str] = []

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t022-handoff")
    mock_queue.get_fence = MagicMock(return_value=15)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)

    async def tracked_release(session_id: str, req_id: str) -> None:
        call_order.append("queue_release")

    mock_queue.release = AsyncMock(side_effect=tracked_release)

    mock_client = MagicMock()
    mock_client.set_fencing_token = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )

    async def tracked_create_batch(
        session_id: str,
        messages: list[dict[str, object]],
    ) -> dict[str, object]:
        if any(m.get("sender") == "USER" for m in messages) and not any(
            m.get("sender") == "AGENT" for m in messages
        ):
            call_order.append("user_pre_persist")
        else:
            call_order.append("partial_persist")
        return {"messages": [{"id": "partial-handoff-id", "sender": "AGENT"}]}

    mock_client.create_message_batch = AsyncMock(side_effect=tracked_create_batch)

    class TrackingOutputStreamSession:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self.closed = False
            self.flushed = False

        async def process_token(self, token: str) -> AsyncIterator[str]:
            call_order.append("process_token")
            yield token

        async def flush(self) -> AsyncIterator[str]:
            call_order.append("pipeline_flush")
            self.flushed = True
            if False:
                yield ""

        async def aclose(self) -> None:
            call_order.append("pipeline_aclose")
            self.closed = True

        def close(self) -> None:
            call_order.append("pipeline_close")
            self.closed = True

    tracking_pipeline = TrackingOutputStreamSession()

    mock_graph = MagicMock()

    async def mock_astream_events(
        *args: object, **kwargs: object
    ) -> AsyncIterator[dict[str, object]]:
        # Handoff node fails with error in action
        yield {
            "event": "on_chain_end",
            "name": "create_handoff_token",
            "data": {
                "output": {
                    "action": {
                        "error": "Payment token authorization failed",
                    }
                }
            },
        }

    mock_graph.astream_events = mock_astream_events

    with patch(
        "agent.chat_turn.runner.OutputStreamSession",
        return_value=tracking_pipeline,
    ):
        runner = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=mock_queue,
            client_factory=lambda **_kwargs: mock_client,
            redis_client=MagicMock(),
        )

        command = ChatTurnCommand(
            user_id="user-t022",
            session_id="session-t022-handoff",
            message="Proceed to payment",
            token="jwt.token.val",
        )

        events = [e async for e in runner.run(command)]

    # Enforce 4-step causal failure cleanup with force_persist=True:
    # 1. partial persist (enforced even if partial_response was empty)
    # 2. pipeline close (non-flushing)
    # 3. lease release
    # 4. terminal ErrorEvent(HANDOFF_FAILED)
    assert "partial_persist" in call_order
    assert "pipeline_aclose" in call_order
    assert "queue_release" in call_order
    assert tracking_pipeline.flushed is False
    assert "pipeline_flush" not in call_order

    persist_idx = call_order.index("partial_persist")
    close_idx = call_order.index("pipeline_aclose")
    release_idx = call_order.index("queue_release")
    assert persist_idx < close_idx < release_idx

    mock_queue.release.assert_awaited_once_with("session-t022-handoff", "req-t022-handoff")

    # Emits terminal ErrorEvent(HANDOFF_FAILED)
    errors = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(errors) == 1
    assert errors[0].data.code == "HANDOFF_FAILED"
    assert errors[0].data.message == "Checkout handoff could not be created."
    assert errors[0].data.partialMessageId == "partial-handoff-id"

    # Strictly zero ActionHandoffEvent emitted
    handoff_events = [e for e in events if isinstance(e, ActionHandoffEvent)]
    assert len(handoff_events) == 0

    # Strictly zero DoneEvent emitted
    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 0


@pytest.mark.asyncio
async def test_t022_causal_cleanup_ordering_on_exception() -> None:
    """Requirement 6: Causal Cleanup Ordering on Exceptions
    - Unhandled upstream exception strictly executes: partial_persist -> pipeline.close -> queue_manager.release -> terminal ErrorEvent.
    """
    call_order: list[str] = []

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t022-exc")
    mock_queue.get_fence = MagicMock(return_value=99)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)

    async def tracked_release(session_id: str, req_id: str) -> None:
        call_order.append("queue_release")

    mock_queue.release = AsyncMock(side_effect=tracked_release)

    mock_client = MagicMock()
    mock_client.set_fencing_token = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )

    async def tracked_create_batch(
        session_id: str,
        messages: list[dict[str, object]],
    ) -> dict[str, object]:
        if any(m.get("sender") == "USER" for m in messages) and not any(
            m.get("sender") == "AGENT" for m in messages
        ):
            call_order.append("user_pre_persist")
        else:
            call_order.append("partial_persist")
        return {"messages": [{"id": "partial-exc-msg-id", "sender": "AGENT"}]}

    mock_client.create_message_batch = AsyncMock(side_effect=tracked_create_batch)

    class TrackingOutputStreamSession:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self.closed = False
            self.flushed = False

        async def process_token(self, token: str) -> AsyncIterator[str]:
            call_order.append("process_token")
            yield token

        async def flush(self) -> AsyncIterator[str]:
            call_order.append("pipeline_flush")
            self.flushed = True
            if False:
                yield ""

        async def aclose(self) -> None:
            call_order.append("pipeline_aclose")
            self.closed = True

        def close(self) -> None:
            call_order.append("pipeline_close")
            self.closed = True

    tracking_pipeline = TrackingOutputStreamSession()

    mock_graph = MagicMock()

    async def mock_astream_events(
        *args: object, **kwargs: object
    ) -> AsyncIterator[dict[str, object]]:
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Emitted tokens before crash ")},
        }
        raise RuntimeError("Fatal upstream LLM provider connection failure")

    mock_graph.astream_events = mock_astream_events

    with patch(
        "agent.chat_turn.runner.OutputStreamSession",
        return_value=tracking_pipeline,
    ):
        runner = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=mock_queue,
            client_factory=lambda **_kwargs: mock_client,
            redis_client=MagicMock(),
        )

        command = ChatTurnCommand(
            user_id="user-t022",
            session_id="session-t022-exc",
            message="Search flights",
            token="jwt.token.val",
        )

        events = [e async for e in runner.run(command)]

    # Causal cleanup sequence: partial_persist -> pipeline.close (non-flushing) -> queue_manager.release -> terminal ErrorEvent
    assert "partial_persist" in call_order
    assert "pipeline_aclose" in call_order
    assert "queue_release" in call_order
    assert tracking_pipeline.flushed is False
    assert "pipeline_flush" not in call_order

    persist_idx = call_order.index("partial_persist")
    close_idx = call_order.index("pipeline_aclose")
    release_idx = call_order.index("queue_release")
    assert persist_idx < close_idx < release_idx

    mock_queue.release.assert_awaited_once_with("session-t022-exc", "req-t022-exc")

    errors = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(errors) == 1
    assert errors[0].data.code == "LLM_ERROR"
    assert errors[0].data.message == "The AI model encountered an error. Please try again."
    assert errors[0].data.partialMessageId == "partial-exc-msg-id"
