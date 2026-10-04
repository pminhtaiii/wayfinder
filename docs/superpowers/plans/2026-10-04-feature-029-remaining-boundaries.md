# Feature 029 Booking Boundary Fixes — Remaining Boundaries

> **For agentic workers:** Execute one task at a time with the RED → GREEN → verify → review/commit steps below. Keep tasks T061–T065 separate; pair no more than two tasks per worker.

**Date:** 2026-10-04  
**Scope:** Supplemental TDD plan for the root-confirmed remaining boundary leaks from T056. Tasks T059/T060 are owned elsewhere.

## Goal

Move the remaining live offer and cancellation interpretation into the existing supplier capabilities. Domain consumers pass and receive canonical values through current ports and services.

## Architecture

`SupplierSearchModule` owns offer and stored-offer interpretation. `SupplierOrderModule` owns cancellation confirmation, redacted-order enrichment, and order mapping. `BookingLifecycleService`, `BookingRecoveryService`, `ChatHandoffService`, and `FlightSearchOrchestratorService` consume neutral results. Keep `FULFILLMENT_GATEWAY_PORT` unchanged and keep `BookingStateModule` dependent only on Prisma and DomainEvents.

## TechStack

NestJS 10, TypeScript 5.9.3, Jest 29.7.0, ESLint 8.57.1, existing Prisma client. Use installed workspace CLIs directly from `C:\Booking Systems\apps\api`; install no dependencies.

## Spec

Use the approved Feature 029 design in `specs/029-duffel-provider-narrowing/plan.md` and the bounded findings in `.superpowers/sdd/2026-10-04-feature-029-final-verification/task-3-report.md`. This bite implements only root-confirmed tasks T061–T065. Keep existing public HTTP/SSE shapes, persisted history, cancellation safety, and search ordering. The user approved the design and legitimate existing-test adaptations.

## GlobalConstraints

- Do not add a network call, database query, dependency, schema change, budget reservation, or new provider port.
- `BookingStateModule` stays Prisma + DomainEvents only. Inject `FLIGHT_SEARCH_PORT` into the existing `PaymentFulfillmentSaga`, never into lifecycle/state modules.
- Keep raw supplier payload opaque in domain code. Do not use `any` or type assertions; use typed contracts and runtime guards.
- Migrate coverage into the supplier-local normalizer/adapter tests; do not delete coverage, skip a test, weaken an assertion, or change timer/timeout values.
- Preserve the 25,000 ms saga handoff timing checks and the 50 ms supplier-order semaphore timeout check.
- Keep dashboard legacy persisted-snapshot reads as the explicit, narrowly justified exception below, pending root's final adjudication.
- Planning only: do not edit source/tests, run tests/typecheck/lint, or commit as part of this planning task.

## For workers

For each task: (1) add/adapt its focused regression and run it to observe RED; (2) make the smallest boundary change and run the same regression to GREEN; (3) run that task's Jest command, API no-emit TypeScript check, and API ESLint command; (4) inspect the diff for boundary leaks and preserved compatibility; (5) commit that task and report the commit plus evidence to root. Do not start a dependent task until the prior boundary's focused verification is green. Add a dated approval comment to every existing test file whose fixtures are adapted.

## Fixed signatures

The existing search port gains only the optional neutral metadata argument needed to preserve partial stored offers. Metadata comes from the already-loaded intent/offer row, never another query:

```typescript
export type NeutralStoredOfferMetadata = {
  supplierOfferId?: string | null;
  totalAmount?: string | null;
  currency?: string | null;
  departureDate?: Date | string | null;
  adults?: number | null;
  children?: number | null;
  infants?: number | null;
};

export interface FlightSearchPort {
  normalizeStoredOffer(
    rawOffer: unknown,
    metadata?: NeutralStoredOfferMetadata,
  ): FlightOffer | null;
}

export type FlightOffer = {
  // existing fields
  flightSnapshot?: FlightSnapshot;
  passengersWereProvided?: boolean;
};
```

