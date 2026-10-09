# Implementation Plan: Chatbot Backend Infrastructure and Booking Handoff

**Branch**: `017-chatbot-backend-infrastructure` | **Date**: 2026-08-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/017-chatbot-backend-infrastructure/spec.md`

## Summary

Evolve the existing FastAPI/LangGraph chatbot from one broad agent with a fake confirmation-gated `book_flight` tool into the accepted read-only, multi-agent architecture. One stateless Router sends each turn to a tool-free General-Purpose Agent, a five-tool Travel Assistant, or a one-tool Checkout Orchestrator. Search results create a code-owned Trusted Search Snapshot; explicit checkout commitment becomes a read-only state signal; deterministic nodes ask NestJS to issue an owner/session/offer-bound handoff token; and checkout resolves and consumes that token through the existing deterministic readiness and intent pipeline.

The implementation reuses the working chat domain, API-key plus user-claim gateway authentication, input/output guardrails, memory summarization, readiness projection, and SSE infrastructure while hardening their boundaries. It migrates JWTs to required identity/revocation claims, routes all agent persistence through service-authenticated endpoints, encrypts ChatMessage content at the application boundary, replaces instance-local controls with PII-free Redis state, adds NestJS-signed search attestations and a dedicated BookingAgentProjection, stages direct FastAPI streaming, and adds a claimed-then-consumed `ChatHandoff` lifecycle. The LLM receives no write tool, token, URL, local/provider identifier, payment data, or passenger PII.

## Technical Context

**Language/Version**: Python 3.11+ for `apps/agent`; TypeScript 5.4+ for NestJS/shared/web; SQL through Prisma migrations

**Primary Dependencies**: Existing FastAPI, SSE-Starlette, Pydantic 2, PyJWT, HTTPX, LangChain 1.3.x, LangGraph 1.2.x, LangChain OpenAI adapter/Mimo, NestJS 10, Prisma 5, Next.js App Router, NextAuth, Zod; add direct Python `redis` asyncio dependency and declare LangGraph as a direct dependency rather than relying on LangChain transitively

**Storage**: PostgreSQL through Prisma for encrypted durable chat, safe booking projections, audit, and handoff/claim records; Redis for one-script daily/burst admission, fenced session serialization, and PII-free attested Trusted Search Snapshots; application encryption keys remain outside PostgreSQL; no agent-direct PostgreSQL access

**Testing**: pytest/pytest-asyncio for agent unit/integration/contract tests; Jest for NestJS unit/integration tests; NestJS/Supertest E2E; Playwright for direct-stream and checkout handoff browser flows

**Target Platform**: Existing Linux-hosted web/API/agent services, PostgreSQL 16, Redis 7, and modern browsers with fetch streaming

**Project Type**: pnpm monorepo with Next.js web, NestJS deterministic API, Python FastAPI agent, and shared TypeScript contracts

**Performance Goals**: With model/supplier boundaries stubbed, accepted request-to-router application overhead p95 under 100 ms; handoff create/resolve p95 under 300 ms; quota rejection before any inference; no extra Duffel call during handoff issue/resolve

**Constraints**: Zero LLM write tools; no PII or offer IDs in chat events/LLM context/logs/traces/audits; the handoff token may appear only in the strict `ACTION_HANDOFF.handoffToken` field and redacted same-origin bootstrap POST/cookie path, never in text/URL/telemetry/browser storage; legacy ChatMessage/title plaintext remains inventoried only during the reversible observation window and is absent from PostgreSQL/backups after approved Phase 17/T102; no PII in Redis; no supplier call inside a DB transaction or by a losing claim; direct streaming must enforce canonical JWT claims plus revocation/active-user checks and strict CORS; existing SSE events and non-chat checkout remain compatible

**Scale/Scope**: One active Trusted Search Snapshot per authenticated user/session, top five search results, default 50 messages/user/UTC day plus existing 60/minute burst limit, horizontal agent instances sharing Redis controls, five user stories across four workspace areas

## Constitution Check

_GATE: Passed before research and re-checked after design._

| Principle                          | Design response                                                                                                                                                                                                                                                                                                                     | Result |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Flight-First Architecture          | Work is limited to flight discovery, booking inquiry, and handoff into the existing flight checkout; no hotel, dining, or trip-planner scope is introduced.                                                                                                                                                                         | PASS   |
| Deterministic Transaction Boundary | The LLM has six read-only/state-signal tools. Deterministic LangGraph nodes and NestJS own token creation; NestJS readiness/intent/payment/booking services remain authoritative.                                                                                                                                                   | PASS   |
| API Budget Discipline              | Handoff issue/resolve uses stored FlightOffer data and performs no Duffel call. Repricing remains at the existing deterministic checkout commitment point. Chat quota blocks cost before inference.                                                                                                                                 | PASS   |
| Observability                      | Cross-service trace propagation, PII-safe routing/quota/handoff metrics, Redis health, and dashboard/alert contracts are explicit deliverables.                                                                                                                                                                                     | PASS   |
| Incremental Delivery               | Seventeen phases separate controls, additive encrypted persistence, attestation, credential primitives, acceptance, action, consumption, observation, and two approved cleanups. Phases 1–15 are flaggable/backward compatible; Phases 16–17 require separate approval.                                                             | PASS   |
| Security Requirements              | Canonical JWT/revocation checks, service-auth chat persistence, application-level chat encryption, exact projection DTOs, signed selection attestations, hash-only tokens, server-owned session binding, pre-supplier claim CAS, clean-URL bootstrap, fail-closed Redis admission, fencing, and privacy corpus tests are mandatory. | PASS   |

### Post-design re-check

The data model and contracts preserve every gate. Redis contains only counters, locks, and the explicitly PII-free Trusted Search Snapshot. PostgreSQL remains the durable source for chat and token lifecycle. The only new write endpoint is inaccessible to the LLM and is called solely from a deterministic graph node over the existing service-authenticated boundary.

## Baseline and Migration Seams

| Existing capability to retain                   | Current evidence                                                                | Planned seam                                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JWT-protected SSE, guardrails, message batching | `apps/agent/src/agent/streaming/sse.py`                                         | Decompose into orchestration/event helpers without changing token/done/error semantics.                                                                              |
| NestJS-owned sessions/messages/memory           | `apps/api/src/chat/*`, `ChatSession`, `ChatMessage`                             | Add soft deletion and versioned AES-GCM message envelopes; move all agent writes/reads to service-authenticated endpoints and prevent browser AGENT/SUMMARY forgery. |
| API key + short-lived user claim                | `apps/api/src/agent-gateway/auth/*`, `apps/agent/src/agent/auth/claim_token.py` | Reuse for all read tools and deterministic handoff creation.                                                                                                         |
| Readiness projection and `ACTION_REQUIRED`      | Feature 016 gateway/SSE/web code                                               | Preserve as profile/inline correction only; add separate `ACTION_HANDOFF`.                                                                                           |
| Output safety hard stop                         | `apps/agent/src/agent/guardrails/output_pipeline.py`                            | Continue applying to text; only schema-validated structured events bypass text transformation.                                                                       |
| Monolithic graph and fake booking tool          | `apps/agent/src/agent/graph/*`, `tools/registry.py`                             | Replace graph topology, remove confirmation interrupt and `book_flight`.                                                                                             |
| Broad booking list projection                   | `agent-gateway/dto/user-bookings.dto.ts`                                        | Replace broad snapshot-derived reads with dedicated BookingAgentProjection summary/detail DTOs and opaque reference.                                                 |
| Process-local limits/queue/search cache         | middleware, queue, `FLIGHTS_CACHE`, `MemorySaver`                               | Move cost, serialization, and trusted selection state to shared Redis; reconstruct messages from NestJS each turn.                                                   |
| Next.js SSE proxy                               | `apps/web/app/api/chat/stream/route.ts`                                         | Keep as rollback path until direct authenticated FastAPI streaming passes; then remove.                                                                              |

## Design Decisions

### 1. One graph per turn, durable context restored at entry

The compiled LangGraph remains a single graph containing all agent nodes, but it no longer needs an interrupt-capable checkpointer after the confirmation node is removed. Each stream request validates canonical JWT claims plus NestJS-backed active/revoked state, loads authorized decrypted summary/recent messages through the service-authenticated gateway and the PII-free current search snapshot from Redis, invokes one shared `AgentState`, and persists the encrypted completed turn through the same gateway. Browser endpoints force USER/STANDARD; fencing prevents a stale worker from persisting AGENT/SUMMARY. Missing snapshot state after expiry causes a fresh-search response; it never falls back to parsing an offer from conversation text.

### 2. Redis is the agent control plane, not conversation storage

Create one `redis.asyncio.Redis` client in FastAPI lifespan and close it on shutdown. Small repository classes own exact prefixes and atomic scripts:

- `chat:budget:{userId}:{YYYY-MM-DD}` plus `chat:burst:{userId}:{window}`: one versioned Lua admission script increments both only when both admit, uses next-UTC-boundary expiry, and never charges denied attempts.
- `chat:session-lock:{userId}:{sessionId}`: token-owned lease plus monotonic fencing token; refresh loss cancels work and NestJS durable writes reject stale fencing owners.
- `chat:snapshot:{userId}:{sessionId}`: versioned PII-free snapshot with TTL no longer than offer freshness.

Redis unavailability fails closed before inference. Health reports Redis separately. No message text, prompt, booking passenger data, token, or payment data is stored in these keys.

### 3. Structured stateless router with asymmetric checkout gate

Use the existing Mimo-compatible chat model with strict Pydantic structured output. `RouteDecision` permits only the four accepted intents, confidence in `[0,1]`, a commitment boolean, and an optional one-based selection index. The Router has no tools and never writes conversational text. A deterministic route function applies configured thresholds. Checkout requires every gate criterion; any checkout-like partial match routes to Travel Assistant with `possible_checkout`, while low-confidence non-checkout messages fall back safely to Travel Assistant.

### 4. Tool inventories are constructed per agent, not filtered at runtime

Replace the global registry with explicit immutable registries. General receives no tools. Travel receives `search_flights`, `get_user_preferences`, `list_user_booking_summaries`, `get_booking_detail`, and `check_booking_readiness`. Checkout receives only `signal_checkout_intent`. Registry contract tests compare exact names and assert no service client or mutation endpoint is reachable through the tool interface.

`signal_checkout_intent` is implemented as a state-updating LangGraph tool/controlled tool node. It accepts only `offer_index`, verifies the latest snapshot mapping, and sets a typed `CheckoutSignal`; it performs no I/O.

### 5. Trusted Search Snapshot is separate from display results

After the stripping consumer is deployed, the new graph opts into `POST /api/agent-gateway/v2/flights/search` with an owned session and proposed next snapshot version. NestJS returns a trusted envelope containing local/provider IDs, display fields, freshness, and a signed user/session/ordered-offer/version/expiry attestation. The legacy GET stays display-only throughout rollback. The new executor splits the POST response immediately:

- A PII-free snapshot containing identifiers, service-only attestation, and minimal validation fields is stored in AgentState/Redis.
- A formatted numbered summary without identifiers is returned as the ToolMessage to the LLM.
- The existing `flight_results` browser event is produced from a separate exact display projection with no identifier fields.

Every successful search increments `snapshotVersion` and atomically overwrites the prior record. Failed searches leave the prior snapshot unchanged only if it is still fresh; the response clearly says the new search failed. No module-level `FLIGHTS_CACHE` remains.

### 6. Booking data is split into summary and explicit detail

Add a one-to-one `BookingAgentProjection` with a unique opaque reference and only the accepted summary/detail columns. Populate it transactionally at confirmation, refresh it during supplier synchronization, and backfill existing bookings before tool enablement. Summary/detail methods query only this projection and include no-raw-snapshot-load tests. Price/currency, fare class, passenger count, DB ID, PNR, PII, and raw snapshots never cross the gateway.

### 7. Handoff credentials are hash-only and retry-reproducible

Add `ChatHandoff` with unique `tokenHash` and server-derived `idempotencyKeyHash`, owner/session/FlightOffer/attestation binding, expiry, internal claim fields, optional consumption time, and optional unique BookingIntent relation. Token material is a versioned, high-entropy HMAC output derived from a secret key, random row ID, and binding that NestJS derives from the verified attestation digest plus selected index. Callers supply neither IDs nor idempotency keys. NestJS can re-derive the same token for an active retry while persisting only hashes/key version.

The deterministic agent node validates selection against the owner/session Redis snapshot before the call. NestJS verifies the signed attestation, claimed user, active owned ChatSession, ordered offer/index binding, exact FlightOffer/Duffel match, local freshness, and `ISSUE` flag; the agent and endpoint both enforce issuance off. It performs no Duffel/payment/intent call. Duplicate active requests converge; replaced/expired attestations cannot mint credentials.

### 8. Resolve is read-only; consume is atomic with intent creation

`POST /api/bookings/handoffs/resolve` accepts only the token in a no-store body plus authenticated user, recovers and validates the stored ChatSession relation internally, and returns safe context without consuming. Client-supplied session fields fail strict validation.

Canonical readiness accepts server-read `handoffToken` as an additive alternative to `flightOfferId` and derives session/offer internally. Intent creation first CAS-claims in a short transaction. The owner compare-and-refreshes under a watchdog; supplier hard timeout plus finalization margin stays below remaining claim TTL, refresh loss cancels work, and takeover waits through a recovery buffer. The final transaction revalidates unexpired claim ownership plus active/non-deleted ChatSession before creating BookingIntent and consuming. Existing non-chat paths remain untouched.

### 9. `ACTION_HANDOFF` is an application event, never LLM text

Add a versioned Pydantic event model in Python and matching Zod/shared TypeScript contract. The deterministic create node emits only:

`version`, `action: begin_checkout`, `handoffToken`, `expiresAt`, and exact presentational airline/route/departure/price/currency fields.

It contains no URL or offer identifier. The web parser rejects unknown versions/actions/extra keys, then POSTs the transient credential to a CSRF/origin-protected same-origin bootstrap. That route stores it only in a short-lived HttpOnly/Secure/SameSite cookie and 303-redirects to clean `/checkout/passengers`; access/APM logs redact the body. The page resolves server-side and never places the token in URLs, readable storage, analytics, logs, or nested links.

### 10. Direct streaming is a staged transport migration

Add public agent URL configuration, strict origin allowlist, credentials-disabled bearer requests, trace/correlation headers, and client access to the canonical NextAuth session JWT. Deploy FastAPI CORS/auth/active-revocation support and browser tests before changing the client. Then point `ChatWidget` directly to FastAPI and verify connection/session continuity while the flag-controlled `apps/web/app/api/chat/stream/route.ts` fallback remains tested throughout the observation window. Remove the proxy only in Phase 16 after explicit approval and final focused direct-only regression; it is not a permanent second architecture.

### 11. Existing safety pipeline is preserved, not re-platformed

This feature does not introduce NVIDIA's `nemoguardrails` package. The existing fail-closed input/output classification and PII pipeline remains the enforced boundary and gains an ingress sensitive-PII block before the message reaches the model or raw ChatMessage persistence, plus privacy tests for prompts, ToolMessages, and application events. Misleading naming may be cleaned up only if it does not change behavior. Replacing the safety engine is a separate reviewed security feature.

### 12. Chat persistence uses application-level authenticated encryption

Migrate ChatMessage content and ChatSession title to record-bound AES-256-GCM ciphertext with external versioned keys, authorized gateway-only decryption, dual-read/backfill verification, and database/backup inventory while legacy columns remain for rollback. ChatSession becomes soft-deletable: deletion prevents future access/writes and revokes active claims/handoffs while retaining consumed linkage only for the documented audit period. Legacy plaintext removal occurs only in separately approved Phase 17; rotation and retention are tested operational contracts.

## Bite-Sized Delivery Phases

| Phase                                              | Scope and owned files                                                                                                                                     | Entry → exit criteria                                                                                                 | Focused verification                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1. Contract/JWT/flag freeze                        | shared/Pydantic contracts, canonical token profile, crypto/Redis/handoff config                                                                           | Existing suites green → exact contracts compile and flags default off                                                 | real Nest token fixtures; cross-language schema/config tests              |
| 2. Redis lifecycle and health                      | pooled async client, lifespan, dependency health                                                                                                          | Phase 1 → startup/close/degradation behavior green                                                                    | lifecycle and health tests                                                |
| 3. Atomic quota admission                          | one Lua daily/burst decision with UTC semantics                                                                                                           | Phase 2 → accepted-only charging across instances                                                                     | limit-edge/UTC/error concurrency tests                                    |
| 4. Fenced session lease                            | lock sequence, refresh/cancel, NestJS write fence                                                                                                         | Phase 2 → stale workers cannot write or emit                                                                          | TTL/takeover/disconnect/refresh-loss tests                                |
| 5. Trusted snapshot repository                     | strict attested snapshot serialization/replace/TTL                                                                                                        | Phase 2 → PII-free owner/session state restores safely                                                                | schema/overwrite/isolation/expiry tests                                   |
| 6. Encrypted additive persistence                  | ChatMessage/title envelopes, ChatSession soft delete, BookingAgentProjection, ChatHandoff/claim schema, migrations/backfills                              | Phases 1–5 → ciphertext twins/backfills verified while legacy plaintext remains rollback-compatible; new schema inert | migration/backfill/ciphertext/relation/deletion tests                     |
| 7. Secure stream/persistence migration             | active/revoked JWT check, service-auth chat endpoints, direct-server CORS/auth, encrypted turn persistence                                                | Phase 6 → current assistant runs through hardened boundaries while client still uses proxy                            | real JWT/logout/deactivation; forged AGENT; restart/fence tests           |
| 8. Router and specialist graph                     | router schema/node, prompts, graph topology, obsolete confirmation removal                                                                                | Phase 7 → fixture matrix reaches expected specialist only                                                             | topology/malformed output/gate tests                                      |
| 9. Read tools, attested search, booking projection | exact registries, signed search envelope, safe summary/detail DTOs                                                                                        | Phase 8 → six-tool allowlist and exact read models enforced                                                           | attestation/snapshot; no-raw-snapshot-load; privacy E2E                   |
| 10. State-only checkout signal                     | one signal tool and no-I/O gate                                                                                                                           | Phase 9 → valid selection mutates per-turn state only                                                                 | no-I/O and invalid-index tests                                            |
| 11. Credential primitive                           | attestation verifier, server-derived idempotency, HMAC/hash/key rotation                                                                                  | Phase 10 → deterministic retry-safe credential unit green with no route enabled                                       | crypto/attestation/idempotency tests                                      |
| 12. Dark create/resolve API                        | service-auth create, user-auth token-only resolve, exact `ISSUE`/`ACCEPT` gates                                                                           | Phase 11 → dark server acceptance works without action emission                                                       | auth/owner/flag/freshness/strict DTO E2E                                  |
| 13. Deterministic action and clean web bootstrap   | agent client/nodes, SSE event, strict card, CSRF bootstrap cookie, clean checkout URL                                                                     | Phase 12 → valid internal action resolves without token URL/storage                                                   | ordering/privacy/parser/bootstrap Playwright                              |
| 14. Claimed canonical consume                      | Feature 016 preflight, token-only readiness, pre-supplier claim, final intent/consume CAS                                                                | Phase 13 plus verified plural seam → one winner/zero supplier losers                                                  | rollback/recovery/100-way claim race                                      |
| 15. Direct cutover, observability, and observation | ChatWidget direct stream, metrics/traces/runbook/context docs; proxy retained                                                                             | Phases 1–14 → full topology observed with rollback proven                                                             | full three-service E2E; privacy/security/performance/flag matrix          |
| 16. Approved direct-only cleanup                   | archive proxy rollback evidence, remove proxy/false flag state, direct-only config                                                                        | explicit Phase 15 transport approval → direct-only topology with focused regression green                             | direct-stream/session/handoff plus direct-only config rejection           |
| 17. Approved plaintext cleanup                     | retain recovery export; drop legacy ChatMessage content and ChatSession title plaintext only after live dual-read/write observation/backfill/backup proof | separate encrypted-chat approval → ciphertext-only schema with legacy readers shut down                               | cleanup migration; decrypt round-trip; DB/backup scan; recovery rehearsal |

Redis lifecycle must precede the quota, lease, and snapshot packages; those three can then develop independently but merge behind separate GREEN checkpoints. Encrypted/additive persistence precedes secure stream cutover but retains the plaintext representation used by the old application. Credential cryptography is independently reviewed before dark create/resolve API work. Action emission waits for dark acceptance. Before Phase 14, the Feature 016 preflight must prove the canonical plural readiness/intent seam; if it fails, stop after dark resolve/bootstrap and keep issuance off. Direct client cutover is last. Proxy removal is approved Phase 16; plaintext-column removal is a separate Phase 17 only after live encrypted-chat observation, recovery export, verified backfill/database/backup scans, and legacy-reader shutdown.

## Requirement Traceability

| Requirements / outcomes        | Owning phases | Required proof                                                                                                   |
| ------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| FR-001–009; SC-002, SC-008     | 1–7, 15       | canonical JWT/revocation, service-auth persistence, direct auth/CORS, Lua admission, encryption and safety tests |
| FR-010–018; SC-001, SC-003     | 8–10          | topology, structured router, thresholds, tool allowlist, state-only signal tests                                 |
| FR-019–021; SC-004             | 5, 9, 11–13   | signed attestation, snapshot overwrite/TTL/isolation and negative corpus                                         |
| FR-022–024; SC-004             | 6, 9          | BookingAgentProjection exact keys, ownership, no broad snapshot load, PII exclusion                              |
| FR-025–028; SC-005–006         | 11–14         | attestation verification, server-derived idempotency, hash-only retry, flag/auth/concurrency tests               |
| FR-029–031; SC-007             | 1, 13, 15     | strict event parsing, CSRF bootstrap, clean URL, legacy event regression                                         |
| FR-032–035; SC-005–006, SC-010 | 12–14         | token-only resolve, pre-supplier claim, final atomic consume, compatibility                                      |
| FR-036–043; SC-008–010         | 1–17          | flags, fencing, soft deletion, encryption/rotation/cleanup, telemetry, full quickstart/regression suites         |

## Project Structure

### Documentation (this feature)

```text
specs/017-chatbot-backend-infrastructure/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── api.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/agent/
├── pyproject.toml
├── src/agent/
│   ├── config.py
│   ├── main.py
│   ├── agents/
│   │   ├── general_agent.py
│   │   ├── travel_assistant.py
│   │   └── checkout_orchestrator.py
│   ├── graph/
│   │   ├── graph.py
│   │   ├── nodes.py
│   │   ├── router.py
│   │   └── state.py
│   ├── infrastructure/redis.py
│   ├── middleware/rate_limit.py
│   ├── models/events.py
│   ├── queue/message_queue.py
│   ├── repositories/
│   │   ├── chat_budget_repository.py
│   │   ├── session_lock_repository.py
│   │   └── trusted_snapshot_repository.py
│   ├── streaming/sse.py
│   └── tools/
│       ├── booking_detail.py
│       ├── booking_summaries.py
│       ├── registry.py
│       ├── search_flights.py
│       └── signal_checkout_intent.py
└── tests/

apps/api/
├── prisma/schema.prisma
├── prisma/migrations/20260805000000_chatbot_handoff/
├── prisma/migrations/20260805010000_chat_message_plaintext_cleanup/
├── prisma/scripts/backfill-booking-agent-projections.ts
├── prisma/scripts/backfill-encrypted-chat-messages.ts
├── src/agent-gateway/
│   ├── dto/
│   ├── agent-booking-reference.service.ts
│   ├── agent-gateway.controller.ts
│   └── agent-gateway.service.ts
├── src/chat-handoff/
│   ├── dto/
│   ├── chat-handoff.controller.ts
│   ├── chat-handoff.service.ts
│   ├── chat-handoff-token.service.ts
│   └── chat-handoff.module.ts
├── src/chat/chat-message-crypto.service.ts
├── src/booking-intent/
└── test/

apps/web/
├── components/chat/
│   ├── ChatWidget.tsx
│   └── CheckoutHandoffCard.tsx
├── app/checkout/handoff/route.ts
├── app/checkout/passengers/page.tsx
├── lib/chatStream.ts
└── tests/chat-checkout-handoff.spec.ts

packages/shared/src/types/
├── chat.types.ts
└── index.ts

docs/runbooks/chatbot-handoff.md
```

**Structure Decision**: Extend the existing three services and shared package. Add one NestJS `chat-handoff` domain module because token lifecycle is deterministic application state and should not be mixed into the read-only agent tool service. Keep routing and trusted state in `apps/agent`; keep presentation in `apps/web`; introduce no new deployable service or database.

## Compatibility and Rollout

1. Add shared contracts and flags with defaults off: `FEATURE_FLAG_CHAT_MULTI_AGENT`, `FEATURE_FLAG_CHAT_HANDOFF_ACCEPT`, `FEATURE_FLAG_CHAT_HANDOFF_ISSUE`, `FEATURE_FLAG_CHAT_DIRECT_STREAM`, plus public agent URL/origin and quota/handoff TTL settings. Existing graph and proxy remain active.
2. Deploy Redis-backed quota/burst/session locking and health before multi-agent routing. If Redis is down, chat returns a stable 503 without model cost; ordinary web/API booking remains unaffected.
3. Apply additive encrypted ChatMessage/title, ChatSession soft-delete, BookingAgentProjection, and ChatHandoff/claim migrations. Backfill/verify ciphertext/projection rows and inventory database/backups while retaining legacy plaintext for rollback; do not drop it before the separate Phase 17 gate.
4. Deploy service-authenticated chat persistence, signed search attestation, narrow projection endpoints, and handoff create/resolve acceptance dark. Continue serving compatibility routes only to the old graph; collect exact caller telemetry.
5. Enable multi-agent routing with handoff issuance disabled. Remove the fake `book_flight` path and verify searches, preferences, booking inquiries, readiness, disambiguation, and legacy `ACTION_REQUIRED`.
6. Deploy strict web support for `ACTION_HANDOFF` while issuance is still disabled. Unknown versions/actions remain ignored with safe telemetry.
7. Enable handoff issuance for internal/test users. Use the same-origin POST/bootstrap cookie and clean checkout URL, resolve server-side by token plus user, and target canonical plural readiness/intent with the pre-supplier claim protocol. Existing search-page offer-ID checkout and singular compatibility routes remain available.
8. Enable direct browser→FastAPI streaming after CORS/JWT/session continuity tests in the deployed topology. Keep the proxy and its configuration behind the transport flag for the complete observation window and rollback-matrix test.
9. Rollback order during observation: disable issuance → disable multi-agent router → revert client to proxy if needed. Acceptance may stay enabled to honor already-issued unexpired tokens. Never drop `ChatHandoff`, encryption envelopes, or BookingAgentProjection rows during rollback.
10. Only after explicit observation approval, archive the successful rollback matrix, delete the proxy and obsolete `Direct=false` configuration, then rerun direct-stream/session/full-handoff plus direct-only configuration rejection tests. This cleanup is not part of the reversible rollout checkpoint.
11. Under explicit encrypted-chat approval, live dual-read/write observation, complete message/title ciphertext twins, recovery export, and database/backup inventories were verified; Phase 17 / Phase 8E plaintext cleanup (`20260805010000_chat_message_plaintext_cleanup`) has been applied, dropping legacy columns with final zero-plaintext checks passed.

## Observability Deliverables

- Propagate or create `x-trace-id` and `x-correlation-id` browser → FastAPI → NestJS; correlate them with ChatSession without putting identifiers in response bodies.
- Emit PII-safe structured events for JWT claim/revocation rejection, encrypted persistence/backfill/rotation status, quota admit/deny/failure, fence loss, route decision, specialist selection, disambiguation, tool outcome, attestation/snapshot write/miss/expire, handoff issue/replay/resolve/claim/release/consume/reject, bootstrap outcome, direct transport, and output hard stop.
- Metrics: accepted/denied chat messages, daily quota utilization buckets, burst rejects, Redis errors/latency, active streams, router intent/confidence/latency, disambiguations, tool calls/errors/latency, snapshot hit/miss/replace/expire, handoff issue/resolve/consume/replay/foreign/expired/stale counts, and stream time-to-first-safe-token.
- Required negative fields for logs/traces/audits: message content, summary content, handoff token/hash, local/Duffel offer ID, raw tool payload, booking DB ID, PNR, passenger/contact/passport/payment data.
- Add `docs/runbooks/chatbot-handoff.md` with dashboard panels, alert thresholds, feature-flag state, Redis failure response, JWT/attestation/token/chat-encryption rotation, encrypted backup verification/retention, in-flight claim/token rollback policy, direct-stream CORS troubleshooting, and expired/stale recovery.
- Alerts: Redis health failure; quota bypass invariant failure; error rate above 2× baseline for five minutes; router malformed-output spike; any cross-owner handoff attempt spike; any token integrity or privacy-corpus failure; handoff resolve/consume p95 above 300 ms; first-safe-token p95 regression.

## Verification Strategy

- **Unit**: canonical JWT profile; AES-GCM envelope/rotation; Router/gate; tool inventory; state-only signal; signed snapshot serializer; combined Redis Lua; fenced lease; attestation/idempotency/token/hash/key version; exact event schemas.
- **Integration**: JWT active/revoked ordering; service-auth encrypted chat persistence; BookingAgentProjection-only reads; signed create; token-plus-user resolve; pre-supplier claim and final intent/consume transaction.
- **Boundary/security**: no LLM/tool reaches create; no identifiers/PII/plaintext chat in disallowed stores or events; credential exists only in exact action field and redacted bootstrap/HttpOnly path; zero credential URL/access-log matches; client session fields rejected; tokens hash-only; service/encryption keys never enter graph/database.
- **E2E**: direct stream → signed search → selection → `ACTION_HANDOFF` → bootstrap/clean URL → server resolve → readiness → claim → canonical intent; ambiguity/fresh search; expired/invalid attestation; 100-way zero-supplier-loser consume; disconnect/fence loss; feature flags.
- **Performance**: deterministic model/supplier fakes; 100 warmed requests for router overhead and handoff endpoints; 100 concurrent quota increments and token consumes.
- **Regression**: existing chat persistence, guardrail, SSE hard-stop, agent gateway, readiness, checkout, ancillary, payment, and booking tests; old `ACTION_REQUIRED` behavior remains.
- **Test workflow**: Backend E2E under `apps/api/test/`; Playwright under `apps/web/tests/` using `NEXT_PUBLIC_API_URL` and explicit agent webServer/config; tests observe only public boundaries and follow repository RED → GREEN → REFACTOR rules.

## Complexity Tracking

| Transitional complexity                                     | Why needed                                                                                                                                                                           | Simpler alternative rejected because                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Redis-backed quota, lock, and trusted snapshot repositories | Direct streaming and multiple agent instances need cost control, session serialization, and selection state that are not process-local; Redis already exists and stores no PII here. | Keeping dictionaries/MemorySaver loses guarantees on restart and scales quota per process.                        |
| Dedicated `chat-handoff` module and table                   | Single-use, owner/session-bound checkout credentials require durable, auditable CAS state.                                                                                           | A raw offer ID or signed URL cannot enforce consumption, duplicate prevention, or authoritative lifecycle checks. |
| Temporary proxy/direct dual transport flag                  | The accepted direct topology must be deployed without an all-at-once browser/CORS/auth cutover.                                                                                      | Immediate proxy deletion creates an unrecoverable coordinated deployment boundary.                                |
| BookingAgentProjection safe read model                      | Existing Booking columns cannot serve accepted logistics without loading broad snapshots; the LLM needs a stable opaque selector.                                                    | Returning DB IDs or loading raw snapshots violates the exposure tier.                                             |
| Application-level encrypted ChatMessage migration           | Conversation text can contain identity-linked PII and must satisfy the constitution across database/backups.                                                                         | Undocumented volume encryption cannot prove record-level plaintext absence or narrow decryption access.           |
| Pre-supplier handoff claim                                  | Concurrent intent requests must be rejected before paid supplier validation while preserving crash recovery.                                                                         | A final consume CAS alone permits every contender to call Duffel before one wins.                                 |
