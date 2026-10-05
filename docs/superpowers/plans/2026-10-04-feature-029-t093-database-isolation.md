# T093 Database Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let T093's API webServer use the selected disposable `DATABASE_URL`, while retaining the current `test_db` default.

**Architecture:** The Playwright config will pass through `process.env.DATABASE_URL` for its API server and use the existing URL when the variable is unset. A temporary config-load assertion will import the actual TypeScript config through the installed API `ts-node` loader; it will not launch services or connect to a database.

**Tech Stack:** TypeScript, Playwright Test, Node.js, installed `ts-node` and `tsconfig-paths` loaders.

**Spec:** `specs/029-duffel-provider-narrowing/spec.md`; T093 phase-7 verification follow-up.

## Global Constraints

- Change only `apps/web/tests/playwright.config.ts`; preserve assertions, ports, timing, CI settings, and the existing fallback URL.
- Add no dependencies, lockfile changes, application/API source changes, or permanent test that mirrors this reversible config expression.
- The config-load probe must not start Playwright web servers or mutate a database.
- Run implementation and verification only after T059 has committed and the coordinator releases T067, so checks stay sequential with the API worker.
- If a Windows `.bin` wrapper fails, invoke the corresponding installed CLI JavaScript entry point with `node`; do not install packages.
- Keep `t067-isolation-report.md` as scratch evidence; commit only the config change and this plan.

---

### Task 1: Pass the selected database URL to T093's API server

**Files:**
- Modify: `apps/web/tests/playwright.config.ts` — the API entry in `webServer[].env`
- No permanent test file; use the transient config-load assertions below.

**Interfaces:**
- Consumes: `process.env.DATABASE_URL` from the test runner environment.
- Produces: `webServer[].env.DATABASE_URL` equal to that value, or the current `postgresql://postgres:postgres@127.0.0.1:5432/test_db` fallback.

- [ ] **Step 1: Observe RED with a synthetic phase-7 database URL**

Run in PowerShell from the workspace root. The API server config is selected by its T093 readiness URL; importing the config does not start it.

```powershell
Push-Location apps/api
$env:T093_REAL_FLOW = 'true'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/phase7_config_probe'
$probe = @'
const assert = require('node:assert/strict');
const config = require('../web/tests/playwright.config.ts').default;
const entries = Array.isArray(config.webServer)
  ? config.webServer
  : config.webServer
    ? [config.webServer]
    : [];
const api = entries.find((entry) => entry.url === 'http://127.0.0.1:3001/test/t093/ready');
assert.ok(api, 'T093 API server config must exist');
assert.equal(api.env?.DATABASE_URL, process.env.DATABASE_URL);
'@
$nodeArgs = @('-r', 'ts-node/register', '-r', 'tsconfig-paths/register')
$redOutput = node @nodeArgs -e $probe 2>&1
$redExitCode = $LASTEXITCODE
$redText = $redOutput -join [Environment]::NewLine
$redText
Pop-Location
if ($redExitCode -ne 1 -or $redText -notmatch 'AssertionError \[ERR_ASSERTION\]' -or $redText -notmatch 'phase7_config_probe' -or $redText -notmatch 'test_db') {
  throw 'RED must be the DATABASE_URL assertion mismatch, not a loader failure.'
}
```

Expected: Node exits with code `1` and `AssertionError [ERR_ASSERTION]`; the actual value is the existing `.../test_db` URL and the expected value ends in `/phase7_config_probe`. Save the captured output and exit code in `t067-isolation-report.md`. If the primary loader fails before reaching this assertion due to ts-node typechecking or project resolution, preserve and report that launcher failure, then retry the same probe using the installed transpile-only loader with project lookup disabled and explicit CommonJS/Node resolution:

```powershell
Push-Location apps/api
$env:TS_NODE_SKIP_PROJECT = 'true'
$env:TS_NODE_COMPILER_OPTIONS = '{"module":"CommonJS","moduleResolution":"Node"}'
$nodeArgs = @('-r', 'ts-node/register/transpile-only')
$redOutput = node @nodeArgs -e $probe 2>&1
$redExitCode = $LASTEXITCODE
$redText = $redOutput -join [Environment]::NewLine
$redText
Pop-Location
if ($redExitCode -ne 1 -or $redText -notmatch 'AssertionError \[ERR_ASSERTION\]' -or $redText -notmatch 'phase7_config_probe' -or $redText -notmatch 'test_db') {
  throw 'Fallback RED must be the DATABASE_URL assertion mismatch.'
}
```

