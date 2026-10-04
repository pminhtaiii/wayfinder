# User approved on 2026-10-03: lifecycle fixtures and selections use canonical supplierOfferId;
# browser projections continue to reject both internal and legacy provider identity fields.
import asyncio
import inspect
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import pytest
import redis.asyncio as redis
from pydantic import ValidationError

from agent.trusted_search_snapshot import (
    AttestedSearchEnvelope,
    ResolvedOfferSelection,
    SnapshotOwner,
    TrustedSearchResult,
    TrustedSearchSnapshot,
    TrustedSearchSnapshotLifecycle,
    TrustedSnapshotRepository,
    models,
)


class FakeAsyncRedis:
    """Small Redis boundary fake that preserves compare-and-set behavior."""

    def __init__(self) -> None:
        self._clock = 0
        self._store: dict[str, str] = {}
        self._expires_at: dict[str, int] = {}

    def advance(self, seconds: int) -> None:
        self._clock += seconds

    async def get(self, key: str) -> str | None:
        if key in self._expires_at and self._expires_at[key] <= self._clock:
            self._store.pop(key, None)
            self._expires_at.pop(key, None)
        return self._store.get(key)

    async def set(self, key: str, value: str | int, ex: int | None = None) -> bool:
        self._store[key] = str(value)
        if ex is not None:
            self._expires_at[key] = self._clock + int(ex)
        return True

    async def delete(self, *keys: str) -> int:
        deleted = 0
        for key in keys:
            if key in self._store:
                deleted += 1
            self._store.pop(key, None)
            self._expires_at.pop(key, None)
        return deleted

    async def incr(self, key: str) -> int:
        current = await self.get(key)
        value = int(current or "0") + 1
        self._store[key] = str(value)
        return value

    async def eval(self, _script: str, _num_keys: int, *args: Any) -> int:
        """Emulate the repository's issued/accepted-version Lua boundaries."""

        snapshot_key, issued_key, accepted_key, *operation_args = args
        if not all(isinstance(key, str) for key in (snapshot_key, issued_key, accepted_key)):
            raise TypeError("Redis keys must be strings")

        if len(operation_args) == 3:
            payload, incoming_version, ttl = operation_args
            if (
                not isinstance(payload, str)
                or not self._is_positive_integer(incoming_version)
                or not self._is_positive_integer(ttl)
            ):
                return 0

            existing_payload = await self.get(snapshot_key)
            if existing_payload is not None:
                try:
                    existing_version = json.loads(existing_payload)["snapshotVersion"]
                except (KeyError, TypeError, json.JSONDecodeError):
                    return 0
                if (
                    not self._is_positive_integer(existing_version)
                    or incoming_version <= existing_version
                ):
                    return 0
            else:
                existing_version = 0

            issued_version = self._counter_value(await self.get(issued_key))
            accepted_version = self._counter_value(await self.get(accepted_key))
            if issued_version is None or accepted_version is None:
                return 0
            effective_accepted_version = max(existing_version, accepted_version)
            if incoming_version <= effective_accepted_version:
                return 0
            if issued_version > effective_accepted_version:
                if incoming_version != issued_version:
                    return 0

            await self.set(snapshot_key, payload, ex=ttl)
            await self.set(issued_key, incoming_version, ex=ttl)
            await self.set(accepted_key, incoming_version, ex=ttl)
            return 1

        if len(operation_args) == 1:
            (initial_ttl,) = operation_args
            if not self._is_positive_integer(initial_ttl):
                return -4

            snapshot_payload = await self.get(snapshot_key)
            snapshot_version = 0
            counter_ttl = initial_ttl
            if snapshot_payload is not None:
                try:
                    snapshot_version = json.loads(snapshot_payload)["snapshotVersion"]
                except (KeyError, TypeError, json.JSONDecodeError):
                    return -2
                if not self._is_positive_integer(snapshot_version):
                    return -2
                counter_ttl = self._ttl(snapshot_key)
                if counter_ttl <= 0:
                    return -3

            issued_version = self._counter_value(await self.get(issued_key))
            if issued_version is None:
                return -1
            accepted_version = self._counter_value(await self.get(accepted_key))
            if accepted_version is None:
                return -5

            if snapshot_payload is None:
                issued_ttl = self._ttl(issued_key) if issued_version > 0 else 0
                accepted_ttl = self._ttl(accepted_key) if accepted_version > 0 else 0
                if (issued_version > 0 and issued_ttl <= 0) or (
                    accepted_version > 0 and accepted_ttl <= 0
                ):
                    return -3
                if issued_ttl > 0 and accepted_ttl > 0:
                    counter_ttl = min(issued_ttl, accepted_ttl)
                elif issued_ttl > 0:
                    counter_ttl = issued_ttl
                elif accepted_ttl > 0:
                    counter_ttl = accepted_ttl

            next_version = max(snapshot_version, issued_version, accepted_version) + 1
            await self.set(issued_key, next_version, ex=counter_ttl)
            return next_version

        if len(operation_args) == 0:
            snapshot_payload = await self.get(snapshot_key)
            snapshot_version = 0
            tombstone_ttl = 0
            if snapshot_payload is not None:
                try:
                    snapshot_version = json.loads(snapshot_payload)["snapshotVersion"]
                except (KeyError, TypeError, json.JSONDecodeError):
                    snapshot_version = 0
                if self._is_positive_integer(snapshot_version):
                    candidate_ttl = self._ttl(snapshot_key)
                    if candidate_ttl > 0:
                        tombstone_ttl = candidate_ttl
                    else:
                        snapshot_version = 0
                else:
                    snapshot_version = 0

            issued_raw = await self.get(issued_key)
            issued_version = self._counter_value(issued_raw)
            issued_ttl = self._ttl(issued_key) if issued_version and issued_version > 0 else 0
            if issued_raw is not None and (issued_version is None or issued_ttl <= 0):
                await self.delete(issued_key)
                issued_version = 0
                issued_ttl = 0

            accepted_raw = await self.get(accepted_key)
            accepted_version = self._counter_value(accepted_raw)
            accepted_ttl = (
                self._ttl(accepted_key) if accepted_version and accepted_version > 0 else 0
            )
            if accepted_raw is not None and (accepted_version is None or accepted_ttl <= 0):
                await self.delete(accepted_key)
                accepted_version = 0
                accepted_ttl = 0

            issued_ttl = self._ttl(issued_key) if issued_version > 0 else 0
            accepted_ttl = self._ttl(accepted_key) if accepted_version > 0 else 0
            if tombstone_ttl <= 0:
                if issued_ttl > 0 and accepted_ttl > 0:
                    tombstone_ttl = min(issued_ttl, accepted_ttl)
                elif issued_ttl > 0:
                    tombstone_ttl = issued_ttl
                elif accepted_ttl > 0:
                    tombstone_ttl = accepted_ttl

            invalidated_version = max(snapshot_version, issued_version, accepted_version)
            if invalidated_version > 0 and tombstone_ttl > 0:
                await self.set(accepted_key, invalidated_version, ex=tombstone_ttl)
            await self.delete(snapshot_key)
            return 1

        raise TypeError("Unsupported Redis Lua call")

    def _ttl(self, key: str) -> int:
        if key not in self._expires_at:
            return -1
        return self._expires_at[key] - self._clock

    @staticmethod
    def _is_positive_integer(value: object) -> bool:
        return type(value) is int and value > 0

    @staticmethod
    def _counter_value(value: str | None) -> int | None:
        if value is None:
            return 0
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
        if parsed <= 0 or not parsed.is_integer():
            return None
        return int(parsed)


