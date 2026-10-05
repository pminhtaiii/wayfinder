# Feature 029 Verification: Narrow the Duffel Supplier Boundary

## Phase 1: Setup and Behavior Baseline (T001–T004)

Run from `C:\Booking Systems` on 2026-09-29. All commands exited with code 0.

### Verification Matrix

| Check | Command | Result |
| --- | --- | --- |
| **Phase 1 Jest Matrix (Full)** | `pnpm --filter @api/backend exec jest --runInBand src/duffel/duffel.service.spec.ts src/flights/flights.service.spec.ts src/flights/flight-search-orchestrator.service.spec.ts src/duffel/duffel-ancillary.service.spec.ts src/payment/ancillary-payment-validation.service.spec.ts src/duffel/duffel-fulfillment.adapter.spec.ts src/payment-fulfillment/payment-fulfillment.saga.spec.ts` | **PASS**: 7 suites passed, 260 tests passed, 0 failed (~48.34s). |
| **Quickstart Baseline Checkpoint** | `pnpm --filter @api/backend exec jest --runInBand src/duffel/duffel.service.spec.ts src/flights/flights.service.spec.ts src/flights/flight-search-orchestrator.service.spec.ts` | **PASS**: 3 suites passed, 128 tests passed, 0 failed (~22.43s). |
| **TypeScript Typecheck** | `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` | **PASS**: Exit 0; 0 compilation errors across backend API. |
| **Private SDK Indexing Census** | `Get-ChildItem -Path "apps/api/src" -Recurse -Filter "*.ts" \| Select-String -Pattern "duffelService\['duffel'\]"` | **PASS**: 0 matches found in `apps/api/src`. |
| **Broad Bracket Access Census** | `Get-ChildItem -Path "apps/api/src" -Recurse -Filter "*.ts" \| Select-String -Pattern "\['duffel'\]"` | **PASS**: 0 matches found in `apps/api/src`. |

---

### Task Implementation Details

#### T001: Flight Search & Offer Detail Baseline Characterization
- Characterized raw vs cached flight searches (user and agent scopes).
- Characterized deterministic UUID generation and result ordering based on search hash and rank.
- Characterized rate budget enforcement (caller and global limits).
- Characterized all 10 live offer detail scenarios (successful retrieval, price drift detection, 404 purge, 410 purge, purge failure resilience, upstream 500 error mapping, DuffelTimeoutError translation without DB purge, fallback to offerRecovery on purged offer, 404 for missing valid UUID, and 400 for invalid UUID format) in `duffel.service.spec.ts` and `flights.service.spec.ts`.

#### T002: Ancillary Catalog & Repricing Characterization
- Characterized seat-map caching, TTLs, and missing-map fallbacks in `duffel-ancillary.service.spec.ts`.
- Characterized service quarantine for invalid or missing seat/baggage records.
- Characterized priced-offer validation, passenger-scope checks, and amount/currency reconciliation in `ancillary-payment-validation.service.spec.ts`.

#### T003: Fulfillment Adapter & Payment Saga Compensation Characterization
- Characterized create/retrieve/cancel operations, order idempotency, and semaphore concurrency gating in `duffel-fulfillment.adapter.spec.ts`.
- Characterized PII redaction in persisted order snapshots and payment logs.
- Characterized compensation and replay paths, unconfirmed cancellation handling, and fencing in `payment-fulfillment.saga.spec.ts`.

#### T004: Seal Private SDK Access & Verify Baselines
- Replaced the private bracket escape hatch in `apps/api/src/flights/flights.service.ts`:
  ```typescript
  // Before:
  const duffelResponse = await this.duffelService['duffel'].offers.get(
    flightOffer.duffelOfferId,
  );
  liveOffer = duffelResponse.data;

  // After:
  liveOffer = (await this.duffelService.getOfferById(
    flightOffer.duffelOfferId,
  )) as Record<string, unknown>;
  ```
- Updated unit test mocks in `apps/api/src/flights/flights.service.spec.ts`:
  - Removed `mockOffersGet` and the nested `duffel: { offers: { get } }` mock shape.
  - Added typed `getOfferById: jest.Mock` to `duffelService`.
  - Updated and characterized all 10 flight detail test scenarios (successful retrieval, price drift detection, 404 purge, 410 purge, purge failure resilience, upstream 500 error mapping, DuffelTimeoutError translation without DB purge, fallback to offerRecovery, 404 for missing valid UUID, and 400 for invalid UUID format) to mock and assert `duffelService.getOfferById`.
- Verified zero instances of private SDK bracket access remain in `apps/api/src`.
- Confirmed full clean build and typecheck with zero compiler warnings or errors.

---

### Invariants Verification
- **Zero `any` in new code or test fixtures**: `liveOffer` in `flights.service.ts:getFlightDetail` continues to be declared as `Record<string, any>` internally; the cast to `Record<string, unknown>` at the public `getOfferById` callsite does not remove this internal type declaration (full cleanup scheduled for Phase 3). All new test fixtures and mocks avoid `any`.
- **No functional regressions**: All 260 characterization tests passed without changes to public interfaces or business behaviors.
- **Phase 1 Convergence**: Tasks T001, T002, T003, and T004 in `specs/029-duffel-provider-narrowing/tasks.md` are marked `[x]`.

---

## Phase 2: Foundational Duffel Core and Shared Budget (T005–T012)

Run from `C:\Booking Systems` on 2026-09-29. All commands exited with code 0.

### Verification Matrix

