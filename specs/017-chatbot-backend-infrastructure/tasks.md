# Tasks: Chatbot Backend Infrastructure and Booking Handoff

**Input**: Design documents from `/specs/017-chatbot-backend-infrastructure/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/api.md`, `quickstart.md`

**Tests**: Required by FR-039/FR-040 and the repository workflow. Within each story, write the listed public-boundary tests first, run them to confirm RED, then implement and refactor while keeping all prior suites green.

**Organization**: Setup and foundational work establish shared contracts, encrypted/additive storage, and four separately gated Redis capabilities. Each later phase is one independently testable user story. The plan's seventeen delivery slices are mapped through 1–3 task work packages and explicit GREEN checkpoints below.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it owns different files and has no dependency on an incomplete task in the same phase.
- **[US1]–[US5]**: Maps the task to a user story in `spec.md`.
- Every task names the exact target file(s).

## Phase 1: Setup — Contract and Configuration Freeze

**Purpose**: Add inert contracts, dependency declarations, and disabled-by-default configuration without changing live behavior.

- [x] T001 Add the direct `langgraph` and asyncio `redis` dependencies and refresh the lockfile in `apps/agent/pyproject.toml` and `apps/agent/uv.lock`
- [x] T002 Document the approved Python Redis/LangGraph usage constraints and dependency rationale in `context/library-docs.md`
- [x] T003 [P] Write failing cross-language accepted/rejected event contract tests and fixtures in `apps/agent/tests/test_event_contracts.py`, `apps/agent/tests/fixtures/chat_events.json`, and `packages/shared/src/types/chat.types.spec.ts`
- [x] T004 [P] Write failing canonical JWT profile and disabled-default/invalid flag, encryption-key, attestation-key, and claim-TTL configuration tests in `apps/api/src/auth/auth.service.spec.ts`, `apps/agent/tests/test_config.py`, `apps/api/src/chat-handoff/chat-handoff.config.spec.ts`, and `apps/web/lib/featureFlags.spec.ts`
- [x] T005 [P] Define strict shared Router, booking projection, SSE action, and handoff error types in `packages/shared/src/types/chat.types.ts` and export them from `packages/shared/src/types/index.ts`
- [x] T006 [P] Define matching strict Pydantic route and event models in `apps/agent/src/agent/models/events.py` and `apps/agent/src/agent/models/requests.py`
- [x] T007 Add agent Redis/quota/router/snapshot/direct-stream settings, NestJS JWT/encryption/attestation/handoff accept/issue/token/claim settings, and web direct-stream/bootstrap settings with disabled defaults in `apps/agent/src/agent/config.py`, `apps/agent/.env.example`, `apps/api/src/app.module.ts`, `apps/api/.env.example`, `apps/web/lib/featureFlags.ts`, and `apps/web/.env.example`
- [x] T008 Run the new contract/config tests and shared builds, confirm GREEN with every rollout flag off, and record the contract-freeze checkpoint in `specs/017-chatbot-backend-infrastructure/quickstart.md`

**Checkpoint**: Shared contracts compile; all new flags default off; runtime behavior is unchanged.

### Setup Work Packages and Stop Points

1. **1A — Dependencies/rules (2 tasks)**: T001–T002. Stop after lockfile and project-specific usage rules review.
2. **1B — RED contracts/config (2 tasks)**: T003–T004. Confirm the cross-language/JWT/config suites fail for the intended missing behavior.
3. **1C — GREEN contracts/config (3 tasks)**: T005–T007. Stop after strict schemas compile and all flags remain off.
4. **1D — Freeze checkpoint (1 task)**: T008. Record exact green commands before runtime work.

---

## Phase 2: Foundational — Additive Storage and Redis Primitives

**Purpose**: Build blocking infrastructure used by every story before changing orchestration.

**⚠️ CRITICAL**: No user-story runtime cutover begins until this phase passes its focused tests.

### Work Package 2A — Redis Lifecycle and Health

- [x] T009 [P] Write failing Redis lifecycle and health tests in `apps/agent/tests/test_redis_infrastructure.py`
- [x] T010 Implement one pooled asyncio Redis client with startup/close semantics in `apps/agent/src/agent/infrastructure/redis.py`
- [x] T011 Wire Redis lifecycle/dependency health in `apps/agent/src/agent/main.py`, run T009 to GREEN, and record Checkpoint 2A in `specs/017-chatbot-backend-infrastructure/quickstart.md`

**Checkpoint 2A**: Redis startup, shutdown, and degraded health are green.

### Work Package 2B — Atomic Daily/Burst Admission

- [x] T012 [P] Write failing one-Lua daily/burst admission tests covering concurrency, rejected-attempt non-charging, UTC rollover/TTL, and Redis fail-closed behavior in `apps/agent/tests/test_chat_budget.py`
- [x] T013 Implement the versioned combined Lua admission contract and exact key/error semantics in `apps/agent/src/agent/repositories/chat_budget_repository.py`, run T012 to GREEN, and record Checkpoint 2B in `specs/017-chatbot-backend-infrastructure/quickstart.md`

**Checkpoint 2B**: Burst and daily limits form one atomic accepted-only charge.

### Work Package 2C — Fenced Session Lease

- [x] T014 [P] Write failing acquire/refresh/release/takeover tests proving TTL overrun, refresh loss, and disconnect cannot let a stale fencing owner persist or emit in `apps/agent/tests/test_session_lock.py`
- [x] T015 Implement monotonic fenced leases, refresh-loss cancellation, bounded wait/depth, and write-fence propagation in `apps/agent/src/agent/repositories/session_lock_repository.py` and `apps/agent/src/agent/queue/message_queue.py`, then run T014 to GREEN

