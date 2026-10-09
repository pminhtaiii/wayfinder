# Phase 0 Research: Ancillary Seat and Baggage Checkout

All technical unknowns are resolved for planning. The approved product decisions come from `docs/adr/0003-ancillary-services.md`; repository evidence comes from the current Feature 9-14 implementation.

## 1. Feature boundary and flow placement

- **Decision**: Add one independently skippable Ancillaries route after passenger details and before read-only review, with Seats and Baggage as switchable sections.
- **Rationale**: Passenger records already exist on `BookingIntent`, enabling named tabs, infant exclusion, age validation, and stable supplier-passenger mapping. One page minimizes flow steps while preserving a clear review boundary.
- **Alternatives considered**: Ancillaries before passenger details; separate seat and baggage pages; inline editing on review. Rejected because they either lack passenger identity, increase abandonment, or blur commit/review state.

## 2. Supplier authority and service validation

- **Decision**: Duffel is the sole authority for seat maps, available services, service ownership, availability, and final price. The server re-fetches/reprices at commitment and validates every submitted service against offer, Duffel passenger, segment coverage, amount, and currency before payment authorization.
- **Rationale**: Local locks cannot prevent inventory sales through other distribution channels. The current `DuffelService` already centralizes offer lookup and order creation, making it the correct adapter seam.
- **Alternatives considered**: Redis seat locks; trusting client-copied service objects; client-only validation. Rejected as incomplete concurrency/security controls.

## 3. Custom seat map representation

- **Decision**: Normalize Duffel seat-map cabins, rows, sections, elements, and services into a project-owned read contract, then render it with project components.
- **Rationale**: The approved interaction requires direct price-state integration, passenger/segment indicators, accessibility semantics, and design-system tokens that a drop-in widget cannot guarantee.
- **Alternatives considered**: `@duffel/components` ancillary widget; rendering raw supplier JSON. Rejected for styling/state limitations and contract leakage.

## 4. Segment/passenger identity

- **Decision**: Persist selections against local `BookingIntentPassenger.id`, supplier passenger ID, and supplier segment ID. Use `serviceId` as the actionable supplier identity and `seatDesignator` only for display.
- **Rationale**: The current BookingIntent passenger position/type mapping is not itself a durable Duffel ID mapping. Capturing both identities makes validation and order payload construction explicit while maintaining ownership via BookingIntent.
- **Alternatives considered**: Passenger array index; seat designator as identity; route/flight-number keys. Rejected because indexes and display labels are ambiguous across refreshes and segments.

## 5. Persistence model

- **Decision**: Add append-only normalized `AncillarySelection`, `SeatSelection`, and `BaggageSelection` versions owned by `BookingIntent`, plus an optimistic `ancillaryVersion`, current-snapshot pointer, validated timestamp, and aggregate current totals. Payment stores a restrictive foreign-key reference to the exact snapshot it priced. Keep the short-lived supplier catalog in Redis rather than PostgreSQL.
- **Rationale**: Normalized rows enforce uniqueness and coverage constraints, allow auditable server reconciliation, and preserve the exact service rows needed by payment recovery after a later selection becomes current. BookingIntent identifies the editable current version, while Payment recovery never follows that mutable pointer.
- **Alternatives considered**: Replacing one active snapshot; one opaque JSON snapshot only; final Booking-only persistence; dedicated reservation service/database. Replacement erases recovery inputs, JSON-only weakens constraints/queryability, final-only loses crash recovery, and a new service is unjustified.

## 6. Client state and recovery

- **Decision**: Keep pre-Continue browsing state in a client reducer/store. On Continue, persist the normalized snapshot to BookingIntent and store a minimal intent/version/expiry-bound localStorage copy. Server state wins during reconciliation.
- **Rationale**: Instant interactions need local state; committed selections must survive navigation and tab closure. Version checking prevents stale local state from overwriting newer server state.
- **Alternatives considered**: Re-save on every click; sessionStorage; localStorage as authority. Rejected for request/API overhead, inadequate crash recovery, and tampering/staleness risk.

## 7. Price tracking and currency

- **Decision**: Use decimal-safe minor-unit arithmetic in one ISO 4217 currency for the client estimate and server totals. Browse total is `base + seats + baggage`; Duffel repricing supplies the authoritative commitment amount.
- **Rationale**: The current payment record stores minor units while BookingIntent prices are decimals. Explicit conversion prevents floating-point and unit drift.
- **Alternatives considered**: Floating-point summation; client currency conversion; repricing on every interaction. Rejected for correctness, unsupported authority, latency, and API budget.

## 8. Seat-map caching

- **Decision**: Use the approved `seatmap:{offerId}` key with a 60-second TTL, treat TTL `<=3` seconds as a miss, and provide a force-refresh bypass through the existing CacheService `get`/`getTtl`/`set` seam. Cache only supplier-native offer/segment/service data and Duffel passenger IDs. Derive Duffel-to-local passenger mappings per authenticated BookingIntent after each cache read; never cache the intent-specific projection.
- **Rationale**: Existing `CacheService` already provides `get`, `set`, `del`, and `getTtl` with Redis/in-memory fallback. The short TTL absorbs bursts without making checkout correctness depend on cache freshness.
- **Alternatives considered**: No cache; 2-3 minute cache; caching selected state. Rejected for supplier cost, volatility, and privacy/state correctness.