| Check | Command | Result |
| --- | --- | --- |
| **Phase 2 Core & Consumer Jest Matrix** | `pnpm --filter @api/backend exec jest --runInBand src/supplier/core/duffel-core.module.spec.ts src/supplier/core/duffel-rate-budget.service.spec.ts src/cache/cache.service.spec.ts src/duffel/duffel.service.spec.ts src/flights/flights.service.spec.ts src/disruption/sync/reconciliation.service.spec.ts` | **PASS**: 6 suites passed, 133 tests passed, 0 failed (~53.63s). |
| **TypeScript Typecheck** | `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` | **PASS**: Exit 0; 0 compilation errors across backend API. |
| **Obsolete Monthly Budget Census** | `Get-ChildItem -Path "apps/api/src" -Recurse -Filter "*.ts" \| Select-String -Pattern "budget:duffel:\$\{"` | **PASS**: 0 matches found in `apps/api/src`. |
| **Active Duffel Budget Key Census** | `Get-ChildItem -Path "apps/api/src" -Recurse -Filter "*.ts" \| Select-String -Pattern "budget:duffel:"` | **PASS**: All occurrences reference daily keys (`budget:duffel:daily:...`). No monthly counter remains active. |

---

### Task Implementation Details

#### T005: Core Module & SDK Provider Baseline Tests
- Verified singleton Duffel SDK instance construction.
- Validated `DUFFEL_ACCESS_TOKEN` validation, `DUFFEL_API_URL` parsing, base path normalization, and protocol rejection (non-http/https) in `duffel-core.module.spec.ts`.

#### T006: Budget Service & Atomic Cache Concurrency Tests
- Added concurrency and fail-closed tests in `duffel-rate-budget.service.spec.ts` and `cache.service.spec.ts`.
- Verified UTC midnight expiration, dual counter atomicity (global daily total + caller-specific limits), and Redis outage resilience.

#### T007: Atomic Check-and-Increment Operation
- Implemented `checkAndIncrWithLimits` in `apps/api/src/cache/cache.service.ts` using an atomic Lua script for Redis.
- Enforced fail-closed behavior when Redis is unavailable, returning a typed unavailable error.

#### T008: Singleton SDK Provider & DuffelCoreModule
- Implemented `duffelSdkProvider` providing `DUFFEL_SDK` in `apps/api/src/supplier/core/duffel-sdk.provider.ts`.
- Exported `DUFFEL_SDK` and `DuffelRateBudgetService` via `apps/api/src/supplier/core/duffel-core.module.ts`.

#### T009: Daily Rate Budget Reservation Service
- Implemented `DuffelRateBudgetService` with `reserveAttempt(extraConstraint?)`.
- Enforces daily UTC total cap of 1,500 attempts with optional caller constraints (e.g. user 1,000, agent 500).
- Emits typed errors with retry timestamp (next UTC midnight for quota exhaustion, bounded backoff for store outage).

#### T010: Route DuffelService Attempts Through Core Reservation
- Injected `DuffelRateBudgetService` into `DuffelService`.
- Routed raw flight search, live offer lookup, seat-map retrieval, priced offer fetch, order creation, order retrieval, cancellation quote, and order cancellation attempts through `reserveBudgetAttempt()`.
- Handled parallel seat-map/services and order retries with per-attempt metering.

#### T011: Migrate Disruption Reconciliation Off Monthly Budget
- Removed legacy monthly budget keys (`budget:duffel:${year}-${month}`) from `DuffelService` and `ReconciliationService`.
- Handled typed `RATE_LIMIT_EXCEEDED` errors in `ReconciliationService`, recording `budgetBlocked` metrics and deferring sync without decrement or double-charging.

#### T012: Wire DuffelCoreModule & Checkpoint Validation
- Imported and registered `DuffelCoreModule` in `apps/api/src/duffel/duffel.module.ts`.
- Typed `createCancellationQuote` with `DuffelCancellationQuote` ensuring type safety across consumer services.
- Ran the 6 core/duffel/flights/reconciliation test suites (133 tests passed).
- Confirmed clean TypeScript typecheck across backend API.
- Confirmed zero occurrences of obsolete monthly budget keys.

---

### Invariants Verification
- **Zero `any` in new code or test fixtures**: All newly created types and providers adhere to strict typing (`DuffelCancellationQuote`, `DuffelRateBudgetService`).
- **All Duffel attempts share daily budget**: Total daily attempts capped at 1,500 via atomic Redis Lua script; no monthly counter active.
- **Phase 2 Convergence**: Tasks T005 through T012 in `specs/029-duffel-provider-narrowing/tasks.md` are marked `[x]`. Phase 2 foundation is complete.

## Phase 4: Ancillary Capability Isolation (T025–T031)

Run from `C:\Booking Systems` on 2026-10-01. T030 rewiring and the T031 checkpoint passed locally.

### T031 Checkpoint

| Check | Command | Result |
| --- | --- | --- |
| **Phase 4 Quickstart Jest Checkpoint** | `pnpm --filter @api/backend exec jest --runInBand src/supplier/ancillary src/ancillaries src/payment/ancillary-payment-validation.service.spec.ts` | **PASS**: 11 suites passed, 153 tests passed, 0 failed; exit code 0 (~44.11s). |
| **API TypeScript Check** | `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` | **PASS**: Exit code 0; no compiler diagnostics. |
| **Supplier Ancillary Module E2E (additional mocked check)** | `pnpm --filter @api/backend exec jest --runInBand --config test/jest-e2e.json test/supplier-ancillary.e2e-spec.ts` | **PASS**: 1 suite passed, 1 test passed, 0 failed; exit code 0 (~47.04s). |
| **Ancillary/Payment Legacy Boundary Census** | `rg -n --glob "*.ts" -e "DuffelService" -e "DuffelModule" apps/api/src/ancillaries apps/api/src/payment/ancillary-payment-validation.service.ts apps/api/src/payment/payment.module.ts` | **PASS**: No production ancillary/payment-validation references. The only three matches are test assertions naming `DuffelModule` to verify it is absent. |
| **Full API Network-Guard Gate (additional)** | `pnpm --filter @api/backend test:ci` (with `NODE_OPTIONS` requiring `tests/ci/node-network-guard.cjs`) | **PASS**: 127 suites passed, 2,312 tests passed, 0 failed; exit code 0. |
| **CI Workflow Contract** | `node --test tests/ci/ci-workflow.contract.test.mjs` | **PASS**: 23 tests passed, 0 failed. |
| **Shared Types** | `pnpm --filter @shared/types test` | **PASS**: 110 tests passed, 0 failed. |
| **API/Shared ESLint** | `pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0` | **PASS**: Exit code 0; 0 warnings and errors. |

