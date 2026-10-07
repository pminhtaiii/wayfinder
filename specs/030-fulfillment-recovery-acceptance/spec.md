# Feature Specification: Safe Booking Fulfillment Recovery

**Feature Branch**: codex/030-fulfillment-recovery-acceptance
**Created**: 2026-10-07
**Status**: Draft
**Input**: Accepted booking fulfillment and payment verification decisions in docs/adr/research-booking-fulfillment-reconciliation-decisions.md and docs/adr/research-payment-verification-architecture-decisions.md.

## User Scenarios & Testing

### User Story 1 - Complete or safely hold a booking (Priority: P1)

A traveler confirms a flight booking and receives a truthful final or pending status. The system authorizes the traveler payment, asks the supplier to create an instant order using the supplier authoritative balance amount and currency, and captures the traveler authorization only after the order is confirmed. If either provider response is uncertain, the booking remains recoverable and the system establishes provider state before taking a compensating or repeated action.

**Why this priority**: This is the money-moving booking journey. Preventing a duplicate order, an unjustified capture, or an unjustified release protects both traveler funds and supplier commitments.

**Independent Test**: Drive real booking/payment orchestration and the database through isolated stateful provider simulators for success, definitive failure, and lost-response cases. Assert simulator ledgers, persisted booking state, checkpoints, and traveler-visible status without real provider accounts.

**Acceptance Scenarios**:

1. **Given** a valid booking intent and sufficient Stripe authorization, **When** the traveler confirms payment and the supplier instant order is validated, **Then** the supplier leg uses its authoritative balance amount and currency, the traveler authorization is captured once, and the confirmed booking shows the validated order.
2. **Given** a supplier create attempt whose response is lost, **When** the traveler retries or recovery claims the case, **Then** the prior attempt is reconciled and any candidate linkage validated before capture, cancellation, release, or another create; an unresolved attempt is never replayed automatically.
3. **Given** a Stripe capture request with an uncertain result after supplier confirmation, **When** recovery runs, **Then** Stripe is reconciled before supplier cancellation and the order is retained while capture remains unknown.
4. **Given** definitive supplier failure before any order exists, **When** the result is verified, **Then** Stripe authorization may be released and the booking records the verified failure.
5. **Given** the supplier order is confirmed and Stripe capture definitively fails, **When** compensation runs, **Then** supplier cancellation is confirmed and persisted before releasing the authorization; an unconfirmed cancellation leaves the case recoverable.
6. **Given** the traveler authorization expires while supplier creation is unresolved, **When** the order is later confirmed, **Then** expiry is recorded as payment evidence but is not treated as proof that no supplier order exists; recovery follows the confirmed-order/expired-payment compensation or review path and never blindly recaptures or creates again.

### User Story 2 - Reconcile and escalate uncertainty with evidence (Priority: P1)

A booking operations user can find uncertain cases, see provider evidence and elapsed time, and take only an evidence-supported workflow action. Automatic reconciliation starts immediately and continues after a case is escalated. Escalation requests attention; it does not declare provider failure or authorize unsafe retry.

**Why this priority**: Time-sensitive intervention needs a reliable queue without turning a clock threshold or manual button into financial truth.

**Independent Test**: Seed an unresolved case and advance a deterministic clock while isolated providers expose controlled records. Verify bounded automatic reconciliation, active queue visibility at the configured threshold or earlier expiry safeguard, and that only evidence-backed actions can resolve the case.

**Acceptance Scenarios**:

1. **Given** a provider outcome first becomes uncertain, **When** automatic recovery is scheduled, **Then** it begins without waiting for escalation and continues after queue entry.
2. **Given** uncertainty has persisted for 15 minutes or intervention is needed before actual authorization expiry, **When** an authorized operations user opens the queue, **Then** the case is visible with age, expiry context, last reconciliation outcome, and retained evidence.
3. **Given** an operator requests a supported reconciliation or resume action, **When** the case is still unresolved, **Then** the system re-reads evidence, validates order linkage, acquires the same claim as automation, records actor/evidence/action/outcome, and safely no-ops if resolved.
4. **Given** provider state is unknown or supplier evidence cannot be linked to the booking, **When** an operator tries to force, release, refund, cancel, close, or create, **Then** the unsupported action is rejected and the case remains active.
5. **Given** late validated evidence resolves an escalated case, **When** status refreshes, **Then** the case leaves the active queue while audit and provider evidence remain available.

