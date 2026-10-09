# Tasks: Traveler Profile & Booking Readiness

**Input**: Design documents from `specs/016-traveler-profile-booking-readiness/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/api.md`, `observability.md`, `quickstart.md`

**Tests**: Required by `context/workflow.md`. For each behavior, write the listed test first, confirm RED, implement the minimum GREEN change, then refactor without weakening the test.

**Organization**: Five user stories are split into ten reviewable implementation phases plus setup/foundation/polish. Every task names its owned file(s).

## Phase 1: Setup — Shared Contracts, Flags, and Operational Names

**Purpose**: Establish compile-time contracts and disabled-by-default rollout controls without changing runtime behavior.

- [x] T001 [P] Add traveler profile, passenger-source, profile-revision, readiness result, safe reason-code, and masked passenger summary types in `packages/shared/src/types/traveler-profile.types.ts` and `packages/shared/src/types/booking-intent.types.ts`
- [x] T002 Export the new shared contracts from `packages/shared/src/types/index.ts` and verify `pnpm --filter @shared/types build` passes
- [x] T003 [P] Add `FEATURE_FLAG_BOOKING_READINESS=false` validation/defaults to `apps/api/src/app.module.ts` and `apps/api/.env.example`
- [x] T004 [P] Add `NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS=false` to `apps/web/.env.example` and centralize its read in `apps/web/lib/featureFlags.ts`
- [x] T005 [P] Define PII-safe operation names, metric names, and allowed metadata keys from `observability.md` in `apps/api/src/common/observability/booking-readiness-observability.types.ts`

**Checkpoint**: Shared packages compile; both services retain existing behavior with the new feature disabled.

---

## Phase 2: Foundation — Additive Schema, Bound Encryption, and Migration Safety

**Purpose**: Create rollback-safe data/encryption foundations required by profile and intent stories.

**⚠️ CRITICAL**: No profile or snapshot write path starts until this phase is green.

- [x] T006 [P] Write failing migration compatibility tests for nullable profile/snapshot columns, profile revision default, and preserved legacy expiry data in `apps/api/test/traveler-profile-readiness-migration.e2e-spec.ts`
- [x] T007 [P] Write failing AES-GCM version/AAD/cross-record substitution tests in `apps/api/src/common/encryption.service.spec.ts`
- [x] T008 Extend `EncryptionService` with backward-compatible versioned bound encrypt/decrypt methods in `apps/api/src/common/encryption.service.ts` until T007 passes
- [x] T009 Add the eleven nullable `TravelerProfile` fields, `revision`, expiry ciphertext shadow, complete `BookingIntentPassenger` fields, `snapshotVersion`, and retain `travelerProfile` provenance `onDelete: SetNull` in `apps/api/prisma/schema.prisma`
- [x] T010 Create the additive SQL migration without renaming/dropping legacy columns in `apps/api/prisma/migrations/<timestamp>_traveler_profile_readiness/migration.sql` until T006 passes
- [x] T011 [P] Write failing bounded-batch, optimistic-predicate, decrypt/compare, checkpoint, quarantine, and abort-threshold tests in `apps/api/src/profile/passport-expiry-backfill.service.spec.ts`
- [x] T012 Implement the idempotent dual-write/backfill service with allowlisted structured batch events and processed/skipped/quarantined/abort metrics in `apps/api/src/profile/passport-expiry-backfill.service.ts` until T011 passes

**Checkpoint**: Migration is additive and reversible; old ciphertext still decrypts; new ciphertext is record-bound; backfill never clears legacy data.

---

## Phase 3: User Story 1A — Owned Profile API (Priority: P1) 🎯 MVP Part 1

**Goal**: Provide secure, revision-controlled profile creation/read/update with atomic travel-document replacement.

**Independent Test**: An authenticated owner can round-trip every field, stale/cross-user writes fail, document updates are atomic, and no values reach logs/audits/cacheable responses.

### RED tests

- [x] T013 [P] [US1] Write failing profile service tests for owner scoping, create/update, revision CAS, document atomicity, dual-write expiry, and safe audit metadata in `apps/api/src/profile/profile.service.spec.ts`
- [x] T014 [P] [US1] Write failing controller tests for DTO validation, no-store/private headers, sanitized errors, trace propagation, and disabled-flag behavior in `apps/api/src/profile/profile.controller.spec.ts`
- [x] T015 [P] [US1] Write failing authenticated profile API E2E tests including stale revision, disallowed origin, cross-user isolation, global log/filter redaction, and plaintext-at-rest assertions in `apps/api/test/profile.e2e-spec.ts`

