# Chatbot Booking Orchestration — Architecture Decisions

The chatbot is evolving from a read-only advisory assistant into a booking orchestrator. These decisions define how the chatbot communicates with deterministic booking tools, what data it can access, how it hands off to the web checkout, and how multiple agents collaborate within a single LangGraph. All decisions were stress-tested during a grilling session on 2026-08-05.

## Status

Accepted.

---

## Decision 1: Conversational Handoff — No Write Tools

The chatbot orchestrates the existing deterministic booking pipeline but never executes transactional operations. It assists with flight discovery, evaluation, and intent capture, then hands off to the web checkout UI via a server-issued Handoff Token. The LLM has zero write tools.

**Rejected alternative:** Agent-driven booking (giving the agent write tools like `create_booking_intent`, `initiate_payment`). Rejected because it would require solving PCI-DSS card-detail handling in the chat channel, would duplicate every validation/idempotency mechanism already built into the web checkout, and would massively expand the attack surface for prompt injection.

---

## Decision 2: Daily Message Quota

Each authenticated user gets ~50 messages per day, tracked in Redis (`chat:budget:{userId}:YYYY-MM-DD`, TTL 24h). When exhausted, the system returns 429 before any LLM inference — zero cost incurred. The existing 60-req/min rate limiter remains as burst protection on top.

Monthly quota is deferred. The daily quota is sufficient for booking flows (a typical booking conversation is ~20 messages).

---

## Decision 3: Handoff Token (Not Raw Offer ID)

When the chatbot prepares checkout, the backend creates a short-lived, server-issued, single-use handoff token that references the Duffel offer ID internally. The browser URL uses the token (`/checkout/passengers?handoff=chk_handoff_abc123`), never the raw offer ID.

**Consequences:**

- The selected offer cannot be replaced by editing a URL parameter.
- Checkout rejects tokens belonging to another user or session.
- Internal provider identifiers never become part of the browser contract.
- Expired offers are handled through a controlled reprice flow.

---

## Decision 4: Structured ACTION_HANDOFF SSE Event

The SSE stream emits a versioned `ACTION_HANDOFF` event with a handoff token and presentational display metadata. The frontend renders a rich checkout card with a "Proceed to Checkout" button. The display metadata is presentational only — the checkout page loads authoritative data from the backend.

The frontend accepts only an explicit action registry (`begin_checkout`), never arbitrary URLs. Plain-text links are a degraded-client fallback only, generated deterministically by the application, never by the LLM.

**Rejected alternative:** LLM-generated markdown deep links. Rejected because the LLM could hallucinate or be manipulated to produce wrong offer IDs, and the frontend would have no way to distinguish legitimate from fabricated links.

---

## Decision 5: LLM Signals Intent, Deterministic Code Executes

The LLM participates in intent recognition ("the user wants to book Flight 3") via a read-only tool (`signal_checkout_intent`), but the actual handoff token creation is performed by deterministic LangGraph nodes (`validate_handoff` → `create_handoff_token`).

The `signal_checkout_intent` tool validates the offer index against the Trusted Search Snapshot in graph state and sets a flag. It has no side effects. The downstream deterministic nodes validate offer expiry, session ownership, and duplicate prevention before calling NestJS to create the token.

**Rejected alternative:** Pure deterministic post-processing (no LLM intent tool). Rejected because deterministic code cannot distinguish between recommendation ("Flight 2 looks great") and commitment ("I want to book Flight 3") — intent recognition requires the LLM.

**Rejected alternative:** LLM-triggered token creation (giving the LLM a `create_handoff_token` tool). Rejected because it would give the LLM a write-adjacent capability and a new attack surface for prompt injection.

---

## Decision 6: Trusted Search Snapshot

When `search_flights` returns, the `custom_tool_node` stores a compact snapshot in graph state — only the fields needed for validation and handoff (Duffel offer ID, airline, route, departure time, price, currency). The LLM sees only a formatted text summary without offer IDs.

When `signal_checkout_intent(offer_index=N)` is called, the deterministic `validate_handoff` node resolves the index against this snapshot. The offer ID flows exclusively through the snapshot → deterministic node path, never through the LLM's message history.

Overwritten on each new search — "Flight 3" always refers to the latest search.

---

## Decision 7: Tool Inventory — Six Read-Only Tools

| Tool                          | Agent                 | Purpose                                                     |
| ----------------------------- | --------------------- | ----------------------------------------------------------- |
| `search_flights`              | Travel Assistant      | Search flights via Duffel through agent gateway             |
| `get_user_preferences`        | Travel Assistant      | Read PII-stripped traveler profile preferences              |
| `list_user_booking_summaries` | Travel Assistant      | Compact booking summaries (no financial data, no PII)       |
| `get_booking_detail`          | Travel Assistant      | Narrow detail for a selected booking, on explicit request   |
| `check_booking_readiness`     | Travel Assistant      | Check profile completeness for a specific offer             |
| `signal_checkout_intent`      | Checkout Orchestrator | Express user's explicit booking intent for a specific offer |

