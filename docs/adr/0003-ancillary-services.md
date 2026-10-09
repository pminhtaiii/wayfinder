# Grilling Session #4 — Ancillary Services: Seat Selection, Baggage & Dynamic Price Tracker

Stress-tested the ancillary services architecture across 14 prioritized design decisions covering pricing model, seat map rendering, security, multi-passenger UX, multi-segment handling, caching, payment integration, and cancellation impact before implementation.

**Date**: 2026-07-26 | **Feature**: 15 (Ancillary Services — Seat Selection, Baggage & Price Tracker)
**Participants**: User + AI | **Questions Resolved**: 14

---

## Context

Features 1–14 are complete: auth, AI chatbot with guardrails, flight search (Duffel), maps, multi-passenger/cabin selection, booking intent with pessimistic locking, Stripe manual-capture payments, booking management, and cancellation/refund recovery. The system covers the full booking lifecycle but lacks ancillary services — seat selection, baggage add-ons, and dynamic pricing — which every production OTA offers and which represent the #1 ancillary revenue driver in the travel industry.

---

## Decisions Made

### Q1 — Feature Choice ✅

**Decision**: Ancillary Services (Seat Selection + Baggage + Dynamic Price Tracker) as Feature 15.
**Rationale**: Biggest gap between current system and production OTAs (Expedia, Skyscanner, Kiwi). Directly impacts user satisfaction during the booking flow. Duffel Seat Maps & Services API fully supports it. Other contenders (round-trip/multi-city, loyalty programs) deferred as lower architectural complexity or lower user visibility.

---

### Q2 — Pricing Model: Client-Side Aggregation ✅

**Decision**: Client-side price tracking with server-side validation at checkout. No re-pricing API calls during browsing.
**Rationale**: Duffel uses an additive pricing model — each seat/service has a fixed `total_amount`. Formula: `Total = Base Offer Price + Σ(Service Price × Quantity)`. Client sums these instantly; one server-side call to `POST /air/offers/{id}/actions/price` at checkout confirms the authoritative total.
**Benefits**: Zero latency on seat taps, no wasted API budget (vs. 90+ re-price calls per session), instant UX feedback for budget-conscious travellers.
**Alternatives rejected**: Server-side re-pricing on every selection (500ms–2s latency per click, expensive API costs).

---

### Q3 — Seat Map Renderer: Custom Built ✅

**Decision**: Build a fully custom seat map renderer. Do not use Duffel's `@duffel/components` drop-in widget.
**Rationale**: Need tight price tracker integration (wire seat taps directly to price state), brand consistency with existing Tailwind + shadcn/ui design system, fine-grained multi-passenger UX control, and independence from Duffel's component lifecycle. Trade-off: ~2–3 weeks more development, but pays dividends in UX quality.
**Alternatives rejected**: Duffel `<DuffelAncillaries />` widget (limited styling control, callback-dependent price events, visual clash with app theme).

---

### Q4 — Security & Authorization: Duffel as Single Source of Truth ✅

**Decision**: No client-side soft-locking of seats. Duffel is the authoritative gatekeeper for availability. Multi-layer validation at price check AND order creation.
**Key guards**:

- Server validates JWT + BookingIntent ownership before accepting seat selections
- Server validates submitted `service.id`s belong to the correct offer and passenger (prevents service ID tampering)
- Duffel rejects orders with unavailable service IDs at the supplier level
- Graceful conflict resolution: unavailable seats marked on the map with re-selection prompt
  **Why no soft-locking**: This system is one of many distribution channels. Redis locks only protect against own users — travellers on Expedia or the airline's site can still book the same seat.

---

### Q5 — Idempotency & Crash Recovery ✅

**Decision**: Extend existing `@IdempotencyKey` service to seat/baggage confirmation. Use `localStorage` (not `sessionStorage`) for post-"Continue" recovery.

