# Whole-Stack Smoke and Sanity Test Harness

Authoritative documentation for the zero-dependency whole-stack smoke and sanity test harness.

---

## 1. Architecture & Scope

The smoke and sanity test harness provides an automated, fast, black-box verification gate that starts the complete application stack (PostgreSQL, Redis, NestJS API, Next.js Web, FastAPI Agent, and a local mock server) to validate end-to-end integration and core business flows without calling external third-party providers or running LLM inference.

### Core Design Principles

- **Zero External Test Dependencies**: Built entirely with Node.js built-in modules (`node:test`, `fetch`, `node:http`, and `node:child_process`). No external test runner or assertions library is imported.
- **No Application Internal Imports**: Black-box execution over public HTTP interfaces only. Does not import NestJS, Next.js App Router, FastAPI, Prisma, or Redis clients into test files.
- **Mock Boundary & Air Gap**: Standalone HTTP mock server (`node:http`) intercepts Duffel flight APIs and Stripe payment APIs on loopback. The loopback network guard ensures zero outbound network traffic to real providers.
- **Strict Sequential Lifecycle**:
  1. **Infrastructure / Builds**: PostgreSQL, Redis started via Docker Compose; shared packages and services built; Prisma migrations deployed.
  2. **Process Boot**: Mock server + NestJS API + FastAPI Agent + Next.js Web processes spawned.
  3. **Concurrent Readiness Polling**: All service endpoints probed concurrently every 2 seconds until healthy or bounded deadline reached.
  4. **Smoke Suite**: 8 broad whole-stack checks executed via `node:test` (`<15s`). Smoke failure gates sanity execution immediately.
  5. **Sanity Suite**: Narrow deterministic business flows (search/cache, booking lifecycle, agent-gateway authentication) executed (`<60s`).
  6. **Unconditional Process Cleanup**: Harness child processes and services terminated unconditionally in a `finally` block on both success and failure.

### Sanity Suite Flow Groups & Scope

While the smoke suite provides rapid, surface-level connectivity checks across the entire stack in under 15 seconds, the **Sanity Suite** performs deep, deterministic verification of core business flows and security invariants in under 60 seconds without invoking real third-party providers or LLM inference.

The sanity suite is structured into three discrete, sequential flow groups executed against a shared authenticated actor:

1. **Group 1: Flight Search & Cache Suppression**
   - **Contract Verification**: Validates public `POST /api/flights/search` response shape against strict DTO schemas (verifying essential offer fields including `id`, `airline`, `flightNumber`, `departureAirport`, `arrivalAirport`, `departureTime`, `arrivalTime`, `duration`, `price`, `currency`, `segments`, and metadata).
   - **Cold-to-Warm Redis Transition**: Proves the cache lifecycle by performing an initial cold search against the Duffel mock (`meta.cached === false`), followed by an identical repeated search retrieving data directly from Redis (`meta.cached === true`).
   - **Search Hash Parity**: Compares normalized response envelopes (`normalizeCacheEnvelope`) to ensure identical offer results and deterministic search hash parity between cold and warm queries.
   - **Zero Supplier Calls Guarantee**: Inspects mock provider counters (`POST /air/offer_requests`) to verify that repeated searches result in zero additional external supplier requests.
   - **Offer Passenger Identity Capture**: Dispatches `GET /api/flights/:id` to retrieve authoritative offer passenger IDs (`passengers[0].id`) required for canonical booking readiness and intent creation.

2. **Group 2: Confirmed Booking Happy Path**
   - **Traveler Profile Upsert & Revision Tracking**: Inspects the actor's initial profile revision via `GET /api/profile`, submits full traveler details (identity, contact, travel document) via `PATCH /api/profile` with optimistic concurrency control (`expectedRevision`), and asserts that the revision number increments monotonically.
   - **Advisory Booking Readiness Evaluation**: Dispatches an advisory pre-flight check via `POST /api/bookings/intents/readiness` binding the flight offer ID, passenger identity, and traveler profile revision to verify non-blocking readiness (`ready === true` or `status === 'READY'`).
   - **Canonical Booking Intent Creation**: Dispatches `POST /api/bookings/intents` with search passenger identities and profile references, asserting the creation of a canonical intent with a valid UUID v4 `intentId` and expected lifecycle status (`DRAFT`, `PENDING`, or `AWAITING_PAYMENT`).
   - **Idempotent Payment Lifecycle**: Initiates payment via `POST /api/bookings/payment/create` with a unique `Idempotency-Key` header, capturing the resulting `paymentId`. Subsequently executes `POST /api/bookings/payment/confirm` using a distinct `Idempotency-Key` header and a freshly generated booking UUID to prevent idempotency key collisions between creation and confirmation stages.
   - **Bounded Async Polling & Confirmed Booking Assertion**: If the payment confirmation returns an asynchronous `PENDING` state, executes bounded polling against `GET /api/bookings/payment/:id/status` until reaching `SUCCEEDED` within a tight deadline. Concludes by querying `GET /api/bookings/:bookingId` to confirm the booking status is `CONFIRMED`, with a verified mock PNR reference (`MOCK123`) and valid total pricing.