### GREEN implementation

- [x] T016 [P] [US1] Implement nested identity/contact/document/preferences PATCH DTOs with complete-document validation in `apps/api/src/profile/dto/update-profile.dto.ts`
- [x] T017 [P] [US1] Implement full-profile and safe completion response DTOs in `apps/api/src/profile/dto/profile-response.dto.ts`
- [x] T018 [US1] Implement owned profile reads, revision CAS writes, dual-write protection, atomic document clearing/replacement, safe audits, and allowlisted profile read/update outcome events/metrics in `apps/api/src/profile/profile.service.ts`
- [x] T019 [US1] Implement guarded `GET/PATCH /api/profile`, feature behavior, no-store headers, trace context, and sanitized errors in `apps/api/src/profile/profile.controller.ts`
- [x] T020 [US1] Register `ProfileModule`, backfill provider, Prisma/audit/encryption dependencies, and app import in `apps/api/src/profile/profile.module.ts` and `apps/api/src/app.module.ts`

**Checkpoint**: US1 API acceptance scenarios and SC-001/SC-005 API boundaries pass independently.

---

## Phase 4: User Story 1B — Secure Profile UI (Priority: P1) 🎯 MVP Part 2

**Goal**: Let the traveler review/correct all profile sections without leaking values into browser side channels.

**Independent Test**: The profile page loads and saves every field, handles revision conflicts, and places no PII in URL, route state, local/session storage, or cache.

### RED tests

- [x] T021 [P] [US1] Write failing Playwright owner flow, validation, revision-conflict, all-fields-visible, and browser-privacy assertions in `apps/web/tests/traveler-profile.spec.ts` (100% verified with live Playwright execution)
- [x] T022 [P] [US1] Write failing profile client contract tests for no-store requests and safe error mapping in `apps/web/lib/profile.spec.ts` (17/17 tests passing)

### GREEN implementation

- [x] T023 [US1] Implement authenticated server-side profile fetch and revision-aware PATCH helpers in `apps/web/lib/profile.ts` (browser writes use the same-origin authenticated proxy in `apps/web/app/api/profile/route.ts`)
- [x] T024 [US1] Implement accessible identity, contact, full-document, and preferences form sections with conflict recovery in `apps/web/components/profile/TravelerProfileForm.tsx`
- [x] T025 [US1] Implement the protected Server Component profile page and feature-disabled fallback in `apps/web/app/profile/page.tsx`
- [x] T026 [US1] Wire the existing Profile navigation entry and return-target allowlist in `apps/web/components/layout/Header.tsx` and `apps/web/lib/safeReturnTarget.ts`

**Checkpoint**: US1 is a deployable MVP behind the web flag; disabling the flag leaves legacy checkout unchanged.

---

## Phase 5: User Story 2A — Pure Booking Readiness Evaluator (Priority: P2)

**Goal**: Produce deterministic domestic/international/unknown field statuses with hard, advisory, and deferred tiers and zero I/O.

**Independent Test**: A table-driven matrix covers all scopes, every required field, optional middle name, trip-end expiry, advisory buffer, unsupported type, and unknown entry eligibility.

### RED tests

- [x] T027 [P] [US2] Write the complete table-driven evaluator matrix with a fake clock in `apps/api/src/booking-intent/booking-readiness.evaluator.spec.ts`
- [x] T028 [P] [US2] Write failing tests that prove missing airport-country data yields blocking `UNKNOWN` while destination eligibility remains non-blocking unknown in `apps/api/src/booking-intent/booking-readiness.evaluator.spec.ts`

### GREEN implementation

- [x] T029 [P] [US2] Define normalized evaluator inputs, section/field outputs, statuses, and safe reason codes in `apps/api/src/booking-intent/booking-readiness.types.ts`
- [x] T030 [US2] Implement the side-effect-free scope, identity, contact, atomic-document, expiry, and warning rules in `apps/api/src/booking-intent/booking-readiness.evaluator.ts`
- [x] T031 [US2] Parse and clamp `PASSPORT_ADVISORY_BUFFER_DAYS` with default 180 in `apps/api/src/booking-intent/booking-readiness.config.ts` and add it to `apps/api/.env.example`

