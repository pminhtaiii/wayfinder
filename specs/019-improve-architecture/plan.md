# Implementation Plan: Deepen Codebase Architecture

**Branch**: `019-improve-architecture` | **Date**: 2026-08-20 | **Spec**: [spec.md](spec.md)

**Input**: Owner-approved architecture decisions from `docs/adr/0004-architecture-review-deepening.md`, formalized in `specs/019-improve-architecture/spec.md` and using the domain language in `CONTEXT.md`.

## Summary

Deepen six high-leverage module boundaries without changing public product behavior: centralize provider-blind Refund Settlement and introduce one cancellation obligation with many refund transactions; split Booking into Lifecycle, Management, and Cancellation while removing the Payment↔Booking cycle; centralize Trusted Search Snapshot lifecycle; extract a typed Chat Turn Runner from SSE transport; move Flight Search and Web Booking Management behind authenticated server seams; and replace the catch-all Agent Gateway service with capability-local modules.

Delivery is incremental. Each slice begins with behavior characterization, introduces its target interface alongside compatibility code, cuts callers over one cluster at a time, passes focused and cross-service gates, then removes obsolete code. Candidate #9 (Duffel provider capability narrowing) and the optional Traveler Profile/shared-contract redesign are explicitly deferred.

## Technical Context

**Language/Version**: TypeScript 5.4 on Node.js 20+; Python 3.11+

**Primary Dependencies**: NestJS 10, Prisma 5.14, Next.js 14.2.3 App Router, React 18.3, Zod 3.23, FastAPI, Pydantic 2, LangGraph 1.2+, `redis.asyncio`, Stripe 15, Duffel SDK 4.28

**Storage**: PostgreSQL 16 for transactional state and ledger; Redis 7 for trusted snapshots, quotas, and session fencing

**Testing**: Jest 29 and NestJS E2E/Supertest; Node `tsx --test`; pytest/pytest-asyncio; Playwright 1.62; TypeScript typecheck, Next build, ESLint, Ruff

**Target Platform**: Three existing deployables—NestJS API, Next.js web application, and Python FastAPI agent—running on the current Windows/local and Linux/container deployment model

**Project Type**: pnpm monorepo with TypeScript web/API/shared packages plus Python agent service

**Performance Goals**:

- No additional Stripe, Duffel, or LLM calls caused by the refactor.
- Refund reservation and settlement hold database locks only for local persistence work, never across provider calls.
- Preserve current search retry budget, snapshot TTL cap, SSE queue capacity, and user-visible polling cadence.
- Preserve existing endpoint paths and serialized chat event names/keys.

**Constraints**:

- Deterministic booking/payment/refund boundary; no LLM transactional writes.
- Provider-blind settlement and booking transition cores.
- Supplier-first cancellation remains unchanged.
- Strong financial consistency, idempotency, double-entry ledger integrity, and PII-safe audit.
- No JWT, private API URL, retry policy, or internal Duffel/Stripe identity in accepted Client Component scope.
- Direct browser→FastAPI chat SSE remains unchanged.
- No new runtime dependency.
- No long-lived compatibility facade after caller migration.

**Scale/Scope**: Six sequential architecture slices across `apps/api`, `apps/agent`, `apps/web`, and a narrow portion of `packages/shared`; one additive/contract PostgreSQL migration series; existing external APIs remain compatible

## Constitution Check

_GATE: Passed before Phase 0 research and re-checked after Phase 1 design._

