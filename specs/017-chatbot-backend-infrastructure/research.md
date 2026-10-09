# Research: Chatbot Backend Infrastructure and Booking Handoff

**Date**: 2026-08-05

**Status**: Complete — all planning questions resolved

## Repository Baseline

- The standalone `apps/agent` FastAPI service, direct-to-agent target topology, JWT ingress, NestJS-owned chat persistence, manual sliding window/summary strategy, and read-only default tools originate in `docs/adr/0014-chatbot-backend-architecture.md`.
- The accepted orchestration decisions in `CONTEXT.md` and `docs/adr/0015-chatbot-booking-orchestration.md` supersede the old open topology questions: four agent roles plus a deterministic handoff pipeline, six fixed read-only tools, asymmetric checkout gate, Trusted Search Snapshot, two-tier booking projection, and `ACTION_HANDOFF`.
- Current working code already supplies authenticated SSE, persistence, guardrails, API-key plus user-claim gateway auth, search/preferences/bookings/readiness tools, and tests. It does not supply the accepted router, tool tiers, trusted snapshot, token lifecycle, or action event.
- Current contradictions to migrate: a Next.js stream proxy, monolithic graph, process-local `MemorySaver`/limits/queues, popped `FLIGHTS_CACHE`, broad booking DTO, fake `book_flight`, confirmation interrupt, unversioned action event, and no cross-language shared SSE contract.

## Decision 1: Preserve three services and assign state by authority

**Decision**: Keep Next.js for presentation, FastAPI/LangGraph for advisory orchestration, and NestJS/PostgreSQL for durable chat and deterministic application state. Do not add another service or database.

**Rationale**: This is the accepted ADR and current deployment shape. NestJS already owns users, sessions, messages, offers, readiness, intents, audits, and service authentication. Handoff lifecycle is deterministic application state and belongs there. Python should never access PostgreSQL directly.

**Alternatives considered**:

- Move orchestration into NestJS: rejected by the accepted multi-agent Python/LangGraph decision.
- Give the agent its own PostgreSQL/SQLite database: rejected because it creates a second migration/backup authority.
- Store handoffs only in Redis: rejected because single-use consumption and BookingIntent binding require durable, auditable transaction state.

## Decision 2: Direct browser-to-agent streaming is an explicit staged migration

**Decision**: Implement the ADR-approved browser → FastAPI stream. Keep the current Next.js proxy only behind a temporary rollback flag until public agent URL, JWT access, strict CORS, trace headers, disconnect behavior, and browser tests pass.

**Rationale**: The current proxy contradicts both the named ADR and the repository rule limiting Next.js route handlers. Direct streaming removes the second long-lived connection and per-token proxy hop. Before cutover, NestJS must migrate its JWT profile to required `sub`/`iss`/`aud`/`jti` claims and FastAPI must verify NestJS-backed active-user/revocation state; signature-only validation is insufficient.

**Alternatives considered**:

- Permanently retain the Next.js BFF: operationally convenient but directly conflicts with the accepted topology and leaves duplicate streaming/error handling.
- Issue a new short-lived chat token from NestJS: rejected in the ADR and unnecessary with the existing JWT.
- Delete the proxy in the first deployment: rejected because public CORS/auth/deployment behavior needs a reversible observation window.

## Decision 3: Remove LangGraph checkpointing after removing interrupts

**Decision**: Compile the single multi-agent graph without `MemorySaver`. Reconstruct durable message context from NestJS and restore only the current PII-free search snapshot from Redis at each turn. All agents still share one typed `AgentState` within the turn.

**Rationale**: The only current interrupt exists for the obsolete `book_flight` confirmation path. LangGraph persistence is useful for human interrupts and fault recovery, but it stores graph channels, including messages; using a Redis/Postgres checkpointer would duplicate PII-bearing conversation storage and weaken the authority boundary. Official LangGraph guidance confirms checkpointers organize state by thread and are required for interrupt/resume, while graph state can otherwise be supplied on invocation: [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api).

**Alternatives considered**:

- Keep process-local `MemorySaver`: rejected because it is instance-local and unnecessary without interrupts.
- Add a Postgres checkpointer: rejected because it gives the agent direct database ownership and duplicates chat persistence.
- Add a Redis checkpointer: rejected because graph messages may contain PII; only the explicit PII-free snapshot is allowed in Redis.

## Decision 4: Use Redis asyncio as a narrow control plane

**Decision**: Add one application-lifetime `redis.asyncio` client and small repositories for one-script daily/burst admission, fenced session leases, and Trusted Search Snapshot keys.

