# Feature Specification: Delete the Booking Umbrella

**Feature Branch**: `codex/025-booking-umbrella-deletion`
**Created**: 2026-09-21
**Status**: Draft for implementation
**Input**: [Booking umbrella deletion grilling decisions](../../docs/adr/0009-booking-umbrella-deletion.md)

## User Scenarios & Testing

### User Story 1 - Booking actions retain clear ownership (Priority: P1)

As a traveler, I can list and view my bookings and request cancellation information through the same authenticated behavior while booking management and cancellation each own their operations.

**Why this priority**: Removing the umbrella is the primary architecture goal; preserved behavior makes this a viable first increment.

**Independent Test**: Exercise all five existing booking operations with an owner, another user, invalid IDs, and missing records after the umbrella is removed; responses and authorization remain equivalent.

**Acceptance Scenarios**:

1. **Given** an authenticated owner with bookings, **when** they list or view a booking, **then** they receive the same booking data, pagination, and status as before.
2. **Given** an authenticated owner with a cancellable booking, **when** they request status, quote, or cancellation, **then** each operation reaches its existing cancellation behavior.
3. **Given** an unauthenticated caller or a caller who does not own a booking, **when** they use any booking operation, **then** access is rejected as before.

### User Story 2 - Booking reads return without provider repair (Priority: P2)

As a traveler, I can see the latest known state of my booking promptly even when payment or airline providers are slow or unavailable. A stale processing booking is queued for background reconciliation, while a departed confirmed booking can still become completed during the read.

**Why this priority**: Booking history must remain available during provider outages without weakening the correctness of purchases, cancellations, or refunds.

**Independent Test**: Make a processing booking stale and delay or fail external provider responses; list and detail still complete from stored data, reconciliation runs separately, and the periodic sweep remains available.

**Acceptance Scenarios**:

1. **Given** a processing booking older than the existing staleness threshold, **when** its owner lists or opens it, **then** the response uses current known state without waiting for external reconciliation and requests background reconciliation.
2. **Given** multiple reads of the same stale booking across application replicas, **when** reconciliation is requested repeatedly, **then** concurrent repair is reduced through a per-booking lease and any duplicate work remains safe.
3. **Given** a confirmed booking whose departure has passed, **when** its owner lists or opens it, **then** its local completion transition remains visible in that response.
4. **Given** a temporary background reconciliation failure, **when** a traveler reads the booking, **then** the read still succeeds and the existing periodic recovery sweep can retry the booking.

### User Story 3 - Cancellation uses one sub-resource (Priority: P3)

As a traveler, I can check cancellation status, request a quote, and confirm cancellation through consistent booking cancellation URLs in the application.

**Why this priority**: The backend and frontend must switch together so the visible cancellation flow stays intact during the pre-production route cleanup.

**Independent Test**: Complete the quote and cancellation journey using the new paths, verify status on the same cancellation resource, and confirm the old irregular routes are absent.

**Acceptance Scenarios**:

1. **Given** an authenticated booking owner, **when** they get `/bookings/:bookingId/cancellation`, **then** they receive cancellation status.
2. **Given** an authenticated booking owner, **when** they post to `/bookings/:bookingId/cancellation/quote`, **then** they receive a cancellation quote.
3. **Given** a valid quote and an authenticated owner, **when** they post to `/bookings/:bookingId/cancellation`, **then** cancellation executes with the existing safeguards and response.
4. **Given** the booking detail page, **when** the traveler uses cancellation actions, **then** the application calls the matching frontend routes under `/api/booking-management/`.

### Edge Cases

- A stale booking can become terminal between read detection and background processing; reconciliation must recheck current state before doing provider work.
- The five-minute coordination lease can expire while work is active; a later worker may proceed, so reconciliation remains idempotent and release must never remove another worker's lease.
- Coordination storage can be unavailable; booking reads still succeed and the periodic sweep remains the recovery path.
- An event listener can fail after a successful read; the failure is observed without changing the read response.
- Pagination and ordering must use the locally completed booking state as they do today.
- Cancellation quote expiry, ownership, invalid identifiers, and refund outcomes retain existing behavior after route changes.

## Requirements

### Functional Requirements

