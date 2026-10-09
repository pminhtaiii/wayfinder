# Quickstart Validation: Chatbot Backend Infrastructure

This guide proves the feature through public boundaries. It does not replace the task-level RED → GREEN → REFACTOR workflow.

## Prerequisites

- Node/pnpm workspace dependencies installed.
- Python 3.11+ and `uv` available for `apps/agent`.
- Docker Desktop running with PostgreSQL and Redis available through `docker compose up -d`.
- Matching secrets in `apps/api/.env` and `apps/agent/.env`: `JWT_SECRET`, canonical JWT issuer/audience, `AGENT_SERVICE_API_KEY`, and `CLAIM_TOKEN_SECRET`.
- External versioned key rings configured for ChatMessage AES-GCM, search attestation, and handoff token derivation; never place real values in source, PostgreSQL, backups, or test output.
- Web public agent URL and agent CORS allowlist point to the actual development origins.
- Feature 016 canonical plural readiness/intent contracts available for Phase 14 tests.

## Configuration Under Test

Validate defaults first:

```text
FEATURE_FLAG_CHAT_MULTI_AGENT=false
FEATURE_FLAG_CHAT_HANDOFF_ACCEPT=false
FEATURE_FLAG_CHAT_HANDOFF_ISSUE=false
FEATURE_FLAG_CHAT_DIRECT_STREAM=false
CHAT_DAILY_MESSAGE_LIMIT=50
CHAT_BURST_LIMIT=60
CHAT_BURST_WINDOW_SECONDS=60
```

Then enable phases in this order:

```text
CHAT_HANDOFF_ACCEPT → CHAT_MULTI_AGENT → web ACTION_HANDOFF support
→ CHAT_HANDOFF_ISSUE → CHAT_DIRECT_STREAM
```

Acceptance should be deployed before issuance. Direct stream is last.

## Build and Static Contract Checks

From repository root:

```powershell
pnpm --filter @shared/types build
pnpm --filter @api/backend build
pnpm --filter @web/frontend build
```

From `apps/agent`:

```powershell
uv sync
uv run pytest tests/test_config.py tests/test_graph.py tests/test_tools.py tests/test_sse_integration.py
```

Expected:

- Shared strict chat/handoff contracts compile.
- Python event fixtures match TypeScript/Zod accepted fixtures.
- The exact six-tool allowlist passes.
- No confirmation-resume input or `book_flight` path exists in the enabled graph.
- Existing `ACTION_REQUIRED` fixtures remain valid.

## Phases 1–7: Authentication, Redis Controls, Encryption, Persistence, and CORS

Run focused agent tests:

```powershell
uv run pytest tests/test_auth.py tests/test_rate_limit.py tests/test_chat_budget.py tests/test_session_lock.py tests/test_trusted_snapshot.py tests/test_health.py
```

Scenarios:

1. Real NestJS tokens require `sub`/`iss`/`aud`/`jti`; missing/invalid/expired, logged-out/revoked, and deactivated-user tokens return 401 before quota/model/persistence, while the temporary legacy `id` transition is explicit.
2. Non-allowlisted Origin returns 403 before streaming; allowlisted preflight exposes only exact methods/headers, uses `allow_credentials=false`, and auth errors still carry the correct allowlisted CORS headers.
3. Fifty default accepted messages succeed; the next returns `CHAT_DAILY_QUOTA_EXCEEDED` before guardrail/router/specialist/tool calls.
4. One Lua admission decision increments daily and burst only for accepted requests; burst rejection does not charge daily, daily rejection leaves no burst reservation, and UTC rollover/TTL is exact under concurrency.
5. Redis outage returns `CHAT_CONTROL_PLANE_UNAVAILABLE`; it never bypasses quota.
6. Two simulated agent instances contend on the same fenced lease; TTL overrun, refresh loss, and disconnect prove the stale worker cannot persist an encrypted turn/summary or emit an action.
7. `/health` reports Redis independently from NestJS and model/guardrail status.
8. Seeded passport/card/contact PII is blocked before all model spies and encrypted message persistence; only a value-free security event is recorded.
9. Agent chat calls use service-authenticated access/session/memory/completed-turn/summary endpoints; browser attempts to write AGENT/SUMMARY fail.
10. New/migrated ChatMessage rows have complete versioned AES-GCM envelopes and round-trip verification; the legacy column remains only for rollback during observation, has a recovery inventory, and is no longer used by the migrated agent path. Soft-deleted sessions reject access.

Expected: cost control and session ownership are cross-instance, atomic, and fail closed.

## Phases 5, 8–10: Trusted State, Routing, and Signal

```powershell
uv run pytest tests/test_trusted_snapshot.py tests/test_router.py tests/test_graph.py tests/test_streaming_agent.py
```

