# Grilling Session — Feature 14: Disruption & Flight-Change Management

Stress-tested the disruption detection, supplier synchronization, and flight-change management architecture across 13 high-fidelity design questions before specification.

## Decisions Made

### Q1 — Notification Outbox ✅

**Decision**: Write a durable notification outbox record in the same transaction as the itinerary revision and disruption classification. The future notification service consumes, replays, and marks delivered — never infers disruptions retroactively from itinerary diffs.
**Rationale**: Atomicity guarantee. Zero wasted work now (one table, one `create()` call). Retrofit cost later would be high — the outbox is co-born with the revision model.

---

### Q2 — Itinerary Revision Segment Storage ✅

**Decision**: Normalized `ItineraryRevisionSegment` child table mirroring `FlightSegmentSnapshot` fields, with an explicit `segmentOrder` column. Reuses extraction logic from `mapDuffelOrderToSnapshots` in `duffel.service.ts`.
**Impact**: Purely additive — existing `Booking.flightSnapshot` (booking-time capture) is untouched. `flightSnapshot` = "what did it look like when booked?" `ItineraryRevision` = "what does the supplier say it looks like now?"

---

### Q3 — Disruption Status: Orthogonal Field ✅

**Decision**: `disruptionStatus` is a separate field on `Booking`, not baked into `BookingStatus`. States: `NONE → DETECTED → ACKNOWLEDGED → RESOLVED`.
**Rationale**: Disruption doesn't change the booking lifecycle — a disrupted booking is still `CONFIRMED`. Baking disruption into `BookingStatus` causes combinatorial explosion (`DISRUPTED_CANCELLATION_PENDING`, etc.) and overloads the primary state machine.
**Revision-scoped**: Tied to `activeDisruptionRevisionId` — acknowledgement is per-revision, not per-booking.
**Resolution metadata**: `resolvedReason` (TRAVELLER_ACCEPTED | DEPARTURE_PASSED | ADMIN_RESOLVED | BOOKING_CANCELLED), `resolvedAt`, `resolvedBy` (traveller/system/admin).

---

### Q4 — Sync Pipeline Concurrency: Two-Layer Guard ✅

**Decision**: CAS (compare-and-swap) as primary concurrency control, UNIQUE constraint as fallback.

- **Primary**: `UPDATE booking SET syncLockedAt = NOW() WHERE id = ? AND (syncLockedAt IS NULL OR syncLockedAt < NOW() - INTERVAL '5 minutes')` — first caller wins, stale locks self-expire.
- **Fallback**: `UNIQUE(booking_id, version)` on `ItineraryRevision` — database rejects the second insert if two pipelines race past the CAS. Whichever transaction commits first wins; the loser catches the unique violation and exits cleanly.
  **Rationale**: CAS prevents 99.9% of races. The unique constraint is defense-in-depth — the database is the arbiter, not application logic.

---

### Q5 — Diff Baseline: Both Previous Revision and Original Snapshot ✅

**Decision**: Diff against both baselines, each serving a distinct purpose:

- **Previous revision → current**: Incremental diff — drives notifications ("your flight just moved 2.5 hours")
- **Original `flightSnapshot` → current**: Cumulative diff — drives dashboard summaries ("this booking has drifted 3.5 hours total from the original")

**Critical design rule**: All detected changes are stored as revisions (see Q6). This guarantees the "previous revision" baseline always exists — no gaps from sub-material changes being discarded.

---

### Q6 — Store All Revisions, Flag Materiality ✅

**Decision**: Persist every detected supplier change as an `ItineraryRevision`, regardless of materiality. Materiality is a classification flag on the revision (`isMaterial: boolean`), not a write gate.

- Notification outbox records are only created for material revisions
- Complete audit trail — no intermediate states lost
- Eliminates the gap where two sub-material changes that are cumulatively material would have no previous revision to diff against
  **Storage cost**: Negligible — a booking accumulates 2–5 revisions over its lifetime at most.

---

### Q7 — Notification Throttle ✅

**Decision**: 3 material notifications per booking per day, with stabilization messaging.

- Notifications 1–2: Normal outbox writes
- Notification 3 (last before throttle): Carries a stabilization warning — "Your airline is making frequent changes. We'll consolidate further updates and notify you when the schedule stabilises."
- Beyond 3: No further outbox records. Booking flagged for manual admin review.
- Revisions and materiality classification continue unconditionally regardless of throttle.
  **Rationale**: Prevents notification fatigue from airlines making frequent schedule adjustments. The problem is the airline's, not the system's — but the UX impact is ours to manage.

---

### Q8 — Materiality Classification Rules ✅

**Decision**: Deterministic ruleset with asymmetric delay thresholds.