class ProductionLikeLuaRedis(FakeAsyncRedis):
    """Production-shaped Redis double using the same atomic Lua semantics."""

    connection_pool = object()


class ProductionLikeRedisWithoutLua(FakeAsyncRedis):
    """A production-shaped Redis client must fail closed when atomic eval is unavailable."""

    connection_pool = object()
    eval = None


class ProductionLikeRedisWithUnavailableLua(FakeAsyncRedis):
    """A client that exposes eval but cannot execute Lua must also fail closed."""

    connection_pool = object()

    async def eval(self, *args: object) -> int:
        raise NotImplementedError("Lua scripting is unavailable")


class ReloadInterleavingRedis(FakeAsyncRedis):
    """Inject a fresh snapshot immediately after the initial cache miss."""

    def __init__(self, owner: SnapshotOwner, fresh_snapshot: TrustedSearchSnapshot) -> None:
        super().__init__()
        self._snapshot_key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"
        self._version_key = f"{self._snapshot_key}:version"
        self._fresh_snapshot = fresh_snapshot
        self._injected = False
        self.delete_called = False

    async def get(self, key: str) -> str | None:
        if key == self._snapshot_key and not self._injected:
            self._injected = True
            await self.set(self._snapshot_key, self._fresh_snapshot.model_dump_json(), ex=60)
            await self.set(self._version_key, str(self._fresh_snapshot.snapshotVersion), ex=60)
            return None

        return await super().get(key)

    async def delete(self, *keys: str) -> int:
        self.delete_called = True
        return sum([await FakeAsyncRedis.delete(self, key) for key in keys])