- [ ] **Step 2: Make the single-expression config change**

In the API server's `env` object, change the `DATABASE_URL` value from the current literal to:

```ts
// User-approved 2026-10-04: T093's API server and Prisma assertions must use the same disposable DATABASE_URL for phase-7 isolation.
DATABASE_URL:
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/test_db',
```

- [ ] **Step 3: Verify the synthetic override and unchanged fallback**

Keep the PowerShell session from Step 1 open so `$probe` and the loader selected there remain available. Repeat the config load from `apps/api` with these environment values, capturing `$LASTEXITCODE` before `Pop-Location`:

```powershell
Push-Location apps/api
$env:T093_REAL_FLOW = 'true'
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/phase7_config_probe'
$greenOutput = node @nodeArgs -e $probe 2>&1
$greenExitCode = $LASTEXITCODE
$greenText = $greenOutput -join [Environment]::NewLine
$greenText
Pop-Location
if ($greenExitCode -ne 0) { throw 'T093 API config did not honor the supplied DATABASE_URL.' }
```

Expected: exit code `0`; save the captured output and exit code in `t067-isolation-report.md`.

Then verify the fallback in a fresh config load with `DATABASE_URL` unset:

```powershell
Push-Location apps/api
$env:T093_REAL_FLOW = 'true'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
$defaultProbe = @'
const assert = require('node:assert/strict');
const config = require('../web/tests/playwright.config.ts').default;
const entries = Array.isArray(config.webServer)
  ? config.webServer
  : config.webServer
    ? [config.webServer]
    : [];
const api = entries.find((entry) => entry.url === 'http://127.0.0.1:3001/test/t093/ready');
assert.ok(api, 'T093 API server config must exist');
assert.equal(api.env?.DATABASE_URL, 'postgresql://postgres:postgres@127.0.0.1:5432/test_db');
'@
$defaultOutput = node @nodeArgs -e $defaultProbe 2>&1
$defaultExitCode = $LASTEXITCODE
$defaultText = $defaultOutput -join [Environment]::NewLine
$defaultText
Pop-Location
if ($defaultExitCode -ne 0) { throw 'The default T093 DATABASE_URL fallback changed.' }
```

- [ ] **Step 4: Run the requested web checks and discover T093 without starting services**

```powershell
Push-Location apps/web
& '.\node_modules\.bin\tsc.CMD' --noEmit
if ($LASTEXITCODE -ne 0) { throw 'Web typecheck failed.' }
& '.\node_modules\.bin\next.CMD' lint
if ($LASTEXITCODE -ne 0) { throw 'Web lint failed.' }
Pop-Location

$env:T093_REAL_FLOW = 'true'
& '.\apps\web\node_modules\.bin\playwright.CMD' test 'apps/web/tests/chat-t093-real-flow.spec.ts' --config='apps/web/tests/playwright.config.ts' --list
if ($LASTEXITCODE -ne 0) { throw 'T093 Playwright test discovery failed.' }
```

If a wrapper fails, run the installed entry point directly, preserving the same working directory and arguments:

```powershell
Push-Location apps/web
node '.\node_modules\typescript\bin\tsc' --noEmit
if ($LASTEXITCODE -ne 0) { throw 'Web typecheck failed.' }
node '.\node_modules\next\dist\bin\next' lint
if ($LASTEXITCODE -ne 0) { throw 'Web lint failed.' }
Pop-Location

$env:T093_REAL_FLOW = 'true'
node '.\apps\web\node_modules\@playwright\test\cli.js' test 'apps/web/tests/chat-t093-real-flow.spec.ts' --config='apps/web/tests/playwright.config.ts' --list
if ($LASTEXITCODE -ne 0) { throw 'T093 Playwright test discovery failed.' }
```

Expected: typecheck and lint exit `0`; `--list` discovers the T093 test and exits `0` without starting webServer processes. Do not run the full Playwright flow for this config-only change. Record each command, exit code, test discovery count, and loader behavior in `t067-isolation-report.md`. Typecheck remains required.

- [ ] **Step 5: Commit only the config change and this plan**

```powershell
git diff --check -- apps/web/tests/playwright.config.ts
git add -- apps/web/tests/playwright.config.ts
git add -f -- docs/superpowers/plans/2026-10-04-feature-029-t093-database-isolation.md
git diff --cached --check
git diff --cached --name-only
git commit -m "test(web): honor T093 database override"
```

Before committing, confirm the staged file list contains only `apps/web/tests/playwright.config.ts` and this plan; leave all other workers' changes unstaged.
