# Feature Specification: Whole-Stack Smoke and Sanity CI

**Feature Branch**: `020-smoke-sanity-tests`

**Created**: 2026-08-26

**Status**: Approved input for planning

**Input**: Owner-approved decisions in `docs/adr/0018-cicd-smoke-sanity.md`.

## User Scenarios & Testing

### User Story 1 - Gate pull requests on whole-stack readiness (Priority: P1)

As a maintainer, I need CI to boot the complete application stack and run a fast black-box smoke suite so a pull request cannot pass when a service, dependency, authentication boundary, or cross-service connection is fundamentally broken.

**Why this priority**: A green collection of isolated gates does not prove that the composed system starts or communicates correctly. This is the minimum valuable increment and the prerequisite for deeper sanity checks.

**Independent Test**: Start Postgres, Redis, NestJS, Next.js, FastAPI, and the local provider mock; run only the smoke suite and verify all eight checks pass in under 15 seconds after readiness. Introduce one service or connectivity failure and verify the suite fails with diagnostic output before any sanity test runs.

**Acceptance Scenarios**:

1. **Given** all application services and infrastructure are running, **When** the smoke suite executes, **Then** it verifies API, web, and agent health; Postgres and Redis readiness; frontend-to-API rendering; API-to-agent service authentication; and register-login-token-identity round-trip behavior through public HTTP interfaces.
2. **Given** any smoke assertion fails, **When** the CI job reaches the smoke gate, **Then** the job fails, the sanity suite is not executed, service diagnostics are retained in the job log, and all background processes are stopped.
3. **Given** an upstream service job was skipped because its paths did not change, **When** every executed prerequisite succeeded, **Then** the whole-stack job remains eligible; any failed or cancelled prerequisite blocks it.

---

### User Story 2 - Validate key deterministic business flows (Priority: P2)

As a maintainer, I need a narrow sanity suite to exercise flight search, caching, booking completion, and agent-gateway authentication so regressions in the highest-value cross-service flows are found before merge without calling real providers or an LLM.

**Why this priority**: Once basic readiness is proven, the greatest remaining risk is that services are alive but cannot complete the core business workflows.

**Independent Test**: Against the same already-running stack, execute the sanity suite with local Duffel, Stripe, and agent responses. Verify flight search and cache behavior, a happy-path profile-to-confirmed-booking lifecycle, and positive and negative agent-gateway authentication in under 60 seconds.

**Acceptance Scenarios**:

1. **Given** an authenticated test user and a validating Duffel mock, **When** the same valid flight search is submitted twice, **Then** the first response satisfies the required public contract and the separate cache check proves the repeated response is served according to the accepted cache behavior without an additional provider request.
2. **Given** an authenticated test user, **When** profile setup, readiness evaluation, booking intent creation with passengers, mocked payment, and mocked supplier order creation complete, **Then** the public booking view reports `CONFIRMED` without any LLM or real external API call.
3. **Given** the API and agent are running, **When** cross-service checks execute, **Then** API-to-agent liveness succeeds without an LLM call and the existing agent-to-API gateway accepts a valid `X-Agent-API-Key` plus signed user claim, returns 401 for a missing or invalid service key, and returns 403 for an authenticated service claim whose user is not authorized.

---

### User Story 3 - Make the suites reproducible and diagnosable (Priority: P3)

As a developer or CI operator, I need the same zero-dependency test harness, readiness behavior, mock contracts, data-isolation rules, and commands to work locally and in GitHub Actions so failures can be reproduced and understood without external secrets.

**Why this priority**: Reliable diagnostics and local parity keep the new gate maintainable after its first successful run.

**Independent Test**: Run the documented local workflow against a dedicated `smoke_test` database, then deliberately make one service unavailable and one mock request invalid. Verify bounded readiness timeout, per-service diagnostics, unexpected-route logging, non-zero exits, and cleanup.

**Acceptance Scenarios**:

1. **Given** services become ready at different times, **When** readiness polling starts, **Then** all service probes run concurrently at two-second intervals and either complete within 120 seconds or report the last status/error and elapsed time for every unready service.
2. **Given** a mock receives a supported request, **When** required fields are valid, **Then** it returns the deterministic fixture and records timestamp, method, pathname, and status; missing required fields fail validation and unknown method/path combinations return 404 with a warning.
3. **Given** a local run, **When** the documented reset workflow begins, **Then** it targets only the dedicated `smoke_test` database and does not depend on cleanup inside individual tests.
4. **Given** the pull request targets `development`, **When** an application, harness, workflow, or shared infrastructure path such as `docker-compose.yml` changes, **Then** one `smoke-and-sanity` job performs one boot cycle, reports with Node's spec reporter, cleans up unconditionally, and is included in the aggregate `ci-status` decision.

### Edge Cases

- One service returns HTTP successfully but its readiness payload reports a failed Postgres or Redis dependency.
- A service starts after several connection refusals but before the 120-second readiness deadline.
- The frontend serves an error shell or fallback HTML that returns 200 but does not prove the expected server-rendered API content.
- Registration collides with data from a prior local run; generated identities must remain unique even though the local database is reset.
- A repeated search changes response ordering or metadata while retaining the same cached domain payload.
- The mock receives malformed JSON, a missing required header/body field, or an unsupported method on an otherwise known pathname.
- A background process exits before readiness or remains alive after a test failure.
- An upstream CI job is skipped, cancelled, or fails under GitHub Actions `needs` semantics.
- A pull request changes only `docker-compose.yml`; shared infrastructure change detection must still require the whole-stack job.
- Secrets, tokens, passwords, passenger PII, or payment details could appear in diagnostics; logs must redact or omit them.

## Requirements

### Functional Requirements

- **FR-001**: The repository MUST provide separate smoke and sanity suites under `tests/smoke/` using Node.js `node:test` and built-in `fetch`, with no application-service imports.
- **FR-002**: The smoke suite MUST perform the eight checks approved in the ADR and MUST complete in under 15 seconds after readiness under normal CI conditions.
- **FR-003**: The sanity suite MUST cover flight search response shape, a separate Redis-cache behavior check, the happy-path booking lifecycle, and agent-gateway positive and negative service authentication.
- **FR-004**: Sanity execution MUST occur only after smoke succeeds and MUST complete in under 60 seconds under normal CI conditions.
- **FR-005**: All whole-stack assertions MUST use public HTTP interfaces and MUST NOT import NestJS, Next.js, FastAPI, Prisma, Redis, or domain service internals.
- **FR-006**: The harness MUST use a standalone dependency-free `node:http` mock server for all Duffel and Stripe interactions and MUST use deterministic mocked agent responses without an LLM call.
- **FR-007**: The mock server MUST route on HTTP method plus pathname, validate required request fields, reject malformed requests, return 404 for unknown routes, and emit PII-safe request diagnostics.
- **FR-008**: Existing loopback-only network guards MUST remain active so a configuration error cannot reach real Duffel, Stripe, or LLM endpoints.
- **FR-009**: Readiness polling MUST probe services concurrently every two seconds with one 120-second overall deadline and per-service last-result diagnostics.
- **FR-010**: NestJS readiness MUST be the authoritative smoke proof for both Postgres and Redis connectivity; the harness MUST NOT add separate database or Redis clients.
- **FR-011**: CI MUST run one `smoke-and-sanity` job on pull requests to `development`, after applicable API, web, and agent prerequisites, using a single stack boot cycle.
- **FR-012**: The whole-stack job MUST accept successful or legitimately skipped upstream jobs, MUST reject failed or cancelled prerequisites, and MUST participate in the final `ci-status` result.
- **FR-013**: Changes to smoke-suite, CI helper, workflow, dependency-lock, shared infrastructure including `docker-compose.yml`, shared code, or service files that can affect the composed system MUST make the whole-stack job eligible through change detection; `docker-compose.yml` MUST be included in the API, Web, and Agent filters.
- **FR-014**: CI MUST use an ephemeral Postgres database and Redis instance; local runs MUST use a dedicated `smoke_test` database that is dropped/recreated only by an explicit harness command.
- **FR-015**: The job MUST install locked dependencies, build or prepare required artifacts, generate Prisma Client, deploy migrations, start all application and mock processes, wait for readiness, run smoke then sanity with the spec reporter, and clean up on success or failure.
- **FR-016**: CI and local diagnostics MUST include process/service identity and actionable failure state while excluding secrets, bearer tokens, user passwords, passenger PII, payment details, and raw provider payloads.
- **FR-017**: CI workflow contract tests MUST verify trigger scope, dependency ordering, path-filter coverage, smoke-before-sanity sequencing, timeout/cleanup behavior, and `ci-status` aggregation.
- **FR-018**: The repository MUST document coverage, prerequisites, environment variables, local reset/start/run/cleanup commands, expected timings, and troubleshooting in `tests/smoke/README.md` and the feature quickstart.
- **FR-019**: The current scope MUST NOT add Dockerfiles, CD/deployment automation, staging infrastructure, SAST/DAST tooling, real-provider sandbox tests, custom reporters, or GitHub annotations.
- **FR-020**: No new third-party runtime or test dependency MAY be introduced; the harness MUST use Node.js and repository-installed tooling only.

