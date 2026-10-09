# Grilling Session — BookingProjectionModule Extraction & Event-Driven Architecture

> Captured from grilling session on 2026-09-15.
> Source: architecture-review-2026-09-13.html (Candidate #2: Relocate BookingAgentProjection to core).

---

## Context

Three core domain modules (`BookingLifecycleModule`, `CancellationModule`, `DisruptionModule`) import `AgentGatewayModule` solely to access `BookingAgentProjectionService`, inverting the dependency direction (core → edge) and forcing a `forwardRef` circular loop in `DisruptionModule`. There are 12 direct calls to the projection service across 4 services in 3 modules. Additionally, `RefundSettlementService` mutates booking status via `tx.booking.update()` bypassing `BookingLifecycleService` entirely, leaving the agent projection stale after refund settlement.

The system has zero event infrastructure — no `@nestjs/event-emitter`, no `EventEmitter2`, no `@OnEvent`. All inter-module communication is 100% synchronous DI method calls. The codebase has 3 `forwardRef` cycles total.

---

## Decision 1 — State-Transition Events, Not Intent Events ✅

**Problem**: Need to define what a "domain event" represents in this system.

**Decision**: Use state-transition events — one event per lifecycle transition: `booking.confirmed`, `booking.failed`, `booking.cancelled`, etc. The event name tells you *what happened*. Listeners decide what to do.

**Rationale**: State-transition events are domain-native (they match existing `BookingLifecycleService` transitions), stable (adding a new listener doesn't require changing the emitter), and preserve locality — the emitter only knows what *it* did, not what *others* should do. Intent events create hidden coupling: the emitter has to know about its consumers' responsibilities.

---

## Decision 2 — Passive Hydrated-Once Events ✅

**Problem**: Event payloads need to balance data completeness with coupling.

**Decision**: Thin identity events with an injected hydrator service. Events are passive data contracts carrying `{ bookingId, eventId, sourceVersion, timestamp }`. No behavior on the event class. The listener calls `this.hydrator.hydrate(event.bookingId)` to load the full booking state. First caller pays the DB query; result is cached per event processing cycle.

**Key constraint**: `event.hydrate(...)` was rejected — events must remain behavior-free. Hydration is the listener's responsibility via an injected `BookingEventHydrator` service.

---

## Decision 3 — Event Contracts in `domain-events/` Directory ✅

**Problem**: Event contracts (classes/types) need a home that doesn't create import coupling between emitter and listener modules.

**Decision**: Dedicated `apps/api/src/domain-events/` directory containing:
- `domain-event.base.ts` — abstract base class
- `booking.events.ts` — all booking event classes
- `refund.events.ts` — refund event classes
- `booking-event-hydrator.service.ts` — shared hydration service

**Rationale**: `packages/shared` is for cross-app types; these events are API-internal. A dedicated directory prevents any import path coupling between emitter and listener modules.

---

## Decision 4 — Emit After Commit, Eventual Consistency for Projections ✅

**Problem**: 6 of 12 projection call sites currently execute inside Prisma transactions. With events, should we emit inside or after the transaction?

**Decision**: Emit events after the transaction commits. Projections are eventually consistent. The `BookingAgentProjection` is a derived read model, not a source of truth. A stale projection during a crash window is acceptable — the reconciliation cron repairs it.

**ADR alignment**: The "no eventual consistency in payment mutations" constraint (from `0032-payment-system.md`) applies to payment state (Stripe intents, captures, booking status transitions), not to derived read models. Payment mutations remain strictly CP. Projections are eventually consistent.

**Pattern**: Collect events during the transaction, flush them to `EventEmitter2` after commit succeeds.

---

## Decision 5 — Thin Dispatcher Listener + Separate Projection Service ✅

**Problem**: How to structure the `BookingProjectionModule` — one class or two?

**Decision**: Thin `BookingProjectionListener` as an event adapter, separate `BookingProjectionService` for projection logic. The listener owns:
- `@OnEvent` routing
- Structured error logging with `eventId`, `bookingId`, `aggregateVersion`
- Metrics instrumentation
- Hydration orchestration

The projection service owns:
- Data extraction (snapshot parsing, fallback logic)
- PII stripping
- Projection persistence
- Idempotent upsert

**Rename**: `BookingAgentProjectionService` → `BookingProjectionService` to remove the historical `agent-gateway` ownership implication.

**Rationale**: Consistent with the Ports & Adapters direction from Candidate 1. The projection service remains testable in isolation without mocking `EventEmitter2`.

---

## Decision 6 — Monotonic Version with Last-Write-Wins ✅

**Problem**: Need idempotent projection updates safe against duplicate and out-of-order event delivery.

**Decision**: Monotonic integer `version` column on the `Booking` model, incremented on every state change. The `BookingAgentProjection` table stores `sourceVersion` — the booking version it was derived from. The listener uses a stale-event guard:

```typescript
if (event.sourceVersion <= projection.sourceVersion) {
  this.logger.debug(`Stale event for booking ${event.bookingId}, skipping`);
  return;
}
```

**Last-write-wins** for concurrent events targeting the same booking. Acceptable because:
1. Both writers hydrate from the source of truth (current `Booking` row)
2. Both are writing projections derived from equally fresh data
3. Staleness is self-correcting via the next event or reconciliation cron

**Rejected**: Timestamps — clock skew, resolution collisions, NTP drift. Optimistic locking with retries — adds complexity for a self-correcting read model.

---

## Decision 7 — Log + Observe + Reconcile Error Handling ✅

**Problem**: What happens when a projection listener throws?

**Decision**: Log the error with structured context, increment a failure metric, do not propagate the error back to the booking workflow. The booking transaction already committed successfully — a projection failure must not make a successful command appear to have failed.

```typescript
@OnEvent('booking.confirmed')
async onConfirmed(event: BookingConfirmedEvent) {
  try {
    await this.refreshProjection(event.bookingId);
  } catch (error) {
    this.logger.error('Booking projection update failed', {
      eventId: event.eventId,
      bookingId: event.bookingId,
      aggregateVersion: event.aggregateVersion,
      error,
    });
    this.metrics.increment('booking_projection.failure');
  }
}
```

**No generic retry from day one**. Retrying every exception makes permanent programming/data errors noisier without fixing them.

**Evolution path**:
1. **Now**: log + metric + reconciliation
2. **Next**: targeted retry for classified transient errors (connection/tx failures) if metrics justify it
3. **Later**: proper transactional outbox if projection freshness becomes operationally critical (skip intermediate DLQ)

---

## Decision 8 — Remaining `forwardRef` Cycles Scoped Out ✅

**Problem**: Two other `forwardRef` cycles exist beyond the projection-related one:
- `AgentBookingReadinessModule` ↔ `BookingIntentModule`
- `BookingIntentModule` ↔ `ChatHandoffModule`

**Decision**: Leave them for a separate session. These are **query coupling** (one module needs to read another's data), not **side-effect coupling** (reactions to state changes). Events are the wrong tool — the fix is likely interface extraction or shared read services, consistent with the ports & adapters direction.

---

## Decision 9 — BookingProjectionModule Owns Reconciliation ✅

**Principle**: The component that owns a derived read model also owns detecting and repairing drift in that read model.

**Decision**: `BookingProjectionModule` contains its own reconciliation cron:

```
BookingProjectionModule
├── BookingProjectionListener       — @OnEvent handlers
├── BookingProjectionService        — extraction, PII, persistence
├── BookingProjectionReconciliationService — drift detection + repair
└── BookingProjectionRepository     — persistence mechanics
```

**Version-aware reconciliation**: The cron identifies bookings where `Booking.version > Projection.sourceVersion` and repairs only those — not blind full rebuilds.

**Repository abstraction**:
```typescript
interface ProjectionReconciliationSource {
  findStaleBookingIds(options: { limit: number }): Promise<string[]>;
}
```

**Batched from day one**: 100 stale bookings per pass, bounded concurrency of 5.

**Multi-replica awareness**: Documented but not implemented. Version-guarded writes make duplicate reconciliation correct but wasteful. Distributed lock/lease is the evolution path if horizontal scaling demands it.

**Metrics**: `projection_reconciliation.{stale_found, repaired, failed, duration}`

---

## Decision 10 — Big Bang Rollout ✅

**Problem**: 12 direct projection call sites across 4 services need to be replaced with event emission.

**Decision**: Big bang — replace all 12 call sites in one PR. No dual-write transition period.

**Rationale**: The product is not in production. The entire design assumes eventual consistency with a reconciliation cron as backstop. That cron IS the safety net. Dual-write adds temporary complexity (two code paths, version conflicts) for a transition period with no production risk to mitigate.

---

## Constraints That Must Not Be Re-Litigated

- **Payment mutations remain CP** — no eventual consistency in payment state transitions (ADR: 0032-payment-system.md)
- **Projections are eventually consistent** — derived read models, not sources of truth
- **In-process EventEmitter2 only** — no message queue for a monolith (this session)
- **No generic saga framework** until a second saga-like workflow emerges (ADR: 0031-payment-module-deepening.md)
- **Saga → BookingLifecycleService → events** — the saga never emits events directly; lifecycle service is the single emitter for booking state transitions
- **BookingRecoveryService keeps direct Stripe + Duffel access** — reconciles crashed sagas, not routed through saga ports (ADR: 0031-payment-module-deepening.md)
- **Remaining 2 forwardRef cycles are separate work** — query coupling, not side-effect coupling

---

## Domain Events Catalog

| Event | Emitter | Replaces | Listeners |
|---|---|---|---|
| `booking.confirmed` | `BookingLifecycleService.updateToConfirmed()` | `createOrUpdateProjection(bookingId, tx)` | `BookingProjectionListener` |
| `booking.failed` | `BookingLifecycleService.updateToFailed()` | `updateProjectionStatus(bookingId, FAILED, tx)` | `BookingProjectionListener` |
| `booking.completed` | `BookingLifecycleService.checkAndCompleteBooking()` | `updateProjectionStatus(bookingId, COMPLETED, tx)` | `BookingProjectionListener` |
| `booking.recovery.resolved` | `BookingRecoveryService.reconcileBookingIfStale()` | 4× `updateProjectionStatus` / `createOrUpdateProjection` | `BookingProjectionListener` |
| `booking.cancelled` | `CancellationService.cancelBooking()` | `updateProjectionStatus(bookingId, status, tx)` | `BookingProjectionListener` |
| `booking.disruption.synced` | `SupplierSyncService.syncBooking()` | `createOrUpdateProjection(bookingId, tx)` | `BookingProjectionListener` |
| `refund.settled` | `RefundSettlementService.settleVerifiedOutcome()` | **NEW** — fixes missing projection update | `BookingProjectionListener` |

---

## Final Module Structure

```
apps/api/src/
├── domain-events/                          ← NEW
│   ├── domain-event.base.ts
│   ├── booking.events.ts
│   ├── refund.events.ts
│   └── booking-event-hydrator.service.ts
│
├── booking-projection/                     ← NEW (extracted from agent-gateway)
│   ├── booking-projection.module.ts
│   ├── booking-projection.service.ts       ← renamed from BookingAgentProjectionService
│   ├── booking-projection.listener.ts
│   ├── booking-projection-reconciliation.service.ts
│   └── booking-projection.repository.ts
│
├── agent-gateway/                          ← SHRUNK (projection provider removed)
├── booking-lifecycle/                      ← MODIFIED (drops AgentGatewayModule, emits events)
├── cancellation/                           ← MODIFIED (drops AgentGatewayModule, emits events)
├── disruption/                             ← MODIFIED (drops forwardRef, emits events)
├── refund-settlement/                      ← MODIFIED (emits refund.settled, fixes projection gap)
└── app.module.ts                           ← ADDS EventEmitterModule.forRoot(), BookingProjectionModule
```