def _owner() -> SnapshotOwner:
    return SnapshotOwner(user_id="user-private-123", chat_session_id="session-private-456")


def _results() -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    return [
        {
            "offerIndex": index,
            "flightOfferId": f"flight-internal-{index}",
            "supplierOfferId": f"supplier-private-{index}",
            "airline": "Vietnam Airlines",
            "origin": "SGN",
            "destination": "HAN",
            "departureAt": now + timedelta(hours=index),
            "arrivalAt": now + timedelta(hours=index + 2),
            "price": "120.00",
            "currency": "USD",
        }
        for index in (1, 2)
    ]


def _snapshot_payload(
    owner: SnapshotOwner,
    *,
    version: int = 1,
    expires_at: datetime | None = None,
    created_at: datetime | None = None,
    results: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    exp = expires_at or (now + timedelta(minutes=15))
    if created_at is not None:
        create_time = created_at
    elif exp.tzinfo is not None and exp.utcoffset() == timedelta(0) and exp <= now:
        create_time = exp - timedelta(minutes=15)
    else:
        create_time = now
    return {
        "schemaVersion": 1,
        "snapshotVersion": version,
        "userId": owner.user_id,
        "sessionId": owner.chat_session_id,
        "createdAt": create_time,
        "expiresAt": exp,
        "fingerprint": "fingerprint-private-abc",
        "selectionAttestation": "attestation-private-xyz",
        "results": results or _results(),
    }


def _envelope_payload(*, version: int = 1) -> dict[str, Any]:
    snapshot = _snapshot_payload(_owner(), version=version)
    return {
        "schemaVersion": snapshot["schemaVersion"],
        "snapshotVersion": snapshot["snapshotVersion"],
        "expiresAt": snapshot["expiresAt"],
        "fingerprint": snapshot["fingerprint"],
        "selectionAttestation": snapshot["selectionAttestation"],
        "results": snapshot["results"],
    }


def _envelope(*, version: int = 1) -> AttestedSearchEnvelope:
    return AttestedSearchEnvelope.model_validate(_envelope_payload(version=version))


def _lifecycle(redis: FakeAsyncRedis | None = None) -> TrustedSearchSnapshotLifecycle:
    return TrustedSearchSnapshotLifecycle(TrustedSnapshotRepository(redis or FakeAsyncRedis()))


def test_snapshot_rejects_zero_and_non_contiguous_offer_indexes() -> None:
    owner = _owner()

    zero_indexed = _snapshot_payload(owner, results=[{**_results()[0], "offerIndex": 0}])
    non_contiguous = _snapshot_payload(
        owner,
        results=[_results()[0], {**_results()[1], "offerIndex": 3}],
    )

    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(zero_indexed)
    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(non_contiguous)


def test_snapshot_requires_a_utc_expiry() -> None:
    owner = _owner()
    naive_expiry = datetime.now() + timedelta(minutes=15)
    non_utc_expiry = datetime.now(timezone(timedelta(hours=7))) + timedelta(minutes=15)

    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, expires_at=naive_expiry))
    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, expires_at=non_utc_expiry))


def test_snapshot_and_envelope_reject_boolean_versions_and_offer_indexes() -> None:
    owner = _owner()

    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=True))
    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(
            _snapshot_payload(owner, results=[{**_results()[0], "offerIndex": True}])
        )
    with pytest.raises(ValidationError):
        AttestedSearchEnvelope.model_validate({**_envelope_payload(), "snapshotVersion": True})


def test_attested_envelope_fails_closed_for_invalid_security_and_offer_data() -> None:
    naive_expiry = datetime.now() + timedelta(minutes=15)
    non_utc_expiry = datetime.now(timezone(timedelta(hours=7))) + timedelta(minutes=15)
    invalid_payloads = [
        {**_envelope_payload(), "unexpected": "rejected"},
        {**_envelope_payload(), "fingerprint": ""},
        {**_envelope_payload(), "selectionAttestation": ""},
        {
            **_envelope_payload(),
            "results": [_results()[0], {**_results()[1], "offerIndex": 3}],
        },
        {**_envelope_payload(), "expiresAt": naive_expiry},
        {**_envelope_payload(), "expiresAt": non_utc_expiry},
    ]

    for payload in invalid_payloads:
        with pytest.raises(ValidationError):
            AttestedSearchEnvelope.model_validate(payload)


