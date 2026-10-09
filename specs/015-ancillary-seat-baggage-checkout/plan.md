# Implementation Plan: Ancillary Seat and Baggage Checkout

**Branch**: `015a-ancillary-seat-baggage-checkout` | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md) | **PRD**: [prd.md](./prd.md)

**Input**: Approved Feature 15 decisions in `docs/adr/0003-ancillary-services.md` and the feature specification in `spec.md`.

## Summary

Add a deterministic, user-owned ancillary checkout slice between passenger details and review. The backend will normalize/cache Duffel seat maps and services, persist optimistic-versioned segment/passenger selections on BookingIntent, revalidate and reprice the exact offer/services before payment, and extend the existing manual-capture Stripe/Duffel saga rather than introduce a second transaction path. The frontend will rebuild the currently missing real checkout foundation, render a custom accessible seat map and baggage selector, keep browsing interactions local and instant, persist only committed recovery state, and expose a read-only review with targeted edit links.

The plan explicitly treats the absent live search/passenger/review/payment UI as a prerequisite. Historical deleted demo checkout code is evidence only and must not be restored as production behavior.

## Technical Context

**Language/Version**: TypeScript 5.4 on Node.js >=20; SQL migrations for PostgreSQL

**Primary Dependencies**: NestJS 10, Next.js 14.2.3 App Router, React 18.3, Prisma 5.14, `@duffel/api` 4.28, Stripe 15.12, ioredis 5.4, class-validator 0.14, Zod 3.23, Tailwind 4 alpha semantic tokens

**Storage**: PostgreSQL for BookingIntent-owned normalized committed selections/payment binding; Redis/in-memory fallback for 60-second PII-free supplier catalogs; localStorage for minimal TTL-bound post-Continue recovery metadata

**Testing**: Jest/ts-jest unit tests, NestJS Jest E2E with PostgreSQL and supplier/payment stubs, Playwright 1.41 browser tests, TypeScript build/typecheck, ESLint

**Target Platform**: Linux-hosted NestJS/Next.js services; evergreen desktop browsers for the custom seat grid; controls remain keyboard/zoom accessible at narrow widths

**Project Type**: pnpm monorepo web application (`apps/api`, `apps/web`, `packages/shared`)

**Performance Goals**:

- client price update visible within 100 ms and with zero browse-time repricing calls;
- cached ancillary catalog read below 200 ms p95 at the API boundary;
- seat-map miss/force refresh bounded by existing Duffel timeout/rate controls;
- no external API call inside a database transaction;
- payment/order behavior retains existing recovery/compensation SLOs.

**Constraints**:

- Duffel is authoritative for availability, service association, exact price, order, and cancellation quote;
- one currency per offer/selection/payment with explicit major/minor conversion;
- no AI in selection, pricing, payment, or order creation;
- no raw supplier passenger payload, passport/contact data, card data, or Stripe secret in Redis/localStorage/logs;
- no hardcoded hex values or raw Tailwind color classes;
- no new global client state library; use focused reducer/local state;
- no mobile-specific seat-map redesign in Feature 15a;
- existing cancellation/refund math remains supplier-quote authoritative.

**Scale/Scope**: One offer/BookingIntent at a time; multiple segments and passengers; seats plus checked/carry-on baggage only; browsing catalog TTL 60 seconds; one PaymentIntent and one Duffel order per successful checkout.

## Constitution Check — Pre-Design Gate

- **I. Flight-first architecture — PASS**: seat and baggage services are optional additions to the selected flight and cannot block base-fare checkout when skipped.
- **II. Deterministic transaction boundary — PASS**: NestJS/Prisma/Duffel/Stripe services own all authoritative operations; the AI service is absent.
- **III. API budget discipline — PASS**: no browse-time repricing, 60-second seat-map cache, early-expiry refresh, force-refresh observability, and existing rate/budget controls bound Duffel traffic.
- **IV. Operational visibility — PASS WITH PLANNED WORK**: structured logs, audit events, cache/supplier/validation/payment outcomes, trace/correlation propagation, and rollout health checks are implementation deliverables. The repository has no general Prometheus abstraction, so the phase first uses existing Logger/AuditService/health patterns and adds metrics only through an approved existing seam.
- **V. Incremental delivery — PASS**: phases are schema-compatible, independently testable, feature-flagged vertical increments.
- **Security requirements — PASS WITH PLANNED WORK**: ownership/expiry/version checks, server-side service validation, minor-unit money handling, PII-safe cache/contracts, and existing Stripe-hosted card boundary are explicit gates.

