# Product Requirements Document: Disruption & Flight-Change Management

**Feature:** 014 — Disruption & Flight-Change Management
**Status:** Planned
**Related plan:** [plan.md](./plan.md)
**Decision record:** [Feature 14 grilling session](../../docs/adr/0021-disruption-flight-change.md)

## Problem Statement

Travellers currently see only the itinerary captured when a booking was made. If an airline later moves, removes, replaces, or reroutes a flight, the platform has no reliable way to ingest that change, distinguish a minor update from a material disruption, show the supplier-authoritative itinerary, or let the traveller record that they understand and accept it. Missed or duplicated supplier events can therefore leave the booking page stale and operations staff unaware of customers who need help.

## Solution

Build a deterministic supplier synchronization capability around confirmed Duffel orders. Signed Duffel webhooks are durably accepted into an inbox and processed asynchronously; a budget-aware reconciliation job catches missed events. Both triggers call one idempotent synchronization pipeline that fetches the authoritative order, creates immutable itinerary revisions only for genuine changes, compares the latest state with both the preceding revision and the original booking snapshot, classifies material disruptions, transitions a revision-scoped disruption lifecycle, and atomically writes a notification outbox request.

The booking experience shows the current supplier itinerary, the cumulative change from the original booking, a material-disruption banner, and a local history. Travellers can acknowledge or accept only the active revision. Operations staff can inspect failed events, throttled notifications, aged disruptions, and data-quality gaps. Notification delivery, voluntary flight changes, and automatic rebooking remain separate features.

## User Stories

1. As a traveller, I want airline-initiated changes to reach my booking reliably, so that I do not rely on stale flight details.
2. As a traveller, I want repeated delivery of the same supplier event to be harmless, so that I do not see duplicate changes or alerts.
3. As a traveller, I want the platform to verify that a webhook came from Duffel, so that an attacker cannot alter my disruption state.
4. As a traveller, I want the webhook receiver to acknowledge valid events quickly, so that provider retries do not amplify an outage.
5. As a traveller, I want the platform to fetch the current Duffel order after an event, so that the event payload itself is never mistaken for the authoritative itinerary.
6. As a traveller, I want missed webhooks to be caught before departure, so that supplier delivery problems do not hide a disruption.
7. As a traveller on a round trip, I want return-leg changes monitored after my outbound departure, so that the booking is not considered complete too early.
8. As a traveller, I want unchanged supplier reads to create no revision, so that my history contains meaningful changes rather than polling noise.
9. As a traveller, I want every genuine supplier change retained, including minor changes, so that the itinerary has a complete audit trail.
10. As a traveller, I want segment insertions and removals matched without position-based cascades, so that reroutes are described accurately.
11. As a traveller, I want a moved flight to be compared with the immediately preceding itinerary, so that I can understand what just changed.
12. As a traveller, I want the latest itinerary compared with what I originally booked, so that accumulated drift is visible.
13. As a traveller, I want repeated small changes to become material when their cumulative effect crosses a threshold, so that disruption detection cannot be evaded by gradual movement.
14. As a traveller, I want earlier departures treated more strictly than later departures, so that a change likely to make me miss a flight is surfaced promptly.
15. As a connecting traveller, I want removed segments, airport/date changes, overnight connections, and connections below the 60-minute minimum to be material, so that structurally unsafe itineraries demand attention.
16. As a traveller, I want exact threshold boundaries applied consistently, so that the same itinerary always receives the same classification.
17. As a traveller, I want my booking detail page to show the latest supplier-authoritative itinerary while retaining the original itinerary for comparison, so that an alert never accompanies stale “current” times.
18. As a traveller, I want a prominent banner for the active material revision, so that I know action is required.
19. As a traveller, I want to acknowledge that I understand the active disruption, so that the platform records my awareness without claiming I accepted the itinerary.
20. As a traveller, I want to accept the active itinerary locally, so that the disruption can be resolved without invoking a supplier change operation.
21. As a traveller, I want stale acknowledgement or acceptance clicks rejected when a newer material revision exists, so that I cannot accidentally resolve a change I have not reviewed.
22. As a traveller, I want acknowledgement and acceptance retries for the same active revision to be idempotent, so that refreshes and duplicate clicks remain safe.
23. As a traveller, I want a newest-first paginated revision history, so that I can review changes without exposing raw supplier payloads or passenger data.
24. As a traveller, I want a new material revision to reopen a previously resolved disruption, so that every new significant change receives attention.
25. As a traveller, I want minor revisions to remain in history without clearing an unresolved material disruption, so that small updates do not hide a larger outstanding issue.
26. As a traveller, I want cancellation eligibility and deadlines to remain independent of disruption status, so that the new feature does not change my existing cancellation rights.
27. As a traveller who cancels, I want supplier-confirmed cancellation to resolve the active disruption atomically, so that a cancelled itinerary cannot remain marked as disrupted.
28. As a traveller, I want synchronization racing with cancellation to converge without a post-cancellation revision or notification, so that cancelled bookings stay terminal.
29. As a traveller, I want at most three material notification requests per booking per UTC day, so that unstable airline schedules do not create notification fatigue.
30. As a traveller, I want the third daily notification request marked with a stabilization warning, so that I understand further alerts may be suppressed for review.
31. As a traveller, I want later material revisions still persisted and shown when notifications are throttled, so that throttling never hides the authoritative state.
32. As an operations agent, I want bookings with suppressed notifications flagged independently of traveller disruption status, so that I can investigate unstable itineraries.
33. As an operations agent, I want terminal Duffel inbox failures visible with safe diagnostics and correlation identifiers, so that I can retry or escalate them.
34. As an operations agent, I want to resolve an active disruption with a required reason and audit note, so that manual intervention is attributable.
35. As an operations agent, I want data-quality gaps such as missing Duffel order IDs or snapshots reported, so that legacy bookings excluded from synchronization are not silent.
36. As an operations engineer, I want structured PII-safe logs, metrics, traces, dashboards, and alerts for webhook receipt, inbox backlog, synchronization, classification, notification suppression, and aged disruptions, so that failures can be diagnosed without redeploying.
37. As an operations engineer, I want the reconciliation job to respect Duffel API budget and prioritize near, stale departures without starving other eligible bookings, so that backup synchronization does not impair booking traffic.
38. As an operations engineer, I want workers and cron triggers to be safe across multiple application instances, so that deployment topology cannot duplicate work.
39. As a product owner, I want ingestion, processing, reconciliation, customer surfacing, and outbox creation independently feature-flagged, so that rollout and rollback are controlled.
40. As a product owner, I want existing eligible bookings bootstrapped without immediately sending unreviewed historical alerts, so that launch does not surprise travellers.