3. **Group 3: Agent Communication & Gateway Authorization**
   - **Direct Agent Reachability (Zero-LLM)**: Probes the FastAPI Python agent directly via `GET /health/live` to guarantee HTTP reachability without triggering LLM inference or background guardrail evaluations.
   - **Cross-Service API-to-Agent Probe**: Probes NestJS `GET /api/health/agent` to verify internal service-to-service connectivity from the API backend to the agent daemon.
   - **Positive Gateway Query**: Dispatches an authorized request to `GET /api/agent-gateway/users/preferences` supplying valid service authentication (`X-Agent-API-Key`) and a cryptographically valid HMAC-SHA256 user claim (`X-User-Claim`), verifying successful retrieval of user preferences without bearer token sharing.
   - **Strict Negative Authorization Matrix**: Validates gateway defenses by verifying that missing/invalid API keys or claim tokens return HTTP 401, and forged/non-existent user claims return HTTP 403, without leaking secrets or credentials in diagnostic outputs.

---

## 2. Commands & Execution

### Implemented Harness Commands

The test harness exposes four runnable root scripts in `package.json`:

- **`pnpm test:smoke:units`**: Introduced in Phase 2 (Foundational Contracts & Test Seams)
- **`pnpm test:smoke`**: Introduced in Phase 3 (User Story 1: Whole-Stack Readiness Gate)
- **`pnpm test:sanity`**: Introduced in Phase 4 (User Story 2: Deterministic Business Flows) — executes deterministic business flows (search/cache suppression, booking happy path, agent gateway dual-guard auth) in < 60s
- **`pnpm test:smoke:all`**: Introduced in Phase 5 (User Story 3: Orchestration & Reproducibility) — executes complete lifecycle (boot, ready, smoke, sanity, cleanup)

| Command                 | Underlying Execution                                                                                                              | Description                                                                                                                | Target Phase / Status |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `pnpm test:smoke:units` | `node --test tests/smoke/wait-for-ready.unit.test.mjs tests/smoke/mock-server.unit.test.mjs tests/smoke/test-utils.unit.test.mjs` | Runs unit test suites for harness utilities, mock server, and readiness polling                                            | Phase 2 (Implemented) |
| `pnpm test:smoke`       | `node --test --test-reporter=spec tests/smoke/smoke.test.mjs`                                                                     | Runs 8 whole-stack smoke checks against an already running stack                                                           | Phase 3 (Implemented) |
| `pnpm test:sanity`      | `node --test --test-reporter=spec tests/smoke/sanity.test.mjs`                                                                    | Runs deterministic business flow sanity checks (search/cache suppression, booking happy path, agent gateway auth) in < 60s | Phase 4 (Implemented) |
| `pnpm test:smoke:all`   | `node scripts/ci/run-smoke-sanity.mjs --mode=local`                                                                               | Runs complete orchestrator lifecycle (boot, ready, smoke, sanity, cleanup) in local mode                                   | Phase 5 (Implemented) |

### Full Orchestrator Scripts

> [!NOTE]
> The automated lifecycle orchestrator (`scripts/ci/run-smoke-sanity.mjs` and `pnpm test:smoke:all`) is implemented for Phase 5 (User Story 3). Developers can execute the full automated boot/readiness/smoke/sanity/cleanup lifecycle with `pnpm test:smoke:all` or execute smoke and sanity checks against a running stack using `pnpm test:smoke` and `pnpm test:sanity`.

The orchestrator manages the full lifecycle: log directory initialization, process boot, readiness polling, smoke execution, conditional sanity execution, diagnostic capture, and process cleanup.

Prerequisites are Docker with Compose, Node.js 20, pnpm 10.34.5, Python 3.11, uv 0.12.0, and dependencies installed from `pnpm-lock.yaml` and `uv.lock`. The shared package, API, and Web application must be built, and Prisma Client plus migrations must be current before the orchestrator starts services.

```bash
# Local mode (requires local Compose and dedicated smoke_test database)
pnpm test:smoke:all

# CI mode (runs inside GitHub Actions runner with ephemeral database)
node scripts/ci/run-smoke-sanity.mjs --mode=ci
```

### Environment-Specific Workflows

#### Local Environment Usage

1. **Start Infrastructure**:
   ```powershell
   docker compose up -d
   ```
2. **Prepare Dedicated Database**:
   Local execution requires a dedicated `smoke_test` database. Reset operations strictly refuse to run against any database name other than `smoke_test`.

   ```powershell
   $databaseExists = docker compose exec -T postgres psql -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='smoke_test'"
   if ($databaseExists.Trim() -ne '1') {
     docker compose exec -T postgres createdb -U postgres smoke_test
   }

   $env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/smoke_test?schema=public'
   pnpm --filter @api/backend prisma:generate
   pnpm --filter @api/backend exec prisma migrate deploy
   ```

3. **Install Locked Dependencies and Build Artifacts**:
   ```powershell
   pnpm install --frozen-lockfile
   uv sync --locked --package agent
   pnpm build:shared
   pnpm --filter @api/backend build
   pnpm --filter @web/frontend build
   ```
4. **Execute Complete Lifecycle**:
   ```powershell
   pnpm test:smoke:all
   ```
   To intentionally rebuild the dedicated database from migrations, pass the guarded local-only reset flag directly:
   ```powershell
   node scripts/ci/run-smoke-sanity.mjs --mode=local --reset-db
   ```
   `--reset-db` is rejected in CI mode and rejected unless the decoded database name is exactly `smoke_test`. Never point it at `flight_booking` or another persistent database.
