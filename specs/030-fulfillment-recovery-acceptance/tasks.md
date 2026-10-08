# Tasks: Safe Booking Fulfillment Recovery

**Input**: spec.md, plan.md, research.md, data-model.md, contracts/, acceptance-matrix.md, quickstart.md.
**Tests**: Requested test-first implementation: write focused checks before implementation and observe failure for the intended behavior.
**Format**: Sequential task ID, optional [P] only for independent files, [USn] on every story task, concrete target paths. New paths are planned deliverables.

## Phase 1: Setup
- [X] T001 [P] Add default-off/invalid-configuration tests in apps/api/src/payment-fulfillment/fulfillment-recovery.config.spec.ts.
- [X] T002 Implement recovery enrollment/configuration and validated lease/expiry policy in apps/api/src/payment-fulfillment/fulfillment-recovery.config.ts and apps/api/src/app.module.ts.

## Phase 2: Foundation and Controlled Harness
- [x] T003 [P] Add clean/legacy migration and Payment reservation reader tests in apps/api/test/fulfillment-recovery-migration.e2e-spec.ts.
- [x] T004 [P] Add acquire/renew/fence/takeover race tests using actual DB time in apps/api/src/payment-fulfillment/fulfillment-workflow.repository.spec.ts.
- [ ] T005 [P] Add stable-operation/distinct-attempt/immutable-evidence tests in apps/api/src/payment-fulfillment/provider-operation.service.spec.ts.
- [x] T006 Add workflow/operation/attempt schema, nullable unique Stripe intent ID, internal RESERVED status and PaymentEvent links with an additive migration in apps/api/prisma/schema.prisma and apps/api/prisma/migrations/20261007000000_fulfillment_recovery/migration.sql.
- [x] T007 Implement single workflow claim and fenced state writes using DB time in apps/api/src/payment-fulfillment/fulfillment-workflow.repository.ts.
- [ ] T008 Implement stable identities, atomic Payment reservation, pre-dispatch PREPARED and immutable late evidence in apps/api/src/payment-fulfillment/provider-operation.service.ts.
- [x] T009 Wire providers and update nullable-ID/RESERVED readers before flag enablement in apps/api/src/payment-fulfillment/payment-fulfillment.module.ts, apps/api/src/payment/payment.service.ts, apps/api/src/booking-lifecycle/booking-recovery.service.ts and packages/shared/src/ (keep existing ready-intent responses compatible).
- [ ] T010 [P] Add ledger/transport contract tests for independent Stripe and supplier side effects in apps/api/test/fulfillment-harness/provider-transports.spec.ts.
- [ ] T011 Implement stateful transport simulators with realistic verified provider capabilities in apps/api/test/fulfillment-harness/stripe-server.ts and apps/api/test/fulfillment-harness/supplier-server.ts.
- [ ] T012 [P] Add protected driver, cross-run isolation, production exclusion, redaction and teardown tests in apps/api/test/fulfillment-harness/driver.spec.ts.
- [ ] T013 Implement explicit signed event release, held responses, disposable DB/Redis bootstrap, restart barriers and cleanup in apps/api/test/fulfillment-harness/driver.ts and apps/api/test/fulfillment-harness/bootstrap.ts.
- [ ] T014 Implement a test-only external Stripe browser client seam without replacing application UI in apps/web/tests/fixtures/fulfillment-stripe-client.ts.
- [X] T015 Implement virtual recovery scheduling (not DB lease time), finite fault scenarios and expected-variant manifest in apps/api/test/fulfillment-harness/scheduler.ts and apps/api/test/fulfillment-harness/scenarios.ts.
- [ ] T016 Configure isolated real Next/Nest/provider startup and failure-on-missing-services in apps/web/tests/playwright.fulfillment.config.ts and apps/api/test/fulfillment-harness/server.ts.

Foundation checkpoint: journal, one DB claim, provider transport fidelity and isolated driver exist. No external call is held inside a database transaction.