Maintain a deterministic routing fixture table with:

- GENERAL greeting.
- SEARCH request.
- BOOKING_INQUIRY logistics question.
- CHECKOUT explicit commitment with active snapshot/index.
- High-confidence checkout without snapshot.
- High-confidence checkout with curiosity but no commitment.
- Out-of-range and stale result index.
- Low-confidence checkout-like request.
- Malformed/unknown Router output.
- Legacy session after restart with no snapshot.

Expected:

- Only the fully satisfied checkout case reaches Checkout Orchestrator.
- Partial checkout cases reach Travel Assistant with `possible_checkout` or request a fresh search.
- General has no tools; Travel and Checkout have only their exact registries.
- The new graph alone calls opt-in POST v2 search with an owned session/proposed version; it receives a signed ordered-offer attestation, atomically replaces the snapshot, and exposes neither attestation nor identifier. The legacy GET response remains byte-for-byte display-only in rollback tests.

## Phase 9: Booking Projection Boundary

Run API tests:

```powershell
pnpm --filter @api/backend test -- agent-gateway.service.spec.ts
npm run test:e2e --workspace=apps/api -- --runTestsByPath test/agent-gateway.e2e-spec.ts
```

Expected exact keys:

- Summary: bookingReference, airline, origin, destination, departureTime, arrivalTime, status, durationMinutes, stops.
- Detail: summary plus flightNumber, baggageAllowance, changeable, refundable.

Negative corpus must prove absence of price/currency, fare class, passenger count/details, contact/passport/payment data, PNR, Booking.id, Duffel IDs, and raw snapshots. Query spies prove only BookingAgentProjection is loaded; confirmation, cancellation, supplier-sync, webhook/reconciliation, and existing-row backfill tests keep itinerary/status current. Foreign/stale references return the same safe not-found shape.

## Phases 10–13: Signal, Credential, Dark API, SSE Action, and Bootstrap

Run focused suites:

```powershell
uv run pytest tests/test_checkout_signal.py tests/test_graph.py tests/test_nestjs_client.py tests/test_sse_integration.py tests/test_sse_output_guardrail.py
pnpm --filter @api/backend test -- chat-handoff
npm run test:e2e --workspace=apps/api -- --runTestsByPath test/chat-handoff.e2e-spec.ts
```

Required scenarios:

1. `signal_checkout_intent` updates typed state and performs zero network/cache/database calls.
2. Invalid index/snapshot cannot create a handoff.
3. NestJS verifies the signed ordered-offer attestation, derives idempotency from attestation digest/index, rejects caller IDs/idempotency keys, and returns the same re-derived token/one row for an active retry.
4. Database contains only token hash/key version, never token plaintext.
5. Cross-user, client-supplied session, invalid/replaced attestation, malformed, expired, and stale-offer creation/resolve fail with zero supplier calls.
6. `ACTION_HANDOFF` is emitted only after deterministic create succeeds.
7. Event payload has exact version/action/display keys and no URL or identifiers.
8. Unknown action/version/extra fields fail strict Python and TypeScript parsing.
9. Output guardrails continue to inspect text; strict application events bypass text mutation only after schema validation.
10. `ISSUE=false` rejects create at both agent node and NestJS direct service-auth endpoint; `ACCEPT` independently controls existing credential resolution.
11. Card click POSTs the token through Origin/CSRF validation, sets only an HttpOnly/Secure/SameSite=Strict cookie, redirects to clean `/checkout/passengers`, and leaves zero token matches in URL/history/access logs/readable storage.

## Phase 14: Checkout Resolve, Claim, and Atomic Consume

### Blocking Feature 016 preflight

Before writing or enabling consumption, run the existing canonical plural readiness/intent contract tests and verify `POST /api/bookings/intents/readiness`, `POST /api/bookings/intents`, the shared evaluator, source resolution, and singular compatibility aliases are present. If this preflight fails, stop with dark create/resolve acceptance enabled and `FEATURE_FLAG_CHAT_HANDOFF_ISSUE=false`; do not improvise a second intent pipeline.

```powershell
npm run test:e2e --workspace=apps/api -- --runTestsByPath test/chat-handoff.e2e-spec.ts test/booking-intent.e2e-spec.ts test/booking-readiness.e2e-spec.ts
```

Run the 100-way concurrent consume test in the dedicated E2E test profile.

Expected:

- Resolve accepts token plus authenticated user only, validates its stored session internally, can repeat while ACTIVE, and never consumes.
- Readiness by handoff is read-only and uses the same evaluator as offer-ID readiness.
- Successful canonical intent first CAS-claims before Duffel, owner-refreshes under a watchdog, enforces supplier timeout plus finalization below remaining TTL, and only then atomically creates/consumes after revalidating the active/non-deleted session.
- Exactly one concurrent request owns the claim/creates the bound intent; every loser returns stable in-progress/consumed behavior before any supplier/payment call.
- Invalid/not-ready/stale-profile requests release the matching claim; refresh loss cancels and blocks takeover through the uncertainty buffer before bounded recovery.
- Supplier/payment spies remain zero for resolve, every losing/replayed request, and every DB transaction.
- Existing non-chat offer-ID and singular compatibility flows remain green.