5. **Run Against Already-Running Stack** (for iterative development):

   ```powershell
   # Run smoke checks
   pnpm test:smoke
   # Or direct Node command:
   node --test --test-reporter=spec tests/smoke/smoke.test.mjs

   # Run sanity checks (only if smoke passes)
   pnpm test:sanity
   # Or direct Node command:
   node --test --test-reporter=spec tests/smoke/sanity.test.mjs
   ```

6. **Tear Down Infrastructure**:
   ```powershell
   docker compose down
   ```
   The orchestrator always cleans up only the mock, API, Agent, Web, smoke, sanity, and optional reset processes it records. The local caller owns Docker Compose startup and teardown; the orchestrator does not stop local containers.

#### CI Environment Usage

In GitHub Actions (`.github/workflows/ci.yml`), the `smoke-and-sanity` job executes automatically on PRs targeting `development` when application, harness, workflow, or infrastructure paths change:

- Starts PostgreSQL and Redis with Docker Compose, waits for both to become ready, and removes their volumes during unconditional teardown.
- Runs `pnpm install --frozen-lockfile` and `uv sync --locked --package agent`, builds shared/API/Web artifacts, generates Prisma Client, and deploys migrations.
- Runs `node scripts/ci/run-smoke-sanity.mjs --mode=ci`.
- Automatically emits only privacy-safe Compose status and run-scoped diagnostic file names. CI does not print raw Compose, service, mock, stdout, or stderr log bodies; inspect raw files locally and review them before sharing.
- Unconditionally stops orchestrator-owned processes, then the workflow runs `docker compose down --volumes --remove-orphans` even after failures or cancellation.
- Reports status to `ci-status` aggregate gate.

---

## 3. Environment & Non-Production Secrets

Authoritative environment variable contract matching `specs/020-smoke-sanity-tests/contracts/test-harness.md`:

| Variable                | Consumer        | Contract                                                                      |
| ----------------------- | --------------- | ----------------------------------------------------------------------------- |
| `SMOKE_API_URL`         | tests/harness   | Defaults to `http://127.0.0.1:3001/api`                                       |
| `SMOKE_WEB_URL`         | tests/harness   | Defaults to `http://127.0.0.1:3000`                                           |
| `SMOKE_AGENT_URL`       | tests/harness   | Defaults to `http://127.0.0.1:3002`                                           |
| `SMOKE_MOCK_URL`        | tests/harness   | Required loopback URL in CI (e.g., `http://127.0.0.1:4010`)                   |
| `DATABASE_URL`          | API/Prisma      | CI job database or local `smoke_test`; never default development DB for reset |
| `REDIS_URL`             | API/Agent       | Loopback Redis (`redis://127.0.0.1:6379`)                                     |
| `API_URL`               | Web server      | Private NestJS URL (`http://127.0.0.1:3001`)                                  |
| `AGENT_SERVICE_URL`     | API             | Loopback Agent URL (`http://127.0.0.1:3002`)                                  |
| `NESTJS_API_URL`        | Agent           | Loopback NestJS API URL (`http://127.0.0.1:3001/api`)                         |
| `DUFFEL_API_URL`        | API             | Loopback mock in smoke/sanity; real default when absent                       |
| `STRIPE_API_URL`        | API             | Loopback mock in smoke/sanity; Stripe default when absent                     |
| `AGENT_SERVICE_API_KEY` | API/Agent/tests | Shared non-production CI value                                                |
| `CLAIM_TOKEN_SECRET`    | API/Agent/tests | Shared non-production CI value                                                |
| `JWT_SECRET`            | API/Web/Agent   | Shared non-production CI value                                                |

> [!IMPORTANT]
> **Loopback Enforcement & Default Parity**:
>
> - All service and mock URLs supplied to the test harness must parse as valid loopback addresses (`127.0.0.1` or `localhost`).
> - Provider client adapters (`DuffelService`, `StripeService`) retain their production defaults when `DUFFEL_API_URL` or `STRIPE_API_URL` environment variables are omitted.
> - Smoke/sanity runs set both provider URLs to the local mock server and the network guard permits loopback only. They never call real providers or LLM inference.
> - All secret values used across the harness are deterministic, non-production test credentials. Real API keys or production secrets are never used; do not paste real values into this workflow or its diagnostics.

---

## 4. Data Isolation Rules

To avoid corrupting persistent local development data and prevent race conditions:

1. **CI Ephemeral Instances**:
   - In GitHub Actions, each job runs against fresh, transient PostgreSQL and Redis service containers that are discarded when the job ends.
2. **Dedicated Local `smoke_test` Database**:
   - Local runs must connect to a separate database strictly named `smoke_test` (e.g., `postgresql://postgres:postgres@127.0.0.1:5432/smoke_test?schema=public`).
   - The default development database (`flight_booking`) must never be used for smoke/sanity runs.
3. **Database Guardrails**:
   - Reset operations and migration scripts MUST parse `DATABASE_URL` and explicitly refuse execution if the database name is not strictly `smoke_test`.
   - Tests generate unique actor emails/identities per run to prevent collision even if a previous run was aborted.

---

## 5. Timing Budgets

The harness enforces strict timing boundaries to guarantee rapid feedback and prevent hanging CI pipelines:

| Phase                    | Timing Budget                 | Polling Interval | Failure Behavior                                                                       |
| ------------------------ | ----------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| **Concurrent Readiness** | $\le$ 120 seconds             | 2 seconds        | Aborts immediately on deadline; dumps per-service last-status diagnostics; skips tests |
| **Smoke Suite**          | < 15 seconds post-readiness   | N/A              | Exits non-zero; skips sanity suite; retains process logs                               |
| **Sanity Suite**         | < 60 seconds post-smoke       | N/A              | Exits non-zero; retains process logs                                                   |
| **Total Test Execution** | < 75 seconds (post-readiness) | N/A              | Strict failure gate on any timeout or uncaught rejection                               |

### Suite Timing Budget & Zero-LLM Invariant Enforcement

- **Strict 60-Second Sanity Ceiling**: The sanity suite enforces a strict `SUITE_TIMEOUT_MS = 60000` limit. Elapsed time is measured across every check (`runSafeCheck`) and confirmed in an `after()` hook.
- **Dynamic Request Timeout Allocation**: To prevent late-running operations from hanging tests as the suite approaches its budget, `getRemainingTimeoutMs(maxRequestMs)` dynamically scales per-request HTTP timeouts (`Math.min(maxRequestMs, remaining)`).
- **Zero-LLM Guarantee**: Both smoke and sanity suites enforce a strict zero-LLM air gap. Sanity suite assertions verify zero outbound calls to endpoints matching `/chat`, `/completions`, `mimo`, or `llm`. Agent reachability and gateway authorization rely solely on deterministic, non-LLM HTTP probes (`/health/live` and `/api/agent-gateway/*`).

---

## 6. Diagnostics & Troubleshooting

### Readiness Probes Contract

All probes are executed concurrently every 2000 ms with a single shared 120000 ms deadline:

| Probe               | Endpoint                | Expected Result                                                           | Interpretation & Failure Diagnosis                                                                                                                                           |
| ------------------- | ----------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API Health**      | `GET /api/health`       | HTTP 200, `{"status":"ok","dependencies":{"database":"up","redis":"up"}}` | Verifies NestJS process is alive and connected to Postgres and Redis. Failure indicates DB/Redis container down, incorrect `DATABASE_URL`/`REDIS_URL`, or migration pending. |
| **Web Serving**     | `GET /`                 | HTTP 200, HTML body containing expected landing marker                    | Verifies Next.js App Router server is compiled and listening. Failure indicates build missing (`pnpm build`), Node memory pressure, or port 3000 collision.                  |
| **Web Upstream**    | `GET /health/upstream`  | HTTP 200, sanitized upstream health payload                               | Verifies Next.js server-side can reach NestJS API via private `API_URL`. Failure indicates `API_URL` misconfigured or NestJS network unreachable from Web server.            |
| **Agent Health**    | `GET /health`           | HTTP 200 (status may be `degraded` without Mimo)                          | Verifies FastAPI Agent server is listening. Note: status `degraded` is accepted for direct reachability since external LLM is disabled.                                      |
| **API $\to$ Agent** | `GET /api/health/agent` | HTTP 200                                                                  | Verifies NestJS can reach Agent lightweight no-LLM liveness endpoint. Failure indicates `AGENT_SERVICE_URL` misconfigured or Agent down.                                     |
| **Mock Server**     | `GET /__mock/health`    | HTTP 200                                                                  | Verifies local Duffel/Stripe mock HTTP server is listening on loopback. Failure indicates mock failed to bind port.                                                          |

### Smoke Suite Execution & 8-Check Mapping

The whole-stack smoke suite executes shallow, black-box verification across the running stack without third-party dependencies, internal application imports, or LLM inference.

#### Standalone Execution Command

```bash
# Run standalone smoke suite with spec reporter
pnpm test:smoke

# Equivalent underlying Node.js test command
node --test --test-reporter=spec tests/smoke/smoke.test.mjs
```

#### Execution Timing Budget

- **Budget**: `< 15 seconds` across the entire suite.
- **Enforcement**: Suite-level timeout (`SUITE_TIMEOUT_MS = 15000`) and individual check timeouts. Elapsed duration is measured and asserted after each check and across the entire suite.
- **Diagnostics**: Each check emits diagnostic timing via `t.diagnostic('[smoke] <check> finished in <ms> (suite elapsed: <ms>)')`.
- **Negative Privacy Guarantee**: All check errors are passed through `redactSensitive` before surfacing in reports, ensuring zero tokens, passwords, secrets, or PII can leak into logs.

#### Eight Named Smoke Checks

