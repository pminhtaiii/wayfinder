# Research: Flight Match Scoring

This document resolves implementation details left open by `docs/adr/0023-flight-match-scoring.md`. It does not reopen the ADR's approved product decisions.

## Decision 1: Keep scoring pure and supplier-independent

**Decision**: Create `FlightMatchModule` under the NestJS API with a pure `FlightMatchScorerService` and pure `CategoryRankerService`. Inputs are normalized, immutable offer facts and PII-free scoring preferences. The module imports no Prisma, profile, Duffel, cache, HTTP, agent, or logging module.

**Rationale**: This matches the established `BookingReadinessEvaluator` boundary, makes golden fixtures sufficient for unit tests, and keeps all transactional and supplier work outside scoring.

**Alternatives considered**:

- LLM-as-judge: rejected by the ADR for cost, latency, non-determinism, and constitutional boundary reasons.
- Scoring inside `FlightsService`: rejected because it couples policy to profile/supplier orchestration and prevents reuse.
- Shared npm package: rejected as unnecessary packaging for a server-owned policy with one authoritative runtime.

## Decision 2: Introduce one browser-and-agent orchestration path

**Decision**: Refactor the existing normalized offer mapping and search orchestration into the existing flights domain. `FlightsService.search()` remains the browser controller entry and becomes the authoritative flow: fetch/cache Duffel offers, normalize/map offers, load the owned profile projection, choose `MATCHED` or `RANKED`, rank, persist only existing search history/raw offer recovery data, and return the response. `AttestedFlightSearchService` delegates supplier search and ranking to this flights-domain orchestration, then applies attestation, result limits, trusted-snapshot persistence, and gateway-safe projection.

**Rationale**: Today `apps/api/src/flights/flights.service.ts` and `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.ts` independently map and order Duffel offers. Delegation is required to satisfy the ADR's same-scorer/same-result invariant and avoid policy drift.

**Alternatives considered**:

- Import `FlightMatchModule` directly into the agent gateway: explicitly rejected by the ADR.
- Duplicate only normalization code in each path: rejected because ranking, eligibility, mode, and tie-break behavior could still diverge.
- Route the agent through the public HTTP controller: rejected because an in-process module call preserves the current gateway auth and attestation boundaries without internal HTTP.

## Decision 3: Normalize policy inputs once

**Decision**: Add a supplier-independent `FlightMatchInput` for each offer with local opaque ID, original index, price/currency, total itinerary duration, stop count, outbound first-departure/final-arrival instants, longest-segment cabin, all marketing and operating carrier codes, safe carrier display names, and checked-baggage inclusion. Duffel-to-input mapping remains in the flights domain.

**Rationale**: Scoring should not understand Duffel payloads or provider IDs. The same normalized facts also support category ranking, UI mapping, and gateway projections.

**Alternatives considered**:

- Score the browser DTO: rejected because its display strings and current baggage text are too lossy for precise rules.
- Pass raw Duffel offers: rejected because it violates the pure supplier-independent boundary.

## Decision 4: Use explicit deterministic formulas

All arithmetic uses finite numbers, internal precision of six decimal places, and `clamp(value, 0, 1)`. Contributions and effective weights are rounded to six decimals; the final score is `roundHalfAwayFromZero(sum(contribution) * 100)` and is clamped to 0–100. Dimension signals are `POSITIVE` for sub-scores at or above `0.67`, `NEUTRAL` from `0.34` through `0.669999`, and `NEGATIVE` below `0.34`. Stable sort always retains the original supplier order as its final tie-breaker.

### Price (base weight 0.20, baseline)

- Reference: median eligible price in the offer currency.
- The first valid offer establishes the comparison currency; later mixed-currency offers are dropped with the `MIXED_CURRENCY` aggregate reason defined in Decision 16.
- Formula: `clamp(0.5 + 0.5 * sensitivityMultiplier * ((median - price) / max(median, 0.01)), 0, 1)`.
- Multipliers: `BUDGET=1.25`, `MODERATE=1.0`, `FLEXIBLE=0.75`, missing=`1.0`.
- Explanation bands use the signed percentage difference from the median.

### Stops (base weight 0.12, baseline)

- With `maxStops`: score `1` when `stops <= maxStops`; otherwise `clamp(1 - 0.5 * (stops - maxStops), 0, 1)`.
- Without `maxStops`: use the eligible set minimum as the reference with the same 0.5 penalty per additional stop.
- Stops are non-negative integers.