## Implementation Decisions

- All disruption decisions remain deterministic. AI does not ingest, classify, acknowledge, accept, resolve, or notify about supplier changes.
- The clean working tree does not currently contain the booking detail/list, admin refund UI, or Playwright configuration that project status documents mark complete. Feature 14 therefore begins with a verification gate and restores the minimum protected booking-detail/list and test foundation before disruption UI is added; the work must not assume those components exist.
- A dedicated disruption domain module owns webhook verification, the durable inbox, event processing, supplier synchronization, segment matching, diffing, classification, reconciliation, traveller disruption APIs, and admin operations. Existing booking services integrate with it at read and cancellation/completion boundaries.
- The public Duffel receiver verifies `X-Duffel-Signature` against the raw request bytes with the configured webhook secret and a timestamp replay tolerance. A verified event is inserted before returning success; duplicate deliveries return success without duplicate work. Unsupported verified event types are durably marked skipped.
- The supported initial supplier event is `order.airline_initiated_change_detected`. Duffel event ID is the delivery deduplication key; the order ID is validated from the event object and mapped to one booking.
- The inbox uses atomically claimed leases and the lifecycle `PENDING → PROCESSING → PROCESSED`, with `RETRY_SCHEDULED`, `SKIPPED`, and `FAILED_NEEDS_ATTENTION` terminal/side states. Transient failures retry after 1, 5, 15, and 15 minutes; the fifth failed attempt escalates. A crashed processing lease is reclaimable.
- Webhook processing and scheduled reconciliation converge on one supplier synchronization command. Supplier event and cron rows are triggers only; the fresh Duffel order is authoritative.
- A booking synchronization claim uses compare-and-swap with an owner/token and a five-minute lease. The Duffel request timeout must remain shorter than the lease. Release is conditional on the same owner/token so an expired worker cannot clear a successor’s claim.
- Synchronization rechecks booking eligibility in the final transaction. A booking no longer confirmed or already supplier-cancelled cannot receive a new revision, disruption transition, or outbox write.
- The original booking snapshot remains immutable. New bookings retain optional Duffel segment IDs in that snapshot; legacy snapshots continue through fallback matching.
- A canonical itinerary fingerprint makes unchanged supplier reads idempotent. A successful unchanged read updates synchronization coverage without creating a revision.
- Every changed itinerary is stored as an immutable revision with normalized ordered segments, source/event correlation, fingerprint, incremental and cumulative structured diffs, match method/confidence, material reasons, triggering baseline, and classifier ruleset version.
- Segment matching is one-to-one: stable Duffel segment ID; carrier + flight number + local departure date + origin; origin/destination + local date + nearest departure within six hours; segment order only as a final tie-breaker. Ambiguous low-confidence candidates remain removed/added.
- Materiality is true when either the incremental diff or the cumulative original-to-current diff triggers a rule. Strict boundaries are more than 60 minutes earlier and more than 120 minutes later; equality is non-material. Binary rules cover removed/added segments, airport or local-date changes, newly introduced overnight connections, and consecutive same-journey connections below 60 minutes.
- Round-trip slices are evaluated as separate journeys. Final-arrival thresholds apply to the final destination of each slice, not between unrelated outbound and return segments.
- Disruption lifecycle is orthogonal to booking status: `NONE → DETECTED → ACKNOWLEDGED → RESOLVED`. A new material revision sets the active revision, resets to `DETECTED`, and clears resolution metadata. A non-material revision does not replace an unresolved active material revision.
- Acknowledge and accept commands carry the active revision ID. Same-revision replays are idempotent; stale revisions return conflict with the canonical active state. Acceptance is a local `TRAVELLER_ACCEPTED` resolution and performs no Duffel mutation.
- Supplier-confirmed cancellation resolves disruption as `BOOKING_CANCELLED` in the existing atomic cancellation transition. Departure/final-arrival passage resolves unresolved disruptions as `DEPARTURE_PASSED`; admin resolution records the authenticated administrator and a required safe note.
- The booking detail read model returns the latest current itinerary plus original/cumulative comparison and an active disruption summary. List reads return a compact disruption badge. All reads are local database reads and do not call Duffel.
- Initial page reads are server-rendered and uncached; acknowledge/accept mutations refresh the canonical server state. Live browser push/SSE is not introduced in Feature 14.
- A notification outbox row is written in the same transaction as a material revision and disruption transition. One row per revision is allowed. No recipient PII is copied; the future delivery service resolves recipients later. Delivery is out of scope.
- The daily throttle uses UTC and an atomic same-booking count. Rows 1–2 are normal, row 3 has a stabilization flag, and row 4+ is suppressed while the booking receives an independent operations-attention reason/timestamp. Suppression never blocks persistence or state transition.
- Reconciliation runs every 30 minutes, processes at most 20 eligible bookings per run, prioritizes unsynchronized/stalest and then the next unflown departure, and uses stable keyset ordering. It includes confirmed round trips until their final segment has arrived. Failed work remains eligible without permanently starving the rest of the window.
- The reconciliation worker consumes the existing Duffel budget/rate telemetry, yields to transaction-critical traffic, and stops safely when its allocated budget is unavailable.
- Raw webhook payload is access-restricted, encrypted at rest through existing database controls, never logged or exposed via APIs, and removed/redacted after 30 days. Itinerary revisions and state-transition audit records follow booking/audit retention. Outbox rows remain until the future delivery contract defines archival.
- Rollout is additive: migrate and deploy dormant read/write support; configure/register the webhook; enable ingestion; canary the processor; generate a data-quality/bootstrap report; enable reconciliation; enable customer/admin UI; enable outbox creation last. Existing-booking bootstrap persists revisions but suppresses customer notification until explicitly enabled.

