import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.runnables import RunnableConfig

from agent.graph.nodes import create_handoff_token
from agent.tools.search_flights import search_flights
from agent.trusted_search_snapshot import (
    AttestedSearchEnvelope,
    SnapshotOwner,
    TrustedSearchSnapshot,
    TrustedSearchSnapshotLifecycle,
    TrustedSnapshotRepository,
)


class MemoryRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    async def get(self, key: str) -> str | None:
        return self.values.get(key)

    async def set(self, key: str, value: str) -> bool:
        self.values[key] = value
        return True


class SearchGateway:
    def __init__(self, results: list[dict[str, object]]) -> None:
        self.results = results
        self.search_calls = 0

    async def post_gateway_flights_search_v2(
        self,
        *,
        chat_session_id: str,
        proposed_snapshot_version: int,
        origin: str,
        destination: str,
        date: str,
        passengers: int,
    ) -> dict[str, object]:
        self.search_calls += 1
        now = datetime.now(timezone.utc)
        return {
            "snapshotVersion": proposed_snapshot_version,
            "snapshotExpiresAt": (now + timedelta(minutes=15)).isoformat(),
            "selectionAttestation": "sel_v1_search_result",
            "fingerprint": "fingerprint-search-result",
            "results": self.results,
        }


def _owner() -> SnapshotOwner:
    return SnapshotOwner(user_id="user-neutral", chat_session_id="session-neutral")


def _result(identity_field: str, identity: str) -> dict[str, object]:
    now = datetime.now(timezone.utc)
    return {
        "offerIndex": 1,
        "flightOfferId": "flight-uuid-neutral",
        identity_field: identity,
        "airline": "Northwind Air",
        "origin": "SGN",
        "destination": "HAN",
        "departureAt": (now + timedelta(hours=1)).isoformat(),
        "arrivalAt": (now + timedelta(hours=3)).isoformat(),
        "price": "120.00",
        "currency": "USD",
    }


def _snapshot_payload(owner: SnapshotOwner, result: dict[str, object]) -> dict[str, object]:
    now = datetime.now(timezone.utc)
    return {
        "schemaVersion": 1,
        "snapshotVersion": 1,
        "userId": owner.user_id,
        "sessionId": owner.chat_session_id,
        "createdAt": (now - timedelta(minutes=1)).isoformat(),
        "expiresAt": (now + timedelta(minutes=15)).isoformat(),
        "fingerprint": "fingerprint-neutral",
        "selectionAttestation": "sel_v1_neutral",
        "results": [result],
    }


@pytest.mark.asyncio
async def test_redis_rejects_legacy_supplier_identity_and_mixed_aliases() -> None:
    owner = _owner()
    redis = MemoryRedis()
    lifecycle = TrustedSearchSnapshotLifecycle(TrustedSnapshotRepository(redis))
    legacy_payload = _snapshot_payload(owner, _result("duffelOfferId", "duffel-legacy"))
    mixed_result = _result("supplierOfferId", "supplier-neutral")
    mixed_result["duffelOfferId"] = "duffel-legacy"
    mixed_payload = _snapshot_payload(owner, mixed_result)

    await redis.set(
        f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}", json.dumps(legacy_payload)
    )
    assert await lifecycle.load_active(owner) is None

    await redis.set(
        f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}", json.dumps(mixed_payload)
    )
    assert await lifecycle.load_active(owner) is None


@pytest.mark.asyncio
async def test_redis_accepts_a_valid_neutral_snapshot() -> None:
    owner = _owner()
    redis = MemoryRedis()
    lifecycle = TrustedSearchSnapshotLifecycle(TrustedSnapshotRepository(redis))
    payload = _snapshot_payload(owner, _result("supplierOfferId", "supplier-neutral"))
    await redis.set(f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}", json.dumps(payload))

    snapshot = await lifecycle.load_active(owner)

    assert snapshot is not None
    assert snapshot.results[0].supplierOfferId == "supplier-neutral"


@pytest.mark.asyncio
async def test_search_tool_runs_fresh_search_when_legacy_snapshot_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = _owner()
    redis = MemoryRedis()
    lifecycle = TrustedSearchSnapshotLifecycle(TrustedSnapshotRepository(redis))
    legacy_payload = _snapshot_payload(owner, _result("duffelOfferId", "duffel-legacy"))
    await redis.set(
        f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}", json.dumps(legacy_payload)
    )
    assert await lifecycle.load_active(owner) is None

    monkeypatch.setattr("agent.tools.search_flights.get_redis_client", lambda: redis)
    gateway = SearchGateway(
        [
            {
                "flightOfferId": "fresh-flight-uuid",
                "duffelOfferId": "duffel-fresh",
                "airline": "VN",
                "departureAirport": "SGN",
                "arrivalAirport": "HAN",
                "departureTime": "2026-10-10T08:00:00Z",
                "arrivalTime": "2026-10-10T10:00:00Z",
                "price": "120.00",
                "currency": "USD",
            }
        ]
    )
    staging: dict[str, object] = {}
    config = RunnableConfig(
        configurable={
            "nestjs_client": gateway,
            "thread_id": owner.chat_session_id,
            "user_id": owner.user_id,
            "trusted_snapshot": None,
            "_snapshot_staging": staging,
            "_snapshot_stage_key": "search-0",
        }
    )

    narration = await search_flights.ainvoke(
        {"origin": "SGN", "destination": "HAN", "date": "2026-10-10", "passengers": 1},
        config=config,
    )

    assert gateway.search_calls == 1
    assert "Found 1 flights:" in narration
    staged = staging.get("search-0")
    assert isinstance(staged, dict)
    envelope = staged.get("envelope")
    assert isinstance(envelope, AttestedSearchEnvelope)
    assert envelope.results[0].supplierOfferId == "duffel-fresh"


