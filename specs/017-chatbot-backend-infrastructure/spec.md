# Feature Specification: Chatbot Backend Infrastructure and Booking Handoff

**Feature Branch**: `017-chatbot-backend-infrastructure`

**Created**: 2026-08-05

**Status**: Ready for planning

**Input**: Build the accepted chatbot backend architecture as incremental, independently verifiable slices. The chatbot remains advisory and read-only, uses specialist agents inside one LangGraph, and hands explicit booking commitment to deterministic checkout through a short-lived handoff token.

## User Scenarios & Testing

### User Story 1 - Secure, Budgeted Conversation (Priority: P1)

As an authenticated traveler, I can have a streamed conversation with the assistant and resume the conversation later without another user's messages, quota, or session state affecting mine.

**Why this priority**: Authentication, ownership, persistence, safety rails, and cost control are prerequisites for every useful chatbot behavior.

**Independent Test**: Start a direct authenticated stream, exchange messages in an owned session, reconnect, and verify persisted history is restored; then exhaust the daily quota and verify the next request is rejected before any model or tool invocation.

**Acceptance Scenarios**:

1. **Given** a valid web session, **When** the browser opens a direct stream to the Python agent, **Then** the agent validates the JWT, applies input/output guardrails, and emits the existing versioned SSE events.
2. **Given** an absent, expired, or invalid JWT, **When** a stream is requested, **Then** the request returns 401 without creating a chat session or invoking an LLM.
3. **Given** a user below the daily quota, **When** a message is accepted, **Then** the Redis daily counter is charged atomically before inference and expires after the configured daily window.
4. **Given** a user at the daily quota, **When** another message is submitted, **Then** the request returns 429 before guardrail-model, router-model, specialist-model, or tool execution.
5. **Given** two users use the same session identifier, **When** the second user requests history or streams a turn, **Then** ownership validation rejects access without revealing whether the session exists.
6. **Given** an agent instance restarts, **When** the user resumes a session, **Then** durable messages and summaries are restored from NestJS while ephemeral search selection state is restored only from its bounded PII-free snapshot store or safely treated as absent.
7. **Given** a user submits passport, payment-card, contact, or other protected booking PII in chat, **When** ingress validation runs, **Then** the message is blocked before model inference and raw chat persistence and the user is directed to the secure form.

---

### User Story 2 - Correct Specialist Routing and Read-Only Travel Help (Priority: P2)

As a traveler, my message is routed to the narrow specialist that can answer it, while ambiguous checkout language produces an informed clarification instead of an unintended action.

**Why this priority**: The accepted multi-agent architecture reduces tool exposure and makes checkout intent handling safer than the current monolithic agent.

**Independent Test**: Submit representative GENERAL, SEARCH, BOOKING_INQUIRY, CHECKOUT, low-confidence, and ambiguous-checkout messages against a stubbed router model and verify the selected node, tool inventory, and response behavior.

**Acceptance Scenarios**:

1. **Given** a valid message, **When** the Intent Router classifies it, **Then** its strict structured result contains only an allowed intent, confidence, commitment signal, and resolvable selection reference.
2. **Given** GENERAL intent, **When** routing completes, **Then** the General-Purpose Agent responds with no tools bound.
3. **Given** SEARCH or BOOKING_INQUIRY intent, **When** routing completes, **Then** the Travel Assistant receives only its five read-only tools.
4. **Given** possible checkout intent that fails any checkout-gate criterion, **When** routing completes, **Then** the Travel Assistant receives `possible_checkout` metadata and asks a context-aware clarification.
5. **Given** low confidence for a non-checkout message, **When** routing completes, **Then** the system safely falls back to the Travel Assistant without inventing an action.
6. **Given** any specialist prompt or tool result, **When** the response is streamed, **Then** existing input/output guardrails and PII scrubbing still apply to text while validated structured application events bypass text transformation.

---

### User Story 3 - Privacy-Minimized Booking Answers (Priority: P3)

As a traveler, I can ask when and where I am flying and explicitly request limited extra flight details without exposing financial, passenger, payment, provider, database, or PNR data to the LLM.

**Why this priority**: The current booking tool exposes more data than the newly accepted two-tier boundary permits.

**Independent Test**: Seed owned and foreign bookings, invoke summary and detail tools, and verify the exact allowlisted fields returned to the model for default and explicit-detail requests.