| #     | Check Name                        | Target Endpoint                                                                                 | HTTP Method               | Expected Success Contract                                                                                                                      | System Boundary Under Test                                                                      |
| ----- | --------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **1** | `API health and dependency shape` | `${SMOKE_API_URL}/health`                                                                       | `GET`                     | HTTP 200, `status === 'ok'`, `dependencies` object containing `database` and `redis` keys                                                      | NestJS API container & dependency health aggregator                                             |
| **2** | `Next.js homepage HTML`           | `${SMOKE_WEB_URL}/`                                                                             | `GET`                     | HTTP 200, HTML body contains landing marker (`wayfinder` or `landing-title`)                                                                   | Next.js Web App Router server-side compilation and rendering                                    |
| **3** | `Agent health HTTP reachability`  | `${SMOKE_AGENT_URL}/health`                                                                     | `GET`                     | HTTP 200, `status === 'ok'` or `status === 'degraded'` (reachability only, no LLM required)                                                    | FastAPI Python Agent HTTP service reachability                                                  |
| **4** | `PostgreSQL readiness`            | `${SMOKE_API_URL}/health`                                                                       | `GET`                     | Derived from API health: `dependencies.database === 'up'`                                                                                      | NestJS Prisma connection pool & PostgreSQL container query readiness                            |
| **5** | `Redis readiness`                 | `${SMOKE_API_URL}/health`                                                                       | `GET`                     | Derived from API health: `dependencies.redis === 'up'`                                                                                         | NestJS CacheService ping & Redis container reachability                                         |
| **6** | `Web upstream reachability`       | `${SMOKE_WEB_URL}/health/upstream`                                                              | `GET`                     | HTTP 200, `{ "status": "ok", "upstream": "up" }`                                                                                               | Next.js server-side to NestJS API upstream connectivity via private `API_URL`                   |
| **7** | `API-to-Agent reachability`       | `${SMOKE_API_URL}/health/agent`                                                                 | `GET`                     | HTTP 200, `{ "status": "ok" }`                                                                                                                 | NestJS AgentHealthService to FastAPI Agent lightweight no-LLM `/health/live` probe              |
| **8** | `Authentication round-trip`       | `${SMOKE_API_URL}/auth/register`<br>`${SMOKE_API_URL}/auth/login`<br>`${SMOKE_API_URL}/auth/me` | `POST`<br>`POST`<br>`GET` | Register returns 201 with JWT and unique user; Login returns 200 with JWT; Authenticated `GET /auth/me` returns matching user `id` and `email` | Database user persistence, bcrypt password hashing, JWT signing and verification, and AuthGuard |

#### Smoke Check Failure Diagnostics & Troubleshooting

| Failing Check                     | Likely Root Cause                                                                                    | Diagnostic Steps & Remediation                                                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Check 1: API health**           | NestJS not listening, wrong `SMOKE_API_URL`, or fatal startup exception                              | Check the run-scoped `api.stderr.log` and `api.stdout.log` or console output. Verify port 3001 is listening (`netstat -ano \| findstr :3001`). Verify `DATABASE_URL` and `REDIS_URL`. |
| **Check 2: Homepage HTML**        | Next.js not built (`pnpm --filter @web/frontend build`), port 3000 down, or error boundary triggered | Check the run-scoped `web.stderr.log` and `web.stdout.log`. Verify `apps/web/.next` exists. Verify Next.js is bound to port 3000.                                                     |
| **Check 3: Agent health**         | FastAPI Agent process down or wrong `SMOKE_AGENT_URL`                                                | Check the run-scoped `agent.stderr.log` and `agent.stdout.log`. Verify Python dependencies and uvicorn on port 3002.                                                                  |
| **Check 4: PostgreSQL readiness** | PostgreSQL container unready, down, or migrations not deployed                                       | Run `docker compose ps` to verify container `flight-postgres` is healthy. Run `pnpm --filter @api/backend exec prisma migrate status` to confirm migrations.                          |
| **Check 5: Redis readiness**      | Redis container down or unreachable on port 6379                                                     | Verify `docker compose ps` for `flight-redis`. Check `redis-cli ping` or verify `REDIS_URL=redis://127.0.0.1:6379`.                                                                   |
| **Check 6: Web upstream**         | Next.js cannot reach NestJS API via private `API_URL`                                                | Verify `API_URL` environment variable passed to Next.js (defaults to `http://127.0.0.1:3001`). Ensure NestJS `/api/health/ping` responds 200.                                         |
| **Check 7: API-to-Agent**         | NestJS cannot reach Agent `/health/live` endpoint                                                    | Verify `AGENT_SERVICE_URL` (defaults to `http://127.0.0.1:3002`). Test direct reachability of `http://127.0.0.1:3002/health/live`.                                                    |
| **Check 8: Auth round-trip**      | Prisma user table write failure, duplicate email, lockout rate limit, or invalid JWT signature       | Verify unique test actor creation (`createUniqueTestActor`). Reset lockout via `POST /api/auth/test/reset-lockout` if in test environment. Ensure `JWT_SECRET` is set.                |

### Sanity Suite Execution & Flow Mapping

The whole-stack sanity suite executes deep, deterministic verification across core business domains (flight search caching, traveler profile, booking lifecycle, idempotent payment confirmation, and agent gateway security) without third-party dependencies or LLM inference.

#### Standalone Execution Command

```bash
# Run standalone sanity suite with spec reporter
pnpm test:sanity

# Equivalent underlying Node.js test command
node --test --test-reporter=spec tests/smoke/sanity.test.mjs
```

> [!NOTE]
> **Execution Prerequisite**:
> The sanity suite runs against an already running stack and is gated by successful smoke execution (`pnpm test:smoke`). In automated CI pipelines (`scripts/ci/run-smoke-sanity.mjs`), sanity checks are skipped immediately if any smoke check fails.

#### Execution Timing Budget & Zero-LLM Invariant

- **Budget**: `< 60 seconds` across the entire sanity suite (`SUITE_TIMEOUT_MS = 60000`).
- **Enforcement**: Cumulative suite elapsed time is validated after each individual check and in an `after()` suite hook (`assert.ok(totalElapsed < SUITE_TIMEOUT_MS)`).
- **Dynamic Allocation**: Individual requests and payment status polling loops use dynamic timeout budgeting (`getRemainingTimeoutMs(maxMs)`), ensuring fast abort if remaining time is insufficient.
- **Diagnostics**: Each check emits step-level diagnostic timing:
  ```text
  [sanity] <check name> finished in <ms> (suite elapsed: <ms>)
  ```
