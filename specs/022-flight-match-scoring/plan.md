# Implementation Plan: Flight Match Scoring

**Branch**: `022-flight-match-scoring` | **Date**: 2026-08-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/022-flight-match-scoring/spec.md`, approved decisions from `docs/adr/0023-flight-match-scoring.md`, and current architecture/profile/search/agent contracts.

## Summary

Build a deterministic, versioned flight-match scoring boundary in the NestJS API and route both browser and attested-agent flight searches through one canonical search orchestrator. The pure scorer evaluates hard airline vetoes and eight fixed-weight dimensions; a separate pure category ranker handles profiles with no effective preference. Five nullable scoring fields extend the existing owner-scoped traveler profile. Search responses become explicitly `MATCHED` or `RANKED`, with strict provider-blind browser and LLM projections, mode-specific UI, aggregate telemetry, and no score persistence or new supplier calls.

The implementation reconciles the ADR's conceptual `FlightSearchModule` with the repository's existing `FlightsModule`: add an exported `FlightSearchOrchestratorService` to that module. It fetches the shared cached/raw Duffel set, caps and normalizes the canonical 20 offers, loads one profile preference snapshot, chooses mode, and ranks. `FlightsService` retains public-search validation, search-history/offer-recovery persistence, and user-search audit. `AttestedFlightSearchService` retains chat ownership, degradation checks, five-result projection, persistence, attestation, and tool audit, but delegates search/ranking to the orchestrator and caps to five only after the canonical 20-offer ranking pass.

## Technical Context

**Language/Version**: TypeScript 5.4 on Node.js 20+ for shared contracts, NestJS API, and Next.js web; Python 3.11+ for the agent service

**Primary Dependencies**: Existing NestJS 10, Prisma 5.14, class-validator/class-transformer, Zod, Next.js 14.2 App Router, React 18, Duffel client, FastAPI/Pydantic/LangGraph; no new third-party dependency

**Storage**: PostgreSQL through Prisma for five additive nullable `TravelerProfile` fields; existing raw Duffel/search persistence unchanged; Redis remains raw supplier cache/budget/trusted snapshot only; match results are never persisted

**Testing**: Jest unit/integration, shared Zod contract tests, NestJS/Supertest E2E, migration contract E2E, Node/tsx web unit tests, Playwright UI E2E, pytest/Pydantic agent tests, lint/typecheck/build, and a local deterministic scorer benchmark

**Target Platform**: Existing Linux-hosted API/web/agent services, PostgreSQL/Redis, modern browsers; Windows PowerShell verification workflow for local development

**Project Type**: pnpm monorepo with NestJS API, Next.js App Router web application, Python agent service, and shared TypeScript contracts

**Performance Goals**: Pure scorer p95 below 20 ms for 20 normalized offers on a warmed local run; no additional Duffel calls; no meaningful regression to existing search endpoint p95 beyond the owner-scoped profile read and low-millisecond computation

**Constraints**: Deterministic and LLM-free; zero scorer infrastructure dependencies; exact fixed weights and total-weight invariant; no provider IDs/PII/unallowlisted profile values in browser or LLM contracts; browser explanations permit only key-specific non-PII match facts and LLM projections are narrower; no user-specific data in shared Duffel cache; no score table/key/history; stable ranking; profile revision CAS preserved; no hardcoded hex/raw Tailwind colors

**Scale/Scope**: Existing capped 20 offers per canonical search, with the attested agent projecting the first five after ranking; eight dimensions, one hard constraint, two modes, five new nullable profile fields, four user-story slices across API/shared/web/agent

## Constitution Check

_GATE: Passed before Phase 0 research and re-checked after design._

| Principle / requirement | Design response | Result |
|---|---|---|
| I. Flight-First Architecture | Changes only traveler flight preferences, flight search ordering, flight result presentation, and agent narration. No supplementary-service dependency enters the path. | PASS |
| II. Deterministic Transaction Boundary | Scoring/ranking are pure deterministic services. The LLM consumes safe precomputed facts and cannot change booking/payment/pricing state. Scores remain advisory and never block selection. | PASS |
| III. API Budget Discipline | Scoring occurs after existing Duffel raw-cache retrieval. The duplicate query-only agent mapped cache is removed for user-specific output; call-count tests prove no new supplier calls. | PASS |
| IV. Observability | Search emits aggregate mode, version, latency, eligibility, and bucket metrics with trace/correlation context. No offer/profile/explanation parameters or PII are logged. | PASS |
| V. Incremental Delivery | Additive migration and tolerant consumers land before producers; pure scoring, browser flow, and agent flow are independently testable increments with rollback-safe contracts. | PASS |
| Security: ownership/input/data protection | JWT ownership and revision CAS guard profile writes; strict DTO/Zod/Pydantic schemas reject malformed data; provider IDs remain behind server/trusted boundaries. | PASS |
| Complexity justification | A pure scoring module plus one exported flights orchestrator removes two existing search implementations and is the minimum structure that guarantees page/agent consistency. | PASS |

### Decision-completeness gate

`research.md` fixes every formula, personalization truth rule, cabin precedence, returned-set median scope, multi-slice normalization, precision, redistribution fallback, all-ineligible behavior, and stable tie-break. No `NEEDS CLARIFICATION` remains.

### Post-design re-check

The data model, scoring-policy contract, OpenAPI contract, rollout sequence, and quickstart preserve every gate. The only persistent change is additive nullable profile state. The only new module is pure and in-process. Agent consolidation reduces external-call and policy surface area.

## Design Decisions and Codebase Reconciliation

### 1. Existing `FlightsModule` is the ADR's flight-search boundary

There is no `FlightSearchModule` today. `apps/api/src/flights/flights.module.ts` is the canonical search domain. Add and export `FlightSearchOrchestratorService` rather than create a second umbrella module. It:

1. accepts validated criteria and consumer source;
2. calls `DuffelService.searchFlights()` once or consumes its raw cache hit;
3. caps raw offers to the canonical first 20 before medians/variance;
4. maps each raw offer once to internal persisted/display facts plus `FlightMatchInput`;
5. loads one PII-free scoring preference snapshot;
6. derives personalization and effective cabin intent;
7. invokes the pure scorer or ranker;
8. returns ordered internal results, mode, raw association, cache/hash facts, profile revision, and aggregate scoring facts.

The orchestrator does not write search history, audit, gateway attestations, or trusted snapshots. Those remain consumer responsibilities.

### 2. Profile scoring projection is internal and flag-independent

`ProfileService` currently exposes a booking-readiness-flagged public API. Add an owner-scoped internal `getScoringPreferences(userId)` projection that selects only scoring fields and revision and does not call the public `FEATURE_FLAG_BOOKING_READINESS` assertion. This avoids coupling core search to the readiness UI flag. It returns an empty projection when no profile exists.

The public profile GET/PATCH contract is extended so users can maintain preferred/blacklisted airlines and the five new fields. Existing revision CAS, atomic update, no-store response, and safe changed-field audit metadata remain authoritative.

### 3. Query cabin intent overrides stored class for that search

Stored class preference determines that cabin matching is personalized and prefills the search form. Once submitted, `query.cabinClass` is the effective cabin intent for that search, preventing an intentional one-off search from being penalized against a stale saved default. If no stored class exists, query cabin remains a supplier filter but does not activate the personalized cabin dimension.

The scorer compares effective intent with the longest segment across outbound/return segments, preserving the current cabin-mismatch convention. Mixed/downgraded results can still discriminate.

### 4. Canonical set and slice semantics

- Medians and variance use the eligible subset of the canonical returned 20, not hidden Duffel offers or the gateway's later five.
- Price is total offer price. The first valid original-order offer establishes currency; malformed and later mixed-currency offers are dropped with aggregate allowlisted reason counts. An all-invalid set returns an empty mode-tagged success.
- Duration/stops use full-itinerary aggregates: sum slice durations and each slice's segment-count-minus-one. Existing display fields remain backward-compatible.
- Schedule windows apply only to outbound first departure/final arrival; one saved window is not reused for return intent.
- Airline rules evaluate every marketing/operating carrier across all slices; blacklist wins.
- Checked baggage is machine-read across each slice's longest segment; display text is never parsed.

### 5. Exact policy and degenerate sets

`contracts/scoring-policy.md` is normative. Policy v1 has fixed weights, six-decimal precision, explicit curves, and deterministic rounding. Missing/zero-variance allocation uses bounded no-recipient fallback so totals/caps both hold. Single-offer sets do not collapse every dimension. All-ineligible sets return null scores and empty breakdowns. Ineligible offers follow eligible ones and never influence comparative statistics.

### 6. Stable nullable wire shape

Every offer contains `matchResult`: populated in `MATCHED` (with null score/level inside when ineligible) and null in `RANKED`. The shared browser schema stays provider-blind. Internal API DTOs may retain `duffelOfferId` only inside the trusted web-server/checkout seam; it is stripped before the browser contract. LLM projection receives only mode, score, level, and allowlisted summarized explanations.

### 7. Additive rollout without a new runtime flag

A dedicated flag would create API/web/agent state combinations and is unnecessary for rollback:

1. Add migration/profile fields/shared schemas and consumers that accept legacy responses as `RANKED`/null while still rejecting forbidden provider fields. The tolerant web server seam lands in Phase 1 before any API producer task.
2. Deploy API producer/orchestrator/scorer and make new fields required in final contract tests.

Rollback producer first leaves tolerant consumers in RANKED. Nullable columns remain harmless; no cleanup/down migration is required.

## Implementation Phases

### Phase 1: Shared contracts and additive profile foundation

1. Extend shared traveler-profile and flight-search schemas/types, including strict negative-privacy tests, and land the tolerant web server parser before the producer.
2. Add nullable Prisma fields/migration and migration E2E proving old rows remain valid and no score storage exists.
3. Extend profile DTOs/service response/update/change tracking/internal scoring projection and tests.
4. Extend web profile contract/form so airlines and all scoring fields are owner-editable under revision CAS.

**Exit**: Fields round-trip safely; legacy and future mode-tagged search responses remain usable by the server seam; no scoring producer exists.

### Phase 2: Pure policy, eligibility, scorer, and category ranker

1. Add immutable match types, versioned policy constants, pure scorer, category ranker, and a zero-import module scaffold; register each provider only after its implementation exists.
2. Implement eligibility, all eight sub-scores, variance/redistribution, contributions, levels, and stable sorting.
3. Drive through table/golden/property-style tests covering non-mutation, formulas, hard veto, medians, precision/buckets, missing/variance/caps/totals, pool fallback, empty/single/all-ineligible, ties, overnight windows, mixed itinerary, and invalid facts.
4. Add a deterministic warmed 20-offer benchmark.

**Exit**: Pure behavior is fully defined without infrastructure mocks.

### Phase 3: Canonical flight-search orchestration and API response

1. Extract Duffel mapping into `flight-offer-normalizer.ts`, preserving deterministic local IDs/display behavior while producing exact match input.
2. Implement/export `FlightSearchOrchestratorService`; import `ProfileModule` and `FlightMatchModule` into `FlightsModule` without cycles.
3. Refactor `FlightsService.search()` to delegate, persist only existing raw/history/recovery facts, emit audit/aggregate telemetry, and return mode/results/meta.
4. Extend local DTO/controller contracts, set `Cache-Control: private, no-store` and remove `ETag` on both search route aliases, and keep detail/selection unchanged.
5. Ensure no mapped score cache exists; retain only existing raw Duffel cache/budget behavior. Upsert missing offer/recovery rows on cache hits and misses.
6. Add unit/API E2E for modes, profile snapshot, profile change on raw-cache hit, agent-warmed-cache browser selection, blacklist, ordering, 20-offer scope, no extra Duffel calls, and no score persistence.

**Exit**: Public search implements the OpenAPI contract with all existing regressions green.

### Phase 4: Transparent profile and search UI

1. Tighten the already-deployed tolerant server parser into the final required mode/match contract while preserving no-store, one POST attempt, credentials, and opaque IDs.
2. Refactor `SearchFormClient` to retain mode/result and extract focused controls/card/badge/breakdown/banner components.
3. Add allowlisted text-only explanation formatting with generic unknown-key fallback.
4. Render MATCHED score/level/breakdown/ineligibility while keeping selection enabled; render RANKED objective controls/profile prompt without score claims.
5. Extend profile form controls using semantic tokens and accessible validation.
6. Add server-boundary, characterization, explanation, and Playwright coverage at responsive widths plus privacy scans.

**Exit**: Both modes are accurate/accessibly rendered and no credential/provider/PII enters browser state, DOM, storage, URL, or bundle.

### Phase 5: Agent gateway delegation and safe narration

1. Import `FlightsModule` in `AttestedFlightSearchModule` and delegate V2/V1 search/ranking to the canonical orchestrator.
2. Retain chat ownership, degradation, tool audit, expiry, persistence, and selection attestation; take first five only after canonical ranking.
3. Remove V1 query-only mapped score cache and use Duffel raw cache.
4. Sign exact ranked order while keeping local/provider IDs trusted-only.
5. Extend gateway DTOs and create a transient Python narration projection from the immediate response. Do not add any match fact to Pydantic trusted snapshot/Redis models. Python performs no scoring/sorting.
6. Update gateway/unit/E2E, snapshot no-score-persistence, tool, graph, and parity tests.

**Exit**: Agent paths do not implement policy; attested order is canonical; safe projections contain no IDs/profile/raw parameters.

### Phase 6: Observability, regression, and documentation

1. Add bounded aggregate mode/version/latency/eligibility/bucket metrics and trace propagation assertions.
2. Add a runbook for policy rollout, alerts, cache-call invariant, rollback, privacy, and cardinality.
3. Run all quickstart gates and existing flight/profile/booking/trusted-snapshot regressions.
4. After implementation verification, update `context/architecture.md` and `context/progress-checker.md` with actual code/test evidence.

**Exit**: All gates pass, p95 target holds, no score storage/cache exists, and rollback is demonstrable.

## Requirement Traceability

| Requirements / outcomes | Owning phases | Required proof |
|---|---|---|
| FR-001–012; SC-001–003, SC-006 | Phase 2 | Pure golden/invariant/non-mutation/benchmark tests and policy contract |
| FR-013–014 | Phase 1 | Additive migration, profile DTO/service/CAS unit/API/UI tests |
| FR-015–018, FR-023–024; SC-004 | Phases 3, 6 | Orchestrator/API tests, supplier counters, no-score DB/Redis audit, aggregate metrics |
| FR-019–020; SC-005 | Phase 4 | Strict web tests, mode Playwright, explanation allowlist, browser privacy scan |
| FR-021–022; SC-001, SC-005 | Phase 5 | Delegation, attestation order, page/agent parity, Pydantic/SSE privacy tests |
| FR-025; SC-007 | All | TDD sequencing, regression matrix, lint/typecheck/build |

## Project Structure

### Documentation

```text
specs/022-flight-match-scoring/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── flight-search.openapi.yaml
│   └── scoring-policy.md
└── tasks.md
```

### Source code

```text
packages/shared/src/types/
├── flight-search.types.ts
├── flight-search.types.spec.ts
├── traveler-profile.types.ts
└── index.ts

