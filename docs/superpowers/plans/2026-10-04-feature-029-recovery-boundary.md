# T062 — SupplierOrder cancellation and recovery boundary

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task; steps use checkbox syntax.

**Date:** 2026-10-04
**Execution:** Root released T062 source and check work on 2026-10-04 after T061 independent review and T055 characterization. Implementation and final verification are complete; see `.superpowers/sdd/2026-10-04-feature-029-final-verification/t062-boundary-report.md` for observed results.

## Goal

Keep raw Duffel cancellation and recovered-order interpretation inside `SupplierOrder`. Return the existing cancellation outcome, pass only neutral passenger enrichment into supplier-local snapshot mapping, and preserve recoverable payment state until cancellation is confirmed.

## Architecture

`DuffelCancellationService` normalizes provider/replay shapes once to `CancelOrderOutcome`; `DuffelFulfillmentAdapter` preserves its existing port and admission/fencing behavior while forwarding that outcome. `BookingRecoveryService` consumes the typed outcome and constructs neutral enrichment from its already-loaded booking intent. `DuffelRecoveryService` applies the current booking-recovery fill-only enrichment policy to a fresh in-memory copy of event evidence and delegates snapshot construction to `OrderSnapshotNormalizer`.

## Tech Stack

NestJS 10, TypeScript 5.9.3, Jest 29.7.0, existing API package and installed workspace CLIs. No dependency or Prisma change.

## Spec

Source: `specs/029-duffel-provider-narrowing/spec.md` and `specs/029-duffel-provider-narrowing/plan.md`; task contract: `docs/superpowers/plans/2026-10-04-feature-029-remaining-boundaries.md` §T062 and its fixed signatures.

## Global Constraints

- Add no port, provider or database call, endpoint, reservation, lock, schema, dependency, suppression, or skip. `CancelOrderOutcome` is the existing contract; there is one cancellation attempt through the current quote/confirm path and the existing one retrieval used only to reconcile a failed confirmation.
- Add no `any` or type assertion. Narrow all provider and persisted `unknown` values at runtime. Keep Nest constructor injection and use the existing exported SupplierOrder capabilities.
- Keep raw cancellation and raw passenger field interpretation in SupplierOrder. Booking recovery may read only the legacy order ID at root `id` or nested `data.id`; it may not inspect provider passenger keys.
- Preserve the two existing enrichment policies separately. The adapter's `enrichRedactedDuffelOrder` first redacts then fills identity/title/phone and applies contact email only to the first passenger. The booking-recovery helper deep-copies the persisted evidence and fills only missing/`REDACTED` names and DOB, with contact email fallback for every passenger. Move the latter policy into `DuffelRecoveryService`; keep the adapter helper and its behavior unchanged. Do not add a policy flag or shared configurable helper.
- Keep `duffel_order_created` event type and metadata unchanged. The writer remains `PaymentFulfillmentSaga`'s `paymentEvent.create` with `metadata: orderOutcome.evidence` (`payment-fulfillment.saga.ts:729–734`). Persist only the same redacted evidence and canonical snapshots; newly enriched raw order objects stay in memory and are never written to event metadata.
- Keep checkpoint progression, replay/idempotency behavior, hold/failure state, stale-sweeper deferral and TTL, redaction, one-attempt budget accounting, and provider call counts. Budget denials must still bypass cancellation reconciliation; the existing retry time/backoff remains intact.
- Do not change the existing 25,000 ms saga handoff or 50 ms supplier semaphore timing assertions. Do not change HTTP/SSE aliases, error codes/statuses, signed HMAC bytes, ciphertext contexts, identity order, or legacy history.
- If an existing consumer mock must change because the service contract is now typed, date the rationale `2026-10-04` and preserve every assertion. Keep provider-shaped fixtures in SupplierOrder tests.
- Do not write context, task-ledger, or verification files in this planning task. At implementation time, stage only T062 source/spec files and this plan; never stage root `tasks.md` or context/verification files.

## Existing typed contracts and fixed signatures

The existing port types are exported by `apps/api/src/payment-fulfillment/ports/index.ts`:

```typescript
export interface PassengerEnrichmentInput {
  id?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  gender?: string;
  dateOfBirth?: string;
  passengerType?: string;
  email?: string;
  phoneNumber?: string;
}

export interface CancelOrderOutcome {
  success: boolean;
  orderId: string;
  status?: string;
}
```

