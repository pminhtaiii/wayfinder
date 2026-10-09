# Feature Specification: Disruption & Flight-Change Management

**Feature Branch**: `014a-disruption-grilling-decisions`

**Created**: 2026-07-24

**Status**: Planned

**Input**: Prior session context in `CONTEXT.md` and `docs/adr/0021-disruption-flight-change.md`, expanded into an implementation-ready PRD.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Reliably synchronize supplier changes (Priority: P1)

As a traveller, I receive the latest supplier-authoritative itinerary after an airline-initiated change, even when Duffel retries or a webhook is missed.

**Why this priority**: Every downstream disruption decision depends on reliable, deduplicated ingestion and a fresh authoritative supplier read.

**Independent Test**: Deliver a signed change webhook, run the inbox processor, and verify one changed itinerary revision is stored and visible; replay the webhook and verify no duplicate revision is created.

**Acceptance Scenarios**:

1. **Given** a valid signed supported Duffel event, **When** it reaches the public endpoint, **Then** it is durably recorded before a successful acknowledgement and no Duffel read occurs in the request.
2. **Given** the same event is delivered more than once, **When** every delivery is verified, **Then** every delivery receives success and only one inbox record is eligible for processing.
3. **Given** a valid event was missed, **When** an eligible booking enters a reconciliation run, **Then** the same supplier synchronization command fetches and persists the change.
4. **Given** a round-trip booking whose outbound has departed but return has not, **When** reconciliation runs, **Then** the booking remains eligible based on its next unflown segment.

---

### User Story 2 - Detect and preserve material disruptions (Priority: P1)

As a traveller, I am alerted when an itinerary change is structurally unsafe or crosses the approved time thresholds, including cumulative drift built from multiple small changes.

**Why this priority**: Reliable ingestion without accurate deterministic materiality would either hide important changes or create alert fatigue.

**Independent Test**: Process table-driven supplier itineraries and verify immutable revisions, structured diffs, exact material reasons, revision-scoped state, and atomic outbox behavior.

**Acceptance Scenarios**:

1. **Given** a supplier itinerary identical to the current canonical itinerary, **When** synchronization succeeds, **Then** coverage time advances without a new revision or outbox row.
2. **Given** a genuine minor change, **When** it is synchronized, **Then** a non-material revision is stored and no notification request is created.
3. **Given** two individually minor changes whose original-to-current cumulative drift crosses a threshold, **When** the second change is synchronized, **Then** it is material and records the cumulative baseline as a trigger.
4. **Given** concurrent webhook and reconciliation triggers for the same change, **When** both run, **Then** exactly one revision/version and at most one outbox row commit.
5. **Given** a new material revision after acknowledgement or resolution, **When** it commits, **Then** the active revision changes, status returns to `DETECTED`, and prior resolution metadata is cleared.

---

### User Story 3 - Review and act on the active disruption (Priority: P1)

As a booking owner, I can see the current itinerary and its history, acknowledge that I understand the active disruption, and locally accept the active itinerary.

**Why this priority**: This is the customer outcome of the feature and prevents a correct backend from remaining operationally invisible.

**Independent Test**: Seed an active material revision, open booking detail, verify current versus original information, acknowledge, accept, and confirm the audited state transitions without an external supplier call.

**Acceptance Scenarios**:

1. **Given** a changed booking, **When** its owner opens booking detail, **Then** the page shows the latest revision as current and retains the original itinerary only for comparison.
2. **Given** an active detected revision, **When** its owner acknowledges that exact revision, **Then** status becomes `ACKNOWLEDGED` and the action is audited.
3. **Given** the active detected or acknowledged revision, **When** its owner accepts that exact revision, **Then** status becomes `RESOLVED` with `TRAVELLER_ACCEPTED` and no Duffel mutation occurs.
4. **Given** a newer material revision arrived before a submitted action, **When** the stale action is processed, **Then** it returns conflict with the canonical active revision and leaves state unchanged.
5. **Given** a booking owner requests history, **When** the response is returned, **Then** it is newest-first, paginated, local-only, and excludes raw supplier payload and passenger PII.

---

### User Story 4 - Preserve cancellation correctness (Priority: P1)

