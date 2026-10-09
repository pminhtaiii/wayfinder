# Implementation Plan: Disruption & Flight-Change Management

**Branch**: `014a-disruption-grilling-decisions` | **Date**: 2026-07-24 | **Spec**: [spec.md](./spec.md)

**Input**: [PRD](./PRD.md), [feature specification](./spec.md), [domain glossary](../../CONTEXT.md), and [Feature 14 grilling ADR](../../docs/adr/0021-disruption-flight-change.md)

## Summary

Implement deterministic, supplier-authoritative flight disruption management for confirmed Duffel bookings. Signed webhooks are durably fast-acked into a transactional inbox; a 30-minute, budget-aware reconciliation job backs them up. Both use one idempotent synchronization command with owned CAS leases, canonical itinerary fingerprints, confidence-based one-to-one segment matching, immutable normalized revisions, incremental and cumulative materiality, revision-scoped traveller actions, an atomic notification outbox, cancellation-safe convergence, and operations tooling.

The plan also corrects two repository realities that the earlier design did not capture: round trips cannot become completed after the first outbound departure, and the clean working tree lacks the booking/admin/Playwright frontend marked complete in project documentation. The delivery sequence therefore restores the minimum protected booking UI/test foundation before adding Feature 14 presentation.

## Technical Context

| Area                  | Decision                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Language/runtime      | Node.js 20+, TypeScript 5.4                                                                                  |
| Backend               | NestJS 10, global `/api` prefix, raw-body capture already enabled                                            |
| Frontend              | Next.js 14.2.3 App Router, React 18; Server Components for initial protected reads                           |
| Storage               | PostgreSQL through Prisma; schema is additive to current Feature 12 model                                    |
| Scheduling            | Existing `@nestjs/schedule`; database leases make jobs multi-instance safe                                   |
| Supplier              | Installed `@duffel/api`; full order retrieval is authoritative; custom raw HMAC verifier for webhook edge    |
| Shared contracts      | `packages/shared` remains the DTO/type source of truth                                                       |
| Tests                 | Jest unit/API E2E with Supertest, Playwright 1.41.2 after configuration restoration                          |
| Webhook target        | Durable ACK p95 <500 ms; no Duffel request in receiver                                                       |
| Processing target     | Webhook-triggered material revision visible p95 <2 minutes                                                   |
| Reconciliation target | Eligible missed changes caught within 35 minutes when budget available                                       |
| Read target           | Booking detail/history local-only, zero supplier calls, p95 <200 ms under existing load profile              |
| Batch/scale           | Inbox and reconciliation batches of 20; no new queue service                                                 |
| Concurrency           | Owned five-minute Booking sync lease + inbox lease + unique `(bookingId, version)` fallback                  |
| Security              | HMAC raw bytes/replay tolerance, JWT ownership, ADMIN RBAC, PII-safe logs/DTOs, 30-day raw payload retention |
| Rollout               | Separate ingestion, processor, reconciliation, customer-surfacing, and outbox flags                          |

No `NEEDS CLARIFICATION` items remain. Defaults not fixed by the ADR are resolved in [research.md](./research.md), including fallback match tolerance, retry schedule, UTC throttle boundary, retention, and frontend update behavior.

## Constitution Check — Pre-Design Gate

- **Flight-first architecture — PASS:** supplier synchronization and disruption handling directly improve the booked-flight lifecycle. No hotel, activity, or unrelated product work enters the path.
- **Deterministic transaction boundary — PASS:** Duffel fetch, matching, classification, state transitions, outbox intent, cancellation interaction, and traveller/admin actions contain no AI/LLM decision.
- **API budget discipline — PASS WITH REQUIRED CONTROLS:** webhook-triggered reads have a user-facing purpose; reconciliation is capped, prioritized, deduplicated, feature-flagged, and budget-aware. The implementation must integrate existing 50/75/90% supplier-budget alerts.
- **Observability and operational visibility — PASS WITH REQUIRED DELIVERABLES:** structured PII-safe logs, trace/correlation propagation, metrics, heartbeat/health, dashboard, alerts, admin queues, and runbook are planned before enablement.
- **Incremental delivery — PASS:** each phase/PR leaves the application deployable; execution remains disabled until prerequisites and verification are satisfied.
- **Security requirements — PASS:** raw signature verification, no PII/card logging, server-side ownership/RBAC, audit actions, safe retention, and input validation are explicit.