Snapshot normalization must also accept the historical partial `slices[].segments[]` evidence that `parseDuffelRawOfferSnapshot` accepted without a supplier ID, amount, currency, or passenger array. Use the already-loaded booking intent's neutral metadata to complete the normalizer input; if the existing boundary cannot preserve a valid historical snapshot this way, stop and report the concrete missing fact instead of discarding the itinerary or inventing a wider abstraction.

`DuffelCancellationService` returns the existing cancellation contract, and `DuffelRecoveryService` accepts neutral recovery enrichment:

```typescript
export class DuffelCancellationService {
  cancelOrder(orderId: string): Promise<CancelOrderOutcome>;
}

export class DuffelRecoveryService {
  mapOrderToSnapshots(
    order: unknown,
    passengerEnrichment?: readonly PassengerEnrichmentInput[],
    contactEmail?: string,
  ): {
    flightSnapshot: FlightSnapshot;
    passengerSnapshot: PassengerSnapshot;
  };
}
```

No new network operation is part of either signature. `readSupplierOrderId(value: unknown): string | null` remains a bounded ID-only read of the persisted payment-event envelope.

## Checkbox execution steps

- [ ] T061: add and observe RED for snapshots from full and partial stored offers, including snake/camel aliases; verify metadata completes old partial raw snapshots without another query or provider call.
- [ ] T061: add and observe RED for `PaymentFulfillmentSaga` passing the normalized snapshot in `createBooking`'s existing final argument and lifecycle preserving neutral `segments[]` history.
- [ ] T061: move the provider parser into SupplierSearch; observe GREEN for supplier normalizer, saga, and lifecycle tests.
- [ ] T061: run its focused Jest, API typecheck, and API ESLint commands; review and commit T061.
- [ ] T062: add and observe RED for confirmed/pending/blank cancellation outcomes, replay/budget safety, and supplier-local passenger enrichment of redacted persisted order evidence.
- [ ] T062: move cancellation response parsing and redacted-order enrichment into SupplierOrder; make recovery consume `CancelOrderOutcome` and neutral enrichment inputs; observe GREEN without added calls.
- [ ] T062: run its focused Jest, API typecheck, and API ESLint commands; confirm existing 25,000 ms and 50 ms timing assertions are unchanged; review and commit T062.
- [ ] T063: add and observe RED for normalized expiry, original-versus-synthetic passenger handling, and unchanged attestation aliases/HMAC fixtures.
- [ ] T063: move stored-row completion into `normalizeStoredOffer` and make ChatHandoff consume normalized facts; observe GREEN without direct raw-field parsing.
- [ ] T063: run its focused Jest, API typecheck, and API ESLint commands; review and commit T063.
- [ ] T064: add and observe RED for canonical-only orchestrator input/output while retaining all migrated parser, ranking, order, and top-20 cases.
- [ ] T064: remove the raw overload/result and duplicate domain parser after moving its full test coverage to SupplierSearch; observe GREEN.
- [ ] T064: run its focused Jest, API typecheck, and API ESLint commands using only test paths that remain after migration; review and commit T064.
- [ ] T065: add and observe RED for supplier-neutral quote helper names, byte-compatible delimiters/sentinel behavior, and the unchanged legacy response alias.
- [ ] T065: rename internal cancellation quote types/helpers and callers; observe GREEN.
- [ ] T065: run its focused Jest, API typecheck, and API ESLint commands; review and commit T065.
- [ ] After all five tasks pass, update the relevant `context/` documents and run the combined checkpoint below; leave dashboard history handling for root's final adjudication.

## T061 — Normalize the booking flight snapshot before lifecycle persistence

**Files:**

- `apps/api/src/supplier/search/flight-search.port.ts`
- `apps/api/src/supplier/search/flight-offer.normalizer.ts` and its spec
- `apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts`, its module wiring if required, and its spec
- `apps/api/src/booking-lifecycle/booking-lifecycle.service.ts` and its spec

**Red assertions:**