**Checkpoint**: US2 domain rules pass with no Prisma, HTTP, Redis, agent, or Duffel dependency.

---

## Phase 6: User Story 2B — Advisory Readiness Endpoint (Priority: P2)

**Goal**: Resolve owned sources and every segment country server-side, return the normal readiness shape without writes, and expose measurable/traceable behavior.

**Independent Test**: Domestic/international/unknown requests return parity with the pure evaluator, include profile revision, create zero rows, and make zero supplier calls.

### RED tests

- [x] T032 [P] [US2] Write failing controller/service tests for source ownership, all-segment country lookup, revision projection, zero writes, and advisory `UNKNOWN` mapping in `apps/api/src/booking-intent/booking-readiness.service.spec.ts`
- [x] T033 [P] [US2] Write failing API E2E tests for `POST /bookings/intents/readiness`, feature-disabled response, trace propagation, PII-safe logs/audits, and zero Duffel calls in `apps/api/test/booking-readiness.e2e-spec.ts`

### GREEN implementation

- [x] T034 [P] [US2] Implement readiness request/response DTOs and discriminated source validation in `apps/api/src/booking-intent/dto/booking-readiness.dto.ts`
- [x] T035 [US2] Implement owned source resolution, stored-offer segment normalization, batched airport-country lookup, evaluator invocation, and safe projection in `apps/api/src/booking-intent/booking-readiness.service.ts`
- [x] T036 [US2] Add the canonical advisory action and `200 UNKNOWN`/infrastructure-error mapping in `apps/api/src/booking-intent/booking-intent.controller.ts`
- [x] T037 [US2] Import `ProfileModule` and `AirportsModule` and register evaluator/readiness providers in `apps/api/src/booking-intent/booking-intent.module.ts`
- [x] T038 [US2] Emit PII-safe readiness metrics/events and trace propagation in `apps/api/src/booking-intent/booking-readiness.observability.ts`

**Checkpoint**: US2 can be enabled and tested independently; readiness is advisory and has no supplier or persistence side effects.

---

## Phase 7: User Story 3A — Passenger Sources and Complete Snapshots (Priority: P3)

**Goal**: Replace ambiguous profile merging with exact source variants and build record-bound complete snapshot rows.

**Independent Test**: Mixed profile/inline passengers normalize independently; cross-user/stale/conflicting sources fail; copied ciphertext fails; successful snapshots remain unchanged after profile edits.

### RED tests

- [x] T039 [P] [US3] Write failing DTO tests for `traveler_profile`/`inline`, expected revision, passenger matrix, offer passenger ID, and `useProfile + source` conflict in `apps/api/src/booking-intent/dto/create-intent.dto.spec.ts`
- [x] T040 [P] [US3] Write failing source resolver tests for ownership, stale revision, mixed passengers, and no inline/profile value merging in `apps/api/src/booking-intent/passenger-source-resolver.service.spec.ts`
- [x] T041 [P] [US3] Write failing snapshot builder tests for completeness, AES AAD, cross-position/intent swaps, masked summaries, immutable provenance, and snapshot survival after source-profile deletion in `apps/api/src/booking-intent/passenger-snapshot.service.spec.ts`

### GREEN implementation

- [x] T042 [US3] Replace the legacy passenger DTO with nested discriminated sources and expected revision in `apps/api/src/booking-intent/dto/create-intent.dto.ts`
- [x] T043 [US3] Implement owned/revision-checked source normalization in `apps/api/src/booking-intent/passenger-source-resolver.service.ts`
- [x] T044 [US3] Implement preallocated-position AAD encryption, complete snapshot persistence data, and masked projections in `apps/api/src/booking-intent/passenger-snapshot.service.ts`
- [x] T045 [US3] Register source/snapshot providers without changing current create behavior in `apps/api/src/booking-intent/booking-intent.module.ts`

**Checkpoint**: Source and snapshot components are independently green before they replace legacy intent orchestration.

---

## Phase 8: User Story 3B — Atomic Intent and Safe Route/Client Migration (Priority: P3)

**Goal**: Make readiness authoritative at create time, create no partial state, and migrate first-party clients to plural/safe contracts without breaking legacy paths.

**Independent Test**: A ready request writes one complete intent; not-ready/stale requests write zero rows; both route families enforce the same service and safe read shape; profile edits cannot change the snapshot.