**Binary rules (always material):**
| Change Type | Reason |
|---|---|
| Segment removed / cancelled | Traveller may no longer have transport |
| New segment added as replacement | Itinerary structure changed |
| Departure airport changed | Traveller may go to wrong airport |
| Arrival airport changed | Destination logistics changed |
| Connection time below MCT (60 min) | Itinerary may be impossible |
| Segment date changes | Different travel day |
| Overnight connection introduced | Hotel / visa / transport impact |
| Final destination arrival large shift | Traveller's downstream plans affected |

**Threshold rules (system-wide constants):**
| Change Type | Threshold |
|---|---|
| Departure moved earlier | > 1 hour (stricter — traveller might miss flight) |
| Departure moved later | > 2 hours (aligns with EU261 standard) |
| Final destination arrival shifted | Same thresholds (>1h earlier / >2h later) |

**MCT**: 60 minutes system-wide constant. Not airport-specific — a single global floor. Sufficient for a disruption detector; airport-specific MCTs can be promoted from a constant to a config table if needed later.

---

### Q9 — Duffel Webhook Inbox (C-lite) ✅

**Decision**: Lightweight transactional inbox pattern — not fire-and-forget, not a heavy queue.

1. Verify Duffel webhook signature
2. Insert durable `DuffelWebhookEvent` record (event ID, order ID, event type, status, attempts, raw payload)
3. Return `200 OK` immediately
4. `DuffelEventProcessor` polls pending events in small batches and runs the sync pipeline

**Failure handling**: Exponential backoff retries (1m, 5m, 15m). After 5 failures → `FAILED_NEEDS_ATTENTION`.

**Rationale**: Fire-and-forget (Option A) has a reliability gap — process crash after ACK but before pipeline completion loses the event. The reconciliation cron would catch it in ≤30 minutes, but for a flight departing in 2 hours, that delay is costly. C-lite closes this gap with one small table. The pattern mirrors the existing Stripe webhook infrastructure — same shape, different supplier.

---

### Q10 — Reconciliation Cron: Backup Only ✅

**Decision**: Duffel webhooks are the primary sync trigger. The reconciliation cron is backup-only.

- **Frequency**: Every 30 minutes
- **Scope**: `CONFIRMED` bookings with `departureAt` within 72 hours
- **Ordering**: `ORDER BY lastDuffelSyncedAt ASC, departureAt ASC` — stalest-then-soonest priority
- **Batch size**: 20 bookings per run (cursor-based)
- **New field**: `lastDuffelSyncedAt` on Booking — updated by both webhook-triggered and cron-triggered syncs
- **Failure handling**: Implicit retry — `lastDuffelSyncedAt` not updated on failure, booking stays at top of priority queue

---

### Q11 — Confidence-Based Segment Matching ✅

**Decision**: Cascade matching strategy for the diff engine:

1. **Primary**: Stable Duffel segment ID (requires adding `seg.id` to `mapDuffelOrderToSnapshots` extraction — currently dropped)
2. **Secondary**: Carrier + flightNumber + departureDate (optionally + departure airport)
3. **Fallback**: Origin + destination IATA pair + departureDate + time proximity
4. **Position-based**: Weak tie-breaker only, never a normal fallback
5. Unmatched old segments → `removed`. Unmatched new segments → `added`.
6. Itinerary-level patterns (e.g., `ROUTING_CHANGED`, `SEGMENT_REPLACED_BY_CONNECTION`) derived from aggregate segment-level diff results.

**Rationale**: Position-based matching breaks when airlines insert or remove segments — it causes cascading false diffs. The confidence cascade handles the common case (flight number preserved) and the edge case (rerouted with new flight number).

---

### Q12 — Cancellation × Disruption Interaction ✅

**Decision**: Three rules:

1. **Traveller CAN cancel during a disruption** — cancellation is the traveller's right within the deadline, independent of disruption status.
2. **Cancellation auto-resolves disruption** — `disruptionStatus = RESOLVED`, `resolvedReason = BOOKING_CANCELLED`, `resolvedAt = now`, `resolvedBy = traveller/system`. A cancelled booking has no itinerary to disrupt.
3. **Disruption does NOT affect cancellation deadline** — deferred to a future feature. Feature 14 detects and surfaces disruptions; it does not alter cancellation economics.

---

### Q13 — Sync Pipeline Failure Handling ✅

**Decision**: Two mechanisms, both self-healing:

- **Webhook-triggered**: Dedicated retry tracking via `DuffelWebhookEvent` record (exponential backoff: 1m, 5m, 15m; escalate after 5 failures)
- **Cron-triggered**: Implicit retry via staleness priority ordering (`lastDuffelSyncedAt ASC` keeps failed bookings at the top)

No manual intervention needed for transient failures. Only persistent failures (5+ attempts) escalate to admin attention.

---

## Disruption Status State Machine

