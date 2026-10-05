# Feature 029 — Phase 5 Slice 5 verification

Date: 2026-10-03. Scope: T043 checkpoint and scoped T042–T043 / US3 convergence. Approved slice design date: 2026-10-02. Verification baseline: `62f1e286e4aea755b3afeed356f287a5118893cd`. T042 implementation commit: `e1b4f48a`. T058 boundary fix commit: `3f6f88ea`.

## Status

T043's local verification gates pass, including the provider-visibility requirement closed by T058. The independent T058 source/test review and final T043 evidence/context review both returned GO with zero findings. Remote CI results and outstanding gates are recorded below.

## Verification gates

| Gate | Command / scope | Result |
| --- | --- | --- |
| Shared contracts | `pnpm --filter @shared/types test` | **PASS**, exit 0; 23 suites, 110 tests, 0 failed. The initial sandbox attempt exited 1 before assertions because Node could not spawn test workers (`spawn EPERM`); rerunning with approved process escalation passed. Shared code was unchanged after this run. |
| Static CI contract | `node --test tests/ci/ci-workflow.contract.test.mjs` | **PASS**, exit 0; 23 tests, 0 failed. The initial sandbox attempt hit the same pre-test `spawn EPERM`; rerunning with approved process escalation passed. CI contract files were unchanged after this run. |
| T042 supplier suites | `pnpm --filter @api/backend exec jest --runInBand src/supplier/core src/supplier/search src/supplier/ancillary src/supplier/order` | **PASS**, exit 0; 18 suites, 328 tests, before T058. |
| T042 module composition/readiness | `pnpm --filter @api/backend exec jest --runInBand src/app.module.spec.ts src/booking-intent/booking-readiness.service.spec.ts src/ancillaries/ancillaries.module.spec.ts` | **PASS**, exit 0; 3 suites, 42 tests, before T058. |
| T043 order checkpoint | `pnpm --filter @api/backend exec jest --runInBand src/supplier/order src/payment-fulfillment src/cancellation src/booking-lifecycle src/disruption` | **PASS**, exit 0; 25 suites, 500 tests, before T058. The post-T058 guarded full API run passed this scope too. |
| T043 ancillary checkpoint | `pnpm --filter @api/backend exec jest --runInBand src/supplier/ancillary src/ancillaries src/payment/ancillary-payment-validation.service.spec.ts` | **PASS**, exit 0; 11 suites, 153 tests, before T058. The post-T058 guarded full API run passed this scope too. |
| T058 boundary regression | `pnpm --filter @api/backend exec jest --runInBand src/supplier/core/duffel-core.module.spec.ts -t 'does not expose DUFFEL_SDK to an unrelated module'` | **PASS after T058**, exit 0; 1 selected test passed, 10 skipped. Against the pre-fix `@Global()` module it was a genuine RED: `.rejects.toThrow(/DUFFEL_SDK/)` received a resolved `TestingModule`; after removing `@Global()` it passed. |
| T058 capability module specs | Core plus search, ancillary, order, and AppModule composition specs | **PASS**, 5 suites, 30 tests. |
| API TypeScript | `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` | **PASS after T058**, exit 0. |
| API lint | `pnpm --filter @api/backend lint` | **PASS after T058**, exit 0. |
| API/shared ESLint | `pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0` | **PASS**, exit 0; no warnings or errors. Shared files were unchanged after this run. |
| Full API with network guard | Set `NODE_OPTIONS` to require `tests/ci/node-network-guard.cjs`, then `pnpm --filter @api/backend run test:ci` | **PASS after T058**, exit 0; 130 suites, 2,326 tests, 0 failed. This is a local run, not remote CI. |
| Core-provider privacy boundary | Inspect `apps/api/src/supplier/core/duffel-core.module.ts`, capability imports, and the negative composition test against plan/contract | **PASS after T058**: the core module is not global; search, ancillary, and order modules explicitly import it; an unrelated module cannot resolve `DUFFEL_SDK`. |

The initial sandbox process restriction affected only Node worker launches for shared/static tests. The same commands passed after approved process escalation; there was no test assertion failure.

## Database-backed E2Es

All post-T058 E2Es used the existing disposable `feature029_slice2_test` database and the repository network guard. The database was not reset, migrated, or reseeded. The test access token was set through the test environment; secret environment contents were not read or printed.

| Fresh post-T058 command scope | Result |
| --- | --- |
| `pnpm --filter @api/backend test:e2e -- test/supplier-order-module.e2e-spec.ts test/supplier-order-services.e2e-spec.ts test/supplier-ancillary.e2e-spec.ts test/module-deepening.e2e-spec.ts test/characterization/booking-characterization.e2e-spec.ts test/flights-analytics.e2e-spec.ts test/flights-cleanup.e2e-spec.ts` | **PASS**, exit 0; 7 suites, 52 tests. |
| `pnpm --filter @api/backend test:e2e -- test/cancellation.e2e-spec.ts test/booking.e2e-spec.ts test/payment-fulfillment-safety.e2e-spec.ts test/disruption.e2e-spec.ts test/disruption-phase3.e2e-spec.ts test/payment-fulfillment.e2e-spec.ts test/payment-idempotency.e2e-spec.ts test/booking-passenger-final-validation.e2e-spec.ts test/booking-events.e2e-spec.ts` | **PASS**, exit 0; 9 suites, 93 tests. |

