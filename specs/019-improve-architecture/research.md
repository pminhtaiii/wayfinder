# Phase 0 Research: Deepen Codebase Architecture

This research resolves all technical choices needed to implement the approved decisions in `docs/adr/0004-architecture-review-deepening.md`.

## R1. Scope and delivery model

**Decision**: Deliver Feature 019 as six independently deployable architecture slices in the ADR order: Refund Settlement; Booking Lifecycle/Management/Cancellation; Trusted Search Snapshot; Chat Turn Runner; Flight Search and Web Booking Management server seams; Agent Gateway capability modules. Defer Duffel capability narrowing and the optional Traveler Profile/shared-contract redesign.

**Rationale**: Each slice has a distinct behavior surface and rollback boundary. A big-bang rewrite would violate incremental delivery and make regression attribution difficult.

**Alternatives considered**:

- One repository-wide architecture rewrite: rejected because it combines unrelated risk domains.
- A shared-contract big bang first: rejected because contracts should be introduced only for the slice consuming them.

## R2. Refund obligation and transaction migration

**Decision**: Add `CancellationRefundObligation` as the one-to-one Booking obligation and reinterpret the existing Refund record as an individual `RefundTransaction`. Add a nullable obligation foreign key first, backfill existing cancellation refunds, validate, and remove the legacy direct Booking→Refund relationship only in a later contract migration. Keep the physical `refunds` table initially via Prisma `@@map` to avoid a table-rename rollout dependency.

**Rationale**: The current schema already permits Payment→many Refund rows, but `Refund.bookingId @unique` and Booking’s singular relation prevent multiple independent transactions for one cancellation. Expand/backfill/contract keeps old code deployable during migration and preserves rollback.

**Alternatives considered**:

- Booking→many Refund directly: rejected because it conflates the amount owed with provider money movements.
- Destructive table/model replacement in one migration: rejected because it prevents safe rollback and makes legacy validation impossible.
- Mutable refunded/reserved counters on both parent tables: rejected initially because Refund Transactions are the auditable source of truth and duplicated counters can drift.

## R3. Refund reservation concurrency

**Decision**: Reserve capacity in a short PostgreSQL transaction that locks Payment first and then the Cancellation Refund Obligation when present, sums successful and active transaction amounts, validates both remainders, and inserts the Refund Transaction plus transaction-scoped idempotency record. Commit before any Stripe call. All code paths use the same lock order. Retries reuse the existing transaction and reservation.

Active reservation statuses are `REFUND_PENDING`, `REFUND_PROCESSING`, and `REFUND_RETRY_SCHEDULED`. `SUCCEEDED` consumes the reserved amount; terminal failure releases it.

**Rationale**: This applies the invariant to both financial parents, prevents over-refund races, and follows the established pattern of brief database coordination with no locks across network calls.

**Alternatives considered**:

- Stripe-only over-refund protection: rejected because local state could still create duplicate work and contradictory audit history.
- Redis locks: rejected because PostgreSQL owns both authoritative balances and existing payment decisions exclude Redis coordination.
- Long database locks around Stripe: rejected because external calls cannot be part of a database transaction.

## R4. Refund Settlement contract and state projections

**Decision**: Refund Settlement accepts a persisted Refund Transaction identity plus normalized terminal money facts and audit-only provenance. It validates amount/currency against the transaction, then atomically updates the transaction, exactly one ledger reversal pair, Payment projection, obligation fulfillment projection, Booking projection, payment event, and audit record. Provider or trigger provenance never changes settlement rules.

Payment projection uses cumulative successful refunds against original Payment amount. Booking projection uses cumulative successful transactions for the obligation against obligation amount. `CANCELLATION_PENDING` remains the pre-supplier claim state. After supplier cancellation, an unfulfilled obligation projects `CANCELLED_PENDING_REFUND`; full obligation fulfillment projects `CANCELLED_AND_REFUNDED`, even if Payment remains `PARTIALLY_REFUNDED` because of airline penalties.

**Rationale**: Current webhook logic calculates partial/full Payment state, while inline, cron, and admin paths unconditionally mark Payment refunded. A shared idempotent settlement fixes that drift and preserves the glossary’s state meanings.

