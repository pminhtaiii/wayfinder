# Feature 029 Booking Boundary Fixes — Supplemental TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task; steps use checkbox syntax.

**Status:** Root released T059 after the final unchanged-agent gate passed (1,302 passed, 4 skipped, 12 deselected; exit 0; Ruff passed). T059 implementation, focused tests, API typecheck, and package lint have passed. T060 remains held for root's independent review.

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
- T059 source, test, and gate work is released. Keep T060 source/test/gate work on hold until root completes the independent T059 review and releases it.
- No child agents, `any`, type assertions, dependency/lock/schema/migration edits, security suppressions, endpoints, or weakened/skipped assertions.
- Keep supplier raw evidence opaque in domain code. Keep existing HTTP/SSE aliases, HMAC/crypto contexts, snapshot history, lifecycle holds/idempotency, and webhook behavior unchanged.
- Follow one public test → observed RED → minimal GREEN cycle at a time. If the same failure persists after one corrective attempt, stop and report it to root.

## Checkbox execution steps

- [ ] T059: add and observe RED for legacy stored route aliases and latest return arrival; make the smallest supplier-normalizer change to pass.
- [ ] T059: add and observe RED for stored expiry alias; normalize it at the supplier boundary and pass.
- [ ] T059: add and observe RED proving missing normalized passenger identities cannot be recovered from opaque raw payload; use typed normalized passenger facts only.
- [ ] T059: neutralize passenger identity names through resolver, intent binding, snapshot mapping, and approved adjacent tests; preserve existing stable same-type ordering assertions.
- [ ] T059: run focused Jest suites, API no-emit typecheck, and API package ESLint; self-review and commit; pause for root's independent review.
- [ ] T060: after root review/release, add and observe RED for normalized scope/trip-date facts winning over conflicting raw fields; consume port facts after decrypting snapshots.
- [ ] T060: add and observe RED for normalized offer-expiry fallback; preserve the existing `OFFER_EXPIRED`/409 result.
- [ ] T060: adapt approved fixtures to complete normalized evidence without changing existing safety assertions; verify malformed/missing-country behavior and decrypt-before-validation ordering.
- [ ] T060: run focused validator, intent, and payment-fulfillment Jest suites, API no-emit typecheck, and API package ESLint; self-review and commit; pause for root's independent review.

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

Files in scope:

- `apps/api/src/booking-intent/booking-passenger-final-validator.service.ts`
- `apps/api/src/booking-intent/booking-passenger-final-validator.service.spec.ts`
- `apps/api/src/booking-intent/booking-intent.module.ts` only if the existing exported port provider cannot be injected as-is (expected: no change).

### RED → GREEN 1: normalized international scope and return-date expiry win

Use the public `validate()` method. Inject a typed `FlightSearchPort` test double whose `normalizeStoredOffer` returns a valid normalized offer with `travelScope: 'INTERNATIONAL'` and `tripCompletionDate: '2026-09-10'`. Give the opaque snapshot deliberately conflicting raw fields that claim same-country/domestic travel and an earlier return date. With a passenger whose passport is valid on `now` and through the raw date but expires before `2026-09-10`, assert `DOCUMENT_EXPIRED`. Add a second assertion in this regression for a domestic passenger with no passport: the normalized international scope must reject it as `SNAPSHOT_INCOMPLETE`. Both assertions fail against the current raw-field parser and pass when the validator uses normalized facts. Verify decryption happens before the port is called by retaining the corrupted-ciphertext/expired-offer test and asserting the port was not consulted. Do not call private methods.

Where fixture conversion is practical, use the real `FlightOfferNormalizer.normalizeStoredOffer` in the validator test setup. The deliberately conflicting port result is limited to the consumer regression, where it proves the validator treats `FLIGHT_SEARCH_PORT` as the facts boundary.

### RED → GREEN 2: normalized expiry remains enforced

Add a public `validate()` regression with `intent.offerExpiresAt === null`, an opaque raw snapshot with no expiry field, and a port result with `offerExpiresAt` before the supplied `now`. Assert the existing `OFFER_EXPIRED` / 409 result. The current validator ignores a normalized port result and lets this case through, so the assertion is RED before wiring and GREEN after the minimal change.

### Approved existing-test fixture adaptations

Add the dated approval comment in the validator spec. Replace the incomplete default supplier snapshot fixture with a complete offer accepted by the real normalizer, retaining its original international countries, arrival date, and future expiry. Convert the existing raw-expiry and route fixtures to complete normalized evidence while retaining the exact expiry status/code and passport/trip-date expectations. Wire the port fixture to the real normalizer for these existing behavior tests; use explicit normalized facts only in the two consumer regressions above. Add a normalizer regression confirming that valid slices with missing country codes retain the current `DOMESTIC` scope; confirm that no usable slice shape normalizes to `null` and the validator still defaults to domestic. Preserve every assertion about decrypt-before-expiry ordering, ciphertext binding to intent/position/version/field, passport validity and expiry, explicit option precedence, route scope, and trip completion. No `.skip`, relaxed matcher, or removed assertion.

### T060 verification and commit

After the T059 root review and release, run from `C:\Booking Systems\apps\api`:

```powershell
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/booking-intent/booking-passenger-final-validator.service.spec.ts src/booking-intent/booking-intent.service.spec.ts src/payment-fulfillment/payment-fulfillment.saga.spec.ts
node ../../node_modules/typescript/bin/tsc --project tsconfig.json --noEmit
node ../../node_modules/eslint/bin/eslint.js "src/**/*.ts" "../../packages/shared/**/*.ts" --max-warnings 0
```

The full payment-fulfillment saga spec is included because it is the consumer of final passenger validation. Record actual RED/GREEN logs and gate results, changed-file list, approved adaptations, and final source SHA in the task report. Self-review and commit only T060 files as `fix(029): validate passengers through normalized search facts (T060)`. Stop for root's independent review after the commit.

## Execution holds and invariants

- T059 implementation and focused verification are released. Do not begin T060 production/test changes or gates until root independently reviews the T059 commit and explicitly releases T060.
- Do not create child agents, edit dependencies/lockfiles, schema/migrations, security suppressions, shared verification files, or task ledgers.
- Preserve the current offer expiry, passport, binding, trip-date, ciphertext/HMAC, and booking lifecycle safeguards. Do not add type assertions or `any`; use the exported port and Nest constructor injection.
- Follow one test → observed RED → minimal GREEN cycle at a time. If the same failure remains after one corrective attempt, stop and report it to root.
- Keep Windows PowerShell syntax and use direct installed Jest/TypeScript/ESLint CLIs; no install step is planned.