**Checkpoint 2C**: A stale worker cannot perform a durable write or emit `ACTION_HANDOFF`.

### Work Package 2D — Trusted Snapshot Repository

- [x] T016 [P] Write failing attested Trusted Search Snapshot schema, owner/session, overwrite, TTL, fingerprint, and forbidden-field tests in `apps/agent/tests/test_trusted_snapshot.py`
- [x] T017 Implement strict PII-free attested snapshot serialization, atomic replace/load/delete in `apps/agent/src/agent/repositories/trusted_snapshot_repository.py`
- [x] T018 Run T016 plus Redis regressions to GREEN and record Checkpoint 2D in `specs/017-chatbot-backend-infrastructure/quickstart.md`

**Checkpoint 2D**: The service-only attestation and identifiers restore only inside the correct owner/session boundary.

### Work Package 2E — Encrypted/Additive Prisma Foundation

- [x] T019 [P] Write failing migration/backfill tests for AES-GCM ChatMessage/ChatSession-title dual-write completeness and cleanup preconditions, ChatSession soft deletion, BookingAgentProjection, and ChatHandoff claim/attestation constraints in `apps/api/test/chat-persistence-migration.e2e-spec.ts` and `apps/api/test/chat-handoff-migration.e2e-spec.ts`
- [x] T020 Add encrypted ChatMessage content and ChatSession title fields, `ChatSession.deletedAt`, `BookingAgentProjection`, and claimed `ChatHandoff` relations/indexes/check constraints in `apps/api/prisma/schema.prisma`
- [x] T021 Create the additive dual-write migration and restart-safe encrypted-message/title/projection backfills in `apps/api/prisma/migrations/20260805000000_chatbot_handoff/migration.sql`, `apps/api/prisma/scripts/backfill-encrypted-chat-messages.ts`, and `apps/api/prisma/scripts/backfill-booking-agent-projections.ts`, then run T019 to GREEN while retaining all legacy plaintext

**Checkpoint 2E**: Additive schema/backfills are rollback-safe, every migrated message decrypts, and projection rows are complete.

### Work Package 2F — Inert Domain Skeletons

- [x] T022 Create the versioned AES-GCM chat crypto service plus handoff module/controller/service/strict DTO skeleton in `apps/api/src/chat/chat-message-crypto.service.ts`, `apps/api/src/chat-handoff/chat-handoff.module.ts`, `apps/api/src/chat-handoff/chat-handoff.controller.ts`, `apps/api/src/chat-handoff/chat-handoff.service.ts`, and `apps/api/src/chat-handoff/dto/create-chat-handoff.dto.ts`
- [x] T023 Register the crypto and `ChatHandoffModule` providers with every new route/flag inert in `apps/api/src/chat/chat.module.ts` and `apps/api/src/app.module.ts`
- [x] T024 Run dual-read/dual-write-capable crypto, backfill, migration, shared build, database/backup scan fixture, and rollback tests while retaining the legacy plaintext column; record the additive Checkpoint 2F in `specs/017-chatbot-backend-infrastructure/quickstart.md`

**Checkpoint**: Redis primitives are atomic and PII-free; additive schema is valid; no chatbot path has cut over.

---

## Phase 3: User Story 1 — Secure, Budgeted Conversation (Priority: P1) 🎯 MVP

**Goal**: Provide owned, guarded, persisted chat with cross-instance daily/burst limits and session serialization, while preparing the direct FastAPI transport.

**Independent Test**: Open an authenticated stream, resume its owned history, reject cross-owner access, and prove the 51st default daily request returns 429 before every model/tool spy; then simulate Redis failure and confirm fail-closed behavior.

### Tests for User Story 1

- [x] T025 [P] [US1] Write failing tests using real Nest AuthService tokens for required `sub`/`iss`/`aud`/`jti`, legacy `id` transition, logout revocation, user deactivation, origin/quota ordering, cross-user isolation, and zero-inference/persistence on denial in `apps/api/src/auth/auth.service.spec.ts` and `apps/agent/tests/test_stream_auth_budget.py`
- [x] T026 [P] [US1] Write failing two-instance burst and daily-limit integration tests in `apps/agent/tests/test_rate_limit.py`
- [x] T027 [P] [US1] Write failing session ownership, distributed serialization, TTL overrun, refresh-loss, disconnect/shielded-persistence, and stale-fence rejection tests in `apps/agent/tests/test_stream_session_control.py` and `apps/api/test/agent-chat-gateway.e2e-spec.ts`
- [x] T028 [P] [US1] Write failing encrypted completed-turn/summary/title persistence, browser AGENT/title injection, rotation/backfill, soft-delete, and restart/resume tests in `apps/agent/tests/test_streaming_agent.py`, `apps/api/src/chat/chat-message-crypto.service.spec.ts`, and `apps/api/test/agent-chat-gateway.e2e-spec.ts`
- [x] T029 [P] [US1] Write failing FastAPI CORS/preflight and direct bearer-stream contract tests in `apps/agent/tests/test_direct_stream.py`

### Implementation for User Story 1