### RED tests

- [x] T046 [P] [US3] Write failing service transaction tests for evaluator parity, expected revision race, all-passenger prevalidation, zero-write rollback, profile edit/delete independence, and safe audits in `apps/api/src/booking-intent/booking-intent.service.spec.ts`
- [x] T047 [P] [US3] Write failing plural/singular create/get/prefill response-shape tests, including legacy `useProfile: true/false` translation and rejection of non-primary legacy profile flags, in `apps/api/test/booking-intent.e2e-spec.ts`
- [x] T048 [P] [US3] Update Playwright tests first for plural create, server-authoritative scope, profile revision retry, masked review, and legacy-flag-disabled checkout in `apps/web/tests/checkout-foundation.spec.ts`

### GREEN implementation

- [x] T049 [US3] Refactor intent creation to resolve/evaluate all sources before the short transaction, atomically create intent/snapshots/audit, and emit allowlisted authoritative validation/create events and metrics in `apps/api/src/booking-intent/booking-intent.service.ts`
- [x] T050 [US3] Add canonical plural create/get actions and deprecated singular aliases with safe response parity, legacy `useProfile`-to-source translation, non-primary rejection, and deprecation telemetry in `apps/api/src/booking-intent/booking-intent.controller.ts`
- [x] T051 [US3] Remove decrypted contact/document fields from intent DTOs, add masked summaries, and keep legacy passport keys `null` during compatibility in `apps/api/src/booking-intent/dto/intent-response.dto.ts`
- [x] T052 [US3] Migrate checkout helpers/types to plural readiness/create/get and revision-bearing sources in `apps/web/lib/checkout.ts`
- [x] T053 [US3] Replace browser route-scope and `useProfile` logic with readiness-driven profile/inline submission in `apps/web/components/checkout/PassengerFormClient.tsx`
- [x] T054 [US3] Render only masked document/contact summaries and secure edit links in `apps/web/app/checkout/[intentId]/review/page.tsx`

**Checkpoint**: US3 passes SC-003/SC-004; existing ancillaries/payment routes remain unchanged and their regression tests stay green.

---

## Phase 9: User Story 4A — PII-Safe Gateway, Agent Tool, and SSE (Priority: P4)

**Goal**: Let chat check readiness and emit allowlisted action metadata without receiving or producing passenger values.

**Independent Test**: Inject names/DOB/contact/document/profile IDs into every gateway/tool/event seam and verify they are stripped or rejected; normal output contains only type/ordinal/field/status/reason/target.

### RED tests

- [x] T055 [P] [US4] Write failing gateway service/controller and claim-bound safe-projection tests in `apps/api/src/agent-gateway/agent-gateway.service.spec.ts` and `apps/api/test/agent-gateway.e2e-spec.ts`
- [x] T056 [P] [US4] Write failing NestJS client/tool registry tests for safe readiness requests/responses in `apps/agent/tests/test_nestjs_client.py` and `apps/agent/tests/test_tools.py`
- [x] T057 [P] [US4] Write failing SSE allowlist, unexpected-key fail-closed, and PII corpus tests in `apps/agent/tests/test_sse_integration.py`

### GREEN implementation

- [x] T058 [US4] Implement claim-owned readiness input and allowlisted output DTOs in `apps/api/src/agent-gateway/dto/booking-readiness.dto.ts`
- [x] T059 [US4] Proxy the shared readiness service without profile IDs/values, propagate traces, and emit allowlisted gateway readiness outcome/latency/error events and metrics in `apps/api/src/agent-gateway/agent-gateway.service.ts` and `apps/api/src/agent-gateway/agent-gateway.controller.ts`
- [x] T060 [US4] Add the safe gateway call to `apps/agent/src/agent/tools/nestjs_client.py` and implement/register `apps/agent/src/agent/tools/check_booking_readiness.py` in `apps/agent/src/agent/tools/registry.py`
- [x] T061 [US4] Emit schema-allowlisted `ACTION_REQUIRED` and route ready requests through the existing confirmation/write boundary in `apps/agent/src/agent/graph/nodes.py` and `apps/agent/src/agent/streaming/sse.py`

**Checkpoint**: US4 backend/agent boundary passes with zero PII values and no direct agent database access.

---

## Phase 10: User Story 4B — Secure Chat-to-Form Handoff (Priority: P4)

