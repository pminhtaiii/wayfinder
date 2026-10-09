# Feature Specification: Flight Match Scoring

**Feature Branch**: `022-flight-match-scoring`

**Created**: 2026-08-30

**Status**: Draft derived from the approved flight-match scoring ADR

**Input**: Create a deterministic flight match scoring module and the implementation plan and tasks required to deliver it, based on `docs/adr/0023-flight-match-scoring.md` and prior project decisions.

## User Scenarios & Testing

### User Story 1 - Receive deterministic personalized matches (Priority: P1)

As a signed-in traveler with at least one scoring preference, I receive flight offers ordered by a reproducible 0–100 match score so that the best fit for my profile appears first without adding LLM cost or latency.

**Why this priority**: Deterministic personalized ranking is the core product value and establishes the reusable scoring boundary required by every later surface.

**Independent Test**: Seed a traveler profile and a fixed set of offers, search twice, and verify identical eligibility, scores, match levels, active weights, breakdowns, explanations, and stable order on both runs.

**Acceptance Scenarios**:

1. **Given** a traveler with airline, cabin, schedule, baggage, stop, or price preferences and at least two eligible offers, **when** a search completes, **then** the response mode is `MATCHED`, each eligible offer has a deterministic 0–100 match result, and results default to descending match score with deterministic tie-breakers.
2. **Given** a preferred-airline match, an exact cabin match, and arrival within the preferred window, **when** the offer is scored, **then** the breakdown contains the corresponding positive signals, effective weights, contributions, and i18n-ready explanation key/parameters.
3. **Given** an offer containing a blacklisted marketing or operating carrier, **when** eligibility is evaluated, **then** the offer remains visible, is marked ineligible with `BLACKLISTED_AIRLINE`, and has `score` and `matchLevel` set to `null`.
4. **Given** a missing personalized preference or a zero-variance dimension, **when** weights are resolved, **then** weight redistribution follows the approved two-pool rules, no personalized dimension exceeds its base weight, and the effective weights for a scored offer total 100%.
5. **Given** one or more ineligible offers, **when** comparative medians and variance are calculated, **then** ineligible offers do not distort the scores of eligible offers.

---

### User Story 2 - Receive honest cold-start ranking (Priority: P2)

As a traveler with no scoring preferences, I receive a useful objective ranking without a misleading match score so that search remains valuable before I complete my profile.

**Why this priority**: Cold-start behavior covers existing and anonymous-style profiles safely while preserving the semantic meaning of a “match.”

**Independent Test**: Search with a profile containing no scoring preferences and verify `RANKED` mode, no match results, and stable ordering by stops, price, duration, then reasonable departure time.

**Acceptance Scenarios**:

1. **Given** no scoring preferences are filled, **when** search results arrive, **then** the match scorer is not invoked and the response mode is `RANKED`.
2. **Given** cold-start offers with different stops, prices, durations, and departure times, **when** they are ranked, **then** order is fewest stops, lowest price, shortest duration, reasonable departure time, and stable original order as the final tie-breaker.
3. **Given** an empty result set, **when** ranking completes, **then** the system returns an empty `RANKED` response without division errors or fabricated scoring metadata.

---

### User Story 3 - Understand and configure flight matching (Priority: P3)

As a traveler using the search page, I can maintain the supported scoring preferences and understand why a flight matched so that I can trust and improve the ranking.

**Why this priority**: Transparent explanations and profile controls turn the scoring engine into an understandable user experience rather than an opaque number.

**Independent Test**: Update the new profile fields, perform a search, and verify the MATCHED/RANKED presentation, score badge, match-level label, expandable dimension breakdown, default sorting, and privacy-safe profile prompt.

**Acceptance Scenarios**:

1. **Given** a traveler edits departure/arrival windows, maximum stops, price sensitivity, or checked-baggage requirement, **when** the profile is saved, **then** the values are validated, owner-scoped, revision-checked, and returned through the existing masked profile contract.
2. **Given** a `MATCHED` response, **when** results render, **then** eligible offers show score and level, ineligible offers show constraint reasons, and a traveler can inspect per-dimension explanations without provider identifiers or PII entering the browser contract.
3. **Given** a `RANKED` response, **when** results render, **then** no score badge or match breakdown is shown, ordinary sort controls remain available, and a profile-completion prompt is displayed.
4. **Given** a profile save with an invalid hour, unsupported price sensitivity, invalid maximum stops, or an unknown window property, **when** validation runs, **then** the update is rejected without a partial write; `start > end` remains a valid overnight window.

---

### User Story 4 - Keep agent and search-page recommendations consistent (Priority: P4)

As a traveler using chat, I receive the same deterministic ranking and safe explanations as the search page so that the assistant narrates established facts instead of independently judging flights.

**Why this priority**: Shared scoring prevents contradictory recommendations and keeps the LLM advisory, but it depends on the core search orchestration and contracts.

