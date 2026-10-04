# Tasks: Narrow the Duffel Supplier Boundary

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [supplier contract](./contracts/supplier-boundaries.md), [quickstart.md](./quickstart.md).
**Tests**: Required by FR-012 and the story acceptance scenarios. Write/extend focused tests before each behavior change; confirm the new assertion fails first.
**Organization**: Extract first, rename last. Each phase ends at a runnable checkpoint. File paths are repository-relative.

## Phase 1: Setup and behavior baseline

**Purpose**: Pin current behavior and remove private SDK access before extraction.

- [x] T001 [P] Characterize raw/cached user and agent search, deterministic offer IDs/order, budget, and 404/410 detail behavior in `apps/api/src/duffel/duffel.service.spec.ts` and `apps/api/src/flights/flights.service.spec.ts`.
- [x] T002 [P] Characterize seat-map cache/missing-map and priced-offer validation in `apps/api/src/duffel/duffel-ancillary.service.spec.ts` and `apps/api/src/payment/ancillary-payment-validation.service.spec.ts`.
- [x] T003 [P] Characterize create/cancel/retrieve, fencing, redacted evidence, and compensation/replay in `apps/api/src/duffel/duffel-fulfillment.adapter.spec.ts` and `apps/api/src/payment-fulfillment/payment-fulfillment.saga.spec.ts`.
- [x] T004 Replace the private `this.duffelService['duffel']` lookup with `getOfferById()` in `apps/api/src/flights/flights.service.ts`; update `apps/api/src/flights/flights.service.spec.ts` and run the baseline commands in `specs/029-duffel-provider-narrowing/quickstart.md`.

---

## Phase 2: Foundational Duffel core and shared budget

**Purpose**: Establish one SDK/config owner and atomic daily attempt accounting before capability extraction.

- [x] T005 [P] Add tests for one SDK instance, token/basePath validation, mock URL override, and malformed URL fast fail in `apps/api/src/supplier/core/duffel-core.module.spec.ts`.
- [x] T006 [P] Add concurrency, UTC expiry, cache-hit, attempted-call, and store-unavailable tests in `apps/api/src/supplier/core/duffel-rate-budget.service.spec.ts` and `apps/api/src/cache/cache.service.spec.ts`.
- [x] T007 Implement an atomic Redis check-and-increment operation with total plus optional extra counter/limit and fail-closed budget storage in `apps/api/src/cache/cache.service.ts`.
- [x] T008 Extract SDK token/basePath factory and singleton provider into `apps/api/src/supplier/core/duffel-sdk.provider.ts` and `apps/api/src/supplier/core/duffel-core.module.ts`.
- [x] T009 Implement total daily budget reservation and typed exhausted/unavailable errors with retry time in `apps/api/src/supplier/core/duffel-rate-budget.service.ts`; keep caller labels/limits in search policy, outside core.
- [x] T010 Route each current `DuffelService` SDK/manual HTTP attempt through core reservation, including parallel and retry attempts, in `apps/api/src/duffel/duffel.service.ts`; retain existing mock-server and error behavior.
- [x] T011 Remove monthly search charging in `apps/api/src/duffel/duffel.service.ts` and monthly reconciliation precharge/decrement in `apps/api/src/disruption/sync/reconciliation.service.ts`; catch typed budget denial there, preserve `budgetBlocked` and defer without charging skipped syncs; update `apps/api/src/disruption/sync/reconciliation.service.spec.ts`.
- [x] T012 Wire `DuffelCoreModule` through the temporary `apps/api/src/duffel/duffel.module.ts`; run core and API typecheck checkpoint from `specs/029-duffel-provider-narrowing/quickstart.md`.

**Checkpoint**: Current service still works; all actual Duffel attempts now share a daily budget, and no monthly counter remains active.

---

## Phase 3: User Story 1 — Search and offer detail (Priority: P1) 🎯 MVP

**Goal**: Search, live offer lookup, booking readiness, and handoff consume normalized flight data through the search capability.

**Independent Test**: Search/cache/detail/readiness/handoff fixtures pass with the same ordered public results and stored raw evidence; no search consumer uses the private SDK or parses Duffel-shaped JSON.

### Tests for User Story 1