- **Browsing state**: Client-side only. Lost on crash — acceptable (user hadn't committed).
- **Post-Continue state**: Snapshot to `BookingIntent` (server) + `localStorage` (client). On return, hydrate from `localStorage`, validate against server-side intent.
- **Double-click protection**: Existing `@IdempotencyKey` header service with replay caching prevents duplicate orders.
- **`sessionStorage` limitation acknowledged**: Does not survive tab close or browser crash. Accepted — no workaround exists.

---

### Q6 — Multi-Passenger UX: Tab-Based Stepper ✅

**Decision**: One passenger selects at a time via a tab/stepper interface. Free jumping between passengers allowed.
**Tab format**: `[Tram ✓] [Minh — selecting] [An — not selected]`
**Group visibility**: Seats selected by other passengers in the same booking show a distinct "selected by your group" indicator (not greyed out like unavailable).
**Infant handling**: Infants (lap seats) automatically skipped in the stepper.
**Alternatives rejected**: Simultaneous color-coded selection for all passengers (cognitive overload, confusing with 4+ passengers).

---

### Q7 — Booking Flow Order ✅

**Decision**: `Flight selection → Passenger details → Ancillaries (Seats | Baggage) → Review → Payment`
**Rationale**: Passenger details first enables named tabs (not "Adult 1"), age-based seat restrictions (exit rows require 15+), infant skipping, and adjacent seat suggestions for families.
**Passenger documents**: Always collect name, date of birth, gender (Duffel requirement). Conditionally show passport fields for international routes only (detect by origin/destination country codes).

---

### Q8 — Baggage Placement: Same Page, Two Switchable Sections ✅

**Decision**: Seats and baggage live on the same "Ancillaries" page as two switchable sections. Both are independently skippable.
**Rationale**: Reduces page count while avoiding visual overwhelm. Users mentally group these as "extras." Price tracker shows the combined total across both sections.
**Alternatives rejected**: Separate pages (unnecessary extra step), stacked on same page (overwhelming).

---

### Q9 — Review Page: Read-Only with Edit Links ✅

**Decision**: Read-only summary page with targeted `[Edit seats]` / `[Edit baggage]` links per section. No inline editing.
**Rationale**: Review page's purpose is confirmation, not modification. Inline editing blurs the boundary and increases abandonment. Targeted links preserve selections and are fast enough (one click to edit, one click to return). Same pattern as Amazon checkout and Booking.com.

---

### Q10 — Multi-Segment Handling ✅

**Decision**: Segment tabs above the passenger stepper. Each segment loads its own seat map independently.
**Hierarchy**: `Segment selector → Passenger stepper → Seat map + Price tracker`
**Per-segment skip**: Users can skip seat selection for short hops and only select for long-haul segments.
**Missing seat maps**: When Duffel returns no seat map for a segment, show informational message: _"Seats will be assigned by the airline. No additional charge."_ Segment tab renders as non-interactive.

---

### Q11 — Data Schema: Segment-Scoped Selections ✅

**Decision**: Selections keyed by `[segmentId][passengerId]`. Seat designators (e.g., "12A") are display-only and scoped to their segment. `serviceId` is the real Duffel identifier.

**Seats**:

```typescript
selectedSeats[segmentId][passengerId] = {
  serviceId, // Duffel's globally unique service ID
  seatDesignator, // "12A" — display only, scoped to segment
  amount,
  currency,
};
```

**Baggage**:

```typescript
selectedBaggage[segmentId][passengerId] = Array<{
  serviceId;
  segmentIds; // which segments this service covers
  type; // "checked" | "carry_on"
  weight;
  quantity;
  amount;
  currency;
}>;
```

**Segment isolation**: Switching segments reads from `selections[newSegmentId]` — never carries state from another segment. Switching passengers within a segment only modifies `selections[currentSegmentId][currentPassengerId]`.

---

### Q12 — Baggage Scoping: Per-Segment vs Per-Journey ✅

**Decision**: Display baggage grouped by scope using Duffel's `segment_ids` array:

- `segment_ids.length > 1` → `🏷️ FULL JOURNEY` label
- `segment_ids.length === 1` → `🏷️ THIS FLIGHT ONLY` label

**Mutual exclusion**: Selecting a journey-wide bag disables per-segment options for the same weight tier. Selecting in one tab auto-reflects in other covered segment tabs (with "Selected via [other tab]" indicator to prevent double-purchasing).
**Price comparison**: Show "Save $X" badge when journey-wide is cheaper than sum of per-segment.

---

### Q13 — Stripe Integration: Single PaymentIntent, 10-Step Flow ✅

**Decision**: One Stripe PaymentIntent for the full amount (base fare + all ancillaries). Two-phase commit pattern: authorize first, commit to supplier, then capture or release.

**Flow**:

1. User confirms seats and baggage
2. Server locks the BookingIntent
3. Server re-prices the exact offer and services with Duffel
4. Server calculates the final customer-facing amount
5. Create one Stripe PaymentIntent with manual capture
6. Customer authorizes the full amount
7. Verify PaymentIntent status = `requires_capture`
8. Create the Duffel order with the validated services
9. Duffel order confirmed → capture Stripe payment
10. Duffel order failed → cancel Stripe authorization

**Rationale**: One charge on the user's card statement (reduces chargeback risk). Aligns with Duffel's single-order model. Simpler refund logic. No changes to existing payment pipeline — just a larger `amount`.
**Alternatives rejected**: Separate PaymentIntents for fare and ancillaries (two charges, complex refunds, confusing card statements).

---

### Q14 — Caching Strategy: 60s TTL with Early Expiry Buffer ✅

**Decision**: Cache seat map responses in Redis for 60 seconds, keyed by `seatmap:{offerId}`. If remaining TTL < 3 seconds, treat as cache miss and fetch fresh data.

```typescript
const CACHE_TTL = 60;
const EARLY_EXPIRY_BUFFER = 3;

async function getSeatMap(offerId: string) {
  const cacheKey = `seatmap:${offerId}`;
  const remainingTTL = await redis.ttl(cacheKey);

  if (remainingTTL > EARLY_EXPIRY_BUFFER) {
    return JSON.parse(await redis.get(cacheKey)); // Cache hit
  }

  // Cache miss OR about to expire → fetch fresh
  const seatMap = await duffel.seatMaps.get({ offer_id: offerId });
  await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(seatMap));
  return seatMap;
}
```

**Rationale**: Absorbs concurrent lookups on popular flights. 60s is short enough for reasonable freshness. Checkout validation catches any stale data before payment. Force-refresh button available for power users.
**Alternatives rejected**: 2–3 minute cache (too long for volatile seat availability), no cache (expensive for high-traffic flights).

---

## Cancellation & Refund with Ancillaries

**Decision**: No changes to existing refund pipeline. Duffel handles ancillary refunds at the order level — `refund_amount` includes refundable ancillary costs.

**Flow**:

1. Request Duffel cancellation quote
2. Read `refund_amount`, `refund_currency`, and `refund_to`
3. Show quote and refund method to traveller
4. Confirm the latest, unexpired Duffel cancellation
5. After Duffel confirms: issue Stripe refund or record/deliver airline credit
6. Recovery worker handles Stripe failures or uncertain states

**Non-refundable ancillaries**: Duffel's quote excludes them from `refund_amount`. Communicate clearly to user.

---

## Stale Selection Cleanup

**Decision**: Extend existing two-phase cron (Feature 9) to clean up expired BookingIntents with seat/baggage selections. Client-side `localStorage` entries include TTL check — discard if older than intent's expiry window. Handles anti-abuse from users "playing around."

---

## Complete Booking Flow

```
Search → Flight selection → Passenger details → Ancillaries → Review → Payment
                                                  ├─ [Seats]       ↑
                                                  └─ [Baggage]     │
                                                (switchable,   Read-only
                                                 skippable)    + edit links
```

## Integration Points

| Existing System                  | Integration                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Duffel Service (Feature 6)       | Add `getSeatMap()`, extend `createOrder()` with `services[]`, add `return_available_services=true` |
| BookingIntent (Feature 9)        | Extend encrypted snapshot to include `selectedSeats` + `selectedBaggage`                           |
| Stripe Payment (Feature 10)      | Single PaymentIntent with manual capture — amount includes ancillaries                             |
| Cancellation/Refund (Feature 12) | No changes — Duffel's `refund_amount` already includes refundable ancillaries                      |
| Two-phase Cron (Feature 9)       | Already handles BookingIntent cleanup — covers intents with ancillary selections                   |
| Idempotency Service (Feature 10) | Extend to seat/baggage confirmation endpoint                                                       |

## Out of Scope (Deferred)

| Item                                                  | Reason                 |
| ----------------------------------------------------- | ---------------------- |
| Mobile-responsive seat map                            | Desktop-first approach |
| Post-booking seat changes via Duffel order change API | Separate feature       |
| AI agent seat recommendations                         | Separate enhancement   |
| Round-trip / multi-city search support                | Separate feature       |

## Next Steps

- Write the feature spec using `/speckit-specify`
- Execute the implementation plan with `/speckit-implement` or `/tdd`