## Phases 13–15: Browser Action and Direct Stream

Run Playwright with the configured web/API/agent servers:

```powershell
npx playwright test --config=apps/web/tests/playwright.config.ts apps/web/tests/chat-checkout-handoff.spec.ts
```

Browser scenarios:

1. Direct browser request includes existing bearer JWT and reaches FastAPI without the Next.js stream proxy.
2. The `done` event supplies and the widget retains the new ChatSession ID for the next turn.
3. Search results render without any offer ID in DOM, network-visible SSE payload, URL, storage, or console.
4. Ambiguous commitment renders clarification and no checkout card.
5. Explicit commitment renders `CheckoutHandoffCard`; local action performs only the protected bootstrap POST and the browser lands on a clean URL.
6. Checkout server reads the HttpOnly credential, resolves by token plus user with no-store behavior, and never supplies a session ID.
7. Expired/consumed/foreign/stale tokens render safe recovery and fresh-search actions.
8. Existing `ACTION_REQUIRED` profile/readiness card still works.
9. Unknown event schema/action is ignored safely and records allowlisted telemetry.
10. Tokens never appear in URLs/history, localStorage, sessionStorage, JavaScript-readable cookies, analytics/access logs, console, nested return URLs, or error UI.
11. Complete one real three-service flow: direct stream → signed search → explicit selection → `ACTION_HANDOFF` → bootstrap/clean redirect → token-plus-user resolve → readiness → claim → canonical intent/consume; assert exactly one BookingIntent, consumed linkage, session continuity, zero supplier/payment calls by losers, encrypted messages, and no credential/local/provider identifiers in URL/log/SSE/DOM.

## Full Regression

Agent:

```powershell
uv run pytest
```

API:

```powershell
pnpm --filter @api/backend test
npm run test:e2e --workspace=apps/api
```

Web:

```powershell
npx playwright test --config=apps/web/tests/playwright.config.ts
```

Also run repository lint/type checks defined in `context/workflow.md`.

## Performance and Concurrency Gates

With model, Duffel, Stripe, and email/SMS boundaries stubbed:

- Warm 100 accepted turns; request-to-router application overhead p95 < 100 ms.
- Warm 100 handoff create and 100 resolve requests; p95 < 300 ms.
- Submit 100 simultaneous daily-quota increments at limit-1; exactly one additional request is admitted.
- Submit 100 simultaneous intent creates with one token; exactly one claim reaches Duffel and exactly one BookingIntent is created/bound.
- Verify handoff issue/resolve adds zero Duffel calls.

## Rollout Matrix

| Multi-agent | Accept | Issue | Direct | Expected                                                            |
| ----------- | ------ | ----- | ------ | ------------------------------------------------------------------- |
| off         | off    | off   | off    | Existing safe graph/proxy rollback behavior                         |
| off         | on     | off   | off    | Dark server acceptance; no action event                             |
| on          | on     | off   | off    | New router/tools; checkout disambiguates, no token issuance         |
| on          | on     | on    | off    | Handoff enabled through proxy during initial observation            |
| on          | on     | on    | on     | Target direct topology with proxy retained for observation rollback |
| on          | on     | off   | on     | Rollback issuance; direct safe chat remains                         |

Invalid configuration (`Issue=true` while `Accept=false`) must fail startup or force issuance off with a clear health/config error.

After the observation window and explicit approval, archive this rollback matrix, remove the proxy and `Direct=false` configuration, then rerun direct-stream/session/full-flow tests plus a direct-only configuration test that rejects/removes the old false state. The archived proxy matrix is not expected to run after deletion. Before approval, proxy deletion is a failure of the rollback gate.

Phase 17 is a different approval: after live encrypted message/title dual-read/write observation, complete backfill, recovery export, database/backup inventory, and legacy-reader shutdown, apply the cleanup migration and prove decrypt round trips plus zero legacy plaintext. Transport approval does not imply encryption-cleanup approval.

## Privacy Inspection

Search captured logs, traces, audit metadata, SSE fixtures, browser storage, and URLs for the seeded corpus:

```text
passport number
email
phone
card-like number
Booking.id
Duffel offer ID
PNR
handoff token and token hash
```