@pytest.mark.asyncio
async def test_repository_rejects_a_stale_snapshot_after_a_newer_version_is_saved() -> None:
    owner = _owner()
    redis = FakeAsyncRedis()
    repository = TrustedSnapshotRepository(redis)

    assert (
        await repository.save_snapshot(
            TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=1))
        )
        is True
    )
    assert (
        await repository.save_snapshot(
            TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=2))
        )
        is True
    )
    assert (
        await repository.save_snapshot(
            TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=1))
        )
        is False
    )
    assert (
        await repository.save_snapshot(
            TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=2))
        )
        is False
    )

    stored = await repository.get_snapshot(owner.user_id, owner.chat_session_id)
    assert stored is not None
    assert stored.snapshotVersion == 2


@pytest.mark.asyncio
async def test_repository_uses_the_retained_counter_to_reject_lower_or_equal_versions() -> None:
    owner = _owner()
    redis = FakeAsyncRedis()
    repository = TrustedSnapshotRepository(redis)
    snapshot_key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"
    version_key = f"{snapshot_key}:version"
    accepted_key = f"{snapshot_key}:accepted"
    await redis.set(version_key, "5", ex=60)
    await redis.set(accepted_key, "5", ex=60)

    for incoming_version in (4, 5):
        snapshot = TrustedSearchSnapshot.model_validate(
            _snapshot_payload(owner, version=incoming_version)
        )
        assert await repository.save_snapshot(snapshot) is False
        assert await redis.get(snapshot_key) is None


@pytest.mark.asyncio
async def test_deleting_a_snapshot_retains_its_bounded_counter_and_blocks_a_delayed_lower_version() -> (
    None
):
    owner = _owner()
    redis = FakeAsyncRedis()
    repository = TrustedSnapshotRepository(redis)
    snapshot_key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"
    version_key = f"{snapshot_key}:version"
    accepted = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=5))
    delayed = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=4))

    assert await repository.save_snapshot(accepted) is True
    await repository.delete_snapshot(owner.user_id, owner.chat_session_id)

    assert await redis.get(snapshot_key) is None
    assert await redis.get(version_key) == "5"
    assert redis._expires_at[version_key] > redis._clock
    assert await repository.save_snapshot(delayed) is False
    assert await redis.get(snapshot_key) is None


@pytest.mark.asyncio
async def test_lifecycle_delete_recovers_from_corrupt_payload_and_malformed_version_state() -> None:
    owner = _owner()
    redis = FakeAsyncRedis()
    lifecycle = _lifecycle(redis)
    snapshot_key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"
    issued_key = f"{snapshot_key}:version"
    accepted_key = f"{snapshot_key}:accepted"
    await redis.set(snapshot_key, "{corrupt snapshot", ex=60)
    await redis.set(issued_key, "malformed-issued", ex=60)
    await redis.set(accepted_key, "malformed-accepted", ex=60)

    await lifecycle.delete(owner)

    assert await redis.get(snapshot_key) is None
    assert await redis.get(issued_key) != "malformed-issued"
    assert await redis.get(accepted_key) != "malformed-accepted"
    issued_version = await lifecycle.next_version(owner)
    created = await lifecycle.create_or_replace(owner, _envelope(version=issued_version))
    assert created.snapshotVersion == issued_version


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid_version", ["corrupt", 0, 1.5])
async def test_repository_does_not_replace_a_corrupt_or_non_strict_stored_version(
    invalid_version: object,
) -> None:
    owner = _owner()
    redis = ProductionLikeLuaRedis()
    repository = TrustedSnapshotRepository(redis)
    key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"
    raw_stored_snapshot = json.dumps(
        {**_snapshot_payload(owner, version=1), "snapshotVersion": invalid_version}, default=str
    )
    await redis.set(key, raw_stored_snapshot, ex=60)
    incoming = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=2))

    assert await repository.save_snapshot(incoming) is False
    assert await redis.get(key) == raw_stored_snapshot