Fresh total: **16 suites, 145 tests passed**. An earlier pre-T058 attempt omitted `DUFFEL_ACCESS_TOKEN`: six suites / 51 tests passed, while the ancillary E2E failed before assertions. Rerunning it with the test token passed 1/1. The post-T058 batches above reran all affected E2Es with the required test environment set.

## T042 and T058 regression/parity evidence

- Search SDK-selection regression: `pnpm --filter @api/backend exec jest --runInBand src/supplier/search/duffel-search.adapter.spec.ts -t 'uses the injected SDK when a legacy provider also has an SDK client'` produced a genuine baseline RED (the injected SDK expected one offer-request call but received zero because the old fallback selected the legacy SDK), then passed on the final adapter (1 passed, 31 skipped). Temporary baseline files were removed.
- Ancillary adapter migration: the focused suite first exposed 3 failures out of 16. `getCatalogData` now reserves both catalog attempts sequentially before parallel I/O; the corrected implementation passed 16/16. A capability assertion conflicted with immutable legacy behavior on second-reservation denial; the human approved correcting the expected SDK-call count to zero, and the updated test documents the decision.
- Independent T042 review initially reported one P2 because the SDK regression test's decoy provider used the wrong token. The setup was changed to the actual third constructor metadata token, proved RED against the temporary baseline, and the independent re-review reported zero remaining findings.
- T058's negative composition test was run RED against the old global module and GREEN after the fix (1 selected pass, 10 skipped). The T058 implementer also passed the core and three capability-module composition checks (5 suites / 30 tests), API typecheck, API package lint, and `git diff --check`; the independent source/test review reported zero findings.

## CI security remediation (2026-10-03)

The first remote run on draft PR #366 (`37089314904`, HEAD `4809eff9`) passed API gates, unit tests, E2Es, smoke/sanity, and SAST. Supply-chain policy failed on the existing `braces@3.0.3` GHSA-vfj7-8cjw-p6xm; the advisory has no published patched version. The user directed remediation.

The local pnpm patch backports upstream PR #72 source guards, with maximum nesting/traversal depth 100. The expanded behavioral suite produced genuine RED on the unpatched active API tooling dependency (1/7 passed, 6 security failures), then GREEN on the installed patch (7/7). It covers normal output, the 100/101 boundary, balanced and malformed deep strings, brace/parenthesis nesting, and all direct AST walkers with default and raised limits. Scanner checks passed 18/18, CI contracts passed 24/24 with authorized process spawning, scanner ESLint/syntax and diff checks passed. API/shared TypeScript and ESLint, patch-test formatting/syntax, and diff checks passed. Human-approved advisory-count assertions were synchronized to the actual register total of 102; the prior expected count of 98 was already stale.

Pnpm 9.15.4 generated the patch metadata, and its frozen lockfile-only validation passed. The full Windows pnpm 9 install stalled while active and was stopped; this is not recorded as a passed full install. Local pnpm 12 restoration completed successfully, after which the finalized pnpm 9 lockfile was restored and retained. Its diff is limited to 8 insertions/3 deletions. Remote CI must still prove the full frozen pnpm 9 install. The scanner honors this single advisory exception only when the reviewed patch SHA-256, exact registration, and pnpm 9 lock hash match; missing/changed/unregistered evidence fails closed. Existing policy expiry remains 2026-10-12. Attribution, hashes, and removal criteria are in the dependency advisory register. Patch-only changes now route through API, web, and security validation, with a static contract enforcing the filters.

Independent corrective review: Standards initially found one P2 stale summary count; corrected and rechecked with zero remaining findings. Spec initially found one P2 missing malformed/raised-limit regression coverage; added and rechecked with zero remaining findings. No other source finding was reported. Remote convergence is pending the pushed remediation HEAD.

Final independent Standards and Spec reviews assessed the committed `4809eff9...HEAD` remediation through `d8d92a1d`, including patch-only routing and final verification evidence: **0 findings on each axis; worst severity none**. Patch implementation is committed separately as `923ffc2c`; scanner/CI enforcement and docs as `d8d92a1d`.

### Corrective package-manager alignment

Remote run `37093918369` on `e2912e98` passed SAST, supply-chain scanning, and agent validation. The security job proved the full frozen pnpm 9 install and applied patch regressions on Linux. Regular API/web jobs instead use pnpm 10.34.5 and failed frozen installation because its patch hash uses SHA-256 rather than pnpm 9's base32 algorithm. The initial verification selected the security jobs' older CLI and missed this existing mixed-version setup; patch bytes were identical in the working tree and committed blob, both LF.

