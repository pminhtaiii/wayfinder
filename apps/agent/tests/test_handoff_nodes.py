from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from agent.graph.nodes import (
    create_handoff_token,
    create_handoff_token_node,
    validate_handoff,
)
from agent.graph.state import AgentState
from agent.tools.nestjs_client import NestJSClient
from agent.tools.registry import (
    _CHECKOUT_TOOLS,
    _GENERAL_TOOLS,
    _TRAVEL_TOOLS,
    get_tools,
)


# User approved on 2026-10-03: handoff fixtures represent canonical state and use supplierOfferId.
@pytest.fixture
def mock_nestjs_client():
    client = AsyncMock(spec=NestJSClient)
    return client


@pytest.mark.asyncio
async def test_validate_handoff_missing_signal():
    state = AgentState(signal=None)
    result = await validate_handoff(state, None)
    assert "error" in result["action"]

    state_empty = AgentState(signal={})
    result_empty = await validate_handoff(state_empty, None)
    assert "error" in result_empty["action"]


@pytest.mark.asyncio
async def test_validate_handoff_invalid_offer_index():
    state_zero = AgentState(signal={"offer_index": 0})
    result_zero = await validate_handoff(state_zero, None)
    assert "error" in result_zero["action"]

    state_negative = AgentState(signal={"offer_index": -1})
    result_negative = await validate_handoff(state_negative, None)
    assert "error" in result_negative["action"]

    state_bool = AgentState(signal={"offer_index": True})
    result_bool = await validate_handoff(state_bool, None)
    assert "error" in result_bool["action"]

    state_str = AgentState(signal={"offer_index": "1"})
    result_str = await validate_handoff(state_str, None)
    assert "error" in result_str["action"]


@pytest.mark.asyncio
async def test_validate_handoff_missing_snapshot():
    state = AgentState(
        signal={"offer_index": 1},
        trusted_snapshot=None,
    )
    result = await validate_handoff(state, None)
    assert "error" in result["action"]


@pytest.mark.asyncio
async def test_validate_handoff_invalid_snapshot_missing_version_or_attestation():
    state_no_attestation = AgentState(
        signal={"offer_index": 1},
        trusted_snapshot={"version": 1, "results": [{"airline": "VN"}]},
    )
    res1 = await validate_handoff(state_no_attestation, None)
    assert "error" in res1["action"]

    state_no_version = AgentState(
        signal={"offer_index": 1},
        trusted_snapshot={"attestation": "valid_att", "results": [{"airline": "VN"}]},
    )
    res2 = await validate_handoff(state_no_version, None)
    assert "error" in res2["action"]


@pytest.mark.asyncio
async def test_validate_handoff_offer_index_out_of_bounds():
    state = AgentState(
        signal={"offer_index": 3},
        trusted_snapshot={
            "version": 1,
            "attestation": "valid_att",
            "results": [{"airline": "VN"}],
        },
    )
    result = await validate_handoff(state, None)
    assert "error" in result["action"]


@pytest.mark.asyncio
async def test_validate_handoff_expired_snapshot():
    expired_at = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    state = AgentState(
        signal={"offer_index": 1},
        trusted_snapshot={
            "version": 1,
            "attestation": "valid_att",
            "expiresAt": expired_at,
            "results": [{"airline": "VN"}],
        },
    )
    result = await validate_handoff(state, None)
    assert result == {"action": {"error": "Search snapshot has expired. Please search again."}}


@pytest.mark.asyncio
async def test_validate_handoff_valid_unexpired_snapshot():
    unexpired_at = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()
    state = AgentState(
        signal={"offer_index": 1},
        trusted_snapshot={
            "version": 1,
            "attestation": "valid_att",
            "expiresAt": unexpired_at,
            "results": [{"airline": "VN"}],
        },
    )
    result = await validate_handoff(state, None)
    assert result == {}


@pytest.mark.asyncio
async def test_validate_handoff_supports_alternate_keys():
    unexpired_at = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()
    state = AgentState(
        signal={"selected_index": 2},
        trusted_snapshot={
            "snapshotVersion": 2,
            "selectionAttestation": "sel_att_valid",
            "snapshotExpiresAt": unexpired_at,
            "results": [{"airline": "VN"}, {"airline": "JL"}],
        },
    )
    result = await validate_handoff(state, None)
    assert result == {}