1. Supplier normalization of a stored offer produces the same canonical `FlightSnapshot` fields that lifecycle currently derives from a Duffel offer: segment identity/order, airline, flight number, airport IATA/name/city/terminal, departure and arrival times, duration, aircraft, cabin class, stops, and outbound/return slices. Cover the existing snake case and camel case aliases, including total and segment duration fallbacks.
2. `PaymentFulfillmentSaga` obtains that snapshot only by calling `FLIGHT_SEARCH_PORT.normalizeStoredOffer` on the already stored intent offer evidence, then passes it as the existing final `createBooking` argument. Assert no `getOfferById` or other remote search call is added.
3. `BookingLifecycleService.createBooking` stores an explicitly supplied snapshot, preserves an already neutral `segments[]` snapshot fallback through a shape guard, and does not interpret provider `slices[].segments[]` data itself.

**Implementation:**

Move the raw offer-to-snapshot mapping out of `BookingLifecycleService.parseDuffelRawOfferSnapshot` and into the supplier search normalizer. Return it as optional `FlightOffer.flightSnapshot`. In the saga, normalize its existing persisted raw evidence and pass the canonical snapshot to the already available final lifecycle argument. Lifecycle remains provider-blind; `BookingStateModule` receives no search import or provider dependency. Remove the Duffel-shaped fallback parser from lifecycle, retaining the neutral legacy snapshot read and omission behavior when no valid snapshot exists.

**Public regressions:**

Keep the booking flight snapshot JSON shape stable, including city and airport names, round-trip ordering, duration/stops, and the accepted snake/camel aliases. Do not alter snapshot schema or historical reads.

```typescript
const normalized = flightSearchPort.normalizeStoredOffer(
  baseBookingIntent.rawOfferSnapshot,
  {
    supplierOfferId: baseBookingIntent.supplierOfferId,
    totalAmount: baseBookingIntent.confirmedPrice.toString(),
    currency: baseBookingIntent.currency,
    adults: baseBookingIntent.passengers.filter((passenger) => passenger.passengerType === 'adult').length,
    children: baseBookingIntent.passengers.filter((passenger) => passenger.passengerType === 'child').length,
    infants: baseBookingIntent.passengers.filter((passenger) => passenger.passengerType === 'infant').length,
  },
);
expect(normalized?.flightSnapshot?.segments[0]).toMatchObject({
  supplierSegmentId: 'seg_1',
  departureAirport: { name: 'John F Kennedy Intl', city: 'New York' },
  arrivalAirport: { name: 'London Heathrow', city: 'London' },
});
expect(mockBookingLifecycle.createBooking.mock.calls[0]?.[5]).toEqual(
  baseSnapshots.flightSnapshot,
);
```

The TDD adaptation adds the existing lifecycle regression's partial offer fixture (`seg_1`, JFK/New York, LHR/London) to `baseBookingIntent.rawOfferSnapshot`. The fixture's supplier offer ID, confirmed price, currency, and passenger list provide every fallback fact without a new database or supplier call.

**Focused command:**

```powershell
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/supplier/search/flight-offer.normalizer.spec.ts src/booking-lifecycle/booking-lifecycle.service.spec.ts src/payment-fulfillment/payment-fulfillment.saga.spec.ts
node ../../node_modules/typescript/bin/tsc --project tsconfig.json --noEmit
node ../../node_modules/eslint/bin/eslint.js "src/**/*.ts" "../../packages/shared/**/*.ts" --max-warnings 0
```

## T062 — Keep cancellation and recovered-order interpretation in SupplierOrder

**Files:**

- `apps/api/src/supplier/order/duffel-cancellation.service.ts`, `duffel-recovery.service.ts`, and the supplier order normalizer as needed
- `apps/api/src/supplier/order/duffel-cancellation.service.spec.ts`, `duffel-recovery.service.spec.ts`, `order-snapshot.normalizer.spec.ts`, and `duffel-fulfillment.adapter.spec.ts`
- `apps/api/src/booking-lifecycle/booking-recovery.service.ts` and its spec
- `apps/api/src/payment-fulfillment/payment-fulfillment.saga.spec.ts` for existing cancellation safety regressions