@pytest.mark.asyncio
async def test_repository_does_not_partially_replace_when_the_version_counter_is_malformed() -> (
    None
):
    owner = _owner()
    redis = ProductionLikeLuaRedis()
    repository = TrustedSnapshotRepository(redis)
    accepted = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=1))
    incoming = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=2))
    snapshot_key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"
    version_key = f"{snapshot_key}:version"

    await redis.set(snapshot_key, accepted.model_dump_json(), ex=60)
    await redis.set(version_key, "not-a-version", ex=60)

    assert await repository.save_snapshot(incoming) is False
    assert await redis.get(snapshot_key) == accepted.model_dump_json()


@pytest.mark.asyncio
async def test_repository_fails_closed_when_a_production_like_redis_client_lacks_eval() -> None:
    owner = _owner()
    redis = ProductionLikeRedisWithoutLua()
    repository = TrustedSnapshotRepository(redis)
    snapshot = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner))
    key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"

    assert await repository.save_snapshot(snapshot) is False
    assert await redis.get(key) is None


@pytest.mark.asyncio
async def test_repository_fails_closed_when_a_client_exposes_but_cannot_execute_lua() -> None:
    owner = _owner()
    redis = ProductionLikeRedisWithUnavailableLua()
    repository = TrustedSnapshotRepository(redis)
    snapshot = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner))
    key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"

    assert await repository.save_snapshot(snapshot) is False
    assert await redis.get(key) is None


@pytest.mark.asyncio
async def test_repository_caps_ttl_and_never_writes_an_expired_snapshot() -> None:
    owner = _owner()
    redis = FakeAsyncRedis()
    repository = TrustedSnapshotRepository(redis)
    key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"
    long_lived = TrustedSearchSnapshot.model_validate(
        _snapshot_payload(
            owner, version=99, expires_at=datetime.now(timezone.utc) + timedelta(minutes=30)
        )
    )
    expired_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    expired = TrustedSearchSnapshot.model_validate(
        _snapshot_payload(
            owner,
            version=100,
            created_at=expired_at - timedelta(minutes=1),
            expires_at=expired_at,
        )
    )

    assert await repository.save_snapshot(long_lived, max_ttl=11) is True
    assert redis._expires_at[key] - redis._clock == 11
    assert await repository.save_snapshot(expired) is False
    stored = await repository.get_snapshot(owner.user_id, owner.chat_session_id)
    assert stored is not None
    assert stored.snapshotVersion == 99


@pytest.mark.asyncio
async def test_repository_rejects_a_positive_float_ttl_cap() -> None:
    owner = _owner()
    redis = FakeAsyncRedis()
    repository = TrustedSnapshotRepository(redis)
    snapshot = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner))
    key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"

    assert await repository.save_snapshot(snapshot, max_ttl=1.5) is False
    assert await redis.get(key) is None


@pytest.mark.asyncio
async def test_load_active_returns_none_after_snapshot_ttl_expires() -> None:
    owner = _owner()
    redis = FakeAsyncRedis()
    lifecycle = _lifecycle(redis)
    snapshot = TrustedSearchSnapshot.model_validate(
        _snapshot_payload(owner, expires_at=datetime.now(timezone.utc) + timedelta(seconds=2))
    )

    await lifecycle.repository.save_snapshot(snapshot, max_ttl=2)
    redis.advance(2)

    assert await lifecycle.load_active(owner) is None


@pytest.mark.asyncio
async def test_load_active_fails_closed_for_a_domain_expired_snapshot() -> None:
    owner = _owner()
    redis = FakeAsyncRedis()
    lifecycle = _lifecycle(redis)
    expired_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    expired = TrustedSearchSnapshot.model_validate(
        _snapshot_payload(
            owner,
            created_at=expired_at - timedelta(minutes=1),
            expires_at=expired_at,
        )
    )
    key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"

    await redis.set(key, expired.model_dump_json())

    assert await lifecycle.load_active(owner) is None


@pytest.mark.asyncio
async def test_cache_miss_cleanup_does_not_delete_a_snapshot_saved_in_the_read_delete_gap() -> None:
    owner = _owner()
    fresh = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=2))
    redis = ReloadInterleavingRedis(owner, fresh)
    lifecycle = _lifecycle(redis)

    assert await lifecycle.load_active(owner) is None

    stored = await lifecycle.repository.get_snapshot(owner.user_id, owner.chat_session_id)
    assert stored == fresh
    assert redis.delete_called is False


@pytest.mark.asyncio
async def test_create_or_replace_persists_an_owner_scoped_snapshot() -> None:
    owner = _owner()
    redis = FakeAsyncRedis()
    lifecycle = _lifecycle(redis)

    created = await lifecycle.create_or_replace(owner, _envelope(version=4))

    assert created.userId == owner.user_id
    assert created.sessionId == owner.chat_session_id
    assert created.snapshotVersion == 4
    assert await lifecycle.load_active(owner) == created