Pre-design gate result: **PASS**. No unresolved clarifications remain.

## Project Structure

### Feature documentation

```text
specs/015-ancillary-seat-baggage-checkout/
├── prd.md
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    └── api.md
```

### Planned source layout

```text
apps/api/
├── prisma/
│   ├── schema.prisma
│   └── migrations/<timestamp>_add_ancillary_checkout/
├── src/
│   ├── ancillaries/
│   │   ├── ancillaries.module.ts
│   │   ├── ancillaries.controller.ts
│   │   ├── ancillaries.service.ts
│   │   ├── ancillary-catalog.service.ts
│   │   ├── ancillary-selection.validator.ts
│   │   ├── ancillary-pricing.ts
│   │   ├── dto/
│   │   └── *.spec.ts
│   ├── booking-intent/
│   │   ├── booking-intent.service.ts
│   │   ├── booking-intent.controller.ts
│   │   └── dto/
│   ├── cache/cache.service.ts
│   ├── duffel/
│   │   ├── duffel.service.ts
│   │   └── duffel.types.ts
│   ├── payment/
│   │   ├── payment.service.ts
│   │   ├── payment-idempotency.service.ts
│   │   └── dto/create-payment.dto.ts
│   └── booking/booking.service.ts
└── test/
    ├── ancillary-checkout.e2e-spec.ts
    ├── booking-intent.e2e-spec.ts
    ├── payment.e2e-spec.ts
    ├── payment-idempotency.e2e-spec.ts
    └── cancellation.e2e-spec.ts

packages/shared/src/
├── types/ancillary.types.ts
├── types/booking-intent.types.ts
├── types/payment.types.ts
└── types/index.ts

apps/web/
├── app/
│   ├── search/                              # real entry prerequisite if still absent
│   └── checkout/
│       ├── passengers/page.tsx
│       └── [intentId]/
│           ├── ancillaries/page.tsx
│           ├── review/page.tsx
│           └── payment/page.tsx
├── components/checkout/
│   ├── PassengerDetailsForm.tsx
│   ├── AncillarySelectionClient.tsx
│   ├── SegmentTabs.tsx
│   ├── PassengerStepper.tsx
│   ├── SeatMap.tsx
│   ├── SeatCell.tsx
│   ├── BaggageSelector.tsx
│   ├── PriceTracker.tsx
│   ├── BookingReview.tsx
│   └── CheckoutLoadingEscalation.tsx
├── lib/
│   ├── ancillary-selection.ts
│   └── ancillary-recovery.ts
└── tests/
    └── ancillary-checkout.spec.ts
```

**Structure decision**: Add one NestJS `ancillaries` domain module responsible for supplier catalog normalization and BookingIntent-owned selection commands. Keep payment orchestration in the existing PaymentService, supplier transport in DuffelService, caching in CacheService, and wire contracts in `packages/shared`. Next Server Components own authenticated initial fetch; narrowly scoped Client Components own interactive reducer state and mutations.

## Dependency and delivery map

```text
PR 1 checkout foundation/baseline
          |
PR 2 schema + shared contracts
          |
PR 3 Duffel catalog/cache adapter
          |
PR 4 owned selection API + optimistic commit
          |
PR 5 seat/baggage interactive UI
          |
PR 6 authoritative validation + payment/order saga
          |
PR 7 review, recovery, cancellation disclosure
          |
PR 8 E2E, resilience, observability, rollout/docs
```