**Goal**: Render the action-required card, route single-profile corrections to `/profile`, and route inline/multi-passenger entry to checkout.

**Independent Test**: An incomplete international chat request opens the secure profile form, a corrected profile retries to ready, and inline/multi-passenger cases never ask for PII in chat.

### RED tests

- [x] T062 [P] [US4] Write failing Playwright action-card, allowlisted return-target, retry, inline/multi-passenger redirect, and browser-privacy scenarios in `apps/web/tests/chat-booking-readiness.spec.ts`

### GREEN implementation

- [x] T063 [US4] Implement the metadata-only action card and secure navigation targets in `apps/web/components/chat/BookingActionCard.tsx`
- [x] T064 [US4] Add the minimal SSE `ACTION_REQUIRED` consumer/dispatcher without storing event payloads in `apps/web/components/chat/ChatWidget.tsx`
- [x] T065 [US4] Add safe return-and-retry handling to `apps/web/app/profile/page.tsx` and `apps/web/app/checkout/passengers/page.tsx`

**Checkpoint**: US4 satisfies SC-007 end to end; no chat component accepts identity/contact/document input.

---

## Phase 11: User Story 5 — Final Passenger Safety (Priority: P5)

**Goal**: Authenticate/decrypt and revalidate the frozen snapshot only for the existing payment/order claim owner immediately before the single Duffel call.

**Independent Test**: Expired, incomplete, corrupted, swapped, stale-version, concurrent, or lease-lost snapshots never call Duffel; a valid claimed snapshot calls once with an ephemeral supplier DTO.

### RED tests

- [x] T066 [P] [US5] Write failing final-validator unit tests for AAD authentication, decrypt-then-expiry ordering, completeness, current clock, ephemeral DTO, and plaintext-free errors in `apps/api/src/booking-intent/booking-passenger-final-validator.service.spec.ts`
- [x] T067 [P] [US5] Write failing payment/order integration tests for claim ownership, frozen versions, concurrent submit, lease loss, stable idempotency, and unknown supplier replay in `apps/api/src/payment/payment.service.spec.ts`
- [x] T068 [P] [US5] Write failing E2E tests asserting zero/one Duffel calls and durable PII-safe audit records for every expiry/completeness/AAD/lease/concurrency final-validation outcome in `apps/api/test/booking-passenger-final-validation.e2e-spec.ts`

### GREEN implementation

- [x] T069 [US5] Implement trusted bound-field authentication/decryption, completeness/expiry validation, ephemeral Duffel passenger mapping, and safe outcome objects for auditing in `apps/api/src/booking-intent/booking-passenger-final-validator.service.ts`
- [x] T070 [US5] Register/export the final validator from `apps/api/src/booking-intent/booking-intent.module.ts`
- [x] T071 [US5] Invoke the validator only inside the existing payment/order idempotency owner after version freeze, persist a durable audit for every safe final-validation outcome with trace/correlation IDs inside the owning transaction/recovery boundary, and call `DuffelService.createOrder()` only after success in `apps/api/src/payment/payment.service.ts`
- [x] T072 [US5] Add PII-safe final-validation metrics/reasons and trace continuity in `apps/api/src/booking-intent/booking-readiness.observability.ts`

**Checkpoint**: US5 satisfies SC-006 without a second submission state machine or duplicate supplier call.

---

## Phase 12: Polish, Observability, Performance, and Release Gates

**Purpose**: Prove constitutional operations, whole-flow privacy, performance targets, rollback, and documentation sync.

- [x] T073 Write failing E2E assertions mapping every profile/readiness/intent/gateway/final/backfill operation to metric increments, trace/correlation continuity, required structured fields, and negative PII corpus matching in `apps/api/test/booking-readiness-observability.e2e-spec.ts`
- [x] T074 Implement shared feature counters/latency histograms and health snapshot exposure in `apps/api/src/common/observability/booking-readiness.metrics.ts` and `apps/api/src/health/health.controller.ts` until T073 passes with the operation call sites from T012, T018, T038, T049, T059, and T072
- [x] T075 [P] Add the 100-warmed-request p95 gates with supplier calls disabled in `apps/api/test/booking-readiness.performance.e2e-spec.ts`
- [x] T076 [P] Create dashboard panels, alert thresholds, backfill abort/quarantine, feature rollout/rollback, and incident steps in `docs/runbooks/booking-readiness.md`
- [x] T077 Run the full validation sequence in `specs/016-traveler-profile-booking-readiness/quickstart.md` and record only failures/remediation notes in that file
- [x] T078 Update implemented data flow/module/route details in `context/architecture.md`, implementation status in `context/progress-checker.md`, and any changed commands in `context/workflow.md`
- [x] T079 Verify every FR/SC row in `specs/016-traveler-profile-booking-readiness/plan.md` has passing test evidence and run `git diff --check`