The fulfillment signature remains `cancelOrder(orderId: string, control: PortInvocationControl): Promise<CancelOrderOutcome>`. Implement only these fixed capability signatures:

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

`OrderSnapshotNormalizer.mapDuffelOrderToSnapshots(order: unknown)` remains the existing normalizer. `DuffelRecoveryService.retrieveOrder`, `retrieveCompleteOrder`, and `recoverOrderSnapshots` retain their existing signatures and provider call behavior. No wire or persisted type changes.

## Changed files for T062

Production:

- `apps/api/src/supplier/order/duffel-cancellation.service.ts`
- `apps/api/src/supplier/order/duffel-recovery.service.ts`
- `apps/api/src/supplier/order/duffel-fulfillment.adapter.ts`
- `apps/api/src/booking-lifecycle/booking-recovery.service.ts`

Focused regressions:

- `apps/api/src/supplier/order/duffel-cancellation.service.spec.ts`
- `apps/api/src/supplier/order/duffel-recovery.service.spec.ts`
- `apps/api/src/supplier/order/order-snapshot.normalizer.spec.ts` (preservation regression; edit only if an existing public assertion truly requires an approved fixture adaptation)
- `apps/api/src/supplier/order/duffel-fulfillment.adapter.spec.ts`
- `apps/api/src/booking-lifecycle/booking-recovery.service.spec.ts`
- `apps/api/src/payment-fulfillment/payment-fulfillment.saga.spec.ts` (existing cancellation-safety regressions; retain all assertions)

## TDD checklist

- [x] T062 RED/GREEN 1: normalize cancellation success, pending, missing/blank/null timestamp, explicit-false, and replay shapes to the existing `CancelOrderOutcome`; retain exact reservation and reconciliation call counts.
- [x] T062 RED/GREEN 2: prove `DuffelFulfillmentAdapter` forwards the typed result while retaining preflight, semaphore, input order ID, and port behavior.
- [x] T062 RED/GREEN 3: make `BookingRecoveryService` consume `success/status`; keep pending/failed cancellation recoverable and confirmed cancellation on the existing marker/cleanup path.
- [x] T062 RED/GREEN 4: move only booking recovery's copy-and-fill passenger enrichment to `DuffelRecoveryService`; pass neutral booking-intent facts and email; keep adapter fallback's separate enrichment policy unchanged.
- [x] T062 preservation: keep bounded root `id`/nested `data.id` reading; confirm redacted evidence immutability, canonical snapshots, replay/budget/retry outcomes, existing call counts, and unchanged 25,000 ms / 50 ms assertions.
- [x] T062 sequential focused Jest, API typecheck, and package ESLint; self-review only T062 files, record actual RED/GREEN and gate evidence in `t062-boundary-report.md`, then commit T062 and pause for independent review.

## Behavior-by-behavior TDD sequence

Run each focused test from `apps/api` with the installed Jest command under **Focused verification commands** below. T062 implementation followed the reviewed behavior-by-behavior sequence after root release. Record the actual RED/GREEN chronology and command results in the implementation report; do not normalize away pattern-filtered counts or intermediate fixture-only failures.

### 1. Normalize provider cancellation responses once

In `duffel-cancellation.service.spec.ts`, add a public `cancelOrder` matrix before changing production code. Cover: nonblank `confirmed_at`; confirmed/cancelled status; pending status; absent, blank, and null timestamps without confirmation; and explicit `success: false`, including a false result with otherwise confirming evidence. Assert the returned value contains only `success`, the input `orderId`, and a neutral status string when supplied. A pending response should include the public regression shape:

```typescript
await expect(service.cancelOrder('ord_123')).resolves.toEqual({
  success: false,
  orderId: 'ord_123',
  status: 'pending',
});
expect(orderAdapter.cancelOrder).toHaveBeenCalledTimes(1);
```

**RED:** run the cancellation service spec with the typed assertions in place; capture the raw-response mismatch. **GREEN:** have `DuffelCancellationService.cancelOrder` return `CancelOrderOutcome`, apply the confirmation rules there, and preserve the caller's order ID. Explicit `success: false` vetoes confirmation. A nonblank confirmation timestamp or a confirmed/cancelled/canceled status proves success; pending without confirmation evidence and blank/null/missing timestamps without confirmed status stay false. Keep current port status behavior: confirmed outcomes use `status: 'CANCELLED'`; an unconfirmed outcome retains a string provider status when present. Do not return the raw provider object.