PR 1 and PR 2 may be prepared in parallel only after their route/type contract is frozen. PR 5 starts against PR 4 contracts. PR 6 is the financial gate and must not be enabled until backend E2E passes. Every PR is additive or feature-flagged and must keep base-fare checkout compatible.

## Phase 0 / PR 1 — Reconcile and restore a real checkout foundation

**Goal:** establish a navigable, authenticated production checkout shell in the live tree before ancillary work depends on it.

### Work

1. Confirm the live-tree baseline in CI: `/search`, passenger entry, review, payment UI, Stripe Elements integration, and `components/ui` are absent despite historical specs; document this as a prerequisite rather than relying on deleted demo code.
2. Choose one real entry path from a selected `FlightOffer` into `/checkout/passengers?offerId=...`; rebuild the minimum real search/detail CTA required to exercise it if `/search` remains absent. Do not restore the historical fake PNR/preview path.
3. Add protected Server Component shells for passengers, ancillaries, review, and payment using `getServerSession`, bearer-token Nest fetches, `cache: 'no-store'`, and existing session-expiry redirect behavior.
4. Implement passenger-details UI against existing BookingIntent create/prefill/get contracts, including domestic/international document rules, named passengers, and real returned intent/passenger IDs.
5. Define URL navigation contract: route path carries intent ID; `section`, `segment`, and `passenger` may locate UI state; selections and PII never enter the URL.
6. Resolve the current Wayfinder versus `FlightSystem` visual split for these routes using the existing semantic-token system. New code must not introduce raw colors.
7. If payment UI is in the release slice, add official Stripe Elements client packages only after repository third-party guidance/version verification; otherwise create an explicit disabled handoff seam and block feature completion until real authorization UI exists.
8. Add a narrow feature flag so restored checkout routes can ship hidden while backend work proceeds.

### Tests

- Server route authentication, session expiry, unavailable API, and intent ownership/error rendering.
- Passenger form validation/prefill for adult/child/infant and domestic/international document cases.
- Playwright smoke path from real selected offer to created BookingIntent and protected ancillary placeholder.
- Assert no simulated PNR, local-only booking, or supplier call from Next.js exists.

### Exit criteria

- A real selected offer creates an owned BookingIntent with stable passenger IDs and reaches a protected ancillary placeholder.
- The route shell is buildable, accessible, and gated independently of the existing booking-management UI.

## Phase 1 / PR 2 — Shared contracts, state repair, additive schema, and migration

**Goal:** create the durable identities, monetary semantics, and version boundary required before supplier/UI integration.

### Work

1. Add shared normalized catalog, seat, baggage, selection, price-breakdown, error, and API types in `packages/shared/src/types/ancillary.types.ts`; export them without frontend/backend redefinition.
2. Extend BookingIntent with optimistic `ancillaryVersion`, current read projections for status/totals/currency/validation time, an append-only collection of normalized selection versions, and `currentAncillarySelectionId` pointing to the latest version from [data-model.md](./data-model.md). Store authoritative validated base/grand totals on each snapshot so recovery never reads mutable intent projections.
3. Add `duffelPassengerId` to BookingIntentPassenger. Populate it at new intent creation from the fetched offer; define a deterministic type+ordinal fallback only for legacy active intents and record mismatch as a validation conflict.
4. Add AncillarySelection, SeatSelection, BaggageSelection, and BaggageSelectionSegment constraints. Enforce one seat per passenger/segment and non-duplicated supplier service identities. Keep overlap rules in deterministic validation because they span coverage rows.
5. Bind Payment through an `ON DELETE RESTRICT` foreign key to the immutable AncillarySelection row plus its denormalized version used for amount/order recovery. Do not overload `confirmedPrice`; preserve separate base, ancillary, and authoritative grand totals.
6. Resolve the existing BookingIntent status mismatch: freshly created intents are `PENDING`, while PaymentService currently checks a non-enum `CREATED` path. Specify and implement legal `PENDING -> AWAITING_PAYMENT -> CONFIRMED/terminal` transitions before ancillary integration.
7. Create and inspect an additive Prisma migration, including existing-row defaults/backfill behavior, indexes, check constraints where Prisma cannot express them, and rollback compatibility.
8. Keep expired-intent cascade cleanup for unreferenced snapshots, but skip intents/snapshots protected by retained Payment or recovery references. Add regression proof rather than a parallel ancillary cleanup worker.

