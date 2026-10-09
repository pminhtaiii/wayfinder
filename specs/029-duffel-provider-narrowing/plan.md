# Implementation Plan: Narrow the Duffel Supplier Boundary

**Branch**: `codex/029-duffel-provider-narrowing` | **Date**: 2026-09-29 | **Spec**: [spec.md](./spec.md)

**Input**: [Approved decisions](../../docs/adr/0022-duffel-provider-narrowing.md), [specification](./spec.md), and [code reconciliation](./research.md).

## Summary

Extract the Duffel monolith into search, ancillary, and order capabilities over one internal SDK/config/budget owner. Search exposes `FLIGHT_SEARCH_PORT`; fulfillment keeps the exact `FULFILLMENT_GATEWAY_PORT`. Concrete ancillary, cancellation, and recovery services remain direct Nest providers. Characterize and extract first, delete the monolith, then neutralize internal names and physical database columns while preserving HTTP/SSE wire contracts. The decision record changes the application budget from monthly search/reconciliation accounting to 1,500 total Duffel attempts per UTC day with 1,000 user-search and 500 agent-search allocations.

## Technical Context

**Language/Version**: Existing TypeScript/NestJS API and shared/web packages; existing Python agent runtime.
**Primary Dependencies**: Installed `@duffel/api` ^4.28.0, NestJS DI, Prisma/PostgreSQL, `ioredis` via `CacheService`, Stripe, Python agent packages; no new dependency.
**Storage**: PostgreSQL booking/offer/ancillary/disruption tables; Redis search cache/budgets and trusted search snapshots; persisted JSON snapshots and payment evidence.
**Testing**: Adjacent Jest API specs and E2E suites, shared Node tests, web Node/Playwright tests, agent pytest, Prisma migration status, lint/typecheck/build gates.
**Target Platform**: Existing NestJS API, Next.js frontend, Python agent, PostgreSQL, Redis.
**Project Type**: Cross-service internal refactor plus physical schema rename; no new external API.
**Performance Goals**: No extra Duffel call, cache miss, model call, or synchronous DB write per unchanged action; existing cache TTLs and bounded adapter admission.
**Constraints**: Byte-compatible HTTP/SSE and signed `sel_v1_` payloads; unchanged fulfillment port, fencing, idempotency, PII redaction, refund/compensation, and webhook signature behavior.
**Scale/Scope**: One 1,481-line service; 8 importing feature modules plus AppModule; search/ancillary/order consumers; shared/web/agent contracts; 12+ persisted provider names.

## Constitution Check

*Pre-research and post-design gate: PASS with the budget policy change tracked in spec and tests.*

| Principle | Design evidence |
|---|---|
| Flight-first | Search/detail and order fulfillment remain testable at each extraction; no unrelated workflow enters booking. Budget exhaustion behavior is explicit. |
| Deterministic transaction boundary | Only Nest services/adapters call Duffel; Python agent remains advisory. The fulfillment port stays intact; unconfirmed cancellation retains recoverable payment/booking state instead of releasing the hold against an active supplier order. |
| API budget discipline | One atomic daily reservation precedes every actual Duffel attempt; search cache hits are free; caller allocation stays in search service. |
| Observability | Preserve trace/correlation, error, cache, and supplier-call telemetry; budget counters contain no PII. |
| Incremental delivery | Seal escape hatch, characterize, gate each capability, then rename after the old service is gone. |
| Security | Preserve HMAC attestation bytes, webhook verification, fencing, tenant checks, and fulfillment PII redaction. |

The search port, three capability modules, and one atomic budget operation are justified by the approved boundary and concurrency requirements. No generic ancillary, cancellation, recovery, or second-supplier framework is added.

## Project Structure

### Documentation

```text
specs/029-duffel-provider-narrowing/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/supplier-boundaries.md
├── quickstart.md
└── tasks.md
```

### Target implementation shape

