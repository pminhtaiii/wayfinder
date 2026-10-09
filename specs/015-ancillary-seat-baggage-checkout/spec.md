# Feature Specification: Ancillary Seat and Baggage Checkout

**Feature Branch**: `015a-ancillary-seat-baggage-checkout`

**Created**: 2026-07-26

**Status**: Draft

**Input**: Approved decisions in `docs/adr/0003-ancillary-services.md` for Feature 15 ancillary services.

## User Scenarios & Testing

### User Story 1 - Select Seats Per Passenger and Segment (Priority: P1)

After entering passenger details, a traveller can inspect each available flight segment's seat map, move freely between eligible passenger tabs, and select or skip one seat per non-infant passenger per segment. Selections made for other passengers in the same booking remain visible and distinguishable from unavailable seats.

**Why this priority**: Seat selection is the most visible ancillary capability and establishes the segment/passenger state model used by every later checkout step.

**Independent Test**: Start from a valid owned BookingIntent with two adults and two segments, choose different seats for both adults on one segment, skip the other segment, leave and return to the page, and verify the assignments remain isolated and correctly restored.

**Acceptance Scenarios**:

1. **Given** an owned, unexpired BookingIntent with available seat maps, **When** the traveller selects a seat for a passenger on a segment, **Then** the UI records the Duffel service ID under that exact segment and passenger and updates the displayed price immediately.
2. **Given** one passenger already has a seat selected, **When** another passenger views the same segment, **Then** that seat is shown as selected by the group rather than supplier-unavailable.
3. **Given** an infant without a separate seat entitlement, **When** the passenger stepper renders, **Then** the infant is skipped and cannot receive a seat service.
4. **Given** Duffel returns no seat map for a segment, **When** the segment is viewed, **Then** the segment is non-interactive and explains that the airline will assign seats without an added charge.
5. **Given** a selected seat becomes unavailable before commitment, **When** the server validates the selection, **Then** no payment authorization or supplier order is created and the traveller is prompted to reselect from refreshed availability.

---

### User Story 2 - Add Segment- or Journey-Scoped Baggage (Priority: P2)

A traveller can switch to baggage on the same ancillary page, compare supplier-provided baggage services for each passenger, and select either segment-specific or journey-wide services without purchasing overlapping coverage.

**Why this priority**: Baggage is the second approved revenue-driving ancillary and depends on the same passenger/segment selection foundation as seats.

**Independent Test**: On a two-segment itinerary, select a journey-wide checked bag for one passenger and verify equivalent segment-scoped options are disabled on all covered segment tabs, the single service is counted once, and removing it restores the individual choices.

**Acceptance Scenarios**:

1. **Given** Duffel services with one or multiple `segment_ids`, **When** the traveller views baggage choices, **Then** each option is labelled as this-flight-only or full-journey coverage.
2. **Given** a journey-wide service is selected, **When** a covered segment is viewed, **Then** conflicting same-tier segment services are disabled and the existing cross-segment selection is explained.
3. **Given** the sum of equivalent segment services costs more than a journey-wide service, **When** both are displayed, **Then** the UI shows the calculated saving without changing the supplier prices.
4. **Given** baggage is optional, **When** the traveller skips baggage for every passenger, **Then** the flow can continue without a baggage service.

---

### User Story 3 - Review an Instant, Authoritative Total (Priority: P3)

While choosing extras, a traveller sees an instant price tracker containing the base fare, seat total, baggage total, and combined total. The subsequent review is read-only and offers targeted edit links. On checkout, the server validates ownership and every service against Duffel before using one manual-capture Stripe PaymentIntent for the authoritative full amount.

**Why this priority**: This closes the deterministic transaction and security boundary; browsing totals are useful only if the committed amount and services cannot be tampered with.

**Independent Test**: Select seats and baggage, confirm instant client totals, continue to review, edit and return without losing selections, then complete a mocked checkout where server repricing agrees and one supplier order and one captured PaymentIntent result.

**Acceptance Scenarios**:

1. **Given** selections with a single currency, **When** a service is added, changed, or removed, **Then** the price tracker updates immediately without calling Duffel repricing during browsing.
2. **Given** the traveller chooses Continue, **When** the selection snapshot is accepted, **Then** the server persists normalized seat and baggage service references to the owned BookingIntent and the client stores a TTL-bound recovery snapshot.
3. **Given** a valid snapshot, **When** review loads, **Then** it is read-only and exposes targeted Edit seats and Edit baggage navigation that preserves the other section.
4. **Given** the traveller commits checkout, **When** server repricing and service validation succeed, **Then** a single manual-capture Stripe PaymentIntent covers base fare plus all selected services and the validated service IDs are passed to Duffel order creation.
5. **Given** supplier order creation fails after authorization, **When** the checkout compensates, **Then** the Stripe authorization is cancelled and no confirmed Booking is exposed.
6. **Given** the same confirmation request is retried with the same idempotency key, **When** processing completes or is replayed, **Then** at most one supplier order and one payment transaction exist.