- [x] T013 [P] [US1] Add search-port/cache/hash/ranking/rejection and live-offer lookup contract tests in `apps/api/src/supplier/search/duffel-search.service.spec.ts` and `apps/api/src/flights/flight-search-orchestrator.service.spec.ts`.
- [x] T014 [P] [US1] Add stored-offer normalization parity tests for passenger IDs, expiry, carriers, segments, cabin, baggage, and malformed snapshots in `apps/api/src/supplier/search/flight-offer.normalizer.spec.ts`.
- [x] T015 [P] [US1] Add raw-reader replacement cases in `apps/api/src/booking-intent/booking-readiness.service.spec.ts`, `apps/api/src/agent-gateway/booking-readiness/agent-booking-readiness.service.spec.ts`, and `apps/api/src/chat-handoff/chat-handoff.service.spec.ts`.

### Implementation for User Story 1

- [x] T016 [US1] Define `FLIGHT_SEARCH_PORT`, complete normalized `FlightOffer`/`FlightSearchResult`, live lookup, and stored-offer normalization signatures in `apps/api/src/supplier/search/flight-search.port.ts` per `specs/029-duffel-provider-narrowing/contracts/supplier-boundaries.md`.
- [x] T017 [US1] Move Duffel request mapping, offer search, and live `offers.get` into `apps/api/src/supplier/search/duffel-search.adapter.ts`, reserving each real attempt in core.
- [x] T018 [US1] Move and extend Duffel-offer decoding into `apps/api/src/supplier/search/flight-offer.normalizer.ts`; preserve deterministic UUID, original index, rejection counts/order, and normalized stored-offer read behavior from `apps/api/src/flights/flight-offer-normalizer.ts`.
- [x] T019 [US1] Implement normalized-query cache/hash and caller sub-allocations in `apps/api/src/supplier/search/duffel-search.service.ts`; return the port envelope with raw payload as write-only persistence evidence.
- [x] T020 [US1] Register and export only the search port in `apps/api/src/supplier/search/supplier-search.module.ts`, keeping its normalizer internal; move offer cleanup cron from `apps/api/src/duffel/duffel-cleanup.service.ts` to `apps/api/src/supplier/search/flight-offer-cleanup.service.ts` without duplicate cron registration.
- [x] T021 [US1] Rewire search/detail and ranking in `apps/api/src/flights/flights.service.ts`, `apps/api/src/flights/flight-search-orchestrator.service.ts`, and `apps/api/src/flights/flights.module.ts`; preserve DB raw evidence, response DTOs, audits, match order, and expiry outcomes.
- [x] T022 [US1] Rewire live offer lookup in `apps/api/src/booking-intent/booking-intent.service.ts` and `apps/api/src/booking-intent/booking-intent.module.ts` to `FLIGHT_SEARCH_PORT`, retaining amount/expiry/passenger validation and existing error mapping.
- [x] T023 [US1] Migrate persisted raw-offer readers to `FLIGHT_SEARCH_PORT.normalizeStoredOffer` in `apps/api/src/booking-intent/booking-readiness.service.ts`, `apps/api/src/agent-gateway/booking-readiness/agent-booking-readiness.service.ts`, and `apps/api/src/chat-handoff/chat-handoff.service.ts`; wire `apps/api/src/booking-intent/booking-intent.module.ts`, `apps/api/src/agent-gateway/booking-readiness/agent-booking-readiness.module.ts`, and `apps/api/src/chat-handoff/chat-handoff.module.ts` to the port for neutral passenger, expiry, segment, carrier, and baggage facts.
- [x] T024 [US1] Run search/readiness/handoff and API compile checkpoint in `specs/029-duffel-provider-narrowing/quickstart.md`; fix only parity failures in the User Story 1 paths.

**Checkpoint**: Search and offer detail no longer depend on the Duffel monolith. Booking intent/readiness and handoff use normalized values.

---

## Phase 4: User Story 2 — Ancillary catalog and repricing (Priority: P2)

**Goal**: Seat maps, services, and priced-offer validation use an ancillary capability with unchanged booking totals.

**Independent Test**: Catalog, missing-map, passenger scope, cache, selection, and repricing/payment fixtures pass without `DuffelService` imports in ancillary/payment consumers.