```text
apps/api/src/supplier/
├── core/
│   ├── duffel-core.module.ts
│   ├── duffel-sdk.provider.ts
│   └── duffel-rate-budget.service.ts
├── search/
│   ├── supplier-search.module.ts
│   ├── flight-search.port.ts
│   ├── duffel-search.adapter.ts
│   ├── duffel-search.service.ts
│   ├── flight-offer.normalizer.ts
│   └── flight-offer-cleanup.service.ts
├── ancillary/
│   ├── supplier-ancillary.module.ts
│   ├── duffel-ancillary.adapter.ts
│   ├── duffel-ancillary.service.ts
│   └── ancillary.normalizer.ts
└── order/
    ├── supplier-order.module.ts
    ├── duffel-order.adapter.ts
    ├── duffel-fulfillment.adapter.ts
    ├── duffel-cancellation.service.ts
    ├── duffel-recovery.service.ts
    └── order-snapshot.normalizer.ts

apps/api/src/cache/cache.service.ts                 # atomic reservation seam
apps/api/src/flights/                            # search/detail and ranking consumers
apps/api/src/ancillaries/                        # catalog/selection consumers
apps/api/src/payment/                            # repricing/payment validation
apps/api/src/payment-fulfillment/                # unchanged fulfillment port/saga
apps/api/src/cancellation/                       # concrete cancellation consumer
apps/api/src/booking-lifecycle/                  # recovery consumer
apps/api/src/disruption/                         # sync + concrete webhook
apps/api/prisma/schema.prisma                    # neutral fields
apps/api/prisma/migrations/20260929000000_supplier_identifiers/ # forward physical rename
packages/shared/src/                            # internal types + compatible wire DTOs
apps/web/                                       # edge mapping/contract checks
apps/agent/src/agent/                           # local names + wire aliases
```

**Structure Decision**: Core exports SDK/config and budget only to supplier modules. Search exports only `FLIGHT_SEARCH_PORT`, whose three narrow operations are search, live offer lookup, and normalization of persisted offer evidence. The normalizer remains internal to SupplierSearchModule; booking readiness, agent readiness, and handoff inject the port. `BookingIntentModule` imports SupplierSearchModule for live offer lookup. Ancillary exports its concrete service; order exports the fulfillment token and concrete cancellation/recovery services. `DuffelWebhookEvent` and webhook handlers stay in `apps/api/src/disruption/webhook/`. Dependency direction is feature modules → supplier capability modules → Duffel core, without cycles.

## Phase 0: Research

[research.md](./research.md) reconciles the code with the ADR. Current monthly search/reconciliation accounting is an intentional policy change; the search port needs an envelope for cache/hash/persistence metadata; Duffel-named wire keys remain edge compatibility exceptions. No new library is required.

## Phase 1: Design and Contracts

- [data-model.md](./data-model.md) enumerates physical column/index renames, JSON/Redis compatibility, and the webhook exception.
- [contracts/supplier-boundaries.md](./contracts/supplier-boundaries.md) fixes module exports, search/fulfillment signatures, budget accounting, and wire compatibility.
- [quickstart.md](./quickstart.md) gives executable baseline, slice, migration, and final gates with expected outcomes.

### Implementation sequence and working checkpoints