Expected before Phase 17: zero credential/identifier/PII matches outside protected test inputs, exact `ACTION_HANDOFF.handoffToken`, redacted bootstrap/HttpOnly handling, and the inventoried temporary legacy ChatMessage column with a verified ciphertext twin and recovery export. The token must not appear in any URL/history/access log/text/other event/trace/audit/DOM/readable storage/analytics/error.

After separate Phase 17 approval and cleanup migration, repeat the database/backup scan: ChatMessage content and ChatSession title plaintext must have zero matches and no legacy reader may remain. Any unallowlisted match is blocking.

## Completion Evidence

Record in `docs/runbooks/chatbot-handoff.md` and `context/progress-checker.md` only after implementation:

- Encryption/projection/handoff migration, backfill, plaintext-removal, and backup verification.
- Exact test commands and green results.
- Concurrent quota/consume counts.
- Performance p95 results.
- Feature-flag state and rollback rehearsal.
- Dashboard/alert links or checked-in contracts.
- Privacy corpus result.

### Phase 1: Contract-Freeze Checkpoint (2026-08-05)

- Added direct `langgraph` and `redis` asyncio dependencies to `apps/agent`.
- Documented Python Redis/LangGraph usage constraints in `context/library-docs.md`.
- Wrote failing/passing event contract tests in `packages/shared/src/types/chat.types.spec.ts` and `apps/agent/tests/test_event_contracts.py`.
- Wrote configuration tests in `apps/api/src/auth/auth.service.spec.ts`, `apps/api/src/chat-handoff/chat-handoff.config.spec.ts`, `apps/web/lib/featureFlags.spec.ts`, and `apps/agent/tests/test_config.py`.
- Defined strict shared types in `packages/shared/src/types/chat.types.ts` and exported them.
- Defined `events.py` and `requests.py` in `apps/agent/src/agent/models/`.
- Configured disabled defaults in `.env.example`, `config.py`, `app.module.ts`, and `featureFlags.ts`.
- Ran shared builds and contract/config tests, confirming all are GREEN with flags defaulted to off.

### Phase 2: Checkpoint 2B (2026-08-05)

- Wrote failing one-Lua daily/burst admission tests covering concurrency, rejected-attempt non-charging, UTC rollover/TTL, and Redis fail-closed behavior.
- Implemented the versioned combined Lua admission contract and exact key/error semantics in `chat_budget_repository.py`.
- Tests run to GREEN confirming atomic admission and failure boundaries.

### Phase 2A: Redis Lifecycle Checkpoint (2026-08-05)

- Wrote failing Redis lifecycle and health tests in `apps/agent/tests/test_redis_infrastructure.py`.
- Implemented pooled asyncio Redis client in `apps/agent/src/agent/infrastructure/redis.py`.
- Wired Redis lifecycle and dependency health in `apps/agent/src/agent/main.py`.
- Ran T009 tests to GREEN, ensuring startup, shutdown, and degraded health are handled correctly.

### Phase 2C: Fenced Session Lease Checkpoint (2026-08-05)

- Wrote failing acquire/refresh/release/takeover tests in `apps/agent/tests/test_session_lock.py`.
- Implemented monotonic fenced leases, refresh-loss cancellation, bounded wait/depth, and write-fence propagation in `apps/agent/src/agent/repositories/session_lock_repository.py` and `apps/agent/src/agent/queue/message_queue.py`.
- All 4 session lock tests run to GREEN (acquire/release, TTL overrun/takeover, bounded wait, refresh cancellation).
- A stale worker cannot perform a durable write or emit `ACTION_HANDOFF`.

### Phase 2D: Trusted Snapshot Checkpoint (2026-08-05)

- Wrote failing attested Trusted Search Snapshot schema, owner/session, overwrite, TTL, fingerprint, and forbidden-field tests in `apps/agent/tests/test_trusted_snapshot.py`.
- Implemented strict PII-free attested snapshot serialization, atomic replace/load/delete in `apps/agent/src/agent/repositories/trusted_snapshot_repository.py`.
- Implemented snapshot schema with strict forbidden-field validation in `apps/agent/src/agent/models/snapshot.py`.
- All 10 trusted snapshot tests run to GREEN.
- Full Redis regression suite (22 tests: 2A + 2B + 2C + 2D) run to GREEN.
- Snapshots are PII-free and restore only inside the correct owner/session boundary.

### Phase 2E: Encrypted/Additive Prisma Foundation Checkpoint (2026-08-05)

- Added encrypted `ChatMessage` content fields, `ChatSession` title fields and `deletedAt`, `BookingAgentProjection` model, and `ChatHandoff` model with check constraints to `apps/api/prisma/schema.prisma`.
- Created additive migration in `apps/api/prisma/migrations/20260805000000_chatbot_handoff/migration.sql`.
- Created restart-safe backfill scripts: `backfill-encrypted-chat-messages.ts` and `backfill-booking-agent-projections.ts`.
- Wrote migration/backfill E2E tests in `apps/api/test/chat-persistence-migration.e2e-spec.ts` and `apps/api/test/chat-handoff-migration.e2e-spec.ts`.
- Migration successfully applied to database; legacy plaintext columns retained for rollback.

