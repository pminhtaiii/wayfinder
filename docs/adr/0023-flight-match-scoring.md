# Flight Match Scoring Architecture & Design Decisions

> Captured from grilling session on 2026-08-30.

---

## Context

The flight search pipeline returns Duffel offers sorted by basic criteria (price, departure time). Users with detailed traveler profiles — preferred airlines, cabin class, schedule windows — receive no personalized ranking. This session established a deterministic, LLM-free scoring system that ranks flights against user preferences, covering scoring methodology, weight distribution, module architecture, cold-start handling, and agent integration.

---

## 1. Deterministic Scoring — No LLM Involvement

**Decision:** Build a pure deterministic weighted scorer. Do **not** use LLM-as-judge for flight match scoring.

**Rationale:**

- **Cost Leakage:** Every search triggers an LLM inference call. Abandoned searches = pure burn. With the existing API budget discipline (`budget:duffel:*` counters in Redis), adding an unbounded LLM cost channel contradicts the project constitution's budget discipline principle.
- **Latency Tax:** Adding 1–3s of LLM inference between "results arrive from Duffel" and "user sees results" directly hurts the conversion funnel.
- **Non-Determinism Breaks Trust:** Same flight, same profile, searched twice → different scores. Impossible to unit-test precisely, debug, or audit.
- **Constitutional Alignment:** The project overview states *"The AI scoring is advisory only. It never touches the booking/payment path."* A deterministic scorer keeps scoring on the deterministic side of the architecture boundary.

---

## 2. Scoring Dimensions (8 Total)

**Decision:** Score flights across 8 dimensions, split into two pools.

### Baseline Dimensions (no profile data needed)

| Dimension | Flight Attribute | Scoring Logic |
|:--|:--|:--|
| **Price sensitivity** | Offer price vs search result median | Below median = boost, above = penalty, scaled |
| **Stop count** | Segment count − 1 | Fewest stops preferred, penalty per additional stop |
| **Duration** | Total travel duration vs route median | Shorter = better, scaled against current result set |

### Personalized Dimensions (requires user preferences)

| Dimension | Profile Field | Flight Attribute | Scoring Logic |
|:--|:--|:--|:--|
| **Airline preference** | `preferredAirlines`, `blacklistedAirlines` | `airlineCode` | Preferred = boost, blacklisted = eligibility violation |
| **Cabin class** | `classPreference` | Offer cabin class | Exact match = full score, adjacent = partial |
| **Arrival schedule** | `preferredArrivalWindow` _(new)_ | Arrival hour | Window match scored; arrival weighted higher than departure because travelers often need to arrive by a specific time (meetings, conferences) |
| **Departure schedule** | `preferredDepartureWindow` _(new)_ | Departure hour | Window match scored |
| **Baggage inclusion** | `requiresCheckedBaggage` _(new)_ | Included baggage type | Users who always check bags are penalized by carry-on-only offers |

---

## 3. Weight Distribution (Developer-Defined, Fixed)

**Decision:** Use developer-defined fixed weights. Do **not** expose user-adjustable priority sliders.

**Rationale:**

- Most users won't touch configuration sliders (analysis paralysis).
- Fixed weights are deterministic, testable, and debuggable.
- If user complaints reveal demand for adjustable weights, it can be introduced as a future feature.

### Base Weight Table

| # | Dimension | Weight | Tier | Pool |
|:--|:--|:--|:--|:--|
| 1 | Price sensitivity | **20%** | Primary | Baseline |
| 2 | Airline preference | **15%** | Primary | Personalized |
| 3 | Arrival schedule | **15%** | Primary | Personalized |
| 4 | Stop count | **12%** | Secondary | Baseline |
| 5 | Cabin class | **10%** | Secondary | Personalized |
| 6 | Departure schedule | **10%** | Secondary | Personalized |
| 7 | Baggage inclusion | **10%** | Tertiary | Personalized |
| 8 | Duration | **8%** | Tertiary | Baseline |
| | **Total** | **100%** | | Baseline=40%, Personalized=60% |

---

## 4. Eligibility Gate — Hard Vetoes Separated from Scoring

**Decision:** Use a two-phase design: eligibility check (hard constraints) followed by scoring (soft preferences). Do **not** mix vetoes into the scoring signal enum.

**Rationale:**

- A blacklisted airline isn't a "dimension that scored badly" — it's a constraint violation that prevents scoring entirely.
- `score: null` for ineligible flights is semantically cleaner than `score: 0` or a negative value.
- Ineligible flights remain visible in results with their violation reasons, allowing users to override if the price is exceptional.

### Constraint violations (eligibility = false)

- Blacklisted airline match → `ConstraintViolation { constraint: 'BLACKLISTED_AIRLINE', explanation: { key, params } }`

---

## 5. Two-Pool Weight Redistribution

