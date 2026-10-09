# Agent Tool-Calling Architecture — Grilling Session Decisions

> **Date**: 2026-07-01
> **Scope**: Specialized agent for handling NestJS API calls — tool definitions, gateway design, auth model, orchestration pattern.
> **Builds on**: [chatbot-backend-architecture.md](./chatbot-backend-architecture.md) (Decisions 1–9)

---

## Decision 1: Agent Action Scope

**Choice**: Strictly read-only. No bookings, no payments, no mutations that touch user money or sensitive data.

**Rationale**: The project constitution explicitly prohibits AI agents from executing transactional operations. The agent operates in a controlled sandbox with a restricted set of read operations. Write operations (booking, payment) remain exclusively in the deterministic NestJS services.

**Rejected**: Read + confirmed-write hybrid. Even with user confirmation, the constitutional boundary is clear — agents are advisory only.

---

## Decision 2: Agent Gateway (Structural PII Boundary)

**Choice**: Build a dedicated agent gateway module in NestJS (`src/agent-gateway/`) that exposes a curated, PII-stripped API surface for agent consumption.

**Rationale**: The PII boundary must be **structural, not behavioral**. If the agent calls the same endpoints as the frontend, passport numbers, payment details, and personal data enter the LLM context window. From there, they propagate to:

- LangSmith traces (full prompt/response logging)
- Summarization calls (the summarizer model sees everything)
- LLM provider logs (depending on retention terms)

A system prompt telling the LLM not to surface PII is a behavioral defense — the weakest layer. A gateway that **never includes the field in the response** is a hard boundary. The data simply isn't there to leak.

The gateway also:

- Gives a single audit chokepoint for what data the agent sees
- Decouples the agent's data contract from the frontend's
- Reduces token waste by stripping irrelevant metadata

**Invariant enforced**: Architecture doc already states _"All agent data access goes through the agent-gateway, which strips PII and enforces scoped access."_ This decision implements that invariant.

---

## Decision 3: Tool Inventory (Launch Set)

**Choice**: Three tools at launch:

| Tool                   | Purpose                                                  | Data Returned                                                                                          |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `search_flights`       | Search flights by origin, destination, dates, passengers | Airline, flight number, departure/arrival times, duration, stops, price, fare class, baggage allowance |
| `get_user_preferences` | Fetch PII-stripped traveler profile                      | Seat pref, airline pref, class pref — no passport, no payment data                                     |
| `list_user_bookings`   | Fetch user's bookings with full detail                   | Destination, dates, airline, status, flight info — no PNR, no e-ticket numbers                         |

**Rationale**: These three cover the primary use cases (search, personalization, booking status) without requiring follow-up detail tools. `list_user_bookings` returns full detail because users typically have 1–5 active bookings. `search_flights` returns medium-fat payloads so common follow-up questions can be answered from context.

**Deferred**: `get_flight_details` (unnecessary — search payload is rich enough), `get_flight_status` (AviationStack not integrated yet), hotel/restaurant tools (services not built yet).

---

## Decision 4: Response Payload Strategy (Two-Tier)

**Choice**: Medium-fat payloads that minimize redundant tool calls.

- `search_flights`: Returns airline, flight number, departure/arrival times, duration, stops, price, fare class, baggage. Enough for common follow-ups without a second API call.
- `list_user_bookings`: Returns full booking detail (small result set, no pagination concern).
- `get_user_preferences`: Returns complete preference profile (single object).

**Rationale**: Prevents unnecessary tool calls that burn Amadeus API budget, add latency, and waste tokens. The agent should answer from context when the data is already in the conversation window.

---

## Decision 5: Closed-World Prompt Discipline

**Choice**: The agent's system prompt explicitly enumerates what fields it has access to per tool, and instructs:

1. If the user asks about data already in context or conversation history — answer from context, do not make a redundant tool call.
2. If the user asks about data NOT in the enumerated field list (cancellation policy, specific layover airport, seat configuration) — say plainly that the detail is unavailable rather than guessing.

**Rationale**: Prevents hallucination of data the agent doesn't have. The LLM knows exactly what its tools return and admits ignorance for everything else. This is a closed-world assumption — stronger than generic "don't guess" instructions.

---

## Decision 6: Gateway Authentication (Signed User Claim Token)

