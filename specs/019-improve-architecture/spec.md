# Feature Specification: Deepen Codebase Architecture

**Feature Branch**: `019-improve-architecture`
**Created**: 2026-08-20
**Status**: Approved input for planning
**Input**: Owner-approved decisions in `docs/adr/0004-architecture-review-deepening.md`, supplemented by `CONTEXT.md`.

## User Scenarios & Testing

### User Story 1 - Settle every verified refund consistently (Priority: P1)

As an operator or customer, I need every verified refund outcome to produce the same auditable financial and booking state whether it arrived inline, by webhook, through scheduled recovery, or through an administrator.

**Why this priority**: Refund settlement moves real money, and duplicated finalization logic can produce conflicting Payment and Booking states.

**Independent Test**: Drive equivalent verified outcomes through each trigger and verify identical Refund Transaction, ledger, Payment, Cancellation Refund Obligation, Booking, and audit results.

**Acceptance Scenarios**:

1. **Given** a verified successful Refund Transaction, **When** any trigger submits the normalized outcome, **Then** Refund Settlement atomically records it, writes exactly one matching ledger reversal, recalculates both aggregates, and derives Payment and Booking states.
2. **Given** a $500 Payment and a $300 Cancellation Refund Obligation after supplier cancellation, **When** three independent $100 Refund Transactions succeed, **Then** Payment remains `PARTIALLY_REFUNDED`, Booking remains `CANCELLED_PENDING_REFUND` after the first two transactions, and Booking becomes `CANCELLED_AND_REFUNDED` only after the third success.
3. **Given** a duplicate outcome for an already settled provider transaction, **When** Settlement receives it again, **Then** no duplicate ledger entry, audit record, or transition is created.
4. **Given** an active reservation, **When** a retry occurs, **Then** the same Refund Transaction, reservation, and idempotency identity are reused.

### User Story 2 - Isolate booking lifecycle, reads, and cancellation (Priority: P2)

As a maintainer, I need Payment, booking recovery, booking reads, and cancellation to depend only on the booking capability they use so the Payment and Booking modules no longer form a circular dependency.

**Why this priority**: The broad BookingService and `forwardRef` cycle make the critical payment path difficult to reason about and test.

**Independent Test**: Compile the NestJS module graph without Payment↔Booking `forwardRef`, then run payment confirmation, booking recovery, query, disruption, and cancellation behavior through public interfaces.

**Acceptance Scenarios**:

1. **Given** a normalized payment-pipeline outcome, **When** Payment invokes Booking Lifecycle, **Then** existing booking state, agent projection, and audit effects are preserved.
2. **Given** a booking query, **When** the controller invokes Booking Management, **Then** existing safe list/detail and disruption projections remain unchanged.
3. **Given** a cancellation, **When** Cancellation executes the supplier-first flow, **Then** it creates or continues the obligation and triggers provider refund work without settling records directly.

### User Story 3 - Centralize trusted search snapshot integrity (Priority: P3)

As a traveller using chat-assisted search, I need offer selection to resolve from one authoritative, attested snapshot without leaking provider identifiers to the LLM.

**Why this priority**: Snapshot creation, aliases, validation, persistence, selection, and projection currently span several modules.

**Independent Test**: Create, persist, reload, replace, validate, select, and safely project a snapshot through one lifecycle interface while proving identifier-free LLM output and unchanged handoff behavior.

**Acceptance Scenarios**:

1. **Given** attested results, **When** a snapshot is persisted, **Then** its TTL does not outlive offer freshness.
2. **Given** a new search, **When** its snapshot replaces the previous one, **Then** selection indices resolve only against the new snapshot.
3. **Given** a selected index, **When** selection succeeds, **Then** the lifecycle returns an attested resolved selection without creating a handoff token or calling the handoff service.

### User Story 4 - Separate chat turn lifecycle from SSE transport (Priority: P4)

As a chat user, I need streaming, guardrails, persistence, fencing, and cleanup to retain their behavior even if the HTTP connection disconnects or a turn fails.

**Why this priority**: One large streaming function mixes transport with durable turn orchestration.

**Independent Test**: Exercise Chat Turn Runner through an async typed-event interface independently of HTTP, then verify the thin adapter encodes events and closes the runner on disconnect.

**Acceptance Scenarios**:

1. **Given** a successful turn, **When** the runner completes, **Then** it preserves fencing, graph orchestration, guardrails, encrypted persistence, event order, and lease cleanup.
2. **Given** a failure, **When** recovery runs, **Then** durable cleanup completes before the terminal error event is yielded.
3. **Given** a disconnect, **When** the adapter closes the runner, **Then** cancellation-safe finalization releases leases and preserves the permitted partial turn without relying on event delivery.