- **Negative Privacy Guarantee**: All test errors pass through `redactSensitive` before surfacing in reports, ensuring zero tokens, passwords, secrets, or PII can leak into logs.
- **Zero-LLM Invariant**: Assertions at the end of the suite audit mock provider request logs to guarantee zero calls were made to LLM inference or chat endpoints (`/chat`, `/completions`, `mimo`, `llm`).

#### Deterministic Sanity Flow Groups & Checks

| Group       | Check Name                                               | Target Endpoint                                                                                           | HTTP Method                | Expected Success Contract                                                                                                                                            | System Boundary Under Test                                                     |
| :---------- | :------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------- | :------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------- |
| **Setup**   | `Register & authenticate unique test actor`              | `${SMOKE_API_URL}/auth/register`<br>`${SMOKE_API_URL}/auth/login`                                         | `POST`<br>`POST`           | Returns HTTP 201/200 with valid JWT `token` and `userId` for isolated test run                                                                                       | User auth, bcrypt hashing, Prisma user persistence                             |
| **Group 1** | `T029: Flight search contract assertion`                 | `${SMOKE_API_URL}/flights/search`                                                                         | `POST`                     | HTTP 200, results array $\ge 1$, valid offer shape (`id`, `airline`, `flightNumber`, `price`, `segments`), `meta.cached === false`, non-empty `meta.searchHash`      | Duffel mock integration, offer transformation, search metadata                 |
| **Group 1** | `T030: Redis cache suppression & search hash parity`     | `${SMOKE_API_URL}/flights/search`                                                                         | `POST`                     | HTTP 200, `meta.cached === true`, identical normalized results/searchHash, exactly 1 Duffel `POST /air/offer_requests` call (0 supplier calls on repeated search)    | Redis caching layer, search hash calculation, supplier suppression             |
| **Group 1** | `T031: Capture authoritative offer passenger identifier` | `${SMOKE_API_URL}/flights/:offerId`                                                                       | `GET`                      | HTTP 200, extracts `passengers[0].id`, records Duffel `GET /air/offers/:id` mock call                                                                                | Offer retrieval, passenger identifier extraction for booking                   |
| **Group 2** | `T033: Traveler profile upsert & readiness evaluation`   | `${SMOKE_API_URL}/profile`<br>`${SMOKE_API_URL}/profile`<br>`${SMOKE_API_URL}/bookings/intents/readiness` | `GET`<br>`PATCH`<br>`POST` | Profile revision increments monotonically; advisory readiness evaluates to `ready === true` or `status === 'READY'`                                                  | Traveler profile service, revision control, pre-booking validation             |
| **Group 2** | `T034: Canonical booking intent creation`                | `${SMOKE_API_URL}/bookings/intents`                                                                       | `POST`                     | HTTP 201/200, valid UUID v4 `intentId`, status is `DRAFT`, `PENDING`, or `AWAITING_PAYMENT` binding search passenger identity                                        | Booking intent state machine, passenger-profile binding                        |
| **Group 2** | `T035: Idempotent payment creation & confirmation`       | `${SMOKE_API_URL}/bookings/payment/create`<br>`${SMOKE_API_URL}/bookings/payment/confirm`                 | `POST`<br>`POST`           | Both endpoints succeed using distinct `Idempotency-Key` UUIDs; creates payment intent and dispatches confirmation with booking UUID                                  | Stripe mock payment processing, idempotency key handling, payment confirmation |
| **Group 2** | `T036: Bounded payment polling & confirmed booking`      | `${SMOKE_API_URL}/bookings/payment/:id/status`<br>`${SMOKE_API_URL}/bookings/:bookingId`                  | `GET`<br>`GET`             | Bounded polling for `SUCCEEDED` status; confirmed booking query returns `status === 'CONFIRMED'`, PNR reference `MOCK123`, and total price                           | Async payment settlement, Duffel order placement, owner-visible booking state  |
| **Group 3** | `T037: Direct Agent health & API-to-Agent liveness`      | `${SMOKE_AGENT_URL}/health/live`<br>`${SMOKE_API_URL}/health/agent`                                       | `GET`<br>`GET`             | HTTP 200 on both direct Agent liveness and NestJS cross-service proxy without invoking LLM inference                                                                 | FastAPI Agent HTTP service, NestJS AgentHealthService                          |
| **Group 3** | `T038: Authorized Agent Gateway user query`              | `${SMOKE_API_URL}/agent-gateway/users/preferences`                                                        | `GET`                      | HTTP 200, returns user preferences matching `UserPreferencesDto` using valid `X-Agent-API-Key` and HMAC-signed `X-User-Claim`                                        | Agent Gateway dual-guard authorization, claim token verification               |
| **Group 3** | `T039: Strict negative gateway authorization checks`     | `${SMOKE_API_URL}/agent-gateway/users/preferences`                                                        | `GET`                      | Rejects missing/invalid API key (HTTP 401 `INVALID_API_KEY`), missing claim (HTTP 401 `INVALID_CLAIM_TOKEN`), and non-existent user claim (HTTP 403 `USER_INACTIVE`) | Gateway security perimeter, error code semantics, constant-time validation     |
| **Guard**   | `T040: Suite timing & zero-LLM audit`                    | `${SMOKE_MOCK_URL}/__mock/requests`                                                                       | `GET`                      | Total suite elapsed time $< 60000$ ms; mock request log contains zero calls matching `/chat`, `/completions`, `mimo`, or `llm`                                       | Timing enforcement, air-gap guarantee, zero-LLM invariant                      |

