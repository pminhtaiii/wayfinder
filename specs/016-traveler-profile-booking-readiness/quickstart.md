# Quickstart Validation: Traveler Profile & Booking Readiness

## Prerequisites

- PostgreSQL and Redis running from `docker compose up -d`
- Test environment variables from existing API, web, and agent test setup
- Matching `JWT_SECRET`, `AGENT_SERVICE_API_KEY`, and `CLAIM_TOKEN_SECRET`
- A seeded user, domestic offer, international offer, and airport country data

## Focused validation sequence

1. Apply the feature migration and seed profiles representing empty, domestic-ready, international-ready, expired, and near-expiry documents.
2. Run profile unit/integration tests; verify owner-only round trip, revision conflicts, atomic document update, dual-write/backfill rollback safety, masking, no-store headers, and PII-safe audit metadata.
3. Run evaluator tests; verify domestic, every-segment international detection, missing airport country, expired document, advisory warning, and optional middle name.
4. Run booking-intent tests; verify profile/inline source resolution, expected-profile revision, cross-user rejection, zero writes on failure, AAD-bound immutable snapshots, masked reads, and the route/response compatibility matrix.
5. Run agent tests; verify the gateway/tool/SSE allowlists reject injected PII fields and emit only ordinal/type/status metadata.
6. Run browser E2E: incomplete profile → secure correction → ready → intent → `/checkout/[intentId]/ancillaries`; then verify inline/multi-passenger chat handoff.
7. Run final-order tests with expired, corrupted, cross-record-swapped, concurrent, and lease-lost snapshots; assert Duffel is called only once by the existing claim owner or not called.
8. Run the warmed local performance profile and verify readiness p95 <100 ms, intent creation p95 <200 ms, and profile p95 <50 ms (read) / <500 ms (write) across 100 requests.
9. Verify dashboard/alert/runbook contracts, trace propagation, required structured fields, metric increments, and a negative PII corpus across logs/audits/traces.

## Commands

From the repository root:

```powershell
pnpm --filter @shared/types build
pnpm --filter @api/backend test -- booking-readiness.evaluator.spec.ts --runInBand
pnpm --filter @api/backend test -- booking-intent.service.spec.ts --runInBand
npm run test:e2e --workspace=apps/api
npm run test:e2e --workspace=apps/api -- booking-readiness.performance.e2e-spec.ts
npx playwright test --config=apps/web/tests/playwright.config.ts
pnpm --filter @api/backend build
pnpm --filter @web/frontend typecheck
pnpm --filter @web/frontend build
```

From `apps/agent/`:

```powershell
uv run pytest tests/test_tools.py tests/test_nestjs_client.py tests/test_sse_integration.py
```

## Expected outcomes

- Advisory and authoritative checks agree for identical inputs.
- Every rejected authoritative request leaves intent/passenger counts unchanged.
- Profile edits after intent creation do not alter the snapshot.
- No profile values appear in agent-gateway responses, SSE, logs, audit metadata, traces, URLs, route state, local/session storage, cacheable responses, or errors.
- Invalid final passenger data prevents any Duffel order call.
- Concurrent final submissions converge through the existing idempotency owner and produce at most one supplier call.
- Existing singular intent callers continue working during migration; all new first-party calls use plural routes and both GET paths return the same safe response after client cutover.

See [API contracts](contracts/api.md) and [data model](data-model.md) for exact shapes and migration rules.

## Validation Results & Execution Sign-off

- **Validation Timestamp**: 2026-08-19T23:04:00+07:00
- **Overall Status**: **PASSED (Signed-Off)**

### Test Execution Summary