- [x] T030 [US1] Replace the in-process rate-limit dictionary with the combined accepted-only Redis admission contract and stable errors in `apps/agent/src/agent/middleware/rate_limit.py`
- [x] T031 [US1] Replace in-process conversation locking with fenced `SessionLockRepository`, cancel on refresh loss, and revalidate the fence before persistence/action emission in `apps/agent/src/agent/queue/message_queue.py` and `apps/agent/src/agent/streaming/sse.py`
- [x] T032 [US1] Issue/validate the canonical JWT profile and enforce JWT → NestJS active/revoked access check → quota → fenced owned session → input safety before inference/persistence in `apps/api/src/auth/auth.service.ts`, `apps/agent/src/agent/middleware/auth.py`, `apps/agent/src/agent/streaming/sse.py`, and `apps/agent/src/agent/sanitization/pii_scrubber.py`
- [x] T033 [US1] Add service-authenticated chat access/session/memory/completed-turn/summary endpoints, force browser writes to USER/STANDARD, reject stale fencing tokens, and migrate every agent call off raw browser JWT endpoints in `apps/api/src/agent-gateway/agent-gateway.controller.ts`, `apps/api/src/agent-gateway/agent-gateway.service.ts`, `apps/api/src/chat/chat.controller.ts`, `apps/api/src/chat/chat.service.ts`, and `apps/agent/src/agent/tools/nestjs_client.py`
- [x] T034 [US1] Dual-read/dual-write encrypted completed turns, summaries, and session titles with versioned record-bound AES-GCM while retaining legacy rollback columns; preserve controlled summaries and implement soft-delete/revocation/retention in `apps/api/src/chat/chat-message-crypto.service.ts`, `apps/api/src/chat/chat.service.ts`, `apps/agent/src/agent/memory/manager.py`, and `apps/agent/src/agent/main.py`
- [x] T035 [US1] Implement strict configured-origin CORS and explicit origin rejection with exact methods/headers, `allow_credentials=False`, CORS headers on auth errors, plus Redis/quota degradation health in `apps/agent/src/agent/main.py` and `apps/agent/src/agent/streaming/sse.py`
- [x] T036 [US1] Add strict bearer-token direct-stream support and correlation headers in `apps/web/lib/chatStream.ts` while keeping proxy fallback behind the disabled direct flag
- [x] T037 [US1] Retain the `done.sessionId` value across turns and prevent empty-session recreation in `apps/web/components/chat/ChatWidget.tsx`
- [x] T038 [US1] Run US1 focused tests and the existing auth/memory/queue/guardrail regression suites, then record the checkpoint in `specs/017-chatbot-backend-infrastructure/quickstart.md`

**Checkpoint**: US1 works independently with the existing assistant behavior; quota denial incurs zero model cost and direct-server readiness is proven without client cutover.

### US1 Work Packages and Stop Points

1. **3A — Canonical auth/access ordering (2 tasks)**: T025 and T032. Stop after real-token, revocation, deactivation, and pre-cost denial tests pass.
2. **3B — Atomic admission integration (2 tasks)**: T026 and T030. Stop after two-instance accepted-only charge tests pass.
3. **3C — Fenced turn ownership (2 tasks)**: T027 and T031. Stop after stale-worker write/action rejection passes.
4. **3D — Encrypted service-auth persistence (3 tasks)**: T028, T033, and T034. Stop after forged-AGENT, rotation/backfill, soft-delete, and restart tests pass while legacy plaintext remains rollback-compatible.
5. **3E — Direct-server readiness (3 tasks)**: T029, T035, and T036. Stop with the client flag off after CORS/auth/health/direct-library tests pass.
6. **3F — Session continuity checkpoint (2 tasks)**: T037–T038. Stop after widget reuse plus all prior US1 regressions are green.

---

## Phase 4: User Story 2 — Correct Specialist Routing and Read-Only Travel Help (Priority: P2)

**Goal**: Replace the monolithic graph with the accepted Router, General, Travel, Checkout, and deterministic node topology while keeping every LLM capability read-only.

**Independent Test**: Feed a maintained route fixture matrix through a stubbed Router and prove exact specialist selection, disambiguation, strict tool inventories, latest-search semantics, and no checkout execution for any incomplete gate.

### Tests for User Story 2

- [x] T039 [P] [US2] Write failing strict Router output and malformed/unknown/confidence-bound tests in `apps/agent/tests/test_router.py`
- [x] T040 [P] [US2] Write failing checkout-gate and `possible_checkout` disambiguation matrix tests in `apps/agent/tests/test_checkout_gate.py`
- [x] T041 [P] [US2] Replace old confirmation graph tests with failing node/topology/tool-scope tests in `apps/agent/tests/test_graph.py`
- [x] T042 [P] [US2] Write failing versioned POST owned-session/proposed-version, signed ordered-offer attestation, legacy-GET non-enrichment, snapshot overwrite/expiry, and identifier/attestation non-exposure tests in `apps/agent/tests/test_search_snapshot.py`, `apps/api/src/agent-gateway/selection-attestation.service.spec.ts`, and `apps/api/test/agent-gateway.e2e-spec.ts`
- [x] T043 [P] [US2] Write failing exact General/Travel/Checkout registry tests in `apps/agent/tests/test_tools.py`

### Implementation for User Story 2

- [x] T044 [P] [US2] Implement the tool-free General-Purpose Agent prompt/model adapter in `apps/agent/src/agent/agents/general_agent.py`
- [x] T045 [P] [US2] Implement the five-read-tool Travel Assistant prompt/model adapter with disambiguation metadata in `apps/agent/src/agent/agents/travel_assistant.py`
- [x] T046 [P] [US2] Implement the one-signal-tool Checkout Orchestrator prompt/model adapter in `apps/agent/src/agent/agents/checkout_orchestrator.py`
- [x] T047 [US2] Implement strict Router model invocation and safe fallback normalization in `apps/agent/src/agent/graph/router.py`
- [x] T048 [US2] Replace AgentState confirmation fields with typed route, disambiguation, snapshot, signal, and action fields in `apps/agent/src/agent/graph/state.py`
- [x] T049 [US2] Implement opt-in `POST /api/agent-gateway/v2/flights/search` with owned session/proposed version and its stripping consumer, store the signed ordered-offer attestation only in Redis, emit identifier/attestation-free projections, and leave legacy GET byte-for-byte unchanged in `apps/api/src/agent-gateway/dto/attested-flight-search.dto.ts`, `apps/api/src/agent-gateway/agent-gateway.controller.ts`, `apps/api/src/agent-gateway/agent-gateway.service.ts`, `apps/agent/src/agent/tools/search_flights.py`, and `apps/agent/src/agent/tools/nestjs_client.py`
- [x] T050 [US2] Replace the global registry with immutable per-agent registries and remove `book_flight` in `apps/agent/src/agent/tools/registry.py`
- [x] T051 [US2] Rebuild the single LangGraph topology without `MemorySaver`, confirm node, interrupt, or resume path in `apps/agent/src/agent/graph/graph.py` and `apps/agent/src/agent/graph/nodes.py`
- [x] T052 [US2] Integrate Router/specialist event streaming and safe disambiguation into `apps/agent/src/agent/streaming/sse.py`, then run US2 and existing output-guardrail regressions