### Tests for User Story 2

- [x] T025 [P] [US2] Add adapter/catalog cache and missing-seat-map tests in `apps/api/src/supplier/ancillary/duffel-ancillary.service.spec.ts`.
- [x] T026 [P] [US2] Add repricing, currency, selected service, and passenger-scope parity cases in `apps/api/src/payment/ancillary-payment-validation.service.spec.ts` and `apps/api/src/ancillaries/ancillaries.service.spec.ts`.

### Implementation for User Story 2

- [x] T027 [US2] Extract seat-map, service, and priced-offer SDK calls with per-attempt budget reservation into `apps/api/src/supplier/ancillary/duffel-ancillary.adapter.ts`.
- [x] T028 [US2] Move seat-map/service and price normalization into `apps/api/src/supplier/ancillary/ancillary.normalizer.ts`, retaining existing shared `AncillaryCatalog` and repricing outputs.
- [x] T029 [US2] Implement cache/force-refresh/freshness and concrete ancillary operations in `apps/api/src/supplier/ancillary/duffel-ancillary.service.ts` and register them in `apps/api/src/supplier/ancillary/supplier-ancillary.module.ts`.
- [x] T030 [US2] Rewire `apps/api/src/ancillaries/ancillary-catalog.service.ts`, `apps/api/src/ancillaries/ancillaries.module.ts`, `apps/api/src/payment/ancillary-payment-validation.service.ts`, and `apps/api/src/payment/payment.module.ts` to the ancillary module; retain request-scoped identity validation.
- [x] T031 [US2] Run ancillary/payment and API compile checkpoint in `specs/029-duffel-provider-narrowing/quickstart.md`.

**Checkpoint**: Ancillary flow no longer depends on the Duffel monolith.

---

## Phase 5: User Story 3 — Order lifecycle and safe compensation (Priority: P3)

**Goal**: Fulfillment, cancellation, recovery, and sync use one order capability; unconfirmed cancellation never releases the hold against an active order.

**Independent Test**: Order/saga/cancellation/recovery/disruption suites pass; last-slot create → capture failure → denied cancellation remains recoverable and next-day retry completes once.

### Tests for User Story 3

- [x] T032 [P] [US3] Add order adapter, quote, cancellation, retrieval, snapshot, and redaction parity cases in `apps/api/src/supplier/order/duffel-order.adapter.spec.ts` and `apps/api/src/duffel/duffel-fulfillment.adapter.spec.ts`.
- [x] T033 [P] [US3] Add last-slot denial in both inline capture-failure and 25-second `handleBackgroundError` compensation, retained checkpoint/hold, sweeper TTL deferral, next-day cancellation, and already-cancelled replay tests in `apps/api/src/payment-fulfillment/payment-fulfillment.saga.spec.ts` and `apps/api/src/booking-lifecycle/booking-recovery.service.spec.ts`.

### Implementation for User Story 3