**Red assertions:**

1. Raw cancellation shapes are normalized once by SupplierOrder to the existing `CancelOrderOutcome`. A confirmed timestamp or confirmed status succeeds; pending, blank/null timestamps, and explicit `success: false` remain unconfirmed. Preserve the input order ID and a neutral status when available.
2. `BookingRecoveryService` consumes `success/status` and no longer calls a provider response predicate. Pending or failed cancellation keeps the booking/payment recoverable and does not release the hold.
3. Persisted order enrichment and mapping stay supplier-local. `BookingRecoveryService` maps database passenger identity/name/date-of-birth facts into neutral `PassengerEnrichmentInput` plus contact email, then calls the existing `DuffelRecoveryService` mapper. It no longer walks `passengers[].given_name`, `family_name`, or `born_on`.
4. Recovery still reads the legacy payment-event order ID envelope at root `id` or nested `data.id`; rename the domain helper to `readSupplierOrderId` if it has no wire meaning, without changing the persisted event type or metadata. The exact writer is `PaymentFulfillmentSaga`'s `paymentEvent.create` for `eventType: 'duffel_order_created'` with `metadata: orderOutcome.evidence` (`payment-fulfillment.saga.ts:729–734`); the bounded read is `BookingRecoveryService`'s `duffelEvent.metadata` ID extraction (`booking-recovery.service.ts:361`).
5. Replays, budget denials, stale-sweeper retry state, redaction, and timing checks keep their existing outcomes and call counts.

**Implementation:**

Have `DuffelCancellationService.cancelOrder` return the existing typed `CancelOrderOutcome` after applying the supplier-local confirmation normalizer. `DuffelFulfillmentAdapter` adapts that outcome to the unchanged fulfillment port shape. Move `enrichRedactedDuffelOrder` into the existing SupplierOrder recovery capability and accept optional neutral passenger enrichment/email arguments on its mapping operation; reuse `OrderSnapshotNormalizer` for the existing snapshot result. Keep legacy payment event ID extraction limited to `id`/`data.id`; it is an ID-only history envelope read, not permission to interpret the stored supplier response elsewhere.

**Public regressions:**

Do not add cancellation or order-retrieval calls. Keep confirmed, pending, replay, one-attempt budget accounting, checkpoint state, and recovery retry behavior unchanged. Persist only the same redacted evidence and canonical snapshots.

```typescript
await expect(cancellationService.cancelOrder('ord_123')).resolves.toEqual({
  success: false,
  orderId: 'ord_123',
  status: 'pending',
});
expect(orderAdapter.cancelOrder).toHaveBeenCalledTimes(1);

const recovered = recoveryService.mapOrderToSnapshots(redactedOrder, passengerFacts, contactEmail);
expect(recovered.passengerSnapshot).toMatchObject(expectedPassengerFacts);
```

**Focused command:**

```powershell
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/supplier/order/duffel-cancellation.service.spec.ts src/supplier/order/duffel-recovery.service.spec.ts src/supplier/order/order-snapshot.normalizer.spec.ts src/supplier/order/duffel-fulfillment.adapter.spec.ts src/booking-lifecycle/booking-recovery.service.spec.ts src/payment-fulfillment/payment-fulfillment.saga.spec.ts
node ../../node_modules/typescript/bin/tsc --project tsconfig.json --noEmit
node ../../node_modules/eslint/bin/eslint.js "src/**/*.ts" "../../packages/shared/**/*.ts" --max-warnings 0
```

## T063 — Consume normalized expiry and passenger provenance in chat handoff

**Files:**

- `apps/api/src/supplier/search/flight-search.port.ts`, `flight-offer.normalizer.ts`, and stored-offer helper/specs
- `apps/api/src/chat-handoff/chat-handoff.service.ts` and `chat-handoff.service.spec.ts`

**Red assertions:**