**Checkpoint**: US2 is independently demonstrable; all messages reach one expected specialist, no LLM has a write tool, and legacy sessions without snapshots safely request a new search.

### US2 Work Packages and Stop Points

1. **4A — Router schema/fallback (2 tasks)**: T039 and T047. Stop after malformed/unknown output fails safe.
2. **4B — Checkout gate/state (2 tasks)**: T040 and T048. Stop after every incomplete gate disambiguates.
3. **4C — Graph topology/removal (3 tasks)**: T041, T050, and T051. Stop after fake booking/confirmation/checkpointer paths are absent.
4. **4D — Signed search split (2 tasks)**: T042 and T049. Stop after attestation/snapshot isolation and non-exposure pass.
5. **4E — General/Travel inventory (3 tasks)**: T043–T045. Stop after exact no-tool/five-tool construction passes.
6. **4F — Checkout adapter/integration (2 tasks)**: T046 and T052. Stop after specialist streaming and guardrail regressions pass with issuance off.

---

## Phase 5: User Story 3 — Privacy-Minimized Booking Answers (Priority: P3)

**Goal**: Replace the broad booking list tool with exact summary and explicit-detail tiers using an opaque non-database reference.

**Independent Test**: List owned booking summaries, fetch explicit detail by opaque reference, and prove exact allowlisted keys plus identical safe not-found behavior for missing/foreign references.

### Tests for User Story 3

- [x] T053 [P] [US3] Write failing BookingAgentProjection confirmation/cancellation/supplier-sync/disruption-reconciliation/backfill/reference/owner tests in `apps/api/src/agent-gateway/booking-agent-projection.service.spec.ts`, `apps/api/src/disruption/sync/supplier-sync.service.spec.ts`, `apps/api/src/disruption/sync/reconciliation.service.spec.ts`, and `apps/api/src/disruption/webhook/duffel-event.processor.spec.ts`
- [x] T054 [P] [US3] Write failing exact-key summary/detail query tests with forbidden-field corpus and spies proving no broad Booking/passenger/provider snapshots load in `apps/api/src/agent-gateway/agent-gateway.service.spec.ts`
- [x] T055 [P] [US3] Write failing authenticated summary/detail and cross-owner E2E tests in `apps/api/test/agent-gateway.e2e-spec.ts`
- [x] T056 [P] [US3] Write failing Python summary/detail formatting, reference validation, and error-degradation tests in `apps/agent/tests/test_booking_tools.py`

### Implementation for User Story 3

- [x] T057 [US3] Implement restart-safe projection/reference backfill and verification in `apps/api/prisma/scripts/backfill-booking-agent-projections.ts`
- [x] T058 [US3] Implement strict summary/detail DTOs in `apps/api/src/agent-gateway/dto/booking-summary.dto.ts` and `apps/api/src/agent-gateway/dto/booking-detail.dto.ts`
- [x] T059 [US3] Implement transactional projection population/update at payment/webhook confirmation, cancellation, Duffel event processing, supplier sync, and reconciliation plus owner-scoped opaque lookup in `apps/api/src/agent-gateway/booking-agent-projection.service.ts`, `apps/api/src/payment/payment.service.ts`, `apps/api/src/payment/payment-webhook.service.ts`, `apps/api/src/booking/booking.service.ts`, `apps/api/src/disruption/webhook/duffel-event.processor.ts`, `apps/api/src/disruption/sync/supplier-sync.service.ts`, and `apps/api/src/disruption/sync/reconciliation.service.ts`
- [x] T060 [US3] Replace broad booking snapshot logic with exact BookingAgentProjection-only summary/detail selects in `apps/api/src/agent-gateway/agent-gateway.service.ts`
- [x] T061 [US3] Expose service-authenticated summary and detail routes in `apps/api/src/agent-gateway/agent-gateway.controller.ts`
- [x] T062 [P] [US3] Implement `list_user_booking_summaries` in `apps/agent/src/agent/tools/booking_summaries.py`
- [x] T063 [P] [US3] Implement `get_booking_detail` in `apps/agent/src/agent/tools/booking_detail.py`, remove `list_user_bookings` from the enabled registry, and run US3 gateway/tool privacy suites

**Checkpoint**: US3 works independently; the default tool exposes logistics only and explicit detail adds only flight number, baggage, and fare-condition booleans.

### US3 Work Packages and Stop Points

1. **5A — Projection lifecycle (3 tasks)**: T053, T057, and T059. Stop after confirmation/update/backfill/owner tests pass.
2. **5B — Exact query boundary (3 tasks)**: T054, T058, and T060. Stop after no-raw-snapshot-load and exact-key tests pass.
3. **5C — Authenticated routes (2 tasks)**: T055 and T061. Stop after cross-owner E2E returns the safe not-found shape.
4. **5D — Python read tools (3 tasks)**: T056, T062, and T063. Stop after formatting/degradation/privacy suites pass.

---

