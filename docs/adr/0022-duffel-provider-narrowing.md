# Grilling Session — Narrow the Duffel Provider Interface (Candidate #9)

> Captured from grilling session on 2026-09-28.
> Source: architecture-review-20260820-expanded.html (Candidate #9: Narrow the Duffel Provider Interface).

---

## Context

`DuffelService` (`apps/api/src/duffel/duffel.service.ts`) is a 1,482-line god module with 12 public methods spanning 5 unrelated capability clusters (search, ancillary, order lifecycle, cancellation, recovery). It is imported by 8 NestJS modules. Duffel-specific types (`DuffelOffer`, `DuffelOrder`) leak into 4 non-duffel modules. Duffel-specific column names are hardcoded into 12+ Prisma schema columns and a dedicated `DuffelWebhookEvent` table. Shared contracts in `packages/shared` and frontend components reference Duffel identifiers directly. `FlightsService` bypasses the public API via bracket-notation access to the private Duffel SDK instance (`this.duffelService['duffel'].offers.get(...)`).

The `DuffelFulfillmentAdapter` already partially narrows the order lifecycle behind a `FulfillmentGatewayPort`, but all other callers depend directly on the concrete `DuffelService` class.

Since the system is **not in production** (no live data), renaming database columns and shared contracts carries zero migration risk.

---

## Decision 1 — Capability-local split with future-proofing ✅

**Problem**: How deep to cut when decomposing `DuffelService`?

**Considered options**:

1. **Interface extraction only** — narrow TypeScript interfaces over the monolith.
2. **Capability-local services** — split into smaller classes, each owning its Duffel SDK calls.
3. **Full port + adapter pattern** — provider-blind ports for every capability.

**Decision**: Option 2. Split `DuffelService` into capability-local services, implemented in a way that makes future multi-provider support easy to add. Option 1 doesn't reduce cognitive load (still 1,482 lines). Option 3 over-engineers for a second provider that doesn't exist yet — `FulfillmentGatewayPort` already protects the most critical path.

---

## Decision 2 — Full rename across all depths (no production data) ✅

**Problem**: How far to rename Duffel-specific naming?

**Decision**: Rename across all four depths (code layer, database schema, shared contracts, frontend/agent) since there is no production data. Renaming now is cheaper than renaming post-production.

**Two-layer naming split**:

- **Abstract/public-facing**: provider-neutral names (`Supplier`, `Flight`) at the domain, contract, and database layers.
- **Concrete/implementation**: `Duffel`-named classes/modules for anything that directly touches the `@duffel/api` SDK.

---

## Decision 3 — Naming vocabulary ✅

**Problem**: Which abstract word to use across ~200+ files?

**Decision**: Three vocabularies by layer:

| Layer | Vocabulary | Examples |
|---|---|---|
| Infrastructure/service | `Supplier` | `SupplierSearchService`, `Booking.supplierOrderId`, `SupplierSearchModule` |
| Domain/shared contracts | `Flight` | `FlightOffer`, `FlightSegment`, `FlightOrder` |
| Concrete SDK implementations | `Duffel` | `DuffelSearchAdapter`, `DuffelAncillaryAdapter`, `DuffelCoreModule` |
| Webhook table | `Duffel` (kept) | `DuffelWebhookEvent` — contains Duffel-specific payloads |

**Key constraint**: `provider` rejected due to overloading with NestJS dependency injection vocabulary (`providers: [...]`). `flight` rejected for infrastructure layer because not all supplier operations are flights (ancillaries, refund quotes). `supplier` is unambiguous, doesn't collide, and scales across all capabilities.

---

## Decision 4 — Three deep modules, not five shallow ones ✅

**Problem**: Splitting into 5 capability modules creates dangerously shallow modules for cancellation (~85 lines) and recovery (~52 lines).

**Decision**: Merge into 3 deep modules:

| Module | What it absorbs | Combined depth |
|---|---|---|
| **SupplierSearchModule** (renamed from DuffelSearchModule post-extraction) | Search + passenger mapping | ~350 lines |
| **SupplierAncillaryModule** | Seat maps + repricing | ~440 lines |
| **SupplierOrderModule** | Order creation + cancellation + recovery + fulfillment adapter + snapshot mapping | ~950 lines |

Cancellation and recovery are **flat internal services** inside `SupplierOrderModule` — not nested sub-modules. They operate on the same entity (supplier order) at different lifecycle stages and share the same underlying SDK resources.

---

## Decision 5 — Thin DuffelCoreModule for shared SDK infrastructure ✅

**Problem**: All capability modules need the same Duffel SDK instance (same API token, same `basePath`).

**Decision**: A minimal `DuffelCoreModule` (~30 lines) creates and exports the Duffel SDK instance, base URL configuration, and shared rate-limit budget. Each capability module imports it internally. Domain modules **never** import `DuffelCoreModule` — it's an internal implementation detail.

---

## Decision 6 — Type mapping via normalizer services ✅

**Problem**: Where does the conversion from Duffel-specific types to domain types happen?

**Considered options**:

1. Adapter maps internally — Duffel types never exit the adapter.
2. Service maps at boundary — adapter returns raw Duffel, service transforms.
3. Dedicated normalizer service within the module.

**Decision**: Option 3. Normalizer stays as a separate service within each supplier module. The adapter returns raw Duffel data; the normalizer service transforms it to domain types (`FlightOffer`, `FlightSnapshot`). Existing `flight-offer-normalizer.ts` and `itinerary-normalizer.ts` logic moves into the respective supplier modules.

**Key principle**: Clean separation of SDK interaction (adapter) vs. data transformation (normalizer). Both live inside the same supplier module; domain consumers only see domain types.

---

## Decision 7 — Extraction sequence: extract first, rename last ✅

**Problem**: The decomposition touches a 1,482-line file imported by 8 modules, plus database renames across 12+ columns and shared contract changes. The order matters.

**Decision**: Structural refactor and naming/schema migration are **separate dimensions of change**. Extract first using existing Duffel names, rename to neutral names after the god module is deleted.

| Step | What | Invariant |
|---|---|---|
| **0** | Seal private SDK escape hatch (`FlightsService['duffel']` → public `getOfferById()`) | Compiles, tests green |
| **0.5** | Characterization test checkpoint: verify search, ancillary, order, cancellation, recovery behavior | Tests locked |
| **1** | Extract `DuffelCoreModule` (SDK instance + config + shared rate budget) | Compiles, tests green |
| **2** | Extract `DuffelSearchModule` (search + passenger mapping + normalizer) | `DuffelService` shrinks ~350 lines |
| **3** | Extract `DuffelAncillaryModule` (seat maps + repricing + normalizer) | `DuffelService` shrinks ~440 more lines |
| **4** | Extract `DuffelOrderModule` (order creation + cancellation + recovery as internal services + fulfillment adapter) | `DuffelService` nearly empty |
| **5** | Delete `DuffelService` and `DuffelModule` | God module gone |
| **6** | Provider-neutral rename (code + contracts): `SupplierSearchModule`, `FlightOffer`, etc. | Vocabulary cleanup |
| **7** | Prisma column rename (`duffelOrderId` → `supplierOrderId`) — real column rename, no `@map` aliases | Schema clean |
| **8** | Final architectural audit: Duffel-specific names remain only in integration layer | Boundary verified |

---

## Decision 8 — Two-layer rate limiting ✅

**Problem**: The daily 1,500-call Duffel API budget has sub-allocations (user: 1,000, agent: 500). Where does each concern live?

**Decision**: Split into infrastructure and business layers:

- **`DuffelCoreModule`** provides `DuffelRateBudget` — tracks total Duffel API usage (1,500 calls/day). **Provider-aware, application-ignorant** — it knows Duffel's limits but not who's calling or why.
- **`DuffelSearchService`** owns sub-budget allocation (user: 1,000, agent: 500). This is business logic that belongs in the capability service, not infrastructure.
- **Caching** → Service layer. Cache policy (TTLs, force-refresh) is a business decision.
- **Admission control (semaphore)** → Adapter layer. Duffel-specific backpressure stays with the SDK wrapper, following the existing `DuffelFulfillmentAdapter` pattern.

---

## Decision 9 — Selective port strategy ✅

**Problem**: Should capability services expose abstract port interfaces for future provider swapping?

**Decision**: Ports only where the domain contract is already stable and provider-independent. Don't invent generic interfaces speculatively.

| Capability | Port? | Rationale |
|---|---|---|
| **Search** | ✅ `FLIGHT_SEARCH_PORT` — new | Stable contract: search criteria in, `FlightOffer[]` out. Naturally provider-independent. |
| **Order fulfillment** | ✅ `FULFILLMENT_GATEWAY_PORT` — already exists | Keep the existing narrow contract. Do not replace with a wider `SupplierOrderPort`. |
| **Cancellation** | ❌ Concrete | No stable provider-neutral semantics yet. Introduce a port when a second provider makes the common contract clear. |
| **Recovery** | ❌ Concrete | Same as cancellation. |
| **Ancillary** | ❌ Concrete | Seat maps, services, and repricing are highly provider-specific. Don't invent a generic interface before knowing what a second provider looks like. |

**Governing rule**: Add ports where the domain contract is already stable and provider-independent, not simply because an implementation might change someday.

---

## Post-Refactor Structure

```
apps/api/src/
├── supplier/
│   ├── core/
│   │   ├── duffel-core.module.ts          (SDK instance + config)
│   │   ├── duffel-sdk.provider.ts         (Duffel SDK factory)
│   │   └── duffel-rate-budget.service.ts  (total API budget tracking)
│   ├── search/
│   │   ├── supplier-search.module.ts      (exports FLIGHT_SEARCH_PORT)
│   │   ├── supplier-search.port.ts        (abstract interface)
│   │   ├── duffel-search.adapter.ts       (SDK calls)
│   │   ├── duffel-search.service.ts       (implements port, caching, sub-budgets)
│   │   └── flight-offer.normalizer.ts     (DuffelOffer → FlightOffer)
│   ├── ancillary/
│   │   ├── supplier-ancillary.module.ts
│   │   ├── duffel-ancillary.adapter.ts    (SDK calls)
│   │   ├── duffel-ancillary.service.ts    (concrete — no port)
│   │   └── ancillary.normalizer.ts
│   └── order/
│       ├── supplier-order.module.ts       (exports FULFILLMENT_GATEWAY_PORT)
│       ├── duffel-order.adapter.ts        (SDK calls)
│       ├── duffel-fulfillment.adapter.ts  (implements existing port)
│       ├── duffel-cancellation.service.ts (concrete internal service)
│       ├── duffel-recovery.service.ts     (concrete internal service)
│       └── order-snapshot.normalizer.ts   (DuffelOrder → FlightSnapshot)
```

## Post-Refactor Dependency Graph

```
FlightsModule
└── → FLIGHT_SEARCH_PORT (SupplierSearchModule)
    └── → DuffelSearchService → DuffelSearchAdapter → DuffelCoreModule

AncillariesModule + PaymentModule
└── → DuffelAncillaryService (SupplierAncillaryModule)
    └── → DuffelAncillaryAdapter → DuffelCoreModule

PaymentFulfillmentSaga
└── → FULFILLMENT_GATEWAY_PORT (SupplierOrderModule)
    └── → DuffelFulfillmentAdapter → DuffelOrderAdapter → DuffelCoreModule

CancellationModule
└── → DuffelCancellationService (SupplierOrderModule)
    └── → DuffelOrderAdapter → DuffelCoreModule

BookingLifecycleModule + DisruptionModule
└── → DuffelRecoveryService (SupplierOrderModule)
    └── → DuffelOrderAdapter + OrderSnapshotNormalizer → DuffelCoreModule
```

**Dependency direction**: All arrows flow downward. No cycles. Every new module is either a leaf adapter or a thin service over adapters/normalizers.

---

## What does NOT change

- **Duffel SDK version**: Same `@duffel/api` ^4.28.0, same API version.
- **Domain event model**: Same `FlightSnapshot`, `PassengerSnapshot` shapes.
- **Guardrail behavior**: PII redaction stays in the fulfillment adapter.
- **API contract**: No changes to HTTP endpoints, response shapes, or error codes.
- **Security guarantees**: Admission control, HMAC signature verification, PII redaction preserved.
- **DuffelWebhookEvent table**: Keeps the Duffel name — contains Duffel-specific payloads.
- **FulfillmentGatewayPort**: Existing port contract preserved exactly as-is.