`PaymentModule` imports `SupplierAncillaryModule` directly. The passing ancillary and payment validation suites cover catalog/cache/freshness, missing-seat-map fallback, passenger scoping, repricing, validation, and payment-bound totals. The full API run and ancillary E2E used mocked external boundaries. Remote CI is not claimed here.

### Scoped Convergence: T030/T031

✅ **Converged for this slice** against spec FR-005, FR-010, and FR-012 and the supplier boundary contract's ancillary capability: ancillary/payment consumers use `DuffelAncillaryService` through `SupplierAncillaryModule`; catalog and authoritative repricing behavior remain covered; existing consumer contracts are unchanged; the focused Jest, E2E, compile, and boundary checks pass. Later order extraction, monolith deletion, naming/migration, and final audit tasks remain pending and are outside T030/T031.

### Task Implementation Details

#### T030: Consumer Rewiring
- `AncillaryCatalogService` and `AncillaryPaymentValidationService` now consume `DuffelAncillaryService`.
- `AncillariesModule` and `PaymentModule` import `SupplierAncillaryModule`; the catalog fingerprint, request-scoped identity checks, lease lifecycle, currency checks, and supplier-authoritative repricing totals remain covered by the focused tests.
- Consumer tests use the ancillary capability boundary. T030 was committed as `b44b98c4` after review approval.

#### T031: Phase 4 Checkpoint
- Ran the exact Phase 4 checkpoint and TypeScript command from `specs/029-duffel-provider-narrowing/quickstart.md`; both exited 0.
- Ran the supplier ancillary module E2E with mocked SDK/cache boundaries as an additional check.
- Confirmed no production `DuffelService` or `DuffelModule` references remain in the ancillary consumers or ancillary payment validation service. The Phase 4 checkpoint is complete locally.

## Phase 5 Slice 1: Order Capability (T032–T034)

### Current status

- **T032 — Complete:** Order-operation parity characterization, including the manual order POST request shape, was committed as `93fe963a` (`test(supplier): lock order operation parity`) and reviewed/approved.
- **T033 — Complete:** Original implementation commit `1739d209`, correction commit `acc77e0b`, privacy-parity fix `164af26d`, and human-approved type-only fixture annotation `25ff5e60`. Commit `164af26d` restored generic legacy confirmation/retrieval messages; `25ff5e60` changes fixture types only. The user-approved strict confirmation and non-JSON handling is preserved in current head `f3793c26`. Code review returned GO after three fixes. The legacy fulfillment adapter maps pending, negative, and invalid cancellation outcomes to `false`, so the saga retains the hold, processing state, checkpoint, and order evidence. Recovery rejects non-record responses and generic “cannot be cancelled” errors instead of treating them as already cancelled. Scoped convergence across T032–T034 found zero gaps across 3 FRs, 3 US3 acceptance criteria, 2 success criteria, 4 boundary edges, 5 plan decisions, and 5 constitution requirements.
- **T034 — Complete:** The metered `DuffelOrderAdapter` and shared core configuration provider were committed as `2675a0f2`; review returned GO with no Important or Critical findings. It covers manual order POST, quote creation, quote confirmation, cancellation, active-order retrieval, and complete-order retrieval.
- T035–T043 remain pending, including order consumer rewiring. No remote CI status is claimed.

### Local verification recorded for this slice

| Check | Result |
| --- | --- |
| Focused order adapter/fulfillment Jest suites after T034 | **PASS**: 5 suites, 105 tests. |
| Corrected T033 adapter/recovery/saga Jest suites | **PASS**: 3 suites, 138 tests. |
| Final order + legacy supplier Jest check | **PASS**: 2 suites, 54 tests. |
| Payment fulfillment focused E2Es after fixture correction `34b2db3b` | **PASS**: 2/2 against the isolated task database; assertions unchanged. |
| API TypeScript check | **PASS**. |
| All-file API/shared ESLint | **PASS**. |
| Targeted spec lint | **PASS**. |
| Shared types tests | **PASS**: 110 tests. |
| CI workflow contract tests | **PASS**: 23 tests. |
| Full API unit run at `f3793c26` | **PASS**: 128 suites, 2,359 tests. TypeScript check and full API/shared ESLint also pass. The earlier 128-suite/2,346-test run in `api-final-signoff.log` remains a valid historical checkpoint. |

These results record local checks only. T032–T034 checks, code review, scoped convergence, the latest API unit run, and focused E2Es pass. Standards review has 0 open findings and 2 resolved; Spec review is GO. The two human-approved E2E fixture corrections are committed as `34b2db3b` without changing assertions. PR #361 remote CI remains pending push; a green CI result on documentation checkpoint `7af33a78` is historical and does not establish CI status for the current PR head. T035–T043 and broader Phase 5 work remain pending.

---

## Phase 7: Boundary and Provider-Name Census (T056)

Executed from `c:\Booking Systems` on 2026-10-05 across:
- `apps/api/src/`
- `packages/shared/src/`
- `apps/web/`
- `apps/agent/src/`
- `apps/api/prisma/schema.prisma`

### 1. Invariant & Boundary Audit Summary