**Acceptance Scenarios**:

1. **Given** owned bookings, **When** the assistant lists bookings, **Then** it receives only airline, route, departure/arrival times, status, duration, stops, and an opaque booking reference.
2. **Given** an opaque reference for an owned booking, **When** the user explicitly asks for details, **Then** the assistant may additionally receive flight number, baggage allowance, and user-friendly refundable/changeable flags.
3. **Given** a foreign, malformed, or stale opaque reference, **When** detail is requested, **Then** the gateway returns a safe not-found result and emits no protected data.
4. **Given** any booking summary or detail response, **When** it crosses the agent gateway, **Then** price, currency, fare class, passenger count, passenger PII, passport data, payment data, provider payloads, database IDs, and PNR references are absent.

---

### User Story 4 - Deterministic Checkout Handoff (Priority: P4)

As a traveler who explicitly commits to a flight from my latest search, I receive a safe checkout card that opens deterministic web checkout without the LLM creating an intent, booking, payment, URL, offer identifier, or token.

**Why this priority**: This delivers booking orchestration while preserving the constitutional deterministic transaction boundary.

**Independent Test**: Search flights, explicitly select one result, receive `ACTION_HANDOFF`, resolve the token as the owning user, and atomically consume it during canonical intent creation; verify ambiguity, expiry, replay, duplicate calls, and cross-user/session use fail safely.

**Acceptance Scenarios**:

1. **Given** a completed flight search, **When** the code-owned tool executor receives the results, **Then** it stores a compact Trusted Search Snapshot and sends the LLM only a formatted summary with no local or Duffel offer identifier.
2. **Given** a later search in the same session, **When** it succeeds, **Then** it atomically replaces the prior snapshot so result numbers always refer to the latest search.
3. **Given** explicit commitment, checkout confidence at or above the configured threshold, an active snapshot, and a resolvable result index, **When** routing completes, **Then** the Checkout Orchestrator may call only `signal_checkout_intent`.
4. **Given** a valid checkout signal, **When** deterministic graph nodes run, **Then** they validate snapshot ownership/freshness and call a deterministic NestJS handoff service using authenticated service credentials.
5. **Given** repeated deterministic creation with the same user, session, snapshot version, and selected result, **When** no prior token has expired or been consumed, **Then** NestJS returns the same active handoff rather than creating duplicates.
6. **Given** a created handoff, **When** the stream emits `ACTION_HANDOFF`, **Then** the versioned payload contains only `begin_checkout`, the opaque token, expiry, and allowlisted display metadata; it contains no URL, offer identifier, provider payload, PII, or payment data.
7. **Given** a valid unconsumed token, **When** checkout resolves it, **Then** the backend verifies token hash, owner, chat session, expiry, feature state, and authoritative offer freshness before returning a safe checkout context.
8. **Given** a valid token is submitted with canonical intent creation, **When** the transaction succeeds, **Then** the token is consumed by compare-and-swap in the same transaction as the new booking intent.
9. **Given** two concurrent consumers, **When** both submit the same token, **Then** at most one creates an intent and the loser receives a stable consumed/replay error.
10. **Given** an expired, foreign, malformed, already-consumed, or snapshot-mismatched token, **When** it is resolved or consumed, **Then** no intent, payment, booking, or supplier call occurs.

---

### User Story 5 - Observable, Reversible Rollout (Priority: P5)

As an operator, I can enable the new router, projections, direct stream, and handoff path incrementally, observe failures without PII, and roll back issuance without breaking existing chat or checkout.

**Why this priority**: The change spans three services and replaces live contracts; staged acceptance before issuance keeps rollback safe.

**Independent Test**: Exercise each feature-flag combination and verify old chat events continue, new server contracts can be deployed dark, issuance can be disabled independently, and metrics/logs identify routing, quota, handoff, and privacy failures.

**Acceptance Scenarios**:

1. **Given** new feature flags are disabled, **When** users chat, **Then** existing safe chat and `ACTION_REQUIRED` behavior remains available while `ACTION_HANDOFF` is never issued.
2. **Given** server acceptance is enabled before frontend rendering, **When** a handoff token is resolved, **Then** backend validation works without requiring the new card to be visible.
3. **Given** issuance is disabled during rollback, **When** an already-issued unexpired token is used, **Then** the configured rollback policy either honors it or returns a stable retry-safe error; no partial intent is created.
4. **Given** any cross-service turn, **When** it executes, **Then** trace and correlation identifiers propagate browser to agent to NestJS and appear in PII-safe structured telemetry.
5. **Given** quota, routing, tool, handoff, or checkout failures, **When** operators inspect health, metrics, and logs, **Then** they can distinguish failure class and latency without seeing message content, tokens, offer IDs, PII, or payment data.

