# Feature 029 Booking Boundary Fixes — Supplemental TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task; steps use checkbox syntax.

**Status:** T059 was committed and independently reviewed before T060 release. T060 implementation and focused checks are complete locally: five Jest suites passed (224 tests), API no-emit typecheck passed, and package ESLint passed. The scoped T060 commit is ready for root's independent review.

**Prepared against:** `2ccca27fb789e2dec34fc90d242c846fef640421` (plan-only HEAD). The task brief identifies `eda88f0` as the source baseline. Chronology: one user-authorized full-agent retry reported `input.injection` p95 `2.2666 ms > 2 ms`; the later final unchanged-agent gate passed with the counts above, after which root released T059. Jest, TypeScript, ESLint, and network-guard CLI paths were confirmed before implementation; exact T059 executions and results are recorded in `.superpowers/sdd/2026-10-04-feature-029-final-verification/booking-boundary-fix-report.md`.

**Root review:** Root approved the signatures and RED/GREEN sequencing, with the additional requirements below: preserve missing-country/default-scope behavior exactly, keep ciphertext decryption before offer parsing/expiry/document validation, and do not broaden malformed-evidence handling. The Jest, TypeScript, ESLint, and network-guard CLI paths listed below were confirmed to exist with read-only `Test-Path` checks; no CLI was executed.

## Goal

Complete T059 by making travel facts and passenger identities supplier-neutral at the existing search boundary, then complete T060 by having final passenger validation consume those normalized facts through the exported port. Keep booking and wire behavior intact.

## Architecture

`SupplierSearchModule` owns supplier-specific parsing and normalization. Booking-intent and final-validation code depend on the existing exported `FLIGHT_SEARCH_PORT`. The validator decrypts passenger snapshots first, then normalizes stored offer evidence, then checks expiry and derives scope/trip completion facts. No new service, port method, database field, or module is required.

## TechStack

NestJS 10, TypeScript 5.9.3, Jest 29.7.0, ESLint 8.57.1, existing Prisma client. Use the installed workspace CLIs directly from `C:\Booking Systems\apps\api`; do not install dependencies.

## Spec

Use the approved T059/T060 boundary design in `.superpowers/sdd/2026-10-04-feature-029-final-verification/booking-boundary-fix-brief.md` and `specs/029-duffel-provider-narrowing/plan.md`. User approval for legitimate existing-test adaptations supersedes the brief's older pending-approval line. Adapt only fixtures, port wiring, and neutral field names while retaining every expiry, passport, binding, ciphertext-binding, and trip-completion assertion.

## GlobalConstraints

- Keep the current checkout and make separate T059/T060 commits; root reviews T059 independently before any T060 edits.
- T059 source, test, and gate work is complete and independently reviewed. T060 was held until that review, then released; its implementation and required checks are complete locally. Commit only T060-owned files, then pause for root review.
- No child agents, `any`, type assertions, dependency/lock/schema/migration edits, security suppressions, endpoints, or weakened/skipped assertions.
- Keep supplier raw evidence opaque in domain code. Keep existing HTTP/SSE aliases, HMAC/crypto contexts, snapshot history, lifecycle holds/idempotency, and webhook behavior unchanged.
- Follow one public test → observed RED → minimal GREEN cycle at a time. If the same failure persists after one corrective attempt, stop and report it to root.

## Checkbox execution steps

- [ ] T059: add and observe RED for legacy stored route aliases and latest return arrival; make the smallest supplier-normalizer change to pass.
- [ ] T059: add and observe RED for stored expiry alias; normalize it at the supplier boundary and pass.
- [ ] T059: add and observe RED proving missing normalized passenger identities cannot be recovered from opaque raw payload; use typed normalized passenger facts only.
- [ ] T059: neutralize passenger identity names through resolver, intent binding, snapshot mapping, and approved adjacent tests; preserve existing stable same-type ordering assertions.
- [ ] T059: run focused Jest suites, API no-emit typecheck, and API package ESLint; self-review and commit; pause for root's independent review.
- [x] T060: after root review/release, observe RED for normalized scope/trip-date facts winning over conflicting raw fields; consume port facts after decrypting snapshots.
- [x] T060: observe the consumer RED for expired normalized offer facts and preserve the existing expiry-only raw-snapshot compatibility case and persisted `offerExpiresAt` check.
- [x] T060: keep route/date and expiry-only snapshots partial; preserve alias/default/date-prefix behavior, option precedence, ciphertext ordering, and all existing safety assertions.
- [x] T060: run the focused five-suite Jest gate, API no-emit typecheck, and package ESLint; self-review the scoped diff and prepare the T060 commit for root's independent review.