- [x] T034 [US3] Extract manual order POST and order/quote/cancel/retrieve SDK operations into `apps/api/src/supplier/order/duffel-order.adapter.ts`, counting each actual attempt and preserving idempotency/request shapes.
- [x] T035 [US3] Move Duffel order/itinerary-to-domain mapping into `apps/api/src/supplier/order/order-snapshot.normalizer.ts`; remove Duffel types from `apps/api/src/disruption/domain/itinerary-normalizer.ts` while preserving legacy snapshot reads.
- [x] T036 [US3] Move quote/confirm/cancel orchestration into flat `apps/api/src/supplier/order/duffel-cancellation.service.ts` with existing refund amounts and idempotent already-cancelled handling.
- [x] T037 [US3] Move retrieve/complete-order and snapshot recovery into flat `apps/api/src/supplier/order/duffel-recovery.service.ts` with existing partial-order/error behavior.
- [x] T038 [US3] Move the fulfillment adapter to `apps/api/src/supplier/order/duffel-fulfillment.adapter.ts` and bind unchanged `FULFILLMENT_GATEWAY_PORT` in `apps/api/src/supplier/order/supplier-order.module.ts`; preserve semaphore, fencing, redaction, and fallback snapshots.
- [x] T039 [US3] Rewire order consumers and Nest imports in `apps/api/src/cancellation/cancellation.service.ts`, `apps/api/src/booking-lifecycle/booking-recovery.service.ts`, `apps/api/src/disruption/sync/supplier-sync.service.ts`, `apps/api/src/payment-fulfillment/payment-fulfillment.module.ts`, and `apps/api/src/app.module.ts`; update module-wiring tests.
- [x] T040 [US3] Preserve order-created idempotency checkpoint, payment hold, PROCESSING booking, and order evidence on unconfirmed cancellation in both `executeConfirmPayment` and `handleBackgroundError` of `apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts`; do not finalize the key or void/fail until cancellation is confirmed.
- [x] T041 [US3] Defer stale recovery on unconfirmed cancellation via existing `CacheService` key `booking:recovery:defer:{bookingId}` with TTL to budget retry time or bounded backoff, then cancel/confirm before void/fail in `apps/api/src/booking-lifecycle/booking-recovery.service.ts`; missing key causes safe recheck and duplicate remote effects remain blocked.
- [x] T042 [US3] Delete `apps/api/src/duffel/duffel.service.ts`, `apps/api/src/duffel/duffel.module.ts`, `apps/api/src/duffel/duffel.service.spec.ts`, and moved duplicate normalizer/cleanup files after equivalent capability tests and all consumers use the new modules.
- [x] T043 [US3] Run order/saga/recovery/privacy and API compile checkpoint in `specs/029-duffel-provider-narrowing/quickstart.md`.

**Checkpoint**: The monolith is gone, and money-path replay/compensation is recoverable under budget denial.

---

## Phase 6: User Story 4 — Neutral names and physical schema (Priority: P4)

**Goal**: Internal domain/contract/database names are supplier-neutral; current HTTP/SSE and signed attestation bytes remain stable.

**Independent Test**: Fresh and existing-schema migrations pass; provider-name census has only enumerated SDK/webhook/wire/history exceptions; API, web, agent, and HMAC fixtures remain compatible.

### Tests for User Story 4

Approved Slice 6.1 scope: T045 pins legacy reads and strict stale-agent state; neutral segment/new-write coverage remains T051. T046 pins both root identity names and nested legacy rejection; nested supplierOfferId rejection remains T049. See [Slice 6.1 verification](./slice-6-1-verification.md).

- [X] T044 [P] [US4] Pin current API JSON keys and `sel_v1_` signed payload bytes in `apps/api/src/agent-gateway/selection-attestation.service.spec.ts`, `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts`, and `packages/shared/src/types/flight-search.types.spec.ts`.
- [X] T045 [P] [US4] Add legacy/new booking snapshot and strict stale-agent-snapshot behavior in `apps/api/src/disruption/domain/itinerary-normalizer.spec.ts`, `apps/api/src/booking-management/booking-management.service.spec.ts`, and `apps/agent/tests/test_trusted_search_snapshot.py`.
- [X] T046 [P] [US4] Extend web provider-ID stripping and checkout-injection tests in `apps/web/lib/server/flight-search.spec.ts`, `apps/web/lib/server/booking-management.spec.ts`, and `apps/web/tests/handoff-checkout-proxy.unit.ts`.

### Implementation for User Story 4

