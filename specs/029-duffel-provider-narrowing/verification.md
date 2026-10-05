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