| Audit Item | Target / Invariant | Result | Status |
| --- | --- | --- | --- |
| **`DuffelService` in Production** | Exactly 0 references across all production code | **0 hits** across all production source files | **PASS** |
| **`DuffelModule` in Production** | Exactly 0 references across all production code | **0 hits** across all production source files | **PASS** |
| **Absent-Assertions in Tests** | Only negative assertions permitted | **3 hits** in `ancillaries.module.spec.ts:21, 34, 38` | **PASS** |
| **Private SDK Bracket Access `['duffel']`** | Exactly 0 references repository-wide | **0 hits** in `apps/api/src/`, `packages/shared/src/`, `apps/web/`, `apps/agent/src/` | **PASS** |
| **`@duffel/api` Imports** | Strictly isolated to concrete supplier adapters/providers | **4 production files**, all inside `apps/api/src/supplier/` (`core`, `search`, `ancillary`, `order`) | **PASS** |
| **Prisma Physical Columns & Indexes** | Non-webhook models must use neutral names (`supplier...`) | All non-webhook columns/indexes use `supplier...` (`supplierOfferId`, `supplierOrderId`, `supplierCancellationQuoteId`, `supplierOfferIdHash`); only webhook table `DuffelWebhookEvent` (`duffel_webhook_events`) retains `duffelOrderId` | **PASS** |
| **Module Graph & Dependency Flow** | Capability-to-core direction, non-global core, narrow ports | `DuffelCoreModule` has no `@Global()`; imported only by 3 supplier capability modules; `SupplierSearchModule` exports only `FLIGHT_SEARCH_PORT`; zero domain consumers import Duffel core | **PASS** |

---

### 2. Concrete SDK Imports Audit (`@duffel/api`)

Production files importing `@duffel/api`:
1. `apps/api/src/supplier/core/duffel-sdk.provider.ts` (line 2): Singleton SDK factory & config validator.
2. `apps/api/src/supplier/search/duffel-search.adapter.ts` (line 10): Concrete search & offer retrieval SDK calls.
3. `apps/api/src/supplier/ancillary/duffel-ancillary.adapter.ts` (line 2): Seat map & available services SDK calls.
4. `apps/api/src/supplier/order/duffel-order.adapter.ts` (line 2): Order creation, cancellation quote, & order retrieval SDK calls.

Test files importing `@duffel/api` for typing mock instances:
- `apps/api/src/ancillaries/ancillaries.service.spec.ts` (line 2): `import { Duffel } from '@duffel/api'` (test double typing).
- `apps/api/src/payment/ancillary-payment-validation.service.spec.ts` (line 1): `import { Duffel } from '@duffel/api'` (test double typing).
- `apps/api/src/supplier/ancillary/duffel-ancillary.adapter.spec.ts` (line 3)
- `apps/api/src/supplier/ancillary/duffel-ancillary.capability.spec.ts` (line 3)
- `apps/api/src/supplier/ancillary/supplier-ancillary.module.spec.ts` (line 3)
- `apps/api/src/supplier/core/duffel-core.module.spec.ts` (line 3)
- `apps/api/src/supplier/order/duffel-order.adapter.spec.ts` (line 1)
- `apps/api/src/supplier/search/duffel-search.adapter.spec.ts` (line 9)

Zero imports exist in `packages/shared/src/`, `apps/web/`, or `apps/agent/src/`.

---

### 3. Classification of All Legitimate Provider-Named (`duffel`) Occurrences

Every remaining identifier containing `duffel` (case-insensitive) across production source files falls into one of four approved architectural categories:

#### Category A: Concrete Supplier SDK Core & Adapters (`apps/api/src/supplier/`)
- `apps/api/src/supplier/core/duffel-core.module.ts`: Non-global encapsulation of SDK & budget providers.
- `apps/api/src/supplier/core/duffel-sdk.provider.ts`: `DUFFEL_SDK` provider, `DUFFEL_SDK_CONFIGURATION`.
- `apps/api/src/supplier/core/duffel-rate-budget.service.ts`: Daily rate budget enforcement.
- `apps/api/src/supplier/search/duffel-search.adapter.ts`: Concrete Duffel search adapter.
- `apps/api/src/supplier/search/duffel-search.service.ts`: Metered search service implementing `FlightSearchPort`.
- `apps/api/src/supplier/search/flight-offer.normalizer.ts`: Maps raw Duffel offer payloads to canonical `FlightOffer`.
- `apps/api/src/supplier/ancillary/duffel-ancillary.adapter.ts`: Concrete seat map/services adapter.
- `apps/api/src/supplier/ancillary/duffel-ancillary.service.ts`: Metered ancillary operations.
- `apps/api/src/supplier/ancillary/ancillary.normalizer.ts`: Maps raw Duffel seatmaps/services to domain catalog.
- `apps/api/src/supplier/order/duffel-order.adapter.ts`: Metered order, quote, & order retrieval adapter.
- `apps/api/src/supplier/order/duffel-fulfillment.adapter.ts`: Implements `FULFILLMENT_GATEWAY_PORT`.
- `apps/api/src/supplier/order/duffel-cancellation.service.ts`: Concrete cancellation quote & confirm service.
- `apps/api/src/supplier/order/duffel-recovery.service.ts`: Order retrieval & snapshot mapping service.
- `apps/api/src/supplier/order/order-snapshot.normalizer.ts`: Maps raw Duffel order payloads into neutral `FlightSnapshot` / `PassengerSnapshot`.
- `apps/api/src/duffel/duffel.types.ts` & `cancellation-confirmation.ts`: Concrete upstream Duffel TypeScript wire contracts.

#### Category B: Duffel Webhook Subsystem (`apps/api/src/disruption/webhook/` & `schema.prisma`)
- `apps/api/prisma/schema.prisma` (lines 799–918): `DuffelWebhookEvent` model and `DuffelWebhookEventStatus` enum in table `duffel_webhook_events`.
- `apps/api/src/disruption/webhook/duffel-webhook.controller.ts`: Webhook listener for Duffel order change events.
- `apps/api/src/disruption/webhook/duffel-signature.service.ts`: HMAC signature verification using `DUFFEL_WEBHOOK_SECRET`.
- `apps/api/src/disruption/webhook/duffel-inbox.service.ts`: Webhook inbox deduplication & persistence.
- `apps/api/src/disruption/webhook/duffel-event.processor.ts`: Asynchronous event processing worker.
- `apps/api/src/disruption/webhook/duffel-processor-health.service.ts` & `health.controller.ts`: Webhook queue health metrics.
- `packages/shared/src/disruption-types.ts`: `AdminDuffelWebhookEventDto` and `DuffelWebhookEventStatus`.

