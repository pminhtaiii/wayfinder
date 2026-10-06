# CI test boundaries — grilling session

Date: 2026-10-05

Status: Suite separation implemented; local validation and its limits are recorded below. Remote CI has not been run for this change.

## Goal

Separate overly broad test buckets so each suite can be run independently and CI failures identify the failing boundary more clearly.

## Verified starting evidence

- Before this change, `.github/workflows/ci.yml` provisioned PostgreSQL and Redis and deployed migrations inside `api-unit-tests`, which ran the broad `test:ci` command.
- The previous agent verification command selected `not redis_integration`. SC-004 wall-clock benchmarks were included in that correctness bucket.
- `apps/api/package.json` already provides `test:e2e:performance`. `apps/api/test/jest-e2e.json` excludes performance-named files. Preserve and inspect this existing separation before adding another mechanism.
- `docs/adr/research-cicd-smoke-sanity-decisions.md` deliberately keeps smoke and sanity in one job to reuse stack startup. Separate classification and reporting do not automatically require separate jobs.
- The existing branch protection guidance requires only `ci-status`. Any split must preserve aggregation of required checks and correct handling of change-aware skips.

## Classification model

### Exploration examples

- `apps/api/test/supplier-order-module.e2e-spec.ts` builds a Nest module with mocked SDK/cache/fetch dependencies. It is component integration despite its E2E filename.
- `apps/api/test/booking-readiness.performance.e2e-spec.ts` combines an HTTP application, Prisma/database access, warmup, and measured samples. It is infrastructure-backed API performance testing.
- The original agent markers covered Redis integration and security, without a separate performance slice. `apps/agent/tests/test_t098_agent_performance.py` contains both correctness and benchmark tests, so classification occurs per test.
- `apps/web/package.json` exposes broad Playwright testing and explicit compatibility file lists. Browser tests with intercepted APIs differ from the opt-in `chat-t093-real-flow.spec.ts` composed service flow.
- A timing assertion can protect correctness (for example, lock expiration or a ReDoS bound). Do not move every test using a clock into an optional benchmark job.

1. Boundary exercised: isolated logic, component/interface, infrastructure adapter, composed system.
2. Purpose: correctness, contract compatibility, performance, security.

Performance is a purpose rather than a system boundary: an isolated scanner benchmark and a full HTTP load test are both performance tests with different environments. Similarly, an HTTP test with mocked persistence is not proof of a database integration.

## Approved direction

The user approved independently runnable suites and named CI results for unit, interface/component, infrastructure integration/migration, and performance testing. Keep one required `ci-status` aggregate and preserve change-aware service routing.

Tests already required in CI remain required, including existing benchmarks. API E2E performance suites that were not previously run by CI do not automatically become PR blockers. Shared stack startup for smoke and critical flows remains shared.

## Documentation approach

Update operational testing guidance with the final commands and gates. Keep general testing terminology out of the business-domain glossary. Production behavior and assertions are outside this restructuring's scope.

## Result

- API CI: unit; interface (shared contracts, API compatibility contracts, component tests); infrastructure integration/migration; existing in-process performance.
- Web CI: isolated Node tests and frontend-only browser characterization, separate from lint/typecheck/build. App route contracts and T093 system acceptance have explicit additional commands.
- Agent CI: one primary lane per test (`agent_unit`, `agent_redis`, `agent_performance`). Dependency/purpose markers remain available. Required Redis skips fail in setup or test-body execution.
- Each changed service requires every applicable lane to succeed. `ci-status` remains the single required check, and smoke/critical flows keep one shared stack startup.
- Suite commands and prerequisites: [testing guide](../../context/testing.md). Visual job graph: [architecture](../../context/architecture.md#ci-verification-boundaries).

## Local verification

- API selectors: Jest's real `runCLI --listTests` proves all 206 previously required suites appear exactly once: 117 unit, 2 API contracts, 19 component/interface, 67 infrastructure integration, 1 existing fast performance. Optional performance selection retains both the fast benchmark and previously optional E2E benchmarks.
- API and web package typechecks/lint passed; Agent Ruff checks/format passed.
- Web isolated Node tests: 420 passed with the network guard. The previous 122-test compatibility selection also passed.
- Browser characterization: 14 of 16 passed. The booking redirect case timed out during navigation (`ERR_ABORTED`); the search selection case expected `/checkout/passengers?offerId=...` but observed `/checkout?offerId=...`. Causes were not established by this restructuring. The final runner reuses the existing Playwright configuration and lists all 16 cases. A focused search-form case passed through the final shared-config runner (1/1); this does not replace the full-run result.
- Agent original isolated lane: 1,290 passed, 4 skipped. All 4 added skip-guard regressions passed. Final strict collection with partition validation passed: 1,322 tests (1,298 isolated correctness, 15 Redis correctness, 9 performance).
- CI/status/security-filter/migration contract checks: 40 passed. Network-guard and smoke-runner checks: 25 passed. Workflow YAML parses; local `actionlint` is unavailable.
- Focused API infrastructure check: all 18 supplier-sync tests passed against a fresh disposable PostgreSQL database after all 25 migrations. Disposable PostgreSQL/Redis containers were removed; existing application containers were retained.
- Agent Redis correctness: 14 passed in the full lane; one bounded-wait test exceeded its unchanged 4-second upper bound during concurrent local checks (4.49 seconds). That test passed when rerun alone.
- Agent performance lane: 7 passed, 2 failed against unchanged latency assertions on this Windows host: `test_cold_initialization_vs_warm_execution` and `test_t098_lua_admission_latency_benchmark` (Redis Lua p95 40.165 ms versus 10 ms). These results are exposed by the performance lane rather than hidden in unit coverage.

## Existing optional web route-suite failure

All Node tests remain runnable through `test:node`: 420 isolated tests plus 64 app route-contract tests. The route selection contains 56 locally failing cases in `app/api/booking-management/route-parity.spec.ts`; its `createRequire().cache` mocks do not intercept the routes' ESM imports, so real backend-client authorization returns 401 instead of the mocked responses. The other 8 route cases pass.

This route selection was not in previous required CI and remains a separate optional command (`test:route-contracts`). The failure was reproduced using the installed `tsx` CLI, then work on fixing those mocks stopped under the repository's repeated-failure rule. The user was asked whether to fix the mocks or retain the optional suite; the split preserves the previous gating scope while that additional fix is undecided. No failing test is silently removed from the aggregate.

## Verification limits

The full API runtime matrix, T093 composed-system acceptance, and remote GitHub Actions run were not rerun. Existing benchmark assertions, sample counts, and ceilings were retained. Local timing failures are recorded rather than waived or relabeled as passes.
