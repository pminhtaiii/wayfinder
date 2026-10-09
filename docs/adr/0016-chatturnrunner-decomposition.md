# Grilling Session — Decompose ChatTurnRunner God Module

> Captured from grilling session on 2026-09-24.
> Source: architecture-review-2026-09-13.html (Candidate #6: Decompose ChatTurnRunner god module).

---

## Context

`ChatTurnRunner.run()` is a 1,051-line method (1,335-line file) handling 9 responsibilities: ingress admission, session bootstrap, distributed lease acquisition, memory context fetch + guardrail re-scan, snapshot loading, output pipeline management, user/agent message persistence, LangGraph stream processing with tool-specific domain projections, and background memory summarization. The SSE adapter (`sse.py`, 328 lines) duplicates auth, quota, and PII scanning inline. `events.py` leaks `format_sse()` — an SSE transport concern — into the domain event model.

After completing Candidates 1–5 (Payment deepening, BookingAgentProjection relocation, Booking umbrella deletion, agent-chat extraction, guardrail registry collapse), this is the next refactor target. The decomposition introduces six new modules and an extraction sequence designed to leave the system working at each step.

---

## Decision 1 — Bottom-up extraction: GraphEventInterpreter first ✅

**Problem**: The `run()` method has two broad zones — sequential setup/teardown (steps B–J, Q–U in the call flow) and the dense LangGraph event processing loop (steps K–P). Which do you extract first?

**Considered options**:

1. **Top-down — extract TurnSessionCoordinator first**, wrapping the lifecycle around the existing runner.
2. **Bottom-up — extract GraphEventInterpreter first**, isolating the LangGraph event translation loop.

**Decision**: Option 2. The `astream_events` loop (steps K–P) is the densest coupling zone — it interleaves LangGraph-specific event format parsing with domain-specific projections (snapshot browser, booking readiness, checkout handoff). Extracting it first creates the most valuable testable seam: "given this LangGraph event stream, what domain events come out?" — without needing Redis, NestJS, or an LLM. Extracting the coordinator first would still leave a ~900-line `run()` with the same interleaving problem.

Once the interpreter is extracted and covered by focused tests, the remaining `run()` code is sequential setup/teardown — straightforward to lift into a coordinator.

---

## Decision 2 — Interpreter + ToolResultResolver split (ports & adapters) ✅

**Problem**: The `astream_events` loop does two fundamentally different things: (a) format translation (LangGraph event types → domain event types), and (b) domain projection (reading Redis snapshots for `search_flights`, validating readiness responses, extracting claim tokens for checkout handoff). These involve I/O and domain knowledge.

**Considered options**:

1. **Pure interpreter** — only format translation; caller pattern-matches on tool name and does projections.
2. **Domain-aware interpreter** — owns the branch sniffing with injected dependencies (snapshot repo, etc.).
3. **Interpreter + resolver port** — interpreter is a pure translator that calls through an abstract `ToolResultResolver` interface; a concrete resolver handles Redis reads and domain projection.

**Decision**: Option 3. The interpreter itself stays tool-name-agnostic — it calls `resolver.resolve(tool_name, raw_result, context)` for **every** `on_tool_end` event. The resolver decides which tools are domain-significant and returns either a specialized domain event (`FlightResultsEvent`, `ActionRequiredEvent`, `ActionHandoffEvent`) or `None` (meaning "emit the normal `ToolResultEvent`").

**Key constraint**: The interpreter never checks tool names. All domain-significance knowledge lives in the resolver. Adding a new domain-significant tool (e.g., `change_flight`, `add_ancillary`) means modifying only the resolver — the interpreter never changes.

**Interface**:

```python
class ToolResultResolver(Protocol):
    async def resolve(
        self, tool_name: str, raw_result: Any, context: TurnContext
    ) -> Optional[ChatTurnEvent]:
        """Return a specialized domain event, or None for default ToolResultEvent."""
        ...
```

The resolver is a leaf module — it depends downward on infrastructure (snapshot repo, NestJS client) and nothing depends on it except the interpreter. No circular dependencies, no widening existing modules.

---

## Decision 3 — Output pipeline stays with caller, not interpreter ✅

**Problem**: During token streaming, the runner currently feeds tokens into `OutputStreamSession` (the guardrail output pipeline from Candidate 5) before yielding them. Should the interpreter own this pipeline, or yield raw tokens for the caller to pipe through guardrails?

**Considered options**:

1. **Interpreter owns pipeline** — interpreter receives `OutputStreamSession` as a dependency, feeds tokens through it, yields post-guardrail events.
2. **Interpreter yields raw tokens** — caller intercepts `TokenEvent`s and pipes them through the output pipeline.

**Decision**: Option 2. The output pipeline is a stateful, side-effecting component (it buffers, holds PII scanning context per session). Injecting it into the interpreter would couple it to the guardrail subsystem, violating the single-responsibility boundary. The interpreter's job is "translate LangGraph events into domain events" — output guardrail scanning is policy enforcement, a different concern.

**Leverage gained**: The interpreter's output can be consumed by any caller — test harness, WebSocket adapter, batch replay tool — without needing to set up an output guardrail pipeline for each one.

**Tradeoff**: The caller needs a ~10-line loop to intercept `TokenEvent`s and pipe them through `OutputStreamSession` before re-yielding. Small price for keeping the interpreter pure.

---

## Decision 4 — ConversationMemory as orchestrator over existing modules ✅

**Problem**: Memory management is scattered across `run()`: step 4 (fetch history + summary from NestJS with magic `total + 2` offset), step 5 (guardrail re-scan on fetched history), and step 16 (fire-and-forget background summarization via `MemoryManager`). The existing `MemoryManager` (192 lines) only handles summarization.

**Considered options**:

1. **Elevate MemoryManager to implement all three** — make it a larger module that directly handles fetching, scanning, and summarizing.
2. **Create ConversationMemory as orchestrator** — thin module that delegates to NestJSClient (fetch), GuardrailGateway (scan), and existing MemoryManager (summarize).

**Decision**: Option 2. ConversationMemory orchestrates — it does not re-implement the mechanisms. The existing `MemoryManager` stays intact as the summarization engine. The gateway stays as the scanning engine. ConversationMemory coordinates them behind a clean interface:

```python
class ConversationMemory:
    async def get_context(
        self, session_id: str, client: NestJSClient
    ) -> ValidatedConversationContext:
        """Fetch, slice, guardrail-scan, return safe context."""
        ...

    async def schedule_compaction(
        self, session_id: str, client: NestJSClient, message_count: int
    ) -> None:
        """Fire-and-forget background summarization."""
        ...
```

**What this hides**: The magic `total + 2` offset, the guardrail re-scan on history, the summarization trigger logic. The coordinator calls two methods instead of inlining fetch-slice-scan-summarize logic.

**Key constraint**: ConversationMemory is an orchestrator, not a monolith. It delegates to existing modules and does not contain domain logic itself.

---

## Decision 5 — SSE admission via FastAPI dependency injection → shared services ✅

**Problem**: `sse.py` (328 lines) inlines JWT decode, user access check, input guardrail scanning, and Redis quota checking before delegating to the runner. A deliberate ordering dependency exists: PII scanning must run before quota so blocked messages don't consume the user's daily quota. The pre-computed `ValidatedInput` must flow through to the runner to avoid double-evaluating guardrails.

**Considered options**:

1. **True middleware** — extract auth (steps 1–2) into `AuthMiddleware` and quota (step 4) into `QuotaMiddleware`. Keep input guardrail (step 3) in the endpoint handler. Problem: middleware doesn't express ordering constraints well; quota would run before guardrails, so PII-blocked messages consume quota.
2. **FastAPI dependency injection** — each admission step becomes a `Depends()` function. Ordering is explicit in the dependency chain.

**Decision**: Option 2, with an additional layering constraint: the `Depends()` functions are **thin wrappers** that call into **shared admission services**. The business rules live in reusable application-level services, not coupled to FastAPI.

**Architecture**:

```
FastAPI Depends() (thin wrappers)
  → Shared Admission Services (AuthService, InputAdmissionService, QuotaService)
    → thin sse.py transport adapter (~35 lines)
      → runner
```

**Ordering chain**: `verify_auth → scan_input → check_quota → runner`. The `ValidatedInput` flows from `scan_input` through to the runner without re-evaluation.

**Reusability**: A future WebSocket transport calls the same admission services directly, bypassing FastAPI `Depends()` but preserving identical auth/guardrail/quota logic and ordering.

**What does NOT change**: The business rules — PII blocks before quota consumption, JWT verification, deterministic PII fallback when gateway is degraded.

---

## Decision 6 — Move `format_sse` from `events.py` to `sse.py` ✅

**Problem**: `events.py` defines pure Pydantic domain event models but also exports `format_sse()` — an SSE transport serialization function. This leaks transport concerns into the domain event module.

**Decision**: Move `format_sse()` to `sse.py` where the SSE transport adapter lives. `events.py` becomes purely domain event definitions with zero external coupling (only `pydantic` and `typing`). This is a mechanical 2-minute move with zero risk.

---

## Decision 7 — Extraction sequence ✅

The six new modules are extracted in this order. Each step leaves the system working and passing tests.

| Step | Extract | Rationale |
|------|---------|-----------|
| 1 | `format_sse` → move to `sse.py` | 2-minute mechanical move. Removes event model leak. Zero risk. |
| 2 | `ToolResultResolver` | Leaf module, no dependents. Write + test against mocked snapshot repo. |
| 3 | `GraphEventInterpreter` | Depends on resolver only. Write + test with mocked resolver. `run()` shrinks ~400 lines. |
| 4 | `ConversationMemory` | Orchestrator over existing modules. Independent of steps 2–3 (parallelizable). `run()` shrinks ~100 more lines. |
| 5 | Admission services + FastAPI `Depends()` | Extract from `sse.py`. Each service independently testable. `sse.py` drops to ~35 lines. |
| 6 | `TurnSessionCoordinator` | What remains in `run()` is now a sequential script with one-liner delegates — lift into coordinator. |

**Why this order**: Steps 1–3 are bottom-up; each makes the next easier. Step 4 is independent and parallelizable. Step 5 is a separate concern from runner decomposition. Step 6 is the "vacuum seal" — by then, `run()` is thin enough that the coordinator is just moving it to a new class.

---

## Post-Refactor Structure

```
apps/agent/src/agent/
├── chat_turn/
│   ├── __init__.py
│   ├── command.py                (unchanged)
│   ├── controller.py             (unchanged)
│   ├── events.py                 (SHRINKS — format_sse removed)
│   ├── runner.py                 (SHRINKS → thin orchestrator, becomes coordinator)
│   ├── interpreter.py            (NEW — GraphEventInterpreter, tool-name-agnostic)
│   └── resolver.py               (NEW — ToolResultResolver, domain projections)
├── memory/
│   ├── manager.py                (unchanged — summarization engine)
│   └── conversation.py           (NEW — ConversationMemory orchestrator)
├── admission/
│   ├── auth.py                   (NEW — AuthService)
│   ├── input_admission.py        (NEW — InputAdmissionService)
│   └── quota.py                  (NEW — QuotaService)
├── streaming/
│   └── sse.py                    (SHRINKS — ~35 lines, pure transport + format_sse)
```

## Post-Refactor Dependency Graph

```
TurnSessionCoordinator (thin orchestrator)
├── ConversationMemory
│   ├── → NestJSClient (fetch)
│   ├── → GuardrailGateway (re-scan history)
│   └── → MemoryManager (background summarize)
├── GraphEventInterpreter (tool-name-agnostic)
│   └── → ToolResultResolver (domain projections)
│       ├── → TrustedSearchSnapshotLifecycle (read-only)
│       └── → NestJSClient (read-only)
├── OutputStreamSession (from Candidate 5)
├── TrustedSearchSnapshotLifecycle (existing)
├── NestJSClient (persistence)
└── queue_manager (lease/fencing)

FastAPI Depends() (thin wrappers)
├── → AuthService (JWT + access check)
├── → InputAdmissionService (→ GuardrailGateway)
└── → QuotaService (→ Redis budget)

sse.py (~35 lines, pure transport)
└── → TurnSessionCoordinator
```

**Dependency direction**: All arrows flow downward. No cycles. Every new module is either a leaf (Resolver, admission services) or a thin orchestrator over existing modules (ConversationMemory, Coordinator).

---

## What does NOT change

- **LangGraph integration**: Same `astream_events` API, same event types consumed.
- **Domain event model**: Same `ChatTurnEvent` union, same payload types, same discriminator.
- **Guardrail behavior**: Same layers, same order, same fail-closed semantics (Candidate 5 already refactored).
- **SSE event format**: Same wire protocol — `format_sse` moves files but output is identical.
- **Memory summarization**: `MemoryManager` stays intact; ConversationMemory delegates to it.
- **API contract**: No changes to HTTP endpoints, SSE event shapes, or error codes.
- **Security guarantees**: Auth, PII, quota ordering preserved. PII-blocked messages still don't consume quota.
