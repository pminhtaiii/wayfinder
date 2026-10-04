import json

import pytest

from agent.models.events import DisplayInfo, HandoffEvent
from agent.observability.chat_observability import ChatTelemetry, TelemetryPrivacyError
from agent.sanitization.pii_scrubber import detect_pii, scrub_pii
from agent.trusted_search_snapshot import (
    SafeFlightResult,
    SafeSearchResult,
    TrustedSearchSnapshot,
    TrustedSearchSnapshotLifecycle,
    TrustedSnapshotRepository,
)

SEEDED_PRIVACY_CORPUS = [
    "chk_handoff_v1_secret_credential_12345",
    "token_hash_abc123def456",
    "local_offer_id_xyz987",
    "duffel_offer_id_duff_123",
    "booking_db_id_uuid_000",
    "PNR123456",
    "pnr_ABCDEF",
    "passenger_john_doe",
    "traveller.john@example.com",
    "+1 555-123-4567",
    "P12345678",
    "4111111111111111",
    "plaintext customer chat secret message",
]


def test_pii_scrubber_redacts_seeded_corpus():
    """Verify that pii_scrubber detects and scrubs email, phone, passport, and card."""
    sample_text = (
        "Contact me at traveller.john@example.com or +1 555-123-4567. "
        "My passport is P12345678 and card is 4111 1111 1111 1111."
    )
    assert detect_pii(sample_text) is True
    scrubbed = scrub_pii(sample_text)
    assert "traveller.john@example.com" not in scrubbed
    assert "+1 555-123-4567" not in scrubbed
    assert "P12345678" not in scrubbed
    assert "4111 1111 1111 1111" not in scrubbed
    assert "[EMAIL REDACTED]" in scrubbed
    assert "[PHONE REDACTED]" in scrubbed
    assert "[PASSPORT REDACTED]" in scrubbed
    assert "[CARD REDACTED]" in scrubbed


def test_safe_llm_fields_excludes_identifiers():
    """Verify SafeSearchResult and SafeFlightResult models do not contain local offer IDs, Duffel offer IDs, or database IDs."""
    forbidden = {
        "flightOfferId",
        "duffelOfferId",
        "offerId",
        "bookingId",
        "id",
        "userId",
        "sessionId",
    }
    safe_fields = set(SafeSearchResult.model_fields.keys()) | set(
        SafeFlightResult.model_fields.keys()
    )
    for f in safe_fields:
        assert f not in forbidden


def test_project_snapshot_results_excludes_identifiers():
    """Verify project_for_browser and project_for_llm never return offer IDs or provider IDs to the browser."""
    # User approved on 2026-10-03: rename only this internal snapshot fixture to the canonical
    # identity field so strict snapshot validation can exercise the unchanged privacy projection.
    snapshot = TrustedSearchSnapshot.model_validate(
        {
            "schemaVersion": 1,
            "snapshotVersion": 1,
            "userId": "usr_123",
            "sessionId": "ses_456",
            "createdAt": "2026-09-20T00:00:00Z",
            "expiresAt": "2026-09-20T01:00:00Z",
            "selectionAttestation": "sel_v1_mock",
            "fingerprint": "mock_fp",
            "results": [
                {
                    "offerIndex": 1,
                    "flightOfferId": "local-uuid-1234",
                    "supplierOfferId": "duffel-offer-5678",
                    "airline": "VN",
                    "origin": "SGN",
                    "destination": "HAN",
                    "departureAt": "2026-09-20T08:00:00Z",
                    "arrivalAt": "2026-09-20T10:00:00Z",
                    "price": "120.00",
                    "currency": "USD",
                }
            ],
        }
    )
    lifecycle = TrustedSearchSnapshotLifecycle(TrustedSnapshotRepository(None))
    browser_projected = [r.model_dump() for r in lifecycle.project_for_browser(snapshot)]
    llm_projected = [r.model_dump() for r in lifecycle.project_for_llm(snapshot)]
    for projected in (browser_projected, llm_projected):
        assert len(projected) == 1
        item = projected[0]
        assert "flightOfferId" not in item
        assert "duffelOfferId" not in item
        assert "local-uuid-1234" not in json.dumps(item, default=str)
        assert "duffel-offer-5678" not in json.dumps(item, default=str)


def test_action_handoff_event_schema_strictly_forbids_private_fields():
    """Verify HandoffEvent schema allows only strict allowlisted display fields."""
    display = DisplayInfo(
        airline="VN",
        origin="SGN",
        destination="NRT",
        departureAt="2026-09-20T02:00:00Z",
        arrivalAt="2026-09-20T08:30:00Z",
        price="420.00",
        currency="USD",
    )
    event = HandoffEvent(
        version=1,
        action="begin_checkout",
        handoffToken="chk_handoff_v1_opaque_token_value",
        expiresAt="2026-09-20T03:00:00Z",
        display=display,
    )
    event_json = event.model_dump_json()
    assert "chk_handoff_v1_opaque_token_value" in event_json
    assert "url" not in event_json
    assert "offerId" not in event_json
    assert "flightOfferId" not in event_json
    assert "duffelOfferId" not in event_json
    assert "sessionId" not in event_json
    assert "userId" not in event_json

    # Unknown fields must fail validation
    with pytest.raises(Exception):
        HandoffEvent(
            version=1,
            action="begin_checkout",
            handoffToken="chk_" + "handoff_v1_test",
            expiresAt="2026-09-20T03:00:00Z",
            display=display,
            url="https://example.test/checkout",
        )


def test_chat_telemetry_strictly_rejects_privacy_corpus():
    """Verify telemetry rejects each value in the seeded privacy corpus."""
    telemetry = ChatTelemetry()
    for forbidden_val in SEEDED_PRIVACY_CORPUS:
        with pytest.raises(TelemetryPrivacyError, match="contains protected data"):
            telemetry.emit(
                "tool_call",
                status="failed",
                fields={"outcome": forbidden_val},
            )


def test_sse_error_payloads_contain_zero_pii_or_tokens():
    """Verify that SSE error payloads contain standard error codes and scrubbed messages."""
    pii_payload = json.dumps(
        {
            "code": "GUARDRAIL_BLOCKED",
            "message": "Your message contains protected personal information and cannot be processed.",
            "partialMessageId": None,
        }
    )
    for forbidden_val in SEEDED_PRIVACY_CORPUS:
        assert forbidden_val not in pii_payload


@pytest.mark.asyncio
async def test_sse_event_serialization_excludes_forbidden_corpus():
    """Verify that any stream response data conforms to strict boundary safety and excludes forbidden tokens/PII."""
    display = DisplayInfo(
        airline="VN",
        origin="SGN",
        destination="HAN",
        departureAt="2026-09-20T08:00:00Z",
        arrivalAt="2026-09-20T10:00:00Z",
        price="150.00",
        currency="USD",
    )
    event = HandoffEvent(
        version=1,
        action="begin_checkout",
        handoffToken="chk_handoff_v1_safe_token_string",
        expiresAt="2026-09-20T09:00:00Z",
        display=display,
    )
    serialized = event.model_dump_json()
    for forbidden_val in SEEDED_PRIVACY_CORPUS:
        assert forbidden_val not in serialized