As a traveller, I can continue to cancel under existing rules, and cancellation safely closes any active disruption without allowing a racing synchronization to reopen it.

**Why this priority**: Cancellation already handles real supplier and payment state; disruption handling must not weaken its guarantees.

**Independent Test**: Race supplier synchronization with the existing cancellation flow and verify supplier-confirmed cancellation wins, the disruption resolves atomically, and no post-cancellation revision/outbox commits.

**Acceptance Scenarios**:

1. **Given** an active disruption and an eligible cancellation, **When** Duffel confirms cancellation, **Then** the same atomic booking transition resolves the disruption as `BOOKING_CANCELLED`.
2. **Given** synchronization fetched while cancellation was in flight, **When** synchronization reaches its final transaction after cancellation, **Then** it commits no revision, no outbox row, and no detected state.
3. **Given** a disruption, **When** cancellation eligibility is evaluated, **Then** existing fare deadline and refund rules are unchanged.

---

### User Story 5 - Recover failures and operate the feature (Priority: P2)

As an operations agent, I can identify and act on failed supplier events, throttled bookings, aged disruptions, and legacy data gaps using PII-safe diagnostics.

**Why this priority**: Supplier events and background work can fail after the customer request ends; production safety requires an explicit operational path.

**Independent Test**: Exhaust retries for an event, exceed the notification cap, and seed a data-quality gap; verify ADMIN-only monitoring, retry/manual resolution, audit events, metrics, and alerts.

**Acceptance Scenarios**:

1. **Given** a transient processor failure, **When** attempts remain, **Then** the event receives the deterministic next retry time and can be reclaimed after a crashed lease.
2. **Given** the fifth processing failure, **When** it is recorded, **Then** the event enters `FAILED_NEEDS_ATTENTION` and is visible/alerted to operations.
3. **Given** a fourth material revision in one UTC day, **When** it commits, **Then** its outbox write is suppressed, its revision/status still commit, and an independent operations-attention flag is set.
4. **Given** a non-admin caller, **When** they request disruption operations endpoints, **Then** access is denied.
5. **Given** an admin manually resolves an active revision, **When** the command succeeds, **Then** the admin identity, safe note, reason, revision, timestamp, and correlation ID are audited.

---

### User Story 6 - Roll out safely to existing bookings (Priority: P2)

As a product owner, I can introduce ingestion and customer surfacing in controlled stages without sending accidental historical notifications or losing queued events on rollback.

**Why this priority**: Existing bookings have legacy JSON without supplier segment IDs and may already differ from Duffel.

**Independent Test**: Deploy against representative legacy data with customer flags disabled, run bootstrap, inspect the report/revisions, then enable and disable each processing surface without deleting durable state.

**Acceptance Scenarios**:

1. **Given** an eligible legacy booking with a valid order and snapshot, **When** bootstrap runs with notifications disabled, **Then** genuine differences are stored but create no traveller delivery request.
2. **Given** a legacy booking lacks synchronization prerequisites, **When** bootstrap runs, **Then** the booking appears in a data-quality report and no unsafe supplier request is attempted.
3. **Given** the processor or reconciliation flag is disabled, **When** the application runs, **Then** no new background supplier work begins and existing inbox/revision data remains recoverable.

### Edge Cases

