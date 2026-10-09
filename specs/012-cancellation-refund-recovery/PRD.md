# Product Requirements Document: Cancellation & Refund Recovery

**Feature:** 012 — Cancellation & Refund Recovery  
**Status:** Planned  
**Related plan:** [plan.md](./plan.md)  
**Decision record:** [Cancellation and Refund Failure Handling](../../docs/adr/0012-cancellation-and-refund-failure-handling.md)

## Problem Statement

Travellers with a confirmed flight currently lack a trustworthy way to cancel a
booking and understand what will happen to their money. A cancellation crosses
two independent systems: the airline supplier must release the PNR, and Stripe
must reimburse the traveller. Failures, duplicate requests, or a process crash
between those systems can otherwise leave a traveller uncertain whether the
flight is cancelled, whether a refund is coming, or what action to take.

## Solution

Give an eligible traveller a clear cancellation journey: see the fare-specific
deadline and supplier-provided refund quote, explicitly confirm, and receive a
durable status. The platform always cancels with Duffel before requesting a
Stripe refund. It recovers transient failures safely, never duplicates a
cancellation or refund, and proactively escalates a terminal refund failure to
human review while keeping the traveller informed.

## User Stories

1. As a traveller, I want to see whether my confirmed flight is eligible for cancellation, so that I do not attempt an unavailable action.
2. As a traveller, I want to see my fare-specific cancellation deadline, so that I can decide before the airline's cutoff.
3. As a traveller, I want to see the exact supplier-provided refund amount and currency before confirming, so that I understand the financial consequence.
4. As a traveller, I want to see when a cancellation quote expires, so that I can act on a current price and policy.
5. As a traveller, I want to explicitly confirm my cancellation after reviewing the quote, so that I do not accidentally release my flight.
6. As a traveller, I want duplicate clicks or refreshes to remain safe, so that I cannot cancel the same booking twice.
7. As a traveller, I want confirmation that the airline cancellation is being processed, so that I know the platform has accepted my request without misrepresenting completion.
8. As a traveller, I want the flight to be cancelled before my refund is initiated, so that I am not refunded while an active booking remains.
9. As a traveller, I want to see a pending-refund state and its next expected retry, so that I know a temporary payment-provider problem is being handled.
10. As a traveller, I want to see a clear cancelled state when the refund has completed, so that I can retain a reliable record.
11. As a traveller, I want a clear support path when a refund needs manual attention, so that I am not left without recourse after the flight has been cancelled.
12. As a support operator, I want a PII-safe history of claims, supplier results, Stripe results, and correlation IDs, so that I can resolve an escalation without guessing.
13. As an operations engineer, I want alerts for stuck cancellation claims, recurring supplier failures, and refund escalations, so that payment-impacting failures are addressed promptly.
14. As the platform, I want recovery after an application crash to check the supplier's actual state first, so that retries do not duplicate supplier cancellations.
15. As the platform, I want every retry for one logical refund to use the same Stripe idempotency key until it is unsafe to do so, so that retries cannot create duplicate refunds.
16. As the platform, I want deterministic Stripe errors and expired idempotency keys to go directly to manual attention, so that futile automated retries do not delay resolution.

## Implementation Decisions

- Cancellation and reimbursement remain fully deterministic; AI has no role in the booking, cancellation, or payment transaction boundary.
- Only confirmed or completed bookings with a successful payment, supplier order, and unexpired stored cancellation deadline can enter cancellation.
- The traveller first requests a supplier cancellation quote. A valid stored quote is reused; the response provides the exact supplier `refund_amount`, currency, quote expiry, and cancellation deadline.
- The cancellation command requires the selected quote and atomically claims the booking. Concurrent callers receive the canonical state and never repeat the supplier call.
- The booking moves through this user-visible lifecycle:

  ```text
  CONFIRMED/COMPLETED → CANCELLATION_PENDING
  CANCELLATION_PENDING → CANCELLED_PENDING_REFUND
  CANCELLED_PENDING_REFUND → CANCELLED
  CANCELLED_PENDING_REFUND → REFUND_FAILED_NEEDS_ATTENTION
  ```

- A durable cancellation record holds supplier quote and confirmation evidence; the existing payment refund record gains booking ownership, amounts, retry schedule, key age, and safe error diagnostics.
- Duffel cancellation uses short synchronous retries at 1, 3, 5, and 10 seconds. If supplier cancellation cannot be confirmed, the request fails without beginning a refund.
- Recovery verifies the Duffel order before retrying. An already-cancelled order moves directly to refund handling; an unconfirmed valid quote is reused instead of creating another.
- Stripe refund attempts use short inline retries at 1, 3, and 5 seconds, followed by worker retries at 1 minute, 5 minutes, 30 minutes, and 2 hours.
- Retryable Stripe failures include temporary provider/server/network/rate-limit failures. Invalid, declined, disputed, already-refunded, and other deterministic failures escalate immediately.
- One logical refund reuses one Stripe idempotency key. A key at least 22 hours old is not retried and instead escalates for manual attention.
- Webhooks and the scheduled worker reconcile the same durable refund state idempotently. Conditional database updates decide the sole actor allowed to call Stripe.
- Booking detail and list reads use only local state; they do not poll Duffel or Stripe. Customer responses and operational records mask PII and never expose payment-card data.
- Structured logs, audit events, metrics, health signals, and alerts carry trace and correlation identifiers for every claim, retry, result, and escalation.

## Testing Decisions

The primary behavioral seams are the cancellation quote command, cancellation
confirmation command, and read-only cancellation status endpoint. These are
the highest stable seams: tests assert customer-visible responses and durable
state rather than service internals.

- Backend E2E tests cover ownership, eligibility, fare deadlines, quote expiry
  and reuse, supplier retry exhaustion, CAS races, remote-first crash recovery,
  transient versus deterministic Stripe failure classification, worker/webhook
  races, idempotency-key expiry, and escalation.
- Frontend Playwright tests cover quote review, explicit confirmation,
  cancellation-pending, refund-pending, completed cancellation, and
  needs-attention/support messaging.
- Concurrency tests verify the externally observable invariant: two requests or
  a worker race yield one supplier cancellation and one logical Stripe refund.
- Webhook tests verify that late or duplicate provider events converge to the
  same user-visible state without a duplicate reimbursement.
- Existing NestJS API E2E and Next.js Playwright conventions remain the prior
  art; migrations, linting, type checking, and existing payment/booking tests
  must remain green.

## Out of Scope

- AI recommendations or automatic cancellation decisions.
- Refunds that exceed the supplier quote or absorb airline penalties.
- Cancellation of bookings that are not confirmed/completed, have no eligible
  supplier order, or are past their stored cancellation deadline.
- A new payment processor, card-data storage, or browser-side supplier/payment
  polling.
- Hotel, dining, itinerary, and other non-flight products.

## Further Notes

- The cancellation deadline is fare-specific, not a global policy setting.
- A successful supplier cancellation followed by refund trouble is treated as a
  customer-care incident: it is visible, auditable, monitored, and escalated;
  it is never silently abandoned.
- Implementation is intentionally divided into five PR-sized vertical slices:
  quote/eligibility, supplier cancellation, refund recovery, status/operations,
  and end-to-end resilience verification.
- Publishing this PRD to GitHub remains blocked until the GitHub integration is
  granted Issues write access for the repository.