## Approval and scope

The user approved the design and legitimate existing-test adaptations during this session. That approval supersedes the brief's older pending-test-approval language. The rationale is to make the existing tests express the same approved behavior through the exported neutral `FLIGHT_SEARCH_PORT` contract after provider narrowing. Adaptations are limited to fixture validity, port wiring, and neutral field names. Preserve every existing offer-expiry, passport, passenger-binding, ciphertext-binding, and trip-completion assertion; do not skip tests or weaken expectations. Add a dated human-approval comment to each existing test file whose fixtures are adapted.

T059 also owns canonical passenger identity naming in `PassengerSourceResolverService`, `BookingIntentService` binding, `PassengerSnapshotService`, and their focused tests, as requested by root. T060 owns final passenger validation through normalized supplier facts. Keep the work in the current checkout and make two commits, with root review between them.

## Fixed interfaces and behavior

Keep the exported search port and its existing method unchanged:

```typescript
normalizeStoredOffer(rawOffer: unknown): FlightOffer | null;
```

Add the minimal normalized travel facts to `flight-search.port.ts`; existing hand-built `FlightOffer` fixtures remain source-compatible:

```typescript
export type FlightTravelFacts = {
  travelScope: 'DOMESTIC' | 'INTERNATIONAL' | null;
  tripCompletionDate: string | null;
};

export type FlightOffer = {
  // existing fields
  travelScope?: FlightTravelFacts['travelScope'];
  tripCompletionDate?: FlightTravelFacts['tripCompletionDate'];
};
```

The supplier normalizer fills those optional fields for valid live and stored evidence. Country/date/expiry aliases are interpreted only there. Preserve the current scope behavior exactly: when a valid slice array is present, use `INTERNATIONAL` only when both country values are non-empty and differ under the current comparison; missing country facts retain `DOMESTIC`. When there is no usable slice shape and normalization returns `null`, the validator keeps its existing default `DOMESTIC` scope unless the caller explicitly supplied a scope. Do not reject malformed or missing evidence merely because it cannot be normalized, and do not add a raw-domain fallback. Completion date is the latest valid arrival date across all slices. Normalize supported stored aliases at that boundary: `iata_country_code` / `countryCode`, `arriving_at` / `arrivalDate` / `arrivingAt`, and `expires_at` / `expiresAt`. Keep supplier passenger `id` mapped to `FlightOfferPassenger.supplierPassengerId` there.

Use `supplierPassengerId` for `PassengerSourceRequest` and `ResolvedPassenger`, keep that name through `BookingIntentService`, and map it to the existing Prisma `supplierPassengerId` field in the snapshot writer. The intent binding algorithm must consume only the typed normalized `FlightOffer.passengers` array. For each intent passenger, preserve the current stable first-unmatched same-type mapping and input order. Missing or mismatched normalized identities continue to return `UPSTREAM_UNAVAILABLE` before persistence; opaque `rawSupplierPayload` cannot fill them.

Inject the existing `FLIGHT_SEARCH_PORT` into `BookingPassengerFinalValidatorService` using Nest constructor injection. Preserve the order: validate basic intent presence, decrypt and authenticate passenger snapshots, then normalize `rawOfferSnapshot` once through `normalizeStoredOffer`, then check expiry, derive travel facts, and validate documents. This keeps `SNAPSHOT_INTEGRITY_FAILURE` ahead of offer-expiry and document errors and avoids touching supplier evidence before the ciphertext check. Let a non-empty explicit `scope` and `tripCompletionDate` retain their current precedence; otherwise use normalized travel facts, then the existing domestic/null defaults and passenger-document scope elevation. Check persisted `intent.offerExpiresAt` and the normalized offer expiry with the current expired-offer result (`OFFER_EXPIRED`, HTTP 409). A null normalizer result remains non-throwing and follows current default behavior; do not add rejection or partial raw inspection. No new port method, module, database field, network call, or endpoint is needed; `BookingIntentModule` already imports `SupplierSearchModule`.

Keep edge compatibility explicit and unchanged:

- Raw supplier `passengers[].id` becomes the normalized `supplierPassengerId`; consumers do not inspect raw passenger JSON.
- `rawSupplierPayload` remains opaque storage evidence, and `rawOfferSnapshot` keeps its existing persistence behavior.
- The booking request/response `DuffelPassengerDto.id` and `duffelPassengers` output remain provider wire aliases. The final validator still maps the neutral persisted `supplierPassengerId` to the wire `id`.
- Existing crypto contexts (`snapshotVersion`, `intentId`, `position`, `fieldName`), ciphertext bytes, Prisma columns, history records, and persisted literal values remain unchanged.
- Do not rename unrelated ancillary HTTP DTO aliases.