The user explicitly approved updating existing pinned-version and patch-lock fixture expectations to pnpm 10.34.5 on 2026-10-03. The correction aligns the security jobs and toolchain inventory with the existing regular-job pin; retains object-form `hash`/`path` checks; and replaces only the lock patch hash, snapshot key, and two consumer references (4 insertions/4 deletions, committed as `4c870daf`). The exact pnpm 10.34.5 CLI reproduced the original frozen mismatch, then passed frozen lockfile-only validation after correction; unchanged behavioral regressions remain 7/7. No dependency version or source-patch byte changed. Scanner tests passed 18/18 and CI contracts passed 24/24, including consistent pins across all frozen-install Node jobs and missing/incorrect lock hash/path rejection. Scanner/security-test lint, syntax, and diff checks passed; the CI contract file's 19 existing `no-regex-spaces` lint issues were unchanged. The corrective remote rerun remains pending.

## Final dual-axis review

Independent Luna Max reviewers assessed `git diff 62f1e286e4aea755b3afeed356f287a5118893cd...HEAD` through T043 commit `2eb88a61` after scoped convergence. Standards: 0 findings, worst severity none; module boundaries, constructor injection, type declarations, and approved test migration comply with repository rules, with no actionable Fowler smells. Spec: 0 findings, worst severity none; T042–T043 and T058 match the approved scope, preserve compatibility files and supplier behavior, and honestly report local gates. Phases 6–7 remain pending. Remote CI is checked separately on the draft PR.

## Reference census

`rg -n --glob '*.ts' '\b(DuffelService|DuffelModule|DuffelCleanupService)\b' apps/api/src apps/api/test` found no runtime imports or references to the deleted classes. Remaining hits are negative absence assertions/test labels in `test/module-deepening.e2e-spec.ts` and `src/ancillaries/ancillaries.module.spec.ts`. `DuffelServiceLine` remains only as its declaration/use in `src/duffel/duffel.types.ts`, the compatibility wire type explicitly retained by GOAL.md. `rg -n '@Global' apps/api/src/supplier` returned no matches; `DuffelCoreModule` is imported only by `SupplierSearchModule`, `SupplierAncillaryModule`, and `SupplierOrderModule`.

## Scoped convergence

The `.specify/scripts/powershell/check-prerequisites.ps1 -Json -RequireTasks -IncludeTasks` prerequisite succeeded for Feature 029; `.specify/extensions.yml` has no `before_converge` or `after_converge` hooks.

The initial scoped T042–T043 / US3 assessment found one HIGH `contradicts` issue: `@Global()` violated the plan Structure Decision and supplier-boundaries contract, which require explicit supplier-module imports. T058 was appended with exact source/spec references and the dependency that it gates T043 and must finish before US4 T044–T054. T058 is now implemented and checked. **✅ Converged for the scoped T042–T043 / US3 checkpoint**: the post-fix recheck found zero remaining findings. It checked the three US3 acceptance scenarios, one plan structure decision, the supplier-boundaries module-import rule, and all five constitution principles relevant to this scope (no constitution findings). The order lifecycle/compensation tests pass, the three capability modules explicitly import a non-global core, the unrelated-module regression passes, and the local T043 gates pass. No additional convergence task was appended on the recheck; T058 is the only convergence item. Phases 6–7 remain pending.

Independent pnpm alignment review assessed the correction from e2912e98 through a1a08f1c: Standards 0 findings, worst severity none; Spec 0 findings, worst severity none. Both reviewers confirmed consistent CI pins, unchanged dependency versions, and fail-closed patch metadata enforcement.

### Verified inline review follow-up (2026-10-03)
Both user-provided findings remained valid against 1d988e44. Commit 81d8fc8c adds pnpm-workspace.yaml to security routing and includes its new regression in CI. Commit 0ef59fc6 stops workspace advisory matching at the next nonblank line indented two spaces or less and runs the new public-interface regressions in CI. Existing test bodies were unchanged. Genuine RED/GREEN evidence was recorded for both tasks: routing failed without the path/runner addition; later sibling-list advisories were incorrectly accepted before the scanner fix, while blank-line preservation already passed. Final local checks: CI contracts plus routing regression 26/26; patch/scanner/workspace-boundary regressions 28/28; syntax and direct ESLint passed, diff whitespace checks passed. Plain MJS/YAML changes require no TypeScript compile check. Standards found one duplicate documentation note, fixed and independently rechecked with zero remaining findings. Remote validation is checked on the draft PR after the final push.
Independent Spec review at 0ef59fc6 also reported zero findings, worst severity none, confirming both requested behaviors and CI regression wiring. Final review totals: Standards 0 remaining; Spec 0; worst severity none on each axis. Scoped follow-up converged with no additional task.
