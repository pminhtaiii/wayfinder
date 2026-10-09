# Research: Chat Turn Decomposition

**Source**: [Approved decision record](../../docs/adr/0016-chatturnrunner-decomposition.md) and codebase census on 2026-09-25.

## R1. Extraction direction

**Decision**: Move SSE formatter first, then resolver, interpreter, conversation memory, admission, and coordinator. Conversation memory can be developed independently after the event seam exists.

**Rationale**: `apps/agent/src/agent/chat_turn/runner.py` contains the dense graph event loop and lifecycle code. Bottom-up extraction gives a focused test seam before moving lifecycle ownership.

**Alternative considered**: Coordinator first would carry the intertwined event loop into a renamed large module.

## R2. Actual graph completion source and wire compatibility

**Decision**: Invoke the resolver once for each guardrail-validated ToolMessage in the existing `on_chain_end` / `name == "tools"` output, before emitting ToolResultEvent. Preserve `on_tool_end` for timing telemetry. An accepted result emits the current ToolResultEvent and then any specialized follow-up in the current order; invalid readiness blocks before ToolResultEvent, though a prior ToolCallEvent may already have been emitted. The resolver must be able to supply the current readiness summary override or a safe block decision, not just an optional event. Keep handoff projection for its existing chain-end nodes. The coordinator checks the active fence before forwarding ActionRequiredEvent or ActionHandoffEvent.

**Rationale**: The ADR describes `on_tool_end` as the resolver point and a specialized-or-default result. Current `on_tool_end` has no authoritative validated message; `on_chain_end` is where the runner receives validated tool messages, emits ToolResultEvent, and may then emit FlightResultsEvent or ActionRequiredEvent. Literal use of the ADR pseudocode would drop events and change the SSE contract. This is a necessary source and return-shape reconciliation while retaining the ADR's tool-name-agnostic interpreter boundary.

**Alternative considered**: Migrating projections to raw `on_tool_end` would risk bypassing the validated message boundary and duplicate or reorder events.

## R3. Output policy ownership

**Decision**: Interpreter emits raw TokenEvent values from stream, model-end fallback, and node-end fallback. Coordinator feeds each token through the single gateway-owned OutputStreamSession and emits only approved chunks. Preserve deduplication state, partial response, one-shot flush, and non-flushing close.

**Rationale**: Translation and guardrail policy remain separate, with unchanged output safety and cleanup.

**Alternative considered**: Injecting the stream session into the interpreter would couple translation to security state.

## R4. Memory and admission

**Decision**: ConversationMemory delegates to NestJSClient, GuardrailGateway, and existing MemoryManager, forwarding the same per-turn AdmissionContext (user/session/trace/correlation/policy) for history re-scan and preserving the `totalMessageCount + 2` compaction count. Auth, input, and quota rules move to reusable services. FastAPI Depends wrappers express ordering while SSE remains an adapter. Preserve current length and gateway-health precedence, PII before Redis/quota, and one validated decision passed to ChatController.

**Rationale**: Current `sse.py` already passes precomputed admission to the controller; the extraction should retain that behavior rather than add a second scan.

**Alternative considered**: Generic middleware cannot reliably express the input-before-quota ordering.

## R5. Scope and verification

**Decision**: No new persistence model, dependency, route, event payload, or model/tool behavior. Focused suites: `test_chat_turn_runner.py`, `test_chat_turn_events.py`, `test_chat_controller.py`, `test_sse.py`, `test_sse_integration.py`, `test_memory.py`, trusted snapshot tests, stream session and auth budget tests, plus SSE characterization. Run the full non-Redis agent suite after integration.

**Rationale**: This is an internal decomposition; behavioral parity and security invariants are its acceptance criteria.