### Phase 2F: Inert Domain Skeletons Checkpoint (2026-08-05)

- Created versioned AES-GCM `ChatMessageCryptoService` in `apps/api/src/chat/chat-message-crypto.service.ts`.
- Created inert `ChatHandoffModule`, `ChatHandoffController`, `ChatHandoffService`, and `CreateChatHandoffDto` in `apps/api/src/chat-handoff/`.
- Registered `ChatMessageCryptoService` in `ChatModule` as provider and export.
- Registered `ChatHandoffModule` in `AppModule` imports.
- All routes are inert (throw `ServiceUnavailableException`); no chatbot path has cut over.
- Redis primitives are atomic and PII-free; additive schema is valid.

### Phase 3: Work Package 3F Checkpoint (2026-08-06)

- **T037 (Session ID Retention in ChatWidget)**: Verified session ID preservation across multi-turn streams in `apps/web/components/chat/ChatWidget.tsx`. `handleDone` callbacks capture `done.sessionId` from completion events, setting `activeSessionId` so subsequent user requests pass `sessionId` in the body and prevent redundant empty-session auto-creation.
- **T038 (US1 Test Verification & Suite Validation)**:
  - Ran 31 US1 focused agent Pytest suites in `apps/agent` (`test_stream_auth_budget.py`, `test_rate_limit.py`, `test_stream_session_control.py`, `test_streaming_agent.py`, `test_direct_stream.py`). All 31 tests passed 100% GREEN.
  - Ran NestJS US1 focused Jest test suites (`auth.service.spec.ts`, `chat-message-crypto.service.spec.ts`, `agent-gateway.service.spec.ts`). All 20 tests passed 100% GREEN.
  - Built `@shared/types` (`pnpm --filter @shared/types build`) with zero compilation errors.
  - Verified ingress PII detection & security audit logging in `apps/agent/src/agent/streaming/sse.py`.
  - Verified canonical JWT claim validation (`sub`, `iss`, `aud`, `jti`), NestJS access checks before quota admission, record-bound AES-256-GCM dual-write encryption, and strict CORS preflight handling.

### Phase 4: Work Package 4F Checkpoint (2026-08-06)

- **T039, T047 (Router schema/fallback)**: Implemented strict Router model invocation and safe fallback normalization. Malformed/unknown Router output fails safely and routes to Travel Assistant.
- **T040, T048 (Checkout gate/state)**: Replaced AgentState confirmation fields with typed route, disambiguation, snapshot, signal, and action fields. Every incomplete checkout gate routes to Travel Assistant with `possible_checkout` metadata.
- **T041, T050, T051 (Graph topology/removal)**: Replaced global registry with immutable per-agent registries and removed `book_flight`. Rebuilt LangGraph topology without `MemorySaver`, removing fake booking/confirmation/checkpointer paths.
- **T042, T049 (Signed search split)**: Implemented opt-in `POST /api/agent-gateway/v2/flights/search` with owned session/proposed version and its stripping consumer. Stored signed ordered-offer attestation only in Redis.
- **T043, T044, T045 (General/Travel inventory)**: Implemented tool-free General-Purpose Agent adapter and five-read-tool Travel Assistant adapter.
- **T046, T052 (Checkout adapter/integration)**: Implemented Checkout Orchestrator adapter. Integrated Router/specialist event streaming and safe disambiguation.
- **Test Verification**: Addressed CodeReview findings, fixing snapshot routing keys in the checkout gate and dead code in checkout orchestrator. Run `uv run pytest tests/` in `apps/agent` resulting in 100% tests GREEN (201/201).

### Phase 6: Work Package 6H Preflight Checkpoint (2026-08-07)

- Run the Feature 016 checkout-readiness preflight tests in `apps/api` using `pnpm --filter @api/backend test`.
- PASSED: 532/532 tests passed. Preflight is GREEN. (Initial blocking gaps resolved via subagent).
- Canonical readiness/intent prerequisites are met. Proceeding to WP 6I.

### Phase 7: Work Package 7B GREEN Checkpoint (2026-08-09)

