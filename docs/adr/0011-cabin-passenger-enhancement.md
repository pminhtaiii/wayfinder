# Cabin Class & Passenger Type Enhancement — Grilling Session Decisions

**Date**: 2026-07-09
**Session**: Grilling session between user and AI to stress-test architecture for the next flight search enhancement
**Base feature**: 006-flight-search-service (all 6 phases complete)

---

## Context

The flight search pipeline (Duffel integration, caching, budget tracking, search + detail endpoints, frontend) is fully built. The next step is making the search engine **production-usable** by removing hardcoded assumptions: cabin class is locked to `economy`, all passengers are forced to `adult`.

## Feature Priority Order (User Decision)

| Priority    | Feature                                                                      | Status               |
| ----------- | ---------------------------------------------------------------------------- | -------------------- |
| **Phase 1** | Cabin class selection + Passenger type diversity                             | Next — this document |
| **Phase 2** | Filtering & sorting (stops, airlines, price range, departure time, duration) | Queued               |
| **Phase 3** | Booking flow (order creation, payment)                                       | Queued               |
| **Future**  | Multi-city, flexible date search, price alerts, saved searches               | Backlog              |

---

## D1: Cabin Class Strategy

**Decision**: Request-level filtering — pass the user's selected `cabinClass` to Duffel's `offerRequests.create()` API call.

**Rationale**: Duffel optimizes search results internally for the requested cabin. Post-filtering (requesting all cabins and filtering client-side) wastes API budget and may miss premium cabin offers that Duffel only returns when explicitly requested.

**Alternatives rejected**:

- Post-filtering on returned results — budget-inefficient, inaccurate for rare cabins.

---

## D2: Mixed-Cabin Validation

**Decision**: Flexible validation — keep mixed-cabin offers but flag them with per-segment cabin class details. Do not discard any offers.

**Rationale**: In real aviation, regional feeder flights often lack premium cabins. Discarding the entire itinerary would yield zero results for complex multi-leg journeys. Industry standard is to keep and warn.

**Alternatives rejected**:

- Strict validation (discard mismatched offers) — too aggressive, kills valid itineraries.
- Threshold validation (longest segment match only) — incorporated into the status classification below instead.

---

## D3: Three-Tier Cabin Match Status

**Decision**: Classify each offer as `full`, `mixed`, or `downgraded` using a deterministic, single-rule algorithm:

```
1. Find the longest-duration segment across all slices (outbound + return)
2. If that segment's cabinClass ≠ requestedCabinClass → status = "downgraded"
3. Else if any other segment's cabinClass ≠ requestedCabinClass → status = "mixed"
4. Else → status = "full"
5. Worst case wins (if longest segment is downgraded, status is downgraded regardless)
```

**UI treatment**:

- `full` → no warning
- `mixed` → yellow ⚠️ badge next to price with expandable details
- `downgraded` → red ⚠️ badge next to price — stronger warning

**Rationale**: No magic thresholds, no tunables, no ambiguity from segment ordering. "Longest segment" alone resolves feeder-leg-vs-main-flight correctly.

---

## D4: Cabin Mismatch Data Shape

**Decision**: Add per-segment cabin class and offer-level mismatch summary.

### FlightSegmentDto additions:

```typescript
cabinClass: 'economy' | 'premium_economy' | 'business' | 'first';
```

### FlightOfferDto additions:

```typescript
requestedCabinClass: 'economy' | 'premium_economy' | 'business' | 'first';
cabinClassMatch: 'full' | 'mixed' | 'downgraded';
cabinMismatchDetails: {
  segmentIndex: number;
  leg: 'outbound' | 'return';
  expected: string;
  actual: string;
  route: string; // e.g., "SGN → HAN"
}
[] | null;
```

**UI placement**: "Mixed Cabin" or "Downgraded" badge displayed next to the price. Mismatch details are specific: _"Segment SGN→HAN is Economy (requested: Business)"_.

**Rationale**: Users must never assume the whole itinerary matches their requested cabin. Specific per-segment details enable informed booking decisions.

---

## D5: Passenger Type DTO Shape