Gate result: proceed. No constitutional waiver is required.

## Project Structure

### Feature documentation

```text
specs/014-disruption-flight-change-management/
├── PRD.md
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    ├── api.md
    └── ui.md
```

### Planned source layout

```text
apps/api/
├── prisma/
│   ├── schema.prisma
│   └── migrations/<feature-14-migration>/
├── src/
│   ├── disruption/
│   │   ├── disruption.module.ts
│   │   ├── domain/
│   │   │   ├── itinerary-normalizer.ts
│   │   │   ├── itinerary-fingerprint.ts
│   │   │   ├── segment-matcher.ts
│   │   │   ├── itinerary-diff.ts
│   │   │   └── materiality-classifier.ts
│   │   ├── sync/
│   │   │   ├── supplier-sync.service.ts
│   │   │   ├── sync-claim.service.ts
│   │   │   └── reconciliation.service.ts
│   │   ├── webhook/
│   │   │   ├── duffel-webhook.controller.ts
│   │   │   ├── duffel-signature.service.ts
│   │   │   ├── duffel-inbox.service.ts
│   │   │   └── duffel-event.processor.ts
│   │   ├── api/
│   │   │   ├── disruption.controller.ts
│   │   │   ├── admin-disruption.controller.ts
│   │   │   └── dto/
│   │   └── observability/
│   │       └── disruption-telemetry.service.ts
│   ├── booking/
│   │   ├── booking.service.ts
│   │   └── dto/booking-response.dto.ts
│   ├── duffel/duffel.service.ts
│   └── app.module.ts
└── test/
    └── disruption.e2e-spec.ts

packages/shared/src/
├── booking-types.ts
└── disruption-types.ts

apps/web/
├── app/
│   ├── bookings/
│   │   ├── page.tsx
│   │   └── [bookingId]/page.tsx
│   └── admin/disruptions/page.tsx
├── components/bookings/
│   ├── BookingDetail.tsx
│   ├── DisruptionAlert.tsx
│   ├── ItineraryChangeSummary.tsx
│   └── ItineraryRevisionTimeline.tsx
├── components/admin/disruptions/
├── lib/api-client.ts
├── types/next-auth.d.ts
└── tests/
    ├── playwright.config.ts
    └── disruptions.spec.ts
```

**Structure decision:** keep all disruption orchestration in one Nest domain module while pure normalization/matching/classification remains framework-independent. Booking owns booking lifecycle/read integration; Duffel owns the supplier adapter; shared owns cross-app DTOs. The web restores and then extends the protected booking surface instead of introducing a Next.js BFF or frontend business rules.

## Dependency and delivery map

```text
Phase 0 baseline gate
  └─ Phase 1 contracts/schema
      ├─ Phase 2 deterministic domain core
      │   └─ Phase 3 synchronization transaction
      │       ├─ Phase 4 webhook inbox/processor
      │       └─ Phase 5 reconciliation/completion
      └─ Phase 6 traveller APIs/cancellation integration
          └─ Phase 7 traveller frontend

Phases 4–7
  └─ Phase 8 operations/observability/rollout
      └─ Phase 9 end-to-end verification and docs
```

Customer surfacing stays disabled until Phases 1–6 pass bootstrap/current-itinerary verification. Outbox creation stays disabled until operations/alerting is ready.

## Phase 0 / PR 1 — Baseline reconciliation and protected frontend foundation

**Goal:** make the plan executable against the actual clean tree and establish one protected web data seam.

### Work

1. Record the current documentation/filesystem mismatch in the PR and do not silently mark prior feature status incomplete without owner review.
2. Verify current booking/cancellation backend E2E behavior and current Prisma schema as the migration baseline.
3. Check the installed Next.js 14.2.3 package documentation/types before writing App Router code, per repository instructions. If the packaged docs remain absent, use the installed type declarations and existing project conventions; do not assume newer breaking APIs.
4. Restore the minimum authenticated `/bookings` and `/bookings/[bookingId]` pages and components required to render the existing booking API, or recover the exact prior implementation if it exists in reachable repository history. Preserve current API ownership behavior.
5. Add a typed server-only Nest API client using `getServerSession(authOptions)`, bearer token forwarding, explicit `no-store`, and typed 401/403/404 handling. Add NextAuth session augmentation for access token, user ID, and role resolution where needed.
6. Restore `apps/web/tests/playwright.config.ts`, fixtures/setup, and a baseline protected booking detail/list smoke test. Do not add Feature 14 assertions until the baseline passes.
7. Establish semantic UI tokens (critical/warning/neutral/success/focus/surface) without hardcoded hex or raw Tailwind color utilities. Follow the repository’s current CSS strategy consistently.