### Edge Cases

- A checkout-like message arrives in a legacy session with no Trusted Search Snapshot.
- The snapshot expires or is replaced between routing and handoff creation.
- The selected result index is zero, negative, non-integer, out of range, or refers to an older search.
- Router output is malformed, uses an unknown intent, or reports a confidence outside 0 through 1.
- The router classifies checkout with high confidence but the message expresses curiosity rather than commitment.
- Redis is unavailable before quota charging or snapshot persistence.
- A user pastes passport, payment-card, email, or phone data into chat before any agent node runs.
- NestJS is unavailable after the model signaled checkout intent but before handoff creation.
- The client disconnects after token creation but before receiving `ACTION_HANDOFF` and retries the same message.
- A token expires between checkout page resolution and intent submission.
- Two browser tabs resolve or consume the same handoff token concurrently.
- A user tampers with the handoff bootstrap body/cookie, reuses another user's token, or attempts to supply a session binding that differs from the server-owned relation.
- An offer becomes stale while its token remains temporally valid.
- A structured event contains an unknown version, action, extra property, URL, or identifier field.
- Output guardrails block text before or after a valid structured handoff event.
- Daily quota day-boundary and TTL behavior differs across application time zones; quota keys use UTC dates.
- Existing `ACTION_REQUIRED`, `token`, `done`, `error`, `tool_call`, `tool_result`, and `flight_results` consumers receive the new server version.

## Requirements

### Functional Requirements

