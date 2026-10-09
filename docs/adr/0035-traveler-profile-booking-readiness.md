# Traveler Profile & Booking Readiness Architecture

We need a persistent traveler identity layer so users don't re-enter passport, contact, and identity data on every booking — especially when booking through the chatbot. The existing `TravelerProfile` model stores preferences, an encrypted `passportNumber`, and a legacy plaintext `passportExpiry` date, but is missing 10 of the 13 Duffel-required passenger fields. This ADR records every design decision made during the grilling session.

## Status

Accepted — 2026-07-28

## Considered Options & Decisions

### 1. Schema: 10 new nullable fields on `TravelerProfile`

Additive migration, all `String?` / `DateTime?`, no breaking changes.

| Section             | New Fields                                                                | Existing (no change)                                                                               |
| ------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Identity**        | `givenName`, `middleName`, `familyName`, `dateOfBirth`, `gender`, `title` | —                                                                                                  |
| **Contact**         | `email`, `phoneCountryCode`, `phoneNumber`                                | —                                                                                                  |
| **Travel Document** | `documentType`, `issuingCountry`                                          | `passportNumber` ✅, `passportExpiry` ✅, `nationality` ✅                                         |
| **Preferences**     | —                                                                         | `seatPreference`, `classPreference`, `preferredAirlines`, `blacklistedAirlines`, `dietaryNeeds` ✅ |

- `middleName` remains optional, never required by validation.
- `email` on the profile is the traveler contact email (can differ from login email).
- `passportExpiry` kept its existing name (not renamed to `passportExpiresOn`) — the existing plaintext date column already has production data.

**Rejected:** Renaming `passportExpiry` to align with Duffel's `expires_on` — risky for encrypted data, and domain model should use its own ubiquitous language.

**Deferred:** Tier 2 fields (frequent flyer, KTN, redress number) — different validation/privacy requirements. Companion travelers — separate follow-up feature; `BookingIntentPassenger.travelerProfileId` already supports referencing any profile without schema changes.

---

### 2. Passenger Source: discriminated union per passenger

Intent creation payload uses a `source` union on each passenger:

```json
{
  "passengers": [
    { "offerPassengerId": "pas_001", "source": { "type": "traveler_profile", "travelerProfileId": "tp_456" } },
    { "offerPassengerId": "pas_002", "source": { "type": "inline", "givenName": "...", ... } }
  ]
}
```

**Rejected:** `useProfile: true` flag — doesn't scale to multi-passenger bookings where each passenger may come from a different source.

**Consequence:** Companion travelers will be another `travelerProfileId` in the array, not a new mechanism.

---

### 3. Passenger Snapshot: full snapshot at intent creation, passport as atomic unit

All Duffel-bound fields (identity, contact, AND passport document group) are snapshotted into `BookingIntentPassenger` at intent creation time. Sensitive fields are encrypted at rest using the existing `EncryptionService` (AES-256-GCM). Decryption happens only inside the trusted booking service just before `DuffelService.createOrder()`.

**Key principle:** The passport document group (number, issuing country, expiry) is treated as **one atomic unit**. If the passport expires, the entire group is invalidated and re-collected — not split across snapshot and live-reference halves.

**Rejected (Hybrid approach):** Snapshotting identity but resolving passport live from profile at order time — splits the document group across two data sources, making expiry validation inconsistent.

**Rejected (Full live-reference):** Storing only `travelerProfileId` and resolving everything at order time — profile edits between review and payment silently change what's sent to Duffel, violating the "review what you confirmed" principle.

---

### 4. Three-layer validation with shared evaluator

| Layer                               | Endpoint                               | Behavior                                                          |
| ----------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| **Readiness (advisory)**            | `POST /api/bookings/intents/readiness` | Proactive check. Returns field statuses. Not a guarantee.         |
| **Intent creation (authoritative)** | `POST /api/bookings/intents`           | Same evaluator, hard rejection. Creates snapshot only on success. |
| **Order creation (final)**          | Internal `BookingIntentService`        | Offer expiry, snapshot integrity, document checks before Duffel.  |

Both readiness and intent creation use the same `BookingReadinessEvaluator` — a shared, pure validation unit. The evaluator takes `{ profile, offerSegments, airportCountries }` and returns `{ scope, ready, sections[] }`.

**Rejected:** Letting intent creation report missing fields as the primary UX — a failed POST before every first international booking is wasteful and a bad UX pattern.

---

### 5. Readiness Scopes: DOMESTIC vs INTERNATIONAL

