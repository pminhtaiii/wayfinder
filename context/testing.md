# Testing and Verification Guide

Comprehensive instructions for writing, running, and verifying tests across the Flight Booking System codebase, including E2E test suites, runner workflows, mocking strategies, Playwright guidelines, and the pre-PR local gate validation matrix.

For coordinated runs, keep raw test logs and generated review output in the current session dump, then put concise results and evidence paths in the canonical verification record. See [Session artifact dumps](workflow.md#session-artifact-dumps).

---

## E2E Testing Instructions

When the task involves writing, running, or verifying E2E tests:

1. **Locating E2E Tests**:
   - Backend NestJS API E2E tests reside in `apps/api/test/` (e.g., `*.e2e-spec.ts`).
   - Frontend Next.js Playwright UI tests reside in `apps/web/tests/` (e.g., `*.spec.ts`).

2. **Configuration**:
   - Backend E2E uses Jest, configured in `apps/api/test/jest-e2e.json`.
   - Frontend E2E uses Playwright, configured in `apps/web/tests/playwright.config.ts`.
   - Playwright run artifacts use per-config folders under `.agent-work/test_results/` (`default`, `ancillary`, `state`, and `fulfillment`) so concurrent suites do not clean one another's output.

3. **Running E2E Tests**:
   - Backend API E2E tests: run `npm run test:e2e --workspace=apps/api`
   - Frontend Playwright E2E tests: run `npx playwright test --config=apps/web/tests/playwright.config.ts`
   - **Verified T093 workflow (PowerShell)**: use the direct workspace binaries below. The T093 Playwright configuration starts the installed Next CLI directly so Windows does not recurse into an implicit `pnpm install`.

     ```powershell
     docker compose up -d

     pnpm build:shared
     pnpm --filter @api/backend prisma:generate

     Push-Location apps/api
     $env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
     & '.\node_modules\.bin\prisma.CMD' migrate status
     Pop-Location

     & '.\node_modules\.bin\tsx.CMD' --test `
       apps/web/tests/handoff-bootstrap-acceptance.unit.ts `
       apps/web/tests/handoff-bootstrap.unit.ts `
       apps/web/tests/handoff-form-submission.unit.ts `
       apps/web/tests/handoff-checkout-proxy.unit.ts `
       apps/web/tests/handoff-cookie.unit.mts

     Push-Location apps/api
     & '.\node_modules\.bin\jest.CMD' --runInBand `
       src/chat-handoff/chat-handoff.service.spec.ts `
       src/chat-handoff/booking-handoff.controller.spec.ts
     Pop-Location

     Push-Location apps/web
     $env:NEXTAUTH_SECRET = 'local-build-only'
     $env:NEXTAUTH_URL = 'http://localhost:3000'
     $env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3001'
     $env:NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS = 'true'
     $env:NEXT_PUBLIC_FEATURE_FLAG_CHAT_HANDOFF = 'true'
     $env:NEXT_PUBLIC_AGENT_URL = 'http://127.0.0.1:3002'
     node node_modules/next/dist/bin/next build
     Pop-Location

     $env:UV_CACHE_DIR = 'C:\Booking Systems\.uv-cache'
     $env:T093_REAL_FLOW = 'true'
     $env:T093_TEST_TIMEOUT_MS = '600000'
     $env:T093_STREAM_TIMEOUT_MS = '300000'
     $env:T093_BROWSER_TIMEOUT_MS = '120000'
     $env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
     & '.\apps\web\node_modules\.bin\playwright.CMD' test `
       'apps/web/tests/chat-t093-real-flow.spec.ts' `
       --config='apps/web/tests/playwright.config.ts' `
       --reporter=line
     ```

     On Windows, run the full Playwright command in an environment that permits local service access and `taskkill` cleanup of Playwright-owned web-server trees; otherwise the assertions may finish while the runner hangs during teardown. Do not report T093 as passing without the final Playwright exit code `0`.

4. **Mocking & Test Strategy**:
   - Follow opaque-box verification strategies: validate system state through external HTTP APIs and UI flows.
   - Use time acceleration (`POST /auth/test/reset-lockout` when `NODE_ENV === 'test'`) and database assertions.

5. **Playwright Integration Guidelines**:
   - **Environment Configuration**: Ensure the Playwright webServer environment defines `NEXT_PUBLIC_API_URL` (defaults to `http://127.0.0.1:3001` in `playwright.config.ts`) to prevent compilation crashes during page loads.
   - **Bypass Strategy**: Inject `mock-scenario` cookies (such as `'disruption-detected'`) to bypass backend fetches in Server Components, prompting them to render static mocks directly.
   - **Strict Mode Bypass**: Avoid strict mode failures caused by the default Next.js route announcer (`role="alert"`) by appending `.first()` to alert locators (e.g., `page.getByRole('alert').first()`).
   - **Prevent Login Races**: After submitting registration or login forms, always wait for the browser to load the landing page (e.g., `await expect(page).toHaveURL(/.*localhost:3000\/$/)`) before attempting to navigate to authenticated/protected pages.
   - **Mocking Client Settings**: To verify behavior with missing or altered environment configurations without leaving mutable test hooks in production client bundles, fetch configuration options dynamically from a Next.js Server Route (e.g., `/api/config`) and use Playwright's `page.route` network interception in the test to mock the JSON response.

---

## Pre-PR Local Gate Validation Matrix

### Test suite boundaries

CI reports static validation separately from tests. The service suites are change-aware; `ci-status` remains the single required branch-protection check and rejects missing or unexpectedly skipped required lanes.

| Service / boundary | Local command | Dependencies |
| --- | --- | --- |
| API unit | `pnpm --filter @api/backend test:unit` | Mocked collaborators; no PostgreSQL/Redis service |
| API interface contracts | `pnpm --filter @api/backend test:contract` | Wire/snapshot compatibility fixtures |
| Shared interface contracts | `pnpm --filter @shared/types test` | Shared DTO/schema fixtures; API interface CI step |
| API component/interface | `pnpm --filter @api/backend test:component` | Nest module/adapter wiring and mocked infrastructure |
| API infrastructure integration | `pnpm --filter @api/backend test:integration` | Disposable PostgreSQL and Redis; generated Prisma client and migrated schema |
| API existing CI benchmarks | `pnpm --filter @api/backend test:performance:unit` | In-process benchmarks; required in CI |
| API full performance | `pnpm --filter @api/backend test:performance` | Also includes database-backed HTTP benchmarks; explicit local suite, not newly required in PR CI |
| Web unit/Node tests | `pnpm --filter @web/frontend test:unit` | Isolated Node/tsx tests outside `app/`; includes existing compatibility coverage |
| Web route contracts | `pnpm --filter @web/frontend test:route-contracts` | Node route-level interface tests; separately runnable, not newly required in CI |
| Web all Node tests | `pnpm --filter @web/frontend test:node` | Aggregate unit and route-contract suites |
| Web browser interface | `pnpm --filter @web/frontend test:interface` | Chromium and frontend only; characterization coverage |
| Web composed-system acceptance | `pnpm --filter @web/frontend test:system` | T093 disposable database, Redis, API, frontend, agent, local model fixture; opt-in acceptance |
| Agent isolated correctness | `uv run --package agent pytest apps/agent/tests -m agent_unit --strict-markers` | Mocked service collaborators |
| Agent Redis correctness | `uv run --package agent pytest apps/agent/tests -m agent_redis --strict-markers` | Dedicated disposable Redis database |
| Agent performance | `uv run --package agent pytest apps/agent/tests -m agent_performance --strict-markers` | Benchmarks; Redis for Redis-marked benchmarks |

API interface contracts and component tests have separate CI steps in one interface job. Database-backed API HTTP tests belong to infrastructure integration even if their filenames retain `e2e-spec`. Existing API `test`, `test:ci`, and `test:e2e` aggregate commands remain available for compatibility.

On a fresh checkout, build the shared package (`pnpm build:shared`) and generate the Prisma client with
`pnpm --filter @api/backend prisma:generate` before dispatching API test workers. Every CI API worker prepares its own
generated files after dependency installation. The generation, API build, and Jest package commands run through
`scripts/ci/run-api-task.mjs`, which holds `.scratch/api-task.lock` for the child process lifetime. This prevents Prisma
generation, build, and tests from overlapping in one checkout. The runner rejects a busy checkout and leaves recovery to
the caller: wait for the current task, or, after an unexpected exit, inspect the lock and verify that no API task is
still running before removing a stale lock. It does not kill the lock owner or reclaim locks automatically.
Direct Prisma generation, Nest build, and Jest invocations bypass this protection; use the API package scripts for those
tasks. Isolated API test tasks also remove inherited `DUFFEL_MOCK` and `DUFFEL_API_URL`
overrides from the child environment so component and unit results do not depend on an external supplier mock.
`pnpm --filter @api/backend test:partition` uses Jest's actual selectors to prove the previous required suite appears
exactly once in the new lanes and the optional performance aggregate retains both fast and database-backed benchmarks.

### API task runner and integration storage

The API integration runner does not start PostgreSQL or Redis, run migrations, or clean up shared services. Use
disposable loopback services whose database and Redis index are reserved for tests. Set `DATABASE_URL` to the app
database with its schema, `REDIS_URL` to an explicit disposable Redis index, and
`FULFILLMENT_HARNESS_ADMIN_DATABASE_URL` to the same PostgreSQL database without a `schema` query parameter. For the CI
integration service, these are
`postgresql://postgres:postgres@127.0.0.1:5432/fulfillment_recovery_test?schema=public`,
`redis://127.0.0.1:6379/0`, and
`postgresql://postgres:postgres@127.0.0.1:5432/fulfillment_recovery_test`, respectively. The workflow provisions those
disposable services and applies migrations before running integration tests; local callers must prepare their own.
Integration fixtures may create or remove their run-owned schemas and clear the selected Redis database, so never point
these URLs at shared or production storage.

Web Node discovery separates tests under `app/` (route contracts) from isolated tests elsewhere. The previous compatibility command remains available. The pre-existing `app/api/booking-management/route-parity.spec.ts` mock-loading failure is recorded in the [suite-separation decision record](../docs/adr/0017-ci-test-boundaries.md); it is exposed through the route-contract/all-Node commands and is not silently skipped or newly included in required PR CI.

Agent primary selectors are disjoint: Redis-backed performance tests run only in the performance lane. Existing `redis_integration` and `performance` markers describe dependencies/purpose; collection assigns one primary lane to each test. Set `CI_REQUIRE_REDIS_TESTS=1` for Redis correctness and `CI_REQUIRE_PERFORMANCE_TESTS=1` for performance to reject empty required selections and fail required Redis-backed skips. To validate classification without touching Redis, set `CI_VALIDATE_TEST_PARTITIONS=1` and run `uv run --package agent pytest apps/agent/tests --collect-only -q --strict-markers`; clear that flag before normal runs. Lock TTL/refresh and ReDoS termination assertions remain correctness checks; a clock assertion alone does not make a benchmark.

Apply the Node/Python network guards below to test commands. Use disposable storage: some Redis fixtures flush their selected Redis database. Smoke and critical business flows retain one shared stack startup and distinct suite results; existing external-vendor mocks and network restrictions remain active.

Before opening or updating a PR, run the applicable change-aware gates from the matrix below. Preserve stricter task-specific exit gates already documented.

For each check, report the actual command and final exit status, then mark it passed or failed. List applicable checks that were not run as unrun and give the reason. A focused pass establishes only the scope it exercised; it does not establish completion while other applicable gates remain.

- **Static Contract**: `node --test tests/ci/ci-workflow.contract.test.mjs`
- **API Gate**: Run `pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0` and `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit`. Shared contract tests run with the interface lane.
- **TypeScript escape guard**: Run `pnpm lint:types` for staged, unstaged, and untracked changes against `HEAD`. For an explicit branch diff, run `pnpm lint:types --base <base-ref>` (for example, `origin/development` when available). CI runs `node scripts/ci/check-type-escapes.mjs --base HEAD^1` in the API and web gates. See [TypeScript enforcement scope](code-standards.md#typescript).
- **API Tests**: `$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'`; run `test:unit`, `test:contract`, `test:component`, and `test:performance:unit` from the table. Run `test:integration` against prepared disposable storage. Keep the inner quotes around paths containing spaces and use forward slashes inside Node's option string to avoid escape parsing.
- **Web Gate & Build** (PowerShell): Run each command in order and stop on a nonzero exit code.
    ```powershell
    pnpm --filter @web/frontend lint
    if ($LASTEXITCODE -ne 0) { throw "Web lint failed with exit code $LASTEXITCODE" }

    pnpm --filter @web/frontend typecheck
    if ($LASTEXITCODE -ne 0) { throw "Web typecheck failed with exit code $LASTEXITCODE" }

    pnpm --filter @web/frontend build
    if ($LASTEXITCODE -ne 0) { throw "Web build failed with exit code $LASTEXITCODE" }
    ```
- **Agent Gate & Tests**: `$env:UV_CACHE_DIR = "C:\Booking Systems\.uv-cache"`; run `uv run --package agent ruff check apps/agent` and `uv run --package agent ruff format --check apps/agent`. With `$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"`, run the three selectors in the table; required Redis/performance flags belong only to their respective lane.
- **Windows agent timing gate**: If the guarded performance lane repeatedly fails only SC-004 wall-time measurements while its isolated benchmark passes, verify the Python network guard and run that lane once with `ABOVE_NORMAL_PRIORITY_CLASS` applied only to the Python process executing pytest; restore that process's previous class in `finally`. Keep the suite, sample counts, percentiles, and ceilings unchanged; do not use realtime or machine-wide priority changes. This is a host-specific measured timing mitigation, not a proven scanner regression. The [T066 verification plan](../docs/superpowers/plans/2026-10-04-feature-029-agent-performance-fix.md) records the original full-suite launcher and evidence before suite separation.
- **Branch Protection Requirement**: Only require `ci-status` on branch protection rules for `development`.

---

## Remote CI Pipeline Triage & Convergence

When opening or updating pull requests, monitor remote CI runs and iterate on failures using the `ci-feedback-loop` skill ([`ci-feedback-loop`](../.agents/skills/ci-feedback-loop/SKILL.md)):
- **Inspect / Monitor CI**: Run `node .agents/skills/ci-feedback-loop/scripts/inspect-ci.mjs` (append `--watch` to poll in-progress runs until conclusion).
- **Triage & Convergence**: Map remote failing steps to local reproduction commands using the matrix above, remediate locally, push, and poll until remote conclusion is green.
