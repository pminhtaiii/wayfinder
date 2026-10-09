# CI/CD Pipeline — Smoke & Sanity Test Decisions

> Captured from grilling session on 2026-08-26.

---

## Context

The existing CI pipeline covers change detection, lint/typecheck gates, unit tests, E2E tests, and build verification across all 3 services (API, Web, Agent). However, no tests validate whether the services actually boot and communicate correctly as a composed system. This session established the design for adding smoke and sanity test suites to the pipeline.

---

## 1. No CD Pipeline Yet

A Continuous Delivery pipeline is **deferred**. Prerequisites are missing: no Dockerfiles, no staging/production environment, no IaC. Building smoke/sanity tests against a Docker Compose full-stack in CI provides immediate value without solving the entire deployment problem first.

**Progression:**

1. **Now** → Smoke/sanity tests against Docker Compose in CI
2. **Next** → Dockerfiles + SAST/DAST scanning
3. **Then** → Staging environment + IaC + CD pipeline

---

## 2. Smoke vs. Sanity — Definitions

| Aspect          | 🔥 Smoke Tests                     | 🎯 Sanity Tests                          |
| --------------- | ---------------------------------- | ---------------------------------------- |
| Question        | "Is the system alive?"             | "Do key business flows work?"            |
| Scope           | Broad, shallow — every service     | Narrow, deep — specific flows            |
| Data created    | Minimal (1 test user)              | Yes — users, profiles, intents, bookings |
| Failure meaning | Deployment is fundamentally broken | A specific business flow is broken       |
| Run order       | First — gate for sanity tests      | After smoke passes                       |
| Expected speed  | < 15 seconds                       | < 60 seconds                             |

---

## 3. Smoke Test Checklist (8 Checks)

1. **NestJS API Health** — `GET :3001/api/health` → 200 with `db: connected, redis: connected`
2. **Next.js Frontend Serves** — `GET :3000/` → 200 with expected HTML
3. **FastAPI Agent Health** — `GET :3002/health` → 200
4. **Database Connectivity** — confirmed via NestJS health endpoint (Prisma ↔ Postgres)
5. **Redis Connectivity** — confirmed via NestJS health endpoint (cache layer)
6. **Frontend → API Communication** — Next.js SSR successfully reaches NestJS
7. **API → Agent Communication** — NestJS reaches FastAPI via `X-Service-Auth` (no LLM call)
8. **Auth Flow Round-Trip** — register → login → JWT → `/auth/me` returns user

---

## 4. Sanity Test Flows (3 Flows)

### Flow 1 — Flight Search Round-Trip

Auth → search with mocked Duffel → verify response shape and required field contract. Redis cache verification is a **separate** sanity test (cache hit behavior, response identity, timing are tested independently).

### Flow 2 — Full Booking Lifecycle

Full lifecycle from profile creation to confirmed booking: profile setup → readiness evaluation → intent creation with passengers → payment (mocked Stripe) → PNR creation (mocked Duffel) → verify booking status = `CONFIRMED`. **Happy path only** — no unhappy path testing.

### Flow 3 — Agent Gateway Communication

- Direct agent health check (bypass NestJS)
- API → Agent service auth handshake via `X-Service-Auth` (proves cross-service communication)
- Agent responses are **mocked** (no LLM calls)
- Negative auth tests: unauthenticated access (401), invalid service key (403)

---

## 5. Test Runner

**`node:test` + built-in `fetch`** — framework-agnostic, black-box HTTP assertions only. No service imports.

Runner split across the project:

| Runner                | Domain                         |
| --------------------- | ------------------------------ |
| Jest                  | NestJS unit/integration tests  |
| pytest                | FastAPI agent tests            |
| Playwright            | Browser E2E tests              |
| `node:test` + `fetch` | Whole-stack smoke/sanity tests |

---

## 6. File Location