**Rationale**: Redis 7 already runs for the system. A shared async client matches FastAPI's event loop and provides cross-instance atomic controls. Redis's official client guidance recommends one pooled async client created at startup and closed at shutdown: [redis-py asynchronous operations](https://redis.io/docs/latest/develop/clients/redis-py/async/).

**Alternatives considered**:

- Keep in-process dictionaries: rejected because limits and locks become per instance and vanish on restart.
- Call NestJS for every quota/lock operation: rejected because it adds a network hop to every turn and turns transient orchestration controls into API/database concerns.
- Store full AgentState: rejected because it would put user message content in Redis.

## Decision 5: Use strict structured router output and deterministic edge logic

**Decision**: The Router is a no-tool model call with strict Pydantic output. A deterministic conditional route applies allowed intents, confidence thresholds, commitment, snapshot presence, and selection resolution. Router failure never executes checkout.

**Rationale**: This matches the accepted asymmetric gate and keeps the LLM responsible only for semantic classification. Official LangGraph guidance supports typed state plus conditional edges and advises using one routing mechanism per node: [LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api).

**Alternatives considered**:

- Keyword router: rejected by the accepted decision because it cannot reliably distinguish curiosity from commitment.
- Router-generated clarification: rejected because the Router must remain single-purpose and stateless.
- Confidence-only checkout routing: rejected because a high score without snapshot, commitment, or resolvable selection is unsafe.

## Decision 6: Declare exact tool inventories per agent

**Decision**: Construct separate immutable tool lists for General (none), Travel (five accepted reads), and Checkout (state-only signal). Remove `book_flight`, confirmation metadata, interrupt, resume input, and confirmation SSE event from the new graph path.

**Rationale**: Construction-time scoping is easier to audit than runtime filtering. `signal_checkout_intent` updates typed graph state and performs no I/O; deterministic nodes own the service call. This directly enforces the constitutional no-write boundary.

**Alternatives considered**:

- One agent with all tools: rejected by the accepted decomposition.
- Keep `book_flight` as a harmless stub: rejected because it falsely reports transactional success and trains both tests and prompts around a prohibited capability.
- Give token creation to Checkout Orchestrator: rejected because service I/O would become LLM-triggerable as a tool.

## Decision 7: Persist only a compact Trusted Search Snapshot

**Decision**: Deploy an opt-in versioned POST search seam after its stripping consumer. It accepts an owned session plus proposed snapshot version and returns an identifier/attestation-bearing envelope; the legacy GET stays display-only. Split the opt-in response into a code/Redis snapshot, identifier-free ToolMessage, and identifier-free `flight_results` event. NestJS signs user/session/ordered offers/version/expiry; replace the snapshot atomically and expire with offer freshness.

**Rationale**: The current gateway omits offer identifiers, the Python module cache is popped after streaming, and readiness currently expects an ID the live LLM cannot safely obtain. A typed split makes the hidden identifier path explicit and testable.

**Alternatives considered**:

- Let the LLM echo an offer ID: rejected for prompt-injection and hallucination risk.
- Resolve from conversation text: rejected because numbered results become stale after a new search.
- Store full Duffel response: rejected because it expands data surface and cache size without downstream need.

## Decision 8: Add an opaque Booking reference and exact DTO tiers

**Decision**: Add a one-to-one `BookingAgentProjection` with an opaque generated `agentReference`. Populate it at confirmation/supplier synchronization and backfill before enabling tools. Summary/detail endpoints query only exact projection columns and scope detail lookup by user plus reference.

**Rationale**: Current Booking columns cannot supply the accepted tiers, and the existing gateway derives them by loading broad flight/passenger snapshots. A dedicated safe read model makes the privacy boundary enforceable at the query layer and gives follow-up detail an opaque reference without exposing internal IDs.

**Alternatives considered**:

- Continue returning Booking.id: rejected by the privacy boundary.
- Use result index only: rejected because booking order can change between turns.
- Encode/encrypt the DB ID in the reference: rejected as unnecessary cryptographic complexity when an additive random column is cheap.

## Decision 9: Use hash-only, reproducible handoff credentials

**Decision**: `ChatHandoff` stores a SHA-256 token hash, key version, and server-derived idempotency hash. NestJS verifies the selection attestation and derives the binding from its digest plus selected index; callers cannot vary an idempotency key. The returned token is a versioned high-entropy HMAC output derived from the server secret, random row ID, and binding, so NestJS can re-derive it for an active retry without storing plaintext.

**Rationale**: Plaintext credentials must not be stored, logged, or audited. Purely random first-response tokens cannot be returned again after a lost response unless plaintext/encrypted token material is stored. Keyed deterministic derivation gives hash-only persistence, retry convergence, rotation support, and opaque unforgeability.

**Alternatives considered**:

- Store plaintext token: rejected as credential exposure.
- Store encrypted token: viable but adds encryption lifecycle when HMAC derivation is sufficient.
- Generate a new token on every retry: rejected because it invalidates an already-rendered card or creates multiple active credentials.
- Put the raw Duffel offer ID in the URL: rejected by the accepted handoff decision.

## Decision 10: Resolve repeatedly, claim before supplier access, consume once with BookingIntent

**Decision**: Token resolution uses token plus user and recovers the stored session internally. Intent submission CAS-claims before Duffel, then owner-refreshes under a watchdog with supplier timeout/finalization strictly inside the lease. Refresh loss cancels and blocks takeover through a recovery buffer. Finalization revalidates unexpired claim plus active/non-deleted session before atomically creating BookingIntent and consuming. Readiness remains unclaimed/read-only.

**Rationale**: Consuming on page view breaks refresh/back navigation. A final consume CAS alone happens too late because concurrent requests can all reprice before one wins. A pre-supplier claim makes losers fail before supplier cost, while the final claim-owner transaction avoids the crash gap between consumption and intent creation.

**Alternatives considered**:

- Consume on first page load: rejected due to refresh and prefetch behavior.
- Consume in a separate request before intent creation: rejected due to the crash gap.
- Create BookingIntent directly from chat: rejected by the deterministic checkout boundary and missing passenger confirmation.

## Decision 11: Add `ACTION_HANDOFF`; preserve `ACTION_REQUIRED`

**Decision**: Emit a new named, versioned application event containing only the registered action, opaque token, expiry, and presentational fields. Strict Pydantic and Zod schemas reject unknown actions, versions, URLs, identifiers, or extra keys. The registered action POSTs the transient token to a same-origin CSRF/origin-protected bootstrap, stores it only in a short-lived HttpOnly/Secure/SameSite cookie, and redirects to a clean URL. Existing named SSE events remain unchanged.

**Rationale**: `ACTION_REQUIRED` already serves profile/readiness correction. Reusing it would conflate correction with explicit booking commitment. A separate application event avoids LLM-generated links and lets the frontend build navigation locally.

**Alternatives considered**:

- Markdown link from the model: rejected because it can be hallucinated or injected.
- Include a server URL in the event: rejected because the frontend action registry is the security boundary.
- Replace all old events with a new envelope: rejected because it creates unnecessary client breakage.

## Decision 12: Preserve the current guardrail engine in this feature

**Decision**: Keep and regression-test the existing fail-closed input/output guardrail and PII pipeline. Do not add the NVIDIA `nemoguardrails` dependency during this infrastructure migration.

**Rationale**: Although the original ADR names NeMo Guardrails, the repository's `NemoGuardrailService` is a custom Mimo safety classifier and the stronger output pipeline is already implemented/tested. Replacing the engine while changing topology, state, tools, contracts, and checkout would make failures difficult to isolate and violates incremental delivery.

**Alternatives considered**:

- Install NVIDIA NeMo Guardrails now: rejected as an unrelated third-party re-platform with separate prompts/configuration/performance/security validation.
- Remove inference guardrails and rely on tool scoping: rejected because the accepted security model has both structural and inference-time layers.

## Decision 13: Encrypt chat content at the application boundary

**Decision**: Migrate ChatMessage content and message-derived ChatSession title to record-bound AES-256-GCM ciphertext with external versioned keys and gateway-only decryption. Use expand/contract: additive dual-read/write, restart-safe backfill while plaintext remains for rollback, live observation/recovery export, then separately approved Phase 17 column removal and final database/backup verification. Soft-delete sessions and revoke active handoffs on deletion.

**Rationale**: Conversation text can contain identity and itinerary-linked PII even when high-risk passport/payment/contact patterns are blocked. Database storage encryption alone is not an auditable per-record application control and does not constrain accidental broad ORM reads. Authenticated encryption plus narrow gateway decryption satisfies the project constitution and makes plaintext absence testable.

**Alternatives considered**:

- Rely only on volume/database encryption: rejected because the repository has no documented/tested backup and access control proving the constitutional guarantee.
- Redact every stored conversation: rejected because it damages required conversational memory and cannot reliably preserve meaning.
- Store encryption keys beside ciphertext: rejected because database compromise would expose both.

## Resolved Former Open Questions

| Former question           | Resolution                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Multi-agent topology      | Stateless Router → General/Travel/Checkout specialists in one LangGraph, plus deterministic handoff nodes.                         |
| LLM provider              | Preserve the deployed Mimo OpenAI-compatible endpoint; Router may use a separately configurable model name but not a new provider. |
| Python framework          | FastAPI is confirmed by the implemented service.                                                                                   |
| Recent message window     | Preserve configurable default 20 and token budget 4000; summaries run after completed turns.                                       |
| Direct vs proxy transport | Direct browser → FastAPI is the target; proxy exists only as a staged rollback path.                                               |
| Agent-to-NestJS identity  | Existing API key plus HMAC user claim supersedes raw JWT forwarding.                                                               |
| Snapshot durability       | PII-free Redis TTL repository restored into per-turn AgentState; messages remain NestJS/PostgreSQL-owned.                          |