### User Story 5 - Keep transport and credentials out of rendering (Priority: P5)

As a web user and maintainer, I need Flight Search and Booking Management rendering to consume typed server outcomes without receiving JWTs, backend URLs, or retry policies.

**Why this priority**: Current Client Components cross the browser-to-NestJS boundary directly and duplicate transport knowledge.

**Independent Test**: Exercise both flows while asserting browser requests use the approved server seam, tokens never enter Client Component props, and visible outcomes remain stable.

**Acceptance Scenarios**:

1. **Given** search input, **When** the user searches or selects an offer, **Then** a server-owned operation handles authentication, transport, bounded retries, validation, and typed mapping.
2. **Given** a booking command, **When** the user refreshes, cancels, acknowledges, or accepts a disruption, **Then** server-owned operations enforce authentication and typed conflict/error semantics.
3. **Given** either rendering tree, **When** its client bundle and props are inspected, **Then** no JWT, NestJS URL, internal Duffel/Stripe identifier, or retry policy is present; user-facing booking references such as a PNR remain available to the authenticated booking owner.

### User Story 6 - Give each agent tool a local capability boundary (Priority: P6)

As a maintainer, I need each approved read-only tool family to own its validation, privacy projection, audit, and dependencies instead of using one catch-all Agent Gateway service.

**Why this priority**: The broad gateway couples unrelated tools and chat persistence.

**Independent Test**: Invoke all six approved tools through capability-local modules and verify compatible safe outputs, unchanged authorization, and no tool-inventory expansion.

**Acceptance Scenarios**:

1. **Given** search, readiness, booking-read, or preference traffic, **When** the controller routes it, **Then** only the corresponding capability module is involved.
2. **Given** chat persistence traffic, **When** it reaches NestJS, **Then** the Chat module owns it rather than a shallow gateway forwarder.
3. **Given** any response, **When** privacy contracts are evaluated, **Then** the six read-only tools and two-tier booking exposure remain unchanged.

### Edge Cases

- Concurrent initiators attempt to reserve more than the Payment or obligation remainder.
- A webhook and inline response report the same provider refund in opposite arrival order.
- A terminal failure releases its reservation while another transaction remains active.
- An obligation is fulfilled while the original Payment remains partially refunded because of an airline penalty.
- Booking confirmation fails after partial provider progress and later recovery converges.
- A stale or legacy snapshot alias appears during migration.
- The chat client disconnects during guardrail work or durable persistence.
- A server seam receives an expired session, malformed JSON, stale disruption revision, or unavailable offer.
- A gateway tool attempts to return a field outside its privacy projection.

## Requirements

### Functional Requirements