@pytest.mark.asyncio
async def test_search_tool_rejects_gateway_result_without_supplier_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    redis = MemoryRedis()
    monkeypatch.setattr("agent.tools.search_flights.get_redis_client", lambda: redis)
    gateway = SearchGateway(
        [
            {
                "flightOfferId": "flight-uuid-application",
                "airline": "VN",
                "departureAirport": "SGN",
                "arrivalAirport": "HAN",
                "departureTime": "2026-10-10T08:00:00Z",
                "arrivalTime": "2026-10-10T10:00:00Z",
                "price": "120.00",
                "currency": "USD",
            }
        ]
    )
    staging: dict[str, object] = {}
    config = RunnableConfig(
        configurable={
            "nestjs_client": gateway,
            "thread_id": "session-neutral",
            "user_id": "user-neutral",
            "trusted_snapshot": None,
            "_snapshot_staging": staging,
            "_snapshot_stage_key": "search-0",
        }
    )

    narration = await search_flights.ainvoke(
        {"origin": "SGN", "destination": "HAN", "date": "2026-10-10", "passengers": 1},
        config=config,
    )

    assert gateway.search_calls == 1
    assert narration == "I encountered an error preparing your search results. Please try again."
    assert staging == {}


@pytest.mark.asyncio
async def test_search_tool_rejects_unsigned_supplier_identity_alias(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    redis = MemoryRedis()
    monkeypatch.setattr("agent.tools.search_flights.get_redis_client", lambda: redis)
    result = {
        "flightOfferId": "flight-uuid-trusted",
        "duffelOfferId": "duffel-authoritative",
        "supplierOfferId": "supplier-unsigned-override",
        "airline": "VN",
        "departureAirport": "SGN",
        "arrivalAirport": "HAN",
        "departureTime": "2026-10-10T08:00:00Z",
        "arrivalTime": "2026-10-10T10:00:00Z",
        "price": "120.00",
        "currency": "USD",
    }
    gateway = SearchGateway([result])
    staging: dict[str, object] = {}
    config = RunnableConfig(
        configurable={
            "nestjs_client": gateway,
            "thread_id": "session-neutral",
            "user_id": "user-neutral",
            "trusted_snapshot": None,
            "_snapshot_staging": staging,
            "_snapshot_stage_key": "search-0",
        }
    )

    narration = await search_flights.ainvoke(
        {"origin": "SGN", "destination": "HAN", "date": "2026-10-10", "passengers": 1},
        config=config,
    )

    assert gateway.search_calls == 1
    assert "Found 1 flights:" not in narration
    assert staging == {}


def test_neutral_snapshot_keeps_sse_display_projection_unchanged() -> None:
    owner = _owner()
    payload = _snapshot_payload(owner, _result("supplierOfferId", "supplier-private"))
    snapshot = TrustedSearchSnapshot.model_validate(payload)
    lifecycle = TrustedSearchSnapshotLifecycle(TrustedSnapshotRepository(MemoryRedis()))

    projection = [
        result.model_dump(mode="json") for result in lifecycle.project_for_browser(snapshot)
    ]

    # User approved on 2026-10-03: this premature expected-value correction matches Pydantic's
    # established UTC "Z" JSON serialization; the provider-free display-field assertion is exact.
    assert projection == [
        {
            "index": 1,
            "airline": "Northwind Air",
            "origin": "SGN",
            "destination": "HAN",
            "departureAt": snapshot.results[0].departureAt.isoformat().replace("+00:00", "Z"),
            "arrivalAt": snapshot.results[0].arrivalAt.isoformat().replace("+00:00", "Z"),
            "price": "120.00",
            "currency": "USD",
        }
    ]
    assert "supplier-private" not in json.dumps(projection)


@pytest.mark.asyncio
async def test_handoff_token_accepts_neutral_internal_snapshot() -> None:
    now = datetime.now(timezone.utc)
    state = {
        "signal": {"offer_index": 1},
        "trusted_snapshot": {
            "schemaVersion": 1,
            "snapshotVersion": 1,
            "userId": "user-neutral",
            "sessionId": "session-neutral",
            "createdAt": now.isoformat(),
            "expiresAt": (now + timedelta(minutes=15)).isoformat(),
            "fingerprint": "fingerprint-handoff-neutral",
            "selectionAttestation": "sel_v1_handoff_neutral",
            "results": [
                {
                    "offerIndex": 1,
                    "flightOfferId": "flight-handoff-neutral",
                    "supplierOfferId": "supplier-handoff-neutral",
                    "airline": "Northwind Air",
                    "origin": "SGN",
                    "destination": "HAN",
                    "departureAt": now.isoformat(),
                    "arrivalAt": (now + timedelta(hours=2)).isoformat(),
                    "price": "120.00",
                    "currency": "USD",
                }
            ],
        },
    }
    client = AsyncMock()
    client.create_handoff_token.return_value = {
        "handoffToken": "handoff-neutral-token",
        "expiresAt": (now + timedelta(minutes=10)).isoformat(),
    }

    with (
        patch("agent.graph.nodes.get_settings") as get_settings,
        patch("agent.graph.nodes.get_nestjs_client", return_value=client),
    ):
        get_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = True
        result = await create_handoff_token(state, None)

    assert result["action"]["handoffToken"] == "handoff-neutral-token"
    assert result["action"]["display"]["airline"] == "Northwind Air"
    client.create_handoff_token.assert_awaited_once_with(
        attestation="sel_v1_handoff_neutral",
        selected_offer_index=1,
        fingerprint="fingerprint-handoff-neutral",
    )


# User approved restoring this preserved regression draft on 2026-10-03.
@pytest.mark.asyncio
async def test_handoff_token_rejects_legacy_graph_snapshot_before_upstream_call() -> None:
    now = datetime.now(timezone.utc)
    state = {
        "signal": {"offer_index": 1},
        "trusted_snapshot": {
            "version": 1,
            "userId": "user-neutral",
            "sessionId": "session-neutral",
            "createdAt": now.isoformat(),
            "expiresAt": (now + timedelta(minutes=15)).isoformat(),
            "fingerprint": "fingerprint-handoff-legacy",
            "attestation": "sel_v1_handoff_legacy",
            "results": [
                {
                    "offerIndex": 1,
                    "flightOfferId": "flight-handoff-legacy",
                    "duffelOfferId": "duffel-handoff-legacy",
                    "airline": "Northwind Air",
                    "origin": "SGN",
                    "destination": "HAN",
                    "departureAt": now.isoformat(),
                    "arrivalAt": (now + timedelta(hours=2)).isoformat(),
                    "price": "120.00",
                    "currency": "USD",
                }
            ],
        },
    }
    client = AsyncMock()
    client.create_handoff_token.return_value = {"handoffToken": "must-not-be-created"}

    with (
        patch("agent.graph.nodes.get_settings") as get_settings,
        patch("agent.graph.nodes.get_nestjs_client", return_value=client),
    ):
        get_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = True
        result = await create_handoff_token(state, None)

    assert result == {"action": {"error": "Invalid state for handoff creation."}}
    client.create_handoff_token.assert_not_awaited()


@pytest.mark.parametrize("supplier_offer_id", [123, {"unexpected": "value"}])
@pytest.mark.asyncio
async def test_handoff_token_rejects_non_string_supplier_identity_before_upstream_call(
    supplier_offer_id: object,
) -> None:
    now = datetime.now(timezone.utc)
    state = {
        "signal": {"offer_index": 1},
        "trusted_snapshot": {
            "schemaVersion": 1,
            "snapshotVersion": 1,
            "userId": "user-neutral",
            "sessionId": "session-neutral",
            "createdAt": now.isoformat(),
            "expiresAt": (now + timedelta(minutes=15)).isoformat(),
            "fingerprint": "fingerprint-handoff-invalid-type",
            "selectionAttestation": "sel_v1_handoff_invalid_type",
            "results": [
                {
                    "offerIndex": 1,
                    "flightOfferId": "flight-handoff-application",
                    "supplierOfferId": supplier_offer_id,
                    "airline": "Northwind Air",
                    "origin": "SGN",
                    "destination": "HAN",
                    "departureAt": now.isoformat(),
                    "arrivalAt": (now + timedelta(hours=2)).isoformat(),
                    "price": "120.00",
                    "currency": "USD",
                }
            ],
        },
    }
    client = AsyncMock()
    client.create_handoff_token.return_value = {
        "handoffToken": "must-not-be-created",
        "expiresAt": (now + timedelta(minutes=10)).isoformat(),
    }

    with (
        patch("agent.graph.nodes.get_settings") as get_settings,
        patch("agent.graph.nodes.get_nestjs_client", return_value=client),
    ):
        get_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = True
        result = await create_handoff_token(state, None)

    assert result == {"action": {"error": "Invalid state for handoff creation."}}
    client.create_handoff_token.assert_not_awaited()