- **FR-001**: The browser MUST stream chat directly to the public FastAPI agent endpoint; the temporary Next.js chat stream proxy MUST remain a tested flag-controlled fallback through the observation window and MUST be removed only after direct authentication, CORS, deployment configuration, browser tests, rollback rehearsal, and explicit post-observation approval pass.
- **FR-002**: NestJS MUST issue a canonical HS256 chat JWT containing required `sub`, `iss`, `aud`, `jti`, and expiry claims while temporarily preserving the legacy `id` claim; FastAPI MUST validate every required claim and NestJS-backed active-user/revocation state before quota, model-backed guardrails, inference, or persistence.
- **FR-003**: Agent-to-NestJS calls MUST use service-authenticated Agent Gateway endpoints for chat access introspection, session creation/ownership, memory load, completed-turn persistence, and summary persistence, with the current API-key plus short-lived user-claim boundary; raw browser JWT forwarding to ordinary ChatController endpoints MUST NOT be used.
- **FR-004**: NestJS MUST remain the sole durable owner of ChatSession and ChatMessage data in PostgreSQL, with all reads/writes scoped to the authenticated user; browser message endpoints MUST force `USER/STANDARD`, while only service-authenticated endpoints may persist `AGENT` or `SUMMARY` records.
- **FR-005**: The system MUST retain the sliding-window plus summary strategy and persist every accepted user/assistant message plus any message-derived ChatSession title as record-bound AES-256-GCM ciphertext with versioned keys; legacy plaintext fields MUST remain through reversible dual-read/write observation and be removed only after separate approval, verified backfill, recovery export, database/backup scans, and legacy-reader shutdown.
- **FR-006**: The agent MUST enforce a Redis-backed configurable daily message quota, default 50 per authenticated user, together with the burst limit in one Lua admission decision before any model inference; UTC expiry and rejection semantics MUST be deterministic.
- **FR-007**: Burst rejection MUST NOT consume daily allowance, daily rejection MUST NOT leak a burst reservation, denied attempts MUST not count toward either accepted-request budget, and the combined decision MUST work consistently across agent instances.
- **FR-008**: Redis failure during quota enforcement MUST fail closed before inference with a stable availability error and MUST NOT silently bypass cost control.
- **FR-009**: The agent MUST keep input/output guardrails, PII detection, hard-stop behavior, partial-response persistence rules, and per-session serialization intact; protected booking PII detected at ingress MUST be blocked before model inference and raw ChatMessage persistence, with only a value-free security audit event recorded.
- **FR-010**: The graph MUST contain distinct Router, General-Purpose Agent, Travel Assistant, Checkout Orchestrator, and deterministic handoff nodes inside one LangGraph.
- **FR-011**: The Router MUST be stateless, have no tools, and return strict structured output with intent `GENERAL`, `SEARCH`, `BOOKING_INQUIRY`, or `CHECKOUT`, confidence, commitment, and optional selection reference.
- **FR-012**: Router validation failures MUST route safely without executing checkout or any write-adjacent operation.
- **FR-013**: Checkout routing MUST require every Checkout Gate criterion: checkout intent, configured high-confidence threshold, commitment, active latest Trusted Search Snapshot, and resolvable result index.
- **FR-014**: A checkout-like message that fails the gate MUST route to the Travel Assistant with `possible_checkout` metadata for informed disambiguation.
- **FR-015**: The fixed agent tool inventory MUST contain exactly `search_flights`, `get_user_preferences`, `list_user_booking_summaries`, `get_booking_detail`, `check_booking_readiness`, and `signal_checkout_intent`.
- **FR-016**: The General-Purpose Agent MUST have no tools; the Travel Assistant MUST have only the first five read-only tools; the Checkout Orchestrator MUST have only `signal_checkout_intent`.
- **FR-017**: `book_flight`, the confirmation node, confirmation-resume SSE behavior, and every write-capable LLM tool MUST be removed.
- **FR-018**: `signal_checkout_intent` MUST only validate an index against code-owned state and set a graph-state signal; it MUST perform no network, database, cache, booking, payment, or token write.
- **FR-019**: The new graph MUST opt into a versioned service-only POST search route that accepts an owned ChatSession plus proposed next snapshot version and returns identifiers with a signed user/session/ordered-offer/version/expiry attestation; the legacy GET response MUST remain display-only/unenriched during rollback, and deterministic code MUST strip the opt-in response into the bounded Trusted Search Snapshot before any LLM/browser projection.
- **FR-020**: The Trusted Search Snapshot MUST be written by deterministic code, atomically replace the prior session snapshot, be scoped to user and session, carry no PII, and never be included in LLM messages or browser events.
- **FR-021**: Snapshot persistence MUST be bounded by offer freshness; absent or expired state after restart MUST require a new search rather than infer an offer from conversation text.
- **FR-022**: `list_user_booking_summaries` MUST read from a dedicated safe `BookingAgentProjection` populated at confirmation/supplier synchronization and return only the accepted Booking Summary Tier plus an opaque non-database booking reference; raw booking/passenger/provider snapshots MUST NOT be loaded by agent gateway methods.
- **FR-023**: `get_booking_detail` MUST require an owned opaque reference and explicit use, and return only the accepted Booking Detail Tier.
- **FR-024**: Financial fields, fare class, passenger count, passenger PII, passport data, payment data, provider payloads, database IDs, and PNR references MUST be absent from every agent booking projection.
- **FR-025**: A deterministic NestJS handoff service MUST verify the signed selection attestation, derive the idempotency binding itself from attestation digest plus selected index, create a versioned high-entropy HMAC credential from a cryptographically random row ID and that binding, persist only token/idempotency hashes plus key version, and reproduce the credential only for an active idempotent retry; callers MUST NOT supply an idempotency key.
- **FR-026**: The deterministic agent node MUST validate the selected index against its owner/session-scoped Redis snapshot; NestJS handoff creation MUST independently validate authenticated service identity, user claim, attestation signature/expiry/user/session/ordered-offer binding, owned ChatSession, exact local/provider offer match, offer freshness, `ISSUE` feature state, and duplicate prevention without calling Duffel or creating a booking intent.
- **FR-027**: Deterministic graph nodes MUST execute `validate_handoff` before `create_handoff_token`; the LLM MUST never receive the token-creation client or endpoint as a tool.
- **FR-028**: Handoff creation retries for the same active selection MUST converge on one active token or a safe equivalent response without duplicate active records.
- **FR-029**: The agent MUST emit a versioned named SSE event `ACTION_HANDOFF` with action `begin_checkout`, token, expiry, and allowlisted display metadata only; the token is allowed only in the exact credential field and MUST NOT appear in streamed text or any other event.
- **FR-030**: The frontend MUST accept only known event versions and the explicit `begin_checkout` registry action, POST the credential in a CSRF/origin-protected same-origin bootstrap body, set it only as a short-lived `HttpOnly; Secure; SameSite=Strict` server cookie, redirect to a clean `/checkout/passengers` URL, and reject URLs or unknown/extra action fields; tokens MUST be absent from URLs, browser storage, access logs, and telemetry.
- **FR-031**: `ACTION_REQUIRED` MUST remain reserved for readiness/profile/inline-passenger correction and MUST NOT be repurposed as checkout commitment.
- **FR-032**: The checkout backend MUST resolve a handoff by credential hash plus authenticated user, recover and validate the stored ChatSession relation/ownership internally, and verify expiry, consumption/claim state, `ACCEPT` feature state, attested selection, and authoritative offer state before returning a safe checkout context; clients MUST NOT supply `chatSessionId`.
- **FR-033**: Canonical intent creation MUST CAS-acquire and owner-refresh a short-lived claim before any Duffel call; supplier hard timeout plus finalization margin MUST stay below remaining claim TTL, refresh loss MUST cancel work and prevent takeover until a safety buffer passes, and the final transaction MUST revalidate unexpired claim ownership plus active/non-deleted stored ChatSession before creating BookingIntent and consuming the claim.
- **FR-034**: Replay, concurrent claim loss, expiry, foreign ownership, client-supplied session attempts, malformed token, invalid/replaced attestation, stale offer, and stale fencing owner MUST produce stable error codes and zero booking/payment/supplier side effects for every loser.
- **FR-035**: Existing singular/plural booking-intent compatibility routes and non-chat checkout entry paths MUST remain functional; chat handoff MUST target the canonical plural contract.
- **FR-036**: New router, booking projections, handoff acceptance, handoff issuance, and direct-stream transport MUST be independently feature-flagged or deploy-order-safe; `ISSUE` MUST gate production create in both the agent deterministic node and NestJS service/controller, while `ACCEPT` alone gates resolve/readiness/consume policy for already-issued credentials.
- **FR-037**: Structured logs, metrics, traces, and audits MUST include allowlisted status, reason, latency, route, confidence bucket, count, trace ID, and correlation ID fields only; they MUST exclude message text, tokens, offer identifiers, tool payloads, and PII.
- **FR-038**: Health reporting MUST include NestJS, model/guardrail, and Redis readiness so quota or snapshot dependency failure is visible.
- **FR-039**: Tests MUST cover graph routing, tool allowlists, snapshot isolation, quota atomicity, token lifecycle/concurrency, exact DTO allowlists, SSE schema validation, transport/authentication, privacy boundaries, and end-to-end search-to-checkout handoff.
- **FR-040**: Implementation MUST follow repository TDD rules: each behavioral slice begins with a failing public-boundary test and all existing chatbot, guardrail, gateway, readiness, checkout, and booking tests remain green.
- **FR-041**: Every distributed session lease MUST carry a monotonic fencing token; durable message/summary writes and `ACTION_HANDOFF` emission MUST reject stale fencing owners after TTL expiry, refresh loss, disconnect, or takeover.
- **FR-042**: ChatSession deletion MUST be a soft delete that revokes/expires active handoffs while retaining consumed handoff audit linkage; retention cleanup MUST delete encrypted message content and keys according to the documented policy.
- **FR-043**: Application-level message/title encryption MUST support versioned-key rotation, controlled owner/service-gateway decryption, restart-safe expand/contract backfill, separately approved plaintext-column removal, and database/backup verification with no key material in PostgreSQL, logs, traces, or audits.

