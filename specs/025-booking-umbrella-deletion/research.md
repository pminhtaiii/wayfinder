# Research: Booking Umbrella Deletion

## Source and dependency check

The [grilling record](../../docs/adr/0009-booking-umbrella-deletion.md) is the decision source. The original `development` checkout had `BookingModule` forwarding five endpoints and `BookingManagementService` awaiting `BookingRecoveryService` in list/detail. Feature 024 merged into `origin/development` as PR #309 during planning. Its source provides `apps/api/src/booking-lifecycle/booking-state.module.ts`, root `EventEmitterModule.forRoot`, and `CacheService.acquireLock/releaseLock` implemented with `SET EX NX` and owner-token Lua release. Rebase this planning branch onto the refreshed base before publication.

## Controller boundaries

**Decision**: Two controllers in their owning modules, direct `AppModule` imports, no umbrella. US1 preserves current URLs and response contracts; US3 changes cancellation URLs as one backend/frontend slice.

**Rationale**: The forwarding module owns no domain logic. Keeping URL prefix separate from module ownership lets cancellation own `/bookings/:bookingId/cancellation`.

**Alternatives considered**: One moved controller would preserve the same cross-domain dependency; splitting frontend folders by backend module would couple thin proxy layout to server internals.

**Scope check**: `BookingManagementModule` already has a single provider, `BookingManagementService`. Supplier synchronization and recovery belong to other modules, so this phase does not extract additional management services.

## Read behavior and event delivery

**Decision**: `PROCESSING` records older than 15 minutes trigger `booking.reconciliation.requested` with only `{ bookingId }`. GET responses use known stored state, except the existing local completion transition. The handler reloads the record and checks eligibility before provider work. The ten-minute cron stays.

**Rationale**: A GET should not inherit Stripe/Duffel latency. A booking ID avoids sending potentially stale or sensitive booking graphs in an in-process event. The cron covers an event lost on process termination; it is the existing recovery guarantee.

**Alternatives considered**: Keep synchronous read repair (availability coupling); add a durable queue/outbox (unnecessary new storage for a path already covered by the sweep); move completion to background (delays a cheap local correctness update).

**Listener collision found in review**: Feature 024's `BookingProjectionListener` subscribes to `booking.**` and accepts any payload with `bookingId`; the new booking-ID-only request would otherwise trigger projection hydration with missing `eventId` and `sourceVersion`. Guard that listener with the committed `BOOKING_EVENTS` catalog and required committed-event fields before hydration or metrics. The request event name remains as approved in the grilling record.

## Deduplication

**Decision**: Reuse feature 024's `CacheService.acquireLock(key, UUID, 300)` and `releaseLock(key, UUID)`. Lock key is `booking:recon:lock:{bookingId}`. Both the event listener and existing ten-minute sweep enter through one locked per-booking helper; a busy lock skips that attempt. If Redis is unavailable, the existing helper's process-local fallback suppresses local duplicates only. A worker releases only its token in `finally`.

**Rationale**: Atomic Redis `SET NX EX` coordinates replicas in normal operation; a unique token prevents an expired worker from deleting a successor's lock. The old sweep directly invoked provider recovery without a lease, so leaving it unchanged would permit event/sweep overlap. Existing helpers avoid another connection or lock abstraction. Because the lease can expire or fall back per process, implementation must verify and, if needed, harden existing Duffel/Stripe side-effect idempotency and conditional booking transitions.

**Alternatives considered**: In-memory `Set` only (no cross-replica coordination); `PaymentIdempotencyService` (financial replay semantics exceed a temporary lease); constant-value lock (unsafe release after expiry).

## Routing and compatibility

**Decision**: Status is `GET /bookings/:bookingId/cancellation`; quote becomes `POST /bookings/:bookingId/cancellation/quote`; execution becomes `POST /bookings/:bookingId/cancellation`. Web route handlers mirror these paths under `/api/booking-management/`.

**Rationale**: These are one resource and a quote action. The product is pre-production with no deployed consumers requiring aliases. Route, proxy, UI, and tests switch together.

**Alternatives considered**: Permanent old-route aliases (unnecessary public surface); separate `/api/cancellation/` frontend tree (adds organizational coupling).

## Open implementation checks

- Verify feature 024 module exports and lock helper signatures against the refreshed `development` code during implementation.
- Inspect the installed Next.js route-handler guide before code edits because this repository's Next version may differ from familiar releases.
- Verify `EventEmitter2` listener behavior with tests: a slow or rejected listener must not delay or fail the GET.
- Verify the projection listener ignores the request event without hydration, upsert, or projection metrics, while all 11 transition names continue to work.
- Verify the recovery service loads the same relation shape as its cron and rechecks current state before calling provider APIs.