Determined by the offer's segments — if any segment crosses a country border (origin/destination airport country codes differ), the scope is `INTERNATIONAL`.

| Scope             | Required                                                    | Not Required                          |
| ----------------- | ----------------------------------------------------------- | ------------------------------------- |
| **DOMESTIC**      | Identity (6 fields) + Contact (3 fields) = 8 fields         | Travel document section not evaluated |
| **INTERNATIONAL** | Identity + Contact + Travel Document (5 fields) = 13 fields | `middleName` always optional          |

**Key distinction:** Route scope determines field requirements. Duffel offer requirements determine whether documents must be submitted. Immigration-entry eligibility requires destination-specific travel rules — not inferred from scope alone.

---

### 6. Document Validation Model: hard / advisory / deferred

| Tier         | Behavior                                                                              | Blocks booking?                                                                       |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Hard**     | Passport expired before trip ends, missing required fields, unsupported document type | Yes — `status: "invalid"`                                                             |
| **Advisory** | Passport expires within `PASSPORT_ADVISORY_BUFFER_DAYS` (default 180) after trip      | Warning only — `status: "warning"`, reason: `PASSPORT_VALIDITY_REQUIRES_VERIFICATION` |
| **Deferred** | Destination-specific validity rules (Timatic integration)                             | Not built — `status: "unknown"`                                                       |

**Rejected:** Universal 180-day hard blocker — passport validity rules vary by destination, nationality, transit route. Only clearly expired/unusable documents are blocked.

---

### 7. PII trust boundary

PII never flows through SSE or the chatbot agent:

- **SSE `ACTION_REQUIRED` events** carry only field names and completion statuses (`filled` / `missing` / `invalid` / `warning`), never values.
- **The form shows ALL fields** (filled and missing) so the user can verify and correct existing data. Actual values are fetched via authenticated `GET /api/profile` (HTTPS), not from the SSE event.
- **The agent gateway readiness tool** returns per-passenger readiness with `passengerType` + `passengerOrdinal` identifiers — no names, no DOB, no passport numbers.
- **For inline passengers** in multi-passenger bookings, the chatbot redirects to the checkout form — it never collects PII for non-profile passengers in chat.
- **The existing PII defense stack** (`pii_scrubber.py` → `output_pipeline.py` → NeMo guardrails) catches any accidental leakage as a final safety net.

**Rejected:** Letting the chatbot collect non-sensitive fields (name, DOB) in chat while directing only passport to a form — even names are PII, and the boundary is cleaner when the chatbot is a booking initiator, not a PII collector.

---

### 8. Module boundaries

| Module                           | Owns                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`profile/`** (NEW)             | `TravelerProfile` CRUD, PII encryption/masking, `GET/PATCH /api/profile` endpoints. Does not know about offers or bookings.                                                            |
| **`booking-intent/`** (EXISTING) | `BookingReadinessEvaluator`, `POST /api/bookings/intents/readiness`, the `source` union resolution logic, passenger snapshot creation. Imports `ProfileService` and `AirportsService`. |
| **`agent-gateway/`** (EXISTING)  | New `check_booking_readiness` tool that proxies to `BookingReadinessEvaluator` with PII stripping. `getUserPreferences` unchanged.                                                     |
| **`common/`** (EXISTING)         | `EncryptionService` — shared by both `profile/` and `booking-intent/`.                                                                                                                 |

**Rejected:** Putting the evaluator in `profile/` — the evaluator's primary concerns (offer segments, passenger mapping, airport country lookup) belong to the booking context, not the profile context.

**Rejected:** Standalone `booking-readiness/` module — adds a module for what is effectively a single pure function. Not worth the structural overhead.

---

### 9. Chatbot booking flow

```
User: "Book me SGN → NRT next Friday"
    → Agent searches flights, returns offers
User: "Book the first one"
    → Agent calls check_booking_readiness(offerId, passengers)
    → Returns: { scope: INTERNATIONAL, ready: false, missing: [travel_document] }
    → Agent emits ACTION_REQUIRED SSE event (field names + statuses only)
    → Chat widget renders form card → "Complete Profile" button
    → Opens secure profile form (HTTPS, not chat)
    → User fills passport → PATCH /api/profile
    → Agent retries readiness → ready: true
    → Agent calls POST /api/bookings/intents (profile source)
    → Intent created with full encrypted snapshot
    → User redirected to /checkout/[intentId]/ancillaries
```

For multi-passenger bookings or inline passengers, the chatbot redirects to the checkout passengers page entirely.