### Key Entities

- **ChatSession**: Existing NestJS-owned durable conversation container scoped to one user; owns persisted raw messages and summaries.
- **ChatMessage**: Existing immutable conversation record with USER or AGENT sender and STANDARD or SUMMARY type, persisted only as versioned record-bound authenticated ciphertext after migration.
- **RouteDecision**: Strict, ephemeral Router output containing the allowed intent, bounded confidence, commitment signal, and optional result reference.
- **AgentState**: Per-turn shared LangGraph state containing messages, route decision, disambiguation metadata, Trusted Search Snapshot, checkout signal, and generated handoff event; excludes service credentials.
- **TrustedSearchSnapshot**: PII-free, code-owned, user/session-scoped mapping from current result indices to authoritative offer identifiers, minimal display fields, and a NestJS-signed selection attestation, stored with a bounded TTL and replaced on each search.
- **BookingAgentProjection**: Dedicated one-to-one safe booking read model containing only the summary/detail allowlist and opaque agent reference; agent reads never load broad booking or passenger snapshots.
- **BookingSummaryProjection**: Minimal default booking read model identified by an opaque booking reference.
- **BookingDetailProjection**: Narrow on-demand extension of the summary projection with flight number, baggage, and friendly fare-condition flags.
- **ChatHandoff**: Deterministic NestJS-owned lifecycle record storing token/idempotency hashes, owner/session/offer/attestation binding, expiry, short-lived internal claim state, consumption state, and optional consumed BookingIntent relation.
- **ActionHandoffEvent**: Versioned application-owned SSE payload that tells the frontend to render a registered checkout action without carrying a URL or offer identifier.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Contract tests prove 100% of registered LLM tools are in the six-item allowlist and none can create, update, or delete application state.
- **SC-002**: Quota tests prove the 51st default daily message returns 429 and records zero guardrail-model, router-model, specialist-model, and tool invocations; concurrent burst/daily rejection neither overcharges nor leaks reservations across UTC rollover.
- **SC-003**: Routing tests achieve 100% expected node selection for the maintained intent/gate fixture set, and every incomplete Checkout Gate case produces disambiguation or a fresh-search request rather than checkout.
- **SC-004**: Final privacy tests find zero local/Duffel offer identifiers, database IDs, PNRs, payment/passport/other PII, plaintext ChatMessage content or ChatSession title, or handoff credentials in disallowed LLM/SSE/database/backup/URL/storage/log/trace/audit surfaces; during reversible encryption observation, inventoried legacy columns are the sole temporary exception and have verified ciphertext twins/recovery export.
- **SC-005**: A 100-request concurrent consume test creates exactly one BookingIntent for one handoff token and returns stable replay/consumed errors for all losers.
- **SC-006**: Cross-owner, client-supplied session, expired, malformed, invalid-attestation, stale-offer, stale-claim, and already-consumed handoff tests reject 100% of losing attempts before any supplier or payment call.
- **SC-007**: Existing SSE event contract tests remain green, and new clients reject 100% of unknown `ACTION_HANDOFF` versions, actions, URLs, or extra sensitive fields.
- **SC-008**: With stubbed model and supplier boundaries, the p95 application overhead from accepted stream request to router invocation is under 100 ms, and handoff create/resolve endpoints are under 300 ms locally.
- **SC-009**: Every cross-service handoff scenario contains one trace ID and correlation ID across browser, agent, NestJS logs, metrics, and audit records with no message or token content.
- **SC-010**: Delivery Phases 1–15 can be enabled, tested, and rolled back without disabling existing safe chat, `ACTION_REQUIRED`, or deterministic non-chat checkout; Phase 16 transport cleanup and Phase 17 plaintext-column cleanup require separate explicit approvals and archived recovery evidence.

