# T061 — Supplier-local lifecycle flight snapshots

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task; steps use checkbox syntax.

**Date:** 2026-10-04
**Execution:** Root released T061 on 2026-10-04; implementation and local verification are complete. T063 remains held until separate T061 independent review and root release.

## Goal

Move the booking-intent raw flight-snapshot parser out of `BookingLifecycleService` and into `SupplierSearch`. The saga must pass the resulting `FlightSnapshot` through `createBooking`'s existing sixth argument. Preserve historical snapshot JSON, aliases, ordering, omissions, duration/stops, and null-versus-empty behavior without deriving itinerary facts from booking metadata.

## Architecture

Add one supplier-local projection to the existing `FLIGHT_SEARCH_PORT`:

```typescript
normalizeStoredFlightSnapshot(rawOffer: unknown): FlightSnapshot | null;
```

It accepts raw stored evidence only. It does not call the SDK, read a database, or reuse complete-offer validation. This boundary is necessary because `BookingLifecycleService.parseDuffelRawOfferSnapshot` accepted missing offer metadata and also accepted missing segment airports/times/duration, writing empty strings for those facts; intent metadata cannot reconstruct missing itinerary values. The concrete current regression at `apps/api/src/booking-lifecycle/booking-lifecycle.service.spec.ts:163–222` supplies the partial `slices[].segments[]` format, omitting top-level ID, amount, currency, and passenger list. The parser source additionally accepts missing airport/time/duration fields; the sparse RED fixture below pins that behavior directly.

`FlightSearchPort.normalizeStoredOffer` stays unchanged and fail-closed, and `FlightOffer` gets no T061 fields. The T060 `normalizeStoredOfferFacts` change remains intact. Metadata completion and `passengersWereProvided` belong to T063, where their consumers need them. `PaymentFulfillmentSaga` calls the snapshot operation once with `payment.bookingIntent.rawOfferSnapshot`. Its current `createBooking` call supplies four arguments and no transaction context; add `undefined` only in the existing fifth `context` slot so the snapshot occupies the existing sixth slot. `BookingStateModule` remains Prisma plus DomainEvents. `PaymentFulfillmentModule` imports `SupplierSearchModule` and the saga injects the exported port.

`BookingLifecycleService.createBooking` continues to prefer an explicit `FlightSnapshot`. Its fallback accepts only a runtime-validated neutral `segments[]` snapshot; it no longer inspects supplier `slices[].segments[]`. If no explicit or valid neutral snapshot exists, omit the JSON field as before.

The neutral fallback guard must use type narrowing, without `as` assertions. Check that the top-level value is a non-array object with a non-empty `segments` array, string `totalDuration` and `cabinClass`, and a non-negative integer `stops`. If present, top-level `baggageAllowance` and `fareClass` must be strings. Every segment must be a non-array object with string `flightNumber`, `departureAt`, `arrivalAt`, and `duration`; an `airline` object with string `name` and `iataCode`; and `departureAirport`/`arrivalAirport` objects with string `iataCode`, `name`, and `city`. If present, `airline.logoUrl` must be a string; each airport's `terminal` and `gate` must be strings; segment `aircraftType` and `supplierSegmentId` must be strings; and segment `sliceOrder`, `segmentOrder`, and `globalOrder` must be non-negative integers. An absent optional field remains absent. Reject malformed values and supplier `slices[]` objects instead of asserting them to `FlightSnapshot`.
## Tech Stack

NestJS 10, TypeScript 5.9.3, Jest 29.7.0, existing API package scripts and installed workspace CLIs. No dependency or Prisma change.

## Spec

Source: [specs/029-duffel-provider-narrowing/spec.md](../../../specs/029-duffel-provider-narrowing/spec.md), especially FR-003 (supplier-local normalization), FR-006 (preserved lifecycle snapshots), and FR-010a (legacy persisted snapshot JSON compatibility).

Changed files for T061:

- `apps/api/src/supplier/search/flight-search.port.ts`
- `apps/api/src/supplier/search/flight-offer.normalizer.ts`
- `apps/api/src/supplier/search/flight-offer.normalizer.spec.ts`
- `apps/api/src/supplier/search/duffel-search.service.ts`
- `apps/api/src/payment-fulfillment/payment-fulfillment.module.ts`
- `apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts`
- `apps/api/src/payment-fulfillment/payment-fulfillment.saga.spec.ts`
- `apps/api/src/booking-lifecycle/booking-lifecycle.service.ts`
- `apps/api/src/booking-lifecycle/booking-lifecycle.service.spec.ts`
- `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.persistence.spec.ts`
- `apps/api/src/booking-intent/booking-passenger-final-validator.service.spec.ts`
- `apps/api/src/payment/payment-ancillary-final-fixes.spec.ts`
- `apps/api/src/payment/payment-ancillary-order-recovery.spec.ts`
- `apps/api/src/payment/payment-ancillary-pipeline.spec.ts`

