# Implementation Plan: Delete the Booking Umbrella

**Branch**: `codex/025-booking-umbrella-deletion` | **Date**: 2026-09-21 | **Spec**: [spec.md](spec.md)

**Input**: Approved [grilling decisions](../../docs/adr/0009-booking-umbrella-deletion.md) and feature specification.

## Summary

Move the five authenticated booking endpoints into controllers owned by booking management and cancellation, then remove the forwarding `BookingModule` and DTO wrappers. Booking reads will return stored state without synchronous Stripe/Duffel repair, emit a booking-ID-only request for stale `PROCESSING` records, and retain local completion checks. `BookingRecoveryService` will process requests asynchronously under a five-minute per-booking coordination lock. Finally, normalize cancellation paths across the API, Next route handlers, server proxy helpers, UI calls, and tests. No schema change or new durable queue.

## Technical Context

**Language/Version**: Existing TypeScript 5.9 workspace; NestJS API and Next.js web app versions pinned by repository manifests.
**Primary Dependencies**: NestJS controllers/guards; feature 024's merged `@nestjs/event-emitter` registration, `BookingStateModule`, and `CacheService` owner-token locks; existing Prisma, Stripe, and Duffel services.
**Storage**: Existing PostgreSQL booking records; Redis `booking:recon:lock:{bookingId}` coordination key, 300-second TTL; no migration.
**Testing**: Jest unit and API E2E, Playwright booking characterization and cancellation journeys, lint/typecheck/build gates.
**Target Platform**: Existing API and web deployments, including multiple API replicas.
**Project Type**: NestJS API plus Next.js frontend in the current monorepo.
**Performance Goals**: List/detail do not await provider reconciliation; verify with a deliberately blocked provider call.
**Constraints**: Preserve authorization, response DTOs, quote/refund safeguards, and read-time `CONFIRMED → COMPLETED`; no external-provider call introduced in the GET critical path.
**Scale/Scope**: Five API endpoints, three frontend cancellation operations, one asynchronous reconciliation event and handler, the existing ten-minute sweep, and a projection-listener guard.

## Constitution Check

*Gate: checked before research and again after design.*

| Principle | Design evidence | Status |
|---|---|---|
| Flight-first | Booking reads become less dependent on payment/airline availability; no new product scope | Pass |
| Deterministic transaction boundary | Events only request existing deterministic recovery; purchase/cancel/refund writes retain authoritative checks | Pass |
| API budget discipline | Stale-only emission and a shared per-booking lease for event and sweep entries limit duplicate provider calls | Pass at design; duplicate-side-effect verification required |
| Observability and privacy | Booking-ID-only event, structured outcome/error logging, no passenger or payment payload | Pass at design; implementation verification required |
| Incremental delivery | Controller split, read repair change, and route normalization each have an independent checkpoint | Pass |
| Security | Existing guards and owner checks remain on every endpoint; no card or PII enters event/lock values | Pass at design; E2E verification required |

No constitutional violation is introduced. In-process events are intentionally non-durable because the existing ten-minute sweep is the recovery mechanism; [research.md](research.md) records the tradeoff.

## Implementation Sequence

### Foundation: Feature 024

Feature 024 merged into `origin/development` as PR #309 while this plan was drafted. Rebase this branch onto that tip before publication. At implementation start, verify `apps/api/src/booking-lifecycle/booking-state.module.ts`, global `EventEmitterModule.forRoot`, and `CacheService.acquireLock/releaseLock` signatures. The planning PR remains docs-only.

### US1: Move controller ownership and remove umbrella

Create `BookingManagementController` under `booking-management/` with `GET /bookings` and `GET /bookings/:bookingId`. Create `CancellationController` under `cancellation/` with the current three cancellation routes and their existing guard, UUID parsing, request user, body validation, service calls, and return shapes. Register each controller in its module. Remove `BookingModule`, `BookingController`, and the forwarding `booking/dto/` files after confirming all references are migrated to owning DTO modules. Remove `BookingModule` from `AppModule`; retain direct module imports. Characterize all five endpoints, owner checks, and route registration before deletion. This checkpoint preserves existing URLs.

### US2: Return reads promptly and reconcile in the background

`BookingManagementService` detects `PROCESSING` bookings with `createdAt <= now - 15 minutes` in list and detail reads. It emits `booking.reconciliation.requested` with `{ bookingId }` and does not await repair. Since `EventEmitter2.emit` can synchronously invoke listeners, keep listener work asynchronous and contain listener errors so emission cannot block or reject the GET. Continue awaiting `BookingLifecycleService.checkAndCompleteBooking()` locally, then sort/map the resulting booking as today. Replace `BookingManagementModule`'s `BookingLifecycleModule` import with feature 024's `BookingStateModule`. Do not inject or export `BookingRecoveryService` into this read module.