apps/api/
├── prisma/schema.prisma
├── prisma/migrations/<timestamp>_add_flight_match_preferences/migration.sql
├── src/flight-match/
│   ├── flight-match.types.ts
│   ├── flight-match.policy.ts
│   ├── flight-match.policy.spec.ts
│   ├── flight-match-scorer.service.ts
│   ├── flight-match-scorer.service.spec.ts
│   ├── category-ranker.service.ts
│   ├── category-ranker.service.spec.ts
│   └── flight-match.module.ts
├── src/flights/
│   ├── dto/search-flight.dto.ts
│   ├── flight-offer-normalizer.ts
│   ├── flight-offer-normalizer.spec.ts
│   ├── flight-search-orchestrator.service.ts
│   ├── flight-search-orchestrator.service.spec.ts
│   ├── flights.service.ts
│   └── flights.module.ts
├── src/profile/{dto/,profile.service.ts,existing specs}
├── src/agent-gateway/{dto/,attested-flight-search/}
└── test/
    ├── traveler-profile-flight-match-migration.e2e-spec.ts
    ├── flights-match-scoring.e2e-spec.ts
    └── agent-flight-match-parity.e2e-spec.ts

apps/web/
├── app/search/{actions.ts,page.tsx}
├── components/search/
│   ├── SearchFormClient.tsx
│   ├── FlightResults.tsx
│   ├── FlightResultCard.tsx
│   ├── FlightMatchBadge.tsx
│   ├── FlightMatchBreakdown.tsx
│   ├── FlightResultsControls.tsx
│   ├── FlightRankingBanner.tsx
│   └── flight-match-explanations.ts
├── components/profile/TravelerProfileForm.tsx
├── lib/server/{flight-search.ts,flight-search.spec.ts}
├── lib/profile-contract.ts
└── tests/flight-match-scoring.spec.ts