1. Handoff expiration uses `FlightOffer.offerExpiresAt` from normalized stored data; the service does not inspect `rawOffer.expires_at`.
2. Handoff response includes passengers only when the stored supplier offer contained a non-empty passenger list. If the supplier normalizer or stored metadata has to synthesize passenger IDs from booking counts, those synthetic identities stay omitted.
3. Missing, malformed, or expired normalized expiry keeps the current stale-handoff error and status.
4. Signed legacy attestation claims retain `expires_at`/`expiresAt` aliases and exact existing HMAC bytes. Public handoff payload shape and passenger omission behavior do not change.

**Implementation:**

Use `FlightOffer.offerExpiresAt`, normalized passengers, and optional `passengersWereProvided`. The supplier normalizer records provenance before synthesizing any missing passenger records. If row metadata is required to complement a partial stored offer, add only the optional neutral argument to the existing `normalizeStoredOffer` method and move the complement-and-normalize sequence fully into SupplierSearch. Remove ChatHandoff's direct raw expiry/passenger checks and its direct call to the raw-shape complement helper.

**Public regression:**

```typescript
expect(syntheticOffer.passengersWereProvided).toBe(false);
expect(response).not.toHaveProperty('offer.passengers');
expect(attestation.selectedOffer.expires_at).toBe(originalLegacyExpiry);
```

**Focused command:**

```powershell
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/chat-handoff/chat-handoff.service.spec.ts src/supplier/search/flight-offer.normalizer.spec.ts src/supplier/search/stored-offer-payload.helper.spec.ts
node ../../node_modules/typescript/bin/tsc --project tsconfig.json --noEmit
node ../../node_modules/eslint/bin/eslint.js "src/**/*.ts" "../../packages/shared/**/*.ts" --max-warnings 0
```

## T064 — Make the flight orchestrator canonical-offer only

**Files:**

- `apps/api/src/flights/flight-search-orchestrator.service.ts`
- `apps/api/src/flights/flight-offer-normalizer.ts` and its spec
- `apps/api/src/flights/flight-search-orchestrator.service.spec.ts`
- `apps/api/src/flights/flights.service.spec.ts` only if a call-site fixture requires the new canonical-only input

**Red assertions:**

1. Orchestrator accepts only canonical `FlightOffer[]`; raw-offer input and raw-offer output are absent from its exported types.
2. Ranking and matching preserve dropped/rejection counts, match scores, eligibility counts, result order, top-20 selection, and canonical offer identity.
3. Migrate direct tests of the duplicate domain Duffel parser to the supplier normalizer, retaining all parser parity assertions there; do not drop the test cases when retiring `flight-offer-normalizer.ts`.
4. The HTTP search DTO remains unchanged because `FlightsService` maps canonical scored data and does not consume the orchestrator's raw output.

**Implementation:**

Require `offers: readonly FlightOffer[]` on `OrchestratorParams`; remove `DuffelOffer`, `rawOffers`, `OrchestratedFlightResult.rawOffer`, `resolveRawOffer`, casts from `rawSupplierPayload`, and the duplicate domain parser/import. Keep scoring and ranking on `matchInput` and return the matching canonical offer. Delete the old parser only after its full coverage has been moved to `supplier/search/flight-offer.normalizer.spec.ts`.

**Public regression:**

```typescript
expect(response.results.map((result) => result.offer?.id)).toEqual(expectedRankedIds);
expect(response.results[0]).not.toHaveProperty('rawOffer');
```

**Focused command:**

```powershell
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/flights/flight-search-orchestrator.service.spec.ts src/supplier/search/flight-offer.normalizer.spec.ts src/flights/flights.service.spec.ts
node ../../node_modules/typescript/bin/tsc --project tsconfig.json --noEmit
node ../../node_modules/eslint/bin/eslint.js "src/**/*.ts" "../../packages/shared/**/*.ts" --max-warnings 0
```

## T065 — Neutralize internal cancellation quote helper names

**Files:**