#### Gateway Security & Authorization Error Semantics

The Agent Gateway exposes read-only and delegated operational interfaces to the FastAPI Agent service without distributing long-lived user credentials or bearer tokens. It enforces a strict dual-guard defense-in-depth model:

```text
Incoming Request ────► [AgentApiKeyGuard] ────► [ClaimTokenGuard] ────► Controller / Service
                     • X-Agent-API-Key         • X-User-Claim
                     • Constant-time equality  • HMAC-SHA256 signature
                     • AGENT_SERVICE_API_KEY   • Keyring validation
                                               • Timestamp TTL (≤ 300s)
                                               • DB User status === 'ACTIVE'
```

1. **Dual Header Security Architecture**:
   - **`X-Agent-API-Key`**: Authenticates the calling service daemon. Validated by `AgentApiKeyGuard` using constant-time buffer comparison (`crypto.timingSafeEqual`) against `AGENT_SERVICE_API_KEY` to eliminate timing side-channel attacks.
   - **`X-User-Claim`**: Authenticates user context delegation. Formatted as `<base64url(payload)>.<base64url(signature)>` where payload contains `{ userId: string, iat: number }`. Validated by `ClaimTokenGuard` and `ClaimTokenService` using HMAC-SHA256 against candidate secret key rings (`CLAIM_TOKEN_SECRET`). Rejects tokens older than 300 seconds (`CLAIM_TOKEN_TTL_SECONDS`). Requires database lookup verifying that the user exists and holds active status (`status === 'ACTIVE'`).

2. **Negative Authorization Error Semantics Matrix**:

| Scenario                     | Request Headers                                       | HTTP Status  | Error Code (`code`)   | Response Message (`message`)               | Diagnostic Behavior                                            |
| :--------------------------- | :---------------------------------------------------- | :----------- | :-------------------- | :----------------------------------------- | :------------------------------------------------------------- |
| **Missing API Key**          | No `X-Agent-API-Key`                                  | **HTTP 401** | `INVALID_API_KEY`     | `"Missing API key"`                        | Warning logged; request halted before claim evaluation         |
| **Invalid API Key**          | `X-Agent-API-Key: invalid-key`                        | **HTTP 401** | `INVALID_API_KEY`     | `"Invalid API key"`                        | Constant-time failure; zero secrets or expected lengths leaked |
| **Missing Claim Token**      | Valid API key, no `X-User-Claim`                      | **HTTP 401** | `INVALID_CLAIM_TOKEN` | `"Missing or invalid X-User-Claim header"` | Fails fast at `ClaimTokenGuard`                                |
| **Malformed Claim Token**    | Valid API key, non-two-part claim                     | **HTTP 401** | `INVALID_CLAIM_TOKEN` | `"Malformed claim token"`                  | Rejects tokens not conforming to `payload.signature`           |
| **Invalid Claim Signature**  | Valid API key, tampered/forged signature              | **HTTP 401** | `INVALID_CLAIM_TOKEN` | `"Invalid claim token signature"`          | Constant-time HMAC verification mismatch                       |
| **Expired Claim Token**      | Valid API key, valid signature, `iat` > 300s old      | **HTTP 401** | `INVALID_CLAIM_TOKEN` | `"Claim token has expired"`                | Rejects stale user delegation claims                           |
| **Non-Existent User Claim**  | Valid API key, valid signature, non-existent UUID     | **HTTP 403** | `USER_INACTIVE`       | `"User not found"`                         | Database lookup fails; forbidden access returned               |
| **Inactive / Disabled User** | Valid API key, valid signature, `status !== 'ACTIVE'` | **HTTP 403** | `USER_INACTIVE`       | `"User account is inactive"`               | Account suspended/inactive; forbidden access returned          |

3. **Negative Privacy & Diagnostic Redaction Guarantee**:
   - **Zero Credential Leaks**: Authorization headers, bearer tokens, passwords, credit card numbers, and HMAC claim secrets are never logged or exposed in diagnostic outputs.
   - **Diagnostic Error Sanitization**: All test failures caught during sanity execution pass through `redactSensitive` before surfacing in reports, stripping authorization headers and sensitive patterns.
   - **Mock Control Sanitization**: Mock server control routes (`GET /__mock/requests`) strictly return sanitized route summaries (method, pathname, count, timestamp), never recording or returning request bodies, headers, or client tokens.

#### Sanity Check Failure Diagnostics & Troubleshooting

