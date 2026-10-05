import datetime
import os
import uuid

import pytest
import redis.asyncio as redis
from pydantic import ValidationError

from agent.trusted_search_snapshot import (
    TrustedSearchSnapshot,
    TrustedSnapshotRepository,
)


# User approved on 2026-10-03: Redis sample snapshots use the canonical supplierOfferId field.
@pytest.fixture
async def redis_client():
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    client = redis.Redis.from_url(redis_url, decode_responses=True)
    try:
        await client.ping()
        yield client
    except (redis.ConnectionError, OSError):
        pytest.skip("Redis is not available")
    finally:
        await client.aclose()


@pytest.fixture
def sample_snapshot_dict():
    return {
        "schemaVersion": 1,
        "snapshotVersion": 1,
        "userId": str(uuid.uuid4()),
        "sessionId": str(uuid.uuid4()),
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "expiresAt": (
            datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=15)
        ).isoformat(),
        "fingerprint": "mock_hmac_fingerprint",
        "selectionAttestation": "signed_opaque_string_from_nestjs",
        "results": [
            {
                "offerIndex": 1,
                "flightOfferId": str(uuid.uuid4()),
                "supplierOfferId": "off_12345",
                "airline": "British Airways",
                "origin": "LHR",
                "destination": "JFK",
                "departureAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "arrivalAt": (
                    datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=8)
                ).isoformat(),
                "price": "500.00",
                "currency": "GBP",
            }
        ],
    }


def test_trusted_search_snapshot_schema_valid(sample_snapshot_dict):
    """Test that a valid schema parses successfully."""
    snapshot = TrustedSearchSnapshot.model_validate(sample_snapshot_dict)
    assert snapshot.schemaVersion == 1
    assert snapshot.snapshotVersion == 1
    assert len(snapshot.results) == 1
    assert snapshot.results[0].offerIndex == 1


def test_trusted_search_snapshot_schema_invalid_version(sample_snapshot_dict):
    """Test that schema version other than 1 is rejected."""
    sample_snapshot_dict["schemaVersion"] = 2
    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(sample_snapshot_dict)


def test_trusted_search_snapshot_schema_forbidden_fields(sample_snapshot_dict):
    """Test that unknown/forbidden fields are rejected."""
    sample_snapshot_dict["unknownField"] = "bad_data"
    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(sample_snapshot_dict)


def test_trusted_search_snapshot_schema_forbidden_result_fields(sample_snapshot_dict):
    """Test that results with forbidden fields (e.g. payment info) are rejected."""
    sample_snapshot_dict["results"][0]["paymentData"] = "card_123"
    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(sample_snapshot_dict)


def test_trusted_search_snapshot_schema_results_bounds(sample_snapshot_dict):
    """Test that results list must be between 1 and 5 items."""
    original = sample_snapshot_dict["results"][0]
    sample_snapshot_dict["results"] = []
    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(sample_snapshot_dict)

    sample_snapshot_dict["results"] = [original.copy() for _ in range(6)]
    for i, r in enumerate(sample_snapshot_dict["results"]):
        r["offerIndex"] = i + 1
    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(sample_snapshot_dict)


def test_trusted_search_snapshot_schema_results_indexes(sample_snapshot_dict):
    """Test that result indexes must be unique and contiguous from 1."""
    # Start from 2
    sample_snapshot_dict["results"][0]["offerIndex"] = 2
    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(sample_snapshot_dict)

    # Non-contiguous
    result2 = sample_snapshot_dict["results"][0].copy()
    result2["offerIndex"] = 3
    sample_snapshot_dict["results"][0]["offerIndex"] = 1
    sample_snapshot_dict["results"].append(result2)
    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(sample_snapshot_dict)


@pytest.mark.asyncio
async def test_trusted_snapshot_repository_replace_and_load(redis_client, sample_snapshot_dict):
    """Test atomic replace and load with correct owner/session."""
    repo = TrustedSnapshotRepository(redis_client)
    snapshot = TrustedSearchSnapshot.model_validate(sample_snapshot_dict)

    # Save
    await repo.save_snapshot(snapshot)

    # Load with correct owner/session
    loaded = await repo.get_snapshot(str(snapshot.userId), str(snapshot.sessionId))
    assert loaded is not None
    assert loaded.snapshotVersion == 1

    # Load with wrong owner
    loaded_wrong_owner = await repo.get_snapshot(str(uuid.uuid4()), str(snapshot.sessionId))
    assert loaded_wrong_owner is None

    # Load with wrong session
    loaded_wrong_session = await repo.get_snapshot(str(snapshot.userId), str(uuid.uuid4()))
    assert loaded_wrong_session is None


@pytest.mark.asyncio
async def test_trusted_snapshot_repository_overwrite(redis_client, sample_snapshot_dict):
    """Test atomic overwrite replaces the old snapshot entirely."""
    repo = TrustedSnapshotRepository(redis_client)
    snapshot1 = TrustedSearchSnapshot.model_validate(sample_snapshot_dict)
    await repo.save_snapshot(snapshot1)

    sample_snapshot_dict["snapshotVersion"] = 2
    snapshot2 = TrustedSearchSnapshot.model_validate(sample_snapshot_dict)
    await repo.save_snapshot(snapshot2)

    loaded = await repo.get_snapshot(str(snapshot1.userId), str(snapshot1.sessionId))
    assert loaded is not None
    assert loaded.snapshotVersion == 2


@pytest.mark.asyncio
async def test_trusted_snapshot_repository_ttl(redis_client, sample_snapshot_dict):
    """Test that snapshot is saved with the correct TTL based on expiresAt."""
    repo = TrustedSnapshotRepository(redis_client)

    now = datetime.datetime.now(datetime.timezone.utc)
    expires = now + datetime.timedelta(seconds=100)

    sample_snapshot_dict["createdAt"] = now.isoformat()
    sample_snapshot_dict["expiresAt"] = expires.isoformat()
    snapshot = TrustedSearchSnapshot.model_validate(sample_snapshot_dict)

    await repo.save_snapshot(snapshot)

    key = repo._get_key(str(snapshot.userId), str(snapshot.sessionId))
    ttl = await redis_client.ttl(key)

    assert 90 < ttl <= 100


@pytest.mark.asyncio
async def test_trusted_snapshot_repository_delete(redis_client, sample_snapshot_dict):
    """Test atomic delete."""
    repo = TrustedSnapshotRepository(redis_client)
    snapshot = TrustedSearchSnapshot.model_validate(sample_snapshot_dict)

    await repo.save_snapshot(snapshot)

    loaded_before = await repo.get_snapshot(str(snapshot.userId), str(snapshot.sessionId))
    assert loaded_before is not None

    await repo.delete_snapshot(str(snapshot.userId), str(snapshot.sessionId))

    loaded_after = await repo.get_snapshot(str(snapshot.userId), str(snapshot.sessionId))
    assert loaded_after is None