#### Category C: Wire & HMAC Attestation Compatibility DTOs / Aliases
- **Public API Wire DTOs** (`apps/api/src/flights/dto/search-flight.dto.ts`, `apps/api/src/agent-gateway/dto/attested-flight-search.dto.ts`):
  `duffelOfferId: string` preserved so existing frontend and Python agent clients continue receiving expected JSON wire properties.
- **HMAC Attestation Compatibility** (`apps/api/src/agent-gateway/selection-attestation.service.ts`, `attested-flight-search.service.ts`, `apps/api/src/chat-handoff/chat-handoff.service.ts`):
  Signed selection payloads (`sel_v1_`) contain `{ flightOfferId, duffelOfferId }` to ensure HMAC byte-level attestation validity across client-server handoff.
- **Wire Cancellation Quote Compatibility** (`apps/api/src/cancellation/cancellation.types.ts`, `booking-management/booking-management.service.ts`, `dto/booking-response.dto.ts`):
  `duffelCancellationQuoteId` and `duffelOrderId` wire fields and backward-compatible function alias `parseDuffelCancellationQuoteId` / `serializeDuffelCancellationQuoteId`.
- **Wire Ancillary Selection Compatibility** (`packages/shared/src/types/ancillary.types.ts`, `apps/api/src/ancillaries/ancillaries.service.ts`, `ports/fulfillment-gateway.port.ts`):
  `duffelPassengerId` wire field for selection payload compatibility.
- **Frontend Edge Ingestion** (`apps/web/lib/server/flight-search.ts:58`):
  `UpstreamOfferBaseSchema` reads upstream wire `duffelOfferId` and strips it before producing browser client views.
- **Python Agent Upstream Projection** (`apps/agent/src/agent/guardrails/schemas/tools.py:85`, `search_flights.py:168`):
  `SearchFlightUpstreamProjection` reads wire `duffelOfferId` and maps it immediately to internal `supplierOfferId`.

#### Category D: Persisted Historical Payment Evidence & Legacy Snapshot Readers
- **Saga Checkpoint & State Machine** (`apps/api/src/idempotency/payment-idempotency.service.ts:24, 31`, `apps/api/prisma/schema.prisma:617`):
  `recoveryPoint: 'duffel_order_created'` in `PaymentRecoveryPoint` union type and default progression.
- **Persisted Payment Events** (`apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts`, `apps/api/src/booking-lifecycle/booking-recovery.service.ts`):
  Reads historical `PaymentEvent` rows where `eventType: 'duffel_order_created'` or `eventType: 'duffel_order_cancelled'`.
- **Legacy Snapshot Readers** (`packages/shared/src/booking-types.ts:59`, `apps/api/src/booking-management/booking-management.service.ts:32-50`, `apps/api/src/disruption/domain/itinerary-normalizer.ts:61`):
  Reads optional legacy `duffelSegmentId` in historical flight snapshots stored in PostgreSQL JSON columns, seamlessly falling back from `supplierSegmentId`.
- **Security & Observability Guardrails** (`apps/agent/src/agent/graph/nodes.py:417`, `chat_observability.py:30, 52`):
  Rejects untrusted user-injected `duffelOfferId` at handoff roots and redacts `duffel_offer_id` from telemetry.

---

### 4. Verification Conclusion

Every single occurrence of `duffel` across the target directories has been identified, line-verified, and justified. Zero unexplained runtime hits exist. The boundary encapsulation is complete, types are clean, and non-webhook database columns are fully neutralized. Task T056 is complete.

---

## Phase 7: Pre-PR Gate Matrix and Validation (T055)

Executed from repository root `C:\Booking Systems` on 2026-10-05 on branch `codex/029-duffel-provider-narrowing`.

### 1. Pre-PR Validation Matrix Summary