- **T086:** Agent and API telemetry tests enforce per-field closed type/value schemas, bounded opaque trace/correlation IDs, and absence of message, token, offer, user/session, passenger, payment, passport, URL, and PII values. A real Python `NestJSClient` loopback test now proves the same sanitized identifiers reach NestJS telemetry and audit persistence.
- **T088:** Agent quota, router, tool, snapshot, and handoff runtime events emit through a fully fail-open structured telemetry facade; normal snapshot hit/miss outcomes are allowlisted, opaque-ID sanitization is centralized, and runtime logs contain fixed event names only.
- **T089:** NestJS emits closed-schema create/resolve/consume/replay metrics and audit metadata with linked opaque IDs; raw claim-release exception stacks are suppressed, and booking-intent consume plus idempotent/consumed replay paths are covered.
- **GREEN evidence:** From `apps/agent`, the focused telemetry/client/direct-stream/router/SSE/auth-budget suite passed `83` tests with the valid `ISSUE=true`/`ACCEPT=true` rollout configuration; Ruff and Python compile checks passed. From `apps/api`, the focused Jest suites passed `51` tests; `npm run test:e2e -- --runTestsByPath test/chat-handoff.e2e-spec.ts` passed `8` tests, including the real Agent→NestJS trace/audit flow; the focused handoff-consumption E2E passed `1` test.
- Playwright was not rerun; the prior user-provided successful run remains the 7A evidence. Continue only at the WP7C stop point for browser→agent→NestJS propagation verification.

### Phase 7: Work Package 7C GREEN Checkpoint (2026-08-10)

- **T090:** Direct and proxy browser requests now create separate `chat_<32 lowercase hex>` trace and correlation headers. Agent SSE sanitizes both values before constructing the NestJS client, and the client forwards only the sanitized values on service gateway calls. The Next.js proxy forwards only headers matching the exact opaque format and drops arbitrary values, preserving the rollback path without leaking sensitive header content.
- **Three-service proof:** `chat-handoff.e2e-spec.ts` now invokes the production browser request builder, carries its generated pair through a real FastAPI stream probe into the NestJS E2E server, and verifies the exact pair on access, memory, turn persistence, handoff creation, telemetry, and audit emission without using message/session/user/offer values as identifiers. The full file passed `9/9`; `agent-chat-gateway.e2e-spec.ts` passed `11/11` and covers numeric memory-query coercion discovered by the probe.
- **Focused GREEN evidence:** `test_nestjs_client.py` passed `24/24`; the renamed direct-stream trace/correlation test passed `1` with `11` deselected; the web `chatTrace.spec.ts`, `chatStream.spec.ts`, and proxy `route.spec.ts` suites passed `17/17`. The client also preserves legacy signed JWT compatibility while validating issuer/audience whenever those claims are present, uses the configured API base exactly once, and adapts NestJS `{token, expiresAt}` into the Agent `ACTION_HANDOFF` contract.
- Playwright was not rerun. The user-provided successful browser runs remain the browser-boundary evidence. WP7C is GREEN; proceed to the existing WP7D/T093 stop point only after the scoped review.

### Phase 7: Work Package 7D/T092 GREEN Checkpoint (2026-08-09)

- **Proxy rollback matrix:** direct streaming disabled uses the same-origin authenticated Next.js SSE proxy; direct streaming enabled bypasses it; both paths use bounded independent opaque trace/correlation IDs. Invalid incoming correlation values are dropped, and `ACTION_REQUIRED` SSE payloads remain byte-for-byte pass-through.
- **GREEN evidence:** route-level proxy tests passed `2/2`; the user-provided `tests/chat-checkout-handoff.spec.ts` browser run passed with `NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM=false`. The Playwright suite was not rerun.
- **T093 was pending at the T092 checkpoint:** the full three-service signed-search → handoff → bootstrap → claim/consume observation flow was the next stop point.

### Phase 7: Work Package 7D/T093 GREEN Checkpoint (2026-08-12)