### Tests

- Shared contract compile tests and serialization fixtures.
- Migration against current Feature 14 data plus an empty database.
- Database constraint tests for passenger/segment seat uniqueness, `(bookingIntentId, version)`, current-pointer integrity, Payment snapshot foreign-key restriction, coverage join uniqueness, currency/quantity bounds, and safe cascade cleanup.
- BookingIntent state transition and legacy passenger-mapping tests.

### Exit criteria

- Migration is backward compatible with base-fare intents/payments.
- Every selection/payment can be traced to one owned intent, supplier passenger, exact version, and currency without reading client state.

## Phase 2 / PR 3 — Duffel ancillary catalog, normalization, and cache discipline

**Goal:** expose one typed, PII-safe, budget-aware supplier adapter for seat maps, services, and exact repricing.

### Work

1. Read the installed Duffel SDK/version documentation available in the package before coding; verify exact Seat Maps, available-services, price-action, order `services[]`, quantity, and error response shapes against `@duffel/api` 4.28 rather than training-memory syntax.
2. Extend `duffel.types.ts` with narrow raw adapter types and project normalized types. Controllers/services outside the adapter never consume raw SDK objects.
3. Add `getSeatMaps(duffelOfferId)` and available-services retrieval with existing timeout, rate-limit, trace/correlation, and safe error normalization patterns.
4. Normalize segment IDs, supplier passenger bindings, cabins/rows/elements, seat services, baggage scope/weight/quantity, currency/amount, and missing-map status. The offer-scoped cached value contains Duffel IDs only—never local BookingIntent/passenger IDs or names. Reject or quarantine incomplete supplier associations instead of guessing.
5. Add exact offer+service repricing through installed-SDK `offers.getPriced(offerId, { intended_payment_methods, intended_services })`. The adapter returns authoritative base, service lines, grand total, currency, and invalid/unavailable service identities.
6. Extend `createOrder()` to accept only validated normalized service ID/quantity input and include it in the current idempotent raw REST request.
7. Implement catalog caching via CacheService: `seatmap:{offerId}`, 60 seconds, `getTtl() > 3` hit, missing/`-2`/`-1`/`<=3` miss, force-refresh bypass and overwrite. Avoid caching passenger PII or committed selection state.
8. Add cache/supplier/audit instrumentation using current Logger/AuditService/trace seams; do not invent an unused metrics framework.

### Tests

- Golden redacted fixtures for multi-cabin maps, aisles/exit rows, unavailable seats, no map, multiple passengers, segment/journey baggage, unknown fields, and supplier error shapes.
- Cache hit/miss, TTL boundaries 4/3/0/-1/-2, force refresh, Redis fallback, concurrent request deduplication if the existing cache seam supports it, and proof that cached values contain no intent-local identifiers.
- Repricing exact totals/currency and unavailable/tampered service mapping.
- Order payload includes each validated service exactly once with stable idempotency key.

### Exit criteria

- Catalog read has one project-owned contract and never leaks raw supplier/PII data.
- Browsing invokes no price action; checkout repricing and order creation use tested exact payloads.

## Phase 3 / PR 4 — Owned ancillary read/commit API and optimistic recovery boundary

**Goal:** allow authenticated travellers to fetch and commit a canonical selection snapshot without payment side effects.

### Work

