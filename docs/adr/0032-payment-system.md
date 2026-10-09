# Payment System — Grilling Decisions

Grilling session: 2026-07-11 / 2026-07-12. Covers Feature B (Payment & Confirmation) of the booking workflow.
Reference video: "Design a Payment System Like a Senior Engineer" (youtube.com/watch?v=Mqalc-nRMB0)

---

## Scope

| Feature                                         | Scope                                                             | Status                      |
| ----------------------------------------------- | ----------------------------------------------------------------- | --------------------------- |
| **A — Booking Creation & Passenger Collection** | Flight selection → passenger entry → re-pricing → intent creation | Complete                    |
| **B — Payment & Confirmation**                  | Stripe payment → PNR creation → ticket issuance → confirmation    | **Current focus**           |
| **C — Bookings Management & Post-Booking**      | `/bookings` list, detail, cancellation, refund, status tracking   | Deferred (depends on A + B) |

---

## Decision 1: Direct Charges (No Stripe Connect)

**Decision**: Use Stripe direct charges. The platform is the merchant of record.

**Rejected alternative**: Stripe Connect with marketplace split payments.

**Rationale**:

- No partners or third-party sellers exist in the current system.
- The platform sells tickets to customers directly via Duffel.
- Duffel costs are an internal accounting concern handled within the system, not via Stripe splits.
- Stripe Connect adds enormous complexity (connected account onboarding, per-account disputes, payout management) with no current justification.

**Future-proofing**: Data model includes fields that could support future marketplace scenarios, but no Stripe Connect wiring in v1.

---

## Decision 2: Payment State Machine (Finite State Machine with Enforced Transitions)

**Decision**: Payment lifecycle is modeled as a strict FSM. Invalid transitions are rejected.

### States

| State                | Meaning                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `CREATED`            | PaymentIntent created on Stripe, client secret returned to frontend |
| `AUTHORIZED`         | Funds held on customer's card (auth-only), not yet captured         |
| `SUCCEEDED`          | Funds captured after Duffel PNR confirmation                        |
| `FAILED`             | Payment failed — **terminal state**, new PaymentIntent required     |
| `EXPIRED`            | Authorization hold timed out unused, or intent expired unconfirmed  |
| `CANCELLED`          | Explicitly cancelled before authorization/capture                   |
| `REFUND_PENDING`     | Refund initiated, awaiting Stripe confirmation                      |
| `PARTIALLY_REFUNDED` | Stripe confirmed a partial refund                                   |
| `REFUNDED`           | Full amount refunded                                                |
| `DISPUTED`           | Chargeback/dispute opened by customer's bank                        |
| `CHARGEBACK_LOST`    | Dispute resolved in customer's favor (platform lost)                |

### Enforced Transitions

```
CREATED → AUTHORIZED → SUCCEEDED
CREATED → FAILED (terminal)
CREATED → CANCELLED

AUTHORIZED → EXPIRED (hold timed out)
AUTHORIZED → CANCELLED (voided)

SUCCEEDED → REFUND_PENDING → PARTIALLY_REFUNDED
                            → REFUNDED
PARTIALLY_REFUNDED → REFUND_PENDING (another refund cycle)

SUCCEEDED → DISPUTED → SUCCEEDED (dispute won, returns to pre-dispute state)
                      → CHARGEBACK_LOST (dispute lost)

PARTIALLY_REFUNDED → DISPUTED → PARTIALLY_REFUNDED (dispute won)
                               → CHARGEBACK_LOST (dispute lost)

REFUNDED → DISPUTED → REFUNDED (dispute won, returns to pre-dispute state)
                     → CHARGEBACK_LOST (dispute lost)
```

### Key Design Rules

- **`FAILED` is terminal**: No retries on the same PaymentIntent. A new PaymentIntent (new `Payment` row) is required for retry. Cleaner audit trail, unambiguous "is this row done" logic.
- **Dispute resolution returns to pre-dispute state**: Winning a dispute after `REFUNDED` returns to `REFUNDED`, not `SUCCEEDED`. The refund already happened; winning just means the bank didn't also take the money.
- **`pre_dispute_status` column**: Stored on the `Payment` record so the dispute resolution webhook handler knows which state to restore.

---

## Decision 3: Authorize-Then-Capture Pattern

**Decision**: Separate authorization and capture. Authorize first (hold funds), then capture only after Duffel confirms the PNR.

**Flow**:

1. Customer submits payment → Stripe **authorizes** (holds funds on card)
2. Backend calls Duffel to create booking/PNR
3. **If Duffel succeeds** → **capture** the authorized amount
4. **If Duffel fails** → **void/cancel** the authorization (customer's card released, no charge)

**Rationale**: Prevents charging customers for bookings that fail on Duffel's side. The customer never pays for a ticket that doesn't exist.

### Tiered Timeout Escalation (Authorize-to-Capture)

| Tier                          | Threshold              | Action                                                                                                                                     |
| ----------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tier 1 — Synchronous**      | 0–30s                  | Show spinner, wait for Duffel response inline                                                                                              |
| **Tier 2 — Async handoff**    | 30s–1min               | Stop spinner, show "Confirming your flight…", let customer leave page. Backend continues in background                                     |
| **Tier 3 — Admin escalation** | ~15min                 | Alert the payment administrator to investigate (our bug vs. Duffel issue?)                                                                 |
| **Tier 4 — Auto-expire**      | 30min–1hr              | Mark `AUTHORIZED → EXPIRED`, void the hold on the customer's card                                                                          |
| **Cleanup sweep**             | 5–10 days after expiry | Retain under a documented policy for auditable payment and ledger records, limiting cleanup to ephemeral idempotency data or safe archival |

**Notification for async confirmation**: Deferred to a separate email notification system (not in scope for payment feature). A cron will send completion signals to users.

---

## Decision 4: Refund System — Dual Trigger Model

**Decision**: Both automated and admin-triggered refunds. Automated refunds for system-detectable errors; admin-triggered for ambiguous cases.

### Refund Scope

- Refunds are for **system errors only** — not "I changed my mind" cancellations.
- Examples of system errors: duplicate charges, failed captures, booking succeeded but ticket issuance failed.

### Trigger Types

| Trigger            | When                                                                                                            | Authorization                |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `SYSTEM_AUTOMATED` | System detects its own error with certainty (e.g., duplicate charge, "charge up to 2 times" invariant violated) | No human needed              |
| `ADMIN`            | Ambiguous cases, customer-reported issues                                                                       | Admin investigation required |

### Automated Refund Guardrails

- **Every automated refund gets its own idempotency key** (e.g., `refund:{paymentId}:{reason}:{occurrence}`) to prevent turning a "charge twice" bug into a "refund twice" bug.
- `requires_review` flag on refund records — automated refunds flagged for 24h human review after execution.

### Partial Refunds

- Supported. Flight bookings can need multiple partial refunds (one passenger cancels, then another, then a fee waiver).
- `PARTIALLY_REFUNDED → REFUND_PENDING` loop is an enforced transition allowing repeat refund cycles.
- Eventually closes to `REFUNDED` when full amount is returned.

---

## Decision 5: Charge Limit — Two Payment Attempts per BookingIntent

**Decision**: A customer can make a maximum of **2 payment attempts** per `BookingIntent`.

**Semantics (Interpretation A — two attempts, not two captures)**:

1. Attempt 1 fails (card declined, Duffel unavailable, 3DS failed) → `FAILED` (terminal)
2. Customer clicks "Try Again" → system creates Attempt 2 (new PaymentIntent, new `Payment` row)
3. Attempt 2 fails → `BookingIntent.status = PAYMENT_EXHAUSTED`, no more attempts allowed

**After exhaustion**: Customer must start over — go back to flight selection, create a **new** `BookingIntent` (re-validates passengers, re-prices with Duffel, gets fresh offer).

**Rationale**:

- Prevents infinite retry loops against a stale offer or consistently failing card.
- Re-creating forces a fresh Duffel re-price — no stale pricing.
- Clean audit trail: each `BookingIntent` has at most 2 `Payment` rows.

**Safety guardrail**: If the system somehow captures a third time (should be impossible), auto-refund immediately with a dedicated idempotency key.

---

## Decision 6: Concurrency Control — Hybrid Pessimistic + Optimistic Locking

**Decision**: Two-phase locking strategy. No Redis locks.

### Phase 1 — Pessimistic Claim (milliseconds, no external calls)

```sql
BEGIN TRANSACTION
  SELECT * FROM booking_intents WHERE id = :id FOR UPDATE
  -- Check: status is in a startable state
  -- Check: payment_attempt_count < 2
  -- Write: status = 'CLAIMING' marker, increment version, commit
END TRANSACTION
-- Lock released immediately. No Stripe or Duffel calls inside this transaction.
```

This alone guarantees "no two requests can start the pipeline for the same intent."

### Phase 2 — Optimistic Version Checks (all external calls happen here)

```sql
-- After Stripe authorize:
UPDATE payments SET status = 'AUTHORIZED', version = version + 1
  WHERE id = :id AND version = :expectedVersion
-- If affected rows = 0 → conflict detected

-- After Duffel PNR creation:
UPDATE payments SET status = 'SUCCEEDED', version = version + 1
  WHERE id = :id AND version = :expectedVersion
-- If affected rows = 0 → conflict (e.g., admin cancelled mid-pipeline)
```

**Rationale**: No long-held locks across network calls. Conflict detection on every step. Redis excluded because PostgreSQL handles the coordination within the same transaction boundary.

---

## Decision 7: Webhook Processing — Source of Truth with Two-Tier Handling

**Decision**: Stripe webhooks are the source of truth for payment status. Client-side confirmations are never trusted.

### Duplicate Handling

- Store Stripe event ID (`evt_xxx`) in `payment_events.stripe_event_id` (unique index, nullable).
- Check before processing — if the event ID already exists, return 200 and skip.

### Out-of-Order / Invalid Transition Handling

**Tier 1 — Self-healing reconciliation (out-of-order but explainable)**:

- The webhook transition is invalid against DB state, but the gap is a plausible ordering issue.
- Example: Webhook says `succeeded`, DB shows `CREATED` (skipped `AUTHORIZED` because that webhook hasn't arrived yet).
- Action: Call `Stripe.paymentIntents.retrieve()` to get canonical state. If Stripe confirms the event is real, fast-forward DB to match. Log the reconciliation. No alert.

**Tier 2 — Alert + drop (irreconcilable)**:

- The webhook transition contradicts DB state in a way reconciliation can't explain.
- Example: Webhook says `succeeded`, DB shows `REFUNDED` — money was already returned.
- Action: Log an allowlisted diagnostic subset of the payload (or use a controlled encrypted audit store with defined retention limits), alert admin, return 200 to Stripe, do **not** change state.

**Design principle**: Stripe is the source of truth, but the state machine is the gatekeeper. Self-heal when the gap is timing. Escalate when the gap implies something fundamentally wrong.

---

## Decision 8: Saved Payment Methods — Lazy Stripe Customer Creation

**Decision**: Stripe `Customer` object created lazily at first payment, not at registration.

### Creation Flow

1. `User.stripeCustomerId` is nullable — populated synchronously **before** creating the first PaymentIntent.
2. Idempotency: Customer creation keyed by `customer-create:{userId}` so retries can't spawn duplicates.
3. When checkbox is checked: set `setup_future_usage: 'off_session'` on PaymentIntent → Stripe auto-attaches the method on success.
4. When unchecked: no `setup_future_usage`, card used once and not saved.

### Opt-In Model

- **Explicit checkbox**: "Save this card for future bookings" — customer controls saving.
- `payment_methods.saved_with_consent` column records that opt-in occurred.

---

## Decision 9: Recovery Points and Dual State Tracking

**Decision**: Two state-tracking columns with different granularities.

### `payments.status` — Business-facing state

- What the customer sees, what webhooks update, what the refund system reads.
- Answers: "what is the current state of this payment?"

### `idempotency_keys.recovery_point` — Pipeline-internal checkpoint

- Where to resume if a request crashes and retries.
- More granular: `started → stripe_authorized → duffel_order_created → captured → completed`
- `duffel_order_created` has no corresponding payment status — the payment is still `AUTHORIZED` at that point.

### Relationship

| Recovery Point         | Payment Status                                               |
| ---------------------- | ------------------------------------------------------------ |
| `started`              | `CREATED`                                                    |
| `stripe_authorized`    | `AUTHORIZED`                                                 |
| `duffel_order_created` | `AUTHORIZED` (Duffel confirmed, capture hasn't happened yet) |
| `captured`             | `SUCCEEDED`                                                  |
| `completed`            | `SUCCEEDED`                                                  |

On retry, the system reads the recovery point to know which step to resume from, then updates the payment status only at business-significant boundaries.

---

## Decision 10: Consistency Over Availability

**Decision**: The payment system prioritizes **consistency over availability** (CP in CAP theorem terms).

**Rationale**: If the system fails for 1–2 minutes, that's acceptable. But an inconsistent state (money charged but no ticket, ticket issued but no charge) is unacceptable.

**Implications**:

- Synchronous database writes with strong consistency guarantees.
- No eventual consistency patterns in the payment pipeline.
- Serializable or strong read-after-write consistency for all payment state queries.

---

## Decision 11: Idempotency at Every Layer

**Decision**: Every mutating operation in the payment pipeline is idempotent.

**Layers**:

- **API layer**: `idempotency_keys` table with unique key + request hash validation.
- **Stripe layer**: Stripe's native idempotency key support on all API calls.
- **Webhook layer**: `stripe_event_id` unique index on `payment_events`.
- **Refund layer**: Per-refund idempotency keys (especially for automated refunds).
- **Recovery layer**: Recovery points enable safe retry from any checkpoint.

---

## Database Schema

### `payments`

| Column                     | Type                  | Notes                                                                                                                               |
| -------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | UUID/SERIAL (PK)      |                                                                                                                                     |
| `booking_intent_id`        | FK → booking_intents  |                                                                                                                                     |
| `attempt_number`           | INTEGER               | 1 or 2                                                                                                                              |
| `idempotency_key_id`       | FK → idempotency_keys |                                                                                                                                     |
| `stripe_payment_intent_id` | TEXT (unique)         |                                                                                                                                     |
| `stripe_customer_id`       | TEXT                  |                                                                                                                                     |
| `amount`                   | INTEGER               | In smallest currency unit (cents)                                                                                                   |
| `currency`                 | TEXT                  | ISO 4217                                                                                                                            |
| `payment_method_type`      | TEXT                  | card, etc.                                                                                                                          |
| `status`                   | ENUM                  | CREATED, AUTHORIZED, SUCCEEDED, FAILED, EXPIRED, CANCELLED, REFUND_PENDING, PARTIALLY_REFUNDED, REFUNDED, DISPUTED, CHARGEBACK_LOST |
| `pre_dispute_status`       | ENUM (nullable)       | Populated when entering DISPUTED state                                                                                              |
| `version`                  | INTEGER               | For optimistic locking                                                                                                              |
| `created_at`               | TIMESTAMP             |                                                                                                                                     |
| `updated_at`               | TIMESTAMP             |                                                                                                                                     |

### `idempotency_keys`

| Column           | Type                 | Notes                                                                                        |
| ---------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `id`             | UUID/SERIAL (PK)     |                                                                                              |
| `key`            | TEXT (unique)        | Client-provided idempotency key                                                              |
| `request_hash`   | TEXT                 | Catches same key reused with different payload                                               |
| `customer_id`    | FK → users           |                                                                                              |
| `request_path`   | TEXT                 | API endpoint path                                                                            |
| `request_params` | JSONB                | Request body snapshot                                                                        |
| `response_code`  | INTEGER              | HTTP status code of response                                                                 |
| `response_body`  | JSONB                | Cached response for replay                                                                   |
| `recovery_point` | TEXT                 | Pipeline progress: started → stripe_authorized → duffel_order_created → captured → completed |
| `locked_at`      | TIMESTAMP (nullable) | Claim mechanism for pessimistic lock                                                         |
| `created_at`     | TIMESTAMP            |                                                                                              |
| `expires_at`     | TIMESTAMP            |                                                                                              |

### `payment_events` (immutable audit log)

| Column            | Type                    | Notes                                                           |
| ----------------- | ----------------------- | --------------------------------------------------------------- |
| `id`              | BIGSERIAL (PK)          |                                                                 |
| `payment_id`      | FK → payments           |                                                                 |
| `event_type`      | TEXT                    | e.g., `payment_intent.succeeded`, `refund.created`              |
| `previous_status` | ENUM                    | State before transition                                         |
| `new_status`      | ENUM                    | State after transition                                          |
| `amount`          | INTEGER                 | Amount involved in this event                                   |
| `source`          | TEXT                    | CHECK constraint on allowed values (webhook, api, cron, system) |
| `stripe_event_id` | TEXT (unique, nullable) | Webhook deduplication                                           |
| `metadata`        | JSONB                   | Raw payload                                                     |
| `created_at`      | TIMESTAMP               |                                                                 |
| `created_by`      | TEXT                    | User ID, system, or service name                                |

### `ledger_entries` (double-entry bookkeeping)

| Column           | Type             | Notes                                              |
| ---------------- | ---------------- | -------------------------------------------------- |
| `id`             | UUID/SERIAL (PK) |                                                    |
| `payment_id`     | FK → payments    |                                                    |
| `transaction_id` | TEXT             | Groups paired debit/credit rows                    |
| `account_id`     | TEXT             | CUSTOMER_RECEIVABLE, PLATFORM_REVENUE, DUFFEL_COST |
| `entry_type`     | ENUM             | DEBIT, CREDIT                                      |
| `amount`         | INTEGER          | In smallest currency unit                          |
| `currency`       | TEXT             | ISO 4217                                           |
| `created_at`     | TIMESTAMP        |                                                    |

**V1 Chart of Accounts** (3 accounts only):

- `CUSTOMER_RECEIVABLE` — money owed by/to the customer
- `PLATFORM_REVENUE` — platform's revenue
- `DUFFEL_COST` — what owed to Duffel for the ticket

**Deferred from v1**:

- `STRIPE_FEES` — visible on Stripe dashboard, not needed in own ledger yet
- `REFUND_LIABILITY` — refunds are reversing entries between existing accounts; `refunds.status = REFUND_PENDING` captures the operational state

### `refunds`

| Column                 | Type                  | Notes                                       |
| ---------------------- | --------------------- | ------------------------------------------- |
| `id`                   | UUID/SERIAL (PK)      |                                             |
| `payment_id`           | FK → payments         |                                             |
| `idempotency_key_id`   | FK → idempotency_keys | Real FK, not bare column                    |
| `stripe_refund_id`     | TEXT (unique)         |                                             |
| `amount`               | INTEGER               | In smallest currency unit                   |
| `currency`             | TEXT                  | ISO 4217                                    |
| `reason`               | TEXT                  |                                             |
| `trigger_type`         | ENUM                  | ADMIN, SYSTEM_AUTOMATED                     |
| `triggered_by_user_id` | FK → users (nullable) | NULL for automated refunds                  |
| `requires_review`      | BOOLEAN               | Flags automated refunds for 24h human check |
| `status`               | ENUM                  | REFUND_PENDING, SUCCEEDED, FAILED           |
| `created_at`           | TIMESTAMP             |                                             |
| `updated_at`           | TIMESTAMP             |                                             |

### `booking_intents` (payment-relevant additions to existing table)

| Column                  | Type            | Notes                                                          |
| ----------------------- | --------------- | -------------------------------------------------------------- |
| `stripe_customer_id`    | TEXT (nullable) | Populated at first payment attempt                             |
| `status`                | ENUM (extended) | Add: AWAITING_PAYMENT, PAYMENT_EXHAUSTED, CONFIRMED, CANCELLED |
| `payment_attempt_count` | INTEGER         | Max 2                                                          |

### `payment_methods`

| Column                     | Type             | Notes                                     |
| -------------------------- | ---------------- | ----------------------------------------- |
| `id`                       | UUID/SERIAL (PK) |                                           |
| `stripe_customer_id`       | TEXT             |                                           |
| `stripe_payment_method_id` | TEXT (unique)    |                                           |
| `card_brand`               | TEXT             | visa, mastercard, etc.                    |
| `card_last4`               | TEXT             | Last 4 digits for display                 |
| `is_default`               | BOOLEAN          |                                           |
| `saved_with_consent`       | BOOLEAN          | Only exists if user opted in via checkbox |
| `created_at`               | TIMESTAMP        |                                           |

---

## Non-Functional Requirements Summary

| Requirement                                       | Implementation                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Correctness**: Exactly one processing at a time | Hybrid pessimistic claim + optimistic version checks                                   |
| **Correctness**: Max 2 charges per booking        | `payment_attempt_count` with pre-check at pipeline entry                               |
| **Consistency over availability**                 | Synchronous writes, strong consistency, no eventual consistency in payment path        |
| **Idempotency at every layer**                    | `idempotency_keys` table, Stripe native keys, `stripe_event_id` dedup, per-refund keys |
| **Reliability**: Recovery from crashes            | `recovery_point` column enables safe retry from any pipeline checkpoint                |
| **Auditability**                                  | Immutable `payment_events` log, double-entry `ledger_entries`                          |

---

## Open Questions (For Future Features / Separate Scope)

1. **Notification system**: Email notifications for async booking confirmations — deferred to separate feature.
2. **Companion profiles (`SavedTraveler` refactor)**: When to schedule relative to Feature B.
3. **Admin panel**: UI for admin-triggered refunds and payment investigation.
4. **Stripe fees tracking**: Add `STRIPE_FEES` ledger account when P&L reporting is needed.
5. **Refund liability account**: Add when gap between "owe refund" and "paid refund" needs separate reporting.