- **Browser boundary coverage:** direct-stream tests reject identifier-bearing handoffs, exercise explicit-selection ordering, retain reconnect continuity, bypass the proxy, and keep legacy `ACTION_REQUIRED` separate. The handoff Playwright spec covers authenticated same-origin POST/bootstrap, strict one-field and versioned-credential validation, `SameSite=Strict` HttpOnly/Secure cookies, clean redirects, and credential absence from URLs, browser logs, storage, and the complete rendered DOM.
- **Three-service/API evidence:** `apps/api` `test/chat-handoff.e2e-spec.ts` passed `9/9`, including production browser request-builder → FastAPI → NestJS trace continuity, signed handoff creation, owner/internal-session resolution, and privacy-safe telemetry/audit linkage. The existing claim/readiness/intent regression covers atomic consume, exactly one winner, zero supplier calls by concurrent losers, encrypted chat persistence, and legacy checkout behavior. The focused Agent rollout suite passed `73/73` with the isolated cache override; the prior WP7A–WP7C flag, telemetry, and proxy evidence remains valid for the four safe flag combinations. These are composed real-boundary checks; the browser Playwright specs themselves intercept the stream, and no new single-harness browser-to-consume run was claimed or rerun.
- **Bootstrap/privacy hardening:** `/checkout/handoff` requires an authenticated NextAuth session plus exact same-origin Origin/Referer, exactly one `handoffToken` form field, and the exact `chk_handoff_v1_` credential shape. Malformed form parsing, cross-origin, and unauthenticated requests return controlled errors without setting a cookie; success returns a clean `303` and stores the credential only in an HttpOnly/Secure/SameSite=Strict cookie.
- **Continuous real-flow evidence:** `T093_REAL_FLOW=true` ran `apps/web/tests/chat-t093-real-flow.spec.ts` with real Next.js, deterministic NestJS, FastAPI, and Mimo boundaries against `test_db`; the exact-final-source run exited `0` with `1 passed (7.4m)`. It verified direct streaming, signed search, explicit selection, distinct `ACTION_REQUIRED`/`ACTION_HANDOFF`, clean native POST/bootstrap, owner/internal-session resolution, token-only readiness, 16-way consume concurrency, one persisted/consumed intent, two expected supplier calls, zero payment calls, four encrypted plaintext-free chat messages, session continuity, and zero credential/identifier leakage across URL, DOM, browser-readable cookies/storage, request URLs, and console output.
- **Focused/build evidence:** the web handoff boundary suite passed `11/11`; focused NestJS handoff/controller suites passed `20/20`; `next build` exited `0` after compiling and type-checking the passenger page plus both same-origin checkout proxy routes. The T093-only Playwright web server starts the installed Next CLI directly on Windows so Playwright does not recurse into an implicit `pnpm install`, while all non-T093 startup commands remain unchanged.
- **Handoff lifecycle hardening:** native form submission adds the credential only at `formdata` time; safe resolve projects only passenger IDs/types required by readiness; unreadable 200 resolve bodies are rejected before cookie issuance; readiness/intent browser payloads exclude tokens and offer/provider IDs; the server injects the HttpOnly cookie credential; and successful intent creation clears the cookie with the same root scope used at issuance.
- **Stop point:** T093 is GREEN. Phase 8 remains separately gated; retain the proxy rollback path and the plaintext-cleanup approval gates.

### Phase 8: Work Package 8D / T101 Approved Direct-Only Cleanup (2026-08-14)

- **Proxy route retirement:** Deleted temporary SSE proxy route `apps/web/app/api/chat/stream/route.ts` and test `apps/web/app/api/chat/stream/route.spec.ts`.
- **Direct-only transport configuration:** Removed `FEATURE_FLAG_CHAT_DIRECT_STREAM` and `NEXT_PUBLIC_ENABLE_DIRECT_AGENT_STREAM` variables from `apps/web` and `apps/agent` configuration schemas, examples, and tests. Updated `apps/web/lib/chatStream.ts` to direct-only transport (`POST ${NEXT_PUBLIC_AGENT_URL}/chat/stream`) with Bearer authentication and independent opaque `X-Trace-Id` / `X-Correlation-Id` propagation (`chat_<32 hex>`).
- **Web boundary & Playwright evidence:**
  - `apps/web/lib/featureFlags.spec.ts` & `apps/web/lib/chatStream.spec.ts`: 8/8 tests passed.
  - All web unit suites (`apps/web/tests/*.unit.ts`): 29/29 tests passed.
  - `apps/web/tests/chat-direct-stream.spec.ts`: 3/3 tests passed with exit code 0 (verified retired `/api/chat/stream` returns 404, direct streaming authenticates and reuses session, and identifier-bearing handoffs are rejected).
  - Next.js production build: 20 routes compiled cleanly with 0 TypeScript/ESLint errors and `/api/chat/stream` completely absent from the route manifest.
- **Backend & agent regression evidence:**
  - Python agent pytest: 264/264 tests passed.
  - NestJS handoff unit suites: 24/24 tests passed.
  - Shared types build (`@shared/types`): code 0.
- **Rollback matrix archived:** Direct streaming is canonical; proxy rollback matrix archived.

### Phase 8: Work Package 8E / T102 Approved Plaintext Cleanup (2026-08-14)

- **Database migration applied:** Applied migration `20260805010000_chat_message_plaintext_cleanup` dropping legacy plaintext columns `title` on `chat_sessions` and `content` on `chat_messages` via `prisma migrate deploy`. Preflight SQL assertions verified zero unmigrated rows.
- **Strict crypto & fail-closed behavior:**
  - `ChatMessageCryptoService`: Record-bound AES-256-GCM authenticated encryption/decryption with zero plaintext fallback. Throws fail-closed errors on missing key, corrupt payload, or auth tag mismatch.
  - `ChatService`: Exclusively writes to ciphertext envelopes (`contentCiphertext`, `contentNonce`, `contentAuthTag`, `contentKeyVersion` on messages; `titleCiphertext`, `titleNonce`, `titleAuthTag`, `titleKeyVersion` on sessions). Decrypts upon authorized retrieval.
  - `AgentGatewayService`: Securely decrypts `lastMessage` for honest cabin/passenger keyword limitation checks.