| Constitutional requirement             | Design response                                                                                                                                                                                                                   | Gate |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Flight-First Architecture              | Work is confined to flight search, booking, payment/refund, and the existing advisory chat path. No hotel/dining scope or new external provider is introduced.                                                                    | PASS |
| Deterministic Transaction Boundary     | Refund Settlement, Booking Lifecycle, Cancellation, and server seams remain deterministic. Trusted Snapshot and handoff preserve zero LLM writes and NestJS cryptographic authority.                                              | PASS |
| API Budget Discipline                  | No extra Duffel calls are introduced. Snapshot replacement removes races; web reads retain bounded retry and mutations fail fast.                                                                                                 | PASS |
| Observability & Operational Visibility | Every slice includes PII-safe structured metrics/audit for settlement replay, reservation conflicts, snapshot rejection, runner cleanup, server-seam errors, and agent-tool outcomes. Trace/correlation propagation is preserved. | PASS |
| Incremental Delivery                   | Six independently shippable slices use characterize→add→cut over→remove, with focused gates and rollback before the next slice.                                                                                                   | PASS |
| PCI/Data Protection                    | Stripe remains the card-data boundary; ledger/refund writes are audited; browser credentials are reduced; tool/event projections remain allowlisted.                                                                              | PASS |
| Complexity justification               | New modules replace proven catch-all/duplicated responsibilities. No speculative provider abstraction or new framework is added.                                                                                                  | PASS |

Post-design re-check: the data model uses expand/backfill/validate/contract; no destructive first deployment exists. All public/wire behaviors have characterization gates. No constitutional exception is required.

## Project Structure

### Documentation (this feature)

```text
specs/019-improve-architecture/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    ├── refund-settlement.md
    ├── booking-lifecycle.md
    ├── trusted-search-snapshot.md
    ├── chat-turn-events.md
    ├── web-server-seams.md
    └── agent-gateway-capabilities.md
```

### Target source layout

```text
apps/api/
├── prisma/
│   ├── schema.prisma
│   └── migrations/<feature-019-expand-backfill-contract>/
├── src/
│   ├── refund/
│   │   ├── refund.module.ts
│   │   ├── refund-transaction.service.ts
│   │   └── refund-transaction.service.spec.ts
│   ├── refund-settlement/
│   │   ├── refund-settlement.module.ts
│   │   ├── refund-settlement.service.ts
│   │   ├── refund-settlement.service.spec.ts
│   │   └── refund-settlement.types.ts
│   ├── booking-lifecycle/
│   │   ├── booking-lifecycle.module.ts
│   │   ├── booking-lifecycle.service.ts
│   │   ├── booking-lifecycle.service.spec.ts
│   │   ├── booking-recovery.service.ts
│   │   ├── booking-recovery.service.spec.ts
│   │   └── booking-lifecycle.types.ts
│   ├── booking-management/
│   │   ├── booking-management.module.ts
│   │   ├── booking-management.service.ts
│   │   └── booking-management.service.spec.ts
│   ├── cancellation/
│   │   ├── cancellation.module.ts
│   │   ├── cancellation.service.ts
│   │   └── cancellation.service.spec.ts
│   ├── booking/
│   │   ├── booking.module.ts
│   │   ├── booking.controller.ts
│   │   └── booking.controller.spec.ts
│   ├── agent-gateway/
│   │   ├── audit/
│   │   ├── auth/
│   │   ├── attested-flight-search/
│   │   ├── booking-readiness/
│   │   ├── safe-booking-read/
│   │   └── traveler-preferences/
│   └── chat/
│       ├── agent-chat.controller.ts
│       └── agent-chat-access.service.ts
└── test/

apps/agent/
├── src/agent/
│   ├── trusted_search_snapshot/
│   │   ├── __init__.py
│   │   ├── models.py
│   │   ├── repository.py
│   │   └── lifecycle.py
│   ├── chat_turn/
│   │   ├── __init__.py
│   │   ├── models.py
│   │   ├── events.py
│   │   └── runner.py
│   └── streaming/sse.py
└── tests/

apps/web/
├── app/
│   ├── search/actions.ts
│   ├── bookings/[bookingId]/
│   └── api/booking-management/bookings/[bookingId]/
├── components/
│   ├── search/SearchFormClient.tsx
│   └── bookings/
└── lib/server/
    ├── flight-search.ts
    ├── flight-search.spec.ts
    ├── booking-management.ts
    └── booking-management.spec.ts

packages/shared/src/types/
├── flight-search.types.ts
└── booking-management.types.ts
```

**Structure Decision**: Use domain-owned modules inside each existing deployable, not a new service or generic architecture layer. Internal contracts live beside their owning module; only browser/API boundary schemas needed by both sides enter `packages/shared`. Existing endpoint controllers may compose multiple deep modules but may not recreate a broad service facade.

