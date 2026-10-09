# API Contract: Traveler Profile & Booking Readiness

All endpoints are authenticated. Examples intentionally omit personal-data values.

## Profile

### `GET /api/profile`

Returns the caller's single profile and section completion. Full editable values are available only from this protected profile endpoint; logs and audits must not record the body.

```json
{
  "profileId": "uuid",
  "identity": {
    "givenName": "...",
    "middleName": null,
    "familyName": "...",
    "dateOfBirth": "YYYY-MM-DD",
    "gender": "...",
    "title": "..."
  },
  "contact": { "email": "...", "phoneCountryCode": "...", "phoneNumber": "..." },
  "travelDocument": {
    "documentType": "passport",
    "passportNumber": "...",
    "passportExpiry": "YYYY-MM-DD",
    "issuingCountry": "XX",
    "nationality": "XX"
  },
  "preferences": { "seatPreference": null, "classPreference": null },
  "revision": 3,
  "updatedAt": "ISO-8601"
}
```

If no row exists, return `200` with `profileId: null` and empty sections so the form can create it.

### `PATCH /api/profile`

Accepts `expectedRevision` plus one or more complete sections. When `travelDocument` is present it must contain all five fields or be `null` to clear the section atomically. The service conditionally updates the owned row at that revision and increments it. Returns the same shape as `GET`.

Errors: `400 PROFILE_VALIDATION_FAILED`, `401 UNAUTHORIZED`, `409 PROFILE_UPDATE_CONFLICT`.

Both profile endpoints return `Cache-Control: no-store, private`, omit ETags, use only the authenticated user's ID in the ownership query, and exclude request/response bodies from logs and traces. Validation errors contain field names/codes only. Browser mutations use the existing bearer-JWT/CORS boundary and reject disallowed origins.

## Advisory readiness

### `POST /api/bookings/intents/readiness`

```json
{
  "flightOfferId": "uuid",
  "passengers": [
    {
      "offerPassengerId": "pas_001",
      "passengerType": "ADULT",
      "source": { "type": "traveler_profile", "travelerProfileId": "uuid" }
    }
  ]
}
```

Inline sources use the same field groups as the profile inside `source`. The endpoint resolves every segment and airport country server-side and performs no persistence.

```json
{
  "scope": "INTERNATIONAL",
  "ready": false,
  "passengers": [
    {
      "passengerType": "ADULT",
      "passengerOrdinal": 1,
      "ready": false,
      "profileRevision": 3,
      "sections": [
        {
          "name": "travel_document",
          "fields": [
            {
              "name": "passportExpiry",
              "status": "warning",
              "reason": "PASSPORT_VALIDITY_REQUIRES_VERIFICATION",
              "blocking": false
            },
            {
              "name": "issuingCountry",
              "status": "missing",
              "reason": "REQUIRED",
              "blocking": true
            }
          ]
        }
      ]
    }
  ]
}
```

Errors: `404 OFFER_NOT_FOUND`, `409 OFFER_EXPIRED`, `422 PASSENGER_MAPPING_INVALID`, `503 READINESS_DEPENDENCY_UNAVAILABLE`. Missing airport-country reference data is not a `503`: it returns `200` with `scope: UNKNOWN`, `ready: false`, and blocking reason `AIRPORT_COUNTRY_UNAVAILABLE` in the normal readiness shape.

## Authoritative intent creation

### `POST /api/bookings/intents`

Uses the same request passenger-source shape. Each `traveler_profile` source also supplies the `expectedProfileRevision` returned by readiness. It refreshes the existing priced offer according to current intent behavior, re-runs the evaluator authoritatively, and creates all snapshots atomically only on success.

- Success: existing intent response plus masked passenger summaries and `preFilledFromProfile` provenance.
- Blocking readiness: `422 BOOKING_NOT_READY` with the same safe result structure; zero writes.
- Unknown airport country: `422 BOOKING_NOT_READY` containing the same `scope: UNKNOWN` result returned advisorially.
- Changed profile revision: `409 PROFILE_CHANGED`; zero writes.
- `useProfile` and `source` together: `400 PASSENGER_SOURCE_CONFLICT`.