## Phase 6: User Story 4 — Deterministic Checkout Handoff (Priority: P4)

**Goal**: Turn explicit selection from the latest search into a deterministic, owner/session-bound, short-lived, single-use checkout credential and strict `ACTION_HANDOFF` card without giving the LLM a write capability.

**Independent Test**: Search, explicitly select, receive an action event, resolve as owner, and consume atomically with canonical intent creation; prove ambiguity, stale state, expiry, replay, duplicate retry, and cross-owner/session cases have zero transactional/supplier side effects.

### Pre-implementation Gates and Tests for User Story 4

- [x] T064 [P] [US4] Write failing state-only checkout-signal/no-I/O tests in `apps/agent/tests/test_checkout_signal.py`
- [x] T065 [P] [US4] Write failing selection-attestation verification, server-derived idempotency, token derivation/hash-only/key-version/expiry, and constant-time verification tests in `apps/api/src/chat-handoff/chat-handoff-token.service.spec.ts` and `apps/api/src/agent-gateway/selection-attestation.service.spec.ts`
- [x] T066 [P] [US4] Write failing strict create/token-only-resolve, `ISSUE`/`ACCEPT` flag, active-retry, and client-id/idempotency/session extra-field rejection tests in `apps/api/src/chat-handoff/chat-handoff.service.spec.ts`
- [x] T067 [P] [US4] Write failing service-auth, signed ordered-offer binding, owner/internal-session, stale-offer/attestation, cross-user, and exact-response E2E tests in `apps/api/test/chat-handoff.e2e-spec.ts`
- [x] T068 [P] [US4] Write failing deterministic validate/create-node and no-LLM-client exposure tests in `apps/agent/tests/test_handoff_nodes.py`
- [x] T069 [P] [US4] Write failing `ACTION_HANDOFF` ordering, strict schema, disconnect/retry, and privacy tests in `apps/agent/tests/test_sse_integration.py`
- [x] T070 [US4] Run the Feature 016 checkout-readiness preflight from `specs/016-traveler-profile-booking-readiness/plan.md`, record evidence in `specs/017-chatbot-backend-infrastructure/quickstart.md`, and stop with handoff issuance off if canonical readiness/intent prerequisites are not green
- [x] T071 [P] [US4] Write failing token-only readiness, claim acquire/owned-refresh/loss/cancel/expiry/recovery, supplier-hard-timeout-below-lease, final active-session/unexpired-claim consume, and 100-request single-winner tests proving every loser makes zero Duffel/payment calls in `apps/api/test/booking-readiness.e2e-spec.ts`, `apps/api/test/booking-intent.e2e-spec.ts`, and `apps/api/test/chat-handoff-concurrency.e2e-spec.ts`
- [x] T072 [P] [US4] Write failing strict card, Origin/CSRF bootstrap POST, HttpOnly/Secure/SameSite cookie, clean redirect/URL, access-log redaction, and browser-storage privacy tests in `apps/web/tests/chat-checkout-handoff.spec.ts`

### Implementation for User Story 4

- [x] T073 [P] [US4] Implement the state-only `signal_checkout_intent` tool and index validation in `apps/agent/src/agent/tools/signal_checkout_intent.py`
- [x] T074 [P] [US4] Implement signed selection-attestation verification, server-derived idempotency, versioned HMAC/SHA-256 credential handling, redaction, and key rotation in `apps/api/src/agent-gateway/selection-attestation.service.ts` and `apps/api/src/chat-handoff/chat-handoff-token.service.ts`
- [x] T075 [US4] Implement deterministic attestation-bound create and token-plus-owner read-only resolve lifecycle with exact `ISSUE`/`ACCEPT` enforcement in `apps/api/src/chat-handoff/chat-handoff.service.ts`
- [x] T076 [US4] Implement service-auth create and user-auth no-store token-only resolve endpoints with strict extra-field rejection in `apps/api/src/chat-handoff/chat-handoff.controller.ts`, `apps/api/src/chat-handoff/dto/create-chat-handoff.dto.ts`, `apps/api/src/chat-handoff/dto/resolve-chat-handoff.dto.ts`, and `apps/api/src/chat-handoff/dto/chat-handoff-response.dto.ts`
- [x] T077 [US4] Resolve selected local/provider offer binding only from the verified attestation/index, remove caller-supplied ID/idempotency fields from create DTOs, and prove the legacy search path cannot reach handoff creation in `apps/api/src/chat-handoff/chat-handoff.service.ts`, `apps/api/src/chat-handoff/dto/create-chat-handoff.dto.ts`, and `apps/api/test/chat-handoff.e2e-spec.ts`
- [x] T078 [US4] Add deterministic handoff client methods that send only attestation/index/fingerprint, propagate traces, and never expose caller IDs/idempotency/session fields in `apps/agent/src/agent/tools/nestjs_client.py`
- [x] T079 [US4] Implement `validate_handoff` and `create_handoff_token` deterministic graph nodes with idempotency binding in `apps/agent/src/agent/graph/nodes.py`
- [x] T080 [US4] Emit strict `ACTION_HANDOFF` and persist the completed turn without exposing token/IDs in text or telemetry in `apps/agent/src/agent/streaming/sse.py`
- [x] T081 [P] [US4] Implement exact shared-event parsing, registered checkout card, and CSRF/origin-protected POST bootstrap that sets a short-lived HttpOnly/Secure/SameSite cookie then redirects cleanly in `apps/web/components/chat/CheckoutHandoffCard.tsx`, `apps/web/components/chat/ChatWidget.tsx`, and `apps/web/app/checkout/handoff/route.ts`
- [x] T082 [US4] Add server-side cookie read/no-store token-only resolution, clean-URL recovery, and credential clearing to `apps/web/app/checkout/passengers/page.tsx` and `apps/web/lib/checkout.ts`
- [x] T083 [US4] Add mutually exclusive server-read handoff source resolution without client `chatSessionId`, plus claim DTO/state fields, in `apps/api/src/booking-intent/dto/booking-readiness.dto.ts`, `apps/api/src/booking-intent/dto/create-intent.dto.ts`, `apps/api/src/booking-intent/booking-readiness.service.ts`, and `apps/api/src/booking-intent/booking-intent.service.ts`
- [x] T084 [US4] Implement pre-Duffel claim CAS with compare-and-refresh watchdog, supplier hard deadline safely below remaining claim TTL, cancellation on refresh loss, buffered takeover, and final unexpired-claim/active-non-deleted-session revalidation in the BookingIntent-plus-consume transaction in `apps/api/src/booking-intent/booking-intent.service.ts`, then run all US4 suites