In the same smallest production change, normalize the existing failed-confirmation replay result to the same typed outcome only when the existing retrieved order is `CANCELLED`. Keep the original cancellation error if retrieval does not prove that status.

**Replay RED/GREEN:** first assert the current replay case returns `{ success: true, orderId: 'ord_replayed', status: 'CANCELLED' }`; observe the raw object fail, then normalize that existing retrieval result. Preserve the exact three budget reservations and one `getOrder` call already asserted by the test. Keep the budget-denied and budget-store-unavailable tests asserting one reservation and zero create/confirm/retrieve calls.

**Precedence:** preserve the existing timestamp-first rule: a nonblank `confirmed_at` proves confirmation even when the same response says `status: 'PENDING'`; explicit `success: false` still vetoes proof. Pending responses with absent, null, or blank timestamps remain unconfirmed.

### 2. Forward the typed cancellation outcome through the adapter

In `duffel-fulfillment.adapter.spec.ts`, add a public contract case using a test-module override for the injected cancellation service and the typed result `{ success: true, orderId: 'ord_123' }` (no status). Keep assertions for one cancellation call, one `beforeInvoke`, the existing permit release, the input order ID, and no additional provider call.

**RED:** assert the adapter returns `success: true` for that typed result and observe the current response predicate reject it because it has no provider status/timestamp. **GREEN:** make the adapter forward the already-normalized outcome under the unchanged fulfillment signature; retain its semaphore acquire/release and `beforeInvoke` ordering. Remove its provider response predicate use. Do not add quote, cancellation, retrieval, or budget calls.

Keep the existing confirmed timestamp/status, status-less, explicit-false, pending, and invalid-result integration cases as coverage of the full SDK-to-port path. They should continue passing through the new SupplierOrder normalizer. Preserve the success, order-ID, status, call-count, and permit assertions.

### 3. Make booking recovery consume the neutral cancellation contract

In `booking-recovery.service.spec.ts`, first update only cancellation-service mocks to the new contract, retaining a dated rationale and every existing state assertion. Add/adjust public cases for `success: false` and `status: 'pending'` and a confirmed outcome. The pending/failed cases must leave booking/payment recoverable: no `duffel_order_cancelled` marker, no Stripe cancellation, no fail transition, and a deferred retry. The confirmed case must retain its current marker/cleanup result.

Example consumer outcome:

```typescript
mockDuffelService.cancellation.cancelOrder.mockResolvedValue({
  success: false,
  orderId: 'ord_123',
  status: 'pending',
});
```

Adapt the existing “records confirmed already-cancelled provider evidence” case to return `{ success: true, orderId: 'ord_123' }` with no status; keep its marker/cleanup assertions. **RED:** this existing public case must fail against the current raw provider predicate, which ignores the typed `success` field. **GREEN:** consume the typed `success` and neutral `status` (a pending status remains unconfirmed even if a contradictory test double sets `success: true`), and remove the provider predicate import/call. Keep typed rate-limit deferral, unavailable-store backoff, existing defer TTL, booking state, and Stripe hold behavior unchanged.

The legacy order-ID read remains bounded to a string at root `id` or nested `data.id`. Rename `readDuffelOrderId` to `readSupplierOrderId` if it remains a domain helper. Preserve its current trim-to-check behavior and exact returned ID; do not parse passenger fields or broaden the payment-event shape. Existing nested-ID recovery/cancellation assertions are the public regression; do not add a test solely for this helper rename.

### 4. Move redacted passenger enrichment into SupplierOrder recovery

In `duffel-recovery.service.spec.ts`, first add a public mapper assertion with redacted passenger evidence and neutral `PassengerEnrichmentInput[]` plus contact email. Cover ID match, index fallback, and the normalizer output. Assert the original event evidence remains redacted and unchanged after mapping.

```typescript
const recovered = recoveryService.mapOrderToSnapshots(
  redactedOrder,
  passengerFacts,
  contactEmail,
);
expect(recovered.passengerSnapshot).toMatchObject(expectedPassengerFacts);
expect(redactedOrder).toEqual(originalRedactedOrder);
```