@pytest.mark.asyncio
@pytest.mark.redis_integration
async def test_save_next_snapshot_uses_atomic_owner_fence_on_local_redis() -> None:
    """The allocate-and-save primitive preserves Redis state on a stale batch."""

    redis_url = os.environ.get("AGENT_TEST_REDIS_URL", "redis://127.0.0.1:6379/15")
    client = redis.from_url(redis_url, decode_responses=True)
    owner = SnapshotOwner(
        user_id=f"atomic-test-{uuid4().hex}",
        chat_session_id=f"session-{uuid4().hex}",
    )
    repository = TrustedSnapshotRepository(client)
    snapshot_key = repository._get_key(owner.user_id, owner.chat_session_id)
    version_key = repository._version_key(owner.user_id, owner.chat_session_id)
    accepted_key = repository._accepted_key(owner.user_id, owner.chat_session_id)

    try:
        try:
            await client.ping()
        except Exception:
            pytest.skip("local Redis is unavailable")

        first = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=1))
        assert await repository.save_next_snapshot(first) is True
        assert await repository.get_snapshot(owner.user_id, owner.chat_session_id) == first

        stale = TrustedSearchSnapshot.model_validate(
            _snapshot_payload(
                owner,
                version=1,
                results=[{**_results()[0], "flightOfferId": "stale-flight"}],
            )
        )
        assert await repository.save_next_snapshot(stale) is False
        assert await repository.get_snapshot(owner.user_id, owner.chat_session_id) == first
        assert await client.get(version_key) == "1"
        assert await client.get(accepted_key) == "1"

        second = TrustedSearchSnapshot.model_validate(
            _snapshot_payload(
                owner,
                version=2,
                results=[{**_results()[0], "flightOfferId": "second-flight"}],
            )
        )
        assert await repository.save_next_snapshot(second) is True
        assert await repository.get_snapshot(owner.user_id, owner.chat_session_id) == second
        assert await client.get(snapshot_key)
        assert await client.get(version_key) == "2"
        assert await client.get(accepted_key) == "2"
    finally:
        await client.delete(snapshot_key, version_key, accepted_key)
        await client.aclose()


@pytest.mark.asyncio
async def test_select_resolves_a_valid_one_based_offer_and_rejects_bounds() -> None:
    snapshot = TrustedSearchSnapshot.model_validate(_snapshot_payload(_owner()))
    lifecycle = _lifecycle()

    selection = await lifecycle.select(snapshot, 2)

    assert selection.offerIndex == 2
    assert selection.offer.supplierOfferId == "supplier-private-2"
    with pytest.raises(ValueError):
        await lifecycle.select(snapshot, 0)
    with pytest.raises(ValueError):
        await lifecycle.select(snapshot, 3)
    for invalid_index in (True, 1.0, "1"):
        with pytest.raises(ValueError):
            await lifecycle.select(snapshot, invalid_index)
    expired_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    expired = TrustedSearchSnapshot.model_validate(
        _snapshot_payload(
            _owner(),
            created_at=expired_at - timedelta(minutes=1),
            expires_at=expired_at,
        )
    )
    with pytest.raises(ValueError):
        await lifecycle.select(expired, 1)


def test_resolved_selection_rejects_an_offer_index_that_does_not_match_its_offer() -> None:
    offer = TrustedSearchSnapshot.model_validate(_snapshot_payload(_owner())).results[0]

    with pytest.raises(ValidationError):
        ResolvedOfferSelection(
            offer_index=2,
            offer=offer,
            selection_attestation="attestation-private-xyz",
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=15),
        )


def _assert_projection_is_safe(
    projection: list[dict[str, Any]], *, allowed_keys: set[str], prohibited_values: set[str]
) -> None:
    def visit(value: Any) -> None:
        if isinstance(value, dict):
            assert set(value).issubset(allowed_keys)
            for key, nested_value in value.items():
                assert key not in {
                    "duffelOfferId",
                    "supplierOfferId",
                    "flightOfferId",
                    "selectionAttestation",
                    "fingerprint",
                    "userId",
                    "sessionId",
                }
                visit(nested_value)
        elif isinstance(value, list):
            for nested_value in value:
                visit(nested_value)
        elif isinstance(value, str):
            assert value not in prohibited_values

    visit(projection)


