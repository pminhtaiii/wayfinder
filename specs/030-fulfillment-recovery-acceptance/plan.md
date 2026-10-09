# Implementation Plan: Safe Booking Fulfillment Recovery

**Branch**: codex/030-fulfillment-recovery-acceptance | **Date**: 2026-10-07 | **Spec**: spec.md

**Input**: Accepted decisions in docs/adr/0006-booking-fulfillment-reconciliation.md and docs/adr/0033-payment-verification-architecture.md.

## Summary

Make the checkout path safe across Stripe authorization, a Duffel instant order paid from the supplier balance, then Stripe capture. Persist stable provider-operation identity and separate execution attempts before uncovered side effects; coordinate the saga, automated recovery, and operator actions through one fenced workflow claim. Unknown outcomes must be reconciled before another side effect. A stale owner may append late immutable provider evidence but cannot advance workflow state. Roll out additively with new mutations disabled until migration and provider contracts are verified. Replace the existing disabled payment-page placeholder with Stripe Elements wired through existing create, confirm, and status APIs. Add no provider, runtime dependency, AI transaction authority, or exactly-once guarantee.

## Technical Context

**Language/Version**: Existing TypeScript/NestJS API and shared/web packages; Next.js App Router; Prisma/PostgreSQL.
**Primary Dependencies**: Existing Stripe Node SDK, Duffel SDK and ports, Nest guards/DI, shared DTOs, Jest/Playwright; no new runtime dependency assumed.
**Storage**: PostgreSQL is authoritative for workflow, provider operations/attempts, shared claim, and audit evidence. Redis recovery locks cease to be a competing owner.
**Testing**: Test-first API unit, contract, component and PostgreSQL integration coverage; real frontend/backend/database composed system flow; small isolated provider sandbox contract suite.
**Target Platform**: Existing API and web services with PostgreSQL and configured Stripe/Duffel accounts.
**Project Type**: Cross-service booking/payment/recovery feature; existing HTTP and signed-webhook contracts stay compatible.
**Performance Goals**: Persist one conditional fenced write before each uncovered side effect; fold an ownership read into that write only when the predicates and checkpoint semantics remain equivalent. Use bounded provider-aware retries.
**Constraints**: No capture before confirmed supplier order; no create replay while unresolved; reconcile uncertain capture before cancellation; expose actual Stripe expiry; validate discovered order linkage; keep provider SDKs server-side; retain webhook signature, DTO, and privacy boundaries.
**Scale/Scope**: Booking intent/payment, fulfillment and provider ports, recovery, admin queue/action API, checkout UI, additive schema migration, and deterministic test harness.

## Constitution Check

**Pre-research: PASS. Post-design: PASS subject to release gates.**

| Principle | Evidence |
|---|---|
| Flight-first | Only the existing flight transaction is in scope. |
| Deterministic transaction boundary | Nest services and provider-blind ports retain all financial authority; exploratory agents are QA-only. |
| API budget discipline | Reads and backoff are bounded and measured; resolved operations stop polling. |
| Operational visibility | Durable operations/attempts and queue age/evidence support diagnosis and audit. |
| Incremental delivery | Expand/backfill first, deploy all claim users together with behavior off, then canary. |
| Security | Reuse auth/ADMIN guards, signed webhooks, audit module, redaction and zero-client-credential boundary. |

## Target Structure

Documentation: specs/030-fulfillment-recovery-acceptance/{spec.md,plan.md,research.md,data-model.md,quickstart.md,tasks.md,acceptance-matrix.md,contracts/}.

Implementation touch points:
- apps/api/prisma/schema.prisma and apps/api/prisma/migrations/<timestamp>_fulfillment_recovery/
- apps/api/src/payment-fulfillment/{ports/payment-gateway.port.ts,ports/fulfillment-gateway.port.ts,payment-fulfillment.saga.ts}
- apps/api/src/idempotency/payment-idempotency.service.ts
- apps/api/src/supplier/order/duffel-fulfillment.adapter.ts
- apps/api/src/booking-lifecycle/booking-recovery.service.ts
- apps/api/src/payment/ (Stripe expiry retrieval, admin controller/service/module)
- apps/api/src/audit/ and apps/api/src/app.module.ts
- apps/web/app/checkout/[intentId]/payment/page.tsx
- apps/web/components/checkout/PaymentFormClient.tsx (new)
- apps/web/lib/checkout.ts and existing backend client helpers as needed
- apps/api/test/ and apps/web/tests/

The API workflow depends only on PAYMENT_GATEWAY_PORT, FULFILLMENT_GATEWAY_PORT, and the existing live-offer port. Provider SDK objects remain inside adapters. Browser code receives only a publishable Stripe key and client secret; backend services own provider keys, authorization, persistence, and orchestration.

## Design Defaults and Sequence