`BookingRecoveryService` keeps its existing ten-minute sweep but sends both cron candidates and event requests through one private per-booking reconciliation helper. The helper creates a UUID owner token and acquires `booking:recon:lock:{bookingId}` through feature 024's atomic `CacheService.acquireLock(key, token, 300)`. If busy, it returns. If acquired, it fetches the latest booking with the relations required by `reconcileBookingIfStale`, confirms it is still stale and `PROCESSING`, invokes recovery, and releases in `finally` through token-checked `CacheService.releaseLock`. The cron still discovers stale bookings and retries missed events; it does not bypass the lease. Feature 024's cache helper falls back to process-local storage during Redis failure, so a lease is coordination rather than correctness. Audit and test the existing Duffel/Stripe cancellation side effects under duplicate execution and after lease expiry; harden idempotency/conditional state checks where necessary before relying on this shared path. Log outcomes without PII or provider secrets. Tests must cover delayed providers, listener failure, event-versus-sweep races, lock expiry/release ownership, state changes before handling, duplicate provider actions, and cron recovery.

Feature 024's `BookingProjectionListener` subscribes to `booking.**`, which also matches the required request-event name. Before emitting this new event, guard the projection listener so only catalogued `BOOKING_EVENTS` with valid committed-event fields (`eventId` and `sourceVersion`) proceed. Place the rejection before the listener's existing `try/finally`, which records duration even on early returns. Request events cause no hydration, upsert, or projection metric. Add a regression test that emits `booking.reconciliation.requested` and observes zero projection work; keep all 11 transition event behaviors intact.

### US3: Normalize cancellation URLs together

Change cancellation controller routes to `@Controller('bookings/:bookingId/cancellation')`, with `@Get()` status, `@Post('quote')` quote, and `@Post()` execute. Move Next route handlers to `apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/route.ts` (GET status and POST execute) and `.../cancellation/quote/route.ts` (POST quote). Update `apps/web/lib/server/booking-management.ts` upstream paths and `apps/web/components/bookings/BookingDetail.tsx` client paths. Move the existing ZAP cancellation execution entry to the new POST path in `tests/security/zap/routes.json`, `tests/security/zap/routes-config.test.mjs`, and `tests/security/zap/openapi.json` so the security workflow scans the live endpoint. Remove old `cancel/`, `cancellation-quote/`, and `cancellation-status/` routes. Update Playwright interception and API E2E paths. Retain result/error mappings and ownership checks. Check the installed Next route-handler docs in `node_modules/next/dist/docs/` before writing route code, per repository rule.

## Project Structure

### Documentation

```text
specs/025-booking-umbrella-deletion/
  spec.md plan.md research.md data-model.md quickstart.md tasks.md
  checklists/requirements.md
  contracts/booking-http.md contracts/reconciliation-event.md
  reviews/convergence.md
```

### Source Code

```text
apps/api/src/
  app.module.ts
  booking/                         # remove umbrella, controller, DTO wrappers
  booking-management/
    booking-management.module.ts
    booking-management.controller.ts
    booking-management.service.ts
    dto/
  cancellation/
    cancellation.module.ts
    cancellation.controller.ts
  booking-lifecycle/
    booking-state.module.ts        # prerequisite from feature 024
    booking-recovery.service.ts
  cache/cache.service.ts           # existing owner-token lock helpers from feature 024
  booking-projection/booking-projection.listener.ts  # exclude request events
apps/api/test/
  booking.e2e-spec.ts
  cancellation.e2e-spec.ts
  characterization/booking-characterization.e2e-spec.ts
apps/web/
  app/api/booking-management/bookings/[bookingId]/cancellation/route.ts
  app/api/booking-management/bookings/[bookingId]/cancellation/quote/route.ts
  lib/server/booking-management.ts
  components/bookings/BookingDetail.tsx
  tests/characterization/booking-seam.characterization.spec.ts
tests/security/zap/
  routes.json
  routes-config.test.mjs
  openapi.json
```

**Structure Decision**: Existing domain modules own controllers and services. Next route handlers remain grouped by traveler booking management, as decided in the grilling record.

## Design Artifacts

- [research.md](research.md): decisions, dependency evidence, and alternatives.
- [data-model.md](data-model.md): reused Booking data and transient event/lease shapes.
- [contracts/booking-http.md](contracts/booking-http.md): HTTP and proxy route contract.
- [contracts/reconciliation-event.md](contracts/reconciliation-event.md): event payload and processing invariants.
- [quickstart.md](quickstart.md): verification guide.

## Post-Design Constitution Recheck

The contracts add no new source of truth, provider dependency on reads, or sensitive event payload. The owner-token lease is explicitly coordination; persisted booking state and verified provider-operation idempotency remain the correctness boundary. The event and ten-minute sweep share the lease, limiting overlapping work in normal operation while retaining missed-event recovery. All design gates remain satisfied subject to duplicate-side-effect tests during implementation.
