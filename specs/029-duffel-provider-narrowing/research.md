# Research and code reconciliation

Source of decisions: [Duffel provider narrowing grilling session](../../docs/adr/0022-duffel-provider-narrowing.md). The supplied external file and repository ADR have identical SHA-256 content. Current code was inspected on `codex/029-duffel-provider-narrowing` before planning.

## 1. Extraction boundary and order

**Decision**: Keep the ADR's sequence: seal the `FlightsService['duffel']` access, characterize behavior, extract core, then search, ancillary, order, delete the old service/module, and only then rename. Search, ancillary, and order live under `apps/api/src/supplier/`; Duffel adapters own SDK calls and capability-local normalizers own transformation.

**Rationale**: `apps/api/src/duffel/duffel.service.ts` currently has 12 public methods and owns four different request clusters. `DuffelModule` is imported by eight feature modules and `AppModule`. The existing `getOfferById()` can replace the private SDK access immediately. Existing `DuffelFulfillmentAdapter` and its port remain the money-path boundary.

**Alternatives considered**: Interfaces over the monolith leave it large; five capability modules split cancellation/recovery too thin; generic ancillary and cancellation ports would encode unproven second-provider semantics.

## 2. Search port versus today's raw-offer flow

**Decision**: Define `FLIGHT_SEARCH_PORT` with criteria-to-`FlightSearchResult`, live offer lookup, and stored-offer normalization operations. The envelope contains normalized `FlightOffer[]`, `searchHash`, and `cached`. A normalized offer may carry an opaque raw supplier payload used only for existing persistence, never interpreted by domain consumers. The module-internal normalizer accepts previously stored raw offer JSON and returns the same domain shape through the port for readiness and handoff readers. `FlightSearchOrchestratorService` retains profile scoring and ranking, and `FlightsService` retains search history, offer persistence, audit, and HTTP outcome mapping.

**Rationale**: Today `DuffelService.searchFlights()` returns a raw `DuffelOfferRequest` plus cache/hash metadata. `FlightSearchOrchestratorService` and `FlightsService` both interpret raw offers; `FlightsService` persists them as JSON and uses a private SDK handle for detail. `BookingIntentService`, `BookingReadinessService`, `AgentBookingReadinessService`, and `ChatHandoffService` also parse stored raw offer JSON for passenger identity, expiry, and segment/carrier facts. A literal `FlightOffer[]` return would discard required metadata and raw recovery evidence. The envelope and stored-offer normalizer cover all readers while keeping SDK types out of consumers.

**Alternatives considered**: Move search history/audit into the supplier module (wrong ownership), duplicate hash/cache metadata in `FlightsService` (two sources of truth), or expose `DuffelOfferRequest` through the new port (no boundary improvement).

## 3. Normalizer responsibilities

**Decision**: Move Duffel-shape decoding from `flights/flight-offer-normalizer.ts` into the search module, but retain profile scoring and category ranking in `flights/`. The search normalizer exposes neutral offer and stored-offer projections needed by booking intent/readiness, agent readiness, handoff, and offer detail. Move Duffel-order-to-segment logic from `disruption/domain/itinerary-normalizer.ts` and `DuffelService.mapDuffelOrderToSnapshots()` to order-local normalizers. Keep public DTO mapping at the HTTP edge. Ancillary's existing seat-map conversion moves next to its adapter.

**Rationale**: The present flight normalizer produces match-scoring input, not a complete HTTP `FlightOfferDto`. A mechanical file move is insufficient; its input/output need a domain shape that supports existing ranking, detail, and persistence. Disruption's current normalizer also imports Duffel shapes in a domain folder.

**Alternatives considered**: Keep normalizers in domain modules (provider type leakage), or put normalization inside adapters (mix request handling with transformation against the ADR decision).

## 4. Budget policy and atomicity

**Decision**: Treat 1,500 total, 1,000 user-search, and 500 agent-search attempts per UTC day as the requested application policy. `DuffelRateBudget` in core reserves each actual outbound attempt. Search service owns caller classification and limit and supplies an optional extra counter/limit to the core's generic atomic reservation; core does not interpret `user` or `agent`. Non-search calls reserve from total only. Use one Redis atomic operation through the existing `CacheService` wrapper to check and increment total and optional extra counter with a common next-UTC-midnight expiry. Cache hits reserve nothing. Every SDK call, parallel call, manual HTTP call, and retry reserves separately. Reject before calling Duffel if reservation fails; budget storage failure fails closed.

**Rationale**: Current code limits search and disruption reconciliation through the same monthly `budget:duffel:YYYY-MM` counter, with defaults 2,000 total, 1,800 user, and 1,200 agent; search caller checks share one counter. It does not meter ancillary or order requests. Reconciliation pre-charges even when a sync later skips and compensates with a decrement. The new daily policy is a behavior change, not merely a class move. Remove both old monthly charging paths and let the adapter reserve only when an outbound attempt will occur. Atomic check-and-increment prevents concurrent overspend, and a daily key namespace avoids interpreting old monthly counts as daily counts.