## Assumptions

- FastAPI, LangChain/LangGraph, Mimo's OpenAI-compatible model endpoint, NestJS, Prisma/PostgreSQL, Redis, NextAuth JWT sessions, and the existing output-guardrail pipeline remain the selected stack.
- The accepted direct browser-to-agent SSE decision is implemented as an explicit transport migration; until that phase is enabled, the existing same-origin proxy remains the rollback path.
- The current service API key plus short-lived claim-token protocol supersedes the original ADR's raw JWT forwarding for agent-to-NestJS calls.
- Redis stores only counters, locks, and the PII-free Trusted Search Snapshot; durable conversation content remains in PostgreSQL through NestJS.
- The graph no longer requires human-interrupt checkpointing after the obsolete confirmation node is removed; durable chat history is reconstructed from NestJS and current trusted search state is restored from its bounded snapshot repository at turn start.
- Existing readiness and canonical plural intent contracts from Feature 016 are dependencies; unfinished final-order work does not block server-side handoff token acceptance, but handoff issuance remains separately flaggable until canonical checkout consumption is ready.
- Offer freshness uses existing locally stored FlightOffer data and configured age limits during handoff creation/resolution; the existing deterministic checkout pipeline performs authoritative repricing at its normal commitment point.
- Price-paid disclosure remains out of scope because the accepted tool inventory provides no protected financial capability.
- Replacing the current custom guardrail engine with another third-party guardrail framework is out of scope; this feature preserves and re-verifies the existing fail-closed input/output boundary.