### Tests

- Existing booking API E2E remains green.
- Protected page redirects unauthenticated users, displays owner booking, and leaks nothing for other-owner/missing IDs.
- Baseline Playwright config executes at least one real test.
- Typecheck proves NextAuth session fields without unsafe repeated casts.

### Exit criteria

- The booking detail/list foundation and Playwright runner exist in the tree and pass.
- Feature 14 UI has a single defined server-read/mutation-refresh seam.
- If the foundation cannot be restored after one corrective attempt, stop per project failure policy and ask the owner whether to split restoration into a prerequisite feature.

## Phase 1 / PR 2 — Contracts, additive schema, migration, and shared types

**Goal:** establish durable invariants before any worker or customer behavior is enabled.

### Work

1. Extend Prisma exactly as [data-model.md](./data-model.md): Booking disruption/sync/current timing fields; revisions/segments; webhook inbox; notification outbox; audit events; enums; named circular relations; indexes.
2. Add the `duffelOrderId` data-quality migration/report. Do not add uniqueness until duplicates are detected/resolved. Backfill current/next/final timing only from valid original snapshots.
3. Extend `FlightSegmentSnapshot` compatibly with optional Duffel segment/slice/order metadata. Add shared current-itinerary, disruption summary/history, lifecycle command, and admin DTOs.
4. Update `mapDuffelOrderToSnapshots` to retain supplier segment IDs for newly confirmed bookings without changing existing stored JSON.
5. Add a separately named typed Duffel method returning the complete order for synchronization. Do not broaden the existing cancellation-oriented `retrieveOrder()` return contract.
6. Add environment validation and documented flags/secrets with no values committed.
7. Generate Prisma through locked pnpm workspace tooling and review migration SQL for production-safe indexes/constraints.

### Tests

- Migration applies to a Feature 12-shaped database with legacy JSON and rolls forward without rewriting original snapshots.
- Prisma relation/unique/index tests cover active revision, revision version, event ID, and one outbox per revision.
- Shared package builds and API/web compile against DTOs.
- Mapper contract fixture proves new segment IDs and legacy optionality.

### Exit criteria

- Additive migration/client generation succeeds.
- All feature flags default off.
- Current application reads remain backward compatible.

## Phase 2 / PR 3 — Pure itinerary normalization, matching, diff, and classification

**Goal:** make supplier changes deterministic and exhaustively testable without framework/database concerns.

### Work

1. Build typed normalization from Duffel order to ordered slices/segments with source offsets/local dates and canonical fields.
2. Implement versioned canonical serialization/fingerprint. Exclude volatile supplier fields; include every field whose change should produce a revision.
3. Implement one-to-one matcher tiers and ambiguity behavior from research. Track consumed candidates and persist method/confidence in diff output.
4. Produce structured segment changes and aggregate itinerary patterns for previous→current and original→current.
5. Implement `disruption-v1` classifier:
   - segment added/removed;
   - origin/destination airport changes;
   - local date changes;
   - strict >60-minute earlier and >120-minute later departure/final-arrival shifts;
   - newly introduced overnight connection;
   - same-slice connection <60 minutes or invalid overlap.
6. Mark material if either baseline triggers; return deduplicated reasons and baseline provenance.
7. Define safe presentation summaries separately from diagnostic diff data so APIs never expose raw supplier content.

### Tests

- Table-driven tests for every tier, one-to-one consumption, duplicate flight candidates, unmatched ambiguity, insert/remove/reroute, and legacy no-ID baseline.
- Property tests for deterministic fingerprint/diff under repeated input and no many-to-one match.
- Exact time boundaries, UTC offsets, DST/local rollover, overnight, negative/overlap, MCT, multi-slice outbound/return isolation, and final-arrival per slice.
- Two 40-minute earlier moves: first minor, second material cumulatively.
- A→B→A produces a new changed fingerprint event chronologically.