**Checkpoint**: All release gates pass; feature remains disabled by default until the documented rollout begins.

---

## Dependencies & Execution Order

### Phase DAG

```text
Phase 1 Setup
  ├─> Phase 2 Data/Encryption Foundation
  │     ├─> Phase 3 Profile API ─> Phase 4 Profile UI
  │     └─> Phase 7 Source/Snapshot Foundation
  └─> Phase 5 Pure Evaluator
        └─> Phase 6 Advisory Endpoint ─┐
Phase 3 Profile API ───────────────────┤
Phase 7 Source/Snapshot Foundation ────┴─> Phase 8 Atomic Intent/Client Migration
Phase 6 + Phase 8 ─> Phase 9 Gateway/Agent ─> Phase 10 Web Handoff
Phase 7 + Phase 8 ─> Phase 11 Final Safety
Phases 4, 6, 8, 10, 11 ─> Phase 12 Release Gates
```

### Story dependencies

- **US1**: Depends on Phases 1–2 only and is the profile MVP.
- **US2**: Pure evaluator depends on Phase 1; endpoint additionally depends on the profile API for stored sources.
- **US3**: Depends on schema/encryption, profile revision, and evaluator parity; it does not depend on the profile UI.
- **US4**: Depends on advisory readiness and safe plural intent creation; backend/agent work precedes the web handoff.
- **US5**: Depends on complete bound snapshots and atomic intent migration; it can run in parallel with US4.

### Parallel opportunities

- T001, T003, T004, and T005 touch separate setup files.
- T006, T007, and T011 begin as independent RED tests; implementation follows their own dependency.
- Phase 4 web UI can proceed in parallel with Phase 5 evaluator after the Phase 3 profile contract stabilizes.
- Phase 9 agent files and Phase 11 payment/order files are independent after Phase 8.
- T073–T076 cover separate metrics, verification, performance, and runbook files.

## Parallel Examples

### US1

```text
Run T013 profile service RED tests, T014 controller RED tests, and T015 API E2E RED tests in parallel.
After Phase 3 contract stabilizes, run T021 Playwright and T022 web client RED tests in parallel.
```

### US2

```text
Run T027 rule matrix and T028 unknown-scope RED cases together.
After evaluator GREEN, run T032 service/controller and T033 API E2E RED tests together.
```

### US3

```text
Run T039 DTO, T040 resolver, and T041 snapshot RED tests together because they own separate files.
Run T046 service, T047 route matrix, and T048 Playwright RED tests together before Phase 8 implementation.
```

### US4

```text
Run T055 NestJS gateway, T056 Python tool, and T057 SSE RED tests together.
Phase 10 starts only after the safe event contract is GREEN.
```

### US5

```text
Run T066 validator, T067 payment integration, and T068 E2E RED tests together; implement T069–T072 in dependency order.
```

## Implementation Strategy

### MVP first

1. Complete Phases 1–2.
2. Complete Phases 3–4 (US1).
3. Stop and validate the secure reusable profile independently.
4. Keep readiness/chat/order flags disabled until their later phases pass.

### Incremental delivery

1. US1: secure profile API/UI.
2. US2: pure/advisory readiness with no write side effects.
3. US3: authoritative source/snapshot and safe route migration.
4. US4 and US5 in parallel: chat handoff and final transactional safety.
5. Phase 12: observability/performance/privacy/rollback release gates.

## Format and execution rules

- Every task uses the required checkbox, sequential ID, optional `[P]`, story label where applicable, and exact path.
- `[P]` means different owned files and no dependency on an unfinished task.
- Tests are written first and must fail for the intended behavioral reason before implementation.
- Do not weaken, delete, or skip a failing test without explicit user approval under `context/workflow.md`.
- Commit after each task or tightly coupled RED/GREEN pair; preserve user-owned unrelated changes.