### Edge Cases

- Seat-map cache entries with three seconds or less remaining are treated as misses; force refresh bypasses cached content.
- Supplier services are rejected when their IDs do not belong to the selected offer, passenger, or declared segment coverage.
- Cross-currency selections are rejected rather than client-converted or silently summed.
- Duplicate seat assignment within the traveller's group is prevented before submission and revalidated by the server.
- Expired or non-owned BookingIntents cannot fetch or persist ancillary selections.
- A local recovery snapshot is discarded when its BookingIntent is missing, expired, belongs to another authenticated user, or no longer matches the server snapshot version.
- Passenger/segment switching never carries a seat designator or service into another scope.
- Repricing changes, unavailable services, and expired offers return structured conflicts that preserve valid selections where possible and identify what must be reviewed.
- Non-refundable ancillary amounts follow the existing Duffel cancellation quote and are disclosed; the refund pipeline is not independently recalculated.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST insert an independently skippable Ancillaries step between passenger details and review, with switchable Seats and Baggage sections.
- **FR-002**: The system MUST retrieve seat maps and available ancillary services only for an authenticated traveller's unexpired BookingIntent and offer.
- **FR-003**: The system MUST cache supplier-native seat maps in Redis for 60 seconds using offer-scoped keys and MUST bypass entries with three seconds or less remaining TTL. Cached values MUST NOT contain local BookingIntent/passenger IDs, traveller names, or an intent-specific passenger projection; the server MUST derive that mapping per authenticated request after reading the cache.
- **FR-004**: The system MUST provide an explicit seat-map force refresh that bypasses the cache without mutating committed selections.
- **FR-005**: The system MUST key seat selections by segment ID and passenger ID and use Duffel service ID as the authoritative identifier; seat designators are display-only.
- **FR-006**: The system MUST allow at most one seat per eligible passenger per segment and MUST exclude lap infants from seat assignment.
- **FR-007**: The system MUST distinguish supplier-unavailable seats, the active passenger's seat, and other group passengers' seats using non-color indicators.
- **FR-008**: The system MUST render each segment independently and provide the approved fallback when a seat map is unavailable.
- **FR-009**: The system MUST key baggage selections by passenger and service coverage, retaining supplier service ID, covered segment IDs, type, weight, quantity, amount, and currency.
- **FR-010**: The system MUST identify journey-wide baggage from multiple supplier segment IDs and prevent overlapping same-tier journey and segment purchases.
- **FR-011**: The system MUST calculate displayed savings only from supplier-provided prices for equivalent coverage and weight tiers.
- **FR-012**: The client MUST calculate the browsing total instantly as base offer price plus selected service amounts and MUST NOT reprice on each interaction.
- **FR-013**: All amounts in one selection MUST use the offer currency; unsupported mixed-currency submissions MUST fail validation.
- **FR-014**: On Continue, the server MUST validate JWT identity, BookingIntent ownership/expiry/version, derive each Duffel-to-local passenger mapping from that owned intent, and validate each service's offer, passenger, segment coverage, availability, amount, and currency before persisting the snapshot. A mapping that is absent, ambiguous, or belongs to another intent MUST be rejected.
- **FR-015**: The system MUST persist each committed ancillary snapshot as a new append-only BookingIntent-owned version, atomically advance the intent's current snapshot pointer, and retain older snapshot/service rows while any Payment or recovery path references them. A later commit MUST NOT replace or mutate an older version.
- **FR-016**: The client MUST retain only the minimum recovery snapshot in localStorage with intent-bound expiry and MUST reconcile it against server state before hydration.
- **FR-017**: The review page MUST be read-only and MUST expose targeted edit links for seats and baggage while preserving the untouched section.
- **FR-018**: At checkout commitment, the server MUST reprice the exact offer and selected services with Duffel and MUST return an actionable conflict before payment authorization when the selection is stale or invalid.
- **FR-019**: The system MUST create one Stripe PaymentIntent in manual-capture mode for the authoritative base-plus-ancillary amount, then create one Duffel order containing only validated service IDs.
- **FR-020**: The system MUST capture Stripe only after Duffel confirms the order and MUST cancel the authorization when supplier order creation fails.
- **FR-021**: Ancillary confirmation and checkout MUST use the existing idempotency mechanism so retries cannot duplicate snapshots, payments, or orders. Payment MUST store and recover from the exact immutable snapshot ID/version it priced rather than the BookingIntent's mutable current pointer.
- **FR-022**: Existing cancellation/refund recovery MUST continue using Duffel's authoritative cancellation quote; the feature MUST disclose excluded non-refundable ancillaries without introducing a second refund calculation.
- **FR-023**: Expired BookingIntent cleanup MUST remove only snapshots not protected by retained Payment/recovery references; database constraints MUST prevent deletion of referenced snapshots. Stale local snapshots MUST self-discard.
- **FR-024**: Supplier calls, validation conflicts, cache behavior, checkout compensation, and idempotent replays MUST emit structured PII-safe logs, traces, metrics, and audit events consistent with project standards.
- **FR-025**: The feature MUST remain deterministic and MUST NOT involve an AI agent in selection validation, pricing, payment, or order creation.
- **FR-026**: The first release MUST support desktop ancillary interaction and accessible keyboard operation; a dedicated small-screen seat-map layout is deferred.