- **FR-001**: One provider-blind Refund Settlement module MUST solely own terminal Refund Transaction, ledger, Payment, obligation, Booking, and audit transitions.
- **FR-002**: Inline, webhook, cron, and admin triggers MUST normalize verified outcomes and MUST NOT retain alternative settlement writes.
- **FR-003**: A Booking MUST have at most one Cancellation Refund Obligation; an obligation MUST support multiple independent Refund Transactions.
- **FR-004**: A Payment MUST support multiple Refund Transactions, including non-cancellation refunds.
- **FR-005**: Each successful Refund Transaction MUST create exactly one ledger reversal for its successful amount.
- **FR-006**: Payment refund state MUST derive from cumulative successful refunds versus original Payment amount.
- **FR-007**: Booking cancellation fulfillment MUST derive from successful obligation transactions versus obligation amount.
- **FR-008**: Active transactions MUST reserve against both applicable balances; retries MUST reuse the same reservation and idempotency identity.
- **FR-009**: Settlement MUST be idempotent under duplicate and out-of-order delivery.
- **FR-010**: Booking Lifecycle MUST own creation, confirmation, failure, reconciliation, completion, recovery, and lifecycle crons.
- **FR-011**: Payment MUST invoke Booking Lifecycle through normalized outcomes without depending on broad BookingService.
- **FR-012**: Booking Management MUST own safe list/detail projections, disruption mapping, and sorting.
- **FR-013**: Cancellation MUST own quote, supplier-first cancellation, recovery coordination, and refund triggering, but not settlement.
- **FR-014**: The Payment↔Booking `forwardRef` cycle MUST be removed without changing accepted state machines.
- **FR-015**: Trusted Search Snapshot Lifecycle MUST own create, validate, replace, persist, select, and safe-project operations.
- **FR-016**: Snapshot Lifecycle MUST NOT create handoff tokens, call handoff creation, or create booking intents.
- **FR-017**: Snapshot TTL MUST be bounded by offer freshness; safe projections MUST exclude provider identifiers and attestations.
- **FR-018**: Chat Turn Runner MUST own ordering, fencing, graph orchestration, guardrails, encrypted persistence, leases, recovery, and cancellation-safe finalization.
- **FR-019**: The HTTP/SSE adapter MUST own only connection handling, disconnect detection, typed-event encoding, and runner closure.
- **FR-020**: Durable runner cleanup MUST complete before a terminal error event is yielded.
- **FR-021**: Production chat events MUST use typed contracts shared with tests.
- **FR-022**: Flight Search and Booking Management rendering MUST NOT receive JWTs, backend URLs, internal Duffel/Stripe identifiers, raw provider payloads, or retry policies; authenticated owner-facing booking references remain part of the prepared Booking view.
- **FR-023**: Server-owned operations MUST validate upstream responses and return typed domain outcomes.
- **FR-024**: Agent Gateway MUST split into capability-local modules for attested search, readiness, safe booking reads, and preferences.
- **FR-025**: Chat persistence MUST be owned by the Chat module, except for a deliberate boundary adapter where needed.
- **FR-026**: The six read-only tools, deterministic handoff boundary, and two-tier booking privacy model MUST remain unchanged.
- **FR-027**: Each slice MUST be independently deployable, retain rollback capability, and pass behavior tests before the next slice.
- **FR-028**: Transactional changes MUST emit structured, PII-safe audit and telemetry with trace and correlation identifiers.
- **FR-029**: New external-boundary contracts MUST pair runtime validation with inferred static types and stable imports.
- **FR-030**: No new third-party runtime dependency MAY be introduced without separate approval and documentation.

### Key Entities

- **Cancellation Refund Obligation**: One amount owed for one cancellation; one-to-one with Booking and one-to-many with Refund Transactions.
- **Refund Transaction**: One provider money movement with its own amount, provider and idempotency identities, lifecycle, and ledger reversal; belongs to Payment and optionally an obligation.
- **Refund Reservation**: The active amount claimed against both applicable balances until success or terminal failure.
- **Normalized Refund Outcome**: Provider-blind terminal facts plus audit-only provenance.
- **Normalized Payment Pipeline Outcome**: Provider-blind success or categorized failure facts passed into Booking Lifecycle.
- **Trusted Search Snapshot**: Attested, expiring code-owned offer selection state with identifier-free LLM projections.
- **Typed Chat Event**: A validated event yielded by Chat Turn Runner and encoded by SSE.
- **Prepared Booking View / Typed Command Outcome**: Server-produced contracts separating rendering from authentication and transport.

## Success Criteria

### Measurable Outcomes

- **SC-001**: All four refund paths pass one settlement contract suite and produce zero duplicate ledger entries under replay.
- **SC-002**: Concurrent reservations cannot make active plus successful amounts exceed either applicable parent amount.
- **SC-003**: Payment↔Booking `forwardRef` and Payment's broad BookingService dependency are absent after the booking slice.
- **SC-004**: Existing booking, cancellation, payment, disruption, chat, handoff, search, and gateway behavior suites remain green after their slices.
- **SC-005**: Chat Turn Runner is testable without HTTP, and SSE encoding without LangGraph or persistence.
- **SC-006**: Flight Search and Booking Management browser bundles and component props contain no access token or NestJS transport configuration.
- **SC-007**: Snapshot selection and safe projection have one production interface and reject malformed or stale state consistently.
- **SC-008**: Each Agent Gateway capability test constructs only its required dependencies.
- **SC-009**: Every slice documents migration, rollout, observability, rollback, and end-to-end verification before implementation.

## Assumptions

- The ADR and `CONTEXT.md` are owner-approved and supersede conflicting implementation details while remaining subordinate to the constitution.
- Existing external API and UI behavior is preserved unless this specification explicitly changes it.
- Existing dependencies are reused.
- Refund balances derive from Refund Transactions inside an atomic database concurrency boundary; the exact mechanism is selected in the plan.
- Candidate #9 (Duffel provider-interface narrowing) remains deferred.
- Traveler Profile/shared-contract deepening is outside Feature 019 except contracts required by Flight Search.
- This workflow creates planning artifacts only; implementation and task generation occur later.