The first API typecheck identified two additional typed `FlightSearchPort` test doubles and three direct saga test constructors that needed the new required port member/argument. Add the supplier normalizer delegate or a null-returning method to those fixtures and pass the port to those constructors, with a dated rationale comment; preserve all existing assertions. This is a compile-driven fixture adaptation, not a behavioral RED. The three-cycle focused suite ran before these five unrelated fixtures were updated; the API typecheck and lint ran after them.

Wait for T060 to finish and release its overlapping `flight-search.port.ts` and normalizer files before implementation. Keep its `FlightStoredOfferFacts` contract and tests. No `BookingStateModule` import or change.

The moved mapper preserves these source rules: top-level `total_duration` then `totalDuration`, otherwise `PT0H` with summed slice durations used only when the total is still `PT0H`; stops are the sum of `max(0, slice.segments.length - 1)`; cabin precedence is top-level `cabinClass` then `cabin_class`, followed by the first segment passenger's `cabin_class`/`cabinClass` or the segment's `cabin_class`/`cabinClass` in iteration order; invalid slice/segment entries are skipped; valid entries retain source slice/segment positions and a contiguous `globalOrder`. Segment mappings keep the existing aliases: carrier `operating_carrier`/`operatingCarrier` and `marketing_carrier`/`marketingCarrier`; carrier/airline IATA `iata_code`/`iataCode`; marketing flight number `marketing_carrier_flight_number`/`marketingCarrierFlightNumber`/`flight_number`/`flightNumber`; origin/destination IATA aliases, airport name and `city_name`/`cityName`/`city.name`/string city; terminal aliases; `departing_at`/`departureAt`; `arriving_at`/`arrivalAt`; `aircraft.name`/`aircraftType`; and segment `id`/`supplierSegmentId`/`duffelSegmentId`. Missing segment duration remains `''`; no elapsed-time duration is synthesized. Existing literal placeholders (`Unknown`, `XX`, `0000`) and empty strings remain the old serialized compatibility values, not facts derived from the intent row.

When `slices` is absent, malformed, or empty, return `null`. When `slices` is a non-empty array but all slices/segments are unusable, return the old snapshot shape with `segments: []`; this is distinct from `null` and remains persisted because the returned snapshot object is explicit input. A plain raw `segments[]` object is not the supplier projection input; lifecycle handles valid neutral snapshots through its guard.

## Global Constraints

- T061 was root-released on 2026-10-04; do not begin T063 before separate T061 independent review and root release. No child agents.
- Keep T060's `normalizeStoredOfferFacts` behavior and tests intact.
- Add no database query/include, passenger relation, supplier/network call, dependency, endpoint, schema change, or second port. Preserve `BookingStateModule` as Prisma plus DomainEvents.
- Keep complete-offer `normalizeStoredOffer` fail-closed. Do not add metadata completion or passenger provenance fields in T061.
- Do not create missing airports, carrier, flight number, timestamps, or duration from intent fields. Snapshot projection receives only raw evidence.
- Keep every existing behavioral/security assertion and the 25,000 ms saga timing value. No skips, weakened assertions, new type assertions, or `any`.
- Put the user-approved fixture adaptation comment dated `2026-10-04` in the existing lifecycle spec, and move every provider-parser JSON assertion to the supplier spec.

## TDD checklist