**Independent Test**: Submit equivalent fixed search criteria through the browser-facing and attested agent paths and verify the same mode, relative order, eligibility, scores, levels, and explanation keys after each boundary applies its permitted projection.

**Acceptance Scenarios**:

1. **Given** identical user, criteria, preferences, and Duffel offers, **when** browser and agent searches run, **then** both paths consume the same flight-search orchestration result rather than implementing separate scoring logic.
2. **Given** matched results reach the agent service, **when** the LLM-facing projection is built, **then** it contains only safe precomputed match facts and excludes user identifiers, profile values, Duffel identifiers, raw offers, and persisted score records.
3. **Given** no scoring preferences, **when** chat searches, **then** the agent receives `RANKED` mode and does not claim that the results are personalized.

### Edge Cases

- Empty, single-offer, all-ineligible, and mixed eligible/ineligible result sets.
- Equal medians, zero/invalid prices or durations, and dimensions whose normalized values are identical.
- Overnight preference windows where `start > end`, exact boundary times, invalid timestamps, and timezone-offset timestamps.
- Multi-segment and return offers with different marketing/operating carriers, cabins, and baggage allowances.
- Preferred and blacklisted airline lists containing the same code; blacklist must win.
- Profile values that are null, empty arrays, duplicated airline codes, differently cased codes, or explicitly `requiresCheckedBaggage: false`.
- Stable ordering when score and every documented tie-breaker are equal.
- Cached Duffel searches after a profile update; raw supplier caching must remain reusable while scoring is recomputed from current profile data.
- Agent-warmed raw cache followed by browser search and selection; missing local offer/recovery rows must be upserted regardless of cache-hit status.
- Existing clients temporarily receiving the pre-feature response shape during additive rollout.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST implement match scoring as a pure deterministic computation with no LLM, Prisma, HTTP, Redis, logging, or profile-loading dependency and MUST NOT mutate its inputs.
- **FR-002**: The system MUST evaluate eligibility before scoring and MUST treat any blacklisted marketing or operating airline as a `BLACKLISTED_AIRLINE` constraint violation.
- **FR-003**: Ineligible offers MUST remain visible and MUST have `score: null` and `matchLevel: null`.
- **FR-004**: Eligible offers MUST be scored across price, airline, arrival schedule, stops, cabin, departure schedule, baggage, and duration using fixed base weights of 20%, 15%, 15%, 12%, 10%, 10%, 10%, and 8% respectively.
- **FR-005**: The system MUST redistribute zero-variance weight within its original pool; missing personalized-preference weight MUST flow to the baseline pool; personalized dimensions MUST NOT exceed their base weights; effective weights for every scored result MUST total 100%.
- **FR-006**: Comparative statistics and variance MUST be calculated from eligible offers only, with explicit deterministic behavior for empty, single-offer, and all-ineligible sets.
- **FR-006A**: Malformed supplier offers MUST be dropped before the canonical scoring set with a PII-safe aggregate reason count; after the first valid offer establishes currency, offers in another currency MUST be dropped rather than compared, and an entirely invalid set MUST return a successful empty mode-tagged result.
- **FR-007**: The score contract MUST include eligibility, a 0–100 score, `STRONG`/`GOOD`/`FAIR`/`WEAK` level, dimension breakdown, scoring version, and effective weights.
- **FR-008**: Dimension explanations and constraint explanations MUST use allowlisted i18n-ready keys and key-specific typed primitive parameters. Browser explanations MAY include the approved non-PII match facts needed to explain a result (for example airline display name, offer time, window bounds, percent-from-median, or stop counts); PII, unrelated profile fields, raw supplier data, and provider identifiers MUST NOT be included.
- **FR-009**: Match levels MUST use the approved inclusive buckets: `STRONG` 75–100, `GOOD` 50–74, `FAIR` 25–49, and `WEAK` 0–24.
- **FR-010**: The scorer MUST use a versioned, centrally defined scoring policy and deterministic rounding/tie-breaking rules so the same normalized inputs produce byte-equivalent results.
- **FR-011**: Price and duration MUST be evaluated relative to the eligible result set median; stop count MUST prefer fewer stops; cabin MUST support exact and adjacent-class partial matches; schedule windows MUST handle ordinary and overnight ranges; checked-baggage requirements MUST distinguish checked baggage from carry-on-only offers.
- **FR-012**: `priceSensitivity` and `maxStops` MUST act as optional modifiers of their baseline dimensions; when absent, those dimensions MUST retain objective defaults. Either populated modifier counts as personalization for mode selection.
- **FR-013**: The system MUST add nullable `preferredDepartureWindow`, `preferredArrivalWindow`, `maxStops`, `priceSensitivity`, and `requiresCheckedBaggage` fields to the owned traveler profile through an additive Prisma migration.
- **FR-014**: Profile update/read contracts MUST validate and normalize the new fields, preserve optimistic revision concurrency, and avoid partial writes.
- **FR-015**: The flight-search orchestration layer MUST load the owned traveler preferences after obtaining cached or fresh supplier offers and MUST recompute ranking for every request without persisting match scores.
- **FR-016**: A profile with at least one effective scoring preference MUST produce `MATCHED` mode and default to eligible score descending, followed by documented stable objective tie-breakers.
- **FR-017**: A profile with no effective scoring preference MUST avoid invoking match scoring, produce `RANKED` mode, omit match results, and rank by stops, price, duration, reasonable departure time, then original order.
- **FR-018**: Raw Duffel search caching and budget enforcement MUST remain unchanged; profile-specific scores MUST NOT be written into shared search cache entries or create additional supplier calls.
- **FR-019**: The browser-safe shared contract MUST expose the ranking mode and safe optional match result while continuing to reject provider identifiers and unknown fields.
- **FR-020**: The search UI MUST render mode-specific behavior: score badges, levels, explanations, and matched default sort only in `MATCHED`; ordinary controls and a profile prompt with no score claims in `RANKED`.
- **FR-021**: The attested agent search MUST consume the same flight-search orchestration/scoring service as browser search; direct agent import or reimplementation of the scorer is forbidden.
- **FR-022**: The LLM-facing agent projection MAY narrate precomputed safe scoring facts but MUST NOT create, alter, or override eligibility, scores, levels, weights, or ordering.
- **FR-023**: Match scores MUST remain ephemeral; no score table, score cache, cleanup job, or historical score record may be introduced.
- **FR-024**: Production telemetry MUST record PII-safe mode counts, scored/ineligible offer counts, score distributions, scoring version, and scorer latency without individual offers, airline preferences, profile values, or explanation parameters.
- **FR-025**: Implementation MUST use TDD and include unit, integration, boundary/privacy, migration E2E, API E2E, web behavior, and agent parity tests because the feature changes the database, user-facing search flow, and multiple modules.