@pytest.mark.asyncio
async def test_create_handoff_token_disabled_feature_flag():
    state = AgentState(
        signal={"offer_index": 1},
        trusted_snapshot={
            "version": 1,
            "attestation": "test_attestation",
            "results": [{"airline": "VN"}],
        },
    )
    with patch("agent.graph.nodes.get_settings") as get_settings:
        get_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = False
        result = await create_handoff_token(state, None)

    assert result == {"action": {"error": "Chat handoff issuance is disabled."}}


@pytest.mark.asyncio
async def test_create_handoff_token_success():
    state = AgentState(
        signal={"offer_index": 1},
        trusted_snapshot={
            "version": 1,
            "attestation": "test_attestation",
            "fingerprint": "fp_test_123",
            "results": [
                {
                    "flightOfferId": "off_sensitive_id",
                    "supplierOfferId": "supplier_sensitive_id",
                    "airline": "Vietnam Airlines",
                    "flightNumber": "VN310",
                    "origin": "HAN",
                    "destination": "NRT",
                    "departureAt": "2026-08-15T08:30:00Z",
                    "arrivalAt": "2026-08-15T15:00:00Z",
                    "price": "452.00",
                    "currency": "USD",
                    "internalSecret": "do_not_expose",
                }
            ],
        },
    )

    mock_client = AsyncMock()
    mock_client.create_handoff_token.return_value = {
        "handoffToken": "test_token_xyz",
        "expiresAt": "2026-08-15T20:00:00Z",
    }

    with (
        patch("agent.graph.nodes.get_settings") as get_settings,
        patch("agent.graph.nodes.get_nestjs_client", return_value=mock_client),
    ):
        get_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = True
        result = await create_handoff_token(state, None)

    assert "action" in result
    action = result["action"]
    assert action["action"] == "begin_checkout"
    assert action["handoffToken"] == "test_token_xyz"
    assert action["expiresAt"] == "2026-08-15T20:00:00Z"
    assert action["display"] == {
        "airline": "Vietnam Airlines",
        "origin": "HAN",
        "destination": "NRT",
        "departureAt": "2026-08-15T08:30:00Z",
        "arrivalAt": "2026-08-15T15:00:00Z",
        "price": "452.00",
        "currency": "USD",
    }
    mock_client.create_handoff_token.assert_awaited_once_with(
        attestation="test_attestation",
        selected_offer_index=1,
        fingerprint="fp_test_123",
    )
    # Sensitive and unlisted fields must not leak into display
    assert "flightNumber" not in action["display"]
    assert "flightOfferId" not in action["display"]
    assert "duffelOfferId" not in action["display"]
    assert "internalSecret" not in action["display"]


@pytest.mark.asyncio
async def test_create_handoff_token_redacts_upstream_failure_details(caplog):
    state = AgentState(
        signal={"offer_index": 1},
        trusted_snapshot={
            "version": 1,
            "attestation": "test_attestation",
            "fingerprint": "test_fp",
            "results": [
                {
                    "flightOfferId": "off_sensitive_id",
                    "supplierOfferId": "supplier_sensitive_id",
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
    )
    mock_client = AsyncMock()
    mock_client.create_handoff_token.side_effect = RuntimeError(
        "request failed for https://supplier.invalid/off_sensitive"
    )

    with (
        patch("agent.graph.nodes.get_settings") as get_settings,
        patch("agent.graph.nodes.get_nestjs_client", return_value=mock_client),
    ):
        get_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = True
        result = await create_handoff_token(state, None)

    assert result == {"action": {"error": "Checkout handoff could not be created."}}
    assert "supplier.invalid" not in str(result)
    assert "off_sensitive" not in str(result)
    assert "supplier.invalid" not in caplog.text
    assert "off_sensitive" not in caplog.text


def test_create_handoff_token_node_alias():
    assert create_handoff_token_node is create_handoff_token


def test_handoff_nodes_not_in_tool_registries():
    all_registered_tools = get_tools()
    all_tool_names = {t.name for t in all_registered_tools}
    general_tool_names = {t.name for t in _GENERAL_TOOLS}
    travel_tool_names = {t.name for t in _TRAVEL_TOOLS}
    checkout_tool_names = {t.name for t in _CHECKOUT_TOOLS}

    prohibited_names = {
        "create_handoff_token",
        "validate_handoff",
        "create_handoff_token_node",
    }

    for name in prohibited_names:
        assert name not in all_tool_names, f"{name} should not be in get_tools()"
        assert name not in general_tool_names, f"{name} should not be in _GENERAL_TOOLS"
        assert name not in travel_tool_names, f"{name} should not be in _TRAVEL_TOOLS"
        assert name not in checkout_tool_names, f"{name} should not be in _CHECKOUT_TOOLS"