**Alternatives considered**: Reuse `CacheService.incr` plus compensating `decr` (cannot atomically enforce three limits under concurrency), or retain in-memory fallback (cannot enforce a shared limit across processes). No new dependency is needed; `ioredis` is already installed.

**Capacity trade-off**: The 1,000+500 search allocations can consume the full 1,500 total before an order call. The approved decision specifies no booking reserve, so this plan introduces none. A denial before order creation can follow the existing safe failure path. A denial while cancelling an already-created order cannot: both the inline saga and the separate `handleBackgroundError` path catch cancellation failure, void the Stripe hold, and mark the booking failed while the supplier order may remain active. The stale-booking recovery sweeper has the same catch-and-void behavior, so changing one path is insufficient. An unconfirmed supplier cancellation must retain PROCESSING, the authorized hold, the order-created evidence/checkpoint, and a retry schedule. Do not finalize the idempotency key. On the next eligible retry, cancel/confirm the supplier order before voiding the hold and failing the booking; an already-cancelled order is success for this purpose. Apply this to any unconfirmed cancellation, including typed budget denial, to fix the shared safety path once. Budget denial supplies next-UTC-midnight retry time; temporary budget-store unavailability uses bounded backoff. `BookingRecoveryService` already injects `CacheService`, so a booking-ID-only TTL defer key avoids a new column; loss of that key causes only a safe budget recheck. Add regression checks for both inline and background last-slot denial and next-day repair. A fixed booking reserve would change the stated allocations and is not assumed.

## 5. Neutral names versus unchanged HTTP JSON

**Decision**: Rename internal types, parameters, Prisma columns, web/agent local variables, and internal DTOs to `supplier*` or `Flight*`. Preserve already-exposed `duffelOfferId`, `duffelOrderId`, and related JSON keys through explicit inbound/outbound compatibility mappers at current HTTP/SSE edges. Inventory and allowlist these compatibility locations in the final audit. `DuffelWebhookEvent` and Duffel signature/payload types remain concrete.

**Rationale**: `packages/shared/src/booking-types.ts`, `disruption-types.ts`, API DTOs, and agent attested-search/readiness payloads currently serialize Duffel-named fields. Renaming those JSON keys would contradict the ADR's unchanged HTTP response-shape decision. The edge exception makes both obligations testable: neutral internals and stable existing clients.

The `sel_v1_` selection attestation signs `JSON.stringify` of offers containing `duffelOfferId`; changing that signed object would invalidate existing tokens. Its byte shape therefore stays at the edge. The strict Python trusted-search snapshot also stores `duffelOfferId`; with no production data, old ephemeral snapshots may fail closed and require a fresh search rather than a dual-format reader. Tests must cover that fallback. Persisted `Booking.flightSnapshot` JSON can contain `duffelSegmentId`, so any neutral snapshot field rename needs a legacy read path for development databases that replay prior migrations; the new write path uses the neutral key.

**Alternatives considered**: Break response shape now (contradicts explicit compatibility decision) or leave Duffel names throughout domain code (contradicts full internal rename). A later versioned API can remove the edge aliases.

## 6. Schema migration

**Decision**: Add a forward Prisma migration that physically renames non-webhook Duffel ID columns and related indexes/constraints, then regenerate Prisma client and update all references. Do not edit committed migration history, use `@map`, or drop and recreate populated tables. Preserve `DuffelWebhookEvent` table and its Duffel-specific fields. Rename persisted saga checkpoint/string identifiers only when all readers/writers and migration handling can be updated together.

**Rationale**: No production data reduces deployment risk, but a clean CI database still replays committed migrations. Forward SQL with `ALTER TABLE ... RENAME COLUMN` preserves development data and validates history. Existing schema includes `Booking.duffelOrderId`, `BookingIntent.duffelOfferId`, passenger IDs in three models, `FlightOffer.duffelOfferId`, segment ID, quote ID, and `duffelOfferIdHash` plus indexes.

The complete current schema inventory also includes `Booking.lastDuffelSyncedAt` and `nextDuffelSyncAt`. Historical migration SQL and existing webhook model keep their Duffel text. Literal persisted values such as `duffel_order_created` and `DUFFEL_COST` require a separate reader/writer compatibility check; they are not column names.

**Alternatives considered**: Editing prior migrations makes existing dev databases diverge; `@map` leaves old physical names; dropping tables loses useful local data.

## 7. Dependencies and validation

**Decision**: Keep installed `@duffel/api` ^4.28.0, NestJS, Prisma, Redis, Stripe, Next.js, and Python agent versions. No new package. Use current focused Jest/Node/Python tests, clean Prisma migration, and the pre-PR gates in `context/testing.md` during implementation.

**Rationale**: This is a boundary refactor. Current `context/library-docs.md` documents Duffel base URL validation and mock-server behavior. The installed skill catalog has no Duffel/Prisma/NestJS-specific skill; project library guidance and current code were used. The installed Next.js documentation must be read before any later Next.js code edit, per `AGENTS.md`.

**Alternatives considered**: A new provider abstraction or new test framework adds cost without satisfying a current requirement.

No `NEEDS CLARIFICATION` remains for the planned extraction mechanics or budget policy.