## Phase 3: US1 - Complete or Safely Hold a Booking (P1)
- [ ] T017 [P] [US1] Add confirmed/definite/unknown create/capture and compensated-failure tests in apps/api/src/payment-fulfillment/payment-fulfillment.saga.spec.ts.
- [ ] T018 [P] [US1] Add fresh supplier total/currency and Balance mapping tests in apps/api/src/supplier/order/duffel-fulfillment.adapter.spec.ts and apps/api/src/supplier/order/duffel-order.adapter.spec.ts.
- [ ] T019 [P] [US1] Add actual authorization-expiry and capture normalization tests in apps/api/src/common/stripe.service.spec.ts.
- [ ] T020 [P] [US1] Add concurrent cross-key creation, lost PI-create response and fenced cleanup tests in apps/api/src/payment/payment.service.spec.ts.
- [ ] T021 [US1] Define outcome/invocation contracts, payment-create reservation semantics and authoritative provider observation/candidate-discovery methods in apps/api/src/payment-fulfillment/ports/payment-gateway.port.ts and apps/api/src/payment-fulfillment/ports/fulfillment-gateway.port.ts.
- [ ] T022 [US1] Enroll/reserve before PI creation, use stable operation keys, prepare browser authorization and reconcile uncertain creation/cleanup in apps/api/src/payment/payment.service.ts.
- [ ] T023 [US1] Normalize Stripe create/authorization/capture and implement authoritative intent/capture/release/refund retrieval plus expanded actual expiry with nullable-ID guards; unavailable reads stay unresolved in apps/api/src/common/stripe.service.ts and apps/api/src/common/stripe-payment.adapter.ts.
- [ ] T024 [US1] Implement fresh supplier-priced Balance request, verified create results, supported candidate discovery and authoritative order/payment/cancellation observations with >=130-second transport timeout; never use snapshot fallback as current provider truth in apps/api/src/supplier/order/duffel-fulfillment.adapter.ts and apps/api/src/supplier/order/duffel-order.adapter.ts.
- [ ] T025 [US1] Adopt durable operations and fenced transitions, reconcile-before-compensate policy, expired-authorization handling and distinct compensated-failure result in apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts.
- [ ] T026 [P] [US1] Add tokenized form/pending/reload/single-submit tests in apps/web/tests/fulfillment-payment-form.unit.ts.
- [ ] T027 [P] [US1] Add authenticated create/confirm/status server-action tests in apps/web/app/checkout/[intentId]/payment/actions.spec.ts and wire apps/web/scripts/run-node-tests.mjs route-contract discovery.
- [ ] T028 [US1] Implement caller-owned payment actions with safe secrets/status handling in apps/web/app/checkout/[intentId]/payment/actions.ts.
- [ ] T029 [US1] Implement Stripe Elements form and pending/resume UI using official browser SDK tokenization in apps/web/components/checkout/PaymentFormClient.tsx (record any required client dependency in context/library-docs.md).
- [ ] T030 [US1] Replace the disabled payment placeholder with working form and truthful confirmation/failure states in apps/web/app/checkout/[intentId]/payment/page.tsx.
- [ ] T031 [US1] Add real DB integration for reserved-before-PI evidence and A01-A09/A21 lifecycle variants in apps/api/test/fulfillment-payment-lifecycle.e2e-spec.ts.
- [ ] T032 [US1] Add customer-flow/pending/duplicate-create browser cases in apps/web/tests/fulfillment-recovery.spec.ts; defer US2 event/restart/operator variants until T042.

Independent US1 test: demonstrate A01, A02, A05 confirmed/definite outcomes, A08 pre-create check and A21 reservation/creation portions. Assert truthful pending for unresolved variants. Complete automatic/event recovery and operator portions are explicit US2 dependencies, not falsely counted as independently delivered.

## Phase 4: US2 - Reconcile and Escalate With Evidence (P1)
- [ ] T033 [P] [US2] Add immediate/backoff/15-minute/early-expiry/restart/stale-response tests in apps/api/src/payment-fulfillment/fulfillment-reconciliation.service.spec.ts.
- [ ] T034 [US2] Implement continued reconciliation, immutable first uncertainty and separate escalation projection in apps/api/src/payment-fulfillment/fulfillment-reconciliation.service.ts and apps/api/src/payment-fulfillment/fulfillment-reconciliation.cron.ts.
- [ ] T035 [P] [US2] Add queue RBAC/no-force/evidence/audit/resolved-no-op tests in apps/api/src/payment/admin-reconciliation.controller.spec.ts.
- [ ] T036 [US2] Implement ADMIN guarded queue/detail/reconcile/resume with shared claim in apps/api/src/payment/admin-reconciliation.controller.ts, apps/api/src/payment/admin-reconciliation.service.ts and apps/api/src/payment/payment.module.ts.
- [ ] T037 [P] [US2] Add queue accessibility/pending/resolved projection checks in apps/web/tests/admin-reconciliation.spec.ts.
- [ ] T038 [US2] Implement authenticated operator queue/detail UI in apps/web/app/admin/booking-reconciliation/page.tsx and apps/web/components/admin/BookingReconciliationQueue.tsx.
- [ ] T039 [P] [US2] Add signed duplicate/out-of-order authorization/capture/creation events and stale-owner evidence tests in apps/api/src/payment/payment-webhook.service.spec.ts.
- [ ] T040 [US2] Retain verified ingress/deduplication and reduce payment events under the workflow fence in apps/api/src/payment/payment-webhook.service.ts; route relevant verified supplier creation events in apps/api/src/disruption/webhook/duffel-webhook.controller.ts and apps/api/src/disruption/webhook/duffel-inbox.service.ts only after account contract verification.
- [ ] T041 [US2] Add real DB operator/sweeper contention, expired DB lease, late evidence and audit coverage in apps/api/test/fulfillment-reconciliation.e2e-spec.ts.
- [ ] T042 [US2] Complete A09 event, A10-A15, A18 isolation and A21 late-authorization browser variants in apps/web/tests/fulfillment-recovery.spec.ts.