## Implementation Strategy

### Slice 0 — Baseline characterization and safety rails

Purpose: freeze externally observable behavior before moving ownership.

1. Add/strengthen characterization tests for:
   - equivalent refund outcomes through inline, webhook, cron, and admin;
   - current booking pipeline convergence and controller response shapes;
   - snapshot aliases, TTL, selection, and projections;
   - all eight SSE event shapes and ordering;
   - Flight Search and Booking Management UI behavior;
   - Agent Gateway route/status/body compatibility and privacy projections.
2. Record baseline module graph/static checks for the existing `forwardRef`, token props, browser NestJS calls, and broad gateway constructor.
3. Add no production abstraction in this slice.

Exit gate: baseline suites pass and each later slice has a public behavior test that will survive internal movement.

Rollback: tests/documentation only.

### Slice 1 — Refund obligation, transaction reservation, and settlement

#### 1A. Expand schema

Modify `apps/api/prisma/schema.prisma` and add an expand migration:

- Add `CancellationRefundObligation` with unique Booking relation, Payment relation, minor-unit totals, currency, and timestamps.
- Rename Prisma `Refund` concept to `RefundTransaction` while retaining `@@map("refunds")`, or introduce the target relation names without a physical table rename.
- Add nullable `cancellationRefundObligationId` to the existing refund table.
- Add nullable `refundTransactionId` to `LedgerEntry` and database uniqueness for one debit/credit account entry per transaction.
- Retain legacy `Refund.bookingId` and `Booking.cancellationRefund` during expansion.

Add a migration/backfill verifier that:

- creates one obligation for every cancellation-linked legacy refund;
- converts major-unit Booking amounts to minor units explicitly;
- links the transaction and existing ledger entries;
- aborts/quarantines Booking-Payment, currency, amount, or ledger mismatches;
- proves no successful transaction lacks a balanced pair.

#### 1B. Add reservation and settlement modules

Create `apps/api/src/refund/refund-transaction.service.ts`:

- `reserveTransaction()` locks Payment then obligation in a brief interactive transaction;
- sums active plus successful amounts from Refund Transactions;
- validates both remaining capacities;
- creates transaction-scoped idempotency identity and reservation;
- commits before Stripe;
- retries reuse the same transaction/key.

Create `apps/api/src/refund-settlement/refund-settlement.service.ts` with `settleVerifiedOutcome()` from [the settlement contract](contracts/refund-settlement.md):

- load persisted transaction and validate amount/currency;
- claim the terminal transition idempotently;
- write exactly one balanced ledger pair on success;
- recalculate Payment and obligation successful aggregates;
- preserve dispute overlay semantics;
- derive `CANCELLED_PENDING_REFUND`, `CANCELLED_AND_REFUNDED`, or `CANCELLED_NO_REFUND` correctly;
- write PaymentEvent/audit and return the prepared result;
- never call Stripe/Duffel or schedule retry.

#### 1C. Convert trigger paths

Modify:

- `apps/api/src/payment/payment-refund.service.ts`
- `apps/api/src/payment/payment-webhook.service.ts`
- `apps/api/src/payment/payment-cron.service.ts`
- `apps/api/src/payment/admin-refund.controller.ts`
- `apps/api/src/payment/payment.module.ts`

Convert one path at a time: webhook, inline, cron, admin. Each path verifies provider/admin evidence, normalizes the same contract, then calls Settlement. Delete its direct Refund/Payment/Booking/ledger transaction body only after the focused suite passes.

Change cancellation idempotency from Booking-scoped `cancellation-refund:{bookingId}` to a transaction-specific identity; retries keep the same key while genuinely independent portions get distinct keys.

#### 1D. Contract schema

After production code and backfill validation use obligations:

- require obligation linkage for cancellation transactions;
- remove `Refund.bookingId` and `Booking.cancellationRefund`;
- leave physical `refunds` table rename as optional later cleanup;
- retain only required legacy amount fields for rollback/retention, then remove them separately.

Observability:

- settlement applied/no-op/conflict counters by provenance;
- reservation rejected by Payment vs obligation capacity;
- backfill mismatch/quarantine count;
- ledger invariant failure alert;
- no raw provider payload or PII in logs.

