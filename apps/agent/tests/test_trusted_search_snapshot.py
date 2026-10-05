import json
from datetime import datetime, timedelta, timezone

import pytest
from langchain_core.runnables import RunnableConfig

from agent.tools.search_flights import search_flights
from agent.trusted_search_snapshot import (
    SnapshotOwner,
    TrustedSearchSnapshotLifecycle,
    TrustedSnapshotRepository,
)


class MemoryRedis:
    def __init__(self) -> None:
        self._values: dict[str, str] = {}

    async def get(self, key: str) -> str | None:
        return self._values.get(key)

    async def set(self, key: str, value: str) -> bool:
        self._values[key] = value
        return True


class FreshSearchGateway:
    def __init__(self) -> None:
        self.search_calls: list[tuple[str, int, str, str, str, int]] = []

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
        self.search_calls.append(
            (chat_session_id, proposed_snapshot_version, origin, destination, date, passengers)
        )
        now = datetime.now(timezone.utc)
        return {
            "snapshotVersion": proposed_snapshot_version,
            "snapshotExpiresAt": (now + timedelta(minutes=15)).isoformat(),
            "selectionAttestation": "sel_v1_fresh",
            "fingerprint": "fingerprint-fresh-029",
            "results": [
                {
                    "flightOfferId": "fresh-fo-029",
                    # User approved on 2026-10-03: preserve distinct application and supplier IDs.
                    "duffelOfferId": "duffel-fresh-029",
                    "airline": "VN",
                    "origin": origin,
                    "destination": destination,
                    "departureTime": (now + timedelta(hours=1)).isoformat(),
                    "arrivalTime": (now + timedelta(hours=3)).isoformat(),
                    "duration": 120,
                    "stops": 0,
                    "price": "120.00",
                    "currency": "USD",
                }
            ],
        }


def _owner() -> SnapshotOwner:
    return SnapshotOwner(user_id="user-029", chat_session_id="session-029")


# User approved on 2026-10-03: canonical snapshot fixtures use supplierOfferId; gateway wire
# results continue to exercise the legacy duffelOfferId contract.
def _valid_result(now: datetime) -> dict[str, str | int]:
    return {
        "offerIndex": 1,
        "flightOfferId": "fo-029",
        "supplierOfferId": "supplier-029",
        "airline": "Northwind Air",
        "origin": "SGN",
        "destination": "HAN",
        "departureAt": (now + timedelta(hours=1)).isoformat(),
        "arrivalAt": (now + timedelta(hours=3)).isoformat(),
        "price": "120.00",
        "currency": "USD",
    }


def _snapshot_payload(
    owner: SnapshotOwner, now: datetime, expires_at: datetime
) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "snapshotVersion": 1,
        "userId": owner.user_id,
        "sessionId": owner.chat_session_id,
        "createdAt": (now - timedelta(minutes=1)).isoformat(),
        "expiresAt": expires_at.isoformat(),
        "fingerprint": "fingerprint-029",
        "selectionAttestation": "sel_v1_signed",
        "results": [_valid_result(now)],
    }


@pytest.mark.asyncio
async def test_legacy_supplier_snapshot_fails_closed() -> None:
    owner = _owner()
    redis = MemoryRedis()
    lifecycle = TrustedSearchSnapshotLifecycle(TrustedSnapshotRepository(redis))
    now = datetime.now(timezone.utc)
    payload = _snapshot_payload(owner, now, now + timedelta(minutes=15))
    result = _valid_result(now)
    result.pop("supplierOfferId")
    result["duffelOfferId"] = "duffel-029"
    payload["results"] = [result]

    await redis.set(f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}", json.dumps(payload))

    assert await lifecycle.load_active(owner) is None


@pytest.mark.asyncio
async def test_expired_legacy_snapshot_fails_closed() -> None:
    owner = _owner()
    redis = MemoryRedis()
    lifecycle = TrustedSearchSnapshotLifecycle(TrustedSnapshotRepository(redis))
    now = datetime.now(timezone.utc)
    payload = _snapshot_payload(owner, now, now - timedelta(seconds=1))

    await redis.set(f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}", json.dumps(payload))

    assert await lifecycle.load_active(owner) is None


@pytest.mark.asyncio
async def test_valid_neutral_snapshot_remains_available() -> None:
    owner = _owner()
    redis = MemoryRedis()
    lifecycle = TrustedSearchSnapshotLifecycle(TrustedSnapshotRepository(redis))
    now = datetime.now(timezone.utc)
    payload = _snapshot_payload(owner, now, now + timedelta(minutes=15))

    await redis.set(f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}", json.dumps(payload))

    snapshot = await lifecycle.load_active(owner)

    assert snapshot is not None
    assert snapshot.results[0].flightOfferId == "fo-029"
    assert snapshot.results[0].supplierOfferId == "supplier-029"


@pytest.mark.asyncio
async def test_search_tool_executes_gateway_search_after_invalid_snapshot_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = _owner()
    redis = MemoryRedis()
    lifecycle = TrustedSearchSnapshotLifecycle(TrustedSnapshotRepository(redis))
    now = datetime.now(timezone.utc)
    payload = _snapshot_payload(owner, now, now + timedelta(minutes=15))
    result = _valid_result(now)
    result.pop("supplierOfferId")
    result["duffelOfferId"] = "duffel-029"
    payload["results"] = [result]
    await redis.set(f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}", json.dumps(payload))
    assert await lifecycle.load_active(owner) is None

    monkeypatch.setattr("agent.tools.search_flights.get_redis_client", lambda: redis)
    gateway = FreshSearchGateway()
    config = RunnableConfig(
        configurable={
            "nestjs_client": gateway,
            "thread_id": owner.chat_session_id,
            "user_id": owner.user_id,
            "trusted_snapshot": None,
            "_snapshot_staging": {},
            "_snapshot_stage_key": "search-0",
        }
    )

    narration = await search_flights.ainvoke(
        {"origin": "SGN", "destination": "HAN", "date": "2026-10-10", "passengers": 1},
        config=config,
    )

    assert gateway.search_calls == [("session-029", 1, "SGN", "HAN", "2026-10-10", 1)]
    assert "Found 1 flights:" in narration
    assert "1. Vietnam Airlines" in narration
    assert "SGN → HAN" in narration