### Duration (base weight 0.08, baseline)

- Reference: median eligible total itinerary duration in minutes.
- Formula: `clamp(0.5 + 0.5 * ((median - duration) / max(median, 1)), 0, 1)`.

### Airline (base weight 0.15, personalized)

- Blacklist is an eligibility veto and always wins over preferred status.
- Any marketing or operating carrier code in `blacklistedAirlines` makes the offer ineligible and records every matched code once.
- With preferred airlines present, score `1` when any normalized carrier code matches; otherwise score `0.5` (neutral, not a false negative claim).
- Empty/duplicate/case-varied codes are normalized away before scoring.

### Cabin (base weight 0.10, personalized)

- Compare the existing profile class preference against the cabin of the longest segment across outbound and return slices, matching the current cabin-mismatch convention.
- Exact class scores `1`, one adjacent class scores `0.5`, and a difference of two or more tiers scores `0`.
- Tier order is economy, premium economy, business, first.

### Arrival and departure windows (base weights 0.15 and 0.10, personalized)

- Apply the profile windows to outbound first departure and outbound final arrival supplier-local clock values. Extract the `HH:mm` portion from the validated offset-aware supplier timestamp before any UTC conversion, so an offset or DST transition cannot shift the intended local window. One profile window is not incorrectly reused for a return leg.
- Windows use inclusive integer hours 0–23; `start > end` means the range crosses midnight; `start == end` means that exact hour.
- Inside the window scores `1`.
- Outside the window, score decays linearly from the nearest boundary over a six-hour shoulder: `clamp(1 - circularDistanceHours / 6, 0, 1)`.
- Invalid or missing outbound timestamps reject that offer during normalization as defined in Decision 16; remaining valid offers continue to use the schedule dimension normally.

### Baggage (base weight 0.10, personalized)

- `requiresCheckedBaggage=true`: score `1` only when every itinerary slice's longest segment includes at least one checked bag for the representative passenger; otherwise `0`.
- `requiresCheckedBaggage=false`: all offers score `1`, expressing no penalty for either inclusion state; the dimension will normally collapse as non-discriminating.
- `null`: the preference is missing and its weight flows to baseline.

**Rationale**: These formulas are simple enough to audit, continuous where comparison is meaningful, consistent with the ADR's median and partial-match language, and fully golden-testable.

**Alternatives considered**:

- Min/max normalization: rejected because one extreme outlier compresses the rest of the set.
- Percentile or learned curves: deferred because they add policy complexity without approved product evidence.
- Segment-weighted preference averages: rejected for v1 in favor of the existing longest-segment cabin convention and clear offer-level explanations.

## Decision 5: Resolve personalization and cold start explicitly

**Decision**: Effective scoring preferences are non-empty preferred or blacklisted airline codes, a valid cabin preference, either schedule window, non-null checked-baggage requirement, non-null `maxStops`, or non-null `priceSensitivity`. Price sensitivity and maximum stops modify baseline dimensions but still count as profile personalization. With no effective preference, use `RANKED` mode and never invoke the registered stateless match scorer.

**Rationale**: The ADR adds `priceSensitivity` and `maxStops` to the profile even though price and stops remain baseline dimensions. Treating them as modifiers preserves the fixed weight pools while ensuring filled preferences are not silently ignored.

**Alternatives considered**:

- Treat price sensitivity and max stops as new dimensions: rejected because the approved policy has exactly eight dimensions and fixed weights.
- Ignore them for mode selection: rejected because a user's only supplied scoring preferences would have no visible effect.

## Decision 6: Apply two-pool redistribution with bounded fallbacks

**Decision**:

1. Begin from the fixed base weights: baseline 0.40, personalized 0.60.
2. Missing personalized dimensions release their base weight directly to the baseline pool.
3. For two or more eligible offers, a dimension is zero-variance when all valid normalized sub-scores are equal at six-decimal precision. Single-offer sets do not apply zero-variance collapse.
4. Compute the baseline target pool as the original 0.40 plus all missing-personalized and personalized-cap overflow transferred downward. Baseline zero-variance weight is redistributed proportionally among active baseline dimensions against this full target.
5. Personalized zero-variance weight first attempts same-pool redistribution subject to the hard cap that no personalized dimension exceeds its base weight. Any unallocatable remainder flows down to active baseline dimensions.
6. If every baseline dimension is zero-variance, cancel collapse for that pool and distribute the entire baseline target (not merely the original 0.40) across PRICE/STOPS/DURATION in their 20:12:8 base ratio. The dimensions remain non-discriminating but absorb transferred weight. Example: airline-only personalization yields baseline target 0.85 and exact effective weights PRICE 0.425, STOPS 0.255, DURATION 0.170, AIRLINE 0.150.
7. Ineligible offers are excluded from medians and variance. If every offer is ineligible, return eligibility results with null scores and no scoring breakdown; the 100% invariant applies only to scored eligible offers.
8. Every scored offer receives the same resolved active-weight map for that result set, and it sums to exactly 1.000000 after deterministic remainder assignment to the highest-weight baseline dimension (price, then stops, then duration).