0. **Seal and characterize**: Replace `FlightsService['duffel'].offers.get` with public `getOfferById()`. Lock search/cache/budget, offer expiry, ancillary catalog/reprice, fulfillment, cancellation, recovery/sync, HMAC, and redaction behavior with focused tests. Record monthly budget baseline separately from the intended daily change.
1. **Core**: Move token/basePath construction, malformed URL fast fail, and mock-server override to `DuffelCoreModule`. Provide one SDK token. Add atomic `DuffelRateBudget` through one Redis check-and-increment operation in `CacheService` and new daily keys. Search supplies caller-specific key/limit; core knows only the total plus an optional extra constraint. Remove the old monthly check/increment in both search and `disruption/sync/reconciliation.service.ts`; preserve the latter's `budgetBlocked` metric and deferral by handling typed adapter denial without a second charge. Meter every SDK/manual HTTP attempt, including parallel calls and retries. Preserve adapter semaphore behavior; gate core tests and API compile.
2. **Search**: Extract passenger mapping, cache/caller policy into search service; SDK search/live-offer lookup into adapter; Duffel-shape normalization into module-internal search normalizer. Add `FLIGHT_SEARCH_PORT` returning normalized offers plus hash/cache metadata and opaque persistence payload, and a stored-evidence normalization operation. Preserve deterministic offer IDs, rejection reasons, original-index mapping, and response order. Rewire `FlightsService`, `BookingIntentService.fetchLiveOffer`, their modules, search orchestrator, offer detail, and cleanup cron. Route persisted raw-offer readers in `BookingReadinessService`, `AgentBookingReadinessService`, and `ChatHandoffService` through the port so they use neutral passenger, expiry, segment, carrier, cabin, and baggage facts. Gate search, ranking, readiness, handoff, agent-gateway, detail, and cache tests.
3. **Ancillary**: Extract seat-map/service and priced-offer calls into adapter; catalog/reprice normalization into local normalizer and policy/cache into ancillary service. Rewire `AncillaryCatalogService`, `AncillariesModule`, `AncillaryPaymentValidationService`, and `PaymentModule`. Gate selection, absent-map, freshness, CAS snapshot, and repricing/payment tests.
4. **Order**: Extract manual `/air/orders` request and order/quote/cancel/retrieve SDK calls into adapter. Move quote/cancel and recovery into two flat services; move order/itinerary snapshots into order normalizer. Move `DuffelFulfillmentAdapter` without changing port, semaphore, fencing preflight, order idempotency, redaction, or fallback snapshot. Correct all unconfirmed-cancellation paths in `PaymentFulfillmentSaga` (inline capture failure and `handleBackgroundError` after the 25-second handoff) and `BookingRecoveryService`: retain PROCESSING, authorized hold, order-created evidence/checkpoint, and retry eligibility; do not complete the idempotency key or void/fail until cancellation succeeds or is confirmed already done. A typed budget denial carries next-UTC-midnight retry time; unavailable store uses bounded backoff. The existing recovery `CacheService` stores only booking ID and next-attempt time in a TTL defer key; the 10-minute sweeper skips that booking until due, and a lost key merely causes a safe recheck. Rewire order consumers in cancellation, recovery, disruption sync, payment, saga, AppModule, and test overrides. Gate inline/background compensation and next-day repair.
5. **Delete monolith**: Once all callers use capability exports, delete `DuffelService` and `DuffelModule`. Assert no bracket/private SDK access, unintended SDK import, or domain import of core. This is the structural checkpoint before naming/schema changes.
6. **Neutral code/contracts**: Rename final Nest modules and internal types to `Supplier`/`Flight`. Neutralize offer/order/passenger/segment/quote/sync/hash identifiers in domain/shared/web/agent internals. Keep explicit wire mappers for current HTTP/SSE DTO keys and signed attestation objects. Legacy booking snapshot JSON remains readable; old strict agent snapshots fail closed to fresh search.
7. **Physical schema**: Add one forward Prisma migration with column and index/constraint renames; do not edit prior migrations or retain `@map` aliases. Rename Prisma fields and references together, regenerate client, and test migration from scratch and on an existing local schema copy. Audit persisted literal states (`duffel_order_created`, `DUFFEL_COST`, recovery points) before changing values and keep legacy readers where records may exist.
8. **Final audit**: Run the quickstart matrix, boundary/name census with allowlist for SDK, webhook, migration history, and wire compatibility, migration/status checks, privacy/HMAC tests. After implementation, update `context/architecture.md`, `context/progress-checker.md`, and any other affected context docs.

**Gate after each step**: Focused tests and API typecheck; stop on a failed invariant before the next extraction. Structural steps may temporarily use Duffel names; neutral naming is deliberately last. No app feature flag or second implementation path is introduced.

## Risks and rollback

- **Search port loses raw evidence or leaves raw readers behind**: Carry raw supplier JSON as opaque persistence metadata; normalize legacy stored JSON before booking readiness, agent readiness, handoff, and detail decisions. Tests compare stored offer, ranking, and those reader outcomes. Domain consumers must not parse raw payloads.
- **Daily budget blocks booking at total exhaustion**: This follows the stated cap and no-reserve policy. A pre-create denial takes the existing safe failure path. Any unconfirmed compensation after order creation must preserve PROCESSING/hold and order evidence for later repair; both current saga and stale recovery catch-and-void paths need correction. A separate reserve requires an explicit later policy change.
- **Signed/serialized drift**: Pin HMAC bytes and API JSON fixtures; map neutral internals to legacy wire keys at edges.
- **Schema misses a reader**: Typecheck after Prisma generation, test clean/existing migrations, and audit old identifiers. Preserve legacy JSON read support.
- **Money path drift**: Keep the fulfillment port unchanged; replay/compensation tests gate order extraction and monolith deletion.

## Complexity Tracking

No constitutional violation is planned. The capability modules, existing fulfillment port, new search port, and one atomic budget reservation are the minimum structures needed by the approved design.
