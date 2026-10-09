# Grilling Session #2 — Cancellation & Refund Stress Test

Stress-tested the cancellation and refund management architecture across 10 prioritized edge cases before implementation.

## Decisions Made

### Q1 — Concurrency Control ✅

**Decision**: Atomic CAS claim (`UPDATE ... WHERE status IN ('CONFIRMED', 'PROCESSING') RETURNING *`) instead of pessimistic row-level locks. Avoids holding DB locks during external HTTP calls.
**New state introduced**: `CANCELLATION_PENDING` — a transient claim state before Duffel is called.

---

### Q2 — Duffel Crash Recovery ✅

**Decision**: Remote-first verification on retry. Don't trust local `cancellationQuoteId` alone — GET the Duffel order first. If already cancelled, skip to refund. If unconfirmed quote exists, confirm it. Only call `create()` fresh if nothing found.
**Rationale**: The gap between an external API call succeeding and the local DB write committing can't be eliminated by reordering.

---

### Q3 — RefundStatus FSM Expansion ✅

**Decision**: Expand `RefundStatus` enum from 3 states to 5:

- `REFUND_PENDING` → `REFUND_PROCESSING` → `REFUND_RETRY_SCHEDULED` → `SUCCEEDED` / `REFUND_FAILED_NEEDS_ATTENTION`

**Error classification gate**: Transient errors (5xx, timeout, 429) → retry. Deterministic errors (card declined, already refunded) → escalate immediately.

**Special case**: `charge_already_refunded` from Stripe should verify with Stripe and potentially mark `SUCCEEDED`, not escalate — it may indicate a previous attempt actually landed.

---

### Q4 — Single Source of Truth ✅

**Decision**: `RefundStatus` is the source of truth for refund progress. `BookingStatus` is a derived projection. A shared `finalizeRefundSuccess()` function updates both atomically in the same transaction, called from three sites:

1. Synchronous inline refund success
2. Background retry worker success
3. Stripe `charge.refunded` webhook

The function is **idempotent** — first caller that transitions wins, all others are no-ops.

---

### Q5 — Two-Layer Retry Architecture ✅

**Decision**: No BullMQ. Two layers using existing infrastructure:

- **Layer 1 (inline, seconds)**: 1s, 3s, 5s retries — catches transient Stripe blips
- **Layer 2 (cron worker, minutes)**: 1min, 5min, 30min, 2hr — catches persistent outages

Cron interval: `*/1 * * * *`. Sweep includes orphan recovery for `REFUND_PENDING` rows older than 2 minutes (crashed inline attempts).

---

### Q6 — Refund Amount ✅

**Decision**: Straight passthrough of Duffel's cancellation quote `refund_amount`. Platform does not absorb airline penalties — user bears cancellation cost. Store both `airlineRefundAmount` and `customerRefundAmount` on the Refund record.

---

### Q7 — Eligibility Check ✅

**Decision**: Three-layer funnel:

1. **Frontend** (cosmetic): show/hide button based on `cancellationDeadline`
2. **Backend** (enforcement): `booking.cancellationDeadline > NOW()`
3. **Duffel** (final arbiter): `orderCancellations.create()` may still reject

**No hardcoded 24h cutoff**. New fields on Booking model: `cancellationDeadline` (DateTime) and `cancellationRefundable` (Boolean), populated from Duffel fare conditions at booking time.

---

### Q8 — Idempotency Key Safety ✅

**Decision**: All retry attempts reuse the **same** Stripe idempotency key. Retry worker checks key age before every attempt — if older than 22 hours (Stripe keys expire at 24h), force escalation to `REFUND_FAILED_NEEDS_ATTENTION`. No automated code path ever fires a Stripe call with a stale key.

---

### Q9 — Admin Escalation (MVP) ✅

**Decision**: MVP keeps it minimal:

- **Alert**: Structured `Logger.error({ level: 'ALERT' })` (existing pattern)
- **Action**: New admin endpoint to resolve escalated refunds — either "retry with fresh key" or "mark resolved manually"
- **Future**: Dedicated admin dashboard page + email notification system (separate feature)

---

### Q10 — User Communication ✅

**Decision**: Time-aware UI messaging, no notification infra for MVP:

- `CANCELLED_PENDING_REFUND` (healthy): _"Your refund of $X is being processed."_
- `REFUND_FAILED_NEEDS_ATTENTION` (< 48h): _"Refund is taking longer than expected. Our team is reviewing — no action needed."_
- `REFUND_FAILED_NEEDS_ATTENTION` (≥ 48h): _"Refund requires attention. Please contact support."_
- **Future**: Email notifications for escalated refunds and successful refund confirmations.

---

## Artifacts Updated

| Artifact                                                                                           | What changed                                                                                                               |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [CONTEXT.md](file:///c:/Booking%20Systems/CONTEXT.md)                                              | Added `Cancellation Pending`, `Cancellation Deadline`. Refined `Refund Escalation`.                                        |
| [ADR-0001](file:///c:/Booking%20Systems/docs/adr/0001-cancellation-and-refund-failure-handling.md) | Expanded with CAS concurrency, remote-first recovery, error classification, idempotency safety rail, refund amount policy. |

## Full State Machine

```
CONFIRMED
  │
  ├─ CAS claim ──▶ CANCELLATION_PENDING
  │                    │
  │                    ├─ Duffel OK ──▶ CANCELLED_PENDING_REFUND
  │                    │                    │
  │                    │                    ├─ Refund $0 ──▶ CANCELLED_NO_REFUND
  │                    │                    │
  │                    │                    ├─ Stripe OK ──▶ CANCELLED_AND_REFUNDED
  │                    │                    │
  │                    │                    └─ Stripe fail ──▶ [Layer 1 inline retries]
  │                    │                                         │
  │                    │                                         ├─ OK ──▶ CANCELLED_AND_REFUNDED
  │                    │                                         │
  │                    │                                         └─ fail ──▶ [Layer 2 cron retries]
  │                    │                                                       │
  │                    │                                                       ├─ OK ──▶ CANCELLED_AND_REFUNDED
  │                    │                                                       │
  │                    │                                                       └─ exhausted/stale key ──▶ REFUND_FAILED_NEEDS_ATTENTION
  │                    │
  │                    └─ Duffel fail ──▶ CONFIRMED (CAS reverted, user gets error)
```

## Next Steps

- Execute the implementation plan with the refined architecture
- Suggested skills: `/speckit-implement` or `/tdd`
