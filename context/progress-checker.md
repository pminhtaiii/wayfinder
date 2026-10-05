# Progress Tracker

This file records implemented reality.

Do not mark a capability complete because it appears in architecture or planning documents. A capability is complete only when its implementation and required verification exist. Detailed historical logs and past feature verification records are archived in [progress-archive.md](../docs/history/progress-archive.md).

---

## MVP Status

Overall status:

```text
FEATURES 001–028 100% COMPLETE / FEATURE 029 COMPLETE / FINAL-SOURCE CI PASSED / T093 ACCEPTANCE PASSED; LOCAL API PARTIAL
```

Feature 029 was developed on `codex/029-duffel-provider-narrowing` and PR [#371](https://github.com/pminhtaiii/wayfinder/pull/371) merged into `development` at `8efbfc5aff4eea7179ef83529d11898b7e8477fb`. Exact-source CI run [37278447237](https://github.com/pminhtaiii/wayfinder/actions/runs/37278447237) passed on source HEAD `791947c365c95e2721893c90cc3d92a433938117`; the API unit job passed 135/135 suites, including the database-backed supplier-sync suite, and API E2E passed 71/71 suites. The local T055 API invocation remains partial at 134/135 suites and 2,367/2,385 tests; remote CI covers the omitted suite but does not change the local result. Earlier Slice 6.2 verification remains recorded under PR [#370](https://github.com/pminhtaiii/wayfinder/pull/370), run [37188540602](https://github.com/pminhtaiii/wayfinder/actions/runs/37188540602), source `551c3890cd37f65ded2adf900244fc9ca0d76dd8`. PR #368 closed without merging; PRs #369 and #370 are historical merged slices.

---

## Feature 029 — Narrow the Duffel Supplier Boundary (Complete)

Feature 029 implementation tasks T001–T057 and convergence tasks T058–T067 are complete and merged. The boundary census found zero unexplained runtime hits. T093 full real-flow Playwright acceptance passed with exit code 0: one Chromium test completed in 4.9 minutes against a fresh disposable database after 25 migrations and seeding 4,562 airports, including SGN and HAN. The documented timeout values were set in the Playwright process, application source and test assertions were unchanged, and only runner-owned PostgreSQL and Redis containers were stopped. Exact-final-source CI run [37278447237](https://github.com/pminhtaiii/wayfinder/actions/runs/37278447237) passed the API unit job (135/135 suites, including the database-backed supplier-sync suite) and API E2E job (71/71 suites). The local API run remains partial (134/135 suites, 2,367/2,385 tests); remote CI provides coverage for the omitted suite without changing the local result. Feature 029 acceptance is complete. See the [Feature 029 verification record](../specs/029-duffel-provider-narrowing/verification.md) for the final T093 result and historical attempts.

Feature 030 has not been specified or selected. Next-feature planning waits only for user selection. No backlog item or second supplier has been selected.

Detailed phase-by-phase execution, live task checklists, and exit gates are tracked in [active-feature.md](./active-feature.md).

- [x] Phase 0: Research & Constitution Alignment
- [x] Phase 1: Setup & Behavior Baseline (T001–T004)
- [x] Phase 2: Core Foundation & Shared Rate Budget (T005–T012)
- [x] Phase 3: Search Capability Isolation (US1 Complete 🎯) (T013–T024)
- [x] Phase 4: Ancillary Capability Isolation (US2) (T025–T031 complete locally)
- [x] Phase 5: Order Capability Isolation (US3) (T032–T043; locally complete, including T058 convergence)
- [x] Phase 6: Neutral Naming & Physical Schema (US4) (T044–T054 complete & CI verified on PR #370, run `37188540602`)
- [x] Phase 8: Convergence — Non-Global Core Module (T058)
- [x] Phase 9: Convergence — Boundary Census & Gate Remediation (T059–T067)
- [x] Phase 7: Final Verification & Audit (T055–T057 evidence recorded; PR #371 merged and exact-source CI passed; T093 real-flow acceptance passed)

Exit gate:
```text
all planned feature phases and convergence tasks pass required exit gates; see active-feature.md for live checkpoints
```

---

## Feature 028 — Backend Client Unification

- [x] Define single-owner server-side transport contract in `apps/web/lib/server/backend-client.ts`.
- [x] Implement `createBackendClient` factory with default and injected token resolution.
- [x] Implement GET retry matrix: up to 3 attempts within 31s deadline for transient 502/503/504 and 429.
- [x] Implement strict single-send guarantee for all mutations (`POST`, `PUT`, `PATCH`, `DELETE`).
- [x] Migrate dashboard summary operations to `backendClient.request` (US1).
- [x] Migrate flight search and offer selection operations to `backendClient.request` (US2).
- [x] Migrate 8 booking management operations to `backendClient.request` (US3).
- [x] Create `outcome-response.ts` as the sole booking `BookingManagementOutcome` -> `NextResponse` mapper (US4).
- [x] Decommission bespoke `fetchWithRetry` shims and orphaned transport helpers across web server code.
- [x] Complete web production build and Playwright validation (241/241 focused tests passed).

Exit gate:
```text
pnpm --filter @web/frontend lint
pnpm --filter @web/frontend typecheck
pnpm --filter @web/frontend build
241/241 tests passed; exactly 1 mapOutcomeToResponse match
```

---

## Feature 027 — Chat Turn Decomposition

- [x] Relocate SSE transport serialization to `apps/agent/src/agent/streaming/sse.py`.
- [x] Establish pure Pydantic domain event models in `apps/agent/src/agent/chat_turn/events.py`.
- [x] Lock synthetic graph behavior baseline fixtures in `tests/test_chat_turn_runner.py`.
- [x] Extract `ToolResultResolver` mapping validated results to typed resolutions (US1).
- [x] Extract `GraphEventInterpreter` translating LangGraph streams to domain events (US1).
- [x] Extract `ConversationMemory` with guardrail scanning and compaction scheduling (US2).
- [x] Extract `AdmissionContext` and admission policy pipeline (US3).
- [x] Integrate unified `ChatTurnRunner` with 4-step causal failure cleanup (US4).
- [x] Verify wire compatibility byte-for-byte across all 8 canonical SSE events.
- [x] Pass 184 decomposition tests and 1,272 non-Redis regression tests.

Exit gate:
```text
ruff check --fix apps/agent
ruff format --check apps/agent
pytest tests/test_chat_turn*.py (184 passed, 0 failed)
```

---

## Feature 026 — Agent Boundary Simplification

- [x] Simplify attested flight search contract to pure DTO inputs in `AttestedFlightSearchModule`.
- [x] Rewire Agent Gateway to delegate flight searches to domain `FlightsService`.
- [x] Eliminate direct Duffel SDK calls and redundant database writes from agent gateway.
- [x] Bind selection attestation HMAC signatures strictly to chat sessions with deterministic UUIDs.
- [x] Verify parity between web search and agent gateway search responses.

Exit gate:
```text
agent-flight-match-parity.e2e-spec.ts passed; zero direct duffel calls in agent gateway
```

---

## Feature 025 — Booking Umbrella Deletion

- [x] Decompose monolithic `BookingService` facade into focused capability submodules.
- [x] Extract `BookingManagementModule` with isolated controller, service, and DTOs (US1).
- [x] Extract `BookingLifecycleModule` and `BookingCancellationModule` (US2 & US3).
- [x] Delete `BookingService` facade and cut over all feature callers (US4).
- [x] Verify zero cyclic dependencies and full test parity across all booking domains.

Exit gate:
```text
BookingService facade deleted; zero circular imports; 39/39 tasks verified
```

---

## Feature 024 — Event-Driven Module Deepening

- [x] Define behavior-free passive domain event DTO envelopes.
- [x] Configure single-root `EventEmitterModule` once in `AppModule`.
- [x] Implement transactional post-commit event dispatch hooks (no uncommitted emits).
- [x] Implement async listener isolation with local exception trapping.
- [x] Verify event delivery and idempotency across booking, payment, and notification flows.

Exit gate:
```text
domain events emit strictly after commit; zero listener failure cascades
```

---

## Feature 023 — Security Systems

- [x] Implement centralized output guardrails and PII sanitization in Python agent.
- [x] Implement HMAC token attestation and Gateway authentication checks.
- [x] Implement `AgentToolAuditService` recording structured audit logs for tool dispatches.
- [x] Integrate Gitleaks and dependency vulnerability auditing into CI pipeline.
- [x] Author runtime penetration and fuzzing test suites for hostile payload rejection.
- [x] Verify fail-closed rate limiters, token expiration handling, and boundary enforcement.

Exit gate:
```text
gitleaks detect --no-git --verbose passed; security test matrix 100% green
```

---

## Feature 022 — Flight Match Scoring

- [x] Define flight match scoring domain port and criteria models.
- [x] Implement multi-factor scoring engine (airline preference, stops, timing, cabin, price).
- [x] Implement personalized ranking pipeline with deterministic tie-breaking.
- [x] Build Next.js match score UI badges, breakdown disclosures, and preference controls.
- [x] Implement agent gateway score narration projection without exposing internal IDs.
- [x] Verify full-stack parity and performance benchmarks (<10ms p95 scoring latency).

Exit gate:
```text
flight-match-scoring.spec.ts passed; agent-flight-match-parity E2E passed
```

---

## Core Platform Foundation (Features 001–021)

- [x] Feature 021: Authenticated booking management dashboard (Next.js & NestJS).
- [x] Feature 020: Whole-stack smoke and sanity CI pipeline with deterministic mocks.
- [x] Feature 019: Architecture deepening, settlement ledger, and trusted search snapshots.
- [x] Feature 018: Pull-request multi-job GitHub Actions CI/CD workflow.
- [x] Feature 017: Chatbot backend infrastructure, SSE streaming, and handoff tokens.
- [x] Feature 016: Traveler profile storage and booking readiness validation.
- [x] Feature 015: Ancillary services catalog, seat maps, baggage, and checkout.
- [x] Feature 014: Disruption monitoring, flight change notifications, and auto-sync.
- [x] Feature 012: Flight cancellation and automated refund ledger settlement.
- [x] Feature 011: Booking management, itinerary retrieval, and status tracking.
- [x] Feature 010: Stripe payment processing, webhook idempotency, and hold capture.
- [x] Feature 009: Booking intent foundation and state lifecycle machine.
- [x] Feature 008: Cabin class selection and multi-passenger search enhancement.
- [x] Feature 006: Duffel flight search service setup and API proxying.
- [x] Features 001–005: PostgreSQL Prisma initialization, JWT auth, LangGraph agent, LLM guardrails, Mapbox.

Exit gate:
```text
monorepo builds clean; all 120+ test suites pass; core user journey functional
```

---

## Deferred Backlog

- [ ] Second flight supplier integration (Sabre / Amadeus adapter implementations).
- [ ] Multi-city flight search support.
- [ ] Real-time flight tracking radar view.
- [ ] Push notification service (WebPush / APNs integration).
- [ ] Automated flight disruption rebooking recommendation engine.
- [ ] Hotel and car rental bundle capabilities.
- [ ] Loyalty points and rewards accrual system.

---

## Final Quality & Release Acceptance Checklist

- [ ] All local packages pass linting without warnings (`pnpm lint`).
- [ ] All TypeScript projects compile clean without errors (`tsc --noEmit`).
- [ ] Monorepo unit and contract test suites pass 100% (`pnpm test`).
- [ ] End-to-end integration test suites pass against local docker test services.
- [ ] Zero unhandled promises or process warnings during test teardown.
- [ ] Security scans pass (zero secret leaks, zero high/critical dependency CVEs).
- [ ] GitHub Actions remote workflow runs 100% green before branch merge.
- [ ] Documentation in `context/` reflects implemented reality.