**Choice**: Service-to-service authentication with cryptographically signed user claim tokens.

**Flow**:

1. User sends message to FastAPI agent service with their JWT.
2. FastAPI middleware validates JWT once, extracts `userId`.
3. Agent mints a **signed claim token** (HMAC-SHA256 with a shared secret between agent and gateway).
4. Claim payload: `userId` + `issuedAt` timestamp only. No active status, no profile data.
5. Agent calls gateway with: `serviceApiKey` (header) + claim token.
6. Gateway validates HMAC signature, checks timestamp is within configured TTL window, processes request.

**Configuration**:

- `CLAIM_TOKEN_TTL_SECONDS` — configurable via environment variable, not hardcoded. Can be tuned per deployment.
- User active status is **not** in the claim token — the gateway checks that independently if needed.

**Rationale**: Forwarding user JWTs (Option A) breaks during long conversations when tokens expire, causing 401 errors mid-tool-call. Simple user-exists DB checks (Option 1) lack cryptographic assurance. The signed claim token provides:

- Cryptographic proof that the userId was extracted from a validated JWT at the FastAPI edge
- Configurable TTL that accommodates long conversations
- No privilege escalation risk from forged userIds — the HMAC signature prevents tampering

**Rejected**:

- **Forward user JWT**: Expires during long conversations, causing mid-stream failures.
- **Trust-the-edge + DB check**: Lacks cryptographic guarantee; an attacker who reaches the gateway could forge userIds.
- **Relaxed JWT expiry**: Ugly hack that weakens the JWT contract.

---

## Decision 7: Tool Calling Mechanism

**Choice**: Native function/tool calling via LLM's structured JSON output (OpenAI-compatible `tool_calls` API).

**Rationale**: Mimo is OpenAI-compatible and supports the tool calling API natively. Structured JSON tool calls are deterministic to parse (no regex), stream cleanly (tokens stream until tool call, execute, resume), and integrate with LangSmith tracing for full tool call observability.

**Rejected**: ReAct-style text-based reasoning. Slower, fragile text parsing, "Thought" traces leak into SSE stream unless filtered, and adds complexity without benefit when the model supports native function calling.

---

## Decision 8: Orchestration Pattern (LangGraph State Machine)

**Choice**: LangGraph state machine with explicit nodes and conditional routing.

**Graph Structure**:

```
START → agent_node → router
  ├── read tool  → tool_node → observation_node → agent_node
  ├── write tool → confirm_node → (user confirms) → execute_node → END
  └── final text → END
```

**Key Design Elements**:

- **Router**: Classifies tool calls by `requires_confirmation` metadata flag on each tool. Read-only tools route directly to execution. Write tools route to confirmation gate.
- **Confirm node**: Sends SSE event `type: "confirmation_required"` with proposed action details. Graph **suspends** using LangGraph's `interrupt_before` mechanism.
- **Resumption**: User's next chat message serves as confirmation response. Graph resumes from checkpoint with user's decision.
- **Checkpointing**: Required for suspend/resume across separate HTTP requests. LangGraph `MemorySaver` for development, persistent backend (PostgreSQL/Redis) for production.

**Rationale**: `AgentExecutor` provides no mechanism to pause mid-loop for user confirmation. LangGraph's `interrupt_before` enables human-in-the-loop gates that are essential for future write operations (booking, payment). Building with LangGraph now avoids a full rewrite when write tools are added.

**Current state**: All 3 launch tools are read-only (`requires_confirmation: false`), so the confirmation path is dormant but architecturally ready.

---

## Summary: Architecture at a Glance

```
User (JWT) → FastAPI Edge (validate JWT, mint claim token)
                    │
                    ▼
            LangGraph State Machine
            (agent_node → router → tool_node)
                    │
                    ▼ (serviceApiKey + claim token)
            NestJS Agent Gateway
            (PII-stripped, scoped, audited)
                    │
                    ▼
            Existing NestJS Services
            (flights, bookings, profiles)
```

**Invariants**:

- Agent never sees PII — structural boundary at gateway
- Agent never executes transactions — constitutional prohibition
- All tool calls traced in LangSmith — full observability
- Claim tokens are cryptographically signed — no userId forgery
- Read tools execute freely; write tools require user confirmation via interrupt
