# Booking Workflow — Grilling Decisions

Grilling session: 2026-07-09. Covers Feature A (Booking Creation & Passenger Collection) of the booking workflow.

---

## Scope

The full booking workflow is split into **3 features**:

| Feature                                         | Scope                                                             | Status                      |
| ----------------------------------------------- | ----------------------------------------------------------------- | --------------------------- |
| **A — Booking Creation & Passenger Collection** | Flight selection → passenger entry → re-pricing → intent creation | **Current focus**           |
| **B — Payment & Confirmation**                  | Stripe payment → PNR creation → ticket issuance → confirmation    | Deferred                    |
| **C — Bookings Management & Post-Booking**      | `/bookings` list, detail, cancellation, refund, status tracking   | Deferred (depends on A + B) |

---

## Decision 1: Server-Side Storage, Not Stateless

**Decision**: Store booking intent data server-side in PostgreSQL.

**Rejected alternative**: Stateless approach (hold data in frontend only).

**Rationale**:

- PII (passport numbers, DOBs, full names) must not live on the client — we need encryption, auditability, and access control server-side.
- Stateless pushes re-validation burden onto Stripe and Duffel APIs unnecessarily.
- Server-side gives us control over data lifecycle, encryption, and cleanup.

---

## Decision 2: Dedicated `BookingIntent` Table (Not the `Booking` Table)

**Decision**: Create a separate `BookingIntent` PostgreSQL table, distinct from the existing `Booking` table.

**Rejected alternative**: Reusing the existing `Booking` table with additional statuses.

**Rationale**:

- The `Booking` table stays clean — every row represents a real, paid booking.
- No `EXPIRED`/`ABANDONED` noise polluting queries, analytics, or the agent gateway's `list_user_bookings` tool.
- Follows the same separation pattern as `FlightOffer` (temporary/cached) vs. `Booking` (permanent).

---

## Decision 3: Two-Phase Cleanup (Soft Expire → Hard Delete)

**Decision**: Abandoned intents go through a two-phase lifecycle:

1. **Phase 1 (Soft expire)**: Cron marks `PENDING` intents older than the TTL as `EXPIRED` (status change only).
2. **Phase 2 (Hard delete)**: A separate/later cron hard-deletes `EXPIRED` rows after a grace period (e.g., 24 hours).

**Rejected alternative**: Direct hard-delete of stale `PENDING` rows.

**Rationale**:

- Eliminates the race condition where a cron deletes an intent at the exact moment a Stripe payment webhook arrives.
- If a payment webhook arrives for an `EXPIRED` intent, the row still exists — we can detect the conflict and handle it gracefully (refund or re-activate).
- No money lost, no missing data. The hard delete only happens after enough time that all in-flight payments have resolved.

---

## Decision 4: Relational Passenger Model (`BookingIntentPassenger`)

**Decision**: Create a separate `BookingIntentPassenger` table with a foreign key to `BookingIntent`.

**Rejected alternative**: Storing passengers as a JSON blob column.

**Rationale**:

- Per-field encryption — reuse the AES-256-GCM pattern from `TravelerProfile` on individual columns (passportNumber, passportExpiry).
- Prisma handles relational models natively with type-safe includes.
- SQL queries on columns are trivial for auditing and debugging.

---

## Decision 5: Validation in Application Layer, Not DB Constraints

**Decision**: Keep passenger fields nullable at the database level. All conditional business rules (e.g., "passport required only for international routes," "infants must have an accompanying adult") are enforced in the NestJS service/DTO validation layer.

**Rejected alternative**: Using `NOT NULL` database constraints.

**Rationale**:

- `NOT NULL` constraints are binary — they cannot express conditional rules like "required only for international flights."
- The database is the storage layer, not the rules engine. Business logic belongs in the application.

---

## Decision 6: Snapshot Copy from TravelerProfile (Pre-Fill)

**Decision**: When creating a booking intent, pre-fill the primary passenger's data from the user's `TravelerProfile` using a **snapshot copy** at creation time.

**How it works**:

1. Backend fetches the user's `TravelerProfile` data.
2. Frontend renders pre-filled fields + empty fields for missing data.
3. User fills only the gaps.
4. Backend creates `BookingIntentPassenger` with a full copy of all data.
5. An optional `travelerProfileId` on the passenger row records the data origin for audit.

**Why snapshot, not live reference**:

- Profile changes after intent creation don't silently alter the booking data.
- When promoted to a real `Booking` (Feature B), all data is already locked in.

---

## Decision 7: GDPR — Explicit Retention/Erasure Lifecycle

**Decision**: `BookingIntentPassenger` rows have their **own** retention/erasure lifecycle, independent from `TravelerProfile`.

**Key constraint**:

- Snapshotting creates a second copy of PII — this copy is subject to its own GDPR erasure obligations.
- Whether completed bookings are exempt as transaction records is a **legal/compliance decision**, not an engineering assumption.
- The system must support cascading PII deletion into intent/booking rows if required by compliance.
- This is flagged as a compliance question, not silently assumed to be solved by the snapshot design.

---

## Decision 8: Companion Profiles — Deferred

**Decision**: Defer the `SavedTraveler` refactor (multiple saved traveler profiles per user) to a separate feature.

**Context**: The current `TravelerProfile` is 1:1 with `User`. To support pre-filling companion passengers (spouse, children), it should become 1:many. The recommended approach is renaming to `SavedTraveler` with a `relationship` field and `isPrimary` boolean.

**Why deferred**: Out of scope for Feature A. Feature A pre-fills only the primary passenger from the existing `TravelerProfile`.

**Why important**: "The system remembers you but never your family" is a bad silent product decision. This feature should be tackled before or alongside Feature B.

---

## Decision 9: Re-Price at Intent Creation

**Decision**: Call Duffel's pricing/confirmation API at the moment the `BookingIntent` is created — not deferred to payment time.

**Rationale**:

- The user should never be surprised by a price change after committing to the flow.
- If the price changed, show it on the review screen before they enter payment.
- The extra latency (one Duffel API call) is acceptable.

**Stored data**: The `BookingIntent` stores a pricing snapshot (confirmed total, currency, per-passenger breakdown, Duffel offer ID, `pricedAt` timestamp).

---

## Decision 10: Staleness Check Before Payment (Feature B Constraint)

**Decision**: Feature B must re-validate pricing before charging, because the pricing snapshot from Feature A can become stale during the TTL window.

**Carried constraint for Feature A**:

- Store a `pricedAt` timestamp in `BookingIntent` so Feature B can calculate staleness.
- Store the Duffel offer ID so Feature B can re-price if needed.

---

## Decision 11: Frontend UX — Deferred to Feature B

**Decision**: The specific UX structure (multi-step wizard, page routing, step flow) is deferred to Feature B's design phase.

**Carried context**: Feature A focuses on backend infrastructure (schema, validation, API endpoints, cron). The frontend booking form design will be addressed when Feature B brings the full end-to-end flow together.

---

## Open Questions (For Future Features)

1. **GDPR compliance**: Does PII deletion cascade into booking intent/booking rows, or are transaction records exempt? (Legal decision.)
2. **SavedTraveler refactor**: When to schedule the companion profiles feature relative to Feature B?
3. **TTL duration**: Exact PENDING → EXPIRED timeout (30 minutes recommended, should be configurable).
4. **Cron frequency**: How often the cleanup job runs (every 5 minutes recommended for Phase 1, daily for Phase 2 hard delete).