All read-only. Zero write tools. The former stub `book_flight` is removed. The `confirm` node is retired.

---

## Decision 8: Two-Tier Booking Data Exposure

**Summary tier** (default via `list_user_booking_summaries`): airline, route, departure/arrival times, status, duration, stops, opaque booking reference. No financial data, no flight number, no PII.

**Detail tier** (on-demand via `get_booking_detail`): adds flight number, baggage allowance, user-friendly fare conditions (changeable/refundable flags). Triggered only when user explicitly requests ("What's my flight number?").

**Never exposed to agent:** passenger names/PII, passport data, payment details, provider payloads, database IDs, PNR references. Price paid requires a separate protected capability.

**Rejected alternative:** Time-window-based flight number disclosure (show flight number only within 7 days of departure). Rejected because it creates confusing behavior (same question, different answers depending on date), doesn't materially address privacy (route + airline + time already identifies the flight), and the stronger controls are authentication, ownership verification, and intent-based disclosure.

---

## Decision 9: Multi-Agent Decomposition

| Agent                     | Type                                 | Tools             | Responsibility                                                |
| ------------------------- | ------------------------------------ | ----------------- | ------------------------------------------------------------- |
| **Intent Router**         | LLM (lightweight, structured output) | None              | Classifies user intent, routes to specialist                  |
| **General-Purpose Agent** | LLM                                  | None              | Greetings, FAQ, general conversation                          |
| **Travel Assistant**      | LLM                                  | 5 read-only tools | Flight search, preferences, booking inquiries, disambiguation |
| **Checkout Orchestrator** | LLM                                  | 1 read-only tool  | Checkout intent signaling only                                |
| **Handoff Pipeline**      | Deterministic code                   | None (no LLM)     | `validate_handoff` → `create_handoff_token`                   |

Each agent has a narrow system prompt and minimal tool set. The user perceives a single assistant.

---

## Decision 10: Single LangGraph, Shared State, Agent-Per-Node

All agents run inside a single LangGraph as different node clusters sharing one `AgentState`. The Router is the entry node and routes to the appropriate cluster. The Trusted Search Snapshot, conversation history, and handoff state live in the shared state object.

**Graph topology:**

```
START → router_node → [route_intent]
    ├── general_agent_node → END
    ├── travel_assistant_node → travel_tools → [route_after_tools] → travel_assistant_node (loop)
    ├── checkout_orchestrator_node → checkout_tool → validate_handoff → create_handoff_token → END
    └── travel_assistant_node (disambiguation, with possible_checkout flag)
```

**Rejected alternative:** Separate LangGraph instances with external state store (Redis). Rejected because it introduces state synchronization complexity, stale-read risks, and the Checkout Orchestrator needs the search snapshot that the Travel Assistant created.

---

## Decision 11: Asymmetric Checkout Gate

Routing to the Checkout Orchestrator requires ALL of the following:

1. `intent == CHECKOUT`
2. Confidence ≥ checkout threshold (higher than other routes, e.g., 0.85 vs. 0.6)
3. Active Trusted Search Snapshot exists in graph state
4. Message expresses commitment rather than curiosity
5. Selection reference (e.g., "Flight 3") can be resolved against the snapshot

If any condition fails, the message is routed for disambiguation — never silently downgraded.

---

## Decision 12: Disambiguation via Travel Assistant

When the Router detects possible checkout intent but the Checkout Gate is not fully satisfied, the message is routed to the Travel Assistant with a `disambiguation: possible_checkout` metadata flag. The Travel Assistant asks an informed clarification question using its search context ("Would you like more details about Flight 3, or are you ready to check out?"). The Router stays stateless and never generates conversational responses.

**Rejected alternative:** Silent fallback to Travel Assistant without clarification. Rejected because it could silently treat an ambiguous message as non-commitment, creating a confusing experience where the user's booking intent is ignored.

---

## Consequences

- The chatbot becomes useful for booking orchestration without any PCI-DSS exposure or transactional risk.
- The multi-agent decomposition enables independent tuning and guardrail configuration per agent.
- The handoff token pattern cleanly bridges the conversational and deterministic systems.
- The checkout gate's multi-criteria design prevents false-positive booking triggers from prompt injection or ambiguous messages.
- The single-graph shared-state architecture keeps the implementation manageable despite the multi-agent decomposition.
- The two-tier data exposure model limits the LLM's information surface while preserving useful travel assistant capabilities.

## New Glossary Terms

All terms have been captured in [CONTEXT.md](file:///c:/Booking%20Systems/CONTEXT.md) under the "Chatbot Booking Orchestration" section:
Conversational Handoff, Handoff Token, Action Handoff Event, Checkout Intent Signal, Trusted Search Snapshot, Booking Summary Tier, Booking Detail Tier, Agent Tool Boundary, Agent Decomposition, Intent Router, Checkout Gate, Routing Disambiguation.
