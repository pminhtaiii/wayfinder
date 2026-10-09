# Research: Whole-Stack Smoke and Sanity CI

## Decision 1: Preserve the ADR's outcome, reconcile its assumed wire shapes

**Decision**: Treat `docs/adr/0018-cicd-smoke-sanity.md` as the scope authority, but bind the implementation to verified current public contracts. The plan records every mismatch rather than creating assertions for interfaces that do not exist.

**Rationale**: The ADR correctly defines the desired guarantees, ordering, timing, isolation, and no-real-provider constraints. Repository inspection found several assumed field names, directions, and status codes that differ from the running architecture.

**Alternatives considered**:

- Assert the ADR literally: rejected because tests would be impossible or would require an unjustified new authentication protocol.
- Rewrite the ADR: rejected because it is the historical owner-decision record; the feature artifacts should document reconciliation without altering it.

## Decision 2: Assert the existing API readiness contract

**Decision**: Smoke asserts `GET /api/health` returns HTTP 200 with `status: "ok"` and `dependencies.database: "up"`, `dependencies.redis: "up"`.

**Rationale**: `apps/api/src/health/health.controller.ts` already treats Postgres failure as `down`/503 and Redis failure as `degraded`/503. No separate database or Redis client is needed.

**Alternatives considered**:

- Assert `db/redis: connected`: rejected because those fields do not exist.
- Probe Postgres and Redis directly: rejected because it duplicates application readiness logic and adds dependencies.

## Decision 3: Separate web serving from web-to-API readiness

**Decision**: Keep `GET /` as the shallow Next.js serving check and add `GET /health/upstream` in `apps/web/app/health/upstream/route.ts`. The route performs a bounded, no-store server-side request to NestJS `/api/health/ping` and returns only a sanitized readiness result.

**Rationale**: The homepage is static and cannot prove frontend-to-API communication. A narrow operational route gives a stable public black-box contract without requiring a NextAuth browser session or coupling homepage availability to the API.

**Alternatives considered**:

- Authenticate through NextAuth and SSR-render `/bookings`: viable but brittle and conflates auth, booking, and readiness.
- Make the homepage fetch the API: rejected because it adds runtime coupling to the primary landing page.
- Place the route under `app/api/`: rejected to avoid expanding the project's tightly allowlisted `app/api/` exceptions.

## Decision 4: Test both real cross-service directions without inventing `X-Service-Auth`

**Decision**: Prove API-to-Agent reachability through a no-LLM liveness probe and prove service authorization through the existing Agent-to-API gateway contract: `X-Agent-API-Key` plus HMAC-signed `X-User-Claim`. Missing or invalid service keys assert 401; a valid service key with an unauthorized user claim asserts 403.

**Rationale**: No `X-Service-Auth` header exists. Current API `/health/agent` calls Agent `/health` without auth, while the real service-auth boundary is Agent-to-API. Invalid keys intentionally return 401; 403 occurs only after service authentication succeeds and the user claim is not authorized.

**Implementation reconciliation**: Add a lightweight Agent liveness endpoint that does not probe Mimo/guardrails, and have `AgentHealthService` call it. The existing detailed `/health` remains unchanged and can still report `degraded` without an LLM.

**Alternatives considered**:

- Add a brand-new `X-Service-Auth` protocol: rejected as duplicative production security surface.
- Treat Agent's detailed degraded health as unavailable: rejected because no-LLM CI would fail despite the process and required local dependencies being reachable.

## Decision 5: Add production-default-neutral provider URL seams

**Decision**: Add optional `DUFFEL_API_URL` and `STRIPE_API_URL` configuration in the existing provider wrappers. Defaults remain the current real provider endpoints. CI sets both to loopback; `tests/ci/node-network-guard.cjs` remains preloaded for Node processes.

**Rationale**: The ADR requires standalone validating mocks, secret-free tests, and no real traffic. Current Duffel and Stripe clients cannot target the mock server. Installed `@duffel/api` 4.x supports a `basePath` constructor option; Stripe 15.x supports host, port, and protocol configuration derived from one parsed URL. `DuffelService` must also use the configured URL for any manual raw order requests.

**Alternatives considered**:

- Keep `NODE_ENV=test` Duffel canned responses: rejected because the standalone mock would not validate requests or prove cache call counts.
- DNS/TLS/process monkeypatching: rejected as fragile and harder to diagnose.
- Inject an entirely new provider abstraction: rejected as unnecessary complexity for two existing wrappers.

## Decision 6: Use a dependency-free validating mock with observable counters

**Decision**: `tests/smoke/mocks/mock-server.mjs` uses `node:http`, method-plus-path routing, JSON and form parsing, deterministic fixtures, redacted request logs, required-field validation, 404 for unknown routes, and loopback-only control endpoints for reset/snapshot of request counters.

