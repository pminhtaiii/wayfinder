# Booking Management & Confirmation — Grilling Decisions

**Date**: 2026-07-18 | **Feature**: 11 (Bookings Management & Confirmation)
**Participants**: User + AI | **Questions Resolved**: 16

---

## Decision 1: Feature Split Strategy

**Decision**: Split into **2 features**, not 3.

| Feature    | Scope                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------- |
| Feature 11 | Bookings Management (list page + detail page with confirmation/failure/processing states) |
| Feature 12 | E-Ticket PDF Generation & Delivery                                                        |

**Rationale**: Originally proposed 3 features (Confirmation + PDF + Management), but the confirmation page and booking detail page show identical data. Merging them eliminates redundant engineering. E-Ticket PDF remains separate because PDF rendering/storage is a self-contained technical concern.

**Alternatives rejected**: Single monolithic feature (too large), 3-feature split (confirmation page redundant with detail page).

---

## Decision 2: Confirmation Page Eliminated

**Decision**: No separate post-payment confirmation page. The booking detail page at `/bookings/[bookingId]?confirmed=true` renders a success state with celebration UI when the `confirmed` query param is present.

**Behavior**:

- `?confirmed=true` → Success banner, PNR prominently highlighted, "save this" callout
- Subsequent visits (no param) → Normal booking detail view

**Rationale**: The data is identical. A separate page is redundant engineering. Production systems (United, Delta, Booking.com) use this pattern.

---

## Decision 3: Failure Handling — Stage-Dependent

**Decision**: Failures surface at the point they occur, not in one place.

| Failure Stage                                                     | Where It Surfaces                      | UX                                                               |
| ----------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| Card declined (Stripe Elements)                                   | Inline on checkout page                | "Payment declined — try a different card." Retry without leaving |
| Pipeline failure (Duffel timeout, offer expired, capture failure) | Booking detail page with failure state | Error explanation + context-aware retry button                   |
| Async failures (webhook disputes)                                 | Deferred to notification feature       | Booking detail reflects DB status                                |

**Key rule**: Card declines NEVER reach the bookings table. They're handled inline on checkout before the Booking record exists.

---

## Decision 4: Processing State — Approach A (Synchronous + Loading Animation)

**Decision**: Approach A — synchronous pipeline with a polished 4-phase loading escalation on the checkout page. No SSE, no Redis Pub/Sub, no background jobs.

**Alternatives evaluated**:

- **Approach B (Fully async + SSE)**: Rejected — requires BullMQ job queue, background workers, async idempotency handling. Too much infrastructure change to the payment pipeline.
- **Approach C (Synchronous + parallel SSE via EventEmitter2)**: Rejected — EventEmitter2 is in-memory, so POST and SSE connections must hit the same process. Silently degrades on multi-replica deployments with no error signal. Swapping to Redis Pub/Sub closes the gap but reduces the simplicity advantage over Approach A.

**Design for upgrade**: Build the checkout loading component with named steps (`AUTHORIZING → RESERVING → FINALIZING → CONFIRMED`) so a future SSE upgrade only swaps triggers from timed transitions to real events.

---

## Decision 5: 4-Phase Checkout Loading Escalation

**Decision**: The checkout page handles long-running pipelines with escalating UX:

| Phase   | Timing | Behavior                                                      |
| ------- | ------ | ------------------------------------------------------------- |
| Phase 1 | 0–10s  | Confident animated stepper with timed transitions             |
| Phase 2 | 10–20s | Animation slows, reassurance message appears                  |
| Phase 3 | 20s+   | "Check My Bookings" escape hatch link appears                 |
| Phase 4 | 45s+   | Client-side timeout, auto-redirect to `/bookings/[bookingId]` |

**Key guarantees**:

- Confirm button disabled immediately on click (prevents double-submit)
- `beforeunload` warns user about leaving
- Server pipeline runs to completion regardless of client state

---

## Decision 6: Data Model — Promote BookingIntent → Booking

**Decision**: Create a new `Booking` record at the **start** of `POST /payments/confirm`, not at `/payments/create`.

**Why not at `/payments/create`**: Cart abandonment in travel is 60–80%. Creating Booking records for users who open the payment page but never pay floods the table with orphaned `PROCESSING` records — recreating the exact problem `BookingIntent` with TTL cleanup was designed to solve.

**Why at `/payments/confirm`**: The user has entered card details and clicked confirm through Stripe Elements. Card is validated and authorized. This is genuine commitment.

**BookingIntent lifecycle**: Remains as a transient pre-payment entity with TTL-based cron cleanup. The Booking links back to it via `bookingIntentId` for audit trail.

---

## Decision 7: Client-Generated UUID for Booking ID

**Decision**: The client generates a UUID v4 and sends it with the confirm request. The server uses it as the Booking primary key.

**Why**: In Approach A, the `/payments/confirm` response doesn't arrive until the pipeline finishes. The escape hatch (Phase 3/4 of the loading escalation) needs a concrete `/bookings/[bookingId]` URL before the response arrives. Client-generated UUID gives the client the ID before the HTTP request even fires.

**Server-side validation (mandatory)**:

```
Receive bookingId from client
  → Validate format (reject if not valid UUID v4)
  → SELECT id, userId FROM bookings WHERE id = bookingId
    → EXISTS + different userId  → 403 Forbidden
    → EXISTS + same userId       → Idempotency replay
    → NOT EXISTS                 → Try INSERT Booking(id, userId, status: PROCESSING)
                                     → ON UNIQUE PK CONFLICT (concurrency race)
                                       → SELECT again and proceed with Idempotency replay / 403 checks
```