## Testing Decisions

Tests assert externally observable behavior and durable state. The primary seams are intentionally few and high-level:

- The webhook HTTP seam verifies raw-body signature behavior, durable insert-before-ack, duplicate and unsupported events, response latency, and absence of raw/PII logging.
- The supplier synchronization command runs against a real test database and a deterministic Duffel adapter stub. It covers unchanged payloads, legacy snapshots, every matching tier, ambiguity, incremental and cumulative materiality, threshold boundaries, multiple slices, atomic revision/status/outbox writes, cancellation races, lock expiry, concurrent webhook/cron triggers, and crash recovery.
- Traveller and admin REST seams cover ownership and RBAC, local current-itinerary/history reads, paging, active-revision compare-and-swap, idempotent replay, stale conflicts, retry/manual resolution, and audit records.
- The reconciliation handler is invoked directly in API E2E tests with the scheduler stopped. Tests verify eligibility, next-unflown coverage, ordering, batch/fairness, failure staleness, and budget degradation.
- Playwright tests use seeded booking/revision states and the real local API to verify current itinerary rendering, disruption banner, acknowledge/accept, stale revision refresh, new-revision reset, history, throttle messaging, cancellation auto-resolution, and admin monitoring.
- Supporting table-driven and property tests cover the pure matcher/classifier, time zones, DST, strict thresholds, MCT, overnight connections, round trips, and stable fingerprints. Redacted Duffel contract fixtures detect payload/SDK drift.
- Migration verification starts from the current Feature 12 schema and representative legacy snapshots. Existing backend E2E, Playwright, type checking, linting, and builds remain green.

## Out of Scope

- Email, SMS, push, or in-app notification delivery; Feature 14 only creates durable outbox requests.
- Customer-initiated voluntary flight changes, Duffel order-change confirmation, automatic rebooking, or alternative-flight recommendations.
- Changing or extending fare-specific cancellation deadlines because a disruption occurred.
- Airline compensation eligibility, EU261 claims, hotel/meal assistance, or travel-insurance workflows.
- Airport-specific minimum connection time data; Feature 14 uses the approved system-wide 60-minute floor.
- AI classification or AI-generated transactional decisions.

## Further Notes

- The third notification copy must state that further notification requests may be held for review; it must not promise a digest or consolidation service that this feature does not implement.
- The current booking completion sweeper must be corrected to use the final itinerary arrival/next unflown segment. Otherwise return-leg disruption monitoring stops after outbound departure.
- The highest-level test seams above are the selected acceptance seams for this plan; implementation should avoid adding lower-level mocks when the same behavior can be proven through them.
- Production targets are: verified webhook durable acknowledgement p95 under 500 ms; webhook-triggered material disruption visible p95 under two minutes; missed eligible events caught within 35 minutes; repeated/concurrent identical input creates exactly one revision and at most one outbox row; and no revision/outbox/state mutation after supplier-confirmed cancellation.