1. **Characterize and wire checkout.** Baseline payment page has disabled card inputs and Pay Now; no real create/confirm call. Use Stripe Elements/tokenized confirmation with current payment create/confirm/status APIs. Do not collect raw card data. Show durable pending status after reload and poll until confirmed or resolved.
2. **Add the minimal durable journal, disabled.** Create FulfillmentWorkflow keyed uniquely by BookingIntent before authorization; embed current owner token, monotonic fence, and lease expiry on this same row. Add ProviderOperation and ProviderAttempt for stable logical identity versus each execution. Extend PaymentEvent for immutable attempt/evidence linkage instead of creating a separate evidence table. Backfill only when provenance is sufficient; ambiguous old rows remain unresolved.
3. **Use one claim authority.** Saga, recovery cron, and admin actions acquire/renew the same workflow-row claim. Default 180-second lease, renewed every 30 seconds; verify against shutdown and provider timeouts. Acquire with one atomic PostgreSQL conditional write using DB time and incremented fence. Provider calls run outside transactions. Retire Redis and request-key locks as financial ownership authorities in the same release cohort; HTTP idempotency remains response replay and request-hash mismatch only.
4. **Journal uncovered provider side effects.** After read-only preflight and immediately before a call, persist a PREPARED attempt with the current fence. The record means possibly sent. A process death after PREPARED is treated as unresolved. Takeover first reconciles that operation; it never repeats an unknown supplier create.
5. **Fence all state advancement; preserve late facts.** Every checkpoint, operation/workflow/payment/booking mutation, compensation decision and resolution validates owner, fence and unexpired lease in its write transaction. A valid response from an expired actor appends an immutable PaymentEvent tied to the old attempt; it cannot advance state. A current owner validates the event before transition.
6. **Keep checkpoint meaning.** Reuse a current checkpoint only if it covers the provider dispatch that follows. Place an uncovered attempt after preflight immediately before dispatch. Replace a redundant ownership SELECT with the fenced attempt update only if equivalent; optimize unnecessary reads without promising a fixed request count.
7. **Reconcile before financial action.** For uncertain Duffel create, retrieve a known verified order or use supported discovery to find candidates and validate supplier account, intent/offer, itinerary, passengers, and persisted evidence. A missing candidate is not proof of failure. For unknown Stripe capture, retrieve Stripe before supplier cancellation. If the authorization expires during an unresolved create, record expiry and keep supplier reconciliation active; a late confirmed order follows safe compensation or operator review, never blind recapture/create.
8. **Bound recovery and escalation.** Start immediately on first uncertainty; initial delays 5s, 15s, 30s, 1m, 2m, then 5m with jitter capped at 5m and provider-budget enforcement. First-uncertainty time is write-once. Queue after 15 minutes or earlier when verified actual expiry requires intervention. Keep automatic recovery running after queue entry; stop provider calls once resolved.
9. **Expose evidence-driven operations.** Build active queue from unresolved workflows and show age from first uncertainty, verified expiry, latest result and safe actions. Reuse JwtAuthGuard, RolesGuard, ADMIN and audit module patterns. Operators can inspect, request reconciliation or resume only an action allowed by fresh provider evidence. No force, arbitrary state patch, unverified release or blind create.
10. **Verify live provider behavior before flag enablement.** Check Duffel fresh offer, balance amount/currency, pending/payment status, discovery, cancellation and timeout behavior; check Stripe capturability and latest-charge expiry fields. Any unsupported field or ambiguity blocks the live switch.
11. **Roll out compatibly.** Add schema/readers, generate dry-run backfill counts, deploy all mutators using the workflow fence while disabled, verify old rows and compatibility, run deterministic system flow and sandbox contracts, then enable isolated canary. Rollback disables mutations but leaves additive schema/evidence readable.

## Release Gates and Risks

- Duffel documents order creation may take 120 seconds; use an HTTP timeout of at least 130 seconds and renew the claim across a normal call. A timeout is unresolved.
- Stripe capture requires current PaymentIntent status requires_capture; retrieve before a recapture, particularly beyond Stripe idempotency retention.
- Balance payment is a separate supplier leg. Derive amount/currency from freshly validated supplier pricing and provider contract; never pass Stripe customer amount by assumption.
- An empty order discovery result, lease expiry, request-key expiry, webhook absence, or 15-minute threshold is not proof of provider failure.
- Insufficient authorization margin, unavailable provider evidence, mismatched linkage, unknown status, or failed fence blocks the next side effect.
- No database transaction spans a provider call. No new generic job framework or runtime dependency is needed.

## Complexity Tracking

| Addition | Need | Simpler alternative rejected |
|---|---|---|
| FulfillmentWorkflow row with embedded claim | One stable booking-intent workflow and single authority before Booking exists, shared across payment attempts and actors. | Multiple Redis/request-key locks disagree on ownership and fencing. |
| ProviderOperation and ProviderAttempt | Logical action identity must outlive HTTP keys; every execution needs distinct durable evidence. | Reusing IdempotencyKey binds financial lifetime to request replay/expiry. |
| PaymentEvent attempt/evidence fields | Keep immutable provider facts using existing payment audit log. | Separate evidence table adds storage/API surface without new semantics. |
| Stateful real-stack simulators | Prove adapter mapping and database/orchestration/webhook behavior deterministically. | Replacing the whole fulfillment port masks the real adapter boundary. |
## Review corrections: all entry points and release routing

Include apps/api/src/payment/payment.service.ts and tests in claim/journal adoption: reserve Payment and stable Stripe creation identity before provider dispatch, persist evidence before browser confirmation, and fence cleanup/release paths. Add PAYMENT_INTENT_CREATE purpose and support nullable Stripe IDs/internal RESERVED state through explicit reader migration and compatible ready-intent responses. Browser authorization is independently observed; prepare before exposing confirmation and reconcile provider facts.

Quiesce/drain legacy mutators before backfill/enrollment. Enrollment survives release-switch changes. Rollback cannot route enrolled unresolved cases into legacy compensation; retain readers/evidence and compatible reconciliation or freeze actions with operator visibility.

Implement the controlled harness explicitly: provider transport servers, protected driver, isolation, browser Stripe seam, scheduler, restart barriers, redaction and teardown. Wire a required CI job, not only assertions. Separate virtual scheduling from real DB lease-expiry tests. Exclude sandbox and long-timeout suites from generic integration discovery; use the route-contract lane for app-directory server-action tests.