## T059 — normalized travel facts and canonical passenger identity

Files in scope:

- `apps/api/src/supplier/search/flight-search.port.ts`
- `apps/api/src/supplier/search/flight-offer.normalizer.ts`
- `apps/api/src/supplier/search/flight-offer.normalizer.spec.ts`
- `apps/api/src/booking-intent/booking-intent.service.ts`
- `apps/api/src/booking-intent/booking-intent.service.spec.ts`
- `apps/api/src/booking-intent/passenger-source-resolver.service.ts`
- `apps/api/src/booking-intent/passenger-source-resolver.service.spec.ts`
- `apps/api/src/booking-intent/passenger-snapshot.service.ts`
- `apps/api/src/booking-intent/passenger-snapshot.service.spec.ts`

### RED → GREEN 1: stored route facts and latest return arrival

Add one public `normalizeStoredOffer` regression using an unknown-input fixture so the test has no supplier type assertion. Use a valid round trip where the legacy country/date aliases identify SGN/VN → NRT/JP outbound and NRT/JP → SGN/VN return. Give the final return segment the latest arrival date. The current parser rejects the legacy arrival alias and returns `null`, so this expectation must fail before the implementation change:

```typescript
const stored = {
  id: 'off_legacy_round_trip',
  total_amount: '100.00',
  total_currency: 'USD',
  passengers: [{ id: 'pas_adult_1', type: 'adult' }],
  slices: [
    { segments: [{
      origin: { iata_code: 'SGN', countryCode: 'VN' },
      destination: { iata_code: 'NRT', countryCode: 'JP' },
      departing_at: '2026-08-01T08:00:00Z',
      arrivalDate: '2026-08-01T15:00:00Z',
    }] },
    { segments: [{
      origin: { iata_code: 'NRT', countryCode: 'JP' },
      destination: { iata_code: 'SGN', countryCode: 'VN' },
      departing_at: '2026-08-10T08:00:00Z',
      arrivingAt: '2026-08-10T15:00:00Z',
    }] },
  ],
};

expect(normalizeStoredOffer(stored)).toMatchObject({
  travelScope: 'INTERNATIONAL',
  tripCompletionDate: '2026-08-10',
});
```

Then implement only supplier-local alias normalization and normalized fact derivation. Do not let the validator or intent domain inspect `origin`, `destination`, `slices`, or arrival aliases.

### RED → GREEN 2: stored expiry alias

Add one separate valid stored-offer regression with `expiresAt: '2026-08-20T00:00:00Z'` and canonical segment timestamps. Assert `offerExpiresAt` is that value. It should fail before the normalizer maps the alias, then pass after the minimal supplier-boundary change. Malformed or absent expiry remains `null`; never invent an expiry.

### RED → GREEN 3: passenger identity cannot come from opaque evidence

Add one public `createIntent` regression in the canonical passenger persistence suite. Set the mocked `getOfferById` result's normalized `passengers` to `[]`, while its `rawSupplierPayload` contains a plausible supplier passenger record. Call `createIntent` with one valid canonical adult source. Assert `UPSTREAM_UNAVAILABLE` and zero booking-intent/passenger writes. It must fail on the current raw fallback, then pass after extraction accepts only `readonly FlightOfferPassenger[]` from the normalized port result.

Keep the existing adult/child valid-binding test and its identity/order expectations. Rename the internal `duffelPassengerId` properties and `extractDuffelPassengerIds` naming in the resolver/intent/snapshot path to `supplierPassengerId` / `extractSupplierPassengerIds`; assert that the normalized identity reaches the existing Prisma `supplierPassengerId` field. Update only affected fixture keys. Do not change offer passenger ordering, passenger types, HTTP keys, or the final Duffel wire DTO.

### T059 verification and commit

After root's T059 release (now in effect), run these commands from `C:\Booking Systems\apps\api` (the network guard is retained for Jest):

```powershell
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/supplier/search/flight-offer.normalizer.spec.ts src/booking-intent/booking-intent.service.spec.ts src/booking-intent/passenger-source-resolver.service.spec.ts src/booking-intent/passenger-snapshot.service.spec.ts
node ../../node_modules/typescript/bin/tsc --project tsconfig.json --noEmit
node ../../node_modules/eslint/bin/eslint.js "src/**/*.ts" "../../packages/shared/**/*.ts" --max-warnings 0
```

