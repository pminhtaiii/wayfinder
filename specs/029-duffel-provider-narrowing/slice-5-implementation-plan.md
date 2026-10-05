# Slice 5 implementation plan

Approved design: 2026-10-02. Scope: T042–T043 only. Review baseline: `62f1e286e4aea755b3afeed356f287a5118893cd`.

## T042 — Decommission the monolith

1. Inspect all monolith callers and compare legacy behavior coverage with supplier capability suites. Preserve order creation, ancillary cache/freshness, missing-map fallback, budget denial, compensation, and privacy assertions.
2. Add one regression to the existing search adapter suite proving the injected `DUFFEL_SDK` handles searches even when an unrelated legacy provider exists. Run the focused case and record RED before removing the legacy fallback.
3. Remove the `DuffelService` constructor dependency and private SDK access in `duffel-search.adapter.ts`; use the injected SDK directly. No port signatures change.
4. Remove `DuffelModule` import/registration from `app.module.ts`. Delete the five files named in GOAL.md. Keep `duffel.types.ts` and `cancellation-confirmation.ts`.
5. Migrate the manual-order characterization in `duffel-order.adapter.spec.ts` to `DuffelOrderAdapter` with its existing SDK configuration token. Preserve request-body, idempotency, headers, and budget assertions. Remove obsolete legacy module/cleanup assertions explicitly authorized by GOAL.md. Migrate the additional supplier ancillary suite from `DuffelService` to the real ancillary adapter/service/normalizer using Nest testing injection and external boundary doubles; preserve every assertion.
6. Run focused tests, compiler, and API lint. Mark T042 complete only after all pass. Have one independent task reviewer check coverage and boundaries; resolve blocking findings. Commit T042.

Consumed interfaces: `DUFFEL_SDK`, `DUFFEL_SDK_CONFIGURATION`, existing budget/cache providers. Produced interfaces: unchanged supplier search/order/ancillary capabilities; no monolith runtime dependency.

Commands:

```powershell
pnpm --filter @api/backend exec jest --runInBand src/supplier
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
pnpm --filter @api/backend lint
rg -n '\b(DuffelService|DuffelModule|DuffelCleanupService)\b' apps/api/src
```

The reference audit distinguishes stale test labels from runtime imports and the retained `DuffelServiceLine` wire type. No broad renaming belongs to this slice.

## T043 — Verify the Phase 5 checkpoint

1. Run quickstart Section 3 and all supplier capability suites. Verify module exports expose the existing ports/concrete lifecycle services while SDK/core providers stay internal to supplier modules.
2. Run the change-aware API local gate: API/shared lint, shared tests, compiler, full API suite with network guard, and static CI contracts. Run existing order/consumer E2E suites using the established disposable test database setup; do not create migrations or change schemas.
3. Record exact commands, exit codes, suite/test counts, boundary results, and any limitations in `slice-5-verification.md`. Mark T043 complete only when its checkpoint passes. Update relevant context status and topology for the removed monolith. Have one independent reviewer verify T043 evidence; commit T043.

Commands:

```powershell
pnpm --filter @api/backend exec jest --runInBand src/supplier/order src/payment-fulfillment src/cancellation src/booking-lifecycle src/disruption
pnpm --filter @shared/types test
node --test tests/ci/ci-workflow.contract.test.mjs
$env:NODE_OPTIONS = "--require=$PWD/tests/ci/node-network-guard.cjs"
pnpm --filter @api/backend run test:ci
```

## Completion gates

Run scoped `speckit-converge` for T042–T043; Phases 6–7 remain pending. Run `code-review` with independent Standards and Spec agents on `git diff 62f1e286e4aea755b3afeed356f287a5118893cd...HEAD`. Resolve blocking findings, then push/update the existing draft PR and run CI convergence. Never weaken tests or retry the same persistent failure more than once.

Self-review: exact scope and files defined; interfaces unchanged; no placeholders; checks cover behavior and boundaries; task commits remain separate.
# CI remediation: GHSA-vfj7-8cjw-p6xm

User direction on 2026-10-03: fix the unpatched `braces@3.0.3` supply-chain blocker on draft PR #366. This is a bounded correction within the approved CI feedback loop.

1. Backport the reviewed source changes from upstream `micromatch/braces` PR #72, commit `d0d575e`, into `patches/braces@3.0.3.patch`; register it with pnpm and regenerate the lockfile. Keep the published package version honest. Limit parser brace/parenthesis nesting and recursive compile/expand/stringify traversal to 100 levels, including caller-supplied ASTs and attempts to override the ceiling.
2. Add `tests/security/braces-patch.test.mjs`. Run `node --test tests/security/braces-patch.test.mjs` against the unpatched package and verify controlled-depth-error assertions fail, then repeat after patch installation and require GREEN. Cover ordinary output, the allowed boundary, malformed/deep strings, and direct ASTs. Verify `pnpm install --frozen-lockfile` applies the checked-in patch. Commit this task independently.
3. Condition the existing expiring exception mechanism for this advisory on the reviewed patch's pinned SHA-256 and matching pnpm manifest/lockfile registration. Missing, modified, or unregistered patches must fail closed. Add new tests without weakening existing assertions. In the supply-chain CI job, apply the frozen install and run the actual patch regressions plus scanner tests before the strict audit. Run `node --test tests/security/supply-chain.test.mjs tests/ci/ci-workflow.contract.test.mjs` and the strict supply-chain scanner; commit this task independently.
4. Independently review the patch and exception guard along Standards and Spec axes. Update verification and security documentation with attribution, exact evidence, existing policy expiry, and removal criteria when upstream publishes a fixed release. Push only reviewed commits and re-run CI for the new HEAD. Do not claim convergence until the remote `ci-status` gate succeeds. The existing one-failed-retry circuit breaker still applies.

Corrective CI task after run `37093918369`: regular Node jobs already pin pnpm 10.34.5, while security jobs pin 9.15.4. Align the two security jobs and toolchain inventory to 10.34.5; regenerate only the patch lock metadata/snapshot/references with that version and retain all dependency versions. Bind the scanner to the reviewed SHA-256 in pnpm 10.34.5's CLI-generated object entry (`hash` and `path`), rather than pnpm 9's base32 hash. The user explicitly approved updating the existing pinned-version and lock-fixture assertions on 2026-10-03. Add a CI contract requiring one Node package-manager pin, preserve all security assertions, verify frozen lock validation and focused regressions, then independently review and commit the correction before the single corrective remote rerun.

### Inline review follow-up (2026-10-03)
The user requested two precise, bounded corrections, verified against HEAD 1d988e44: include pnpm-workspace.yaml in security change routing, and bound workspaceAuditIgnoreMatches to the ignoreGhas list through the next nonblank line indented two spaces or less. Implement each task with a new public-interface regression test, prove RED then GREEN, retain existing test bodies, and commit separately. Include new test files in existing CI runners, run focused security/CI suites and lint/syntax checks, then review Standards and Spec independently. No dependency or application behavior changes.