- [x] **RED 1 — supplier mapper contract:** Add a test in `flight-offer.normalizer.spec.ts` calling `normalizer.normalizeStoredFlightSnapshot(raw)` on the existing lifecycle JFK/LHR fixture. Assert `seg_1`, Delta/DL, `DL100`, airport IATA/name/city, timestamps, `PT8H`, cabin, stops, and source order. Run from `C:\Booking Systems\apps\api`: `node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/supplier/search/flight-offer.normalizer.spec.ts`; record the actual failing output for the missing method.
- [x] **GREEN 1 — move the existing mapper:** Add `normalizeStoredFlightSnapshot(rawOffer: unknown): FlightSnapshot | null` to `FlightSearchPort`, move the lifecycle mapping into `FlightOfferNormalizer` with runtime narrowing, and delegate it from `DuffelSearchService`. Rerun the same supplier Jest command. Completion: the moved fixture matches the old lifecycle JSON exactly, including existing placeholders and optional-field omission.
- [x] **PRESERVATION GREEN — aliases and partials:** After GREEN 1, add supplier tests for the lifecycle mapper's existing aliases: `total_duration`/`totalDuration`; carrier `operating_carrier`/`operatingCarrier` and `marketing_carrier`/`marketingCarrier`; carrier/airline IATA `iata_code`/`iataCode`; all four marketing flight-number keys; airport IATA/name/city/terminal forms; `departing_at`/`departureAt`, `arriving_at`/`arrivalAt`; `aircraft.name`/`aircraftType`; and segment `id`/`supplierSegmentId`/`duffelSegmentId`. Pin top-level duration selection, sum-of-slice-duration fallback, missing segment duration `''`, stops, cabin precedence, outbound/return order, skipped invalid entries, and the sparse case `{ slices: [{ segments: [{ id: 'seg_sparse' }] }] }` yielding empty IATA/departure/arrival/duration strings and `PT0H`. Assert a non-empty all-invalid `slices` array returns exactly `{ segments: [], totalDuration: 'PT0H', stops: 0, cabinClass: 'economy' }`, while absent/empty `slices` returns `null`; assert raw input is unchanged. Run the same single-spec command and record each actual result. These aliases are preservation proofs already accepted by the faithfully moved mapper, so report them as GREEN if they pass; create a RED only for a behavior that is genuinely unimplemented, then make its minimal GREEN before proceeding.
- [x] **RED 2 — saga handoff:** In `payment-fulfillment.saga.spec.ts`, add a typed `FlightSearchPort` mock whose `normalizeStoredFlightSnapshot` returns this complete fixture: `const expectedSnapshot: FlightSnapshot = { segments: [{ airline: { name: 'Delta Air Lines', iataCode: 'DL' }, flightNumber: 'DL100', departureAirport: { iataCode: 'JFK', name: 'John F Kennedy Intl', city: 'New York' }, arrivalAirport: { iataCode: 'LHR', name: 'London Heathrow', city: 'London' }, departureAt: '2026-09-18T10:00:00Z', arrivalAt: '2026-09-18T18:00:00Z', duration: 'PT8H', supplierSegmentId: 'seg_1', sliceOrder: 0, segmentOrder: 0, globalOrder: 0 }], totalDuration: 'PT8H', stops: 0, cabinClass: 'economy' };` Put raw supplier evidence on the already-loaded `baseBookingIntent.rawOfferSnapshot`. Assert one call with that raw value; assert `createBooking` receives `(userId, bookingId, bookingIntentId, paymentId, undefined, expectedSnapshot)`; assert `search` and `getOfferById` were never called. The inspected production call currently passes four arguments and no context, so `undefined` in slot five preserves its current meaning. Run `node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/payment-fulfillment/payment-fulfillment.saga.spec.ts`; record the missing-injection/call failure.
- [x] **GREEN 2 — wire the existing port:** Import `SupplierSearchModule` into `PaymentFulfillmentModule`; inject `FLIGHT_SEARCH_PORT` into the saga; call `normalizeStoredFlightSnapshot(payment.bookingIntent.rawOfferSnapshot)` once before `createBooking`; pass the snapshot (or `undefined` for `null`) in slot six without changing slot five. Rerun the same saga command. Completion: the regression passes, search/live lookup remain uncalled, and every existing 25,000 ms assertion is unchanged.
- [x] **RED 3 — lifecycle ownership and neutral guard:** In `booking-lifecycle.service.spec.ts`, keep supplier JSON assertions in the supplier spec and adapt the existing parser test with: `// Approved 2026-10-04 per T061: move provider snapshot assertions to SupplierSearch; keep lifecycle writes canonical and neutral.` Explicit-snapshot persistence and a valid neutral `segments[]` fallback are preservation-green controls. The genuine RED assertions are that `{ slices: [{ segments: [{ id: 'seg_1', origin: { iata_code: 'JFK' }, destination: { iata_code: 'LHR' }, departing_at: '2026-09-18T10:00:00Z', arriving_at: '2026-09-18T18:00:00Z' }] }] }` without an explicit snapshot does not write `flightSnapshot`, and `{ segments: [null], totalDuration: 'PT8H', stops: 0, cabinClass: 'economy' }` is omitted by the neutral shape guard. Run `node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/booking-lifecycle/booking-lifecycle.service.spec.ts`; record the actual failed assertions.
- [x] **GREEN 3 — provider-blind lifecycle:** Remove `parseDuffelRawOfferSnapshot` and its duration helpers. Implement the field-scoped neutral guard in Architecture without assertions; preserve explicit-snapshot priority, valid neutral fallback, and omission when neither input is valid. Rerun the same lifecycle command. Completion: all former provider field assertions remain in the supplier spec and the lifecycle spec proves no `slices[]` parsing.
- [x] **Verify and self-review T061:** After the three vertical RED/GREEN cycles, run the combined focused Jest command and installed TypeScript/ESLint commands below from `C:\Booking Systems\apps\api`. Review the T061 diff for provider parsing left in lifecycle, new calls/includes, BookingStateModule changes, JSON/alias/order drift, assertion loss, and timer changes. Record actual RED/GREEN and final exits, source SHA/file list, approved fixture adaptation, and concerns in `t061-boundary-report.md` in the root scratch directory. Commit T061 after local gates and self-review; then request independent review of that committed SHA. Do not start T063 before separate review passes and root releases it.
## Focused verification commands

Run from `C:\Booking Systems\apps\api`:

```powershell
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/supplier/search/flight-offer.normalizer.spec.ts src/booking-lifecycle/booking-lifecycle.service.spec.ts src/payment-fulfillment/payment-fulfillment.saga.spec.ts
node ../../node_modules/typescript/bin/tsc --project tsconfig.json --noEmit
node ../../node_modules/eslint/bin/eslint.js "src/**/*.ts" "../../packages/shared/**/*.ts" --max-warnings 0
```