def test_llm_and_browser_projections_allow_only_safe_fields() -> None:
    owner = _owner()
    snapshot = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner))
    lifecycle = _lifecycle()

    llm_projection = [
        result.model_dump(mode="json") for result in lifecycle.project_for_llm(snapshot)
    ]
    browser_projection = [
        result.model_dump(mode="json") for result in lifecycle.project_for_browser(snapshot)
    ]
    prohibited_values = {
        "duffel-private-1",
        "duffel-private-2",
        "flight-internal-1",
        "flight-internal-2",
        "attestation-private-xyz",
        "fingerprint-private-abc",
        owner.user_id,
        owner.chat_session_id,
    }
    llm_allowed_keys = {
        "index",
        "airline",
        "origin",
        "destination",
        "departureAt",
        "arrivalAt",
        "price",
        "currency",
    }
    browser_allowed_keys = llm_allowed_keys

    _assert_projection_is_safe(
        llm_projection, allowed_keys=llm_allowed_keys, prohibited_values=prohibited_values
    )
    _assert_projection_is_safe(
        browser_projection, allowed_keys=browser_allowed_keys, prohibited_values=prohibited_values
    )


def test_normalize_graph_state_replaces_legacy_snapshot_aliases_with_canonical_keys() -> None:
    snapshot = _snapshot_payload(_owner())
    state = {
        "snapshot": snapshot,
        "version": 8,
        "attestation": "attestation-private-xyz",
        "offers": snapshot["results"],
        "unrelated": "preserved",
    }

    normalized = TrustedSearchSnapshotLifecycle.normalize_graph_state(state)

    assert normalized == {
        "trusted_snapshot": snapshot,
        "snapshotVersion": 8,
        "selectionAttestation": "attestation-private-xyz",
        "results": snapshot["results"],
        "unrelated": "preserved",
    }
    assert state["snapshot"] == snapshot


def test_normalize_graph_state_preserves_canonical_precedence_and_nested_aliases() -> None:
    state = {
        "snapshot": {"offers": ["legacy"], "version": 1, "attestation": "legacy"},
        "trusted_snapshot": {"results": ["canonical"], "snapshotVersion": 2},
        "version": 3,
        "snapshotVersion": 4,
        "attestation": "legacy-attestation",
        "selectionAttestation": "canonical-attestation",
        "offers": ["legacy-offer"],
        "results": ["canonical-result"],
    }

    normalized = TrustedSearchSnapshotLifecycle.normalize_graph_state(state)

    assert normalized["trusted_snapshot"] == {
        "results": ["canonical"],
        "snapshotVersion": 2,
    }
    assert normalized["snapshotVersion"] == 4
    assert normalized["selectionAttestation"] == "canonical-attestation"
    assert normalized["results"] == ["canonical-result"]
    assert "snapshot" not in normalized
    assert "version" not in normalized
    assert "attestation" not in normalized
    assert "offers" not in normalized

    nested_aliases = TrustedSearchSnapshotLifecycle.normalize_graph_state(
        {"snapshot": {"offers": ["nested"], "version": 6, "attestation": "nested-attestation"}}
    )
    assert nested_aliases == {
        "trusted_snapshot": {
            "results": ["nested"],
            "snapshotVersion": 6,
            "selectionAttestation": "nested-attestation",
        }
    }


@pytest.mark.asyncio
async def test_next_version_is_monotonic_for_one_owner() -> None:
    lifecycle = _lifecycle()
    owner = _owner()

    assert await lifecycle.next_version(owner) == 1
    assert await lifecycle.next_version(owner) == 2


@pytest.mark.asyncio
async def test_allocated_version_can_be_persisted_once_before_becoming_a_stale_write_fence() -> (
    None
):
    lifecycle = _lifecycle()
    owner = _owner()

    issued_version = await lifecycle.next_version(owner)
    created = await lifecycle.create_or_replace(owner, _envelope(version=issued_version))

    assert created.snapshotVersion == issued_version
    assert await lifecycle.next_version(owner) == issued_version + 1
    with pytest.raises(ValueError):
        await lifecycle.create_or_replace(owner, _envelope(version=issued_version))


@pytest.mark.asyncio
async def test_concurrent_next_version_allocations_are_unique_and_contiguous() -> None:
    lifecycle = _lifecycle()
    owner = _owner()

    allocated = await asyncio.gather(*(lifecycle.next_version(owner) for _ in range(8)))

    assert len(set(allocated)) == 8
    assert sorted(allocated) == list(range(1, 9))


