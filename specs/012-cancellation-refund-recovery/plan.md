# Implementation Plan: Cancellation & Refund Recovery

**Feature Branch**: `012-cancellation-refund-recovery`  
**Input**: [CONTEXT.md](../../CONTEXT.md) and [cancellation/refund ADR](../../docs/adr/0012-cancellation-and-refund-failure-handling.md)  
**Status**: Completed

## Summary

Add a deterministic, supplier-first cancellation flow for confirmed flights.
Duffel cancellation is deadline-sensitive and performed synchronously with
bounded retries. Once Duffel confirms cancellation, Stripe refunds are retried
inline and then by a CAS-claimed worker. Terminal or unsafe refund failures
escalate to manual attention and notify the traveller.

## Technical Context

| Area                 | Decision                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Runtime              | NestJS, Next.js App Router, Prisma/PostgreSQL, Stripe, Duffel                             |
| Transaction boundary | No AI involvement; every external action has an audit record and correlation ID           |
| Concurrency          | Conditional Prisma writes (CAS); never hold a DB transaction across an external HTTP call |
| Supplier recovery    | Remote-first Duffel order/quote verification after a crash or stale claim                 |
| Refund safety        | One logical refund + one Stripe idempotency key; stop at 22 hours                         |
| Observability        | Structured PII-safe logs, metrics for claims/retries/escalations, audit events and alerts |

## Constitution Check

- **Flight-first:** cancellation improves the core flight lifecycle; no hotel or AI scope.
- **Deterministic boundary:** Duffel, Stripe, persistence, scheduling, and notification are deterministic.
- **API budget:** no polling of Duffel from page rendering; recovery requests occur only for claimed work.
- **Operational visibility:** every claim, retry, external result, and escalation receives trace/correlation identifiers.
- **Incremental delivery:** each PR is independently deployable and has an end-to-end acceptance path.

## Design artifacts

- [Research](./research.md)
- [Data model](./data-model.md)
- [API contracts](./contracts/api.md)
- [Validation guide](./quickstart.md)

## Delivery phases and pull requests

### Phase 1 / PR 1 — Quote and cancellation eligibility

**Goal:** A traveller can see whether a confirmed booking is cancellable and
the exact supplier-provided refund before they commit.

**Work:**

- Migrate Booking with cancellation deadline/state fields and add durable
  Cancellation/Refund recovery fields plus indexes.
- Capture the fare-specific cancellation deadline when the booking is confirmed.
- Add the Duffel quote adapter and an owner-scoped quote endpoint that reuses a
  valid stored quote.
- Add shared DTOs and a detail-page cancellation panel showing deadline, quote
  amount, expiry, and unavailable reasons.
- Add audit events, PII-safe structured logs, and API tests for owner,
  eligibility, expired deadline, and quote reuse.

**Exit criteria:** a demo booking displays a durable, supplier-sourced quote;
no cancellation or refund is performed by this PR.

### Phase 2 / PR 2 — Supplier-first cancellation transaction

**Goal:** Confirming a quote cancels the supplier order exactly once before any
refund is attempted.

**Work:**

- Implement the CAS claim from `CONFIRMED`/`COMPLETED` to
  `CANCELLATION_PENDING`; return canonical state to concurrent callers.
- Confirm the Duffel quote using 1/3/5/10-second retry policy and classify
  retryable supplier failures.
- Persist supplier confirmation, amounts, and timestamps before moving to
  `CANCELLED_PENDING_REFUND`.
- Implement stale-claim recovery: retrieve the Duffel order, reuse unconfirmed
  quotes, and avoid duplicate supplier cancellation after a crash.
- Wire the confirmation UI with duplicate-click protection and clear outcome
  messaging.

**Exit criteria:** parallel cancel requests produce one Duffel cancellation;
supplier failure never starts a Stripe refund.

### Phase 3 / PR 3 — Durable Stripe refund recovery

**Goal:** A supplier-cancelled booking either receives one refund or is visibly
escalated for human action.

**Work:**

- Create or reuse one booking-owned Refund from Duffel's quoted amount and
  persist the Stripe idempotency key creation time.
- Add inline Stripe retries (1/3/5 seconds), transient/deterministic error
  classification, and immutable audit events.
- Add a scheduled worker for 1m/5m/30m/2h retry windows. Claim each due refund
  with CAS; reuse the original idempotency key; stop at 22 hours.
- Reconcile Stripe webhooks idempotently and transition the Booking to
  `CANCELLED`; transition terminal cases to
  `REFUND_FAILED_NEEDS_ATTENTION`.
- Emit metrics/alerts and send a proactive traveller notification on escalation.

**Exit criteria:** retries cannot double-refund; deterministic errors and stale
keys escalate without another Stripe call.

### Phase 4 / PR 4 — Cancellation status experience and operations

**Goal:** Travellers and operators can understand the authoritative state
without triggering external API calls from the UI.

**Work:**

- Expose read-only cancellation status on booking detail/list responses.
- Render pending refund, cancelled, and needs-attention states with exact
  refund amounts, retry timing, and support hand-off.
- Add an operator-safe escalation view or existing admin integration showing
  correlation IDs and PII-safe failure reason; no customer card data.
- Add health/metric dashboard entries and alerts for stuck claims, high retry
  rate, supplier failures, and manual escalations.

**Exit criteria:** a refresh-only detail page accurately represents every
durable state, including escalations.

### Phase 5 / PR 5 — End-to-end resilience verification

**Goal:** Prove all normal, concurrent, and crash-recovery paths before rollout.

**Work:**

- Add API E2E coverage for ownership, deadline, quote expiry, CAS races,
  supplier retry exhaustion, remote-first recovery, retry classification,
  key-expiry escalation, and webhook/worker races.
- Add Playwright journeys for quote review, confirmation, pending refund,
  successful cancellation, and manual-attention messaging.
- Run migration, type-check, lint, backend E2E, and Playwright checks.
- Update architecture/progress documentation on completion and prepare the
  rollout/rollback runbook.

**Exit criteria:** all automated checks pass and a production rollback leaves
previous booking states readable.

## GitHub tracking map

Create one GitHub issue per PR/phase, linked in dependency order:

```text
#1 Quote & eligibility
  └─ #2 Supplier-first cancellation
       └─ #3 Stripe refund recovery
            └─ #4 Status and operations UX
                 └─ #5 Resilience verification
```

Each issue is a reviewable vertical slice, is labelled `ready-for-agent` after
approval, and references its blocking issue. PRs target `development` and stay
small enough to review independently.

## Complexity justification

CAS claims, remote-first recovery, and background retries are deliberately more
complex than a direct request/response refund. They are required to protect
real-money transactions from duplicate supplier cancellations, duplicate
refunds, and crash gaps, satisfying the constitution's deterministic,
auditable, and operational-visibility requirements.