apps/agent/
├── src/agent/tools/{nestjs_client.py,search_flights.py,flight_match_projection.py}
├── src/agent/trusted_search_snapshot/{models.py,lifecycle.py}  # remains score-free
└── tests/{test_tools.py,test_search_snapshot.py,test_trusted_search_snapshot_lifecycle.py,existing graph/SSE tests}

docs/runbooks/flight-match-scoring.md

apps/api/src/common/observability/
├── flight-match.metrics.ts
├── flight-match.metrics.spec.ts
└── flight-match-metrics.module.ts
```

**Structure Decision**: Add one pure domain module and one orchestration service inside existing flights. Extend existing boundaries; add no deployable service, package, score table, cache namespace, or LLM scorer.

## Observability Deliverables

- `flight_search_ranking_mode_total{mode}`.
- `flight_match_scoring_duration_ms{version}`.
- `flight_match_offers_total{eligibility}`.
- `flight_match_level_total{level,version}`.
- `flight_match_scoring_error_total{reason,version}` with bounded reasons.
- Logs/audits may include mode, version, counts, latency, trace/correlation IDs only; exclude offer IDs, airline/profile values, windows, sensitivity, baggage preference, explanation params, and raw offers.
- Runbook alerts cover scorer latency/errors, unexpected mode shifts, ineligible-rate spikes, and supplier cache-call regression.

## Verification Strategy

### TDD order

Each behavior follows RED → GREEN → REFACTOR. Tests are not bulk-written. Once written, `context/workflow.md` immutability rules apply.

### Unit/invariant

- Shared negative-privacy schemas; profile normalization/CAS projection; normalizer aggregation.
- Exact formulas/signals; eligibility before references; redistribution/caps/totals/remainder.
- Empty/single/all-ineligible/even median/pool collapse/bucket boundaries/stable ties.
- Category rank/red-eye; frozen input; 1,000-run repeatability.

### API/integration

- Migration defaults; owned profile fields; MATCHED/RANKED; blacklist non-blocking selection.
- Profile changes rescore the same raw cache entry; call counts/budget/persistence/audit regressions.
- Canonical 20 then agent five; attestation order equals returned order.

### Web/agent/privacy

- Tolerant rollout parser then required final contract.
- Mode rendering, sort controls, accessible breakdown, profile CTA, revision conflict.
- No unsafe explanation HTML/tokens/backend URL/provider IDs/PII or unallowlisted profile values in browser surfaces.
- Pydantic extra-forbid; no IDs/attestation/profile values in safe projections; Python preserves order and never scores.

### Performance/non-persistence

- Warm 20-offer p95 below 20 ms.
- Schema/repository and E2E DB/Redis assertions find zero score persistence.
- Supplier mock counters show no additional call for mode/profile changes.

## Dependencies and Delivery Order

```text
Shared contract + profile migration
            │
            ├──────────────┐
            ▼              ▼
Pure scorer/ranker     Profile UI fields
            │              │
            └──────┬───────┘
                   ▼
       Canonical search orchestrator
             │             │
             ▼             ▼
       Search result UI   Agent delegation
             └──────┬──────┘
                    ▼
      Observability + full regression
```

## Complexity Tracking

| Complexity | Why needed | Simpler alternative rejected because |
|---|---|---|
| Pure module + search orchestrator | Separates policy from I/O and supplies one browser/agent path. | Scoring in `FlightsService` or gateway duplicates policy and violates zero-dependency reuse. |
| Tolerant-consumer rollout | Strict web/Pydantic services may deploy separately. | Big-bang emission breaks rolling deploy/rollback; passthrough weakens privacy. |
| Bounded redistribution fallback | ADR requires zero-variance collapse, personalized caps, and exact totals. | Dropping a constraint, underweight scores, or a ninth dimension contradicts policy. |