@pytest.mark.asyncio
async def test_legacy_session_without_accepted_key_can_be_replaced_by_newer_snapshot() -> None:
    owner = _owner()
    redis = FakeAsyncRedis()
    repository = TrustedSnapshotRepository(redis)
    lifecycle = TrustedSearchSnapshotLifecycle(repository)

    snapshot_key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"
    version_key = f"{snapshot_key}:version"
    accepted_key = f"{snapshot_key}:accepted"

    # Simulate legacy session state where :accepted key was not used
    legacy_snapshot = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=1))
    await redis.set(snapshot_key, legacy_snapshot.model_dump_json(), ex=3600)
    await redis.set(version_key, "1", ex=3600)
    # Note: accepted_key is explicitly NOT set in Redis

    # Next version should allocate 2
    next_ver = await lifecycle.next_version(owner)
    assert next_ver == 2

    # Should successfully replace the legacy snapshot without being blocked
    created = await lifecycle.create_or_replace(owner, _envelope(version=next_ver))
    assert created.snapshotVersion == 2

    stored = await lifecycle.load_active(owner)
    assert stored is not None
    assert stored.snapshotVersion == 2

    # Both version and accepted keys are now properly set
    assert await redis.get(version_key) == "2"
    assert await redis.get(accepted_key) == "2"


@pytest.mark.asyncio
async def test_legacy_session_direct_save_without_prior_next_version() -> None:
    owner = _owner()
    redis = FakeAsyncRedis()
    repository = TrustedSnapshotRepository(redis)

    snapshot_key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"
    version_key = f"{snapshot_key}:version"

    # Simulate legacy snapshot and version counter without :accepted key
    legacy_snapshot = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=1))
    await redis.set(snapshot_key, legacy_snapshot.model_dump_json(), ex=3600)
    await redis.set(version_key, "1", ex=3600)

    # Directly saving version 2 must succeed and not be blocked by version_key == "1"
    v2_snapshot = TrustedSearchSnapshot.model_validate(_snapshot_payload(owner, version=2))
    assert await repository.save_snapshot(v2_snapshot) is True

    stored = await repository.get_snapshot(owner.user_id, owner.chat_session_id)
    assert stored is not None
    assert stored.snapshotVersion == 2


FORBIDDEN_SCORING_FIELDS = [
    "score",
    "match_level",
    "matchLevel",
    "weights",
    "breakdown",
    "scoring_version",
    "scoringVersion",
]


@pytest.mark.parametrize("field", FORBIDDEN_SCORING_FIELDS)
def test_models_reject_scoring_fields_validation_error(field: str) -> None:
    owner = _owner()
    raw_result = _results()[0]

    with pytest.raises(ValidationError):
        TrustedSearchResult.model_validate({**raw_result, field: 100})

    envelope_data = _envelope_payload()
    with pytest.raises(ValidationError):
        AttestedSearchEnvelope.model_validate({**envelope_data, field: 100})

    snapshot_data = _snapshot_payload(owner)
    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate({**snapshot_data, field: 100})


def test_trusted_search_snapshot_explicitly_enforces_extra_forbid() -> None:
    for model_cls in (
        models.TrustedSearchResult,
        models.AttestedSearchEnvelope,
        models.TrustedSearchSnapshot,
    ):
        src = inspect.getsource(model_cls)
        assert 'extra="forbid"' in src or "extra='forbid'" in src


@pytest.mark.asyncio
async def test_lifecycle_persisted_redis_payload_is_strictly_score_free() -> None:
    owner = _owner()
    redis = FakeAsyncRedis()
    lifecycle = _lifecycle(redis)

    created = await lifecycle.create_or_replace(owner, _envelope(version=1))
    assert created.snapshotVersion == 1

    snapshot_key = f"chat:snapshot:{owner.user_id}:{owner.chat_session_id}"
    raw_payload = await redis.get(snapshot_key)
    assert raw_payload is not None

    # Strict check: none of forbidden score keys/strings exist in raw json
    for field in FORBIDDEN_SCORING_FIELDS:
        assert f'"{field}"' not in raw_payload

    # Strict check: parsed JSON contains zero scoring keys at top level or nested results
    parsed = json.loads(raw_payload)
    for field in FORBIDDEN_SCORING_FIELDS:
        assert field not in parsed
        for result in parsed.get("results", []):
            assert field not in result