Exit gate: the same settlement contract suite passes for all triggers; concurrency E2E proves no over-refund; migration verifier passes; focused payment/cancellation E2E passes.

Rollback: before contract migration, revert callers to legacy fields while keeping additive schema. After contract migration, rollback requires the validated reverse mapping documented in the migration runbook; do not contract until the observation window completes.

### Slice 2 — Booking Lifecycle, Management, and Cancellation

#### 2A. Extract provider-blind lifecycle core

Move lifecycle methods from `apps/api/src/booking/booking.service.ts` into `apps/api/src/booking-lifecycle/booking-lifecycle.service.ts`:

- `createBooking`
- `updateToConfirmed`
- `updateToFailed`
- normalized `applyPipelineOutcome`
- completion persistence and safe agent-projection/audit updates

Move provider-aware stale checks/crons into `booking-recovery.service.ts`, which obtains supplier facts and invokes the lifecycle core. Keep current cron schedules and recovery semantics.

Modify `apps/api/src/payment/payment.service.ts` to inject `BookingLifecycleService` and replace calls at every confirmation/failure/recovery point. Update payment ancillary tests to mock only the narrow lifecycle contract.

Modify `apps/api/src/disruption/sync/reconciliation.service.ts` and its module to depend on Booking Lifecycle for completion.

Relocate safe booking projection write ownership from Agent Gateway into a booking-owned provider if necessary to avoid a new lifecycle↔gateway cycle; preserve the existing projection schema/read contract.

#### 2B. Extract Booking Management

Move list/detail, disruption projection, itinerary mapping, and sorting into `apps/api/src/booking-management/booking-management.service.ts`. Preserve controller DTOs and response bodies.

#### 2C. Extract Cancellation

Move cancellation status, quote, supplier-first cancel, Duffel remote-first recovery, eligibility, and retry coordination into `apps/api/src/cancellation/cancellation.service.ts`. Cancellation creates/continues the obligation and invokes Refund Transaction orchestration; it never performs settlement writes.

#### 2D. Rewire and remove facade

- `booking.controller.ts` injects Management and Cancellation directly.
- `booking.module.ts` becomes HTTP composition only.
- `PaymentModule` imports Booking Lifecycle, never the broad Booking module.
- `DisruptionModule` imports Booking Lifecycle.
- Remove `BookingService`, its export, and Payment↔Booking `forwardRef` only after all callers migrate.

Exit gate: no broad BookingService references in production; no Payment↔Booking `forwardRef`; all payment, booking, cancellation, disruption, and ancillary focused suites plus E2E pass.

Rollback: extraction commits remain behavior-compatible and revert by caller cluster. Do not delete the broad service until the final cluster cutover passes.

### Slice 3 — Trusted Search Snapshot Lifecycle

Create `apps/agent/src/agent/trusted_search_snapshot/` using [the lifecycle contract](contracts/trusted-search-snapshot.md).

1. Move/canonicalize current Pydantic models and repository behind `TrustedSearchSnapshotLifecycle`.
2. Add atomic version-aware Redis replacement; keep key and TTL semantics.
3. Fail closed on missing offer identity, attestation, fingerprint, version, or expiry outside explicit test fixtures.
4. Add one legacy graph-state normalization boundary for `snapshot`/`trusted_snapshot`, `version`/`snapshotVersion`, `attestation`/`selectionAttestation`, and `offers`/`results`.
5. Convert callers sequentially:
   - `tools/search_flights.py` creation and LLM projection;
   - `tools/signal_checkout_intent.py` selection validation;
   - `graph/checkout_gate.py` active/selectable checks;
   - `graph/nodes.py` resolved selection for handoff;
   - the chat runner/SSE path for load and browser projection.
6. Keep old model/repository modules as compatibility re-exports until full agent/handoff/T093 gates pass, then delete them.

Cryptographic HMAC verification and handoff issuance stay in NestJS. The lifecycle validates shape/ownership/expiry/selection only.

Observability: version-regression rejection, invalid/expired snapshot load, replacement latency, projection privacy failures, and Redis control-plane failures using existing safe telemetry.