Existing `/api/bookings/intent` routes remain deprecated aliases during this feature. First-party callers must use plural routes. Aliases preserve the same auth, validation, service, and safe response behavior after the staged client migration.

### Legacy `useProfile` compatibility

During the compatibility window, only the singular `POST /api/bookings/intent` alias accepts legacy passenger payloads containing `useProfile` without `source`:

- `useProfile: true` on the primary adult is translated server-side to `source: { "type": "traveler_profile" }`, resolved to the authenticated user's owned profile, and snapshotted with the current profile revision. The profile is never selected by a caller-supplied foreign profile ID.
- `useProfile: false` or an omitted flag is translated to `source: { "type": "inline" }` using the existing inline passenger fields.
- A legacy `useProfile: true` on a non-primary passenger is rejected with `400 LEGACY_PROFILE_SOURCE_UNSUPPORTED` rather than silently ignored; multi-passenger callers must migrate to the per-passenger `source` union.
- A payload containing both `useProfile` and `source` is rejected with `400 PASSENGER_SOURCE_CONFLICT`.
- Canonical plural endpoints reject `useProfile` and require the discriminated `source` union. First-party callers migrate before the singular alias is removed.

### `GET /api/bookings/intents/:id`

Returns owned intent data with document/contact summaries only. It MUST NOT return decrypted passport number, passport expiry ciphertext/plaintext, email, or phone number. A secure profile correction always reads `/api/profile`, not this snapshot endpoint.

### Route/response migration matrix

| Concern             | Canonical                           | Compatibility behavior                                                                                                                 |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Advisory readiness  | `POST /bookings/intents/readiness`  | New-only; feature-flagged                                                                                                              |
| Create intent       | `POST /bookings/intents`            | Singular POST alias calls the same service during the observation window                                                               |
| Read intent         | `GET /bookings/intents/:id`         | Web migrates to masked summary first; singular GET then returns the identical safe shape and may retain legacy passport keys as `null` |
| Prefill             | Secure `GET /profile` + readiness   | Singular `/bookings/intent/prefill` remains temporarily for disabled legacy checkout, with deprecation telemetry                       |
| Ancillaries/payment | Existing intent-scoped routes       | Paths unchanged; only their internal passenger DTO use is regression-tested                                                            |
| Agent               | `/agent-gateway/bookings/readiness` | No legacy alias                                                                                                                        |

## Agent-gateway projection

### `POST /api/agent-gateway/bookings/readiness`

Protected by the existing agent API-key and claim-token guards. The caller supplies the offer plus passenger type/ordinal/source kind; the gateway resolves the caller's owned primary profile internally.

Response allowlist:

```json
{
  "scope": "INTERNATIONAL",
  "ready": false,
  "passengers": [
    {
      "passengerType": "ADULT",
      "passengerOrdinal": 1,
      "sections": [
        {
          "name": "travel_document",
          "fields": [{ "name": "passportExpiry", "status": "missing", "reason": "REQUIRED" }]
        }
      ]
    }
  ],
  "nextAction": "COMPLETE_PROFILE"
}
```

No profile ID, name, birth date, contact value, document value, or masked fragment is allowed in this response.

## SSE action-required event

```text
event: ACTION_REQUIRED
data: {"action":"COMPLETE_PROFILE","scope":"INTERNATIONAL","passengers":[{"passengerType":"ADULT","passengerOrdinal":1,"sections":[{"name":"travel_document","fields":[{"name":"passportExpiry","status":"missing","reason":"REQUIRED"}]}]}],"target":"/profile"}
```

The Python event schema is an allowlist. Unexpected/value-bearing keys fail closed and emit a generic safe error. Inline or multi-passenger cases use `target: "/checkout/passengers"`.

## Final order boundary

No new public endpoint is required. The existing payment/order idempotency claim is the single-owner boundary. The owner freezes/re-reads the expected intent and snapshot versions, authenticates and decrypts bound fields inside the trusted final routine, validates completeness/expiry using the current clock, builds an ephemeral supplier DTO, and calls `DuffelService.createOrder()` with the existing stable idempotency key. Plaintext is neither returned nor logged. Lease loss, AAD failure, expiry at the boundary, concurrent submission, and unknown supplier outcomes use the existing replay/recovery path and cannot produce an unowned second call.