**Alternatives considered**:

- Discriminated settlement logic per trigger: rejected because provenance is audit metadata, not business logic.
- Treating `CANCELLED_AND_REFUNDED` as fully refunding the original Payment: rejected because cancellation penalties intentionally separate the two denominators.
- Using `CANCELLATION_PENDING` during partial fulfillment: rejected because that state already means Duffel cancellation has not yet been confirmed.

## R5. Exactly-once ledger linkage

**Decision**: Add a Refund Transaction foreign key to `LedgerEntry` and a database uniqueness rule that permits exactly one debit and one credit entry per successful refund transaction/account/entry type. Settlement idempotency is enforced by transaction state transition plus these database constraints.

**Rationale**: The current free-form `transactionId` does not prevent duplicated reversal pairs under webhook/inline/cron races.

**Alternatives considered**:

- Code-only “already settled” checks: rejected because concurrent transactions can pass the same read.
- One aggregate ledger entry per obligation: rejected because every successful provider transaction must reverse exactly its own amount.

## R6. Booking module ownership and dependency direction

**Decision**: Split the broad BookingService into three modules without a compatibility facade:

- Booking Lifecycle: provider-blind booking state transitions plus an internal provider-aware recovery orchestrator.
- Booking Management: list/detail/read projection, disruption mapping, and sorting.
- Cancellation: eligibility, quote, supplier-first cancellation, recovery coordination, and refund triggering.

Payment and Disruption depend on Booking Lifecycle. The HTTP Booking module composes Management and Cancellation. Cancellation depends on the refund orchestration module, which depends on Refund Settlement. Payment no longer imports the broad Booking module, removing the Payment↔Booking `forwardRef` cycle.

**Rationale**: Current callers already form these three clusters. Keeping provider recovery as a module-internal adapter reconciles the ADR’s provider-blind lifecycle input with the requirement that lifecycle recovery remains cohesive.

**Alternatives considered**:

- Retain a broad BookingService facade: rejected because it preserves the shallow interface and constructor/test coupling.
- Move payment state-machine behavior into Booking Lifecycle: rejected because the module consumes normalized outcomes and must not absorb Stripe/Duffel pipeline orchestration.

## R7. Trusted Search Snapshot authority and migration

**Decision**: Create one Python lifecycle package owning canonical models, Redis persistence, active-load validation, replace/version behavior, selection, and safe projections. Normalize legacy raw-dictionary aliases at one compatibility boundary, then use canonical names internally. Python validates structure, ownership, version, expiry, and selection consistency; cryptographic HMAC verification remains exclusively in NestJS.

Snapshot replacement uses an atomic version-aware Redis operation so a late old response cannot overwrite a newer snapshot. Missing security fields fail closed instead of manufacturing mock identifiers or attestations outside explicit test fixtures.

**Rationale**: Seven current consumers inspect snapshot dictionaries independently. Centralizing lifecycle rules eliminates alias and selection drift without duplicating the NestJS attestation authority.

**Alternatives considered**:

- Copy the attestation secret into Python: rejected because it creates two cryptographic authorities.
- Preserve read-increment-plain-SET replacement: rejected because concurrent searches can regress the stored version.
- Remove all aliases immediately: rejected because incremental migration needs a single tested compatibility edge.

## R8. Chat Turn Runner and typed events

**Decision**: Introduce a `ChatTurnRunner.run(command) -> AsyncIterator[ChatTurnEvent]`. The runner owns session creation, memory/snapshot load, lease/fencing, LangGraph orchestration, output guardrails, persistence, recovery, summarization, and cancellation-safe cleanup. The FastAPI/SSE adapter retains request admission, HTTP error mapping, disconnect detection, typed-event encoding, and runner closure.

Model the eight production event names (`token`, `tool_call`, `tool_result`, `flight_results`, `ACTION_HANDOFF`, `ACTION_REQUIRED`, `done`, `error`) as a strict Pydantic discriminated union. Preserve existing event names, JSON keys, and ordering. Terminal cleanup is causal: persist/close/release first, then yield an error if the connection still exists.