Exit gate: lifecycle unit/integration suites, handoff node/gate/signal suites, SSE `flight_results`, privacy corpus, and real handoff flow pass.

Rollback: compatibility re-exports and unchanged Redis key/schema allow caller-by-caller rollback until final deletion.

### Slice 4 — Typed Chat Turn Runner

#### 4A. Make event models authoritative

Replace the incomplete test-only event models with `apps/agent/src/agent/chat_turn/events.py`, a strict union for the eight actual wire events. First construct these types inside the existing `sse.py` producer while retaining current serialization. Add golden event-name/key/order tests before moving orchestration.

#### 4B. Extract runner in causal-cleanup order

Create `ChatTurnRunner` and `ChatTurnCommand` under `apps/agent/src/agent/chat_turn/`:

- move session creation, memory/snapshot loading, lease/fencing, LangGraph event interpretation, output guardrails, persistence, recovery, and summarization into the runner;
- isolate `LangGraph.astream_events(version="v2")` parsing inside the runner;
- implement one owned cancellation-safe finalizer that awaits partial persistence/guardrail close/lease release before yielding an error;
- prevent stale fencing owners from persisting or emitting action events;
- preserve current `done`, `ACTION_REQUIRED`, and error ordering.

#### 4C. Thin transport and shutdown

Reduce `streaming/sse.py` to request admission, HTTP error mapping, disconnect detection, runner closure, and typed SSE encoding. Replace raw active queue shutdown mutation in `main.py` with active runner handles that are cancelled and awaited.

Keep pre-stream authentication, ingress validation/PII guardrails, and quota admission at the adapter boundary so HTTP-vs-SSE failure semantics remain unchanged.

Observability: runner start/terminal outcome, cleanup latency/result, lease release, fence loss, disconnect cancellation, event-contract rejection, and leaked-task assertions; no message/PII/token content.

Exit gate: event contract/golden tests, runner success/failure/disconnect/fence/shutdown tests, full agent regression, web direct-stream/handoff tests, and real T093 flow pass.

Rollback: typed models land before movement; route calls the runner behind the same `chat_stream` entry point; old helpers remain until cleanup tests pass.

### Slice 5 — Flight Search and Web Booking Management server seams

#### 5A. Narrow shared contracts

Add and export:

- `packages/shared/src/types/flight-search.types.ts`
- `packages/shared/src/types/booking-management.types.ts`

Pair Zod runtime schemas with inferred types. Include only the provider-free Flight Search view and prepared Booking Management outcomes required by this slice. Do not restructure Traveler Profile or the entire shared package.

#### 5B. Flight Search

Create `apps/web/lib/server/flight-search.ts` with server-only `searchFlights` and `selectFlightOffer` operations. It owns `getServerSession`, private `API_URL`, bearer injection, timeout, read retry, upstream Zod validation, and error normalization.

Create `apps/web/app/search/actions.ts` with module-level `'use server'` and plain serializable action results. Modify:

- `apps/web/app/search/page.tsx`: retain auth gate, remove token prop.
- `apps/web/components/search/SearchFormClient.tsx`: remove local FlightOffer, bearer/API URL/fetch/retry logic; retain form state, typed outcome display, and navigation.
- `.env.example` and Playwright environment: introduce private `API_URL`; allow server-only `API_URL ?? NEXT_PUBLIC_API_URL` during transition, but remove public URL use from accepted rendering files.

Update checkout Playwright fixtures because browser route interception cannot observe server-to-server NestJS fetches. Use existing server/mock-scenario seams; add no production client test hook.

#### 5C. Booking Management

Create `apps/web/lib/server/booking-management.ts` for list/detail/status/quote/cancel/disruption/history operations with session ownership, private URL, no-store, timeout, runtime validation, and typed error mapping.

Modify server pages to use it:

- `apps/web/app/bookings/page.tsx`
- `apps/web/app/bookings/[bookingId]/page.tsx`

Add explicit same-origin Route Handlers under `app/api/booking-management/...` for polling, revision pagination, cancellation quote/confirm, and allowlisted `acknowledge|accept` disruption commands. These handlers contain no business logic and delegate to the server module. Document this as the owner-approved Decision 6 exception to the older route-handler convention.