| Gate / Suite | Target & Command | Exit Code | Result | Status |
| --- | --- | --- | --- | --- |
| **CI Workflow Contract** | `node --test tests/ci/ci-workflow.contract.test.mjs` | `0` | **PASS**: 24/24 subtests passed, 0 failures (~1.4s) | **PASS** |
| **Shared Contracts** | `pnpm --filter @shared/types test` | `0` | **PASS**: 111/111 tests passed, 0 failures (~2.5s) | **PASS** |
| **API ESLint** | `pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0` | `0` | **PASS**: 0 errors, 0 warnings across API and shared packages | **PASS** |
| **API Typecheck** | `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` | `0` | **PASS**: 0 compilation errors across backend API | **PASS** |
| **Quickstart Checkpoint 1 (Core & Search)** | `pnpm --filter @api/backend exec jest --runInBand src/supplier/core src/supplier/search src/flights src/agent-gateway/attested-flight-search` | `0` | **PASS**: 14 suites passed, 359 tests passed, 0 failures (~52.8s) | **PASS** |
| **Quickstart Checkpoint 2 (Ancillary)** | `pnpm --filter @api/backend exec jest --runInBand src/supplier/ancillary src/ancillaries src/payment/ancillary-payment-validation.service.spec.ts` | `0` | **PASS**: 11 suites passed, 153 tests passed, 0 failures (~60.0s) | **PASS** |
| **Quickstart Checkpoint 3 (Order & Recovery)** | `pnpm --filter @api/backend exec jest --runInBand src/supplier/order src/payment-fulfillment src/cancellation src/booking-lifecycle src/disruption/webhook` | `0` | **PASS**: 18 suites passed, 412 tests passed, 0 failures (~77.8s) | **PASS** |
| **Quickstart Checkpoint 5 (Contracts & Security)** | `pnpm --filter @api/backend exec jest --runInBand src/agent-gateway/selection-attestation.service.spec.ts src/agent-gateway/attested-flight-search src/booking-management src/disruption/webhook` | `0` | **PASS**: 9 suites passed, 122 tests passed, 0 failures (~39.4s) | **PASS** |
| **API Unit Suites (local)** | `$env:NODE_OPTIONS = '--require=C:\BOOKIN~1\tests\ci\node-network-guard.cjs'`; `pnpm --filter @api/backend test:ci` | `0` (excl. live DB) | **PARTIAL (local)**: 134/135 test suites passed, 2,367/2,385 tests passed; `supplier-sync.service.spec.ts` was not run because it requires active Docker PostgreSQL at `127.0.0.1:5432` | **PARTIAL** |
| **Web Typecheck** | `pnpm --filter @web/frontend typecheck` | `0` | **PASS**: 0 TypeScript errors across frontend application | **PASS** |
| **Web ESLint** | `pnpm --filter @web/frontend lint` | `0` | **PASS**: 0 errors, 0 warnings across web frontend | **PASS** |
| **Web Production Build** | `pnpm --filter @web/frontend build` | `0` | **PASS**: Next.js production build succeeded, 23/23 static pages generated | **PASS** |
| **Agent Ruff Check** | `uv run --package agent ruff check apps/agent` | `0` | **PASS**: 0 lint errors across Python agent service | **PASS** |
| **Agent Ruff Format** | `uv run --package agent ruff format --check apps/agent` | `0` | **PASS**: 0 formatting discrepancies across Python agent service | **PASS** |
| **Agent Pytest Suite** | `$env:PYTHONPATH = "tests/ci/python;apps/agent/src"`; `uv run --package agent pytest apps/agent/tests -m "not redis_integration"` | `0` | **PASS**: 1,295 passed, 11 skipped, 12 deselected, 0 failed under SC-004 ceilings via documented priority launcher | **PASS** |

---

### 2. Verification Conclusion (T055)

