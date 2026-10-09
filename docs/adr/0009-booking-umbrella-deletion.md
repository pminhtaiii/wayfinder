# Grilling Session — Delete the Shallow Booking Umbrella

> Captured from grilling session on 2026-09-21.
> Source: architecture-review-2026-09-13.html (Candidate #3: Delete the shallow Booking umbrella).

---

## Context

`BookingModule` is 15 lines with zero providers, zero exports, and an unused `BookingLifecycleModule` import. It exists solely to aggregate `BookingManagementModule`, `CancellationModule`, and host a pass-through `BookingController`. `BookingController` is 82 lines — every method is a one-liner delegating to `BookingManagementService` or `CancellationService`. `booking/dto/` contains 4 re-export wrappers (19 lines total). The module is pure indirection with no domain logic.

`BookingManagementModule` has no controller. `CancellationModule` has no controller. Only `AppModule` and E2E test fixtures import `BookingModule`.

---

## Decision 1 — Two controllers, split by domain responsibility ✅

**Problem**: BookingController hosts 5 endpoints spanning two distinct domains. After deleting the umbrella, where do the endpoints live?

**Decision**: Two controllers, each in their owning domain module:
- `BookingManagementController` in `BookingManagementModule` — `GET /bookings`, `GET /bookings/:id`
- `CancellationController` in `CancellationModule` — cancellation status, quote, and execute

Controller ownership follows domain responsibility, not URL prefix. `CancellationController` legitimately exposes routes under `/bookings/:bookingId/cancellation` while living in `CancellationModule`. Common HTTP infrastructure (authentication, guards) is shared through the NestJS module system. AppModule imports both modules directly:

```
AppModule
├── BookingManagementModule (BookingManagementController + BookingManagementService)
└── CancellationModule      (CancellationController + CancellationService)
```

---

## Decision 2 — Normalize cancellation URLs as a proper sub-resource ✅

**Problem**: Current routes are irregularly named siblings (`/cancel`, `/cancellation`, `/cancellation-quote`) rather than a clean sub-resource hierarchy.

**Decision**: Restructure before production launch:

| Method | Old Route | New Route |
|--------|-----------|-----------|
| GET | `/bookings/:bookingId/cancellation` | `/bookings/:bookingId/cancellation` (unchanged) |
| POST | `/bookings/:bookingId/cancellation-quote` | `/bookings/:bookingId/cancellation/quote` |
| POST | `/bookings/:bookingId/cancel` | `/bookings/:bookingId/cancellation` |

Enables a clean `@Controller('bookings/:bookingId/cancellation')` prefix with `@Get()` (status), `@Post('quote')` (quote), `@Post()` (execute). GET and POST on the same path is standard REST. Pre-production — no deployed consumers to break; CI pipeline catches breakage.

---

## Decision 3 — Frontend route handlers mirror the backend sub-resource ✅

**Problem**: Next.js route handlers use irregular naming (`cancel/`, `cancellation-quote/`, `cancellation-status/`).

**Decision**: Restructure frontend folders to mirror the normalized backend:

```
# After
app/api/booking-management/bookings/[bookingId]/cancellation/route.ts       ← GET (status) + POST (execute)
app/api/booking-management/bookings/[bookingId]/cancellation/quote/route.ts ← POST (quote)
```

Colocating GET and POST in one `route.ts` is natural for a single REST resource — low complexity since both operate on the same `/cancellation` resource.

---

## Decision 4 — Frontend cancellation routes stay under `booking-management/` ✅

**Problem**: Backend splits into separate modules. Should the frontend route handlers mirror this split with a separate `app/api/cancellation/` prefix?

**Decision**: No. All booking-related route handlers remain under `app/api/booking-management/`.

Frontend and backend serve different organizational purposes: backend needs decoupling, dependency boundaries, and domain ownership; frontend route handlers are thin proxies that need clean routing organization. From the user's perspective, cancellation is part of "managing your bookings." Splitting the frontend to mirror the backend would introduce coupling between frontend folder structure and backend module boundaries.

---

## Decision 5 — BookingManagementModule is already correctly scoped ✅

**Correction**: Initial research incorrectly stated `BookingManagementModule` had 5 providers including `SupplierSyncService` and `BookingRecoveryService`. After verifying the actual source:

- `SupplierSyncService` already lives in `DisruptionModule` (`disruption/sync/supplier-sync.service.ts`)
- `BookingRecoveryService` already lives in `BookingLifecycleModule` (`booking-lifecycle/booking-recovery.service.ts`)

`BookingManagementModule` is 12 lines with a single provider (`BookingManagementService`). No extraction needed — the concern about umbrella re-emergence is addressed by the existing code structure.

---

## Decision 6 — Remove synchronous read-repair from booking reads ✅

**Problem**: `BookingManagementService.listBookings()` and `getBookingDetail()` call `bookingRecoveryService.reconcileBookingIfStale()` synchronously — a write operation triggered by a read. A normal `GET /bookings` becomes dependent on Stripe and Duffel API latency and availability.

**Decision**: Remove the synchronous call. Separate correctness priorities:

- **Reads** (`GET /bookings`, `GET /bookings/:id`): Serve current known state immediately. Trigger reconciliation asynchronously if staleness detected.
- **Critical writes** (purchase, cancellation, refund): Revalidate authoritative state synchronously before proceeding.

Booking reads should not be gated on external provider availability. Critical write paths already have authoritative revalidation (e.g., `PaymentFulfillmentSaga` checks Stripe intent status).

---

## Decision 7 — Async reconciliation via `EventEmitter2` ✅

**Problem**: When staleness is detected during a read, reconciliation should happen without blocking the response.

**Decision**: Emit `booking.reconciliation.requested` via `EventEmitter2`. `BookingRecoveryService` listens via `@OnEvent('booking.reconciliation.requested')`. Deduplication at the handler, not the emitter. Existing cron (`sweepStaleBookings`, every 10 min) remains as the safety net.

---

## Decision 8 — Redis `SET NX EX` with unique lock token for deduplication ✅

**Problem**: Multiple replicas may detect the same stale booking and emit concurrent reconciliation events. In-memory `Set<string>` is invisible across replicas.

**Decision**: Redis `SET NX EX` lock per booking at the reconciliation handler with a unique lock token (UUID), not a constant.

```
Key:   booking:recon:lock:{bookingId}
Value: {unique-worker-token}
TTL:   300s
```

Design invariants:
- **Redis is coordination, not correctness** — reduces duplicate work across replicas, not the correctness guarantee.
- **Reconciliation logic remains idempotent** — safe if duplicate events slip through.
- **Unique lock token** — enables safe explicit lock release; one worker cannot accidentally delete another worker's lock after TTL expiry.
- **`PaymentIdempotencyService` not reused** — its saga, replay, and request-hash semantics are far heavier than this temporary coordination problem requires.

---

## Decision 9 — Keep `checkAndCompleteBooking()` inline on the read path ✅

**Problem**: `BookingManagementService` also calls `bookingLifecycleService.checkAndCompleteBooking()` synchronously during reads (CONFIRMED → COMPLETED when departure passed). Should this also move to async?

**Decision**: Keep it inline. No external API calls — pure Prisma status transition (milliseconds). Immediate correctness matters (users should see "Completed" when a flight has departed). Naturally idempotent — race conditions are edge cases with no consequences.

---

## Decision 10 — Narrow import from `BookingLifecycleModule` to `BookingStateModule` ✅

**Problem**: After removing `BookingRecoveryService`, `BookingManagementModule` still imports `BookingLifecycleModule` — transitively pulling in Stripe, Duffel, Refund, and RefundSettlement.

**Decision**: Import `BookingStateModule` directly. Final module:

```
BookingManagementModule
├── imports: PrismaModule, BookingStateModule
├── controllers: [BookingManagementController]
├── providers: [BookingManagementService]
└── exports: [BookingManagementService]
```

`BookingStateModule` was extracted in Feature 024 (T019) specifically as a narrower reusable boundary for `BookingLifecycleService`. `EventEmitter2` is globally registered — no additional import needed.

`BookingManagementModule` is *primarily a read/query module with a narrow booking-state dependency* — not "pure read," since `checkAndCompleteBooking()` can still perform the local CONFIRMED → COMPLETED transition. If that is ever moved off the read path, the `BookingStateModule` import can be dropped entirely.