### US4 Work Packages and Stop Points

1. **6A — Signal only (2 tasks)**: T064 and T073. Stop after proving the LLM-visible tool mutates state only and performs zero I/O.
2. **6B — Credential primitive (2 tasks)**: T065 and T074. Stop after attestation/idempotency/crypto tests pass with no route enabled.
3. **6C — Dark create/resolve service (3 tasks)**: T066, T075, and T076. Stop after exact flag/DTO/lifecycle unit tests; issuance remains off.
4. **6D — Signed search binding (2 tasks)**: T067 and T077. Stop after ordered-offer/freshness/owner E2E passes.
5. **6E — Deterministic client/node (3 tasks)**: T068, T078, and T079. Stop after no-LLM-client and node validation pass.
6. **6F — SSE action contract (2 tasks)**: T069 and T080. Stop after ordering/privacy/retry tests; public issuance remains off.
7. **6G — Clean web bootstrap/resolve (3 tasks)**: T072 and T081–T082. Stop after cookie, clean-URL, owner-only resolution, and recovery states pass.
8. **6H — Feature 016 gate (1 task)**: T070. Do not start claim/consume implementation unless the recorded preflight is green.
9. **6I — Canonical claim/consume (3 tasks)**: T071, T083, and T084. End only when claim recovery and 100-way zero-supplier-loser tests are green.

**Checkpoint**: US4 completes the end-to-end handoff. The LLM has no token endpoint/tool, resolve is refresh-safe, and one token creates at most one intent under concurrency.

---

## Phase 7: User Story 5 — Observable, Reversible Rollout (Priority: P5)

**Goal**: Deploy server acceptance before issuance, cut over to direct streaming, and make routing/quota/handoff health diagnosable without PII.

**Independent Test**: Exercise every flag combination, trace one complete turn across three services, force each dependency/error class, and verify safe rollback plus exact metrics/log fields.

### Tests for User Story 5

- [x] T085 [P] [US5] Write failing startup/flag dependency tests proving agent and NestJS create both reject `ISSUE=false`, `ISSUE=true/ACCEPT=false` is invalid, `ACCEPT` rollback policy is exact, and transport fallback remains available in `apps/agent/tests/test_config.py`, `apps/api/src/chat-handoff/chat-handoff.config.spec.ts`, and `apps/web/tests/chat-checkout-handoff.spec.ts`
- [x] T086 [P] [US5] Write failing PII-safe structured telemetry and cross-service trace propagation tests in `apps/agent/tests/test_chat_observability.py` and `apps/api/test/chat-handoff.e2e-spec.ts`
- [x] T087 [P] [US5] Write failing direct browser→FastAPI session-continuity and proxy-bypass Playwright scenarios in `apps/web/tests/chat-direct-stream.spec.ts`

### Implementation for User Story 5

- [x] T088 [P] [US5] Add allowlisted quota/router/tool/snapshot/handoff structured metrics and logs in `apps/agent/src/agent/observability/chat_observability.py`
- [x] T089 [P] [US5] Add allowlisted create/resolve/consume/replay audit and metric emission in `apps/api/src/chat-handoff/chat-handoff.service.ts` and `apps/api/src/booking-intent/booking-intent.service.ts`
- [x] T090 [US5] Propagate sanitized trace/correlation headers browser → agent → NestJS in `apps/web/lib/chatStream.ts`, `apps/agent/src/agent/streaming/sse.py`, and `apps/agent/src/agent/tools/nestjs_client.py`
- [x] T091 [US5] Enable direct ChatWidget streaming with strict origin/auth/session continuity and retain flag-controlled fallback in `apps/web/components/chat/ChatWidget.tsx`
- [x] T092 [US5] Retain and exercise the Next.js stream proxy as a tested flag-controlled rollback path through the observation window, and record the direct/proxy rollback matrix in `apps/web/app/api/chat/stream/route.ts` and `specs/017-chatbot-backend-infrastructure/quickstart.md`
- [x] T093 [US5] Run the full three-service browser flow direct stream → signed search → explicit selection → `ACTION_HANDOFF` → clean POST/bootstrap → owner/internal-session resolve → readiness → claim/intent consume plus the flag matrix and legacy `ACTION_REQUIRED` regression; assert one consumed intent, zero supplier/payment calls by losers, no credential/identifier URL/log leakage, encrypted chat persistence, and session continuity in `apps/web/tests/chat-checkout-handoff.spec.ts`, `apps/web/tests/chat-direct-stream.spec.ts`, and `specs/017-chatbot-backend-infrastructure/quickstart.md`

**Checkpoint**: Target topology is active and reversible; existing safe chat/checkout continues under rollback; telemetry diagnoses failures without message/token/identifier content.

### US5 Work Packages and Stop Points