1. Add `AncillariesModule`, protected controller, catalog service, selection validator, pricing utility, and DTOs implementing [contracts/api.md](./contracts/api.md).
2. For every read/mutation: validate UUID, fetch the intent, and enforce user ownership, active status, and intent/offer expiry before catalog access. After reading the supplier-native cached catalog, derive the Duffel-to-local passenger mapping from that authenticated intent in request scope.
3. Implement catalog read with `refresh=true`, current canonical selection, cache metadata, named non-PII passenger view, and no raw supplier payload. Never persist the intent-specific passenger projection in the shared offer cache.
4. Implement pure validation for service membership, passenger/segment scope, infant exclusion, duplicate group seat, baggage quantity, journey/segment overlap, equivalent tier, and single currency.
5. Implement idempotent selection commit with `Idempotency-Key`, request hash/replay, and expected-version CAS. In one short transaction, insert a new immutable snapshot and child rows, atomically advance the BookingIntent current pointer/version/totals, invalidate current validation status, and write the audit event. Never replace, upsert, mutate, or delete older snapshot service rows.
6. Reuse exported PaymentIdempotencyService through the module graph if it remains acyclic; extract a narrowly scoped IdempotencyModule only if an actual dependency cycle appears. Before reuse, require existing idempotency rows to match both `customerId` and `requestPath` as well as request hash so a globally unique key cannot replay another user's or endpoint's response; cover the same checks in the race path.
7. Return structured 409 conflicts containing the canonical version and targeted invalid selections. Do not silently overwrite server state or clear unrelated valid selections.
8. Lock edits once the exact version enters payment processing; define safe resume behavior for failed/pre-authorization attempts.

### Tests

- Controller/service ownership 403, missing 404, expired 410, invalid UUID, and zero supplier call on rejected access.
- Two BookingIntents sharing one Duffel offer reuse the same supplier catalog while each response and validation uses only its own local passenger mapping.
- Every tampering/overlap/currency/infant/duplicate invariant with table-driven pure tests.
- Real-database atomic commit/rollback, CAS race between two tabs, idempotent replay/different-body conflict, append-only N-to-N+1 history, and audit attribution.
- Empty selection commit remains a valid skip path.

### Exit criteria

- One canonical server snapshot/version survives reload and cannot be overwritten by a stale tab.
- No commit route creates PaymentIntent, Duffel order, or captured charge.

## Phase 4 / PR 5 — Custom seat map, baggage selection, and instant price tracker

**Goal:** deliver the interactive ancillary browsing experience against the canonical API.

### Work

1. Server-render the protected ancillary route with owned intent/catalog/selection data; keep only interaction state in `AncillarySelectionClient`.
2. Implement a pure reducer keyed by `[segmentId][intentPassengerId]`, with actions for seat select/deselect, baggage quantity, journey-wide projection/removal, catalog refresh reconciliation, and server hydration.
3. Build SegmentTabs above PassengerStepper. Omit lap infants from seat tabs with explanation; allow free passenger navigation; missing maps use the approved airline-assigned message.
4. Build custom SeatMap/SeatCell from normalized layout. Never infer selection identity from designator or position. Distinguish active passenger, other named group passenger, supplier unavailable, restricted, and available states with text/icon plus semantic tokens.
5. Implement labelled grid/buttons, roving tabindex, Arrow navigation, Enter/Space selection, focus restoration after passenger/segment changes, visible focus, reduced motion, and accessible legend/status.
6. Build BaggageSelector grouped by Full journey/This flight only. Enforce and explain journey-wide mutual exclusion and cross-tab reflection; calculate `Save X` only for equivalent supplier tiers.
7. Build decimal-safe PriceTracker with base/seat/baggage/grand-total breakdown, sticky layout that does not obscure zoomed content, and polite live announcements. Generate zero repricing requests while browsing.
8. Add force refresh that reconciles the new catalog: preserve still-valid service IDs, mark removed/changed selections, and require explicit resolution rather than silently substituting.
9. Continue uses a fresh UUID idempotency key, disables double submit, commits the current snapshot, then writes a minimal versioned/TTL-bound local recovery record and navigates to review.

### Tests

- Pure reducer/property tests for strict passenger/segment isolation, no duplicate group seat, baggage overlap, projection counted once, refresh reconciliation, and currency math.
- Component tests where supported for tab/grid semantics, keyboard movement, names/status, missing map, disabled reasons, and live price announcements.
- Playwright slices for single/multi-segment seats, group indicators, infant skip, journey baggage, force refresh, price latency/no reprice, keyboard, zoom/narrow viewport, and double-submit prevention.