### User Story 3 - Roll out recovery without losing in-flight evidence (Priority: P2)

A release operator can introduce durable recovery gradually while existing bookings and payment records remain readable. In-flight work from before the feature is not treated as absent, and the new workflow stays disabled until explicitly enabled.

**Why this priority**: A safe transaction design needs a migration path that cannot strand payments or assume old recovery records do not exist.

**Independent Test**: Migrate a clean database and a legacy fixture with in-flight booking, payment, event, and request-idempotency rows. Verify compatibility and traceable backfill, then verify that new behavior is inactive until its release switch is enabled.

**Acceptance Scenarios**:

1. **Given** legacy in-flight records, **When** additive migration/backfill runs, **Then** evidence remains readable and synthesized workflow identity links to its source.
2. **Given** the feature switch is off, **When** confirmation processes an existing booking, **Then** no partial new workflow mutates that case.
3. **Given** a migrated row is incomplete or contradictory, **When** the new path evaluates it, **Then** it fails closed to reconciliation instead of inventing an outcome.

### Edge Cases

- Supplier order creation can take up to 120 seconds; use a client timeout of at least 130 seconds in accordance with the current supplier contract.
- Requests or webhooks are duplicated, delayed, out of order, invalidly signed, or replayed after resolution.
- Authorization expires while reconciliation runs or has less remaining time than the configured pre-create margin.
- A provider returns a processing state or its read API is unavailable or rate-limited.
- Supplier discovery returns zero, one, or multiple candidates without verified durable linkage.
- A claim expires while a provider call remains in flight; its late result arrives after another owner takes over.
- Capture later becomes succeeded, definitively failed, or remains non-final after an ambiguous response.
- Supplier cancellation, authorization release, or refund has an ambiguous response or webhook race.
- A legacy booking lacks reliable attempt evidence, supplier metadata, or an active request idempotency row.
- An HTTP idempotency key is replayed or expires while a durable workflow remains unresolved.

## Requirements

### Functional Requirements

- **FR-001**: Booking confirmation MUST authorize traveler payment, obtain a validated instant supplier order, then capture traveler authorization only after supplier confirmation.
- **FR-002**: Supplier payment MUST use supplier-returned authoritative balance amount and currency; traveler charge is a separate financial leg.
- **FR-003**: Each provider result MUST be classified as confirmed, definitively failed, or unresolved, with evidence and timestamps retained.
- **FR-004**: Before supplier create, verify authorization validity and sufficient remaining time for order creation, capture, and recovery margin. If insufficient before any supplier attempt, obtain renewed authorization before dispatch.
- **FR-005**: After uncertain supplier create or capture, reconcile its existing durable operation before another financial or supplier action. Never assume create replay safety or invent a unique lookup key.
- **FR-006**: A discovered supplier candidate MUST pass supplier identity, booking linkage, itinerary, passenger, and known order evidence validation before action.
- **FR-007**: If capture is uncertain, reconcile Stripe before cancelling a confirmed order. If capture definitively failed, persist confirmed order cancellation before releasing authorization.
- **FR-008**: Automated and operator mutations MUST use one time-bounded claim per unresolved booking, re-read and validate after claim, and no-op for resolved cases.
- **FR-009**: Fence the durable pre-dispatch attempt write and post-provider state transaction. Lease expiry does not stop an in-flight provider call. Record valid late evidence without allowing a stale owner to advance workflow state.
- **FR-010**: Give each logical provider operation a stable durable identity across requests and takeovers and each dispatch/reconciliation execution a distinct attempt identity. HTTP idempotency MUST NOT be a second workflow lock.
- **FR-011**: Persist an uncovered provider side-effect attempt as prepared/possibly sent after preflight and immediately before dispatch. A prepared marker is not proof of provider receipt.
- **FR-012**: Reconciliation starts when uncertainty begins, uses bounded provider-aware retry/backoff within supplier/payment budgets, and continues after escalation. Initial escalation is 15 minutes from first uncertainty, earlier if actual authorization expiry requires intervention.
- **FR-013**: A threshold or reconciliation result does not alone declare success/failure or authorize capture, release, refund, cancellation, or create. Surface actual authorization expiry and configured recovery margin.
- **FR-014**: The active queue excludes resolved cases and retains their evidence/audit history. Queue age begins at first uncertainty and does not reset on retry, claim renewal, or escalation.
- **FR-015**: Operator endpoints enforce authenticated operations-role access, allow only evidence-supported actions, and audit actor/evidence/action/time/outcome. No force-success/failure, blind create retry, or unverified release is allowed.
- **FR-016**: Validate provider webhook signatures and preserve existing booking/payment wire contracts during rollout.
- **FR-017**: Persistence changes are additive and deployable disabled. Backfill preserves old rows and creates traceable identities for eligible in-flight work without assuming it is absent.
- **FR-018**: Recovery stays deterministic. Exploratory browser agents cannot authorize, create, capture, refund, cancel, or resolve a production booking.
- **FR-019**: Reduce database round trips only where one fenced update/transaction safely replaces a redundant ownership read; do not move/delete a checkpoint that covers an external side effect.