**RED:** run the recovery spec and capture the current one-argument mapper's missing-enrichment result. **GREEN:** move the booking-recovery helper's fill-only behavior into `DuffelRecoveryService.mapOrderToSnapshots`, accept the fixed optional arguments, deep-copy the evidence, and pass the enriched copy to `OrderSnapshotNormalizer`. Match by supplier passenger ID then index. Fill only missing/`REDACTED` given name, family name, and DOB; validate and format DOB as `YYYY-MM-DD`. Apply the booking contact email only when each passenger's email is missing/`REDACTED`. Preserve existing non-redacted values; do not fill title or phone in this recovery path. Never mutate, persist, or return the enriched raw order.

Then add a booking recovery spy assertion that neutral DB facts map as follows: `supplierPassengerId` → optional `id`, `givenName` → `firstName`, `familyName` → `lastName`, and valid `dateOfBirth` → `YYYY-MM-DD`; pass `bookingIntent.user.email` as the contact email. **RED:** observe the missing arguments / provider-field walk. **GREEN:** construct the typed inputs from the already-loaded booking-intent passenger rows and call the SupplierOrder mapper with the original redacted event evidence. Remove the booking-recovery-local passenger enrichment helper/type and calls to `passengers[].given_name`, `family_name`, and `born_on` from `BookingRecoveryService`.

Leave `DuffelFulfillmentAdapter.enrichRedactedDuffelOrder` and its fallback mapping path unchanged. Its existing tests cover the separate policy that first redacts and can fill title/phone, and that uses contact fallback for only the first passenger. Keep those assertions and call counts intact. Keep the canonical snapshot shape asserted by `order-snapshot.normalizer.spec.ts` unchanged.

### 5. Re-run preservation regressions without expanding the boundary

No new tests are needed for the low-impact ID-helper rename or unchanged config/timing expressions. Re-run the existing public cases in the focused command and confirm their assertions remain:

- `payment-fulfillment.saga.spec.ts`: inline/background replay, nested `data.id`, false cancellation, pending status, budget denial, authorized hold, checkpoint, event evidence, and no early idempotency completion. Preserve the deliberate defensive `success: true, status: 'PENDING'` contract test.
- `booking-recovery.service.spec.ts`: confirmed cancellation marker behavior, unconfirmed/failed cancellation deferral, retry time/backoff, stale-sweeper recoverability, nested ID, and no premature Stripe cancellation/fail transition.
- SupplierOrder specs: exact 2-reservation normal cancellation, exact 3-reservation failed-confirmation replay, 1-reservation budget denial with no network/reconciliation call, redacted evidence, no new retrievals, adapter permit/preflight, and existing 50 ms timing assertion.
- Preserve the 25,000 ms saga handoff assertion and all current checkpoint/replay ordering.

## Approved consumer-fixture adaptation

When adapting `booking-recovery.service.spec.ts` mocks from raw shapes such as `{ status: 'confirmed' }` or `{ id: 'oc_123', status: 'pending' }`, add a dated note: `User-approved 2026-10-04: consumer fixtures now model SupplierOrder's existing CancelOrderOutcome; assertions for deferred state, markers, hold release, and booking transitions are retained.` Replace only the response fixture with the equivalent typed fields (`success`, input `orderId`, neutral `status`). Do not delete, weaken, or rewrite the associated behavioral assertions. SupplierOrder tests must continue to use raw provider response fixtures because they test the normalization boundary itself.

## Focused verification commands

From PowerShell in `apps/api`, run the commands directly against installed project binaries. Run the focused Jest suite first, then the typecheck, then lint; do not run heavy gates in parallel.

```powershell
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
node node_modules/jest/bin/jest.js --config ./jest.config.json --runInBand --runTestsByPath src/supplier/order/duffel-cancellation.service.spec.ts src/supplier/order/duffel-recovery.service.spec.ts src/supplier/order/order-snapshot.normalizer.spec.ts src/supplier/order/duffel-fulfillment.adapter.spec.ts src/booking-lifecycle/booking-recovery.service.spec.ts src/payment-fulfillment/payment-fulfillment.saga.spec.ts
node ../../node_modules/typescript/bin/tsc --project tsconfig.json --noEmit
node ../../node_modules/eslint/bin/eslint.js "src/**/*.ts" "../../packages/shared/**/*.ts" --max-warnings 0
```

The implementation report must include each command's exit code and focused suite counts, the RED/GREEN test names and evidence, any dated fixture adaptation, the final changed-file list, the source commit, and unresolved concerns. Do not claim a RED/GREEN or gate result before observing it.