```
NONE
  │
  └─ Material revision persisted ──▶ DETECTED
                                        │
                                        ├─ Traveller clicks "I understand" ──▶ ACKNOWLEDGED
                                        │                                        │
                                        │                                        ├─ Traveller accepts changes ──▶ RESOLVED (TRAVELLER_ACCEPTED)
                                        │                                        │
                                        │                                        ├─ Departure passes ──▶ RESOLVED (DEPARTURE_PASSED)
                                        │                                        │
                                        │                                        ├─ Booking cancelled ──▶ RESOLVED (BOOKING_CANCELLED)
                                        │                                        │
                                        │                                        └─ Admin resolves ──▶ RESOLVED (ADMIN_RESOLVED)
                                        │
                                        ├─ Departure passes ──▶ RESOLVED (DEPARTURE_PASSED)
                                        │
                                        └─ Booking cancelled ──▶ RESOLVED (BOOKING_CANCELLED)

RESOLVED
  │
  └─ New material revision arrives ──▶ DETECTED (cycle resets with new activeDisruptionRevisionId)
```

## Sync Pipeline Architecture

```
                    ┌──────────────┐
                    │ Duffel fires │
                    │   webhook    │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Verify sig  │
                    │  Insert row  │◄──── DuffelWebhookEvent (inbox)
                    │  Return 200  │
                    └──────┬───────┘
                           │
              ┌────────────▼────────────┐
              │  DuffelEventProcessor   │
              │  (polls pending events) │
              └────────────┬────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │           Supplier Sync Pipeline            │
    │                                             │
    │  1. CAS claim (syncLockedAt)                │
    │  2. Fetch Duffel order (authoritative)      │
    │  3. Cascade segment matching                │
    │  4. Diff against previous rev + original    │
    │  5. Persist ItineraryRevision + segments    │◄── UNIQUE(booking_id, version) fallback
    │  6. Classify materiality                    │
    │  7. Update disruptionStatus                 │
    │  8. Write notification outbox (if material) │◄── Throttle check (3/day)
    │  9. Update lastDuffelSyncedAt               │
    │  10. Release sync claim                     │
    └─────────────────────────────────────────────┘
                           ▲
              ┌────────────┘
              │
    ┌─────────┴──────────┐
    │ Reconciliation     │
    │ Cron (every 30min) │──── Backup trigger, same pipeline
    │ 72h window, 20/run │
    └────────────────────┘
```

## Feature 14 Scope Boundary

### In Scope

| Layer                         | Deliverable                                                                                                                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schema**                    | `ItineraryRevision`, `ItineraryRevisionSegment`, `DuffelWebhookEvent`, `NotificationOutbox` tables. New fields on `Booking`: `disruptionStatus`, `activeDisruptionRevisionId`, `syncLockedAt`, `lastDuffelSyncedAt`, `resolvedReason`, `resolvedAt`, `resolvedBy` |
| **Backend — Webhook**         | `DuffelWebhookController` (signature verify, fast-ack, inbox write)                                                                                                                                                                                               |
| **Backend — Processor**       | `DuffelEventProcessor` (polls inbox, runs sync pipeline)                                                                                                                                                                                                          |
| **Backend — Sync Pipeline**   | CAS claim → Duffel order fetch → segment matching → diff → persist revision → classify materiality → disruption status transition → notification outbox write (with throttle)                                                                                     |
| **Backend — Reconciliation**  | Reconciliation cron (30min, 72h window, batched, priority-ordered)                                                                                                                                                                                                |
| **Backend — Disruption API**  | Endpoints: acknowledge disruption, accept changes (resolve), disruption history                                                                                                                                                                                   |
| **Frontend — Booking Detail** | Disruption banner with acknowledge/accept buttons, revision history view                                                                                                                                                                                          |
| **Admin — Dashboard**         | Disruption monitoring (throttle-flagged bookings, failed events, manual resolve)                                                                                                                                                                                  |

### Deferred

| Item                                   | Reason                                           |
| -------------------------------------- | ------------------------------------------------ |
| Notification delivery (email/SMS/push) | Future feature consumes outbox                   |
| Cancellation deadline recalculation    | Separate feature with its own edge cases         |
| Customer-initiated flight changes      | Different Duffel API surface (voluntary changes) |
| Automatic rebooking suggestions        | Requires voluntary change API                    |

## Artifacts Updated

| Artifact                                              | What changed                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [CONTEXT.md](file:///c:/Booking%20Systems/CONTEXT.md) | Added: Reconciliation Cron, Duffel Webhook Inbox, Segment Matching, MCT, Notification Outbox, Disruption Status, Sync Claim, Notification Throttle. Updated: Supplier Synchronization (webhook-primary), Material Disruption (full ruleset with thresholds). |

## Next Steps

- **`/speckit-specify`** — Convert these decisions into a formal Feature 14 specification
- **`/speckit-plan`** — Generate the implementation plan from the specification
- **`/speckit-tasks`** — Break the plan into dependency-ordered tasks