Record each actual RED/GREEN command and result, focused test counts, typecheck/lint result, changed-file list, approved adaptation list, and implementation source SHA in `.superpowers/sdd/2026-10-04-feature-029-final-verification/booking-boundary-fix-report.md`. Self-review the scoped diff, then commit only T059 files as `fix(029): normalize booking travel facts and passenger identities (T059)`. Stop for root's independent review before T060.

## T060 — final validator consumes normalized facts

This section supersedes the earlier “no new port method” preference and the complete-fixture approach. Root verified that complete-offer normalization drops historically accepted expiry-only and partial itinerary evidence. Preserve that behavior with one supplier-local facts operation on the existing port; do not weaken `normalizeStoredOffer` or make legacy fixtures artificially complete.

Files in scope:

- `apps/api/src/supplier/search/flight-search.port.ts`
- `apps/api/src/supplier/search/flight-offer.normalizer.ts` and `.spec.ts`
- `apps/api/src/supplier/search/duffel-search.service.ts` and its focused spec (method forwarding)
- `apps/api/src/booking-intent/booking-passenger-final-validator.service.ts` and `.spec.ts`
- `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.persistence.spec.ts` (typed port fixture only)
- `apps/api/src/booking-intent/booking-intent.module.ts` only if the already-exported port cannot be injected as-is (expected: no change)

Add this exact typed contract to the existing port; `FlightTravelFacts` already has these fields:

```typescript
export type FlightStoredOfferFacts = FlightTravelFacts & {
  offerExpiresAt: string | null;
};

export interface FlightSearchPort {
  // existing methods
  normalizeStoredOfferFacts(rawOffer: unknown): FlightStoredOfferFacts;
}
```

Implement `normalizeStoredOfferFacts` in `FlightOfferNormalizer` and forward it from `DuffelSearchService` through the same `FlightSearchPort` registration. It returns facts for partial evidence without requiring id, price, currency, passengers, departure timestamps, or a complete offer. Keep `normalizeStoredOffer(rawOffer): FlightOffer | null` strict and unchanged. Refactor/share the existing supplier-local `getTravelFacts` helper so both complete-offer normalization and facts-only normalization use one extraction path, while full-offer validation remains strict before it reaches that helper. Match the old validator's accepted partial facts: `expires_at ?? expiresAt`; country `iata_country_code ?? countryCode`; arrival `arriving_at ?? arrivalDate ?? arrivingAt`; compare non-empty string country facts; and choose the latest calendar-valid `arrivalRaw.slice(0, 10)` without requiring the rest of the timestamp to parse. Preserve the old null/default distinction: non-record input or input without an array-valued `slices` yields null travel facts; any array-valued `slices` initializes `travelScope` to `DOMESTIC` even when empty or malformed, with a null completion date unless a valid arrival prefix is found. Do not require airport codes to recognize old partial route facts. The expiry fact is the selected string alias only when `new Date(value)` is valid, otherwise null, matching the old validator behavior. Do not add supplier parsing back to booking-intent/domain code.

In `BookingPassengerFinalValidatorService`, inject `FLIGHT_SEARCH_PORT` using Nest constructor injection. Preserve the order: basic intent checks; decrypt/authenticate every passenger snapshot; call `normalizeStoredOfferFacts(intent.rawOfferSnapshot)` once; check persisted `intent.offerExpiresAt` independently and then the normalized stored expiry with the existing `OFFER_EXPIRED` / HTTP 409 result; resolve scope/date; validate documents. A corrupted ciphertext must fail before the port is consulted. A non-empty explicit scope and trip-completion option keep precedence; otherwise use non-null normalized facts, then domestic/null defaults and the current passport-data scope elevation. No sync remote/DB call, new provider, endpoint, wire change, or error-shape change.

### RED → GREEN 1: partial route/date facts and validator consumer

First add a supplier-normalizer regression whose snapshot contains only route/date facts (no id, price, currency, passengers, or departure timestamp):

```typescript
const partial = {
  slices: [{ segments: [{
    origin: { countryCode: 'GB' },
    destination: { iata_country_code: 'US' },
    arrivalDate: '2026-09-10T12:00:00',
  }] }],
};
expect(normalizeStoredOfferFacts(partial)).toEqual({
  travelScope: 'INTERNATIONAL',
  tripCompletionDate: '2026-09-10',
  offerExpiresAt: null,
});
```