**Rationale**: The ADR's “same pool,” “personalized cap,” and “total 100%” rules conflict in degenerate sets unless allocation precedence and a no-recipient fallback are defined. This is the smallest deterministic completion of those rules.

**Alternatives considered**:

- Let personalized dimensions exceed base weights: rejected explicitly by the ADR.
- Return totals below 100%: rejected explicitly by the ADR.
- Invent a ninth neutral dimension: rejected because the policy is fixed at eight dimensions.

## Decision 7: Use deterministic ranking and tie-breaks

**Decision**:

- `MATCHED`: eligible before ineligible; score descending; stops ascending; price ascending; duration ascending; reasonable departure penalty ascending; original supplier index ascending.
- `RANKED`: stops ascending; price ascending; duration ascending; reasonable departure penalty ascending; original supplier index ascending.
- Reasonable-departure penalty is `1` for local departures from 00:00 through 04:59 and `0` otherwise. It is only a tie-breaker, never a ninth scoring dimension.

**Rationale**: This implements the ADR's category order, keeps blacklisted offers visible but not recommended, and makes equal-score output stable.

**Alternatives considered**:

- Local offer ID as final tie-breaker: rejected because opaque IDs are hash-derived and less faithful than stable supplier order.
- Filter ineligible offers out: rejected by the ADR.

## Decision 8: Add profile fields through existing ownership and CAS contracts

**Decision**: Add nullable `Json?` departure/arrival windows, `Int? maxStops`, `String? priceSensitivity`, and `Boolean? requiresCheckedBaggage` to `TravelerProfile`. Extend the existing shared profile type, update DTO, profile service allowlist, response mapper, web form, and existing revision-CAS tests. Normalize airline codes and the new enum/string values at the API boundary.

**Rationale**: The profile module already owns authentication, revision checks, atomic updates, masking, and PII-safe audit metadata. A second preferences store would duplicate ownership and consistency rules.

**Alternatives considered**:

- A separate scoring-preferences table: rejected as unnecessary one-to-one persistence and migration complexity.
- A Prisma enum for price sensitivity: rejected because the ADR specifies a nullable string and boundary validation already provides a safe additive rollout.

## Decision 9: Keep scores outside persistence and supplier cache

**Decision**: Cache only raw/provider search results under existing keys. After any cache hit or miss, load current scoring preferences and compute the response. Upsert missing `FlightOffer` and `OfferRecovery` rows for the current browser/gateway result set regardless of the raw-cache hit flag so an agent-warmed cache cannot produce unselectable browser IDs. Persist existing search history and raw offer recovery facts only; do not add score columns, tables, Redis keys, cleanup tasks, or write-behind score analytics.

**Rationale**: Scores depend on the current result set, policy version, and mutable profile. Recomputing is cheaper and safer than invalidation.

**Alternatives considered**:

- Cache by search hash plus profile revision: rejected because it expands key cardinality, complicates invalidation, and provides little value for at most 20 offers.

## Decision 10: Use additive strict contracts and a two-step rollout

**Decision**: Extend shared browser-safe Zod contracts with `mode`, nullable `matchResult`, match schemas, and summary metadata. First deploy consumers that accept both legacy responses and the new mode-tagged response, treating legacy as `RANKED`; then deploy the API producer and make mode required in the final shared contract. Provider IDs remain confined to trusted server internals and are excluded from browser and LLM projections.

**Rationale**: The current web server schema is strict, so adding top-level fields without staging would turn valid searches into `UPSTREAM_UNAVAILABLE` during rolling deployment.

**Alternatives considered**:

- Big-bang API/web deployment: rejected by the constitution's incremental delivery principle.
- Passthrough schemas: rejected because they weaken the established negative-privacy boundary.

