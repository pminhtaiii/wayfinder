# Feature Specification: Traveler Profile & Booking Readiness

**Feature Branch**: `016a-traveler-profile-booking-readiness`

**Created**: 2026-08-01

**Status**: Draft for review

**Input**: Accepted traveler-profile and booking-readiness decisions in `docs/adr/0035-traveler-profile-booking-readiness.md` and canonical vocabulary in `CONTEXT.md`.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Maintain a Booking-Ready Profile (Priority: P1)

As an authenticated traveler, I can review and update the identity, contact, travel-document, and preference information reused during booking so I do not repeatedly enter it.

**Why this priority**: A complete, secure profile is the foundation for every later readiness and booking flow.

**Independent Test**: Save a profile, reload it, and verify every field can be reviewed or corrected while sensitive values are protected outside the secure profile experience.

**Acceptance Scenarios**:

1. **Given** an authenticated traveler with no complete profile, **When** they save valid identity and contact details, **Then** those details are available for future booking-readiness checks.
2. **Given** a traveler with stored travel-document data, **When** they reopen the profile, **Then** they can verify or replace the document without its full sensitive value appearing outside the secure form.
3. **Given** invalid or partial input, **When** the traveler saves, **Then** the affected fields are rejected with field-specific guidance and unchanged valid data is preserved.

---

### User Story 2 - Check Readiness Before Booking (Priority: P2)

As a traveler, I can see whether a selected itinerary has enough passenger information before creating a booking intent, including missing, invalid, warning, and unknown statuses.

**Why this priority**: Proactive guidance avoids a failed first booking attempt and makes domestic and international requirements explicit.

**Independent Test**: Evaluate prepared domestic and international itineraries against complete, incomplete, expired, and near-expiry profiles and verify the expected scope and field statuses.

**Acceptance Scenarios**:

1. **Given** a wholly domestic itinerary, **When** readiness is checked, **Then** identity and contact fields are evaluated and travel-document fields are not required.
2. **Given** an itinerary with any cross-border segment, **When** readiness is checked, **Then** identity, contact, and the full travel-document section are evaluated.
3. **Given** a passport that expires before the trip ends, **When** readiness is checked, **Then** booking is blocked and the travel-document section is invalid.
4. **Given** a passport that expires within the configured advisory period after the trip, **When** readiness is checked, **Then** the traveler receives a warning without being blocked.

---

### User Story 3 - Create an Intent From Explicit Passenger Sources (Priority: P3)

As a traveler, I can create a booking intent whose passengers explicitly use either a saved traveler profile or inline checkout details, and the reviewed passenger data remains stable afterward.

**Why this priority**: Explicit per-passenger sources support current multi-passenger checkout and future companion profiles without ambiguous merging.

**Independent Test**: Create intents from saved-profile and inline sources, modify the original profile afterward, and verify each intent retains the passenger data originally confirmed.

**Acceptance Scenarios**:

1. **Given** a ready saved profile, **When** it is selected as a passenger source, **Then** intent creation succeeds and captures a complete passenger snapshot.
2. **Given** complete inline passenger details, **When** inline is selected, **Then** intent creation succeeds without reading unrelated profile values.
3. **Given** any source is incomplete or invalid for the itinerary, **When** intent creation is attempted, **Then** the same readiness rules reject it and no partial intent or passenger snapshot is created.
4. **Given** a created intent, **When** the source profile is later changed, **Then** the intent retains the previously reviewed passenger information.

---

### User Story 4 - Complete Readiness From Chat Without Sharing PII (Priority: P4)

As a traveler booking through chat, I receive a secure handoff when profile information is missing and can resume booking after correcting it without sharing personal data in chat.

**Why this priority**: Chat is a convenient booking initiator, but it must remain outside the personal-data and transactional trust boundary.

**Independent Test**: Start an incomplete-profile chat booking and verify chat events contain only passenger position/type plus field names and statuses, the secure form performs the edit, and readiness can then be retried.

**Acceptance Scenarios**:

1. **Given** a profile is not ready, **When** chat checks a selected offer, **Then** the response identifies only passenger type, ordinal, field names, and completion statuses.
2. **Given** action is required, **When** the traveler follows the handoff, **Then** all profile fields can be reviewed and corrected in an authenticated form outside chat.
3. **Given** an inline or multi-passenger flow, **When** chat reaches passenger data collection, **Then** the traveler is redirected to checkout rather than asked for personal data in chat.
4. **Given** profile correction succeeds, **When** readiness is retried, **Then** chat may initiate deterministic intent creation and redirect to checkout.

---

### User Story 5 - Enforce Final Passenger Safety (Priority: P5)

As a traveler, I am protected from booking with stale, corrupt, expired, or incomplete passenger data at the final order commitment.

**Why this priority**: Advisory readiness cannot guarantee later validity; the transactional boundary must make the final deterministic decision.

**Independent Test**: Advance time or corrupt a prepared snapshot before order commitment and verify the order is blocked before supplier submission while a valid unchanged snapshot succeeds.

**Acceptance Scenarios**:

1. **Given** an offer or required document expires after intent creation, **When** order creation begins, **Then** the order is blocked before supplier submission.
2. **Given** the passenger snapshot fails integrity or completeness checks, **When** order creation begins, **Then** no supplier order is created and the failure is auditable without personal data in logs.
3. **Given** a valid offer and complete snapshot, **When** order creation begins, **Then** only the trusted deterministic booking path can access the full values required by the supplier.

### Edge Cases