The executed local checks passed, but the local API invocation is partial: the database-backed `supplier-sync.service.spec.ts` suite was not run. This is not a full local API gate pass. Separately, PR [#371](https://github.com/pminhtaiii/wayfinder/pull/371) has recorded successful remote CI in run [37275073216](https://github.com/pminhtaiii/wayfinder/actions/runs/37275073216) at commit `2712cc50ad3cb3898b220fe6d8222dd99483bb3b`; that evidence covers that commit, not later changes. Wire and attestation compatibility are verified byte-for-byte. At the time of this pre-merge checkpoint, Phase 7 remained pending; post-merge evidence follows.

## Post-merge integration and acceptance update (2026-10-05)

PR [#371](https://github.com/pminhtaiii/wayfinder/pull/371) is merged into `development`. GitHub reports final PR head `791947c365c95e2721893c90cc3d92a433938117`, merge commit `8efbfc5aff4eea7179ef83529d11898b7e8477fb`, and merge time `2026-10-05T07:44:48Z`. Local merge ancestry agrees: `8efbfc5a` has base parent `0b1c84682c122101ac7f98e3eeeac481c6c7f14d` and source parent `791947c365c95e2721893c90cc3d92a433938117`.

The previously recorded [run 37275073216](https://github.com/pminhtaiii/wayfinder/actions/runs/37275073216) completed successfully on `2712cc50ad3cb3898b220fe6d8222dd99483bb3b`. The final source includes a later expiry-normalization correction and its regression cases in `flight-offer.normalizer.ts` and `flight-offer.normalizer.spec.ts`; the remaining intervening changes are documentation. Final-head coverage is provided by [run 37278447237](https://github.com/pminhtaiii/wayfinder/actions/runs/37278447237), which completed successfully on the exact final PR head `791947c365c95e2721893c90cc3d92a433938117` before merge. The API gate, API unit and E2E jobs, web gate/build, SAST, supply-chain scan, smoke/sanity, and aggregate `ci-status` succeeded. Agent gate/test jobs were skipped by change filtering; the T055 local agent test and Ruff results remain the evidence for T066.

The successful API unit log for run 37278447237 explicitly reports `PASS src/disruption/sync/supplier-sync.service.spec.ts` and `Test Suites: 135 passed, 135 total`. This supplies remote database-backed coverage omitted from the partial local API run while preserving the distinction that the local run itself did not pass all suites. The same final-head run reports 71/71 API E2E suites passed. Its fresh/upgrade migration proof reports 25 migrations on the fresh database, 11 renamed columns and 5 indexes checked, and on upgrade 16 sentinel rows, 12 linked checks, 8 null controls, uniqueness, and webhook records/index preserved.

The final-slice records remain consistent with the merged source: T056's census found zero unexplained runtime provider hits, with `@duffel/api` confined to four supplier adapters and non-webhook schema names neutralized; Slice 6.1 pins byte-for-byte wire/`sel_v1_` HMAC compatibility, while Slice 6.2 records fresh/upgrade migration preservation; Slice 5 records payment compensation and recovery safety, including the payment-fulfillment safety E2E. T058–T067 are checked in the task register. T067 verifies the isolated `DATABASE_URL` config RED/GREEN behavior and test discovery, but its report says no service or database was started and it did not run the full Playwright flow.

The final-head web gate ran the frontend characterization suite with `PLAYWRIGHT_FRONTEND_ONLY=true`; it did not execute `apps/web/tests/chat-t093-real-flow.spec.ts`. The task register describes T067 as preceding the final T093 real-flow gate, and `context/testing.md` requires a successful full Playwright exit code before T093 is reported as passed. The initial T093 setup attempt below stopped during Prisma engine bootstrap before test launch. At the time this historical update was written, Feature 029 acceptance closeout was still incomplete pending a full T093 run against a dedicated disposable database and runner-owned services. The final section below records the later passing full-flow result. Do not treat test discovery or the web characterization run as that gate.

### Historical T093 Setup Attempt — Blocked Before Test Launch (2026-10-05)

The validation worker checked out `build/untrack-superpowers-plans` at `c5b396525cb8ba761d662e527a9be36551f242fc` and targeted final Feature 029 source `791947c365c95e2721893c90cc3d92a433938117`. **T093 was not run.** No Playwright process or application service started, no T093 assertion executed, and no successful T093 exit code exists.

The worker found ports 3000–3003, 5433, and 6381 free. Existing containers `flight-postgres` and `flight-redis` on ports 5432 and 6379, plus the unrelated container on 8082, were not used or changed. It started runner-owned PostgreSQL and Redis containers on loopback ports 5433 and 6381, confirmed both services ready, and created database `t093_closeout_20261005` inside the runner-owned PostgreSQL container. No shared or user database was contacted.

The initial `prisma migrate deploy` exited 1 before database contact because the Prisma schema-engine download through the configured proxy failed with `ECONNREFUSED 127.0.0.1:9`. For the single corrective attempt, the worker pointed `PRISMA_SCHEMA_ENGINE_BINARY` to the cached Windows engine matching Prisma commit `605197351a3c8bdd595af2d2a9bc3025bca48ea2`. Prisma loaded the schema and identified the disposable database, then exited 1 with `Could not parse schema engine response: SyntaxError: Unexpected token 'o', "operable p"... is not valid JSON`. The cached engine has no `.exe` extension; attributing the response to Windows subprocess launch handling is an inference from the `operable p...` output. No migration was applied.

No third migration attempt was made under the repository fail-fast rule. The worker made no source, test, manifest, or lockfile edits and did not create the temporary Playwright configuration wrapper. It stopped and removed only its two runner-owned containers; the existing services remained running. At this historical setup-only checkpoint, T093 was the sole outstanding acceptance gate and Feature 029 closeout had not yet been completed; a full real-flow exit code 0 was still required. The later passing result is recorded below.

### Historical T093 Approved Continuation — Seeded Full-Flow Retry (before corrected documented-timeout run; 2026-10-05)

The earlier subsection records the historical Prisma bootstrap block. After the user approved the matching cached engine copied to a temporary `.exe`, validation resumed from checkout HEAD `a1db13768034f04a77400243678e1b64de93e8d2` against Feature 029 source `791947c365c95e2721893c90cc3d92a433938117`. The temporary engine matched SHA-256 `A7D949E16CC5937AA77D67888C8993118EF16C764E536E9ED7C17CFE61BB65AD` and reported `schema-engine-cli 605197351a3c8bdd595af2d2a9bc3025bca48ea2`. With `PRISMA_SCHEMA_ENGINE_BINARY` pointed to this copy, `prisma migrate deploy --schema prisma/schema.prisma` exited 0 on the fresh isolated database `t093_closeout_20261005_resume_a1db1376`; all 25 migrations applied.

The first full T093 run then exited 1 at `chat-t093-real-flow.spec.ts:266` because it received no `flight_results` event. Its sanitized tool audit recorded `v2/flights/search` failure `HTTP_400`, and the fresh database contained no airport rows. The T093 server overrides the supplier and country lookup but does not seed `Airport`; `FlightsService.search` rejects origin/destination codes missing from that table. The repository’s documented Prisma seed command, `pnpm --filter @api/backend exec prisma db seed`, was applied only to this isolated database and exited 0, inserting 4,562 airports. A read-only query confirmed `HAN|VN` and `SGN|VN`. Earlier command-lookup mistakes exited before the seed script started and made no database changes.

The checked-in `apps/web/tests/chat-t093-real-flow.spec.ts` was unchanged for the seeded retry. The temporary Playwright wrapper imported the checked-in config, changed only the API and agent Redis URLs to the runner-owned Redis on port 6391, and pointed `testDir` to the checked-in test directory; all other service commands, test timeouts, browser/security settings, and assertions stayed inherited. The full Playwright run executed one Chromium test and exited 1 after the configured 180,000 ms timeout at `chat-t093-real-flow.spec.ts:249`, waiting for `window.__t093StreamBodies.length` to reach 1. The agent stream response was observed at line 238, but its cloned response body did not finish. The post-run audit contained login, registration, chat-session, and chat-message events, but no `v2/flights/search` tool audit. The captured evidence does not identify why the stream stayed open. No third full-flow run was made.

Both runner-owned `--rm` containers were stopped by their verified IDs and removed: PostgreSQL `codex-t093-resume-a1db1376-postgres` (`127.0.0.1:5447`) and Redis `codex-t093-resume-a1db1376-redis` (`127.0.0.1:6391`). The pre-existing `flight-postgres` and `flight-redis` remained running; app ports 3000–3003 and disposable ports 5447/6391 were clear after teardown. The Playwright error artifact remains available under `test-results/chat-t093-real-flow-T093-r-67610--token-only-consumed-intent-chromium/`.

**Interim result after the seeded 180,000 ms retry (historical; superseded below): T093 had not yet passed and Feature 029 acceptance closeout was then incomplete.** At that interim checkpoint, the unchanged real-flow search and checkout assertions remained unverified because no full T093 run had exited 0. This historical local result is separate from final-source CI run 37278447237 at `791947c365c95e2721893c90cc3d92a433938117`; that run’s web gate executed characterization and did not run T093. The final section below records the later T093 pass.

#### Historical seeded-retry PowerShell invocation

This is the actual launch used for the seeded retry that timed out. It is recorded historically, including the environment settings that were actually assigned. The disposable PostgreSQL password is redacted. The timeout variables required by `context/testing.md` were not assigned by this invocation; the Playwright artifact reports a test timeout of 180,000 ms.

```powershell
# Run from C:\Booking Systems
$env:T093_REAL_FLOW = 'true'
$env:DATABASE_URL = 'postgresql://postgres:<redacted>@127.0.0.1:5447/t093_closeout_20261005_resume_a1db1376'
$env:PRISMA_SCHEMA_ENGINE_BINARY = (Join-Path (Get-Location) '.scratch\t093-resume-a1db1376\schema-engine.exe')
$runLog = Join-Path (Get-Location) '.scratch\t093-resume-a1db1376\playwright-second.log'
Push-Location apps/web
try {
  & '.\node_modules\.bin\playwright.cmd' test --config='C:\Booking Systems\.scratch\t093-resume-a1db1376\playwright.config.ts' tests/chat-t093-real-flow.spec.ts *> $runLog
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
Get-Content $runLog | Where-Object { $_ -match '^Running [0-9]+ test|^  [0-9]+ passed|^  [0-9]+ failed|^\s+\[chromium\]|^T093_PLAYWRIGHT_EXIT|Error:|Test timeout' } | ForEach-Object { $_ }
"T093_PLAYWRIGHT_EXIT=$code"
exit $code
```


### Final T093 Acceptance Gate — Passing Isolated Full Flow (2026-10-05)

The earlier T093 subsections preserve the engine-bootstrap failures and the seeded retry that timed out after 180,000 ms because its launch omitted the timeout exports documented by `context/testing.md`. They are historical attempts, not the final result. The timeout correction was limited to the execution environment; neither the checked-in test nor application source changed. Final Feature 029 source `791947c365c95e2721893c90cc3d92a433938117` was validated.

A fresh runner-owned database `t093_closeout_20261005_b89eefd2` ran all 25 Prisma migrations successfully using the matching cached schema engine (`605197351a3c8bdd595af2d2a9bc3025bca48ea2`, SHA-256 `A7D949E16CC5937AA77D67888C8993118EF16C764E536E9ED7C17CFE61BB65AD`). The documented API seed command succeeded only against that database and inserted 4,562 airports; the read-only check confirmed `HAN|VN` and `SGN|VN`. PostgreSQL and Redis were task-owned `--rm` containers on loopback ports 5448 and 6392. No shared database or pre-existing container was used for the flow.

Before Playwright started, the same PowerShell process asserted the effective timeout environment was `T093_TEST_TIMEOUT_MS=600000`, `T093_STREAM_TIMEOUT_MS=300000`, and `T093_BROWSER_TIMEOUT_MS=120000`, and verified the checked-in test consumes all three variables. It also set `UV_CACHE_DIR`, `T093_REAL_FLOW`, the isolated `DATABASE_URL`, and the temporary matching `PRISMA_SCHEMA_ENGINE_BINARY` in that same process. The Playwright wrapper imported the checked-in config, redirected only the T093 API and agent Redis URLs to the owned Redis service, and set `testDir` to the checked-in web tests. The captured wrapper source is `.scratch/t093-resume-a1db1376-retry2/wrapper-evidence.txt` (SHA-256 `40B501C445F70EFE4652E6F7B545CBD0172AB7D03930ED586DCEE282391919A1`).

The actual corrected full-flow command and explicit environment assignments were:

```powershell
# Run from C:\Booking Systems; values shown for DATABASE_URL and the engine path are the actual isolated target, with the disposable password redacted.
$env:UV_CACHE_DIR = 'C:\Booking Systems\.uv-cache'
$env:T093_REAL_FLOW = 'true'
$env:T093_TEST_TIMEOUT_MS = '600000'
$env:T093_STREAM_TIMEOUT_MS = '300000'
$env:T093_BROWSER_TIMEOUT_MS = '120000'
$env:DATABASE_URL = 'postgresql://postgres:<redacted>@127.0.0.1:5448/t093_closeout_20261005_b89eefd2'
$env:PRISMA_SCHEMA_ENGINE_BINARY = (Join-Path (Get-Location) '.scratch\t093-resume-a1db1376-retry2\schema-engine.exe')
$runLog = Join-Path (Get-Location) '.scratch\t093-resume-a1db1376-retry2\playwright-timeouts600k.log'
Push-Location apps/web
try {
  & 'C:\Booking Systems\apps\web\node_modules\.bin\playwright.CMD' test --config='C:\Booking Systems\.scratch\t093-resume-a1db1376-retry2\playwright.config.ts' 'tests/chat-t093-real-flow.spec.ts' *> $runLog
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
"PLAYWRIGHT_EXIT=$code"
exit $code
```

**T093 passed:** Playwright exited 0; one Chromium test passed in 4.9 minutes: `completes signed search through one token-only consumed intent`. This completes the missing full real-flow acceptance gate. Feature 029 closeout is resolved alongside exact-final-source CI run 37278447237, which passed at the same source SHA; the CI web gate itself ran characterization only, so this isolated real-flow result is the distinct T093 evidence. Local API validation remains **PARTIAL** because the local `supplier-sync.service.spec.ts` suite was not run; final-head remote CI separately reports that suite and all 135 API unit suites passing.

Cleanup stopped only the verified task-owned PostgreSQL container `codex-t093-retry-b89eefd2-postgres` (ID `d7b5720477e3f183e30736a8352e09cfe127f3416a107cc04c614793d872cbe2`, port 5448) and Redis container `codex-t093-retry-b89eefd2-redis` (ID `e18bd8a482887bac0f190a1051bf4d0ad860ab6ef78006aa975482bfb2a72982`, port 6392). Their `--rm` policy removed them. Existing `flight-postgres` and `flight-redis` remained running. Ports 3000–3003, 5448, and 6392 were clear after teardown. The temporary engine executable and wrapper config were removed after the wrapper text and hash were preserved. Sanitized migration, seed, and Playwright logs remain in the task scratch directory. No source, test, package, or lockfile edits were made.
