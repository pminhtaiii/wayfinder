# Active Feature

This file points to the current feature state and its evidence; it is not a task-status ledger.

## Current state and resume pointers (2026-10-09)

- Read current task completion only from [the canonical Feature 030 task ledger](../specs/030-fulfillment-recovery-acceptance/tasks.md). Derive the first unchecked task when resuming; do not maintain another status list here.
- Read recorded test evidence and remaining gate results from the [Phase 2 verification record](../specs/030-fulfillment-recovery-acceptance/verification-phase2.md).
- Follow [Agent Coordination](workflow.md#agent-coordination-task-briefs-handoffs-and-reviews) for task briefs, live handoffs, review snapshots, and reports. The `agent:context handoff` command derives its candidate from the task ledger.
- This retro documentation checkpoint does not activate Feature 030 implementation or change its status. When Feature 030 work is separately authorized, derive its first unchecked task from the ledger; existing workflow and design-approval gates still apply.

## Historical checkpoints

## Feature 030 Phase 2 checkpoint (2026-10-08)

Phase 1 setup T001–T002 and original Phase 2 tasks T003–T016 are implemented and committed. The task ledger now marks T005 and T008 complete to match their reviewed implementation and test reports. This is a foundation and controlled-harness checkpoint, not full Feature 030 acceptance.

The production recovery flag remains false. Durable journal services are wired but the production booking path is not yet routed through recovery operations; no live recovery, payment checkout, reconciliation, or operator flow is claimed. See the [Phase 2 verification record](../specs/030-fulfillment-recovery-acceptance/verification-phase2.md) for task evidence, local gates, and remaining limits.

Verified task slices:
- T003/T006: six migration and reservation-reader integration cases passed; Prisma validation/generation, API typecheck, and lint passed.
- T004/T007: 20 real-PostgreSQL claim, renewal, takeover, fence, and callback-expiry rollback cases passed.
- T005/T008: 35 provider-operation, workflow, and migration integration cases passed after the monotonic-outcome fix; the 119-suite / 2,173-test API unit run and API typecheck/lint passed.
- T009: nullable-ID/RESERVED compatibility coverage passed 192 tests and real Nest module-composition coverage passed 3 tests; API typecheck, lint, build, and 212-entry partition checks passed.
- T010/T011: guarded Stripe/supplier transport tests passed 49/49; API partition covered 216 suites exactly once.
- T012/T013: guarded driver/bootstrap tests passed 12/12 with owned schema/Redis cleanup and zero reported leaks.
- T014: isolated Stripe browser fixture passed 2/2; T015 virtual scheduler passed 8/8 and kept a real five-second DB lease unchanged during a 15-minute virtual advance.
- T016: real Nest and Next startup/health/teardown smoke passed 17/17; API/web typechecks and lints, API build, and production-artifact exclusion checks passed.

Current guarded local pre-PR gates passed: CI workflow contract 24/24; API unit 119 suites / 2,173 tests; API contract 2 suites / 8 tests; API component 22 suites / 276 tests after correcting the test environment; shared types 111 tests; API partition 216/216; and performance unit 1 suite / 3 tests. API and web production builds passed. These results do not turn the full API integration lane green.

Integration remains unresolved. The earlier full run passed 69/72 suites and 687/701 tests; 11 T013 driver failures were caused by using the run-scoped application database URL where the driver requires its separate unscoped admin URL. T013 now uses that separate URL while retaining strict app URL validation, but the full lane has not been rerun. Focused diagnostics then found one Agent Gateway fixture returning FEATURE_DISABLED because its flag is set after AppModule loads, and two passenger confirmation cases returning PENDING at about 25 seconds, matching the existing 25-second safety timeout. The approved fixture startup-order correction is active; the internal wait behind the passenger timeout remains undiagnosed. Safety guards, timeout, and assertions remain intact.

T017 and later user-story, rollout, convergence, and acceptance tasks remain open. T053/T054 and final convergence, dual-axis review, and PR CI have not run. Do not mark Feature 030 complete or enable recovery.

## Retro documentation sync (2026-10-09)

Updated the TypeScript guidance and its library-docs pointer, documented diff-aware enforcement, clarified verification reporting, corrected the PowerShell gate example, and moved the current Feature 030 checkpoint to the top.

## Retro API checkout safety checkpoint (2026-10-09)

Added the API task runner to serialize Prisma generation, builds, and Jest tasks within one checkout, reject concurrent
ownership, and clear inherited Duffel override variables for isolated tests. CI routes Prisma generation through the
package alias and supplies an explicit unscoped admin URL for the disposable integration database. The real component
regression passed 32/32 with inherited Duffel mock overrides and the network guard enabled. Combined API runner and CI
contracts passed 43 tests with one POSIX signal-forwarding case skipped on Windows; guarded API build and Prisma
generation, lint, typecheck, and the exact 216-suite partition passed, and `.scratch/api-task.lock` was absent after the
run. Full database integration and the full Docker image build were not run. This tooling checkpoint does not change
Feature 030 status; its integration lane and passenger confirmation timeout diagnosis remain open.

## Retro handoff tooling verification (2026-10-09)

The helper returned the expected task contexts for T006, T017, and T030; combined helper and CI checks passed 35/35 (6 helper, 29 CI). A stale snapshot correctly rejected two changed files, and a fresh 8-file snapshot verified unchanged. This tooling result does not change Feature 030 task or rollout status.

---

## Handoff Origin Policy (Design Accepted; Implementation Pending)

- **Decision record**: [Handoff origin policy grilling session](../docs/adr/research-handoff-origin-policy-grilling-session.md).
- **Direction**: One shared policy for entry and checkout proxy; malformed explicit configuration rejects everywhere, missing configuration falls back only in local development, request evidence is validated strictly, and redirects use the resolved trusted origin.
- **Failure semantics**: Configuration failures return non-cacheable 503 responses; rejected evidence returns non-cacheable 403 responses, both before authentication or backend calls.
- **Status**: Interview decisions accepted on 2026-10-06. Application implementation and verification remain pending.
## CI Test Suite Separation (Implemented; Verification Limits Recorded)

- **Goal**: Separate unit, interface/component, infrastructure integration/migration, and performance results while preserving existing required coverage.
- **Direction**: Independent suite commands and named change-aware CI jobs, a shared smoke/critical-flow startup, and one required `ci-status` aggregate.
- **Decision record**: [CI test boundaries](../docs/adr/research-ci-test-boundaries-grilling-session.md).
- **Exit gates**: Exhaustive suite partition checks, focused runner checks, workflow/status contract tests, package lint/typechecks, and independent review. Infrastructure-backed checks require available disposable services; record any unexecuted checks explicitly.
- **Delivered**: Four API test lanes, web unit/browser-interface lanes, three agent lanes, independent local commands, and fail-closed `ci-status` aggregation. Shared smoke/critical-flow startup is retained.
- **Verified**: All 206 existing required API suites classified exactly once; web isolated Node tests 420/420; agent isolated tests 1,290 passed/4 skipped before additional guard regressions; CI contracts 40/40; network/smoke-runner checks 25/25; focused disposable-database API tests 18/18; package lint/typechecks and independent reviews passed.
- **Limits**: Browser characterization passed 14/16 with navigation timeout/route expectation failures. Optional web route-contract cases fail locally (56/64); two unchanged agent benchmark latency assertions fail on this Windows host. One Redis wait-time check passed in isolation after a timing failure in the full Redis lane. Remote CI, the full API runtime matrix, and T093 were not rerun. See the decision record for exact results and final browser/guard verification.

---

## Feature 029 — Narrow the Duffel Supplier Boundary (Complete)

- **Status**: Complete; implementation, integration, and T093 real-flow acceptance are verified
- **Branch**: `codex/029-duffel-provider-narrowing`
- **Specification**: [specs/029-duffel-provider-narrowing/spec.md](../specs/029-duffel-provider-narrowing/spec.md)
- **Implementation Plan**: [specs/029-duffel-provider-narrowing/plan.md](../specs/029-duffel-provider-narrowing/plan.md)
- **Tasks**: [specs/029-duffel-provider-narrowing/tasks.md](../specs/029-duffel-provider-narrowing/tasks.md)

### Current Summary
PR [#371](https://github.com/pminhtaiii/wayfinder/pull/371) merged into `development` at `8efbfc5aff4eea7179ef83529d11898b7e8477fb`; its tested source HEAD is `791947c365c95e2721893c90cc3d92a433938117`. Exact-source CI run [37278447237](https://github.com/pminhtaiii/wayfinder/actions/runs/37278447237) succeeded. Its API unit job passed all 135 suites, including `supplier-sync.service.spec.ts`, and its API E2E job passed 71/71 suites. The local T055 API invocation remains partial at 134/135 suites and 2,367/2,385 tests because the database-backed suite was unavailable in that invocation; remote CI supplies coverage for that suite without changing the local result. T093 passed: the corrected full-flow Playwright run exited 0 with one Chromium test passing in 4.9 minutes against a fresh disposable database after 25 migrations and seeding 4,562 airports, including SGN and HAN. The documented timeout values were set in the Playwright process; application source and test assertions were unchanged. Only the runner-owned PostgreSQL and Redis containers were stopped, and existing containers remained untouched. See the [Feature 029 verification record](../specs/029-duffel-provider-narrowing/verification.md) for the final acceptance result and historical attempts.

Historical Slice 6.2 (T047–T054: Neutral Names and Physical Schema) completed on remote CI. The forward migration `20260929000000_supplier_identifiers` renamed all 11 non-webhook columns and 5 dependent indexes without `@map` annotations. Dedicated disposable databases `feature029_slice62_fresh` and `feature029_slice62_upgrade` verified the full migration chain and upgrade path with 16 preserved sentinels, 12 links, and null controls. Consumer modules across booking, payment, cancellation, disruption, and agent gateway were migrated without type assertions; public wire compatibility and signed `sel_v1_` HMAC bytes were preserved. That slice's local validation recorded API 134 suites/2,337 tests, 66/66 affected E2Es, contracts 111/111, web compatibility 122/122, and clean typechecks and ESLint. Standards and Spec reviews completed with findings addressed.

Earlier integration history: PR [#369](https://github.com/pminhtaiii/wayfinder/pull/369) (Part 1) merged into `development` (`09806abd`); PR #368 closed without merging. Historical slice PR [#370](https://github.com/pminhtaiii/wayfinder/pull/370) (Part 2) replaced #368 and merged into `development`. PR #370’s final pushed HEAD `551c3890cd37f65ded2adf900244fc9ca0d76dd8` was verified by remote CI run [37188540602](https://github.com/pminhtaiii/wayfinder/actions/runs/37188540602), with all 12 jobs successful. See the Slice 6.2 verification record (retired document; available in Git history) for that historical slice’s PR history and job results.

Phase 9 convergence (T059–T067), Phase 7 Boundary Census (T056), T055–T057 final verification, and the T093 real-flow acceptance gate are complete. The census found zero unexplained runtime provider hits, with `@duffel/api` confined to four supplier adapter files and non-webhook database names neutralized. T059–T067 resolved the recorded boundary and gate findings: supplier travel, completion, expiry, and passenger facts flow through `FLIGHT_SEARCH_PORT`; booking snapshots and cancellation outcomes are normalized at supplier boundaries; cancellation quote helpers use Supplier vocabulary with wire aliases preserved; the agent security performance gate is green; and the Playwright API launcher honors the caller database URL. PR #371 is merged and exact-source CI is recorded above. T093 final passing run is documented in the verification record.

Review follow-up: Prisma consumers and database fixtures use the renamed supplier fields, with explicit mappings preserving existing HTTP keys, signed selection payloads, and `DuffelWebhookEvent.duffelOrderId`. The final expiry-normalization correction and regression cases are included in tested source HEAD `791947c365c95e2721893c90cc3d92a433938117`, covered by exact-source CI run [37278447237](https://github.com/pminhtaiii/wayfinder/actions/runs/37278447237). That CI run did not execute the separate T093 real-flow Playwright gate.

T044–T046 pin signed bytes, legacy snapshots, strict agent state, and web provider-ID boundaries. Independent task reviews and scoped convergence passed at the historical Slice 6.1 checkpoint. Its local validation included guarded API 130 suites/2,331 tests, shared 111 tests, web 120 focused tests/build, and agent 1,291 non-Redis tests. See the Slice 6.1 verification record (retired document; available in Git history) for approvals, mutations, environment retries, and exact commands. At that checkpoint T047–T057 were still pending; later slice and integration status is recorded above. Feature 029 had not yet reached final acceptance at that historical checkpoint.

Phases 0–5 are complete locally. T042 removed the legacy `DuffelService`/`DuffelModule` monolith. T058 removed global visibility from `DuffelCoreModule`, and its negative Nest composition regression proves an unrelated module cannot resolve `DUFFEL_SDK`. T043 passed the guarded API suite (130 suites/2,326 tests), all 16 affected database E2E suites (145 tests), order and ancillary capability checkpoints, shared/static contracts, TypeScript, and lint. The final local evidence and scoped convergence recheck are in the Slice 5 verification record (retired document; available in Git history). This is the historical Slice 5 checkpoint; at that point Phase 7 and final Feature 029 acceptance were still pending. Slice 6.2 remote verification is recorded above. Historical T040/T041 evidence is in the Slice 4 verification record (retired document; available in Git history); earlier T039 validation and Slice 3 findings are in the Slice 3 verification record (retired document; available in Git history).

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

### Phase 7 — Final Verification & Audit (T055–T057; T093 acceptance complete)
- [x] Record API/shared/web/agent, E2E, security, and remote CI gate results (T055; local API result is partial, with remote CI evidence recorded separately).
- [x] Audit supplier boundary and provider-name compatibility exceptions (T056).
- [x] Synchronize implemented architecture, progress, and relevant library guidance (T057).

Exit gate:
```text
T055–T057 evidence recorded; PR #371 merged to development; exact-source CI passed; T093 full real-flow Playwright acceptance passed; Feature 029 complete
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