- `middleName` is absent; it never blocks domestic or international readiness.
- One segment in a multi-segment itinerary crosses a border; the whole itinerary is international.
- Airport country data is unavailable; scope cannot be safely determined and readiness does not claim success.
- One field in the travel-document section is missing or invalid; the document is treated as incomplete rather than combined with stale values.
- The advisory-period setting is absent or invalid; the documented default is used.
- A traveler updates a profile concurrently with intent creation; the intent contains one internally consistent snapshot.
- The requested profile does not belong to the authenticated user; no profile data is revealed or used.
- Repeated readiness requests have no persistence or supplier-booking side effects.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST let an authenticated traveler create, view, and update one owned traveler profile.
- **FR-002**: The profile MUST support identity fields (`givenName`, optional `middleName`, `familyName`, `dateOfBirth`, `gender`, `title`), contact fields (`email`, `phoneCountryCode`, `phoneNumber`), travel-document fields (`documentType`, `passportNumber`, `passportExpiry`, `issuingCountry`, `nationality`), and existing travel preferences.
- **FR-003**: Profile reads, writes, validation errors, audit records, and logs MUST protect personal data; full values may be returned only to the authenticated secure profile experience when needed for correction.
- **FR-004**: Readiness scope MUST be `INTERNATIONAL` when any itinerary segment crosses a country border; otherwise it MUST be `DOMESTIC`.
- **FR-005**: Domestic readiness MUST require `givenName`, `familyName`, `dateOfBirth`, `gender`, `title`, `email`, `phoneCountryCode`, and `phoneNumber`.
- **FR-006**: International readiness MUST require all domestic fields plus `documentType`, `passportNumber`, `passportExpiry`, `issuingCountry`, and `nationality`.
- **FR-007**: `middleName` MUST remain optional for every scope.
- **FR-008**: A shared deterministic readiness rule set MUST produce overall scope/readiness and section-level field statuses without causing booking or profile mutations.
- **FR-009**: Missing required fields, unsupported document types, and passports expiring before trip completion MUST block readiness.
- **FR-010**: A passport expiring within `PASSPORT_ADVISORY_BUFFER_DAYS` after trip completion MUST produce `PASSPORT_VALIDITY_REQUIRES_VERIFICATION` without blocking; the default buffer MUST be 180 days.
- **FR-011**: Destination-specific entry eligibility MUST be represented as unknown when it cannot be authoritatively determined and MUST NOT be presented as guaranteed.
- **FR-012**: Every intent passenger MUST declare exactly one source: an owned traveler profile reference or complete inline passenger data.
- **FR-013**: Intent creation MUST re-run the same readiness rules authoritatively and MUST create no intent or passenger snapshot when any passenger fails a blocking rule.
- **FR-014**: Successful intent creation MUST capture every supplier-bound identity, contact, and required travel-document value as one immutable passenger snapshot.
- **FR-015**: The travel-document section MUST be evaluated and snapshotted as one unit; invalidation MUST require replacing/revalidating the full section rather than mixing stale and current values.
- **FR-016**: Sensitive snapshot values MUST remain protected at rest and MUST be exposed in full only inside the trusted deterministic booking path immediately before supplier submission.
- **FR-017**: Editing or deleting a source profile after intent creation MUST NOT change the passenger snapshot.
- **FR-018**: Final order creation MUST revalidate offer expiry, snapshot integrity/completeness, and document expiry before supplier submission.
- **FR-019**: Chat and streaming events MUST NOT carry names, birth dates, contact values, document values, or other personal-data values.
- **FR-020**: Chat readiness results MUST identify passengers only by passenger type and ordinal and may include only field names, section names, statuses, and non-sensitive reason codes.
- **FR-021**: Chat MUST hand inline and multi-passenger personal-data entry to authenticated checkout rather than collect it conversationally.
- **FR-022**: Profile updates, intent creation outcomes, and final validation failures MUST be auditable without recording personal-data values.

### Key Entities

- **Traveler Profile**: One authenticated traveler's reusable identity, contact, document, and preference information.
- **Readiness Result**: Advisory or authoritative evaluation containing scope, overall readiness, sections, field statuses, and safe reason codes.
- **Passenger Source**: The per-passenger declaration selecting either an owned saved profile or inline checkout data.
- **Passenger Snapshot**: The immutable, protected copy of supplier-bound passenger information attached to a booking intent.
- **Booking Intent**: The priced, time-bounded booking state that owns ordered passenger snapshots and continues into checkout.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A traveler with valid data can save and later review a complete profile in one authenticated flow without re-entering unchanged fields.
- **SC-002**: Readiness classifies all domestic, international, missing-field, expired-document, and near-expiry reference scenarios with 100% agreement with the rules in this specification.
- **SC-003**: Every rejected authoritative readiness attempt creates zero booking intents and zero passenger snapshots.
- **SC-004**: In concurrency tests, 100% of created intents retain exactly the passenger values reviewed at creation even when the source profile changes immediately afterward.
- **SC-005**: Automated privacy checks find zero personal-data values in chat payloads, streaming events, structured logs, and audit metadata.
- **SC-006**: Every invalid or expired final snapshot is blocked before supplier order submission, while every valid reference scenario reaches the existing checkout path.
- **SC-007**: A traveler correcting an incomplete profile from chat can return to a ready state and continue to checkout without entering any personal data into chat.

## Assumptions

- Existing authentication, airport-country data, offer storage, checkout, encryption, audit, and deterministic supplier-order services remain available.
- The canonical readiness field lists in `CONTEXT.md` resolve counting inconsistencies in the ADR: domestic identity has five required fields because `middleName` is optional, and international readiness requires the complete five-field travel-document section.
- The travel-document section uses passport data for this feature; additional document types may be accepted only when already supported by the supplier contract.
- Destination-specific immigration eligibility, frequent-flyer data, known-traveler/redress numbers, and companion-profile management are deferred.
- The current traveler's saved profile may be used in single- or multi-passenger intents, but creating and managing additional companion profiles is out of scope.
- This feature introduces no new third-party dependency.