- [x] T047 [US4] Rename internal domain/shared offer/order/passenger/segment/quote/sync/hash fields to supplier/flight vocabulary in `packages/shared/src/booking-types.ts`, `packages/shared/src/disruption-types.ts`, `packages/shared/src/types/ancillary.types.ts`, and corresponding `apps/api/src/` consumer types.
- [x] T048 [US4] Add explicit current-wire compatibility mappings in `apps/api/src/flights/dto/search-flight.dto.ts`, `apps/api/src/booking-management/dto/booking-response.dto.ts`, `apps/api/src/agent-gateway/dto/attested-flight-search.dto.ts`, and `apps/api/src/agent-gateway/selection-attestation.service.ts`; keep HMAC object serialization unchanged.
- [X] T049 [US4] Update web local names/schema boundaries and reject both old/new injected supplier keys in `apps/web/lib/server/flight-search.ts`, `apps/web/lib/server/booking-management.ts`, `apps/web/lib/handoffCheckoutPayload.ts`, and `apps/web/lib/checkout.ts`.
- [x] T050 [US4] Update agent local names and legacy wire aliases in `apps/agent/src/agent/trusted_search_snapshot/models.py`, `apps/agent/src/agent/tools/search_flights.py`, `apps/agent/src/agent/graph/nodes.py`, and `apps/agent/src/agent/guardrails/schemas/tools.py`; reject stale strict snapshots to fresh search.
- [x] T051 [US4] Add legacy `duffelSegmentId` JSON read and neutral new-write projection in `apps/api/src/supplier/order/order-snapshot.normalizer.ts`; preserve old persisted `duffel_order_created`/`DUFFEL_COST` readers while changing internal vocabulary in `apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts` and `apps/api/src/booking-lifecycle/booking-recovery.service.ts`.
- [x] T052 [US4] Rename non-webhook Prisma fields and indexes without `@map` in `apps/api/prisma/schema.prisma`; add forward physical rename SQL in `apps/api/prisma/migrations/20260929000000_supplier_identifiers/migration.sql` without editing prior migrations.
- [x] T053 [US4] Regenerate Prisma client and update renamed field references across `apps/api/src/booking-intent/`, `apps/api/src/ancillaries/`, `apps/api/src/cancellation/`, `apps/api/src/disruption/`, `apps/api/src/agent-gateway/`, `apps/api/src/chat-handoff/`, and `apps/api/src/payment-fulfillment/`; keep `DuffelWebhookEvent` concrete.
- [x] T054 [US4] Validate clean and previous-schema migration, physical indexes, preserved rows, shared/API typecheck, and cross-service contract cases using `specs/029-duffel-provider-narrowing/quickstart.md`.

**Checkpoint**: Neutral internal vocabulary and real columns, with explicit compatibility edges.

---

## Phase 7: Polish and cross-cutting audit

- [ ] T055 Run full pre-PR API/shared/web/agent gates and E2E scenarios from `context/testing.md` and `specs/029-duffel-provider-narrowing/quickstart.md`; record pass/fail evidence in `specs/029-duffel-provider-narrowing/verification.md`.
- [ ] T056 Audit remaining `DuffelService`, `DuffelModule`, private SDK, `@duffel/api`, and provider-named identifier hits in `apps/api/src/`, `packages/shared/src/`, `apps/web/`, `apps/agent/src/`, and `apps/api/prisma/schema.prisma`; document only SDK/webhook/wire/history exceptions in `specs/029-duffel-provider-narrowing/verification.md`.
- [ ] T057 Update implemented architecture and status in `context/architecture.md` and `context/progress-checker.md`; update `context/library-docs.md` and other directly affected context files if their Duffel guidance is stale.

## Dependencies and execution order

```text
Setup T001–T004 → Foundation T005–T012 → US1 T013–T024 → US2 T025–T031
→ US3 T032–T043 → US4 T044–T054 → final audit T055–T057
```

US1 is the MVP search/detail/readiness slice. US2 and US3 share the old monolith during extraction, so follow the approved search → ancillary → order sequence rather than editing it concurrently. US4 depends on deleting the monolith: physical and contract renames are a separately reviewable change. Each story is independently validated at its checkpoint with the preceding slices working.

### Parallel opportunities

- **US1**: T013, T014, and T015 touch separate test files and can be written together after foundation. Production extraction T016–T023 is ordered by type/adapter/service/consumer dependencies.
- **US2**: T025 and T026 cover separate test files and can be written together; T027–T030 follow adapter → normalizer → service → wiring.
- **US3**: T032 and T033 cover separate test files and can be written together; T034–T041 follow order data and safety dependencies.
- **US4**: T044, T045, and T046 pin different wire/persistence/browser contracts in parallel before shared renames. T047–T053 then move as one coordinated schema/type change.

## Implementation strategy

Complete setup and foundation, ship the US1 search boundary checkpoint first, then ancillary and order extraction. Stop at each checkpoint until focused tests and API compile pass. Delete the monolith before neutral renaming. Finish with the physical migration, byte-compatible external contracts, full security/CI gates, and context documentation sync. No second supplier, new public endpoint, or speculative port is part of this work.

## Phase 8: Convergence (Phase 5 checkpoint)