**Decision:** When a dimension has zero variance in the result set (all flights share the same value) OR a personalized dimension lacks user data, redistribute its weight according to pool rules.

### Redistribution Rules

1. **Zero-variance dimensions** (all results identical for that dimension): weight is redistributed proportionally within the same pool.
2. **Missing personalized preferences** (user didn't fill the field): weight flows **DOWN to the baseline pool**, never sideways to other personalized dimensions.
3. A personalized dimension **never exceeds its original base weight** through redistribution.
4. Total always remains 100%.

### Why sideways redistribution is prohibited

If a user sets only airline preference and collapsed personalized weight redistributed sideways, airline alone would absorb ~35% of the total score — more than double its intended influence. Flowing collapsed personalized weight to baseline ensures the score remains dominated by objective flight quality, with personalization applied at its designed proportion.

### Example: User sets only airline preference

```
Personalized active:    airline = 15%
Personalized collapsed: cabin(10) + departure(10) + arrival(15) + baggage(10) = 45%
  → 45% flows to baseline pool

Baseline pool: 40% + 45% absorbed = 85%
  Price:    20/40 × 85 = 42.5%
  Stops:    12/40 × 85 = 25.5%
  Duration:  8/40 × 85 = 17.0%

Airline: 15% (unchanged)
Total: 85% + 15% = 100%
```

### Example: Full profile, all preferences set

```
Baseline: 40% | Personalized: 60%
Original weights apply unchanged. Zero redistribution.
```

---

## 6. Cold-Start Strategy — Category Ranking Without Scorer

**Decision:** When a user has **zero personalized preferences** filled, skip `FlightMatchModule` entirely. Use a category-based composite ranker instead.

**Rationale:**

- Follows established e-commerce patterns (Google Flights, Skyscanner, Kayak) where anonymous/no-preference users see a "Best" composite ranking.
- Avoids showing misleading "match scores" when there's nothing to match against.
- Saves computation — the scorer is never instantiated.

### Category-Based Ranking Order

1. Fewest stops (primary)
2. Lowest price (secondary)
3. Shortest duration (tertiary)
4. Most reasonable departure time (tiebreaker — avoid red-eye)

### Branching Logic (in FlightSearchService)

```
FlightSearchService.search(userId, criteria):
  1. Load preferences via TravelerProfileModule
  2. hasPersonalization = any personalized field is filled

  if (hasPersonalization):
    → FlightMatchScorerService.scoreAll(offers, preferences)
    → Return { mode: 'MATCHED', results: [...with matchResult] }
  else:
    → CategoryRanker.rank(offers)
    → Return { mode: 'RANKED', results: [...without matchResult] }
```

### Frontend Behavior

- **RANKED mode:** Clean result list, sort controls (price / duration / stops / departure), no score badges. Subtle banner: *"Complete your traveler profile for personalized flight matching."*
- **MATCHED mode:** Score badges, match level tags, expandable per-dimension breakdown, default sort by match score.

---

## 7. Module Architecture — Pure Scorer with Zero Infrastructure Dependencies

**Decision:** `FlightMatchModule` is a pure computational boundary with zero Prisma, HTTP, Redis, or profile-loading dependencies. `FlightSearchModule` orchestrates all data assembly.

### Module Dependency Graph

```
FlightSearchModule
  ├── imports DuffelModule        (fetches offers)
  ├── imports TravelerProfileModule (loads preferences)
  └── imports FlightMatchModule    (pure scorer)

TravelerProfileModule
  └── does NOT know about FlightMatch

FlightMatchModule
  └── does NOT know about TravelerProfile or Prisma
```

**Rationale:**

- Follows the established `BookingReadinessEvaluator` pattern: *"performs no database, HTTP, Redis, airport, supplier, agent, LLM, or logging work and does not mutate inputs."*
- Zero mocks needed in scorer unit tests — pass data in, assert scores out.
- Reusable by any consumer (search page, agent gateway) without importing profile infrastructure.
- Clean anti-cyclic boundary — no bidirectional dependency risk.

---

## 8. Agent Integration — Shared Deterministic Scoring via FlightSearchModule

**Decision:** The AI chat agent uses the **same** deterministic scorer as the search page, accessed through `FlightSearchModule` — not by importing `FlightMatchModule` directly.

### Agent Dependency Path

```
AttestedFlightSearchModule (agent gateway)
  └── calls FlightSearchModule.search(userId, criteria)
        ├── loads preferences via TravelerProfileModule
        ├── fetches offers via DuffelModule
        ├── if hasPersonalization → FlightMatchModule.scoreAll()
        │   else → CategoryRanker.rank()
        └── returns scored/ranked results
```

**Rationale:**

- **Consistency:** The agent sees the exact same scored results as the search page. No conflicting recommendations.
- **Minimal Dependencies:** The agent gateway imports only `FlightSearchModule`, not the scorer or profile modules individually.
- **LLM Narration, Not Judgment:** The LLM reads pre-computed deterministic scores and breakdown and generates conversational reasoning. The LLM adds value by *narrating* the result, not by *producing* it.

---

## 9. Score Persistence — Ephemeral, No Storage

**Decision:** Match scores are computed per search and never persisted. Do **not** create a `flight_match_scores` table.

**Rationale:**

- Scores depend on **both** the result set (for median calculations and weight redistribution) and the profile. Either can change between searches.
- Duffel offers expire. A score from yesterday's search is meaningless against today's availability.
- The scorer is a pure function with near-zero latency — recomputing is cheaper than managing a storage lifecycle.
- No new migration, no cleanup cron, no stale-score bugs.
- Analytics captured through structured telemetry (aggregate score distribution per search) without individual offer persistence.

---

## 10. Output Contract

**Decision:** Return a structured `FlightMatchResult` with eligibility gate, 0–100 score, match level bucketing, per-dimension breakdown with contribution values, and i18n-ready explanation keys.

### Match Level Bucketing

| Level | Score Range |
|:--|:--|
| `STRONG` | 75–100 |
| `GOOD` | 50–74 |
| `FAIR` | 25–49 |
| `WEAK` | 0–24 |

### Contract Shape

```typescript
interface FlightMatchResult {
  eligibility: {
    eligible: boolean;
    violations: ConstraintViolation[];
  };

  score: number | null;       // null when ineligible
  matchLevel: MatchLevel | null;

  breakdown: DimensionScore[];

  metadata: {
    scoringVersion: string;
    activeWeights: WeightMap;
  };
}

type MatchLevel = 'STRONG' | 'GOOD' | 'FAIR' | 'WEAK';

interface DimensionScore {
  dimension: MatchDimension;

  score: number;        // 0–1 normalized sub-score
  weight: number;       // effective normalized weight after redistribution
  contribution: number; // score × weight = actual contribution to final score

  signal: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

  explanation: {
    key: string;                           // i18n template key
    params: Record<string, string | number>; // template parameters
  };
}

interface ConstraintViolation {
  constraint: string;

  explanation: {
    key: string;
    params: Record<string, string | number>;
  };
}
```

### Explanation Key Examples

| Scenario | Key | Params |
|:--|:--|:--|
| Preferred airline | `match.airline.preferred` | `{ airline: 'Vietnam Airlines' }` |
| Blacklisted airline (violation) | `constraint.airline.blacklisted` | `{ airline: 'Spirit' }` |
| Arrival in window | `match.arrival.in_window` | `{ time: '07:30', windowStart: '06:00', windowEnd: '09:00' }` |
| Below median price | `match.price.below_median` | `{ percentBelow: 23 }` |
| Exceeds max stops | `match.stops.exceeds_preference` | `{ actual: 2, preferred: 0 }` |

---

## 11. New Traveler Profile Fields (Prisma Migration Required)

The following fields must be added to the existing `travelerProfile` model:

| Field | Type | Default | Notes |
|:--|:--|:--|:--|
| `preferredDepartureWindow` | `Json?` | `null` | `{ start: number, end: number }` (hours 0–23) |
| `preferredArrivalWindow` | `Json?` | `null` | `{ start: number, end: number }` (hours 0–23) |
| `maxStops` | `Int?` | `null` | `null` = no preference |
| `priceSensitivity` | `String?` | `null` | Enum: `BUDGET`, `MODERATE`, `FLEXIBLE` |
| `requiresCheckedBaggage` | `Boolean?` | `null` | `null` = no preference |

All fields are nullable to support graceful degradation for existing profiles.

---

## 12. API Response Mode Signal

**Decision:** The search API response includes a `mode` field indicating which ranking strategy was used.

```typescript
interface FlightSearchResponse {
  mode: 'MATCHED' | 'RANKED';
  results: ScoredFlightOffer[];
  // RANKED: matchResult is null on every offer
  // MATCHED: matchResult is populated per offer
}
```

This allows the frontend to render the appropriate UI — score badges and breakdown for MATCHED mode, clean sort controls for RANKED mode.

---

## Summary of Excluded / Deferred Items

| Item | Status | Reason |
|:--|:--|:--|
| LLM-as-judge scoring | **Rejected** | Cost, latency, non-determinism |
| User-adjustable weight sliders | **Deferred** | Most users won't touch them; launch with fixed weights first |
| Score persistence (`flight_match_scores` table) | **Rejected** | Ephemeral computation is cheaper and fresher |
| Localization of explanation strings | **Deferred** | i18n-ready key+params structure ships now; translations added later |
| Price trend analysis integration | **Deferred** | Separate feature, separate data contract |