### Exit criteria

- Pure core has no Nest/Prisma/Duffel SDK dependency.
- Golden redacted supplier fixtures produce stable, reviewed results.

## Phase 3 / PR 4 — Supplier synchronization transaction and concurrency

**Goal:** turn a fresh supplier order into one canonical durable result under concurrency, crashes, and cancellation races.

### Work

1. Implement owned Booking sync claim: eligible status/order prerequisites, null/stale lease, random token, five-minute lease, upstream timeout shorter than lease.
2. Fetch full order outside a DB transaction and normalize/fingerprint it.
3. Compare with latest revision or original. For unchanged input, conditionally update coverage/current timing and release only the owned token.
4. In a short Prisma transaction:
   - re-read booking status, lock token, latest revision, and cancellation state;
   - abort cleanly if no longer eligible;
   - handle same-fingerprint convergence or allocate version;
   - create revision and normalized segments;
   - compute/persist both diffs, classifier result, reasons/baselines/ruleset;
   - update current/next/final timing;
   - transition active disruption for material change;
   - apply atomic UTC throttle and outbox/attention decision under policy flags;
   - write audit event, coverage, and conditional lock release.
5. On unique version collision, re-read: converge only on same fingerprint, otherwise retry the short transaction.
6. On fetch/write failure, conditionally release the owned lock, retain stale coverage, set fair next-sync backoff for reconciliation, and emit safe telemetry.
7. Detect supplier-cancelled orders. If cancellation is platform-confirmed, converge to cancellation resolution without disruption notification; unexpected airline cancellation becomes a material reason only while the booking is still eligible under defined state rules.

### Tests

- Real test database + Duffel adapter stub for unchanged, minor, material, cumulative, and legacy baselines.
- Transaction rollback proves no partial revision/status/outbox/audit.
- Parallel triggers yield one version/outbox.
- Expired worker cannot clear successor token.
- Unique collision with same fingerprint converges; different fingerprint retries.
- Cancellation wins after fetch but before final transaction.
- Outbox counts 1/2/3/4 and UTC boundary are atomic.

### Exit criteria

- One command returns `NO_CHANGE`, `REVISION_CREATED`, `SKIPPED_INELIGIBLE`, or `CONVERGED_DUPLICATE` deterministically.
- No external call occurs inside a database transaction.

## Phase 4 / PR 5 — Signed webhook receiver, durable inbox, and processor

**Goal:** make at-least-once unordered supplier delivery reliable without slowing the public endpoint.

### Work

1. Implement isolated Duffel signature verifier using raw bytes, `X-Duffel-Signature`, secret validation/rotation strategy, constant-time comparison, and replay tolerance.
2. Add public `POST /api/duffel/webhook` with no JWT, minimal envelope validation, durable insert, duplicate convergence, unsupported `SKIPPED`, and fast 200.
3. Ensure database outage returns a retryable non-2xx; invalid signature/payload never creates a processable row.
4. Implement inbox batch selection and tokenized lease claim across multiple instances.
5. Process rows independently through SupplierSyncService; one bad event cannot stop the batch.
6. Implement the exact 1/5/15/15-minute schedule, fifth-failure escalation, safe terminal error classification, stale PROCESSING recovery, and processed/skip timestamps.
7. Add 30-day raw payload redaction cleanup and ensure raw payload never enters application logs/traces.
8. Add ingress/processor flags and heartbeat health.

### Tests

- Unit signature fixtures use exact raw bytes and reject content-equivalent reserialization, malformed header, stale timestamp, wrong secret, and timing-safe mismatch path.
- Controller/API tests assert insert-before-ack, no Duffel call, duplicate 200, unsupported skip, and DB failure non-2xx.
- Processor tests assert lease races, crashed claim recovery, deterministic retries/escalation, independent batch progress, and retention cleanup.
- Ack latency measured in an integration benchmark/profile.

### Exit criteria

- Valid webhook receiver meets <500 ms p95 target locally/CI profile.
- Processor can be canary-enabled independently of ingestion.

## Phase 5 / PR 6 — Budget-aware reconciliation and correct completion lifecycle

**Goal:** catch missed events without starving critical Duffel traffic or losing return-leg coverage.

### Work

