# Progress Tracker

This file records implemented reality.

Do not mark a capability complete because it appears in architecture or planning documents. A capability is complete only when its implementation and required verification exist. Detailed historical logs and past feature verification records are archived in [progress-archive.md](../docs/history/progress-archive.md).

---

## MVP Status

Overall status:

```text
FEATURES 001–028 100% COMPLETE / FEATURE 029 PHASES 0–6 COMPLETE & CI VERIFIED (T001–T054) / PHASE 7 T055–T057 PENDING
```

The system operates on branch `codex/029-duffel-provider-narrowing`. Features 001–028 and Feature 029 Phases 0–5 are complete locally. T042 removed the legacy Duffel monolith; T058 removed global SDK/configuration/budget visibility and added a negative Nest module-composition regression. T043 passed the guarded API suite (130 suites/2,326 tests), all affected database E2Es (16 suites/145 tests), shared/static contracts, typecheck, and lint. The [Slice 5 verification record](../specs/029-duffel-provider-narrowing/slice-5-verification.md) has exact commands, exits, counts, and the scoped convergence recheck. Phases 6–7 remain pending; no remote CI success is claimed. Slice 4 and earlier history is preserved in the linked [Slice 4](../specs/029-duffel-provider-narrowing/slice-4-verification.md) and [Slice 3](../specs/029-duffel-provider-narrowing/slice-3-verification.md) records.

---

## Feature 029 — Narrow the Duffel Supplier Boundary (Active)

Phase 6 compatibility slice T044–T046 is complete locally within the approved T049/T051 deferrals. Independent task reviews and scoped convergence passed; the [Slice 6.1 verification record](../specs/029-duffel-provider-narrowing/slice-6-1-verification.md) records API 2,331, shared 111, focused web 120, and agent 1,291 passing tests. Remaining T047–T057 are pending; Feature 029 is incomplete.

Detailed phase-by-phase execution, live task checklists, and exit gates are tracked in [active-feature.md](./active-feature.md).

- [x] Phase 0: Research & Constitution Alignment
- [x] Phase 1: Setup & Behavior Baseline (T001–T004)
- [x] Phase 2: Core Foundation & Shared Rate Budget (T005–T012)
- [x] Phase 3: Search Capability Isolation (US1 Complete 🎯) (T013–T024)
- [x] Phase 4: Ancillary Capability Isolation (US2) (T025–T031 complete locally)
- [x] Phase 5: Order Capability Isolation (US3) (T032–T043; locally complete, including T058 convergence)
- [x] Phase 6: Neutral Naming & Physical Schema (US4) (T044–T054 complete & CI verified on PR #368)
- [ ] Phase 7: Final Verification & Audit (T055–T057)

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