### Exit criteria

- Two passengers/two segments can independently select or skip seats and baggage with exact instant totals.
- The page meets the accessibility contract without color-only meaning or pointer-only interaction.

## Phase 5 / PR 6 — Authoritative validation, payment amount, and Duffel order services

**Goal:** connect one immutable validated selection version to the existing financial saga without weakening recovery.

### Work

1. Implement an internal validate/freeze command invoked by `POST /bookings/payment/create`: verify active owned intent/version, mark/freeze the candidate in a short CAS transaction, release DB locks, call Duffel repricing outside the transaction, then conditionally persist validated totals/status only if the same version remains frozen.
2. Return targeted unavailable/service/price conflicts. Preserve valid selections, invalidate the snapshot for payment, and require traveller acknowledgement/revalidation after a price change.
3. Move authoritative repricing before Payment attempt consumption/`AWAITING_PAYMENT` mutation so supplier failures do not burn one of the existing attempt limits.
4. Extend CreatePaymentDto with `ancillarySelectionId` and `ancillarySelectionVersion`; only after the CAS/reprice succeeds, persist the authoritative base/grand totals on that snapshot, store its ID/version on Payment, transition it to `PAYMENT_BOUND`, and compute the Payment amount from `validatedGrandTotal` in minor units. Empty selections keep base-fare behavior. A separate preview endpoint must never be the sole checkout validation.
5. Bind Payment/event/recovery metadata to intent ID, snapshot version, service counts, and safe totals. Never store seat-map or passenger payload in PaymentEvent/log metadata.
6. Pass exact validated `{serviceId, quantity}` values to Duffel order creation. Re-check intent/version freeze immediately before supplier order if retry recovery can span edits; edits are rejected once payment begins.
7. Preserve current saga: verify `requires_capture`, create Duffel order with stable idempotency key, capture Stripe, or cancel authorization/compensate supplier order on failures. Recovery always loads service rows through the Payment-bound snapshot ID, never the BookingIntent current pointer, even after a newer selection version is committed.
8. Exercise status/recovery behavior at every existing recovery point; a captured charge must never be paired with a silently different ancillary snapshot.

### Tests

- Repricing occurs once per validation/checkout boundary and always outside DB transactions.
- Price/service/version changes before and after freeze produce zero premature Stripe calls.
- Exact major-to-minor conversion for base + seat + baggage; mixed currency rejected.
- Success creates one PaymentIntent, one Duffel order containing exact services, one capture, one Booking.
- Supplier failure cancels authorization; capture failure uses existing supplier/payment compensation; crash/retry resumes at every recovery point without duplication. A failed Payment bound to version N still reconstructs N after version N+1 becomes current.
- Existing payment/idempotency/ledger/booking tests remain green for empty ancillary selection.

### Exit criteria

- Payment and order are provably bound to one authoritative selection version and amount.
- No new payment state machine or parallel compensation path exists.

## Phase 6 / PR 7 — Read-only review, targeted edits, recovery, and cancellation disclosure

**Goal:** complete the traveller loop and preserve correct post-failure/refund communication.

### Work

1. Server-render review from canonical BookingIntent selection and validated totals. Show passenger/segment seat assignments, baggage coverage, base/ancillary/grand total, and no inline mutation controls.
2. Add targeted Edit seats/Edit baggage links that return with `section` and optional segment/passenger location while preserving the other server snapshot.
3. Implement localStorage recovery helper containing only schema version, intent ID, selection version, selected supplier IDs/display metadata, updated/expiry timestamps, and safe ownership marker. Never store passenger/contact/document/card data.
4. On route load/reopen, compare local record with authenticated server intent/version/expiry. Server wins; discard wrong intent/user, expired, malformed, or divergent state and announce recovery outcome.
5. Make payment-page conflict handling route travellers back to the exact affected section/segment/passenger with canonical error details; preserve unaffected selections.
6. Extend confirmed booking presentation/audit only to the minimum approved ancillary summary needed after purchase. Do not duplicate the full volatile seat map.
7. Preserve Duffel-authoritative cancellation/refund math. Extend quote/response/UI to expose `refund_to` and clear non-refundable ancillary exclusion when the supplier provides it; never calculate a second refund amount.
8. Verify intent expiry/delete cascade and client snapshot expiry. No separate stale-selection cron is introduced.