1. Add 30-minute handler with explicit public method for direct tests; decorator is only a trigger.
2. Query only synchronizable confirmed bookings with next unflown departure in `(now, now+72h]`, non-null order ID, due backoff, and no active non-stale lock.
3. Select at most 20 using stable ordering: null/oldest successful sync, next departure, booking ID. Use keyset/cursor progression and failure backoff so a permanent failure cannot monopolize the first page.
4. Check existing Duffel budget/rate controls before each claim; record budget-deferred counts; yield to critical search/booking traffic.
5. Call the shared synchronization command with source `RECONCILIATION`; never update successful coverage on failure.
6. Replace first-departure completion semantics with current final-arrival/next-unflown semantics. Resolve active disruptions with `DEPARTURE_PASSED` atomically when final itinerary travel passes.
7. Add reconciliation flag, backlog/coverage metrics, near-departure staleness alert, and multi-instance overlap tests.

### Tests

- Exact 72-hour boundaries, statuses, missing prerequisites, return-after-outbound, batch 20, ordering/tie-break, and failure fairness.
- Budget denial produces zero supplier call and retains eligibility.
- Two scheduler instances converge through claims.
- Completion waits until current final arrival and auto-resolves active state once.

### Exit criteria

- Missed-event SLO is demonstrable with budget available.
- Reconciliation can be disabled without losing inbox/revision data.

## Phase 6 / PR 7 — Traveller APIs, local read model, and cancellation integration

**Goal:** expose safe current state and revision-scoped actions while preserving existing cancellation guarantees.

### Work

1. Extend booking detail/list mapping with current itinerary and compact disruption summary from local data only. Keep original snapshot semantics explicit.
2. Add SQL-paginated newest-first history endpoint with safe presentation diff/segments.
3. Add acknowledge and accept endpoints with UUID validation, owner lookup through booking, active revision CAS, same-revision idempotency, and stale 409 canonical state.
4. Write audit events for all lifecycle actions with trace/correlation and actor metadata.
5. Add supplier-confirmed cancellation disruption resolution to the existing conditional transition to `CANCELLED_PENDING_REFUND`; derive traveller/system actor from command/recovery context.
6. Audit every other cancellation terminal/recovery path to ensure none reopens disruption or misses required resolution.
7. Ensure list/detail/status reads never invoke the new supplier sync reactively.
8. Add customer-surfacing flag: backend may ingest revisions while hiding customer disruption fields during bootstrap/canary.

### Tests

- Existing ownership 403/missing 404 contract plus revision-under-booking validation.
- Detected→acknowledged→accepted, direct detected→accepted, same-command retry, resolved retry, stale conflict/new revision reset.
- Non-material revision leaves active material state.
- Detail chooses newest revision/current timing and makes zero supplier calls.
- Cancellation auto-resolution is atomic and refund recovery cannot reopen state.

### Exit criteria

- Traveller API contract in [contracts/api.md](./contracts/api.md) passes E2E.
- Existing booking/cancellation/payment tests remain green.

## Phase 7 / PR 8 — Traveller booking disruption experience

**Goal:** let travellers understand and act on the supplier-authoritative change accessibly.

### Work

1. Extend restored protected booking detail Server Component to fetch uncached canonical booking/disruption data.
2. Render current itinerary as primary and original/cumulative comparison as secondary. Never label original snapshot as current after a revision exists.
3. Add discrete detected/acknowledged/resolved presentation, plain-language material reasons, immediate versus cumulative sections, and paginated history.
4. Add narrowly scoped client actions for acknowledge/accept with pending/duplicate protection. On success refresh server state; on stale 409 announce newer change and refresh without applying old action.
5. Keep existing cancellation UI/action independent and visible. Refresh after cancellation to show `BOOKING_CANCELLED` resolution.
6. Add compact booking-list badge for `DETECTED`/`ACKNOWLEDGED`.
7. Implement UI contract accessibility: semantic alert/status, non-color cues, keyboard/focus, reduced motion, 375 px stacking, semantic tokens, no hardcoded hex/raw Tailwind color classes.
8. Do not add frontend materiality logic, Duffel calls, SSE, or a Next.js BFF route.

### Tests

- Component/accessibility tests where existing harness supports them.
- Playwright journeys for current/original diff, acknowledgement, acceptance, stale revision, new revision reset, minor history, cancellation coexistence, cross-user protection, and mobile/keyboard behavior.
- Assert no supplier request is generated by page read or accept action.