- [x] T058 Remove `@Global()` from `apps/api/src/supplier/core/duffel-core.module.ts` so SDK/configuration/budget providers resolve only through explicit supplier capability-module imports, and add a negative Nest composition test in `apps/api/src/supplier/core/duffel-core.module.spec.ts` per the Structure Decision in `specs/029-duffel-provider-narrowing/plan.md` and the Nest module dependencies in `specs/029-duffel-provider-narrowing/contracts/supplier-boundaries.md` (`contradicts`).

Dependency: T058 gates T043 and must finish before US4 tasks T044–T054.

## Phase 9: Convergence (Phase 7 boundary census and gate failures)

These append-only tasks address current-source findings verified during T056 and the repeated T055 performance failure. The user approved the bounded design, legitimate fixture adaptations, and diagnosis/fix of the performance blocker. Preserve existing behavioral/security assertions and timing limits; complete focused TDD, typecheck, and lint before each implementation commit.

- [ ] T059 Normalize travel scope/completion/expiry facts in `apps/api/src/supplier/search/flight-offer.normalizer.ts` and `flight-search.port.ts`; remove raw passenger binding fallback and neutralize internal passenger IDs through `apps/api/src/booking-intent/booking-intent.service.ts`, `passenger-source-resolver.service.ts`, and `passenger-snapshot.service.ts`, preserving identity order, wire aliases, and ciphertext contexts (FR-003, FR-009).
- [ ] T060 Inject the existing exported search port into `apps/api/src/booking-intent/booking-passenger-final-validator.service.ts` and consume supplier-normalized travel/expiry facts instead of parsing raw evidence; preserve decrypt-first ordering, passport/trip-date/expiry safeguards and caller-option precedence (FR-003).
- [ ] T061 Move raw offer-to-booking snapshot conversion from `apps/api/src/booking-lifecycle/booking-lifecycle.service.ts` to the supplier search boundary; pass normalized snapshots from `apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts` through the existing lifecycle argument, keeping BookingStateModule dependent only on Prisma and DomainEvents and retaining legacy snapshot compatibility (FR-003, FR-006, FR-010a).
- [ ] T062 Normalize cancellation outcomes and redacted-order passenger enrichment within `apps/api/src/supplier/order/`; remove those supplier-shape interpretations from `apps/api/src/booking-lifecycle/booking-recovery.service.ts`, preserving pending/budget/replay compensation safety and avoiding additional provider calls (FR-003, FR-006, FR-007a).
- [ ] T063 Remove raw supplier expiry/passenger-shape reads from `apps/api/src/chat-handoff/chat-handoff.service.ts`; consume normalized freshness and passenger-provenance facts through the existing search port, preserving stored-offer fallback, synthetic-passenger omission, HTTP keys and attestation bytes (FR-003, FR-004, FR-010a).
- [ ] T064 Make `apps/api/src/flights/flight-search-orchestrator.service.ts` accept and return only canonical offers; retire the live domain raw-offer parser and preserve equivalent supplier-boundary/ranking/scoring/top-20/currency/identity test coverage (FR-003, FR-004, FR-009).
- [ ] T065 Rename internal cancellation quote parse/serialize helpers and type in `apps/api/src/cancellation/cancellation.types.ts` and consumers to Supplier vocabulary, preserving persisted delimiter bytes and the explicit legacy wire DTO alias (FR-009, FR-010).
- [ ] T066 Diagnose and minimally correct the reproduced agent security performance gate failure, retaining all signatures, Unicode/encoded-attack handling and unchanged performance ceilings. Prefer a verified owned-process environment correction documented in `context/testing.md` when measurements exclude a scanner regression; change guardrail source only for a demonstrated defect. Verify focused and full guarded agent suites and Ruff checks before committing (T055 verified failure).

Execution: T066 clears the current gate blocker first. T059 precedes T060/T061/T063 shared normalized facts; remaining fixes have serialized file ownership. Re-run final T055 gates and T056 census after all fixes, then T057 documentation, whole-feature convergence, independent Standards/Spec reviews, and exact-HEAD remote CI. Historical dashboard snapshot projection is a documented legacy-history read exception; no new live supplier-shape parsing is permitted.