- **Zero-plaintext and security verification evidence:**
  - `test/chat-plaintext-cleanup.e2e-spec.ts`: 4/4 passed (verified exhaustive raw JSON scan for zero plaintext in DB, round-trip decryption, and fail-closed tampering detection).
  - `test/chat-privacy-corpus.e2e-spec.ts`: 3/3 passed.
  - `test/chat.e2e-spec.ts`: 18/18 passed.
  - `test/agent-chat-gateway.e2e-spec.ts`: 11/11 passed.
  - `test/agent-gateway.e2e-spec.ts`: 28/28 passed.
  - `test/chat-persistence-migration.e2e-spec.ts`: 3/3 passed.
  - `test/booking-readiness.e2e-spec.ts`: 10/10 passed.
  - Python agent pytest: 264/264 passed.
  - Next.js production build: 20 routes compiled cleanly with zero TypeScript errors.
- **Feature 017 complete:** All Phase 1 through Phase 8 tasks (T001–T102) completed, verified, and reconciled across codebase and documentation.

### Phase 11C: Rollback Matrix Verification, Chaos Incident Drills & Final Handover (2026-08-17)

- **Stepwise Rollback Matrix Verification (`apps/agent/tests/test_rollback_matrix.py` & `apps/api/test/rollback-matrix.e2e-spec.ts`)**:
  - **Step 1 Rollback (`ISSUE=false, ACCEPT=true`)**: Verified `POST /api/chat-handoff` returns 503 `Chat handoff issuance is disabled`. Agent deterministic node returns error dictionary and suppresses `ACTION_HANDOFF` emission. Pre-issued unexpired tokens continue resolving (200 OK) with safe allowlisted checkout context, claiming via CAS, and consuming into canonical `BookingIntent` records.
  - **Step 2 Rollback (`MULTI_AGENT=false`)**: Verified `router_node` checks `FEATURE_FLAG_CHAT_MULTI_AGENT` and safely bypasses router LLM, routing all queries directly to single-agent Travel Assistant (`"travel"`) with 0 unhandled exceptions.
  - **PostgreSQL Row Integrity**: Verified across 5 flag transition cycles that `ChatHandoff`, `BookingAgentProjection`, and encrypted `ChatMessage` rows remain 100% intact, readable, and decryptable with zero data corruption.
- **Chaos & Fault-Tolerance Incident Drills (`apps/agent/tests/test_chaos_simulation.py` & `apps/api/test/chaos-incident-drills.e2e-spec.ts`)**:
  - **Redis Partition / Outage Drill**: Mid-stream or pre-inference Redis failure fails closed with HTTP 503 `CHAT_CONTROL_PLANE_UNAVAILABLE`. Zero unbudgeted model inference or leaked burst reservations.
  - **Supplier Timeout & Recovery Drill**: Duffel 504 / timeout during live pricing in `BookingIntentService` triggers `releaseClaim` in `finally` block, safely clearing `claimedAt`, `claimTokenHash`, `claimExpiresAt`, `claimRecoverAfter` back to NULL. Zero orphaned `CLAIMED` locks remain; user successfully retries and consumes upon supplier recovery. Expired claim leases (> `claimRecoverAfter`) recover automatically.
  - **Abrupt Client Disconnect Drill**: Client connection drop (`asyncio.CancelledError`) cleanly releases session locks in generator `finally` handler. Monotonic fencing tokens (`validate_active_fence`) prevent stale turn persistence.
- **Automated Negative Privacy Continuous Audit (`apps/agent/tests/test_negative_privacy_audit.py` & `apps/api/test/negative-privacy-audit.e2e-spec.ts`)**:
  - Continuous automated scanner confirms 0 occurrences of forbidden corpus (raw tokens, plaintext chat, passport numbers, card numbers, Duffel offer IDs, PNRs) across PostgreSQL raw rows (`chat_messages`, `chat_sessions`, `chat_handoffs`, `audit_logs`), application logs, telemetry streams, and Redis keys (`chat:budget:*`, `chat:session-lock:*`, `chat:snapshot:*`).
- **Multi-Workspace Regression & Build Verification**:
  - `apps/agent`: 360/360 pytest tests PASSED.
  - `apps/api`: 72/72 unit test suites (682/682 tests) PASSED; 3/3 Phase 11C E2E suites (16/16 tests) PASSED.
  - `apps/web`: 25/25 tsx unit tests PASSED; Next.js production build succeeded with 20/20 routes.
- **Final Handover Complete**: Feature 017 operational sign-off completed 100%.