### Exit criteria

- A traveller can complete the P1 review/action journey on desktop and 375 px viewport.
- Backend remains the sole classifier/authorization source.

## Phase 8 / PR 9 — Admin operations, observability, retention, and rollout controls

**Goal:** make every persistent failure or suppression diagnosable and actionable before broad enablement.

### Work

1. Add ADMIN-only SQL-paginated endpoints and web surface for active/aged disruptions, attention flags, failed inbox events, and data-quality gaps.
2. Add audited failed-event retry, active-revision manual resolve with required safe note, and separate attention clear command.
3. Keep backend RBAC authoritative; resolve admin role server-side rather than trusting client state.
4. Instrument structured events for webhook receive/duplicate/reject, inbox claim/retry/escalation, Duffel fetch, lock contention/takeover, fingerprint no-change, revision/material reasons, lifecycle transition, outbox write/suppress, reconciliation result/budget defer, and admin action.
5. Add metrics/dashboard panels:
   - webhook rate/invalid/duplicate/ack latency;
   - inbox depth/oldest/retries/dead letters/processor heartbeat;
   - sync latency/results/Duffel calls/locks;
   - reconciliation selected/processed/backlog/coverage/budget;
   - revisions/reasons/outbox suppressions/active age/attention cases.
6. Add alerts for terminal event, oldest pending SLO, absent processor/cron heartbeat, near-departure stale sync, elevated Duffel error/rate/budget thresholds, stuck locks, and rising suppression/manual attention.
7. Implement raw-payload retention cleanup and test no raw/PII leakage in logs/DTOs.
8. Write rollout/rollback runbook and bootstrap report workflow. Enable in the staged order from quickstart; outbox last.

### Tests

- Regular user denied all admin APIs/pages; ADMIN can filter, retry, resolve, and clear with audit attribution.
- Safe-note validation and stale active revision conflict.
- Log/API leakage tests with payload/passenger fixtures.
- Metrics/heartbeat emitted on success, no-change, retry, terminal, suppression, and budget-defer paths.
- Retention redacts due raw payload and preserves operational metadata.

### Exit criteria

- 100% of terminal events, attention flags, and data gaps are visible to operations.
- Required dashboards/alerts/runbook exist before customer/outbox enablement.

## Phase 9 / PR 10 — End-to-end resilience verification and documentation sync

**Goal:** prove normal, duplicate, concurrent, crash, race, and rollback behavior across the real seams.

### Work

1. Complete `apps/api/test/disruption.e2e-spec.ts` using real test DB, stopped schedulers, direct public handler invocation, signed raw fixtures, and mocked authoritative Duffel adapter.
2. Complete Playwright disruption journeys against seeded database/API states.
3. Run migration verification against current Feature 12 data, not only empty schema.
4. Run shared/API/web builds, typecheck, lint, focused unit tests, full backend E2E, and Playwright suites.
5. Execute controlled chaos checkpoints: crash after inbox claim, fetch before final transaction, unique collision, cancellation race, and worker restart with queued events.
6. Measure webhook/read/processing SLOs and document environment/result.
7. Perform feature-flag rollout and rollback rehearsal without deleting queued/revision data.
8. Update `context/architecture.md` with inbox/sync/outbox/current-itinerary/admin flows, correct stale Amadeus references in touched sections, and document round-trip completion.
9. Update `context/progress-checker.md` only to the level actually completed; do not mark Feature 14 complete before every phase/verification passes.
10. Update `CONTEXT.md` only if implementation changes approved domain vocabulary or resolved rules; preserve the ADR as the decision history.

### Final verification matrix

| Invariant                                               | Proof                            |
| ------------------------------------------------------- | -------------------------------- |
| Valid webhook persisted before ACK, no Duffel call      | HTTP E2E + latency measurement   |
| Duplicate/concurrent input creates one revision/outbox  | DB-backed concurrency E2E        |
| Incremental and cumulative materiality exact            | golden/property tests + E2E      |
| Current itinerary shown, original preserved             | API E2E + Playwright             |
| Stale traveller/admin action cannot affect new revision | REST E2E + Playwright            |
| Cancellation wins and resolves atomically               | cancellation/disruption race E2E |
| Return leg remains monitored                            | reconciliation/completion E2E    |
| Retry/escalation/retention operational                  | processor/admin E2E              |
| No PII/raw payload leakage                              | structured log/API leakage tests |
| Safe enable/disable/rollback                            | runbook rehearsal                |

