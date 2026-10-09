# Feature Specification: Event-Driven Module Deepening

**Feature Branch**: `024-event-driven-module-deepening`
**Created**: 2026-09-15
**Status**: Planning converged on 2026-09-16; implementation not started

## Input and scope

Implement the recorded [payment decisions](../../docs/adr/0031-payment-module-deepening.md) and [projection decisions](../../docs/adr/0008-booking-projection-event-driven.md). One coordinated backend feature: extract payment orchestration, then cut over derived booking projections. Public booking/payment/agent contracts remain compatible. The user authorized spec, plan, tasks and iterative subagent reviews; this does not start implementation.

## User Scenarios & Testing

### US1 — Complete and recover payment safely (Priority: P1)

As a traveler, I can confirm payment and receive the existing immediate or pending response without duplicate charges or airline orders after retries or provider timeouts.

**Why this priority**: Protect the financial transaction while separating orchestration from payment CRUD.

**Independent test**: Exercise the real HTTP controller and extracted saga with controlled providers and PostgreSQL; retain existing projection calls until US2.

**Acceptance scenarios**:

1. Given authorized payment and valid bound passengers/ancillaries, confirmation validates authorization, creates the airline order, captures payment, then commits canonical booking/payment/ledger changes atomically.
2. Given the same owner/route/key/payload, replay causes no duplicate external effect. Changed payloads or another owner cannot reuse the result.
3. Given execution exceeds 25 seconds, HTTP returns existing 202 PENDING while the same promise continues; polling and recovery still work.
4. Given capture throws, authoritative success continues confirmation without canceling the order. Unknown outcomes remain recoverable; only known noncapture permits compensation.
5. Given a crash at any checkpoint, retry/recovery reuses persisted identifiers and provider idempotency keys. Existing attempt limits and new-payment retry requirements remain enforced.

### US2 — Receive current safe booking information (Priority: P1)

As a traveler using the assistant, I receive a privacy-safe derived view after booking, cancellation, disruption and refund changes.

**Independent test**: Commit each source mutation through its actual service, await projection state with a bounded timeout, and verify status, version and owner isolation.

**Acceptance scenarios**:

1. Successful canonical transactions dispatch passive events only after commit. Rollbacks, rejected transitions and no-ops dispatch none.
2. Listener failure logs/counts a safe error without changing the committed command's successful response.
3. Duplicate/reverse-order events and overlapping hydration never regress persisted sourceVersion or replace an existing agentReference.
4. Cancellation claim/finalization, refund success/failure/manual retry and supplier revision changes all refresh from actual source state.
5. Another owner's read remains forbidden; no new field exposes passenger data, payment data, raw provider payloads or private identifiers.

### US3 — Repair projection drift (Priority: P2)

As an operator, I can repair missing/stale projections after missed events using database state without modifying canonical financial records.

**Independent test**: Suppress dispatch, commit mutations, run reconciliation and verify repair; malformed rows must not starve later IDs.

**Acceptance scenarios**:

1. Each pass considers at most 100 candidates and performs at most five repairs concurrently, without provider calls.
2. Successive passes rotate fairly through more than 100 candidates, including permanently malformed rows.
3. Historical projections start behind their source version after migration and retain their references during repair.
4. Concurrent workers/live events/backfill cannot regress projections; telemetry distinguishes repaired, current, skipped and failed results.

### Edge cases

- Capture timeout after success; failed compensation; database failure after capture; stale idempotency owner.
- Transaction retries require fresh event collectors; caller-owned and standalone transactions both work.
- Hydration may see a newer source than the event; booking and itinerary must be a coherent snapshot.
- Missing flight data leaves an absent projection observable; malformed new itinerary cannot be declared fully repaired with old flight fields.
- Commit-to-dispatch crash, concurrent insert and duplicate refund facts.

## Functional Requirements

- **FR-001**: Extract a concrete saga preserving authorization → order → capture → canonical confirmation, locks, ledger/audit bundles, attempt limits and recovery.
- **FR-002**: Preserve routes, guards, DTOs, ownership, idempotency/replay responses, polling and 25-second Tier 2 behavior.
- **FR-003**: Use provider-blind ports implemented beside existing SDK wrappers; retain direct wrappers for recovery/unrelated flows. Bound adapter admission and always release permits.
- **FR-004**: Extract combined idempotency/checkpoint ownership. Preserve acquisition/fencing; terminal saga checkpoint and replay response become one atomic owner-fenced write.
- **FR-005**: Financial mutations remain authoritative and synchronous. No generic saga, queue or Redis payment lock.
- **FR-006**: Extract projection writes from AgentGatewayModule; replace all direct domain calls in one cutover and remove the associated forwardRef cycle.
- **FR-007**: Passive events carry bookingId, eventId, sourceVersion, timestamp. Lifecycle produces booking facts; the outer transaction owner dispatches after commit.
- **FR-008**: Increment Booking.version atomically for actual business-state/itinerary changes; explicitly exclude bookkeeping. No-op mutations neither increment nor emit.
- **FR-009**: Hydrate once per processing cycle from a consistent snapshot; persist its version using atomic stale-write rejection and stable references.
- **FR-010**: Preserve extraction precedence, PII allowlist and owner-scoped readers; isolate listener failures.
- **FR-011**: Repair missing/stale projections with fair 100/5 batches and guarded backfill. No provider calls, generic retry, outbox or distributed lease.
- **FR-012**: Supply privacy-safe failure/repair telemetry, migration/rollback instructions, runnable verification and module-boundary tests.
- **FR-013**: Include recovery, cancellation claims/finalization, supplier revisions, refund success/failure and manual retry; preserve existing guards and refund lock order.
- **FR-014**: Require behavior-focused unit, integration, boundary and database E2E tests per context/workflow.md; record actual gate exit codes at implementation.

## Key Entities

Booking is canonical business state plus version. BookingAgentProjection remains the existing safe table plus sourceVersion. Domain events are ephemeral identity/version facts. IdempotencyKey retains request binding, lease, checkpoint and replay result. Normalized provider outcomes carry evidence needed by the saga without SDK types.

## Success Criteria

- **SC-001**: Confirmation/replay/recovery fixtures create at most one order and capture per operation; public contract characterizations pass.
- **SC-002**: Every inventoried mutation has a postcommit path; zero direct core-to-agent projection dependencies remain.
- **SC-003**: Concurrent writes never lower sourceVersion or change an existing reference.
- **SC-004**: A full reconciliation traversal repairs all repairable fixture rows despite malformed candidates.
- **SC-005**: Listener errors cannot alter committed HTTP outcomes; privacy/ownership tests pass.
- **SC-006**: Independent planning reviewers report zero unresolved HIGH/CRITICAL issues; requirements map to executable tasks.

## Assumptions and exclusions

US1 can ship first. US2 and US3 activate together in the user-approved nonproduction cutover without dual writes. No frontend redesign, provider replacement, generic event platform, refund module extraction or repair of the other two query-coupling cycles. Planning review is not runtime verification.
