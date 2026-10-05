# Testing and Verification Guide

Comprehensive instructions for writing, running, and verifying tests across the Flight Booking System codebase, including E2E test suites, runner workflows, mocking strategies, Playwright guidelines, and the pre-PR local gate validation matrix.

---

## E2E Testing Instructions

When the task involves writing, running, or verifying E2E tests:

1. **Locating E2E Tests**:
   - Backend NestJS API E2E tests reside in `apps/api/test/` (e.g., `*.e2e-spec.ts`).
   - Frontend Next.js Playwright UI tests reside in `apps/web/tests/` (e.g., `*.spec.ts`).

2. **Configuration**:
   - Backend E2E uses Jest, configured in `apps/api/test/jest-e2e.json`.
   - Frontend E2E uses Playwright, configured in `apps/web/tests/playwright.config.ts`.

3. **Running E2E Tests**:
   - Backend API E2E tests: run `npm run test:e2e --workspace=apps/api`
   - Frontend Playwright E2E tests: run `npx playwright test --config=apps/web/tests/playwright.config.ts`
   - **Verified T093 workflow (PowerShell)**: use the direct workspace binaries below. The T093 Playwright configuration starts the installed Next CLI directly so Windows does not recurse into an implicit `pnpm install`.

     ```powershell
     docker compose up -d

     Push-Location apps/api
     & '.\node_modules\.bin\prisma.CMD' generate
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

Always verify the change-aware service chains locally before opening or updating PRs:

- **Static Contract**: `node --test tests/ci/ci-workflow.contract.test.mjs`
- **API Gate**: `pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0` && `pnpm --filter @shared/types test` && `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit`
- **API Unit Tests**: `$env:NODE_OPTIONS = "--require=$PWD/tests/ci/node-network-guard.cjs"`; `pnpm --filter @api/backend test -- --runInBand`
- **Web Gate & Build**: `pnpm --filter @web/frontend lint` && `pnpm --filter @web/frontend typecheck` && `pnpm --filter @web/frontend build`
- **Agent Gate & Tests**: `$env:UV_CACHE_DIR = "c:\Booking Systems\.uv-cache"`; `uv run --package agent ruff check apps/agent` && `uv run --package agent ruff format --check apps/agent`; with `$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"` run `uv run --package agent pytest apps/agent/tests -m "not redis_integration"`
- **Windows agent timing gate**: If the guarded non-Redis suite repeatedly fails only SC-004 wall-time measurements while its isolated benchmark passes, verify the Python network guard and run the full suite once with `ABOVE_NORMAL_PRIORITY_CLASS` applied only to the Python process executing pytest; restore that process's previous class in `finally`. Keep the suite, sample counts, percentiles, and ceilings unchanged; do not use realtime or machine-wide priority changes. This is a host-specific measured timing mitigation, not a proven scanner regression. See the [T066 verification plan](../docs/superpowers/plans/2026-10-04-feature-029-agent-performance-fix.md) for the exact launcher and evidence.
- **Branch Protection Requirement**: Only require `ci-status` on branch protection rules for `development`.

---

## Remote CI Pipeline Triage & Convergence

When opening or updating pull requests, monitor remote CI runs and iterate on failures using the `ci-feedback-loop` skill ([`ci-feedback-loop`](../.agents/skills/ci-feedback-loop/SKILL.md)):
- **Inspect / Monitor CI**: Run `node .agents/skills/ci-feedback-loop/scripts/inspect-ci.mjs` (append `--watch` to poll in-progress runs until conclusion).
- **Triage & Convergence**: Map remote failing steps to local reproduction commands using the matrix above, remediate locally, push, and poll until remote conclusion is green.