1. **7A — Flag/direct-client gate (3 tasks)**: T085, T087, and T091. Stop after every pre-cleanup transport/accept/issue combination passes.
2. **7B — PII-safe telemetry (3 tasks)**: T086, T088, and T089. Stop after agent/API allowlists and trace linkage pass.
3. **7C — Correlation propagation (1 task)**: T090. Stop after browser→agent→NestJS trace continuity passes.
4. **7D — Rollback/full-flow observation (2 tasks)**: T092–T093. Archive the green proxy matrix and complete signed-search/bootstrap/claim E2E before any cleanup.

---

## Phase 8: Polish and Cross-Cutting Verification

**Purpose**: Close documentation, performance, privacy, and repository-wide regression gates after all desired stories are complete.

- [x] T094 [P] Create the operations, alerts, JWT/attestation/token/chat-encryption key rotation, ciphertext retention/backups, CORS, rollback, claim recovery, and session-deletion runbook in `docs/runbooks/chatbot-handoff.md`
- [x] T095 [P] Update implemented chatbot topology, data flow, invariants, and direct-stream exception in `context/architecture.md`
- [x] T096 [P] Update dependency rules and approved Redis/LangGraph usage in `context/library-docs.md` and completed feature status in `context/progress-checker.md`
- [x] T097 Add maintained dashboard/alert contract assertions in `apps/api/test/chat-handoff-observability.e2e-spec.ts` and `apps/agent/tests/test_chat_observability.py`
- [x] T098 Run 100-request router-overhead, quota-edge, handoff-latency, and consume-concurrency benchmarks and record p95/count evidence in `docs/runbooks/chatbot-handoff.md`
- [x] T099 Run the seeded negative privacy corpus across LLM fixtures, SSE, bootstrap/access logs, traces, audits, clean URLs, DOM, JavaScript-readable cookies, and browser storage; verify temporary legacy ChatMessage/title plaintext has complete ciphertext twins/recovery export and zero migrated-path exposure, and record evidence in `docs/runbooks/chatbot-handoff.md`
- [x] T100 Run full agent pytest, shared/API builds, API Jest/E2E, and Playwright regressions from `specs/017-chatbot-backend-infrastructure/quickstart.md`, then reconcile `spec.md`, `plan.md`, `data-model.md`, `contracts/api.md`, `tasks.md`, and accepted `CONTEXT.md` terminology against green behavior
- [x] T101 After explicit post-observation approval, archive the successful proxy rollback matrix, remove `apps/web/app/api/chat/stream/route.ts` and proxy-only configuration from `apps/web/.env.example`, replace `Direct=false` with a direct-only configuration rejection/removal test in `apps/web/lib/featureFlags.spec.ts`, then rerun direct-stream continuity and full handoff tests and record cleanup evidence in `specs/017-chatbot-backend-infrastructure/quickstart.md`
- [x] T102 After separate encrypted-chat observation/rollback approval proves T034 live dual-read/write, full message/title backfill, database/backup inventories, recovery export, and legacy-reader shutdown, create/apply/test both plaintext-column drops in `apps/api/prisma/migrations/20260805010000_chat_message_plaintext_cleanup/migration.sql` and record irreversible cleanup/recovery evidence in `specs/017-chatbot-backend-infrastructure/quickstart.md`

**Checkpoint**: All functional, privacy, concurrency, observability, performance, migration, and documentation evidence is green; reversible rollout evidence is archived before the separately approved direct-only cleanup.

### Polish and Cleanup Work Packages

1. **8A — Operations/context (3 tasks)**: T094–T096. Stop after runbook and required context synchronization review.
2. **8B — Observability/performance gates (2 tasks)**: T097–T098. Stop after maintained assertions and measured p95/count evidence pass.
3. **8C — Privacy/full regression (2 tasks)**: T099–T100. Stop after the reversible observation evidence is green and archived.
4. **8D — Approved direct-only cleanup (1 task)**: T101. Requires separate transport approval; validate direct-only configuration, not the removed proxy path.
5. **8E — Approved plaintext cleanup (1 task)**: T102. Requires separate encryption approval and recovery evidence; final database/backup scans must find zero ChatMessage/title plaintext.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: Packages 1A→1B→1C→1D; no runtime behavior changes.
- **Phase 2 (Foundational)**: 2A precedes 2B/2C/2D; 2E→2F remains additive and retains legacy plaintext. All checkpoints block story cutover.
- **Phase 3 (US1)**: 3A/3B/3C may integrate independently after their foundation; 3D migrates live encrypted persistence; 3E→3F proves direct readiness while client cutover stays off.
- **Phase 4 (US2)**: 4A→4B; 4C/4D/4E can proceed after typed state; 4F integrates them with issuance off.
- **Phase 5 (US3)**: 5A precedes 5B/5C; 5D enables Python tools only after projection routes are green.
- **Phase 6 (US4)**: Depends on US2 graph/attested-snapshot seam and US3 projection boundary; credential work starts only after signed selection contracts, action waits for dark acceptance, and claim/consume waits for Work Package 6H.
- **Phase 7 (US5)**: 7A/7B→7C→7D after US1–US4; direct client cutover and rollback observation are last reversible work.
- **Phase 8 (Polish/Cleanup)**: 8A→8B→8C; 8D and 8E are independent, separately approved cleanups after archived evidence.

### Mapping to the Seventeen Plan Slices