## Decision 11: Render explanations from allowlisted keys

**Decision**: Add a web-side allowlisted formatter that maps known explanation keys and key-specific primitive parameters to user copy. Approved non-PII match facts such as offer time, window bounds, airline display name, percent-from-median, and stop counts may be rendered. Unknown keys render a generic safe fallback; backend-provided strings are never treated as HTML. `MATCHED` renders score/level/expandable breakdown and ineligibility reasons. `RANKED` renders existing objective controls and a profile-completion prompt with no personalization claim.

**Rationale**: The ADR defers localization strings but requires i18n-ready contracts. Allowlisting avoids XSS and prevents raw supplier/profile data from becoming UI copy.

**Alternatives considered**:

- Backend-rendered English explanation strings: rejected because it defeats the i18n-ready contract.

## Decision 12: Let the LLM narrate only safe precomputed facts

**Decision**: Extend the immediate attested-search response with mode, score, level, and allowlisted explanation summaries, but keep `TrustedSearchSnapshot` and every Redis value score-free. The Python tool creates a transient safe narration projection directly from the immediate gateway response before storing the existing ID-bearing/basic-flight snapshot. It performs no scoring or reordering. Persisted snapshot projections continue to exclude match facts, Duffel IDs from LLM views, user IDs, profile values, and raw offers.

**Rationale**: This preserves consistency and supports immediate narration without violating the ADR's absolute no-score-persistence rule. A later chat turn may re-search/recompute rather than reuse a stale score tied to an old profile/result set.

**Alternatives considered**:

- Send the full dimension contract including all parameters to the LLM: rejected because the agent needs narration facts, not profile-derived raw values.

## Decision 13: No new third-party dependency

**Decision**: Implement medians, clamping, circular hour distance, stable sorting, and rounding with small local pure utilities. Use existing NestJS, Prisma, Zod, Jest, Playwright, and pytest tooling.

**Rationale**: The algorithms are short, and a statistics package would add supply-chain and bundle cost without reducing implementation risk.

**Alternatives considered**: A statistics or decimal package was rejected as unnecessary for bounded normalized arithmetic at six-decimal policy precision.

## Decision 14: The submitted cabin criterion wins for the current search

**Decision**: A non-null stored `classPreference` activates the personalized cabin dimension and prefills the web search control. After submission, the normalized `query.cabinClass` is the effective comparison target for that search. When stored class preference is null, the query cabin remains a supplier filter but does not activate cabin personalization.

**Rationale**: The existing search contract always submits a cabin class. Comparing an intentional one-off business/first/economy search against a stale saved default would penalize exactly what the traveler requested. Duffel may still return mixed or downgraded segments, so cabin scoring remains useful.

**Alternatives considered**:

- Stored preference always wins: rejected because it mis-scores intentional one-off searches.
- Query cabin always activates personalization: rejected because every cold-start search carries a default cabin and would incorrectly become `MATCHED`.

## Decision 15: Score the canonical returned 20 before consumer-specific projection

**Decision**: The first 20 raw offers selected by the existing browser search cap form the canonical scoring/reference set for both consumers. The attested gateway takes the first five only after eligibility, scoring/ranking, and stable ordering.

**Rationale**: Computing gateway medians over five offers and browser medians over 20 would produce different scores for identical searches. The canonical cap also keeps policy performance bounded.

**Alternatives considered**: Scoring after each consumer cap was rejected because it violates browser/agent parity.

## Decision 16: Drop invalid offers deterministically instead of failing the search

**Decision**: The normalizer returns either a valid normalized offer or an allowlisted rejection reason. Drop offers with missing slices/segments, non-finite or negative price, invalid currency, non-positive aggregate duration, negative stops, invalid carrier/cabin/baggage structure, or unusable outbound schedule timestamps. The first valid offer in original order establishes result currency; drop later offers with another currency as `MIXED_CURRENCY`. Preserve original indices for remaining stable ties. If none remain, return an empty `MATCHED` or `RANKED` response based on the profile snapshot and record aggregate rejection counts only.

**Rationale**: One malformed supplier offer must not suppress otherwise usable search results, while cross-currency price medians are invalid. An empty successful result matches existing search semantics better than inventing a new transport error.

**Alternatives considered**:

- Fail the whole request: rejected because it reduces availability for one bad offer and the public contract has an established successful empty-result shape.
- Coerce invalid/mixed values: rejected because it breaks determinism and can mis-rank price/duration.
