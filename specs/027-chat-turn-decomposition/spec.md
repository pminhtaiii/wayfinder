# Feature Specification: Chat Turn Decomposition

**Feature Branch**: `codex/027-028-specs-review`
**Created**: 2026-09-25
**Status**: Draft for review
**Input**: [Chat turn decision record](../../docs/adr/0016-chatturnrunner-decomposition.md)

## User Scenarios & Testing

### User Story 1 - Isolate graph event translation (Priority: P1)

As a chat maintainer, I can reason about graph events and domain projections independently of a live chat session. A new domain-significant tool changes only the resolver.

**Why this priority**: The event loop is the densest coupling in the current runner.

**Independent Test**: Replay representative synthetic graph events through the interpreter with a fake resolver and compare the emitted domain events and order with current behavior, without Redis, NestJS, or an LLM.

**Acceptance Scenarios**:

1. **Given** model and tool events, **when** interpreted, **then** existing domain event types, payloads, and order are retained.
2. **Given** a guardrail-validated tool completion, **when** interpreted, **then** the resolver is called before ToolResultEvent emission; accepted completions retain the current result-then-specialized order, while invalid booking readiness emits no ToolResultEvent.
3. **Given** streamed model tokens, **when** interpreted, **then** raw token events reach the caller, which applies the existing output guardrail before delivery or persistence.

---

### User Story 2 - Coordinate conversation memory (Priority: P2)

As a chat maintainer, I can retrieve safe prior context and schedule summarization through one interface while retaining the existing fetch, scan, and summary mechanisms.

**Independent Test**: With fake collaborators, verify history window selection, guardrail re-scan, fail-closed rejection, and non-blocking compaction scheduling against current fixtures.

**Acceptance Scenarios**:

1. **Given** stored history and summary, **when** context is requested, **then** the same safe context is returned.
2. **Given** unsafe stored context, **when** re-scanned, **then** graph execution does not begin.
3. **Given** an eligible completed turn, **when** compaction is scheduled, **then** existing trigger and background behavior are preserved.

---

### User Story 3 - Reuse ordered admission (Priority: P3)

As a transport maintainer, I can invoke common authentication, input admission, and quota services in the required order without copying business rules into an endpoint.

**Independent Test**: Exercise shared services and the SSE endpoint; verify auth → input scan → quota, one scan, and unchanged errors.

**Acceptance Scenarios**:

1. **Given** blocked PII input, **when** admitted, **then** it is rejected before quota or Redis work with the established error event.
2. **Given** valid input, **when** admitted, **then** the validated result reaches the runner without a second scan.
3. **Given** an existing SSE request, **when** served, **then** HTTP and event formats are unchanged.

---

### User Story 4 - Expose a sequential turn lifecycle (Priority: P4)

As a chat maintainer, I can trace session setup, lease/fencing, graph execution, output protection, persistence, and cleanup in a focused coordinator.

**Independent Test**: Run current lifecycle and security characterization for normal, blocked, cancelled, stale-fence, and failed turns; compare events, persistence, cleanup order, and lease release.

**Acceptance Scenarios**:

1. **Given** a successful turn, **when** it completes, **then** messages, snapshots, events, and summary scheduling are unchanged.
2. **Given** a block, cancellation, or exception, **when** it exits, **then** approved partial persistence, output close, and lease release retain current order.
3. **Given** a domain event, **when** serialized for SSE, **then** the wire representation remains identical while event definitions remain transport independent.

### Edge Cases

- Unknown or malformed graph events retain safe handling; raw tool payloads cannot reach clients through a new path.
- Resolver I/O failures retain current blocking or fallback behavior.
- Invalid booking readiness may emit its existing ToolCallEvent but MUST fail closed before ToolResultEvent; a stale fence prevents ActionRequiredEvent or ActionHandoffEvent delivery.
- Sensitive text split across token chunks passes through one output stream session.
- Gateway unavailability retains admission precedence and fail-closed response.
- PII-blocked input consumes zero quota and performs zero Redis calls.
- Early return, cancellation, and exceptions close the output session without an extra flush.

## Requirements

### Functional Requirements

- **FR-001**: A graph event interpreter MUST translate the existing graph event stream to the existing ChatTurnEvent union without domain-specific I/O or tool-name checks.
- **FR-002**: Every guardrail-validated tool completion MUST invoke a ToolResultResolver before ToolResultEvent emission. Accepted completions MUST preserve the current ToolResultEvent and any specialized follow-up event in their established order; invalid booking readiness MUST emit no ToolResultEvent and retain its existing error/cleanup behavior.
- **FR-003**: The resolver MUST own existing search snapshot and booking readiness tool projections plus checkout handoff projection from the existing handoff node-completion outputs, including safe summary overrides, force-persistence decisions, and fail-closed errors. ActionRequiredEvent and ActionHandoffEvent MUST pass the existing active-fence check before external emission.
- **FR-004**: The interpreter MUST emit raw token events; the caller MUST route all emitted model content through the existing per-turn output guardrail before delivery or persistence.
- **FR-005**: ConversationMemory MUST coordinate existing history fetch, window slicing, history guardrail re-scan, and background summarization without replacing their mechanisms. Re-scanning MUST receive the per-turn AdmissionContext with its existing user, session, trace, correlation, and policy values.
- **FR-006**: Shared admission services MUST preserve auth, length/health, input validation, and quota order. Input validation MUST occur once and its result MUST reach the runner.
- **FR-007**: FastAPI dependency wrappers MUST be thin; admission rules MUST be callable without FastAPI.
- **FR-008**: SSE formatting MUST move from the event model to the SSE adapter with byte-for-byte compatible output.
- **FR-009**: A turn coordinator MUST preserve session bootstrap, distributed lease/fencing, snapshot loading, message persistence, graph invocation, output flush/close, compaction, and exceptional cleanup.
- **FR-010**: Routes, event names/payloads, status/error codes, guardrail behavior, persistence schema, and tool/model behavior MUST remain unchanged.
- **FR-011**: Extraction MUST proceed incrementally: serialization move, resolver, interpreter, memory, admission, coordinator, each with a passing focused gate.
- **FR-012**: Tests MUST characterize translation, projection, memory, ordered admission, SSE compatibility, and lifecycle cleanup without a live LLM for unit coverage.

### Key Runtime Entities

- **Chat turn event**: Existing domain notification emitted during a turn.
- **Turn context**: Data required to interpret and project one turn without changing stored records.
- **Validated conversation context**: Safe history and summary available to graph execution.
- **Validated input**: Admission result passed into the turn without duplicate scanning.
- **Turn lease**: Existing distributed ownership and fencing state.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Existing chat, SSE, memory, guardrail, and security suites pass with zero intended wire or persistence contract changes.
- **SC-002**: Every covered PII-blocked request consumes zero quota and makes zero Redis calls.
- **SC-003**: Interpreter tests run with synthetic graph events and fake collaborators, with zero live model, Redis, or backend calls.
- **SC-004**: Every covered normal, blocked, cancelled, and exceptional turn closes its output session and releases its lease exactly as before.
- **SC-005**: Static inspection finds zero tool-name checks or output guardrail construction in the interpreter and zero SSE formatting in the event-model module.
- **SC-006**: Invalid readiness emits zero ToolResultEvents, and stale-fence turns emit zero action-required or handoff events in the focused suites.

## Assumptions

- This is a behavior-preserving refactor with no new endpoint, database migration, model, package, or user-facing feature.
- Existing tests and production event shapes are the compatibility authority where the decision record does not list every field.
- The six new modules named in the decision record are interpreter, resolver, conversation memory, and three admission services; the coordinator is extracted within the existing runner module.