- Missing/invalid Duffel signature, stale signature timestamp, malformed payload, unsupported event type, and a verified duplicate.
- Event object missing an order ID, order ID not mapped to a booking, or duplicate booking mappings prevented by the database.
- Supplier returns not-found/cancelled while the platform cancellation state differs.
- Legacy original snapshot lacks segment IDs; ambiguous same-route same-day flights; inserted/removed connections; many-to-one candidates.
- Exactly 60 minutes earlier, exactly 120 minutes later, exact 60-minute connection, DST transition, airport-local date rollover, overnight connection, and negative/overlapping connection time.
- Round trip and multi-slice itinerary where outbound and return segments must not be compared as one connection chain.
- Unchanged fingerprint, concurrent triggers, stale synchronization lease, expired worker clearing a successor lock, and unique-version collision containing a genuinely newer payload.
- Non-material revision while a material revision is active; material revision after resolution; stale action after a new material revision.
- Cancellation wins during supplier fetch; supplier-cancelled order caused by the platform versus an airline cancellation.
- First, second, third, and fourth material outbox decisions across a UTC-day boundary.
- More than 20 eligible reconciliation candidates, repeated failures at the front of the priority order, API budget exhaustion, and multiple scheduler instances.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST verify Duffel webhook signatures using raw request bytes, constant-time comparison, configured secret, and timestamp replay tolerance before persistence.
- **FR-002**: The webhook endpoint MUST durably insert a verified supported event before returning success and MUST perform no supplier synchronization inline.
- **FR-003**: Duplicate verified deliveries MUST return success and MUST NOT create more than one processable inbox record.
- **FR-004**: The inbox MUST support `PENDING`, `PROCESSING`, `RETRY_SCHEDULED`, `PROCESSED`, `SKIPPED`, and `FAILED_NEEDS_ATTENTION` with atomic claim leases and stale-claim recovery.
- **FR-005**: The processor MUST retry transient failures after 1, 5, 15, and 15 minutes and escalate the fifth failed attempt.
- **FR-006**: Webhook and reconciliation triggers MUST call the same idempotent supplier synchronization command.
- **FR-007**: Synchronization MUST fetch the current Duffel order and MUST NOT use the webhook payload as itinerary authority.
- **FR-008**: Synchronization MUST use an owned expiring claim and MUST conditionally release only the claim it acquired.
- **FR-009**: Synchronization MUST recheck booking eligibility inside the final write transaction and MUST write no revision/outbox/disruption state after supplier-confirmed cancellation.
- **FR-010**: The original booking snapshot MUST remain immutable and new snapshot extraction MUST retain optional Duffel segment IDs.
- **FR-011**: A canonical fingerprint MUST prevent revisions for an unchanged itinerary while still recording successful synchronization coverage.
- **FR-012**: Every changed itinerary MUST create an immutable versioned revision and normalized ordered segment records.
- **FR-013**: Each revision MUST record structured incremental/cumulative diffs, match method/confidence, source/event correlation, fingerprint, material reasons/baselines, and ruleset version.
- **FR-014**: Segment matching MUST be deterministic, one-to-one, confidence-based, and MUST classify unresolved ambiguity as removed/added.
- **FR-015**: Materiality MUST be true when either incremental or cumulative comparison crosses any approved binary or threshold rule.
- **FR-016**: Time thresholds MUST be strict: more than 60 minutes earlier and more than 120 minutes later; final-arrival rules apply per journey/slice.
- **FR-017**: Connections below 60 minutes, newly introduced overnight connections, segment additions/removals, airport changes, and local-date changes MUST be material.
- **FR-018**: A material revision MUST set the active revision and `DETECTED`; a new material revision MUST clear earlier resolution metadata; a non-material revision MUST NOT replace an unresolved active revision.
- **FR-019**: A material revision, disruption transition, and eligible notification outbox row MUST commit atomically.
- **FR-020**: The daily outbox cap MUST be three per booking per UTC day; the third MUST carry a stabilization flag; fourth and later writes MUST be suppressed and flag operations attention without suppressing revision/status persistence.
- **FR-021**: Traveller acknowledge and accept commands MUST require ownership and the active revision ID, be idempotent for the same revision, and reject stale revisions with conflict.
- **FR-022**: Accepting a revision MUST be a local `TRAVELLER_ACCEPTED` resolution and MUST NOT call Duffel.
- **FR-023**: Supplier-confirmed cancellation MUST atomically resolve the active disruption as `BOOKING_CANCELLED` while preserving all existing cancellation deadlines and economics.
- **FR-024**: The booking detail read model MUST return the current itinerary, original/cumulative comparison, and active disruption summary using only local data.
- **FR-025**: Disruption history MUST be owner-scoped, newest-first, paginated, and exclude raw supplier data and PII.
- **FR-026**: Reconciliation MUST run every 30 minutes, process at most 20 eligible records per run, cover the next unflown segment within 72 hours, use fair stable ordering, and respect Duffel budget controls.
- **FR-027**: Admin APIs MUST require ADMIN role and expose failed events, attention-flagged/aged disruptions, retry, and audited manual resolution with a required safe note.
- **FR-028**: Raw webhook payload MUST never be logged or exposed, MUST be access-restricted, and MUST be deleted/redacted after 30 days.
- **FR-029**: The system MUST emit PII-safe structured logs, trace/correlation IDs, metrics, health/heartbeat signals, dashboards, and alerts required by the constitution for every critical stage.
- **FR-030**: Ingestion, processing, reconciliation, customer surfacing, and outbox creation MUST be independently feature-flagged.
- **FR-031**: Bootstrap MUST report unsynchronizable legacy bookings and MUST suppress customer notification/outbox behavior until explicitly enabled.
- **FR-032**: Departure/completion processing MUST use the current itinerary’s final arrival/next unflown segment so return-leg monitoring does not end after outbound departure.
- **FR-033**: Implementation MUST verify and, where absent, restore the protected booking-detail/list data-access foundation and Playwright configuration before disruption UI work; it MUST NOT rely on documentation-only frontend files.
- **FR-034**: Booking/disruption page reads MUST be uncached server reads; mutation completion MUST refresh canonical state, and Feature 14 MUST NOT add an SSE/WebSocket dependency.