**Decision**: Flat fields on the request DTO — not a structured array.

```typescript
// FlightSearchRequestDto
adults: number;       // required, min 1
children?: number;    // optional, default 0  (ages 2–11)
infants?: number;     // optional, default 0  (under 2, on lap)
```

**Rationale**: Flat fields eliminate cache-key ordering issues (no normalization needed). Covers 99% of booking scenarios. Simple to validate.

**Validation rules**:

- `adults` ≥ 1
- `infants` ≤ `adults` (each infant needs a lap)
- `adults + children + infants` ≤ 9

---

## D6: Isolated Passenger Mapper in DuffelService

**Decision**: Create an isolated mapping function inside `DuffelService` that converts flat DTO fields → Duffel's passenger array format.

```typescript
// Single seam — only this function changes if Duffel adds new types
function mapPassengersToDuffel(
  adults: number,
  children: number,
  infants: number,
): DuffelPassenger[] {
  return [
    ...Array(adults).fill({ type: 'adult' }),
    ...Array(children).fill({ type: 'child' }),
    ...Array(infants).fill({ type: 'infant_without_seat' }),
  ];
}
```

**Rationale**: If Duffel adds `young_adult` or `senior` in the future, only this small function changes. No DTO shape changes, no controller changes, no frontend changes.

---

## D7: Cache Key Shape

**Decision**: SHA-256 of flat, deterministic fields:

```typescript
SHA -
  256(
    JSON.stringify({
      origin,
      destination,
      departureDate,
      returnDate,
      adults,
      children,
      infants,
      cabinClass,
    }),
  );
```

**Rationale**: Flat fields = deterministic ordering by construction. No normalization or sorting needed. Adding `cabinClass` and passenger breakdown increases the cache key space (more permutations = more API calls on cache miss), but this is correct behavior — different cabins genuinely return different offers.

**Budget impact**: Accepted. The 2,000/month budget is sufficient for development/early production. Revisit if it becomes a problem.

---

## D8: Database Schema — Flat Columns

**Decision**: Option A — replace the single `passengers Int` column with flat columns across `FlightOffer`, `SearchHistory`, and the cache key.

### Schema changes (both FlightOffer and SearchHistory):

```
- passengers  Int        ← DROP
+ adults      Int        ← NEW
+ children    Int @default(0) ← NEW
+ infants     Int @default(0) ← NEW
+ cabinClass  String @default("economy") ← NEW
```

**Rationale**: Early development stage — schema changes are trivial. Flat columns enable rich analytics queries (`GROUP BY cabinClass`, `WHERE children > 0`) without JSON extraction. JSON columns rejected as a code smell for known-shape structured data.

---

## D9: Agent Gateway — Default with Honest Degradation

**Decision**: Keep the chatbot defaulting to `economy` / all-adults in Phase 1. Add a lightweight keyword detection layer.

### Keyword detection behavior:

1. Detect when user message implies unsupported cabin/passenger needs (e.g., "business class", "2 kids", "infant")
2. Respond with an honest limitation message: _"I can currently only search economy class for adult passengers. For other cabin classes or passenger types, please use the search page."_
3. Log those triggers to a dedicated analytics channel to prioritize the real NLP upgrade

### Interface compatibility:

- Agent gateway uses the **same DTO shape** as the frontend (`adults`, `children`, `infants`, `cabinClass`)
- Defaults: `adults` mapped from the incoming request's passenger count field, `children = 0`, `infants = 0`, `cabinClass = 'economy'`
- No interface migration needed when full extraction is implemented later

### Future upgrade plan:

- **Trigger**: When keyword-detection logs show >10% of chatbot flight queries mention non-economy cabins or child/infant passengers
- **Scope**: Update Python agent tool schema to accept cabin/passenger params, add extraction logic, remove keyword fallback
- **Not in scope now** — parked for data-driven prioritization

---

## Open Items (Not Yet Grilled)

- Frontend UI design for passenger picker widget and cabin class selector
- Filtering & sorting architecture (Phase 2)
- Booking flow architecture (Phase 3)
