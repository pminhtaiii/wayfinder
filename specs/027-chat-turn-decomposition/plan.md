# Implementation Plan: Chat Turn Decomposition

**Branch**: `codex/027-028-specs-review` | **Date**: 2026-09-25 | **Spec**: [spec.md](./spec.md)

**Input**: [Feature specification](./spec.md), [decision record](../../docs/adr/0016-chatturnrunner-decomposition.md), and [research reconciliation](./research.md).

## Summary

Decompose the current ChatTurnRunner and SSE admission into a tool-name-agnostic graph translator, domain projection resolver, conversation memory coordinator, reusable admission services, and a thin sequential turn coordinator. Preserve all chat HTTP/SSE, security, persistence, and model/tool behavior. Extract in small working slices; do not introduce a new endpoint or dependency.

## Technical Context

**Language/Version**: Python agent service (repository's existing Python 3.12-compatible runtime)
**Primary Dependencies**: Existing FastAPI, LangGraph, Pydantic, GuardrailGateway, NestJSClient, Redis-backed queue/snapshot services, MemoryManager; no new package
**Storage**: Existing NestJS chat persistence and Redis snapshots/leases; no schema change
**Testing**: pytest agent unit/integration/characterization/security suites; Ruff
**Target Platform**: Existing Python agent service
**Project Type**: Internal service refactor
**Performance Goals**: No additional model invocation, backend request, Redis admission call, or guardrail scan per accepted turn
**Constraints**: Existing SSE and HTTP contract, fail-closed security, output holdback and cleanup order, fencing, and PII-before-quota admission
**Scale/Scope**: `chat_turn/runner.py`, `chat_turn/events.py`, `streaming/sse.py`, new interpreter/resolver, conversation memory, three admission services, and focused tests

## Constitution Check

*Gate reviewed before research and after design: PASS.*

| Principle | Design evidence |
|---|---|
| Flight-first and deterministic transaction boundary | Resolver reads/projections remain advisory; booking/payment mutation authority is unchanged. |
| API budget discipline | No added provider calls, model calls, or Redis quota use; blocked input still stops before quota. |
| Observability | Existing timing, correlation, guardrail, and error telemetry remain; `on_tool_end` timing hook is preserved. |
| Incremental delivery | Six extraction steps keep the service working; each has focused tests and can be reverted independently. |
| Security | Auth → length/health → input validation → quota remains ordered; token output still passes one output session before delivery. |

No constitution violation or added architectural complexity beyond seams required by the approved decision record.

## Project Structure

### Documentation (this feature)

```text
specs/027-chat-turn-decomposition/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/chat-turn-internal.md
├── quickstart.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/agent/src/agent/
├── chat_turn/
│   ├── events.py           # Domain event models only
│   ├── runner.py           # TurnSessionCoordinator / thin lifecycle entry
│   ├── interpreter.py      # GraphEventInterpreter
│   ├── resolver.py         # ToolResultResolver and concrete projections
│   ├── controller.py       # Existing validated-input handoff
│   └── command.py          # Unchanged command contract
├── memory/
│   ├── manager.py          # Existing summarization engine
│   └── conversation.py     # ConversationMemory
├── admission/
│   ├── __init__.py
│   ├── auth.py
│   ├── input_admission.py
│   └── quota.py
└── streaming/sse.py       # Depends wrappers, SSE adapter, formatter

apps/agent/tests/
├── test_chat_turn_runner.py
├── test_chat_turn_events.py
├── test_chat_turn_interpreter.py
├── test_tool_result_resolver.py
├── test_conversation_memory.py
├── test_chat_admission.py
├── test_sse.py
└── test_sse_integration.py
```

**Structure Decision**: New modules live next to the current owners. Existing `GuardrailGateway`, `MemoryManager`, snapshot lifecycle, and NestJSClient keep their mechanisms; new classes coordinate them. No circular dependency: runner → interpreter → resolver; runner → memory; SSE → admission services → existing dependencies.

## Phase 0: Research

[research.md](./research.md) records five decisions and resolves the two material ADR/code differences. Current tool projections are created from validated ToolMessages in `on_chain_end` for the `tools` node, while `on_tool_end` carries telemetry. Preserve that source and the existing ToolResultEvent followed by specialized event. The interpreter remains tool-name-agnostic through the resolver interface. No `NEEDS CLARIFICATION` remains.

## Phase 1: Design and Contracts

- [data-model.md](./data-model.md) defines transient turn context, validated context/input, projection, and lease relationships; no persistence migration.
- [contracts/chat-turn-internal.md](./contracts/chat-turn-internal.md) fixes interpreter, resolver, memory, admission, and SSE invariants.
- [quickstart.md](./quickstart.md) gives runnable behavior checks and expected outcomes.

### Extraction steps

1. Move `format_sse` to `streaming/sse.py`; redirect imports/tests and compare exact serialized bytes.
2. Create `resolver.py` with domain-significant projections and focused tests against fake snapshot/backend access. Its tool resolution carries a safe summary/follow-up or a block decision, so invalid readiness fails before ToolResultEvent. A distinct handoff-node completion operation accepts only the three existing handoff node outputs and returns event/force-persistence or blocked HANDOFF_FAILED decisions.
3. Create `interpreter.py` to translate graph events, including model stream/end/node fallback deduplication and tool-call projection. It invokes the resolver before ToolResultEvent for each validated tool completion and yields raw TokenEvents. Keep timing-only `on_tool_end` handling.
4. Create `memory/conversation.py` to delegate history fetch/slice/scan using the existing per-turn AdmissionContext and `MemoryManager` background compaction with existing `totalMessageCount + 2` accounting.
5. Create auth, input, and quota application services plus thin FastAPI dependencies; retain current length/gateway precedence, single validated-input handoff, and blocked-input zero-quota behavior.
6. Move remaining lifecycle setup/teardown into TurnSessionCoordinator in `runner.py`. It owns one OutputStreamSession; transforms every raw token into approved chunks; checks the active fence before forwarding action-required or handoff events; retains normal/blocked/cancelled/error cleanup and lease release order.

**Gate after each step**: Run the relevant focused tests from quickstart. Full agent gate follows step 6. No model or Redis service is needed for isolated interpreter tests.

## Complexity Tracking

None. The resolver port is justified by the approved architecture decision and the existing I/O-heavy tool projections; admission services are required to reuse policy outside FastAPI without duplicating security rules.