### Key Entities

- **Booking disruption state**: Orthogonal current lifecycle, active material revision, owned sync lease, synchronization coverage, current/final itinerary timing, resolution audit metadata, and independent operations-attention metadata.
- **Itinerary Revision**: Immutable supplier-authoritative changed itinerary with version, fingerprint, structured diffs, material classification, and trigger correlation.
- **Itinerary Revision Segment**: Ordered normalized segment used for matching, current-itinerary reads, and history.
- **Duffel Webhook Event**: Durable verified inbox record with deduplication identity, raw payload retention boundary, claim/retry lifecycle, safe errors, and correlation.
- **Notification Outbox**: One future delivery request per material revision with safe reference payload and stabilization marker; no recipient PII.
- **Disruption Audit Event**: Actor-attributed lifecycle and operations actions, including acknowledge, accept, automatic resolution, retry, and admin resolution.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 95% of valid signed webhooks are durably acknowledged in under 500 ms without a Duffel API call.
- **SC-002**: 95% of processed webhook-triggered material changes are visible in booking detail within two minutes.
- **SC-003**: Eligible missed events are detected within 35 minutes while reconciliation is enabled and budget is available.
- **SC-004**: Replaying or concurrently processing identical input produces exactly one itinerary revision/version and at most one outbox row.
- **SC-005**: 100% of supplier-confirmed cancellation races produce no later revision, notification request, or detected disruption state.
- **SC-006**: All approved materiality rules and exact boundary cases pass deterministic table-driven tests, including cumulative drift and multi-slice journeys.
- **SC-007**: Booking detail and history perform zero supplier calls and meet a 200 ms p95 application response target under the existing project load profile.
- **SC-008**: 100% of terminal inbox failures, notification-suppressed bookings, and unsynchronizable legacy bookings are visible to operations with a correlation identifier.
- **SC-009**: No raw webhook payload, passenger PII, or payment data appears in logs or traveller/admin API responses in automated leakage tests.
- **SC-010**: Existing booking, cancellation/refund, payment, backend E2E, and frontend Playwright suites remain green.

## Assumptions

- Duffel `order.airline_initiated_change_detected` is the initial supported change event; adding `air.order.changed` requires a separate contract review.
- The existing raw-body NestJS configuration and Duffel order retrieval client remain available.
- The existing PostgreSQL, Prisma, NestJS schedule, JWT ownership, ADMIN role, audit, and observability patterns are reused.
- The six-hour fallback matching tolerance, UTC throttle day, 30-day raw payload retention, and 500 ms/two-minute/35-minute SLOs are implementation defaults derived from the approved architecture and may be made configurable without changing behavior contracts.
- Notification delivery will later consume the outbox and resolve the traveller’s contact details; Feature 14 stores no delivery recipient.
- Existing snapshot JSON cannot be reliably backfilled with missing Duffel segment IDs; the confidence cascade is the supported legacy path.