### Key Entities

This feature introduces no persistent application entities or schema changes. Its operational concepts are:

- **Stack Run**: One isolated lifecycle containing infrastructure, three application processes, the provider mock, readiness, smoke, sanity, diagnostics, and cleanup.
- **Service Probe**: A service name, URL, validation rule, deadline state, last HTTP status/error, and elapsed time used by readiness polling.
- **Mock Route Contract**: A method/path pair with required request fields, deterministic response fixture, request counter, and safe diagnostic record.
- **Test Actor**: A unique authenticated user plus profile, passengers, search input, booking intent, and public booking identifiers created during one stack run.

## Success Criteria

### Measurable Outcomes

- **SC-001**: All eight smoke checks pass in less than 15 seconds after readiness on a healthy CI runner.
- **SC-002**: All approved sanity flows pass in less than 60 seconds after smoke on a healthy CI runner.
- **SC-003**: A broken service or dependency prevents sanity execution and produces per-service diagnostics within the 120-second readiness bound or immediately on an assertion failure.
- **SC-004**: Repeated flight search proves cache use without a second Duffel mock request, while both returned public payloads satisfy the same contract.
- **SC-005**: The booking sanity flow reaches public booking status `CONFIRMED` using only local mocks and deterministic services.
- **SC-006**: API-to-agent liveness succeeds without an LLM request, while agent-to-API gateway checks produce success for valid service/user credentials, 401 for a missing or invalid service key, and 403 for an authenticated but unauthorized user claim.
- **SC-007**: The GitHub Actions workflow contract test proves the new job cannot be omitted from `ci-status`, cannot run sanity before smoke, cannot reach external provider hosts, and is required for a `docker-compose.yml`-only pull request.
- **SC-008**: A developer can reproduce the CI suites locally from `tests/smoke/README.md` without access to Duffel, Stripe, Mimo, or deployment secrets.
- **SC-009**: Cleanup leaves no harness-owned application or mock processes running after either a passing or failing job.

## Assumptions

- The ADR is owner-approved and resolves product and workflow choices for this feature.
- Existing public service endpoints and deterministic test seams are reused where they satisfy the ADR; any discovered contract mismatch is documented in `research.md` and handled explicitly in the plan.
- GitHub-hosted Ubuntu runners provide Docker, Node.js 20, and process-management primitives; pnpm, uv, and Python are installed at the repository-pinned versions.
- CI provider credentials are non-secret local-only values and all provider base URLs resolve to loopback mocks.
- The feature adds test infrastructure and CI wiring only; it does not change production domain behavior or application data models.