### Key Entities

- **Ancillary Selection Snapshot**: Append-only, versioned BookingIntent-owned commitment containing normalized seat and baggage selections, authoritative validated totals, validation metadata, and expiry. BookingIntent points to the current snapshot while Payment retains the exact immutable snapshot it priced.
- **Seat Selection**: One Duffel seat service assigned to one eligible passenger on one flight segment, with a display-only designator and supplier amount/currency.
- **Baggage Selection**: A quantified Duffel baggage service for one passenger covering one or more segments, including type and weight tier.
- **Ancillary Catalog**: Short-lived supplier-derived seat-map and available-service data used for browsing and server validation.
- **Price Breakdown**: Base, seat, baggage, and combined totals in one currency, with separate client-estimated and server-validated states.
- **BookingIntent**: Existing user-owned, expiring checkout aggregate extended to retain the committed ancillary snapshot and its optimistic version.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A traveller can select or skip seats and baggage for a two-passenger, two-segment itinerary and reach review without any selection appearing under the wrong passenger or segment.
- **SC-002**: Price tracker updates complete within 100 ms of a local selection interaction and generate zero repricing requests during browsing.
- **SC-003**: At checkout, 100% of submitted service IDs are validated against the owned offer/passenger/segment through the current BookingIntent's request-scoped passenger mapping before a payment authorization or Duffel order is created.
- **SC-004**: Repeated requests with one idempotency key produce at most one committed selection snapshot, one PaymentIntent, and one Duffel order.
- **SC-005**: Seat-map requests served from cache avoid supplier calls while entries have more than three seconds remaining; stale-window and force-refresh requests obtain fresh supplier data.
- **SC-006**: Supplier-order failures after payment authorization result in zero captured charges and a cancelled or safely recoverable authorization.
- **SC-007**: Keyboard-only users can navigate segment and passenger controls, identify seat states without color alone, select services, skip sections, and continue to review.
- **SC-008**: Existing booking, payment, cancellation, and refund tests remain green, including cancellation quotes containing refundable ancillary amounts.
- **SC-009**: End-to-end tests demonstrate recovery after tab close/reopen for an unexpired committed snapshot and safe discard after expiry or ownership mismatch.
- **SC-010**: When Payment recovery is bound to ancillary version N and version N+1 later becomes current, recovery uses exactly version N's totals and service lines and neither snapshot is deleted or rewritten.

## Assumptions

- Existing JWT authentication, BookingIntent ownership/versioning, idempotency, Stripe manual-capture, Duffel order creation, Redis, audit logging, and cleanup mechanisms are extended rather than replaced.
- Duffel remains authoritative for seat availability, services, price verification, order creation, and cancellation refund amounts.
- Passenger details, including date of birth, are available before the ancillary step; route-country detection for conditional documents belongs to the passenger-details flow.
- Seat and baggage browsing is optional. Checkout remains possible with no ancillary selections.
- Desktop-first means the seat grid may use horizontal scrolling below the supported layout width, while controls and non-grid content must still meet current accessibility expectations.
- Post-booking ancillary changes, AI recommendations, loyalty benefits, round-trip/multi-city search expansion, and notification delivery are outside this feature.
