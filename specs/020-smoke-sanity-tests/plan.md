# Implementation Plan: Whole-Stack Smoke and Sanity CI

**Branch**: `020-smoke-sanity-tests` | **Date**: 2026-08-26 | **Spec**: [spec.md](spec.md)

**Input**: Owner-approved CI decisions in `docs/adr/0018-cicd-smoke-sanity.md`, reconciled with verified repository contracts in [research.md](research.md).

## Summary

Add one PR-only `smoke-and-sanity` GitHub Actions job that boots Postgres, Redis, NestJS, Next.js, FastAPI, and a deterministic local Duffel/Stripe mock; waits for concurrent readiness; runs eight broad smoke checks; gates narrow sanity flows for search/cache, confirmed booking, and Agent gateway communication; and always emits safe diagnostics and cleans up. Tests use Node.js `node:test`, built-in `fetch`, and `node:http`, with no application imports, real provider calls, LLM calls, or new dependencies.

Implementation requires four bounded compatibility seams discovered during planning: optional provider base URLs with unchanged defaults, a Next server-side upstream readiness route, a no-LLM Agent liveness endpoint used by Nest health, and CI aggregate-state logic that understands path-filtered skipped jobs.

## Technical Context

**Language/Version**: Node.js 20 ESM for harness/tests; TypeScript 5.4/NestJS for API seams; Next.js 14.2.3 App Router; Python 3.11/FastAPI for Agent liveness; YAML for GitHub Actions

**Primary Dependencies**: Built-in `node:test`, `fetch`, `node:http`, `child_process`; existing `@duffel/api` 4.x, Stripe 15.x, NestJS, Next.js, FastAPI, Prisma, Docker Compose, pnpm 10.34.5, uv 0.12.0

**Storage**: Existing PostgreSQL 16 and Redis 7; no schema change; fresh CI database and guarded local `smoke_test` database

**Testing**: Node unit/contract/whole-stack black-box tests, existing Jest/Pytest/Next validation gates

**Target Platform**: GitHub-hosted `ubuntu-latest` PR runner and local Windows PowerShell workflow

**Project Type**: Monorepo web system with NestJS API, Next.js frontend, FastAPI Agent, and CI orchestration

**Performance Goals**: Readiness ≤120s; smoke <15s after readiness; sanity <60s after smoke; one boot cycle

**Constraints**: PRs to `development` only; loopback external mocks; no LLM; no real Duffel/Stripe; no new package; smoke gates sanity; safe logs; unconditional cleanup; upstream skipped-job semantics must be correct

**Scale/Scope**: 8 smoke checks, 3 sanity flow groups plus a separate cache assertion, 3 services, 2 infrastructure services, 1 mock server, 1 shared CI job

## Constitution Check

_Pre-design gate: PASS. Post-design gate: PASS._

| Principle                                  | Gate | Design evidence                                                                                                                                       |
| ------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Flight-First Architecture               | PASS | Sanity focuses on flight search and booking; no hotel/dining scope                                                                                    |
| II. Deterministic Transaction Boundary     | PASS | Booking is exercised through deterministic services with local Stripe/Duffel fixtures; Agent/LLM is excluded from payment and booking                 |
| III. API Budget Discipline                 | PASS | Network guard plus loopback provider URLs make real Duffel traffic impossible; cache suppression is directly asserted                                 |
| IV. Observability & Operational Visibility | PASS | Health/readiness contracts, per-service diagnostics, safe mock logs, process logs, and cleanup outcomes are first-class                               |
| V. Incremental Delivery                    | PASS | Smoke is the MVP gate; sanity flows and CI aggregation are independently testable increments with rollback by file cluster                            |
| Security Requirements                      | PASS | Non-production secrets only, no raw card data, public HTTP tests, existing JWT/claim guards, redacted diagnostics                                     |
| Complexity Governance                      | PASS | One dependency-free orchestrator and two provider configuration options are the smallest reliable way to provide local/CI parity and validating mocks |

No constitutional violation or unresolved clarification remains.

## Codebase Reconciliation

The plan preserves the ADR's intended guarantees while correcting factual assumptions:

| ADR assumption                               | Verified code                                               | Planned contract                                                               |
| -------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| API health says `db/redis: connected`        | `dependencies.database/redis: up`                           | Assert current public readiness shape                                          |
| `/` proves frontend→API                      | Homepage is static                                          | Keep `/` serving check; add `/health/upstream` server fetch                    |
| Agent `/health` is fully healthy without LLM | It can return HTTP 200 `degraded` due Mimo/guardrails       | Direct check asserts reachability; new lightweight liveness excludes inference |
| API→Agent uses `X-Service-Auth`              | No such header; real service auth is Agent→API              | Test API→Agent liveness plus existing Agent→API key/claim authorization        |
| Invalid service key is 403                   | Missing/invalid key is 401; unauthorized valid claim is 403 | Assert the actual security semantics                                           |
| Duffel/Stripe already accept mock URLs       | Both wrappers currently default/hardcode provider endpoints | Add optional URL configuration with unchanged production defaults              |
| Compose local DB is fresh                    | Named volume persists `flight_booking`                      | Guarded reset of only `smoke_test`; CI removes job-owned resources             |

