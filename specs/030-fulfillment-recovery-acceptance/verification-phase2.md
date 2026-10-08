# Feature 030 Phase 2 Foundation and Harness Verification

Date: 2026-10-08
Evidence baseline: 1afcd657b742ddcafa6923ef40c90c0c52dc34d8 (codex/030-fulfillment-recovery-acceptance)

## Checkpoint status

Phase 1 setup T001–T002 and the original Phase 2 tasks T003–T016 are implemented, committed, and reviewed. The T005 and T008 task boxes were corrected to [x] after checking the task ledger, implementation commits, and completion report. This checkpoint covers the durable journal foundation and controlled test harness. It does not complete Feature 030: the production recovery flag is false, the real customer payment/recovery journey is not implemented, and T017 onward remains open.

## Task evidence

| Tasks | Result |
| --- | --- |
| T003/T006 | Additive migration and reservation-reader coverage passed six integration cases, including clean creation and legacy upgrade. Prisma validation/generation and API typecheck/lint passed. |
| T004/T007 | PostgreSQL claim and fencing coverage passed 20 cases across acquisition, renewal, takeover, stale ownership, and callback-expiry rollback. |
| T005/T008 | Stable operation identity, distinct attempts, reservation/evidence behavior, and monotonic terminal outcomes passed 35 provider-operation/workflow/migration integration tests. Implementation commits: 07e24deb and e460d2f5; the task report records the T005 test checkpoint and the reviewed monotonicity correction. |
| T009 | Nullable-ID and RESERVED compatibility coverage passed 192 tests; Nest module-composition coverage passed 3 tests. API typecheck, lint, build, and the 212-suite partition check passed. |
| T010/T011 | Guarded Stripe/supplier transport and fault tests passed 49/49. The simulator covers the installed SDK's supported error fields, supplier user association/filtering, and exact side-effect deltas. |
| T012/T013 | Guarded driver/bootstrap suite passed 12/12. Run-scoped schema and Redis cleanup reported zero leaks. Windows child cleanup verifies process identity before terminating owned children. |
| T014 | Isolated Stripe browser fixture passed 2/2; strict test typechecking, web typechecking, and web lint passed. This is a test-only client seam, not a checkout-flow test. |
| T015 | Virtual scheduler/scenario suite passed 8/8. Advancing its clock by 15 minutes left a real five-second PostgreSQL lease unchanged and renewable. |
| T016 | Real Next/Nest startup smoke passed 17/17. Both applications started from their actual entry points; health checks confirmed API PostgreSQL/Redis readiness and Next-to-Nest reachability. Owned teardown removed the run resources and stopped the two app children with zero reported leaks. Production build scans found no harness runtime modules or driver credentials; only the documented test-only API startup seam remains in the API artifact. |

## Guarded local pre-PR lanes

| Lane | Result |
| --- | --- |
| Static CI workflow contract | 24 passed |
| API unit | 119 suites, 2,173 tests passed |
| API contract | 2 suites, 8 tests passed |
| API component | 22 suites, 276 tests passed after clearing DUFFEL_MOCK and DUFFEL_API_URL for the injected-SDK fixtures |
| Shared types | 111 tests passed |
| API test partition | 216 suites classified exactly once |
| API performance unit | 1 suite, 3 tests passed |
| API/web typecheck and lint | Passed |
| API/web production builds | Passed |

The component lane's first attempt used DUFFEL_MOCK=true, which routed adapter tests away from their injected SDK. The corrected run passed all 276 tests without changing source or assertions. The API unit run emitted Node's url.parse() deprecation warning and expected negative-path fixture logs; no unit test failed. A transient Windows Prisma engine rename error during a build was followed by a successful API build retry after the concurrent test process exited.

The dedicated T016 Playwright smoke passed 17/17 in 1.3 minutes after the initial run found a missing pinned browser binary. The validated project now uses the already installed Chrome channel. No npm dependency was added for this checkpoint.

## Remaining integration failure

The earlier full API integration run reported 69/72 suites and 687/701 tests passed. Eleven T013 driver cases failed during bootstrap because the suite supplied its run-scoped application DATABASE_URL where the driver requires an unscoped admin URL. T013 now accepts a separate admin/base URL and keeps application URLs and strict validators unchanged, but the full API integration lane has not been rerun after that correction.

Focused diagnosis of the other three cases observed:

- One Agent Gateway test returned FEATURE_DISABLED because its readiness flag was set after the statically imported AppModule had already read configuration. The approved startup-order fixture correction is active.
- Two passenger confirmation cases returned HTTP 202/PENDING after 25,038–25,039 ms, matching the existing 25-second saga timeout. The specific awaited operation that remains pending is undiagnosed.

These are unresolved integration results. No assertion, timeout, nullable-provider-ID guard, or other safety behavior was weakened. The corrected fixture setup and the passenger timeout still need a full integration rerun and diagnosis.

## Work still open

The task list still has T017 onward, T053, and T054 open. US1/US2 customer payment and reconciliation flows, rollout/sandbox gates, convergence, final two-axis code review, and PR CI are not complete. Keep the recovery flag false. A green unit/component/startup matrix does not satisfy full integration acceptance or make Feature 030 complete.