Add a later valid arrival via `arrivingAt` and assert it wins; include a valid date-only prefix with the old accepted timestamp shape, and a missing-country segment that stays `DOMESTIC`. These checks should fail before the facts operation, then pass without changing strict full-offer normalization.

Next use public `validate()` with a typed port double returning international scope and `tripCompletionDate: '2026-09-10'`, while the raw snapshot claims domestic scope and an earlier date. Assert `DOCUMENT_EXPIRED` for a passport that expires after the raw date but before the normalized date, and `SNAPSHOT_INCOMPLETE` for a passenger without a passport. Both fail before the validator consumes port facts. Keep this as a consumer-boundary test; use the real supplier normalizer for the partial-input regressions. Retain the corrupted-ciphertext test and assert `normalizeStoredOfferFacts` was not called. Do not call private methods.

### RED → GREEN 2: expiry-only history remains enforced

The existing raw expiry validator regression already passes before T060. Keep it unchanged as the expiry-only compatibility proof: the real facts normalizer must still extract expiry from `{ expires_at }` with no route/pricing/passenger fields, and public validation must retain `OFFER_EXPIRED` / 409.

For the consumer RED, add a separate public `validate()` regression with `intent.offerExpiresAt === null`, a snapshot with no expiry (or a future raw expiry), and a typed port double returning `offerExpiresAt: '2026-08-18T08:00:00.000Z'` while `now` is `2026-08-18T10:00:00.000Z`. Assert the existing `OFFER_EXPIRED` / 409. It passes against the old raw parser because that parser cannot see the port fact, then fails as expected after the validator consumes normalized facts. Independently test that the facts operation handles an expiry-only snapshot, with no `slices` or complete-offer fields:

```typescript
expect(normalizeStoredOfferFacts({ expiresAt: '2026-08-18T08:00:00.000Z' })).toEqual({
  travelScope: null,
  tripCompletionDate: null,
  offerExpiresAt: '2026-08-18T08:00:00.000Z',
});
```

After facts-only extraction exists, wire the preserved expiry-only compatibility case to the real supplier facts normalizer and confirm it stays green. Keep the separate persisted `intent.offerExpiresAt` regression unchanged, and continue checking persisted and normalized stored expiry independently.

### Approved existing-test fixture adaptations

Add the dated approval comment only if an existing validator test file's fixtures or wiring are adapted. Keep partial historical route and expiry fixtures partial; do not replace them with complete normalized offers. Adapt the validator test setup to provide a typed `FlightSearchPort` whose facts method delegates to the real `FlightOfferNormalizer.normalizeStoredOfferFacts` except in the explicit consumer-boundary tests. Preserve every assertion about decrypt-before-expiry ordering, ciphertext binding to intent/position/version/field, passport validity and expiry, explicit option precedence, domestic defaults, route scope, and trip completion. No `.skip`, relaxed matcher, removed assertion, timer change, or security suppression.

### T060 verification and commit

After the T059 root review and release, run from `C:\Booking Systems\apps\api` using the installed CLIs directly:

```powershell
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/supplier/search/flight-offer.normalizer.spec.ts src/supplier/search/duffel-search.service.spec.ts src/booking-intent/booking-passenger-final-validator.service.spec.ts src/booking-intent/booking-intent.service.spec.ts src/payment-fulfillment/payment-fulfillment.saga.spec.ts
node ../../node_modules/typescript/bin/tsc --project tsconfig.json --noEmit
node ../../node_modules/eslint/bin/eslint.js "src/**/*.ts" "../../packages/shared/**/*.ts" --max-warnings 0
```

Record each actual RED/GREEN command and result, focused test counts, typecheck/lint results, changed-file list, approved adaptations, and final source SHA in the T060 task report. Self-review and commit only T060 files as `fix(029): validate passengers through normalized search facts (T060)`. Stop for root's independent review after the commit.

## Execution holds and invariants

- T059 was committed and independently reviewed before T060 was released. T060 implementation and required focused checks are complete locally; commit only T060 files and pause for root's independent review.
- Do not create child agents, edit dependencies/lockfiles, schema/migrations, security suppressions, shared verification files, or task ledgers.
- Preserve the current offer expiry, passport, binding, trip-date, ciphertext/HMAC, and booking lifecycle safeguards. Do not add type assertions or `any`; use the exported port and Nest constructor injection.
- Follow one test → observed RED → minimal GREEN cycle at a time. If the same failure remains after one corrective attempt, stop and report it to root.
- Keep Windows PowerShell syntax and use direct installed Jest/TypeScript/ESLint CLIs; no install step is planned.

