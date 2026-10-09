# Architecture Review — Module Deepening Decisions

> Captured from grilling session on 2026-08-20.
> Source: architecture-review-20260820-expanded.html (8 strong candidates, 1 optional).

---

## Execution Order

Candidates #1 and #4 are independent refactors solving different problems. They share files but do NOT need to be combined into one refactor.

1. **Candidate #1 (Refund Settlement)** — first, surgically clean, no forwardRef
2. **Candidate #4 + #6-Lifecycle (Booking Lifecycle)** — second, breaks the Payment ↔ Booking forwardRef cycle
3. **Candidate #6-Management + #6-Cancellation** — extracted alongside Lifecycle
4. Remaining candidates sequentially

---

## Decision 1 — Refund Settlement Deep Module (Candidate #1)

**Problem**: Identical ledger entry creation (`DEBIT PLATFORM_REVENUE / CREDIT CUSTOMER_RECEIVABLE`) is copy-pasted across 4 locations in `payment-refund.service.ts`. Settlement rules are non-local across four triggers (inline, webhook, cron, admin).

**Decision**: Extract one Refund Settlement deep module. Triggers normalize their outputs before calling Settlement.

**Input shape — composition, not discriminated union:**

- **Common core** (what Settlement consumes): amount, currency, succeeded/failed outcome
- **Provenance** (carried through for audit, does NOT affect settlement logic): Stripe metadata OR admin resolution metadata

**Key principle**: Settlement is provider-blind. It never branches on who triggered it. It receives normalized money facts and does its atomic persistence work. Provenance is metadata for the audit trail only.

**Ownership boundaries:**

| Module            | Owns                                                                               | Must not own                                     |
| ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| Inline trigger    | Stripe request, retry result, normalization to outcome                             | Final database transitions                       |
| Webhook trigger   | Signature and event verification, normalization to outcome                         | Alternative settlement rules                     |
| Cron trigger      | Due claim, Stripe recovery, normalization to outcome                               | Scheduled-only finalization                      |
| Admin trigger     | Authorization, evidence collection, normalization to outcome                       | Direct record mutation                           |
| Refund Settlement | Idempotent atomic persistence (ledger, refund state, payment state, booking state) | Stripe calls, trigger policy, provider awareness |

---

## Decision 2 — Booking Lifecycle Deep Module (Candidates #4 + #6-Lifecycle)

**Problem**: `PaymentService` injects `BookingService` via `forwardRef` (confirmed mutual `PaymentModule ↔ BookingModule` cycle). The reason is `executeConfirmPayment()` (787 lines) calling into BookingService for `PROCESSING → CONFIRMED/FAILED` convergence.

**Decision**: Extract **Booking Lifecycle** module that owns the full booking state machine. Payment pipeline calls _into_ Booking Lifecycle instead of into a broad BookingService.

**Naming**: "Booking Lifecycle" — NOT "Booking Completion". The module owns creation, confirmation, failure, reconciliation, and crons — not just the final step.

**Input from Payment pipeline — normalized outcome:**

- **Success**: confirmed Duffel order reference, captured Stripe payment reference, final amounts
- **Failure**: reason category (`payment_declined`, `order_creation_failed`, `capture_timeout`, `supplier_rejected`, etc.), partial state

**Key principle**: Booking Lifecycle is provider-blind. It receives a normalized payment pipeline outcome and atomically writes the final booking state + agent projection + audit. It does not know how the pipeline ran.

**Methods owned by Booking Lifecycle:**

- `createBooking()` (L189–255)
- `updateToConfirmed()` (L257–289)
- `updateToFailed()` (L291–316)
- `reconcileBookingIfStale()` (L318–457)
- `checkAndCompleteBooking()` (L459–552)
- `handleStaleProcessingBookings()` cron (L142–164)
- `handleCompletedBookings()` cron (L166–187)

**forwardRef resolution**: Payment pipeline → Booking Lifecycle (one-directional). Booking Management and Cancellation never need Payment, so no reverse dependency. Cycle disappears.

---

## Decision 3 — Booking Three-Module Split (Candidate #6)

**Problem**: `booking.service.ts` (1,264 lines) is one wide interface serving three distinct caller clusters with unrelated dependency graphs.

**Decision**: Split into three deep modules sharing booking persistence, no broad facade.

| Module                 | Owns                                                                               | Callers                                                          |
| ---------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Booking Lifecycle**  | Full state machine: creation, PROCESSING → CONFIRMED/FAILED, reconciliation, crons | Payment pipeline, supplier reconciliation, booking recovery cron |
| **Booking Management** | Read projection, listing, detail, disruption mapping, sorting                      | Booking query controller                                         |
| **Cancellation**       | Quote, cancel, supplier-first flow, refund trigger                                 | Cancellation controller                                          |

**Key principle**: The three modules share persistence, not a broad facade. Each caller sees only the interface it uses.

---

## Decision 4 — Trusted Search Snapshot Lifecycle (Candidate #5)

**Problem**: Snapshot aliases, attestation validation, selection, persistence, and safe projections leak across six Python agent modules (`search_flights.py`, `snapshot.py`, `trusted_snapshot_repository.py`, `sse.py`, `checkout_gate.py`, `nodes.py`).

**Decision**: Deepen into one Trusted Search Snapshot lifecycle module.

**Responsibility boundary**: The snapshot module owns resolution from user-selected index to attested offer identity (pure lookup against its own data). It does NOT own handoff token creation or the NestJS call. It returns a resolved offer selection; the handoff pipeline consumes it.

**Lifecycle operations owned:**