These are compatibility and testability seams, not changes to flight, payment, booking, or authentication business behavior.

## Project Structure

### Documentation

```text
specs/020-smoke-sanity-tests/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── test-harness.md
└── tasks.md
```

### Source and tests

```text
.github/workflows/ci.yml
scripts/ci/
├── evaluate-ci-status.mjs
└── run-smoke-sanity.mjs
tests/
├── ci/
│   └── ci-workflow.contract.test.mjs
└── smoke/
    ├── smoke.test.mjs
    ├── sanity.test.mjs
    ├── wait-for-ready.unit.test.mjs
    ├── mock-server.unit.test.mjs
    ├── helpers/
    │   ├── wait-for-ready.mjs
    │   └── test-utils.mjs
    ├── mocks/
    │   └── mock-server.mjs
    └── README.md
apps/api/src/
├── common/stripe.service.ts
├── common/stripe.service.spec.ts
├── duffel/duffel.service.ts
├── duffel/duffel.service.spec.ts
├── health/agent-health.service.ts
└── health/agent-health.service.spec.ts
apps/agent/src/agent/main.py
apps/agent/tests/test_health.py
apps/web/app/health/upstream/route.ts
apps/web/app/health/upstream/route.spec.ts
```

**Structure Decision**: Keep whole-stack tests in the ADR-approved root `tests/smoke/` boundary, CI orchestration in existing `scripts/ci/`, provider configuration inside existing adapters, and operational liveness beside each service's current health surface. No new package or domain module is introduced.

## Runtime Design

### 1. Provider mock and configuration

`mock-server.mjs` exports a programmatic server factory for unit tests and starts as a CLI process for the stack run. It implements the exact Duffel/Stripe method-path combinations observed in the selected search/payment/booking flow, validates required JSON/form fields, and exposes safe counter control routes.

`DuffelService` passes optional `DUFFEL_API_URL` as the installed SDK's `basePath` and uses that same parsed base for manual order HTTP. `StripeService` parses optional `STRIPE_API_URL` and supplies protocol/host/port to the SDK. Invalid configured URLs fail fast. Absence preserves current defaults.

### 2. Health and service boundaries

- API readiness: existing `/api/health` with database and Redis.
- Web serving: `/` expected HTML marker.
- Web upstream: new dynamic/no-store `/health/upstream` route with short timeout to `/api/health/ping` and only `{status, upstream}` output.
- Agent direct: existing `/health` requires HTTP reachability only.
- API→Agent: new lightweight Agent liveness path is called by existing `AgentHealthService`; no Mimo, chat, token generation, or LLM.
- Agent→API auth: an approved read-only gateway endpoint is called with valid/missing/invalid `X-Agent-API-Key` and signed claims to cover success/401/403.

### 3. Harness helpers

`wait-for-ready.mjs` exposes a pure `waitForReady({probes, intervalMs, timeoutMs, fetchImpl, clock})` contract. It starts all probe loops together, aborts on the shared deadline, and returns or throws a structured safe report.

`test-utils.mjs` owns `requestJson`, bearer headers, unique actor creation, HMAC claim signing, future search dates, profile/readiness/intent payload builders, payment polling, response-shape assertions, cache-envelope normalization, and mock counter access. It never logs secrets or full PII-bearing bodies.

### 4. Smoke suite

The smoke file groups eight named black-box checks:

1. API health and dependency shape.
2. Next homepage HTML.
3. Agent health HTTP reachability.
4. Postgres readiness through API health.
5. Redis readiness through API health.
6. Web `/health/upstream` proves server-to-server Nest reachability.
7. API `/api/health/agent` proves no-LLM Agent reachability.
8. API register → login → bearer `/auth/me` identity.

The duplicated API health request may be shared within the suite, but each named assertion remains independently diagnosable.

### 5. Sanity suite

The suite uses one unique TestActor and public APIs only:

- Search: reset mock counters, search valid future route, validate required public result/meta fields, fetch flight detail for passenger identity.
- Cache: repeat identical search; compare results/hash, assert `cached` transition and exactly one Duffel offer-request.
- Booking: create/update traveler profile, evaluate readiness, create intent, create Stripe PaymentIntent, confirm with fresh idempotency identity, poll accepted async status, then assert owner-visible booking is `CONFIRMED` with booking reference.
- Agent: direct health, API→Agent liveness, valid gateway key/claim success, missing/wrong key 401, valid key plus unauthorized claim 403.

### 6. Process orchestration and cleanup

`run-smoke-sanity.mjs` validates loopback URLs and database mode, creates a run log directory, starts mock/API/Agent/Web with separate stdout/stderr logs, watches for premature exits, calls readiness, spawns smoke with the spec reporter, and spawns sanity only after zero exit. A `finally` path sends graceful termination, waits with a bound, escalates only against recorded child handles, and reports cleanup failures.

The workflow starts Compose, installs/builds/migrates, then invokes the orchestrator. An `always()` diagnostic/cleanup step prints safe process log tails and `docker compose ps/logs`, then stops only job-owned Compose services. No custom reporter or artifact action is needed for this scope.

## CI Job Design

### Change detection

Add `tests/smoke/**`, `scripts/ci/run-smoke-sanity.mjs`, and the root `docker-compose.yml` to the API, Web, and Agent filters because harness or shared infrastructure changes can affect the composed stack even when no application-service file changes. A Compose-only pull request therefore sets all three service-domain outputs to `true`, runs their applicable prerequisites, and makes `smoke-and-sanity` mandatory. Existing `.github/**`, root manifests, lockfiles, shared paths, and service paths retain their current behavior.

### Dependency predicate

The job uses `if: always()` and requires:

- `detect-changes` succeeded;
- at least one of API/Web/Agent changed, including infrastructure changes fanned out to those outputs;
- if API changed: both API unit and API E2E succeeded;
- if Web changed: Web build succeeded;
- if Agent changed: Agent tests succeeded.

Skipped terminal jobs are accepted only for unchanged domains. Cancelled or failed applicable jobs never pass the predicate.

### Job sequence

1. Checkout with pinned action and LF behavior.
2. Set up pinned pnpm/Node and uv/Python.
3. Install from frozen/locked dependency graphs.
4. Start Postgres/Redis with Compose.
5. Build shared/API/Web; generate Prisma Client; deploy migrations.
6. Invoke the run orchestrator with non-secret local env, feature flags, loopback provider/service URLs, and network guard.
7. On every result, print safe logs and Compose diagnostics; stop job-owned infrastructure.

### Aggregate result

Add `smoke-and-sanity` to `ci-status.needs`, pass `SMOKE_AND_SANITY_RESULT`, and extend `scripts/ci/evaluate-ci-status.mjs` plus workflow contract tests. Expected result is skipped only when all service change outputs are false; otherwise success is required. The workflow contract must explicitly prove that a `docker-compose.yml`-only change makes all service outputs true and cannot pass `ci-status` unless the whole-stack job succeeds.

## Environment Contract

| Area           | Required values                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Database/cache | job/local `DATABASE_URL`, loopback `REDIS_URL`                                                 |
| Shared auth    | matching `JWT_SECRET`, `AGENT_SERVICE_API_KEY`, `CLAIM_TOKEN_SECRET`                           |
| API providers  | non-live tokens plus loopback `DUFFEL_API_URL`, `STRIPE_API_URL`, Stripe webhook test secret   |
| Cross-service  | `AGENT_SERVICE_URL`, `NESTJS_API_URL`, private Web `API_URL`                                   |
| Feature flags  | booking readiness and any existing booking-confirmation flags required by selected public flow |
| Network        | absolute `NODE_OPTIONS=--require=.../tests/ci/node-network-guard.cjs`                          |
| Tests          | `SMOKE_API_URL`, `SMOKE_WEB_URL`, `SMOKE_AGENT_URL`, `SMOKE_MOCK_URL`                          |

Exact values and redaction rules live in [contracts/test-harness.md](contracts/test-harness.md).

## Test-First Implementation Strategy

1. Extend workflow contract/status truth-table tests before YAML/evaluator changes.
2. Add failing provider-wrapper tests proving overrides/defaults before adapter changes.
3. Add failing health seam tests before Web/Agent health changes.
4. Add helper/mock unit tests before their implementations.
5. Write each smoke check as a named failing black-box test, then expose only the minimal seam needed.
6. Write search/cache, booking, and Agent sanity behaviors as separate failing tests before fixtures/helpers are expanded.
7. Run the complete job lifecycle last; do not weaken established test contracts without owner approval.

## File-by-File Change Plan