## 9. Journey-wide baggage

- **Decision**: Derive scope from supplier `segment_ids`; enforce mutual exclusion for overlapping same-passenger/same-tier coverage in both client reducer and server validation. Store a journey-wide service once and project it into all covered segment views.
- **Rationale**: Duplication per tab would overcount price and risk double purchase.
- **Alternatives considered**: Copy the same service into every segment; permit overlaps and rely on Duffel rejection. Rejected because the local total and review would be misleading.

## 10. Payment and supplier order integration

- **Decision**: Preserve the current two-request payment flow and manual-capture state machine. Payment creation atomically freezes an ancillary snapshot/version, calls installed-SDK `offers.getPriced(offerId, { intended_payment_methods, intended_services })` outside the transaction, CAS-persists the authoritative total, then creates Stripe only if the same frozen version still owns checkout. Extend `DuffelService.createOrder()` with validated `services[]`. Preserve recovery points and compensation behavior.
- **Rationale**: `PaymentService` already acquires idempotency keys, creates a manual-capture PaymentIntent, verifies `requires_capture`, creates the Duffel order, captures, and compensates failures. A parallel checkout pipeline would duplicate the riskiest logic.
- **Alternatives considered**: Separate ancillary PaymentIntent; new checkout orchestrator replacing PaymentService; client-calculated charge amount. Rejected for multiple card charges, regression risk, and tampering.

## 11. Idempotency and concurrency

- **Decision**: Require an idempotency key for ancillary snapshot confirmation and reuse existing request-hash/replay semantics. Use BookingIntent optimistic version/CAS so two tabs cannot silently overwrite committed selections. Checkout binds the Payment to one validated snapshot version.
- **Rationale**: Existing `IdempotencyKey` and Payment recovery points cover payment/order retries but not selection overwrite races. A version precondition closes that gap without a new lock service.
- **Alternatives considered**: Last write wins; distributed lock; payment key alone. Rejected because last-write loses data, distributed locking is unnecessary, and the payment key begins too late.

## 12. Error contract

- **Decision**: Return stable machine codes and structured invalid-selection details for expired intent/offer, version conflict, price change, unavailable service, wrong passenger/segment, mixed currency, and supplier failure. Use 409 for recoverable stale/conflict states, 410 for expired intent/offer, 403 for ownership, and 502/503 for supplier availability.
- **Rationale**: The UI must preserve valid selections, refresh catalog data, and focus the affected passenger/segment without parsing prose.
- **Alternatives considered**: Generic 400/500 errors; discarding the entire snapshot on any conflict. Rejected for weak recovery UX and observability.

## 13. Accessibility and responsive boundary

- **Decision**: Implement semantic tablists, labelled seat buttons, keyboard navigation, focus restoration, live price/status announcements, non-color-only seat states, and reduced-motion behavior. Desktop-first permits horizontal seat-grid scrolling; it does not waive keyboard or semantic accessibility.
- **Rationale**: The custom renderer owns accessibility. Existing project rules prohibit raw color values/classes and require reusable components.
- **Alternatives considered**: Pointer-only grid; color-only passenger mapping; a fully bespoke mobile seat layout in this phase. Rejected for accessibility or approved scope.

## 14. Cancellation/refund compatibility

- **Decision**: Do not calculate ancillary refunds locally. Preserve Duffel cancellation quote fields and existing supplier-first refund recovery; add display/test coverage proving non-refundable ancillary exclusions are communicated.
- **Rationale**: Current cancellation logic treats Duffel's quote as authoritative. Recomputing ancillary refundability would create two financial truths.
- **Alternatives considered**: Separate ancillary refund tables/workflow; prorating locally. Rejected as incorrect and out of scope.

## 15. Observability and rollout

- **Decision**: Emit structured PII-safe logs/traces/metrics for catalog fetch/cache outcomes, validation conflicts by code, snapshot commits/version conflicts, repricing delta, service count/value, and checkout compensation. Protect catalog and checkout integration behind independently controllable flags.
- **Rationale**: Constitution Principles III-IV require API-budget visibility and operational diagnosis; additive flags preserve rollback.
- **Alternatives considered**: One feature flag for all behavior; raw supplier payload logs. Rejected because rollout cannot isolate failures and raw payloads may contain sensitive data.

## Resolved dependencies

- NestJS services/controllers/DTOs and Prisma follow existing backend conventions.
- Next.js App Router uses Server Components for owned intent/catalog loading and narrowly scoped Client Components for interactive selection state.
- Redis uses the existing injectable `CacheService`; no queue or new cache library is required.
- Stripe and Duffel use existing adapters; no new third-party dependency is required for the core feature.
- Jest, real-database Nest E2E, and Playwright provide unit, contract/integration, and browser proof.