- Create (from search tool results)
- Validate (attestation verification)
- Replace (new search supersedes old snapshot)
- Persist (Redis with TTL bounded by offer freshness)
- Select (index → attested offer resolution)
- Safe projection (identifier-free display data for LLM)

**Must not own**: Handoff token generation, NestJS handoff service calls, booking intent creation.

---

## Decision 5 — Chat Turn Runner Deep Module (Candidate #2)

**Problem**: `sse.py` (789 lines) has `chat_stream` at 707 lines and `producer` at ~475 lines. One function owns JWT validation, PII guardrails, quota, session lease, memory/snapshot loading, LangGraph orchestration, 23 event shapes, persistence, recovery, and cleanup.

**Decision**: Split into a thin HTTP/SSE adapter and a deep Chat Turn Runner module.

**Ownership invariant**: The adapter owns connection lifecycle. The runner owns turn lifecycle. These are independent.

**Runner responsibilities:**

- Turn ordering and fencing
- LangGraph orchestration
- Output guardrail pipeline
- Encrypted persistence of conversation turns
- Session lease acquisition and release
- Failure recovery and partial-turn persistence
- Yields typed events through an async iterator (including terminal error events)

**Adapter responsibilities:**

- SSE encoding of typed events from the runner's async iterator
- Transport disconnect detection
- Cancelling/closing the runner on client disconnect
- Never implements domain cleanup

**Critical ordering on failure:**

1. Runner detects failure
2. Runner performs durable cleanup FIRST (persist partial turn, release lease, finalize guardrails) — in a cancellation-safe `finally`-equivalent block
3. Runner emits terminal error event AFTER cleanup is complete
4. Adapter encodes and delivers the error event to the client (if still connected)

**Key principle**: Cleanup is causal, not event-driven. Error events communicate the outcome but are not what makes cleanup happen. If the client disconnects before receiving the error event, cleanup has already completed. The runner guarantees lease/resource cleanup through cancellation-safe finalization because a client disconnect may terminate the stream before an error event can be delivered.

---

## Decision 6 — Unified Server Seam Rule (Candidates #3, #7, #8)

**Problem**: Flight Search rendering (`SearchFormClient.tsx`, 310 lines) and Web Booking Management rendering (`BookingDetail.tsx`, 528 lines) both leak JWT tokens, NestJS URLs, retry policies, and transport details into rendering components — contradicting the accepted frontend integration ADR. Agent Gateway (`agent-gateway.service.ts`, 1,285 lines, 11 dependencies) is a catch-all that combines unrelated tool concerns.

**Decision**: One seam rule, applied everywhere. No exceptions.

**The rule**: Rendering components never receive JWTs, NestJS URLs, or retry policies. All server communication goes through server actions or route handlers that return typed outcomes.

**Application to each candidate:**

### Candidate #3 — Flight Search Server Seam

- Search rendering consumes typed outcomes (success with flight results, or failure with reason)
- Server action owns JWT, fetch, retry policy, normalization, and offer selection
- Shared flight contract lives in one place, not duplicated locally
- Restores the frontend integration ADR that the current code contradicts

### Candidate #7 — Agent Gateway Tool-Local Modules

- Break the 11-dependency catch-all into tool-local deep modules:
  - **Attested Flight Search** — search + attestation
  - **Booking Readiness** — readiness evaluation
  - **Safe Booking Read** — privacy-projected booking data
  - **Traveler Preferences** — preference access
- Chat persistence routes leave Agent Gateway and move to the Chat module owner
- Each module owns its own privacy projection; constructor fan-out shrinks
- Keep the fixed six read-only tools, two-tier booking exposure, and structural PII seam unchanged

### Candidate #8 — Web Booking Management Server Seam

- Booking detail rendering consumes a prepared booking view and typed commands
- Server module owns cancellation, disruption, refresh, status polling, authentication, and error semantics
- Rendering never receives JWT or NestJS URL
- Restores the frontend integration ADR that the current code contradicts

---

## Candidate #9 — Narrow the Duffel Provider Interface (Deferred)

Marked as "Worth exploring" in the review. Not grilled in this session. The principle (capability-local depth behind one shared adapter) is consistent with the other decisions, but this is lower priority and can be addressed later.

---

## Session Summary

All 8 strong candidates from the architecture review have been resolved:

| #   | Candidate                   | Decision Pattern                  | Key Principle                                       |
| --- | --------------------------- | --------------------------------- | --------------------------------------------------- |
| 1   | Refund Settlement           | Deep module, normalized input     | Provider-blind settlement; composition over union   |
| 2   | Chat Turn Runner            | Adapter/runner split              | Adapter owns connection; runner owns turn lifecycle |
| 3   | Flight Search Seam          | Unified seam rule                 | Rendering never sees JWT/transport                  |
| 4   | Payment ↔ Booking Cycle     | Merged into Booking Lifecycle     | Normalized payment outcome as input                 |
| 5   | Trusted Search Snapshot     | Deep lifecycle module             | Owns index→offer resolution, not handoff            |
| 6   | Split Booking by 3 Clusters | Three modules sharing persistence | No broad facade                                     |
| 7   | Agent Gateway               | Tool-local deep modules           | Each tool owns its privacy projection               |
| 8   | Web Booking Management      | Unified seam rule                 | Typed commands and prepared views                   |

**Recommended execution order:**

1. Refund Settlement (clean, no forwardRef, existing test suites)
2. Booking Lifecycle + Management + Cancellation split (breaks forwardRef cycle)
3. Trusted Search Snapshot lifecycle (consolidates agent integrity chain)
4. Chat Turn Runner (adapter/runner split)
5. Flight Search + Web Booking Management seams (applying the unified seam rule)
6. Agent Gateway tool-local modules