**Concurrency (TOCTOU) and Idempotency Safety**:
To prevent race conditions where concurrent double-tapped requests both pass the `NOT EXISTS` check before either inserts, the database-level unique primary key constraint on `Booking.id` MUST be the final authority:

- Wrap the SELECT-then-INSERT in a transaction (or use Prisma's `upsert` / native upsert query).
- Catch any unique constraint violation error (e.g., Prisma error code `P2002` for primary key collision).
- If a collision occurs, gracefully fall back to checking the record again for ownership and executing an idempotency replay, rather than returning a 500 error.

**Security concern addressed**: Without validation, a malicious user could inject another user's bookingId and corrupt their booking. The ownership check prevents this.

**Alternatives rejected**:

- Two-phase confirm (init + execute) — two HTTP requests, more complex idempotency
- Escape hatch uses BookingIntentId — indirect lookup, messy URL

---

## Decision 8: Two Tabs Only (Upcoming / Past)

**Decision**: My Bookings page shows only **Upcoming** and **Past** tabs. No Cancelled tab.

**Rationale**: Cancellation actions are out of scope for Feature 11. An empty or disabled Cancelled tab raises more questions than it answers. Adding a third tab when cancellation ships is a one-line change.

---

## Decision 9: Failed Bookings Visible with Context-Aware Retry

**Decision**: Failed bookings appear in the Upcoming tab with a "Failed" badge and context-aware retry action.

### Failure Categories and Retry Routing

| Failure Category  | Internal Cause                   | User-Facing Message                                                        | Retry Destination                                   |
| ----------------- | -------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `OFFER_EXPIRED`   | Duffel offer unavailable         | "This flight offer has expired. Prices and availability may have changed." | Search results (same route pre-filled)              |
| `PRICE_CHANGED`   | Duffel re-pricing mismatch       | "The price for this flight has changed since your search."                 | Flight detail page (see new price)                  |
| `BOOKING_TIMEOUT` | Duffel 30s PNR timeout           | "We couldn't confirm your reservation in time."                            | Flight detail page (re-verify availability)         |
| `CAPTURE_FAILED`  | Stripe capture failure after PNR | "Something went wrong finalizing your payment."                            | Contact support (PNR exists, money state ambiguous) |
| `SYSTEM_ERROR`    | Unexpected exception             | "Something went wrong on our end."                                         | Flight detail page (fresh attempt)                  |

### Critical Design Rules

1. **`PAYMENT_DECLINED` is NOT a booking failure category.** Card declines are handled inline on the checkout page (Decision 3). By the time the Booking record is created, the card has already been authorized via Stripe Elements.

2. **`failureReason` and charge status are independent concerns:**
   - `Booking.failureReason` → determines which retry button to render
   - `Payment.status` (live DB read at render time) → determines the charge message
   - Never derive "was the user charged?" from the failure category — always read the actual payment state

3. **Retry routes to search/flight detail** (not checkout) because the underlying cause (expired offer, price change) means re-entering the pipeline with stale data will fail again. The user needs to re-confirm pricing first.

---

## Decision 10: Cancellation Actions Deferred

**Decision**: Feature 11 is **read-only**. No cancel button, no refund request flow. Deferred to a dedicated Cancellation & Refund feature.

**Rationale**: The Stripe refund backend (Feature 10, Phase 8) is still being built. Adding cancellation UI to Feature 11 makes it too large. The cancellation flow has its own complexity: policy rules, confirmation modals, refund orchestration, status tracking.

---

## Decision 11: Email Notifications Deferred

**Decision**: No email confirmation in Feature 11. Deferred to a dedicated Notification feature.

**Rationale**: Email infrastructure is horizontal — it serves booking confirmations, cancellation receipts, price alerts, flight status changes, password resets. Building it piecemeal means building it twice. A dedicated feature can build provider integration, template engine, delivery queue, and retry logic once.

For Feature 11, the on-screen confirmation with success banner and PNR display is sufficient.

---

## Decision 12: Flight Data — Snapshot at Booking Time

**Decision**: Store complete flight details as a snapshot on the Booking record during PNR creation. The booking detail page reads entirely from the local database — zero Duffel API calls at render time.

**Rationale**: A confirmed booking is a historical record. Flight details at purchase time are contractual facts. Gate changes and real-time tracking are a different concern (AviationStack, future feature).

**Alternatives rejected**:

- Fetch from Duffel on demand — breaks if Duffel is down, counts against rate limits, slower page loads
- Snapshot + optional refresh — most complex, mixes concerns. Deferred as a future enhancement.

---

## Decision 13: Checkout Escalation Ownership

**Decision**: The 4-phase checkout loading escalation belongs in **Feature 11**, not Feature 10.

**Rationale**: The escalation depends on Feature 11 infrastructure — the `Booking(PROCESSING)` record and the `/bookings/[bookingId]` detail page. Phases 3–4 (escape hatch + redirect) literally cannot work until that page exists. Feature 10 stays focused on the payment pipeline; Feature 11 handles the post-payment experience.

---

## Summary of Deferred Items

| Item                                 | Deferred To                                        |
| ------------------------------------ | -------------------------------------------------- |
| Cancellation & refund UI             | Dedicated Cancellation feature                     |
| Email/SMS notifications              | Dedicated Notification feature                     |
| Real-time SSE progress               | Future SSE upgrade (Approach C with Redis Pub/Sub) |
| Flight data refresh from Duffel      | Future enhancement                                 |
| Cancelled tab on My Bookings         | Ships with Cancellation feature                    |
| AviationStack flight status tracking | Dedicated Flight Status feature                    |