### Key Entities

- **FlightMatchPolicy**: Versioned fixed base weights, normalization constants, score buckets, deterministic rounding, and tie-break rules.
- **FlightMatchInput**: Immutable normalized supplier-independent offer facts required by eligibility and scoring.
- **ScoringPreferences**: PII-free normalized projection of the owned traveler profile fields used by scoring and cold-start detection.
- **FlightMatchResult**: Ephemeral eligibility, score, level, breakdown, and policy metadata for one offer.
- **DimensionScore**: Normalized sub-score, effective weight, contribution, signal, and safe explanation for one active dimension.
- **ConstraintViolation**: A hard eligibility failure and safe explanation, separate from scoring signals.
- **FlightSearchResponse**: Mode-tagged result set containing either matched offers or category-ranked offers.
- **TravelerProfile scoring fields**: Nullable schedule windows, stop limit, price sensitivity, and checked-baggage requirement added to the existing one-profile-per-user record.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Golden fixtures produce identical eligibility, scores, active weights, explanations, and order over 1,000 repeated executions and across browser-facing and attested-agent search paths.
- **SC-002**: Every scored eligible fixture has effective weights totaling exactly 1.000000 at policy precision and a final score within 0–100; every ineligible fixture has null score and level.
- **SC-003**: Unit tests cover all eight dimensions, all redistribution rules, all four match buckets, hard-veto precedence, ordinary/overnight windows, empty/single/all-ineligible sets, and stable ties.
- **SC-004**: Cached and uncached searches issue the same number of Duffel calls as before this feature, and no database table or Redis key stores match scores.
- **SC-005**: API and browser tests prove `MATCHED` and `RANKED` presentation semantics, profile update validation, zero provider IDs/PII in browser and LLM-facing contracts, and only key-allowlisted non-PII parameters in browser explanations.
- **SC-006**: Scorer computation remains below 20 ms p95 for 20 offers in a warmed local benchmark, excluding profile/database/supplier I/O.
- **SC-007**: Existing flight search, profile, trusted-snapshot, booking, payment, lint, typecheck, build, and applicable E2E suites remain green.

## Assumptions

- Existing authenticated profile ownership, revision CAS behavior, Duffel caching, API budget checks, opaque local offer IDs, and trusted agent snapshot lifecycle are reused.
- Airline preference values are normalized IATA carrier codes; display names are resolved outside the scorer and only safe names/codes needed by explanations are projected.
- Schedule windows use local clock hours 0–23 and may cross midnight when `start > end`; exact start and end boundaries are included.
- `requiresCheckedBaggage: null` means unspecified; `false` is an explicit preference that accepts carry-on-only and checked-bag offers equally and therefore normally collapses as zero variance.
- The profile cabin preference uses the existing four-level order: economy, premium economy, business, first.
- The implementation introduces no new third-party dependency.

## Out of Scope

- LLM-generated scores or LLM authority over ranking.
- User-adjustable scoring weights or priority sliders.
- Score persistence, historical score analytics, or per-offer scoring caches.
- Localized translation strings beyond shipping stable explanation keys and parameters.
- Price-trend prediction, fare forecasting, or new supplier calls.
- Booking, pricing, payment, ticketing, refund, or disruption state changes based on match score.