| Plan slice                                         | Task phase                                 |
| -------------------------------------------------- | ------------------------------------------ |
| 1. Contract/JWT/flag freeze                        | Work Packages 1A–1D                        |
| 2. Redis lifecycle/health                          | Work Package 2A                            |
| 3. Atomic quota admission                          | Work Package 2B                            |
| 4. Fenced session lease                            | Work Package 2C plus US1 fence integration |
| 5. Trusted snapshot repository                     | Work Package 2D                            |
| 6. Encrypted additive persistence                  | Work Packages 2E–2F                        |
| 7. Secure stream/persistence migration             | Work Packages 3A–3F                        |
| 8. Router/specialist graph                         | Work Packages 4A–4C and 4E–4F              |
| 9. Read tools/attested search/projection           | Work Package 4D and Work Packages 5A–5D    |
| 10. State-only checkout signal                     | Work Package 6A                            |
| 11. Credential primitive                           | Work Package 6B                            |
| 12. Dark create/resolve API                        | Work Packages 6C–6D                        |
| 13. Deterministic action/clean bootstrap           | Work Packages 6E–6G                        |
| 14. Claimed canonical consume                      | Work Packages 6H–6I                        |
| 15. Direct cutover/observation with proxy retained | Work Packages 7A–7D and 8A–8C              |
| 16. Approved direct-only cleanup                   | Work Package 8D / T101                     |
| 17. Approved plaintext cleanup                     | Work Package 8E / T102                     |

### User Story Dependencies

- **US1 (P1)**: Independently deployable after Foundation; supplies secure/budgeted existing chat.
- **US2 (P2)**: Uses US1 session controls; independently testable with stubbed tools and no handoff issuance.
- **US3 (P3)**: Gateway endpoints are independently testable; enabled Travel tools use US2 registry.
- **US4 (P4)**: Requires latest-search state from US2 and booking boundary from US3; independently testable end-to-end once enabled.
- **US5 (P5)**: Operationalizes all prior stories and owns final transport cutover.

### Within Each User Story

1. Add public-boundary tests and confirm RED.
2. Add data/schema primitives before services.
3. Add services before controllers/endpoints.
4. Add graph/tool behavior before SSE/web integration.
5. Run focused suite, then all previously green regression suites.
6. Refactor only while tests stay green; do not modify an established test without the repository approval process.

## Parallel Opportunities

- Phase 1 TypeScript shared, Python models, API config, and web config tasks can run in parallel after dependency declaration.
- Phase 2 quota, lease, snapshot, and migration tests/implementations own separate files and can run in parallel.
- In US2 the three specialist adapters can be implemented in parallel after their tests and state contract exist.
- US3 API DTO/reference work and Python formatting tools can run in parallel once exact contracts are frozen.
- In US4 token service/API, agent signal/nodes, and web strict parser tests can proceed in parallel; integration waits for the NestJS create contract.
- US5 observability tests and direct browser tests can proceed in parallel before final cutover.

## Parallel Examples

### US1

```text
Task T025: JWT/origin/quota ordering tests
Task T027: session lease/disconnect tests
Task T028: persistence/restart tests
Task T029: direct-stream CORS/auth tests
```

### US2

```text
Task T044: General-Purpose Agent
Task T045: Travel Assistant
Task T046: Checkout Orchestrator
```

### US3

```text
Task T053: booking reference tests
Task T054: exact gateway DTO tests
Task T056: Python tool tests
```

### US4

```text
Task T065: token service tests
Task T068: deterministic node tests
Task T069: SSE action tests
Task T072: Playwright card/parser tests
```

### US5

```text
Task T085: flag matrix tests
Task T086: observability/trace tests
Task T087: direct browser tests
```

## Implementation Strategy

### MVP First — US1 Only

1. Complete Phase 1 contract/config freeze.
2. Complete Phase 2 additive Redis/storage foundation.
3. Complete US1 secure budgeted chat.
4. Stop and validate authentication, ownership, persistence, guardrails, quotas, Redis failure, and proxy/direct-server compatibility.
5. Deploy with multi-agent/handoff/direct-client flags off if desired.

### Incremental Delivery

1. **US1**: Secure shared controls around today's assistant.
2. **US2**: Replace monolith/fake booking with specialist routing and safe disambiguation; issuance stays off.
3. **US3**: Narrow booking data exposure and enable explicit detail.
4. **US4A–D**: Deploy signal-only behavior, dark token acceptance, deterministic action support, and strict web resolution while issuance remains off.
5. **US4E**: Pass the Feature 016 preflight, then enable issuance and atomic checkout consumption.
6. **US5**: Cut browser streaming directly to FastAPI, retain the proxy throughout observation, and complete operations/rollback evidence.
7. **Polish**: Run full privacy/performance/regression gates and synchronize documentation while both rollback representations remain.
8. **Transport cleanup**: Remove the proxy only after explicit transport observation approval and switch tests to direct-only configuration.
9. **Encryption cleanup**: Drop plaintext only after separate live dual-read/write observation, recovery export, verified scans, and legacy-reader shutdown approval.

## Suggested First Execution Batch

Execute setup as four reviews (T001–T002, T003–T004, T005–T007, T008), then stop after each foundation package: Redis lifecycle T009–T011, quota T012–T013, fence T014–T015, snapshot T016–T018, encrypted schema/backfill T019–T021, and inert services T022–T024. Each unit has at most three tasks and no user-visible behavior.

## Notes

- `[P]` means file ownership and dependencies permit parallel work; it does not permit skipping the phase checkpoint.
- `ACTION_REQUIRED` remains for readiness/profile correction; `ACTION_HANDOFF` is only explicit checkout commitment.
- Never expose or log the handoff token/hash except for the exact `ACTION_HANDOFF.handoffToken` field and redacted bootstrap POST/HttpOnly cookie path; tokens are forbidden in URLs, browser-readable storage, access logs, and telemetry. Never expose local/Duffel offer ID, Booking.id, PNR, passenger/contact/passport/payment data.
- Handoff create is deterministic application I/O and must never be added to an LLM registry.
- Existing non-chat checkout and singular/plural compatibility routes remain until separately reviewed cleanup.
- Commit after each task or tightly coupled RED/GREEN slice; stop at any checkpoint for validation.