- **FR-001**: Booking list and detail operations MUST remain authenticated, owner-scoped, and behaviorally equivalent after their ownership moves into booking management.
- **FR-002**: Cancellation status, quote, and execute operations MUST remain authenticated, owner-scoped, and behaviorally equivalent after their ownership moves into cancellation.
- **FR-003**: The booking umbrella and its forwarding-only contracts MUST be removed; the application MUST load booking management and cancellation directly.
- **FR-004**: Booking list and detail reads MUST NOT wait for payment or airline provider reconciliation; they MUST return the current known booking state when that repair is delayed or fails.
- **FR-005**: Reads of processing bookings older than 15 minutes MUST request asynchronous reconciliation; other bookings MUST NOT create unnecessary reconciliation requests.
- **FR-006**: Reconciliation requests MUST identify the booking without exposing traveler or payment details, and processing MUST recheck current booking state.
- **FR-007**: Concurrent reconciliation of one booking MUST be reduced across replicas with a five-minute, owner-specific lease; release MUST be ownership-safe and reconciliation MUST remain safe under duplicate execution.
- **FR-008**: The existing ten-minute stale-booking sweep MUST continue to provide recovery when a read-triggered request is missed or fails, and MUST use the same per-booking coordination path as event-triggered repair.
- **FR-009**: Read-time completion of eligible confirmed bookings MUST remain synchronous and local; critical purchase, cancellation, and refund writes MUST retain authoritative validation.
- **FR-010**: The cancellation status and execution operations MUST share `/bookings/:bookingId/cancellation` with their existing HTTP methods; quote MUST use `/bookings/:bookingId/cancellation/quote`.
- **FR-011**: Frontend route handlers and booking detail actions MUST use the matching cancellation paths under `/api/booking-management/`; the old irregular paths MUST be removed.
- **FR-012**: Existing cancellation result shapes, authorization behavior, and quote safeguards MUST remain unchanged by route normalization.
- **FR-013**: A reconciliation request MUST NOT be processed as a committed booking transition or update the booking projection.
- **FR-014**: The security route inventory, contract checks, and API description MUST target the normalized cancellation execution endpoint so automated scanning continues to exercise the live route.

### Key Entities

- **Booking**: Existing traveler-owned record with status, creation and departure times, and payment/airline references.
- **Reconciliation request**: Transient request identifying one booking for background repair; it creates no new persistent business entity.
- **Reconciliation lease**: Transient per-booking coordination record with an owner token and five-minute expiry.
- **Cancellation quote**: Existing offer and expiry used when the owner confirms cancellation.

## Success Criteria

### Measurable Outcomes

- **SC-001**: All five booking operations preserve successful owner behavior and rejection of unauthenticated or non-owner callers after the umbrella is removed.
- **SC-002**: In a controlled test where external repair is delayed for at least 10 seconds, booking list and detail responses complete without waiting for it.
- **SC-003**: Every stale processing booking read requests background repair, while non-stale and terminal booking reads request none.
- **SC-004**: Concurrent read-triggered and sweep-triggered repair requests for one booking result in one active worker during an unexpired lease in the normal coordination case; duplicate execution after lease expiry is verified safe for provider actions and persisted state.
- **SC-005**: The application completes the status, quote, and execute cancellation journey using only the three specified method/path combinations, with no calls to the removed paths.
- **SC-006**: Existing booking, cancellation, and refund regression suites pass after the change.
- **SC-007**: A `booking.reconciliation.requested` event alone causes zero booking-projection hydration, upsert, or projection metrics; committed booking transitions still update the projection.
- **SC-008**: The security route contract passes with the normalized cancellation execution path and no security fixture points to the removed `/cancel` path.

## Assumptions

- This is a pre-production route cleanup; no deployed external consumer requires the old quote or execute paths.
- Feature 024's event emitter registration, booking state module, and owner-token lock helpers are present on the refreshed `origin/development` base. The planning PR does not modify feature 024 code.
- No schema migration or new durable queue is needed. The existing ten-minute sweep supplies eventual recovery for lost in-process events.
- Existing authentication, booking ownership checks, cancellation quote rules, and critical-write validation remain authoritative.
