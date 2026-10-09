# Tasks: Delete the Shallow Booking Umbrella

**Input**: Design documents from `/specs/025-booking-umbrella-deletion/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `quickstart.md`, and the contracts under `contracts/` are present. Feature 024 is already merged into `origin/development` and supplies the event emitter, booking state module, and owner-token cache locks.

**Tests**: Targeted Jest, API E2E, Node/tsx web unit, and Playwright coverage is included because this phase changes module composition, asynchronous recovery behavior, and public URLs.

**Organization**: Tasks are grouped by the three approved user stories. Stories are delivered in order because URL and module cleanup builds on the controller split, and asynchronous recovery must be stable before the final route migration.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the prerequisite design artifacts and the existing seams that the implementation will change.

- [X] T001 [P] Verify Feature 024's `BookingStateModule`, global `EventEmitterModule.forRoot`, and owner-token cache locks in `apps/api/src/booking-lifecycle/booking-state.module.ts`, `apps/api/src/app.module.ts`, and `apps/api/src/cache/cache.service.ts`
- [X] T002 [P] Reconcile `docs/adr/0009-booking-umbrella-deletion.md`, `specs/025-booking-umbrella-deletion/contracts/booking-http.md`, and `specs/025-booking-umbrella-deletion/contracts/reconciliation-event.md` against the implementation plan before editing source

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the dependency and verification gates shared by every story.

**⚠️ CRITICAL**: Do not start user story implementation until Feature 024 is present and the current booking route and module tests have been identified.

- [X] T003 [P] Capture the current booking module graph and endpoint baseline in `apps/api/src/app.module.spec.ts`, `apps/api/test/booking.e2e-spec.ts`, and `apps/api/test/cancellation.e2e-spec.ts`
- [X] T004 [P] Confirm no Prisma migration or durable queue is needed by checking `apps/api/prisma/schema.prisma`, `specs/025-booking-umbrella-deletion/data-model.md`, and `specs/025-booking-umbrella-deletion/research.md`

---

## Phase 3: User Story 1 - Domain-Owned Booking Controllers (Priority: P1) 🎯 MVP

**Goal**: Delete the shallow `BookingModule` facade and place booking read endpoints and cancellation endpoints in their owning domain modules while preserving the existing HTTP behavior until the URL migration story.

**Independent Test**: Compile the API and run the controller/module tests plus booking and cancellation E2E suites; `GET /api/bookings`, `GET /api/bookings/:id`, `GET /api/bookings/:id/cancellation`, `POST /api/bookings/:id/cancellation-quote`, and `POST /api/bookings/:id/cancel` still authenticate, validate UUIDs, enforce ownership, and delegate to the same services.

### Tests for User Story 1

- [X] T005 [P] [US1] Add `BookingManagementController` delegation and authenticated-user tests in `apps/api/src/booking-management/booking-management.controller.spec.ts`
- [X] T006 [P] [US1] Add `CancellationController` delegation, body validation, and authenticated-user tests for the legacy cancellation paths in `apps/api/src/cancellation/cancellation.controller.spec.ts`
- [X] T007 [P] [US1] Update module metadata assertions in `apps/api/src/app.module.spec.ts` to require direct `BookingManagementModule` and `CancellationModule` registration and the absence of `BookingModule`

### Implementation for User Story 1

- [X] T008 [US1] Create `BookingManagementController` in `apps/api/src/booking-management/booking-management.controller.ts` with the guarded `GET /bookings` and `GET /bookings/:bookingId` methods moved from `apps/api/src/booking/booking.controller.ts`
- [X] T009 [US1] Create `CancellationController` in `apps/api/src/cancellation/cancellation.controller.ts` with the guarded legacy cancellation status, quote, and execute methods moved from `apps/api/src/booking/booking.controller.ts`
- [X] T010 [US1] Register `BookingManagementController` in `apps/api/src/booking-management/booking-management.module.ts` and `CancellationController` in `apps/api/src/cancellation/cancellation.module.ts` without changing the existing service boundaries
- [X] T011 [US1] Remove the `BookingModule` import and registration from `apps/api/src/app.module.ts`, leaving the two domain modules registered directly
- [X] T012 [US1] Delete the obsolete umbrella files `apps/api/src/booking/booking.module.ts` and `apps/api/src/booking/booking.controller.ts`, remove `apps/api/src/booking/booking.controller.spec.ts`, and delete the duplicate DTO facade files under `apps/api/src/booking/dto/` after all imports point to `apps/api/src/booking-management/dto/` or `apps/api/src/cancellation/cancellation.types.ts`
- [X] T013 [US1] Update API characterization and E2E fixtures in `apps/api/test/characterization/booking-characterization.e2e-spec.ts`, `apps/api/test/booking.e2e-spec.ts`, and `apps/api/test/cancellation.e2e-spec.ts` to assert domain-owned controllers while retaining the legacy route behavior

**Checkpoint**: User Story 1 is independently functional. The umbrella module and DTO facade are gone, direct domain modules own the controllers, and all pre-migration routes still pass.

---

## Phase 4: User Story 2 - Non-Blocking Stale Booking Reconciliation (Priority: P2)

**Goal**: Make booking reads return known state without waiting for Stripe or Duffel, request stale `PROCESSING` reconciliation asynchronously, and deduplicate handlers with an ownership-safe Redis lock while retaining the cron safety net and inline local completion transition.

**Independent Test**: Unit tests prove stale list/detail reads emit exactly `{ bookingId }` without calling `BookingRecoveryService`, recent/non-`PROCESSING` reads do not emit, `checkAndCompleteBooking()` still runs inline, event and ten-minute sweep entries share one locked helper, lease expiry and event/sweep races cannot repeat unsafe Duffel/Stripe side effects, and `BookingProjectionListener` ignores the coordination request before hydration, upsert, or metrics.

### Tests for User Story 2

- [X] T014 [P] [US2] Rewrite stale-read coverage in `apps/api/src/booking-management/booking-management.service.spec.ts` to assert non-blocking `booking.reconciliation.requested` emission, the bookingId-only payload, no recovery service call even when provider repair is delayed or rejected, preserved inline `checkAndCompleteBooking()`, and unchanged list/detail mapping
- [X] T015 [P] [US2] Add event-handler, latest-state reload, event-versus-sweep race, lease-expiry, duplicate-provider-side-effect, failure logging, and cron-retention coverage in `apps/api/src/booking-lifecycle/booking-recovery.service.spec.ts`
- [X] T016 [P] [US2] Add atomic lock acquisition, TTL, unique-token, and owner-matched release coverage in `apps/api/src/cache/cache.service.spec.ts`
- [X] T017 [P] [US2] Add `BookingProjectionListener` coverage in `apps/api/src/booking-projection/booking-projection.listener.spec.ts` proving `booking.reconciliation.requested` invokes no hydrator, projection upsert, or metrics method while a valid catalogued `DomainEventBase` still follows the projection path

### Implementation for User Story 2

- [X] T018 [US2] Add a recovery lock integration fixture in `apps/api/src/booking-lifecycle/booking-recovery.service.spec.ts` that asserts both event and sweep entries pass `booking:recon:lock:{bookingId}`, a fresh UUID token, and `300` seconds to Feature 024's `CacheService.acquireLock()` and release through `releaseLock()` with the same token
- [X] T019 [US2] Remove the `BookingRecoveryService` dependency and synchronous `reconcileBookingIfStale()` calls from `apps/api/src/booking-management/booking-management.service.ts`; inject the event emitter, fire-and-forget `{ bookingId }` only for stale `PROCESSING` records, and keep `checkAndCompleteBooking()` inline
- [X] T020 [US2] Refactor `apps/api/src/booking-lifecycle/booking-recovery.service.ts` so `@OnEvent('booking.reconciliation.requested')` and `sweepStaleBookings()` both call one private per-booking locked helper that creates a fresh UUID token, acquires the five-minute lease, reloads the latest relations, rechecks stale `PROCESSING` eligibility, runs recovery, releases only with the same token, and contains/logs failures
- [X] T021 [US2] Audit and harden conditional booking/payment updates and existing Duffel/Stripe cancellation side-effect guards in `apps/api/src/booking-lifecycle/booking-recovery.service.ts` so duplicate execution after lease expiry or an event-versus-sweep race cannot repeat unsafe provider actions or regress state; extend `apps/api/src/booking-lifecycle/booking-recovery.service.spec.ts` with the duplicate-side-effect assertions
- [X] T022 [US2] Guard `BookingProjectionListener` in `apps/api/src/booking-projection/booking-projection.listener.ts` with an early return before its existing `try/finally` (including the duration metric) by accepting only explicit `BOOKING_EVENTS` from `apps/api/src/domain-events/booking.events.ts` with a valid `DomainEventBase` shape from `apps/api/src/domain-events/domain-event.base.ts`; ignore coordination requests such as `booking.reconciliation.requested` without invoking hydrate, upsert, or any metrics method
- [X] T023 [US2] Change `apps/api/src/booking-management/booking-management.module.ts` to import `BookingStateModule` from `apps/api/src/booking-lifecycle/booking-state.module.ts` directly after recovery is removed, while keeping `BookingLifecycleModule` responsible for recovery and its cron
- [X] T024 [US2] Add module graph assertions in `apps/api/src/app.module.spec.ts` that `BookingManagementModule` imports `BookingStateModule` without `BookingLifecycleModule`, while `apps/api/src/booking-lifecycle/booking-lifecycle.module.ts` still provides `BookingRecoveryService` for the scheduled `sweepStaleBookings` job
- [X] T025 [US2] Run the focused API unit suites for `apps/api/src/booking-management/booking-management.service.spec.ts`, `apps/api/src/booking-lifecycle/booking-recovery.service.spec.ts`, `apps/api/src/cache/cache.service.spec.ts`, and `apps/api/src/booking-projection/booking-projection.listener.spec.ts` plus the booking E2E coverage in `apps/api/test/booking.e2e-spec.ts`, and record command exits in `specs/025-booking-umbrella-deletion/quickstart.md`

**Checkpoint**: User Stories 1 and 2 both work. Reads are independent of provider availability, asynchronous recovery is deduplicated across replicas, cron remains a fallback, and local completion remains immediate.

---

## Phase 5: User Story 3 - Normalized Cancellation Sub-Resource (Priority: P3)

**Goal**: Make backend cancellation routes, frontend proxy folders, server client calls, and booking detail calls use one consistent cancellation sub-resource hierarchy.

**Independent Test**: With an authenticated booking, `GET /api/bookings/:id/cancellation` returns status, `POST /api/bookings/:id/cancellation/quote` returns a quote, and `POST /api/bookings/:id/cancellation` executes with the quote body; the Next.js proxy and browser flow use the matching paths under `app/api/booking-management` and no longer call the irregular sibling paths.

### Tests for User Story 3

- [X] T026 [P] [US3] Update backend route and ownership coverage in `apps/api/src/cancellation/cancellation.controller.spec.ts` and `apps/api/test/cancellation.e2e-spec.ts` for `GET /cancellation`, `POST /cancellation/quote`, and `POST /cancellation`, including rejection of the removed legacy siblings
- [X] T027 [P] [US3] Add or update the Node/tsx server-loader coverage in `apps/web/lib/server/booking-management.spec.ts` (create this spec file if it is absent after the branch rebase) for status, quote, and execute paths, including quote body forwarding and mutation retry behavior
- [X] T028 [P] [US3] Add direct Next route-handler tests in `apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/route.spec.ts` and `apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/quote/route.spec.ts` for combined GET/POST cancellation, quote POST, and success, authentication, validation, and upstream status mappings
- [X] T029 [P] [US3] Update the browser cancellation journey in `apps/web/tests/characterization/booking-seam.characterization.spec.ts` to intercept `/cancellation`, `/cancellation/quote`, and `/cancellation` and verify the quoteId payload

### Implementation for User Story 3

- [X] T030 [US3] Change `apps/api/src/cancellation/cancellation.controller.ts` to `@Controller('bookings/:bookingId/cancellation')` with `@Get()`, `@Post('quote')`, and `@Post()` while preserving guards, UUID parsing, DTO validation, and service delegation
- [X] T031 [US3] Read the installed route-handler guide under `node_modules/next/dist/docs/`, then create `apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/route.ts` with GET status and POST execute handlers and `apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/quote/route.ts` with POST quote, preserving the existing outcome-to-response mapping
- [X] T032 [US3] Remove the obsolete frontend proxy files `apps/web/app/api/booking-management/bookings/[bookingId]/cancellation-status/route.ts`, `apps/web/app/api/booking-management/bookings/[bookingId]/cancellation-quote/route.ts`, and `apps/web/app/api/booking-management/bookings/[bookingId]/cancel/route.ts`
- [X] T033 [US3] Update `getCancellationQuote()` and `cancelBooking()` upstream paths in `apps/web/lib/server/booking-management.ts` to `/api/bookings/:bookingId/cancellation/quote` and `/api/bookings/:bookingId/cancellation`, keeping status on `/api/bookings/:bookingId/cancellation`
- [X] T034 [US3] Update cancellation status polling, quote requests, and execute requests in `apps/web/components/bookings/BookingDetail.tsx` to call the normalized frontend proxy paths under `/api/booking-management/bookings/:bookingId/cancellation`
- [X] T035 [US3] Verify no Jest or CI configuration references the generated JavaScript fixture, then delete stale `apps/api/test/cancellation.e2e-spec.js` because `apps/api/test/jest-e2e.json` runs the TypeScript E2E source; document that rationale in `specs/025-booking-umbrella-deletion/quickstart.md`
- [X] T036 [US3] Migrate the existing ZAP cancellation execution entry from `POST /bookings/:id/cancel` to `POST /bookings/:id/cancellation` in `tests/security/zap/routes.json`, replace the legacy required route in `tests/security/zap/routes-config.test.mjs`, and move its OpenAPI operation to `POST /bookings/{id}/cancellation` in `tests/security/zap/openapi.json`; preserve the route ID, bearer authentication, and high sensitivity, and verify registry/OpenAPI parity

**Checkpoint**: All three cancellation operations share the normalized backend and frontend resource hierarchy, and the full booking cancellation browser journey passes through the new paths.

---

## Phase 6: Polish & Cross-Cutting Verification

**Purpose**: Validate the complete phase and keep implementation documentation synchronized.

- [X] T037 [P] Update `context/architecture.md` and `context/progress-checker.md` with the final module graph, event/lock behavior, route map, and verification status when those project context files are present
- [X] T038 Run API lint, typecheck, focused unit/E2E tests, web unit tests, frontend lint/typecheck, the relevant Next.js build checks, and `node --test tests/security/zap/routes-config.test.mjs` as directed by `specs/025-booking-umbrella-deletion/quickstart.md`
- [X] T039 Run `rg` checks over `apps/api/src`, `apps/api/test`, `apps/web/app/api`, `apps/web/lib/server`, `apps/web/components/bookings`, and `tests/security/zap/routes.json`, `tests/security/zap/routes-config.test.mjs`, `tests/security/zap/openapi.json` to prove production code and ZAP fixtures have no remaining `BookingModule` imports, synchronous read-path reconciliation calls, or legacy cancellation URL calls; allow legacy strings only in explicit negative route assertions and historical design documents

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No code dependency, but Feature 024 and the approved ADR must be confirmed first.
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on the foundational baseline and is the MVP.
- **User Story 2 (Phase 4)**: Depends on User Story 1's domain-owned module graph and on Feature 024's `BookingStateModule`.
- **User Story 3 (Phase 5)**: Depends on User Story 1's `CancellationController`; it changes the paths established there and consumes the stable service boundary from User Story 2.
- **Polish (Phase 6)**: Depends on all desired stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Starts after Phase 2; no other story dependency.
- **User Story 2 (P2)**: Starts after User Story 1 and Feature 024 are available; it must preserve the controllers and module ownership established by User Story 1.
- **User Story 3 (P3)**: Starts after User Story 1; run after User Story 2 so the final route verification exercises the completed module graph.

### Within Each User Story

- Write or update tests before implementation tasks and use them to expose stale assumptions.
- Complete controller/module structure before deleting the umbrella files.
- Confirm Feature 024's lock helper contract before wiring the shared event/sweep helper.
- Change backend route annotations, frontend proxy files, server client paths, and browser calls as one migration.
- Stop at each checkpoint and run the independent test criteria before moving to the next story.

### Parallel Opportunities

- T001-T003 can be reviewed in parallel once `spec.md` and `plan.md` exist.
- T005-T007 are independent test-file changes for User Story 1.
- T014-T017 are independent test suites for User Story 2.
- T026-T029 are independent backend, server-loader, route-handler, and browser contract updates for User Story 3.
- T037 can be prepared in parallel with the final verification run.

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete the setup and baseline checks.
2. Implement the two domain-owned controllers and direct module registration.
3. Delete the umbrella and DTO facade only after imports compile.
4. Run the legacy-route E2E and controller/module tests.
5. Stop and validate the controller split as the first independently shippable increment.

### Incremental Delivery

1. Add User Story 1 and validate the module boundary.
2. Add User Story 2 and validate non-blocking reads, event delivery, lock ownership, and cron fallback.
3. Add User Story 3 and validate backend/frontend URL parity through the browser journey.
4. Run cross-cutting static checks and document the verified result.

### Parallel Team Strategy

1. One contributor owns the controller split and module graph.
2. A second contributor can prepare the stale-read/event/lock tests while the split is reviewed, then implement User Story 2 after the module graph lands.
3. A third contributor can prepare frontend and API route contract updates for User Story 3, then apply them after `CancellationController` exists.

## Notes

- Every task uses the required `- [ ] T###` checklist form; user story tasks include `[US1]`, `[US2]`, or `[US3]`.
- `[P]` marks tasks that touch different files and have no dependency on incomplete work in the same story.
- Redis coordination reduces duplicate reconciliation work. Database conditional updates and idempotent reconciliation remain the correctness boundary.
- The legacy cancellation paths intentionally survive User Story 1 and are removed only in User Story 3.
- The tracked generated `apps/api/test/cancellation.e2e-spec.js` is removed after verifying Jest/CI references; TypeScript E2E coverage remains authoritative.