### Tests

- Review is read-only, totals match server, and targeted edit navigation restores correct UI position/state.
- Reload/tab-close recovery, malformed/wrong-user/wrong-intent/version/expired discard, and localStorage PII leakage assertions.
- Stale selection/price conflicts focus the affected scope and prevent payment until revalidated.
- Cancellation quote with refundable and non-refundable ancillary fixtures preserves supplier amount/currency/destination and existing recovery behavior.

### Exit criteria

- A traveller can commit, review, edit, recover, validate, and resume without ambiguous authority or leaked data.
- Existing supplier-first cancellation/refund invariants remain unchanged.

## Phase 7 / PR 8 — End-to-end resilience, observability, rollout, and documentation sync

**Goal:** prove the full slice across real seams and make failures visible before broad enablement.

### Work

1. Complete `apps/api/test/ancillary-checkout.e2e-spec.ts` with real test DB, deterministic clock, Redis/cache seam, mocked Duffel catalog/reprice/order, and mocked Stripe manual capture.
2. Complete Playwright checkout journeys using existing auth and mock-scenario cookie/network patterns without mutable production test hooks. Ensure `NEXT_PUBLIC_API_URL` is defined and avoid route-announcer strict-mode ambiguity.
3. Run migration verification on current data, shared/API/web builds, typecheck/lint, focused unit suites, complete backend E2E, and Playwright.
4. Execute controlled failure checkpoints: stale catalog, selection race, crash after snapshot freeze, repricing timeout, Stripe authorization then Duffel failure, Duffel success then capture failure, retry from each recovery point, Redis outage, and intent expiry.
5. Emit and verify PII-safe structured events/audits for catalog cache result, Duffel latency/error, validation reason, version conflict, commit/validate, price delta, payment/order services count/value, idempotent replay, and compensation.
6. Extend health/operational visibility using the project's real logging/audit/health seams. Define dashboard/alert integration only where the codebase has an approved exporter; document any follow-up rather than claiming nonexistent telemetry.
7. Add independent flags for ancillary catalog/read, selection commit/UI, and payment/order services. Roll out read-only catalog first, then commit/UI canary, then financial integration.
8. Rehearse rollback in reverse: disable ancillary payment/order, UI commit, then catalog. Preserve BookingIntent selections/payments; empty selection/base checkout stays functional.
9. Update `context/architecture.md`, `context/progress-checker.md`, `CONTEXT.md`, and any touched library/workflow guidance to actual implemented state only. Retain the ADR as decision history.
10. Complete CodeRabbit review/convergence for implementation PRs per repository instructions.

### Final verification matrix

| Invariant                                        | Proof                                          |
| ------------------------------------------------ | ---------------------------------------------- |
| Selection never crosses passenger/segment        | reducer/property tests + API E2E + Playwright  |
| Cache obeys 60s/3s/force refresh                 | adapter unit + API E2E                         |
| Tampered/stale service creates no payment/order  | API E2E call-count assertions                  |
| Client browsing makes no reprice call            | Playwright network assertion                   |
| One version binds price/payment/order            | DB assertions + saga E2E                       |
| Retry creates at most one PI/order/capture       | idempotency/recovery E2E                       |
| Supplier failure releases/recovers authorization | payment compensation E2E                       |
| Review/recovery is canonical and PII-safe        | Playwright + storage/log leakage tests         |
| Cancellation remains quote-authoritative         | cancellation/refund E2E                        |
| Base-fare checkout remains compatible            | existing full suites                           |
| Keyboard/non-color interaction works             | semantic/component + Playwright keyboard proof |

### Exit criteria