### Exit criteria

- Every success criterion in [spec.md](./spec.md) has passing evidence.
- All existing suites remain green.
- Context documentation matches actual code and files.
- CodeRabbit review/convergence is completed when the implementation is published as PRs, per repository instructions.

## Test seam strategy

The highest stable seams are deliberately limited:

1. **Duffel webhook HTTP endpoint** for external authenticity/durability/ack behavior.
2. **Supplier synchronization command + real test database + supplier adapter stub** for core truth/concurrency.
3. **Traveller/admin REST endpoints** for ownership, RBAC, lifecycle, and safe read contracts.
4. **Reconciliation public handler** for scheduling selection/budget/fairness without waiting for clocks.
5. **Playwright user/admin journeys** for rendered behavior.

Pure matcher/classifier tests support seam 2 but do not replace end-to-end durable assertions. Avoid tests coupled to private method call order when the same invariant is observable through these seams.

## Rollout plan

1. Deploy migration, shared types, read compatibility, and flags off.
2. Resolve `duffelOrderId`/snapshot data-quality issues and validate timing backfill.
3. Configure test/live webhook secrets and register the supported event endpoint.
4. Enable ingestion only; observe signature/ack/inbox metrics.
5. Enable processor for canary bookings/events with customer/outbox disabled.
6. Run bootstrap report/sync; review matcher/materiality outcomes and legacy exclusions.
7. Enable reconciliation under a small budget and validate coverage/fairness.
8. Enable customer/admin surfacing.
9. Enable outbox creation after alerting/admin readiness. Delivery remains disabled/deferred.

Rollback disables in reverse operational order: outbox, customer UI, reconciliation, processor, then ingestion/webhook delivery. Preserve durable rows; on resume, every queued event revalidates current booking state and fetches the latest supplier order before writing.

## Complexity Tracking

| Complexity                                       | Why needed                                                                     | Simpler alternative rejected because                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Durable inbox table/processor                    | closes crash gap after provider ACK and handles at-least-once delivery         | synchronous/fire-and-forget processing can lose events or cause retry storms                       |
| Owned DB leases + unique revision fallback       | multi-instance webhook/cron concurrency and stale worker safety                | timestamp-only/unconditional release can clear another worker; decorator is not a distributed lock |
| Normalized revisions plus original JSON snapshot | current read, audit, matching, history, and cumulative drift                   | overwriting original destroys evidence; JSON-only revisions are difficult to query/render safely   |
| Incremental and cumulative diff                  | latest explanation plus accumulated materiality                                | either baseline alone misses an approved user need                                                 |
| Derived current/next/final Booking times         | indexed round-trip reconciliation/completion                                   | querying nested JSON is not a fair/budget-efficient scheduler seam                                 |
| Independent attention state and outbox           | separates operational suppression from traveller lifecycle and future delivery | overloading disruption status hides what action is required                                        |
| Frontend foundation restoration                  | required files/config are absent from clean tree                               | planning edits to documentation-only components is not executable                                  |

All complexity maps to deterministic auditability, API-budget discipline, operational visibility, or a verified repository prerequisite. No extra deployable service is introduced.

## Constitution Check — Post-Design Re-evaluation

- **Flight-first:** all models, APIs, UI, and operations stay within booked-flight supplier changes — PASS.
- **Deterministic boundary:** matcher/classifier/state/outbox are pure or transactional deterministic code; no AI dependency — PASS.
- **API budget:** one fetch per successfully claimed trigger, canonical dedupe, capped fair reconciliation, budget gate/telemetry — PASS.
- **Operational visibility:** inbox, attention state, audit events, metrics, heartbeat, dashboard, alerts, retention, and runbook are explicit deliverables — PASS.
- **Incremental delivery:** flags and phase exits keep each PR deployable and allow rollback — PASS.
- **Security:** raw HMAC/replay protection, ownership/RBAC, validation, PII-safe contracts/logs, retention — PASS.

Post-design gate result: PASS. Implementation may proceed phase-by-phase after plan approval.