### Key Entities

- **FulfillmentCase**: Deterministic workflow state, first uncertainty time, escalation state, checkpoints, provider linkage, and safe next action.
- **ProviderOperation**: Stable identity for one logical provider side effect or reconciliation purpose, independent of request and owner.
- **ProviderAttempt**: One dispatch/reconciliation execution with preflight, prepared, response, classified outcome, and evidence timestamps.
- **RecoveryClaim**: Shared time-bounded ownership and monotonic fence for automation and operators.
- **ProviderEvidence**: Validated provider response, retrieved record, signed event, or explicit non-final observation tied to an operation/attempt.
- **ReconciliationCase**: Operator view of unresolved work, age, escalation/expiry context, and evidence.
- **OperatorAuditRecord**: Authenticated actor, evidence references, supported action, result, and timestamp.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Every deterministic payment/supplier fault-matrix case ends confirmed, definitively failed, or still recoverable; no unresolved supplier create is automatically replayed.
- **SC-002**: For every controlled confirmed-order/unknown-capture case, Stripe reconciliation occurs before supplier cancellation.
- **SC-003**: Each unresolved case enters the active queue within one configured reconciliation cycle after 15 minutes from first uncertainty, or earlier when actual authorization expiry requires intervention.
- **SC-004**: Every successful operator mutation records authenticated actor, validated evidence reference, action, timestamp, and outcome; unsupported financial actions are rejected.
- **SC-005**: Migration fixtures preserve all legacy booking/payment/event/idempotency evidence and do not activate the new path until explicitly enabled.
- **SC-006**: The repeatable CI system-flow suite uses real application orchestration/database and isolated stateful simulators to verify delayed and duplicate signed events without real credentials or sleeps except timeout tests.
- **SC-007**: A small isolated sandbox contract suite validates live provider fields and outcomes without production financial accounts.

## Assumptions

- Stripe Payment Intents and supplier instant orders are separate financial legs; deferred supplier hold-order purchase is out of scope.
- The accepted linked ADRs govern behavior; exact thresholds and provider fields require verification before enabling live behavior.
- The 15-minute escalation is configurable policy measured from first uncertainty; actual authorization expiry is retrieved from provider evidence.
- Existing booking, payment, webhook, and idempotency records remain readable; migration is additive.
- Implementation targets the current API, database, existing payment/fulfillment ports, and current booking experience.
- Browser-based exploratory agents may be evaluated later as non-authoritative QA helpers; they are outside this production feature.