- Every measurable success criterion in [spec.md](./spec.md) has passing evidence.
- All existing booking, payment, ledger, cancellation/refund, and disruption suites remain green.
- Flags/rollback are rehearsed and operational failures are visible through implemented seams.
- Context documentation matches the live tree and does not mark Feature 15 complete prematurely.

## Test seam strategy

Use the smallest stable seams that prove externally visible invariants:

1. **Pure normalization/selection/pricing functions** for catalog shape, overlap, isolation, and exact arithmetic.
2. **Ancillary REST API + real database + Duffel/cache stubs** for ownership, tampering, CAS, idempotency, persistence, and conflicts.
3. **Existing PaymentService saga + real database + Stripe/Duffel stubs** for version/amount binding, recovery, and compensation.
4. **Cancellation API/service seams** for quote-authoritative ancillary refund disclosure.
5. **Playwright traveller journey** for rendered selection, accessibility, review/edit/recovery, and network-call behavior.

Avoid tests tied to private method order when the invariant is observable through one of these seams. Avoid live supplier/payment calls in CI.

## Rollout plan

1. Deploy additive schema/shared contracts and the BookingIntent state repair with all ancillary flags off.
2. Enable catalog adapter internally; validate normalized fixtures, cache rate, latency, and supplier budget.
3. Enable protected catalog read for test users; no selection/payment side effects.
4. Enable commit/UI for canary users; monitor version/validation conflicts and local recovery.
5. Enable validation/repricing with Stripe creation still blocked; compare client estimate to supplier total.
6. Enable ancillary Payment/order services for canary users; watch authorization/order/capture/compensation outcomes.
7. Expand availability after E2E, accessibility, and operational gates pass.

Rollback disables financial integration first, then selection commit/UI, then catalog access. Preserve all durable records; base-fare checkout with an empty selection remains available where safe.

## Complexity Tracking

| Complexity                                                  | Why needed                                                                                       | Simpler alternative rejected because                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Append-only normalized selection versions + current pointer | enforce passenger/segment/service invariants and preserve the exact Payment-bound recovery input | replacing one active row erases in-flight recovery data; opaque JSON weakens constraints   |
| Custom seat renderer                                        | approved group/passenger/segment UX, brand integration, exact price state, and accessibility     | drop-in Duffel component cannot meet the approved interaction/design contract              |
| CAS freeze around external repricing                        | avoid long DB locks while preventing payment from using a changed snapshot                       | external calls inside transactions harm concurrency; last-write-wins permits wrong charges |
| Short-lived supplier catalog cache                          | API-budget discipline under volatile seat availability                                           | no cache wastes budget; longer cache gives misleading browsing state                       |
| Minimal localStorage recovery plus server canonical state   | survives tab close after explicit Continue                                                       | sessionStorage does not survive; local-only authority is tamperable/stale                  |
| Checkout frontend foundation phase                          | live development tree lacks navigable real passenger/review/payment routes                       | planning ancillary components against deleted demo code is not executable                  |

All complexity maps to deterministic financial correctness, API-budget discipline, accessibility, operational visibility, or a verified repository prerequisite. No new deployable service, queue, or global client state framework is introduced.

## Constitution Check — Post-Design Re-evaluation

- **Flight-first**: optional seats/baggage remain inside the flight checkout and can be skipped — **PASS**.
- **Deterministic boundary**: supplier normalization, validation, pricing, payment, and order state are typed deterministic services/transactions; no AI — **PASS**.
- **API budget**: short cache, early-expiry policy, no per-click repricing, one commitment reprice, and rollout telemetry — **PASS**.
- **Operational visibility**: safe logs/audits/health, conflict/error codes, recovery outcomes, flags, and rollout/rollback verification are planned against real seams — **PASS**.
- **Incremental delivery**: additive schema and independently gated catalog, commit/UI, and financial phases preserve rollback — **PASS**.
- **Security**: ownership/expiry/version/service validation, server-derived money, Stripe boundary, PII-safe cache/storage/contracts, and auditability are explicit — **PASS**.

Post-design gate result: **PASS**. Implementation may proceed phase-by-phase after plan review and task generation.