Modify:

- `BookingDetail.tsx`: remove `useSession`, access token/API URL, direct Nest fetches, raw `any`, and fallback transport logic; retain UI state, 5-second status poll, typed commands, and refresh behavior.
- `ItineraryRevisionHistory.tsx`: remove token prop and use the same-origin typed route.
- related Booking props/tests: use prepared views. Preserve authenticated owner-visible PNR/passenger facts while excluding Duffel order IDs, Stripe IDs, and raw snapshots.

Observability: server-seam operation/outcome/latency, upstream contract violation, 401/403/404/409 mapping, no-store headers, and allowlisted command rejection; never log tokens or prepared-view PII.

Exit gate: shared/server module/handler tests, typecheck, Next build, scoped token/API URL static check, and checkout/bookings/disruptions Playwright pass.

Rollback: NestJS endpoints remain unchanged. Flight and booking sub-slices can be reverted independently until old token-bearing code is deleted; compatibility environment fallback remains server-only during the observation window.

### Slice 6 — Agent Gateway capability-local modules

#### 6A. Shared authentication and safe audit

Extract `agent-gateway/auth/agent-auth.module.ts` to export existing guards/claim service without exporting the broad gateway. Add `agent-gateway/audit/agent-tool-audit.service.ts` that stores only allowlisted tool name, outcome, duration, response size, and sanitized trace/correlation metadata. Remove raw request DTO audit storage.

#### 6B. Extract one capability at a time

Create service/controller pairs, retaining current route paths/status/bodies:

1. `attested-flight-search/`: legacy-compatible and V2 attested search, mapping, attestation, safe audit.
2. `booking-readiness/`: readiness projection and observability.
3. `safe-booking-read/`: two-tier summary/detail projection; temporarily retain the existing broad endpoint only as a compatibility path, not an approved tool.
4. `traveler-preferences/`: allowlisted preference projection.

After each extraction, remove those methods/dependencies from `AgentGatewayService` and run the cluster plus unchanged E2E contracts.

#### 6C. Move chat ownership

Add `chat/agent-chat.controller.ts` and a narrow Chat-owned access service. Preserve existing `/api/agent-gateway/chat/...` wire paths, fencing, encryption, and errors while injecting `ChatService` directly. Import the narrow agent-auth module; do not create Chat↔Gateway service coupling.

#### 6D. Delete broad service

When all controllers use local services and compatibility E2E passes, remove `AgentGatewayService`, collapse its 11-dependency module wiring, and split its unit suite into capability suites. Export only providers with proven external consumers, such as selection attestation or booking projection during their transition.

Track legacy `/users/bookings` removal as a separate authorized deprecation because current code contradicts documentation; Feature 019 does not silently remove it.

Observability: tool outcome/duration/size, auth denial, projection rejection, attestation failure, and privacy corpus results with no raw params/session/offer/PII.

Exit gate: cluster tests, unchanged gateway/chat E2E, static no-broad-service check, full API build/test, and Python tool integration pass.

Rollback: endpoint paths do not change; revert one controller/service cluster at a time until broad service deletion. Delete the broad service only in the final commit of the slice.

## File-by-File Change Index

### API — Refund and booking