| Failing Flow / Check                         | Likely Root Cause                                                                           | Diagnostic Steps & Remediation                                                                                                                                                   |
| :------------------------------------------- | :------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Group 1: Flight Search (T029)**            | Mock server down on port 4010, missing flight route fixtures, or invalid search DTO payload | Check the run-scoped `mock.stderr.log` and `mock.stdout.log` for unhandled Duffel routes. Verify `SMOKE_MOCK_URL` and inspect API logs.                                          |
| **Group 1: Cache Suppression (T030)**        | Redis container down or NestJS cache service failed to store/retrieve search results        | Verify Redis container (`docker compose ps flight-redis`). Check `REDIS_URL`. Confirm mock server recorded exactly 1 `POST /air/offer_requests` call via `GET /__mock/requests`. |
| **Group 2: Profile Upsert (T033)**           | Revision conflict or validation failure on traveler document fields                         | Ensure `expectedRevision` matches current profile revision from `GET /api/profile`. Check passport expiration date is in the future.                                             |
| **Group 2: Booking Readiness (T033)**        | Missing passenger-to-profile mapping or invalid profile revision                            | Confirm `source.travelerProfileId` and `expectedProfileRevision` match the updated profile. Check the run-scoped API stdout/stderr logs for readiness validation errors.         |
| **Group 2: Booking Intent (T034)**           | Invalid UUID v4 format or offer passenger ID mismatch                                       | Confirm `flightOfferId` matches search offer and `offerPassengerId` matches the ID extracted in T031.                                                                            |
| **Group 2: Payment Creation/Confirm (T035)** | Reused idempotency key, Stripe mock failure, or invalid payment payload                     | Ensure distinct UUIDs are used for create and confirm `Idempotency-Key` headers. Check mock server logs for Stripe customer/payment-intent mock responses.                       |
| **Group 2: Confirmed Booking (T036)**        | Payment polling timed out or Duffel order placement mock failed                             | Check `pollPaymentStatus` attempts and status transitions. Verify Duffel mock `POST /air/orders` handled the order creation and returned `MOCK123`.                              |
| **Group 3: Agent Health (T037)**             | Python FastAPI process down or port 3002 blocked                                            | Verify FastAPI Agent is running (`uvicorn agent.main:app --port 3002`). Check the run-scoped `agent.stderr.log` and `agent.stdout.log`.                                          |
| **Group 3: Gateway Auth (T038/T039)**        | Mismatched `AGENT_SERVICE_API_KEY` or `CLAIM_TOKEN_SECRET` between API and test runner      | Verify environment variables match in both `.env` and test environment. Ensure HMAC tokens are signed with the current secret and timestamp within 300 seconds.                  |
| **Guard: Zero-LLM Violation (T040)**         | An unexpected request triggered agent chat/completion routes                                | Inspect `GET /__mock/requests` log. Ensure sanity tests target only deterministic operational endpoints without triggering LLM fallback paths.                                   |
| **Guard: 60s Timeout Exceeded**              | Slow database query, prolonged payment polling, or resource starvation                      | Review per-check execution times emitted in diagnostic output. Optimize polling interval or investigate machine CPU load.                                                        |

### Diagnostic Log Inspection (`.smoke-diagnostics/`)

Each orchestrator run writes isolated files under `.smoke-diagnostics/<run-id>/`:

- `mock.stdout.log` and `mock.stderr.log`
- `api.stdout.log` and `api.stderr.log`
- `agent.stdout.log` and `agent.stderr.log`
- `web.stdout.log` and `web.stderr.log`
- `smoke.stdout.log` and `smoke.stderr.log`
- `sanity.stdout.log` and `sanity.stderr.log`
- `database-reset.stdout.log` and `database-reset.stderr.log` only when guarded local `--reset-db` is used

> [!CAUTION]
> **PII and Secret Redaction**:
> Harness and suite failures pass through `redactSensitive` before they are surfaced, and mock control routes never record or return request bodies or authorization headers. Service stdout/stderr should still be reviewed before sharing. The harness uses only deterministic non-production credentials and loopback provider mocks; never supply real secrets.

GitHub Actions prints only service status and diagnostic file paths automatically. It never emits raw diagnostic bodies. Open the run-scoped files locally when troubleshooting, review them for sensitive data, and share only the minimum sanitized excerpt needed.

### Common Startup & Readiness Failures

1. **Port Conflicts**:
   - Ports `3000` (Web), `3001` (API), `3002` (Agent), `5432` (Postgres), `6379` (Redis), or `4010` (Mock) are already bound by background processes.
   - _Fix_: Check running processes (`netstat -ano | findstr :3000` or `Get-Process`) and terminate conflicting tasks.
2. **Missing Build Artifacts**:
   - `apps/web/.next` or `apps/api/dist` missing before running orchestrator in CI or local mode.
   - _Fix_: Execute `pnpm build:shared`, `pnpm --filter @api/backend build`, and `pnpm --filter @web/frontend build`.
3. **Database Unready / Migration Error**:
   - Prisma Client out of sync with migrations or database unreachable.
   - _Fix_: Run `pnpm --filter @api/backend prisma:generate` and `pnpm --filter @api/backend exec prisma migrate deploy`.
4. **Premature Child Process Termination**:
   - If any service process exits unexpectedly during readiness polling, the orchestrator immediately halts polling, logs the exit code and stderr tail, and exits with a non-zero status.

### Cleanup Behavior

- All child processes (mock, API, agent, web) are tracked by PID.
- Process cleanup is registered on `SIGINT`, `SIGTERM`, `exit`, and uncaught rejections.
- On Windows and Unix, process trees are terminated gracefully first (`SIGTERM`), escalating to forced termination (`SIGKILL` / `taskkill /F /T`) if processes do not exit within 5 seconds.
- The orchestrator guarantees that no orphaned mock or application servers remain running after a test run concludes or fails.
