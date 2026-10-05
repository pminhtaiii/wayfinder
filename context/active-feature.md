# Active Feature

This file tracks the currently active in-flight feature, its checkpoints, and exit gates.

---

## Feature 029 — Narrow the Duffel Supplier Boundary

- **Status**: Phases 0–6 and Phase 9 convergence complete (T001–T054, T058–T067); Phase 7 boundary census complete (T056); final gate matrix (T055) pending execution and documentation sync (T057) in progress
- **Branch**: `codex/029-duffel-provider-narrowing`
- **Specification**: [specs/029-duffel-provider-narrowing/spec.md](../specs/029-duffel-provider-narrowing/spec.md)
- **Implementation Plan**: [specs/029-duffel-provider-narrowing/plan.md](../specs/029-duffel-provider-narrowing/plan.md)
- **Tasks**: [specs/029-duffel-provider-narrowing/tasks.md](../specs/029-duffel-provider-narrowing/tasks.md)

### Current Summary
Slice 6.2 (T047–T054: Neutral Names and Physical Schema) is complete and verified on remote CI. All 11 non-webhook columns and 5 dependent indexes physically renamed in place via forward migration `20260929000000_supplier_identifiers` with zero `@map` annotations. Dedicated disposable databases `feature029_slice62_fresh` and `feature029_slice62_upgrade` verified full migration chain and upgrade path with 16 preserved sentinels, 12 links, and null controls. All consumer modules across booking, payment, cancellation, disruption, and agent gateway migrated with zero type assertions. Public wire compatibility and signed `sel_v1_` HMAC bytes preserved. Local validation: API full unit suite 134 suites / 2,337 tests passed, 66/66 affected E2Es passed, contracts 111/111 passed, web compatibility 122/122 passed, typechecks and ESLint 0 errors. Standards and Spec code reviews completed and findings addressed.
PR [#369](https://github.com/pminhtaiii/wayfinder/pull/369) (Part 1) merged into `development` (`09806abd`); PR #368 is closed without merging. PR [#370](https://github.com/pminhtaiii/wayfinder/pull/370) (Part 2) replaces #368 as the open slice PR targeting `development`. Its final pushed HEAD `551c3890cd37f65ded2adf900244fc9ca0d76dd8` was verified by remote CI run [37188540602](https://github.com/pminhtaiii/wayfinder/actions/runs/37188540602), with all 12 jobs successful. See the [Slice 6.2 verification record](../specs/029-duffel-provider-narrowing/slice-6-2-verification.md#remote-ci-verification-pull-request-370) for PR history and job results.

Phase 9 convergence (T059–T067) and Phase 7 Boundary Census (T056) are complete locally. All supplier boundary leakages identified during the census have been resolved: travel scope, completion, expiry, and passenger provenance facts are normalized at `SupplierSearchModule` and consumed via `FLIGHT_SEARCH_PORT` (T059, T060, T063); raw offer-to-booking snapshot conversion moved to the supplier search boundary leaving `BookingStateModule` dependent only on Prisma and DomainEvents (T061); cancellation outcomes and passenger enrichment normalized inside `SupplierOrderModule` removing vendor shapes from `BookingRecoveryService` (T062); `FlightSearchOrchestratorService` narrowed strictly to canonical `FlightOffer` objects, retiring the live domain raw-offer parser (T064); internal cancellation quote parse/serialize helpers and types renamed to Supplier vocabulary (`ParsedSupplierCancellationQuoteId`, `parseSupplierCancellationQuoteId`, `serializeSupplierCancellationQuoteId`) with wire aliases preserved (T065); the agent security performance gate failure was diagnosed and corrected via Windows owned-process timing mitigation (T066); and Playwright's API launcher honors `DATABASE_URL` override with `test_db` fallback (T067). Phase 7 Census (T056) verified zero unexplained runtime provider hits across production code, with `@duffel/api` restricted strictly to 4 supplier adapter files and non-webhook DB columns neutralized. Phase 7 final verification matrix (T055) and documentation sync (T057) are active. PR #370 remains open and unmerged.

Review follow-up: Prisma consumers and database fixtures use the renamed supplier fields, with explicit mappings preserving existing HTTP keys, signed selection payloads, and `DuffelWebhookEvent.duffelOrderId`. This application/schema alignment is covered by the Slice 6.2 verification above. Subsequent review fixes require validation on their own pushed HEAD; the recorded CI run does not cover later working-tree changes.

T044–T046 pin signed bytes, legacy snapshots, strict agent state, and web provider-ID boundaries. Independent task reviews and scoped convergence passed at the Slice 6.1 checkpoint. Its local validation included guarded API 130 suites/2,331 tests, shared 111 tests, web 120 focused tests/build, and agent 1,291 non-Redis tests. See the [Slice 6.1 verification record](../specs/029-duffel-provider-narrowing/slice-6-1-verification.md) for approvals, mutations, environment retries, and exact commands. At that checkpoint T047–T057 remained pending; current slice status is recorded above. Feature 029 remains incomplete, and remote CI must match the final pushed HEAD of each new slice PR.

Phases 0–5 are complete locally. T042 removed the legacy `DuffelService`/`DuffelModule` monolith. T058 removed global visibility from `DuffelCoreModule`, and its negative Nest composition regression proves an unrelated module cannot resolve `DUFFEL_SDK`. T043 passed the guarded API suite (130 suites/2,326 tests), all 16 affected database E2E suites (145 tests), order and ancillary capability checkpoints, shared/static contracts, TypeScript, and lint. The final local evidence and scoped convergence recheck are in the [Slice 5 verification record](../specs/029-duffel-provider-narrowing/slice-5-verification.md). This is the historical Slice 5 checkpoint; Slice 6.2 remote verification is recorded above. Phase 7 remains pending and Feature 029 is not complete. Historical T040/T041 evidence is in the [Slice 4 verification record](../specs/029-duffel-provider-narrowing/slice-4-verification.md); earlier T039 validation and Slice 3 findings are in the [Slice 3 verification record](../specs/029-duffel-provider-narrowing/slice-3-verification.md).

---

### Phase 0 — Research & Constitution Alignment
- [x] Reconcile codebase against ADR and specify single internal SDK/config/budget owner.
- [x] Define atomic 1,500 daily Duffel attempt rate budget policy with 1,000 user / 500 agent allocations.
- [x] Define `FLIGHT_SEARCH_PORT` and `FULFILLMENT_GATEWAY_PORT` capability contracts.

Exit gate:
```text
constitution check passes; rate budget semantics locked; boundary contracts approved
```

### Phase 1 — Setup & Behavior Baseline
- [x] Characterize raw vs cached flight searches, UUID generation, rate budget, and expired offer behavior.
- [x] Characterize ancillary catalog, missing seat-map fallback, and priced-offer reconciliation.
- [x] Characterize fulfillment adapter, order idempotency, payment saga, and unconfirmed cancellation paths.
- [x] Seal private bracket escape hatch `duffelService['duffel']` with public `getOfferById`.

Exit gate:
```text
zero direct SDK property access; baseline characterization suites pass (260/260 tests)
```

### Phase 2 — Core Foundation & Rate Budget
- [x] Implement `DuffelCoreModule` exporting singleton `DUFFEL_SDK` provider.
- [x] Implement atomic dual-counter rate budget in `CacheService` via Redis Lua script.
- [x] Implement `DuffelRateBudgetService` with UTC midnight reset and attempted-call charging semantics.
- [x] Wire `DuffelCoreModule` into `DuffelModule` and remove obsolete monthly budget accounting.

Exit gate:
```text
every remote attempt reserved atomically; cache hits bypass budget; core suites pass (133/133)
```

### Phase 3 — Search Capability Isolation (User Story 1 🎯)
- [x] Extract `DuffelSearchAdapter` encapsulating raw offer search and live offer lookup with budget reservation.
- [x] Implement deterministic RFC 4122 v4 `FlightOfferNormalizer` with zero `any`.
- [x] Implement `DuffelSearchService` with Redis SHA-256 query caching (15-min TTL) and caller sub-allocations.
- [x] Relocate midnight cleanup cron to `flight-offer-cleanup.service.ts`.
- [x] Package `SupplierSearchModule` exporting strictly `FLIGHT_SEARCH_PORT`.
- [x] Rewire `FlightsService` and `FlightsModule` to consume `FLIGHT_SEARCH_PORT`.
- [x] Rewire `BookingIntentService` live offer verification to consume `FLIGHT_SEARCH_PORT`.
- [x] Migrate stored raw-offer JSON readers in Readiness, Agent Gateway, and Chat Handoff to port.

Exit gate:
```text
zero Duffel imports in search/intent/gateway; 100% search parity; Phase 3 checkpoint passes (323/323)
```

### Phase 4 — Ancillary Capability Isolation (User Story 2)
- [x] Add regression coverage for installed SDK 404 error shape preserving `seatMapAvailable: false` (T025).
- [x] Lock authoritative repricing totals, aggregated duplicate baggage, and currency validation (T026).
- [x] Implement metered raw `DuffelAncillaryAdapter` with constructor SDK and budget injection (T027).
- [x] Implement guarded `AncillaryNormalizer` mapping seats, baggage, and invalid identities (T028).
- [x] Implement `DuffelAncillaryService` and `SupplierAncillaryModule` (T029 local pass).
- [x] Rewire `AncillariesModule` and `AncillaryCatalogService` to supplier ancillary module (T030).
- [x] Rewire `PaymentModule` and ancillary payment validation to supplier ancillary module (T030).
- [x] Ancillary checkpoint verification gate and API regression pass (T031).

Exit gate:
```text
✅ Passed locally: ancillary consumers isolated from legacy Duffel; catalog/repricing parity verified (11 focused suites/153 tests, API TypeScript exit 0, network-guard API suite 127/127 suites).
```

### Phase 5 — Order Capability Isolation (User Story 3)
- [x] Lock order-operation parity characterization (T032; commit `93fe963a`, reviewed and approved).
- [x] Add safe-compensation and recovery-deferral characterization and implementation (T033; commits `1739d209` and `acc77e0b`; focused checks, code review, scoped convergence, and full API gate pass).
- [x] Extract the metered raw `DuffelOrderAdapter` (T034; commit `2675a0f2`, review GO with no Important/Critical findings).
- [x] Extract order/snapshot normalization and remove vendor types from the disruption normalizer (T035; `2223c7c9`; focused checks and independent review passed).
- [x] Extract cancellation quote/confirm/replay orchestration over the metered order adapter (T036; `0c28be32`; explicit cancelled-order evidence required for replay success).
- [x] Extract order retrieval and snapshot recovery plus service-graph E2E (T037; `2a85a113`; focused checks and independent review passed).
- [x] Add `SupplierOrderModule` and bind fulfillment capability (T038; present on the current base).
- [x] Rewire cancellation, booking recovery, sync, fulfillment modules, and AppModule to supplier order boundaries (T039; task review and local gates passed).
- [x] Preserve saga retry checkpoint, payment hold, PROCESSING booking, and order evidence during unconfirmed compensation (T040; reviewed with zero findings).
- [x] Defer stale recovery on missing/invalid order IDs, lookup failures, unconfirmed cancellation, and typed budget/rate denial; require explicit cancellation proof (T041; recovery 55/55, safety E2E 2/2, API typecheck and lint passed).
- [x] Delete the legacy Duffel monolith after equivalent tests and consumer migration (T042; commit `e1b4f48a`, independently reviewed).
- [x] Run the order/saga/recovery/privacy and API compile checkpoint (T043; guarded API 130/2,326 and affected E2Es 16/145 passed; see Slice 5 verification).
- [x] Remove `DuffelCoreModule` global visibility and verify the negative module-composition boundary (T058; review and scoped convergence recheck passed).

Exit gate:
```text
unconfirmed cancellations preserve processing/hold; order operations isolated; SDK/configuration/budget providers are private to importing supplier capability modules; local checkpoint gates pass
```

### Phase 6 — Neutral Naming & Physical Schema (User Story 4; T044–T054)
- [x] Pin wire/HMAC, legacy snapshots, and provider-ID boundary tests (T044–T046), within the approved T049/T051 deferrals.
- [x] Rename internal types and add explicit current-wire compatibility mappings (T047–T051).
- [x] Apply forward physical Prisma column/index renames and regenerate the client (T052–T053).
- [x] Validate fresh/existing migrations and cross-service compatibility (T054).

Exit gate:
```text
clean migration from scratch; zero orphan duffel database columns; wire compatibility preserved (verified on dedicated fresh/upgrade DBs; 66/66 E2Es pass; 134 suites / 2,337 unit tests pass)
```

### Phase 7 — Final Verification & Audit (T055–T057)
- [ ] Execute full API/shared/web/agent, E2E, security, and remote CI gates (T055).
- [x] Audit supplier boundary and provider-name compatibility exceptions (T056).
- [ ] Synchronize implemented architecture, progress, and relevant library guidance (T057; in progress).

Exit gate:
```text
all local and remote gates pass; 0 regressions; PR merged to development
```

### Phase 9 — Convergence (Phase 7 Boundary Census & Gate Remediation; T059–T067)
- [x] Normalize travel scope, completion, and expiry facts in `flight-offer.normalizer.ts` and `flight-search.port.ts`; neutralize internal passenger IDs (T059).
- [x] Inject search port into `booking-passenger-final-validator.service.ts` and consume normalized facts (T060).
- [x] Relocate raw offer-to-booking snapshot conversion to supplier search boundary; keep `BookingStateModule` dependent only on Prisma and DomainEvents (T061).
- [x] Normalize cancellation outcomes and redacted-order passenger enrichment within `SupplierOrderModule`; remove supplier shapes from `booking-recovery.service.ts` (T062).
- [x] Consume normalized freshness and passenger-provenance facts in `chat-handoff.service.ts` (T063).
- [x] Accept and return strictly canonical offers in `flight-search-orchestrator.service.ts`; retire live domain raw-offer parser (T064).
- [x] Rename cancellation quote ID helpers and types to Supplier vocabulary with wire aliases preserved (T065).
- [x] Resolve agent security performance gate failure with owned-process timing mitigation (T066).
- [x] Honor `DATABASE_URL` override in Playwright API test launcher for isolated test DB execution (T067).

Exit gate:
```text
boundary census clean (0 unexplained leaks); domain orchestrators consume canonical offers; agent security performance gate green; dedicated test db isolation verified
```