| File                                                 | Planned change                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                           | Filters, job, env, dependency predicate, setup/build/migrate/run/diagnostics/cleanup, aggregate dependency |
| `scripts/ci/evaluate-ci-status.mjs`                  | Change-aware expected result for shared whole-stack job                                                    |
| `scripts/ci/run-smoke-sanity.mjs`                    | Cross-platform process lifecycle and sequential suite gate                                                 |
| `tests/ci/ci-workflow.contract.test.mjs`             | Static graph, ordering, guards, cleanup, filter, aggregate truth table                                     |
| `tests/smoke/helpers/wait-for-ready.mjs`             | Concurrent bounded polling and safe report                                                                 |
| `tests/smoke/helpers/test-utils.mjs`                 | HTTP/domain helpers, actor, claims, polling, cache normalization                                           |
| `tests/smoke/mocks/mock-server.mjs`                  | Validating Duffel/Stripe fixtures, safe logs/counters/control                                              |
| `tests/smoke/*.unit.test.mjs`                        | Helper/mock red-green coverage                                                                             |
| `tests/smoke/smoke.test.mjs`                         | Eight named shallow checks                                                                                 |
| `tests/smoke/sanity.test.mjs`                        | Search/cache, booking, and Agent flows                                                                     |
| `tests/smoke/README.md`                              | Local/CI runbook, coverage, environment, timing, troubleshooting                                           |
| `apps/api/src/duffel/duffel.service.ts` + spec       | Optional SDK/manual-fetch base URL with default parity                                                     |
| `apps/api/src/common/stripe.service.ts` + spec       | Optional parsed Stripe API URL with default parity                                                         |
| `apps/api/src/health/agent-health.service.ts` + spec | No-LLM Agent liveness target and accepted response                                                         |
| `apps/agent/src/agent/main.py` + health tests        | Lightweight liveness endpoint that avoids guardrail/LLM probes                                             |
| `apps/web/app/health/upstream/route.ts` + spec       | Dynamic, no-store, bounded Nest ping with sanitized 200/503                                                |
| `context/architecture.md`                            | Replace planned state with implemented data flow, routes, job graph, seams                                 |
| `context/code-standards.md`                          | Record operational `/health/upstream` route exception and provider override safety rule                    |
| `context/library-docs.md`                            | Document installed Duffel `basePath` and Stripe endpoint override pattern                                  |
| `context/progress-checker.md`                        | Feature/task completion and exact verification evidence                                                    |

## Rollout and Rollback

- Land characterization tests and provider/health seams before enabling the CI job.
- Keep all provider defaults unchanged; unset overrides to roll back to current behavior.
- The Web and Agent liveness routes are independently revertible if the job is disabled in the same rollback.
- The shared job is non-deployment CI only. Rollback removes it from `ci-status` and restores evaluator/contract truth tables atomically.
- No migration or production data rollback exists.

## Risks and Mitigations

| Risk                                                    | Mitigation                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Mock fixture drifts from provider wrapper request shape | Validate key fields and keep route tests adjacent; fail unknown routes        |
| Agent detailed health is degraded without Mimo          | Use no-LLM liveness for reachability; never call chat                         |
| Provider override accidentally reaches real host        | Default-parity unit tests, loopback validation in harness, Node network guard |
| Cache assertion is flaky                                | Use mock count and cache metadata, never timing                               |
| Async confirmation exceeds sanity budget                | Bounded short poll with diagnostic last state; deterministic mock responses   |
| GitHub skip semantics hide failure                      | Explicit change-aware `always()` predicate and evaluator truth-table tests    |
| Cleanup kills unrelated local processes                 | Track exact child handles/PIDs; never pattern-kill globally                   |
| Local reset destroys developer data                     | Parse URL and refuse any database other than exact `smoke_test`               |
| Logs leak actor/provider data                           | Allowlisted diagnostic fields and redaction tests                             |

## Complexity Tracking

No constitutional violation exists. The limited complexity is justified:

| Complexity                               | Why needed                                                                   | Simpler alternative rejected because                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| One Node process orchestrator            | Same lifecycle and cleanup semantics must work in Linux CI and local Windows | Inline shell diverges and is hard to test safely                                |
| Optional provider endpoint configuration | Standalone validating mocks cannot receive existing SDK calls otherwise      | Internal canned responses do not verify provider contracts or cache suppression |
| Separate Web upstream health route       | Static homepage cannot prove SSR/server-to-server API connectivity           | Adding API fetch to homepage couples user availability to health probing        |

## Phase 1 Design Completion

- Research decisions: [research.md](research.md)
- Operational model: [data-model.md](data-model.md)
- Harness contract: [contracts/test-harness.md](contracts/test-harness.md)
- Validation guide: [quickstart.md](quickstart.md)
- Post-design constitution re-check: PASS