| Current/target file                                                                   | Planned change                                                                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/prisma/schema.prisma`                                                       | Add obligation and ledger relations; transition Refund→RefundTransaction model; remove legacy relation only after validation |
| `apps/api/prisma/migrations/*`                                                        | Expand, backfill/validate, and contract migrations with rollback notes                                                       |
| `apps/api/src/payment/payment-refund.service.ts`                                      | Retain provider/retry orchestration during migration; remove all terminal persistence bodies                                 |
| `payment-webhook.service.ts`, `payment-cron.service.ts`, `admin-refund.controller.ts` | Normalize verified outcomes and invoke Settlement                                                                            |
| `apps/api/src/refund/*`                                                               | Transaction reservation/idempotency/provider orchestration boundary                                                          |
| `apps/api/src/refund-settlement/*`                                                    | Provider-blind terminal persistence and aggregate projections                                                                |
| `apps/api/src/booking/booking.service.ts`                                             | Source for extraction; delete after all clusters migrate                                                                     |
| `apps/api/src/booking-lifecycle/*`                                                    | Lifecycle core and recovery adapter                                                                                          |
| `apps/api/src/booking-management/*`                                                   | Read projections                                                                                                             |
| `apps/api/src/cancellation/*`                                                         | Supplier-first cancellation and refund trigger                                                                               |
| `apps/api/src/payment/payment.service.ts`                                             | Depend on normalized Booking Lifecycle contract                                                                              |
| `apps/api/src/payment/payment.module.ts`, `apps/api/src/booking/booking.module.ts`    | Remove mutual forward refs; compose target modules                                                                           |
| `apps/api/src/disruption/sync/reconciliation.service.ts`                              | Depend on Booking Lifecycle only                                                                                             |

### Agent

| Current/target file                                                 | Planned change                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `models/snapshot.py`, `repositories/trusted_snapshot_repository.py` | Compatibility re-exports, then delete after lifecycle migration                                    |
| `trusted_search_snapshot/*`                                         | Canonical model/repository/lifecycle and atomic replacement                                        |
| `tools/search_flights.py`, `signal_checkout_intent.py`              | Delegate creation/projection/selection to lifecycle                                                |
| `graph/checkout_gate.py`, `graph/nodes.py`                          | Consume active snapshot/resolved selection rather than raw dict aliases                            |
| `models/events.py`                                                  | Replace test-only mismatch with compatibility import or delete after authoritative event migration |
| `chat_turn/*`                                                       | Typed event union and durable runner                                                               |
| `streaming/sse.py`                                                  | Thin admission/transport adapter                                                                   |
| `main.py`                                                           | Shutdown active runner handles rather than raw queue mutation                                      |

### Web/shared

| Current/target file                                                | Planned change                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `packages/shared/src/types/flight-search.types.ts`                 | Zod runtime schemas and inferred server-action outcomes           |
| `packages/shared/src/types/booking-management.types.ts`            | Prepared owner view and typed command/read outcomes               |
| `packages/shared/src/types/index.ts`                               | Stable explicit exports for only these vertical contracts         |
| `apps/web/lib/server/flight-search.ts`                             | Server-only authenticated search/selection transport              |
| `apps/web/app/search/actions.ts`                                   | Next 14 serializable Server Actions                               |
| `SearchFormClient.tsx`, search page                                | Remove token/browser transport/local contract                     |
| `apps/web/lib/server/booking-management.ts`                        | Server-only authenticated booking operations                      |
| `app/api/booking-management/**/route.ts`                           | Thin same-origin polling/command handlers                         |
| Booking pages, `BookingDetail.tsx`, `ItineraryRevisionHistory.tsx` | Prepared views and typed same-origin operations; no token/API URL |
| `apps/web/.env.example`, Playwright configs                        | Private `API_URL` and test seam migration                         |

### Agent Gateway

| Current/target file                             | Planned change                                             |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `agent-gateway.service.ts`                      | Shrink per extraction, then delete                         |
| `agent-gateway.controller.ts`                   | Split route ownership while preserving paths               |
| `agent-gateway.module.ts`                       | Compose capability modules; export only proven providers   |
| `agent-gateway/auth/agent-auth.module.ts`       | Narrow reusable guard/claim boundary                       |
| `agent-gateway/audit/*`                         | Allowlisted tool audit                                     |
| four capability directories                     | Tool-local validation, projection, audit, and dependencies |
| `chat/agent-chat.controller.ts`, access service | Own current agent chat persistence routes                  |

## Cross-Slice Test Matrix

| Invariant                                             | Primary tests                                                                                | Final gate                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------- |
| Refund exactly-once and partial aggregates            | settlement unit, reservation concurrency integration, refund/cancellation E2E                | Full API E2E                           |
| Payment/Booking cycle removed with behavior preserved | lifecycle/management/cancellation units, payment/booking/disruption E2E, static import check | API build + full tests                 |
| Snapshot authority/privacy                            | lifecycle, search, signal, gate, handoff, privacy tests                                      | Agent full suite + T093                |
| Runner causal cleanup and wire compatibility          | event golden, runner cancellation/fence/shutdown, SSE integration                            | Agent suite + web direct stream + T093 |
| Browser has no backend credentials/transport          | shared/server/handler tests, scoped static grep, Playwright                                  | Next typecheck/build + Playwright      |
| Gateway capability locality/privacy                   | cluster units, unchanged gateway/chat E2E, privacy corpus                                    | API and Python tool integration        |

See [quickstart.md](quickstart.md) for runnable commands and expected outcomes.

## Documentation and Operational Updates

After each implemented slice—not during this planning-only command—update:

- `context/architecture.md`: new ownership, dependency graph, data flow, and compatibility state.
- `context/code-standards.md`: accepted server-seam/Route Handler rule and new stable module conventions when relevant.
- `context/library-docs.md`: only if an existing library usage pattern changes.
- `context/progress-checker.md`: slice status and verification evidence.
- `CONTEXT.md`: only for newly confirmed domain language; do not redefine settled terms ad hoc.
- relevant ADRs: migration/compatibility notes and any discovered conflict resolution.

Operational runbooks must include migration preflight, mismatch abort conditions, metrics/alerts, observation window, rollback command/commit boundary, and cleanup eligibility.

## Risks and Mitigations

| Risk                                                 | Mitigation                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Partial-refund state names drift                     | Preserve glossary: pre-supplier `CANCELLATION_PENDING`; post-supplier incomplete `CANCELLED_PENDING_REFUND`            |
| Money unit mismatch                                  | Store obligation/transaction amounts in integer minor units; validate Decimal conversion in backfill                   |
| Duplicate ledger reversal                            | Refund Transaction FK plus database uniqueness and idempotent settlement transaction                                   |
| Payment dispute/refund interaction                   | Preserve dispute overlay and add explicit combined-state tests before cutover                                          |
| Schema rollback after contract                       | Observation window and validated reverse mapping; contract migration last                                              |
| Booking cycle reappears through projection ownership | Move projection writes to booking-owned boundary; static module graph test                                             |
| Snapshot stale overwrite/projection race             | Atomic version-aware replace and project the snapshot returned by the completed search, not an unrelated latest reload |
| Python gains duplicate HMAC authority                | Keep cryptographic verification exclusively in NestJS                                                                  |
| Client disconnect skips cleanup                      | Runner-owned awaited cancellation-safe finalizer; adapter never owns cleanup                                           |
| Next.js version drift                                | Follow installed 14.2.3 serialization/synchronous API conventions; do not use v15 Promise props                        |
| Server-side calls break browser interception tests   | Use server seam/mock-scenario fixtures; no production client hooks                                                     |
| Prepared Booking view removes user-required data     | Fixture parity tests preserve owner-facing PNR/passenger fields while excluding internal IDs/raw payloads              |
| Legacy broad gateway endpoint conflicts with docs    | Preserve compatibility during refactor and create a separately authorized deprecation decision                         |
| Raw tool audit leaks identifiers                     | Replace raw params with explicit allowlisted audit projections before module extraction completes                      |

## Complexity Tracking

No constitutional violation is requested. The additional module and migration structure is justified by existing, measured complexity:

| Complexity                                                               | Why needed                                                                                               | Simpler alternative rejected because                                                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Refund obligation plus transaction entities                              | One owed amount can be fulfilled by multiple independent money movements                                 | Booking→many Refund conflates obligation and provider operations                                                   |
| Separate lifecycle/recovery services inside one Booking Lifecycle module | Keeps state transitions provider-blind while retaining cohesive recovery ownership                       | One service either leaks providers into transitions or scatters recovery again                                     |
| Thin web Route Handlers for polling/commands                             | Client polling needs an explicit same-origin HTTP boundary while JWT/backend transport stays server-side | Direct browser→NestJS violates the accepted seam; Server Actions are opaque and unsuitable for stable polling URLs |
| Temporary compatibility re-exports/facade during cutover only            | Enables independently deployable migration                                                               | Immediate deletion creates a big-bang caller migration; permanent facade would preserve the shallow interface      |