```
tests/
├── ci/                          → CI infra (existing — network guards, contracts)
└── smoke/
    ├── smoke.test.mjs           → Smoke suite
    ├── sanity.test.mjs          → Sanity suite
    ├── mocks/
    │   └── mock-server.mjs      → Standalone mock HTTP server (Duffel, Stripe)
    ├── helpers/
    │   ├── wait-for-ready.mjs   → Parallel health polling
    │   └── test-utils.mjs       → Shared helpers (register, login, etc.)
    └── README.md                → Coverage docs, local run instructions
```

---

## 7. Stack Boot Strategy (Option B)

Docker Compose for infrastructure (Postgres + Redis) + background processes for application services (NestJS, Next.js, Agent). **No Dockerfiles needed yet.**

CI job sequence:

1. `docker compose up -d` (Postgres + Redis)
2. `prisma migrate deploy` (schema ready)
3. Start NestJS, Next.js, Agent as background processes
4. Start mock HTTP server for Duffel/Stripe
5. `wait-for-ready.mjs` (parallel health polling)
6. `node --test tests/smoke/smoke.test.mjs` (smoke)
7. `node --test tests/smoke/sanity.test.mjs` (sanity)
8. Kill all background processes

When Dockerfiles are built (future), swap steps 1–4 for `docker compose up -d` with the full stack. Zero test rewrites.

---

## 8. CI Job Structure

**Single job** (`smoke-and-sanity`) — smoke runs first, sanity after. One boot cycle. Both suites need the same stack, so splitting into two jobs would double boot time (~2–3 min) for no functional benefit.

Dependency graph:

```
detect-changes
  ├──→ api-gate ──→ api-unit-tests ──→ ┐
  ├──→ api-gate ──→ api-e2e-tests  ──→ │
  ├──→ web-gate ──→ web-build      ──→ ├──→ smoke-and-sanity ──→ ci-status
  └──→ agent-gate → agent-tests    ──→ ┘
```

---

## 9. Wait-for-Ready Strategy

Parallel polling with diagnostic output:

- Poll all services **concurrently** (`Promise.all`)
- Interval: **2 seconds**
- Overall timeout: **120 seconds**
- On timeout: print per-service report with last HTTP status/error and elapsed time
- NestJS health confirms Postgres + Redis connectivity (no separate DB/Redis checks)

---

## 10. External API Mocking

**Standalone mock HTTP server** under `tests/smoke/mocks/`. No production code changes.

Requirements:

- **Validate** key incoming request fields (not just return canned responses)
- **Fail on unknown/unexpected routes** (404 + logged warning)
- **Log all incoming requests** with timestamp, method, path, status for CI diagnostics
- **Route on method + pathname** (not raw URL)
- **Network guard stays active** (belt and suspenders — blocks real Duffel/Stripe even if misconfigured)
- Start and stop as part of CI job lifecycle

Built with **plain `node:http`** — zero dependencies. JSON body parsing via shared helper. Matches the `node:test` zero-dependency philosophy.

---

## 11. Test Data Isolation

**Fresh database per run** (Option C). The CI Postgres service container is ephemeral — created at job start, destroyed when the GitHub Actions runner is recycled. No cleanup code needed.

For local development: use a dedicated `smoke_test` database name, drop and recreate before each run.

---

## 12. Trigger Scope

**PRs to `development` only.** Post-merge smoke tests are deferred until a CD pipeline exists with a staging environment to test against.

---

## 13. Test Reporting

**`node --test --test-reporter=spec`** — human-readable output in GitHub Actions logs. No annotations or custom reporters for now.

---

## 14. Integration Tests with Real APIs (Future, Separate Layer)

Real Duffel/Stripe sandbox integration tests are a **separate future concern**, not part of the current smoke/sanity suite. They would use GitHub encrypted secrets and run as a distinct CI job. The smoke/sanity tests remain secret-free and fully self-contained.

---

## Open Questions (Not Yet Resolved)

- **SAST/DAST scanning**: Tool selection (Trivy, Semgrep, OWASP ZAP) and pipeline placement.
- **Dockerfiles**: Multi-stage build strategy for all 3 services.
- **Staging environment**: Cloud provider, IaC tooling, environment provisioning.
- **CD pipeline**: Full deployment automation from artifacts to production.