**Rationale**: Current production bypasses the test-only event models, and disconnect/shutdown paths can bypass cleanup. A typed runner creates a deep test surface while keeping direct-only SSE transport unchanged.

**Alternatives considered**:

- A NestJS or Next.js chat proxy: rejected because direct browser→FastAPI SSE is an accepted architecture invariant.
- Keep raw event dictionaries and test the route only: rejected because contracts can drift while model tests remain green.
- Let the adapter release leases or persist partial turns: rejected because cleanup must occur even when no event is deliverable.

## R9. Next.js server seam

**Decision**: Use Next.js 14 Server Components for initial reads and colocated Server Actions for Client Component mutations. Both call server-only domain modules backed by the existing authenticated server transport. Client Components receive serializable typed outcomes and prepared views only. Reads retain the accepted two-retry bounded policy; mutations fail fast and rely on domain idempotency rather than transport retry.

Mark server transport modules as server-only using existing project mechanisms; do not introduce another generic client or expose `NEXT_PUBLIC_API_URL` for NestJS. Next.js 14 supports server-side `fetch` from Server Components and Server Actions, and its composition guidance reserves sensitive backend access for the server: <https://nextjs.org/docs/14/app/building-your-application/data-fetching/fetching-caching-and-revalidating> and <https://nextjs.org/docs/14/app/building-your-application/rendering/composition-patterns>.

**Rationale**: Flight Search and Booking Detail currently pass access tokens into client code and perform browser-to-NestJS fetches. Server Actions retain interactivity without moving business rules into rendering.

**Alternatives considered**:

- New Next.js proxy Route Handlers for ordinary JSON operations: rejected because the accepted frontend ADR reserves domain calls for Server Components/Actions and uses handlers only for deliberate transport exceptions.
- Client-side API wrapper: rejected because it still exposes token, URL, retry, and upstream contracts.

## R10. Agent Gateway capability ownership

**Decision**: Preserve existing endpoint paths, guards, six read-only tool inventory, and response contracts while replacing the catch-all service with capability-local providers: Attested Flight Search, Booking Readiness, Safe Booking Read, and Traveler Preferences. Move chat persistence route ownership to the Chat module while keeping wire compatibility for the Python client. Relocate safe booking projection write ownership with booking lifecycle rather than retaining a circular Agent Gateway dependency.

**Rationale**: Each tool family has distinct dependencies and privacy rules. Endpoint-compatible controller composition allows incremental extraction without an external migration.

**Alternatives considered**:

- Keep AgentGatewayService as a pass-through facade: rejected because deletion would remove almost no complexity and callers/tests would continue to depend on the broad constructor.
- Change tool names or response projections during refactor: rejected because Feature 019 is behavior-preserving at the external boundary.

## R11. Verification and rollout discipline

**Decision**: Begin each slice with characterization/contract tests, implement through vertical TDD, run focused suites after each step, then run cross-service E2E gates before deleting compatibility code. Database changes use expand/backfill/validate/contract. Each slice updates architecture/progress documentation and retains a rollback path.

**Rationale**: This feature changes module boundaries across all three deployables and the transactional payment path, so unit-only verification is insufficient.

**Alternatives considered**:

- Move files first and repair tests afterward: rejected because failures would not distinguish behavior drift from wiring errors.
- Defer all E2E until the final slice: rejected because it prevents independent deployment and rollback.

## R12. Dependencies

**Decision**: Add no runtime dependency. Reuse NestJS, Prisma/PostgreSQL, Zod, Next.js Server Actions, Pydantic, Redis, and existing test runners. Use native PostgreSQL/Prisma transaction facilities and existing Redis scripting patterns.

**Rationale**: All required capabilities already exist, and the constitution requires explicit justification for added complexity.

**Alternatives considered**:

- BullMQ for refund work: rejected by the accepted cancellation ADR.
- TanStack Query for web seams: rejected by the accepted frontend integration ADR.
- A new event or workflow framework: rejected because this is in-process module deepening, not a new distributed architecture.