- `apps/api/src/cancellation/cancellation.types.ts`
- `apps/api/src/cancellation/cancellation.service.ts` and its spec
- `apps/api/src/booking-management/booking-management.service.ts` and its spec

**Red assertions:**

1. Internal parser/type/serializer names use supplier-neutral vocabulary (`ParsedSupplierCancellationQuoteId`, `parseSupplierCancellationQuoteId`, and `serializeSupplierCancellationQuoteId`).
2. Null, empty, `PENDING_QUOTE`, bare IDs, and four-part quote values retain exact existing parse and serialization behavior, including `|` delimiters and empty trailing fields.
3. Cancellation response DTO continues to emit the established `duffelCancellationQuoteId` wire field unchanged.

**Implementation:**

Rename the internal type and helpers and update callers/tests. Remove the old Duffel-named service re-export rather than preserving a second internal alias. Keep the response DTO property and serialized database value byte-compatible.

**Public regression:**

```typescript
expect(serializeSupplierCancellationQuoteId('can_quo_123', 'balance', '15.00', 'USD'))
  .toBe('can_quo_123|balance|15.00|USD');
expect(parseSupplierCancellationQuoteId('PENDING_QUOTE').quoteId).toBe('PENDING_QUOTE');
expect(responseBody.duffelCancellationQuoteId).toBe('can_quo_123|balance|15.00|USD');
```

**Focused command:**

```powershell
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/cancellation/cancellation.service.spec.ts src/booking-management/booking-management.service.spec.ts
node ../../node_modules/typescript/bin/tsc --project tsconfig.json --noEmit
node ../../node_modules/eslint/bin/eslint.js "src/**/*.ts" "../../packages/shared/**/*.ts" --max-warnings 0
```

## Persisted history exception for the dashboard

Keep `apps/api/src/dashboard/dashboard.service.ts` unchanged in this bite. Its read path selects persisted `Booking.flightSnapshot` at :68–70 and interprets historical snapshot forms at :91–178: normalized `segments[]` records, legacy `slices[].segments[]`, and the underscore/camel aliases recorded by T056. It does not call the live search capability, inspect `FlightOffer.rawOffer`, or write supplier evidence. `BookingLifecycleService` writes snapshots from `createBooking`/confirmation inputs; `DuffelRecoveryService` maps recovered order evidence to canonical snapshots before lifecycle confirmation. T061 moves the active booking-intent write to a canonical supplier-normalized `FlightSnapshot` while older rows remain readable. Preserve the dashboard parser as a narrowly scoped history compatibility read until a backfill/retention policy is decided. This is an explicit exception for root adjudication, not a waiver for live offer readers.

## Checkpoint across T061–T065

After the focused commands pass, run the affected-file checkpoint from `C:\Booking Systems\apps\api`; T064's command excludes the retired `flight-offer-normalizer.spec.ts` after its assertions move to SupplierSearch:

```powershell
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/supplier/order/duffel-cancellation.service.spec.ts src/supplier/order/duffel-recovery.service.spec.ts src/supplier/order/order-snapshot.normalizer.spec.ts src/supplier/order/duffel-fulfillment.adapter.spec.ts src/booking-lifecycle/booking-recovery.service.spec.ts src/booking-lifecycle/booking-lifecycle.service.spec.ts src/payment-fulfillment/payment-fulfillment.saga.spec.ts src/cancellation/cancellation.service.spec.ts src/booking-management/booking-management.service.spec.ts src/supplier/search/flight-offer.normalizer.spec.ts src/supplier/search/stored-offer-payload.helper.spec.ts src/flights/flight-search-orchestrator.service.spec.ts src/flights/flights.service.spec.ts src/chat-handoff/chat-handoff.service.spec.ts
node ../../node_modules/typescript/bin/tsc --project tsconfig.json --noEmit
node ../../node_modules/eslint/bin/eslint.js "src/**/*.ts" "../../packages/shared/**/*.ts" --max-warnings 0
```

Do not run these as part of planning. The source and test suites remain untouched until the implementation work is dispatched.