**Rationale**: Flight cache behavior must prove the second identical search does not trigger another Duffel request. Process-local counters are not visible to a separately executed test process, so a loopback control contract is needed.

**Alternatives considered**:

- Infer caching only from `meta.cached`: rejected because it does not prove provider suppression.
- Write counters to disk: rejected because it introduces shared-file races and cleanup burden.

## Decision 7: Use real public booking contracts and allow asynchronous confirmation

**Decision**: The sanity lifecycle is search → flight detail → profile upsert → readiness → booking intent → payment create → payment confirm → bounded status poll if 202 → booking detail `CONFIRMED`. It uses fresh UUID idempotency keys and a client-generated booking UUID.

**Rationale**: These are the established opaque-box endpoint contracts in existing E2E suites. Ancillaries are optional and remain outside the happy-path scope.

**Alternatives considered**:

- Seed booking records directly: rejected because it bypasses the business flow.
- Require synchronous payment confirmation: rejected because the accepted endpoint can return 202 and converge asynchronously.

## Decision 8: Compare cached search domain payloads, not the whole envelope

**Decision**: The cache sanity assertion compares `results` and `meta.searchHash`; it expects `meta.cached` to change from false to true and verifies the Duffel mock request count remains one.

**Rationale**: Full response identity is intentionally false because cache metadata changes.

**Alternatives considered**:

- Deep-equal both envelopes: rejected because it would fail correct behavior.
- Use timing as cache proof: rejected as nondeterministic.

## Decision 9: One fresh CI job, conditional on applicable terminal gates

**Decision**: Add `smoke-and-sanity` with `needs` on `detect-changes`, API unit/E2E, web build, and agent tests. Use `always()` plus change-output-aware predicates: changed services require successful terminal jobs; unchanged services may have skipped jobs; failure or cancellation blocks execution. The job runs when at least one service domain changed. Because `docker-compose.yml` defines shared PostgreSQL and Redis infrastructure, add it to all three service filters so a Compose-only change runs all applicable prerequisites and the whole-stack job rather than being treated as irrelevant.

**Rationale**: GitHub Actions skips downstream jobs when a needed job skips unless `always()` is used. The job is shared across all services and cannot be modeled as one ordinary per-service chain. Infrastructure changes are cross-domain by definition; fanning `docker-compose.yml` into the existing outputs avoids adding a fourth result state while preventing database/cache regressions from bypassing `ci-status`.

**Alternatives considered**:

- Require every terminal job to be successful: rejected because path filtering legitimately skips unaffected services.
- Split smoke and sanity into separate jobs: rejected because it doubles installation and boot time.

## Decision 10: Orchestrate application processes in a Node script

**Decision**: `scripts/ci/run-smoke-sanity.mjs` owns mock/API/Agent/Web process creation, per-process log files, readiness, sequential smoke then sanity execution, signal handling, and cleanup in `finally`. GitHub Actions owns Docker Compose infrastructure, dependency installation, builds, migration, and unconditional Compose diagnostics/teardown.

**Rationale**: One orchestrator makes local and Linux CI behavior consistent and makes smoke-before-sanity and cleanup directly testable. It also keeps the workflow readable.

**Alternatives considered**:

- One long inline shell block: rejected because local Windows reproduction and process-tree cleanup would diverge.
- A third-party process manager: rejected by the zero-new-dependency decision.

## Decision 11: Preserve loopback-only networking and no-LLM execution

**Decision**: Set `NODE_OPTIONS=--require=<workspace>/tests/ci/node-network-guard.cjs` for Node services, harness, and tests. The Python process is started with only loopback API/Redis targets, and smoke/sanity never invokes chat or guardrail inference routes.

**Rationale**: The existing guard explicitly permits loopback addresses and blocks external Node traffic. Avoiding Agent chat paths removes the Python LLM risk.

**Alternatives considered**:

- Disable the guard for provider mocks: rejected because loopback is already allowed.

## Decision 12: Isolate CI and local data differently

**Decision**: CI uses a fresh database name inside job-owned Compose lifecycle and tears volumes down after the job. Local execution requires the dedicated `smoke_test` database and an explicit guarded reset command that refuses any other database name.

**Rationale**: The current Compose file uses a persistent named volume and `flight_booking`; `docker compose up -d` alone is not a fresh local run.

**Alternatives considered**:

- Per-test cleanup: rejected by the ADR and creates lifecycle coupling.
- Drop the default development database: rejected as destructive.

## Resolved Unknowns

No open clarification items remain. SAST/DAST, Dockerfiles, staging, CD, real provider sandbox tests, custom reporting, and post-merge execution remain explicitly deferred.