Independent US2 test: A10-A15 plus US2 portions of A09/A18/A21 after US1. Use virtual scheduling for escalation and real DB-time short leases for takeover.

## Phase 5: US3 - Safe Migration, Rollout and Required Gates (P2)
- [ ] T043 [P] [US3] Add verified/incomplete/contradictory legacy dry-run/backfill checks in apps/api/src/payment-fulfillment/fulfillment-recovery-backfill.service.spec.ts.
- [ ] T044 [US3] Implement traceable backfill and quiescence/enrollment reports in apps/api/src/payment-fulfillment/fulfillment-recovery-backfill.service.ts.
- [ ] T045 [P] [US3] Add off-mode/rollback/held-response/late-webhook/retry routing and wire replay checks in apps/api/test/fulfillment-recovery-rollout.e2e-spec.ts.
- [ ] T046 [US3] Adopt enrollment-safe routing across saga, PaymentService, recovery, refund and admin paths; retire competing Redis/HTTP-key financial ownership in apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts, apps/api/src/payment/payment.service.ts, apps/api/src/booking-lifecycle/booking-recovery.service.ts, apps/api/src/payment/payment-refund.service.ts, apps/api/src/payment/admin-refund.controller.ts and apps/api/src/idempotency/payment-idempotency.service.ts.
- [ ] T047 [P] [US3] Add guarded isolated provider auth/mapping/webhook/expiry/discovery/cancellation contracts in apps/api/test/fulfillment-provider-contract.e2e-spec.ts.
- [ ] T048 [US3] Add sandbox-only config and exclude it from ordinary discovery in apps/api/test/jest-fulfillment-sandbox.json and apps/api/jest-integration.json; update specs/030-fulfillment-recovery-acceptance/quickstart.md.
- [ ] T049 [P] [US3] Add A20 real >=130-second create timeout check in apps/api/test/fulfillment-provider-timeout.e2e-spec.ts and apps/api/test/jest-fulfillment-timeout.json with >=180000-ms test/service budget.
- [ ] T050 [US3] Partition long timeout discovery and wire route-contract/controlled lanes in apps/api/jest-integration.json, apps/api/package.json, apps/web/package.json and apps/web/scripts/run-playwright.mjs.
- [ ] T051 [P] [US3] Add omission/zero-scenario/skip/infrastructure/redaction gate contract checks in tests/ci/fulfillment-acceptance.contract.test.mjs.
- [ ] T052 [US3] Implement service-owning controlled runner, required variant manifest checks, A20 lane and separate manual/nightly sandbox job in scripts/ci/run-fulfillment-acceptance.mjs and .github/workflows/ci.yml; preserve ci-status aggregation and relevant path triggers.

Independent US3 test: A16/A17 legacy and rollback fixtures, A18 gate failure modes, A19 sandbox contract with explicit prerequisites and A20 actual transport threshold. Sandbox-skipped is not passed; required controlled checks remain independent of provider secrets.

## Phase 6: Polish
- [ ] T053 Update context/architecture.md, context/progress-checker.md, context/active-feature.md and context/library-docs.md with implemented and verified behavior.
- [ ] T054 Run focused API/web/route-contract checks and every required scenario manifest; record actual results and rollout gates in specs/030-fulfillment-recovery-acceptance/quickstart.md.

## Dependency Graph
T001 -> T002 -> T003-T005 -> T006-T009.
Harness T010-T016 follows core contract definition and blocks composed tests T031/T032/T041/T042.
US1 T017-T032 follows foundation. US2 T033-T042 follows US1 semantics.
US3 T043-T052 validates foundation/story implementation and blocks live activation.
T053-T054 close verification. No live activation before US1 + US2 + US3 gates pass.

[P] marks separate files without unmet prerequisites; it never authorizes simultaneous edits of the same file. Parallel examples: T003/T004/T005; T017/T018/T019/T020; T026/T027; T033/T035/T037/T039; T043/T045/T047/T049/T051 after their dependencies. Implementation shared-file tasks are sequential.

## Requirement-to-Task Traceability
| Requirements | Tasks | Acceptance |
| --- | --- | --- |
| FR-001-FR-004 | T017-T025,T028-T032 | A01,A02,A08,A19,A20,A21 |
| FR-005-FR-007 | T017,T021,T025,T033-T034,T039-T042 | A03-A07,A09-A10 |
| FR-008-FR-011,FR-019 | T004-T009,T020-T025,T033-T042,T046 | A09-A12,A21 |
| FR-012-FR-015 | T033-T042 | A11-A15 |
| FR-016-FR-017 | T003,T006,T027,T039-T052 | A09,A16-A19,A21 |
| FR-018 | T010-T016,T047-T052 | A18-A20 |

MVP: deliver foundation and independently testable US1 while disabled. Automatic recovery/operator ownership and full rollout are US2/US3 prerequisites to production enablement. The separate uncommitted Balance fix is not assumed merged; T018/T024 implement and verify its required mapping on this baseline. Browser exploratory verifier-agent ecosystem is a future follow-up without production financial authority.