| Suite / Command                                                                                                       | Scope / Description                                            | Tests    | Status   | Duration   |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------- | -------- | ---------- |
| `pnpm --filter @shared/types build`                                                                                   | Shared DTO & contract compilation                              | N/A      | **PASS** | ~1.5s      |
| `pnpm --filter @api/backend test -- src/booking-intent/booking-readiness.evaluator.spec.ts --runInBand`               | Pure evaluator rule matrix, boundaries, unknown scope          | 52 / 52  | **PASS** | 16.7s      |
| `pnpm --filter @api/backend test -- src/booking-intent/booking-intent.service.spec.ts --runInBand`                    | Authoritative intent creation, zero writes, bound decrypt      | 36 / 36  | **PASS** | 31.5s      |
| `pnpm --filter @api/backend test -- src/booking-intent/booking-passenger-final-validator.service.spec.ts --runInBand` | Final validator, AAD integrity, live clock, ephemeral DTOs     | 19 / 19  | **PASS** | 19.1s      |
| `pnpm --filter @api/backend test:e2e -- booking-readiness-observability.e2e-spec.ts`                                  | Observability, health endpoints, metric counters, negative PII | 16 / 16  | **PASS** | 58.8s      |
| `pnpm --filter @api/backend test:e2e -- booking-readiness.performance.e2e-spec.ts`                                    | 100-request warmed performance benchmarks (5/5 p95 targets)    | 5 / 5    | **PASS** | 51.7s      |
| `pnpm --filter @api/backend test:e2e -- booking-passenger-final-validation.e2e-spec.ts`                               | Final safety, single supplier call, error handling             | 7 / 7    | **PASS** | 81.5s      |
| `pnpm --filter @api/backend test:e2e -- booking-intent.e2e-spec.ts`                                                   | Intent E2E, plural/singular routes, chat handoff concurrency   | 26 / 26  | **PASS** | 48.9s      |
| `pnpm --filter @web/frontend build`                                                                                   | Next.js production client & page optimization                  | 20 pages | **PASS** | 94.4 kB JS |
| `uv run pytest tests/test_tools.py tests/test_nestjs_client.py tests/test_sse_integration.py`                         | Python agent gateway tools & SSE allowlist filtering           | 57 / 57  | **PASS** | 25.7s      |

### Performance Benchmark Results (Task T075)

| Benchmark                                                      | Samples | p50        | p90        | p95 (Target)             | p99        | Status   |
| -------------------------------------------------------------- | ------- | ---------- | ---------- | ------------------------ | ---------- | -------- |
| 1. Profile Read (`GET /api/profile`)                           | 100     | 14.91 ms   | 21.16 ms   | **32.04 ms** (< 50 ms)   | 61.91 ms   | **PASS** |
| 1B. Profile Write (`PATCH /api/profile`)                       | 100     | 34.14 ms   | 66.72 ms   | **149.80 ms** (< 500 ms) | 540.56 ms  | **PASS** |
| 2. Advisory Readiness (`POST /api/bookings/intents/readiness`) | 100     | 21.13 ms   | 40.60 ms   | **47.96 ms** (< 100 ms)  | 63.29 ms   | **PASS** |
| 3. Sequential Intent Creation (`POST /api/bookings/intents`)   | 100     | 43.38 ms   | 53.73 ms   | **69.46 ms** (< 200 ms)  | 137.52 ms  | **PASS** |
| 4. 100-Way Concurrent Creation (`POST /api/bookings/intents`)  | 100     | 1064.77 ms | 1786.59 ms | **1835.27 ms** (N/A)     | 1889.25 ms | **PASS** |

### Negative PII Corpus Audit

- **Audit Logs**: Verified zero plaintext names, dates of birth, passport numbers, email addresses, or phone numbers in metadata or event records.
- **Metrics & Observability**: Verified all metric labels, health endpoints (`/health/booking-readiness`), and structured logs contain only allowlisted enum reasons and metadata.
- **Agent Gateway & SSE**: Verified strict field allowlisting rejects or strips sensitive PII fields.
- **Database Models & Snapshots**: Verified all stored passport credentials use AES-256-GCM authenticated encryption with AAD binding.
