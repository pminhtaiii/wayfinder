# Quickstart: fulfillment recovery acceptance

This is a planning artifact. The current payment page has disabled card inputs and a disabled Pay Now placeholder in apps/web/app/checkout/[intentId]/payment/page.tsx. The controlled recovery harness, payment UI wiring, configuration and scenarios below must be implemented before this acceptance flow can run.

Read [acceptance matrix](acceptance-matrix.md), [harness contract](contracts/controlled-test-harness.md), [provider operations](contracts/provider-operations.md) and [data model](data-model.md).

## Existing commands and limitations

Use PowerShell and the repository's installed tools. These commands already exist; they do not prove recovery acceptance. Run in the feature worktree:

~~~powershell
Set-Location 'C:\Users\taiph\.codex\worktrees\fulfillment-recovery-plan\Booking Systems'
pnpm --filter @api/backend run test:unit
pnpm --filter @api/backend run test:integration
pnpm --filter @web/frontend run test:unit
pnpm --filter @web/frontend run test:route-contracts
pnpm --filter @web/frontend run test:system
~~~

Backend integration requires the configured isolated PostgreSQL/Redis environment and migration prerequisites; consult context/testing.md. Existing web test:system invokes the T093 chat real-flow runner, not a fulfillment recovery suite. Existing ancillary configuration starts only Next.js and is insufficient. .github/workflows/ci.yml has backend PostgreSQL/Redis integration coverage, but no implied fulfillment recovery gate. Do not repair or replace pnpm as part of this feature; direct installed CLI invocation is available when needed.

Before applying migrations, create and positively identify a disposable run database/schema and set DATABASE_URL to it. Never run migrate/reset against the development or production database. Existing migration command, after that prerequisite:

~~~powershell
pnpm --filter @api/backend exec prisma migrate deploy
~~~

Feature migration/legacy fixtures are planned and must preserve source rows. Credentials must be supplied by an isolated runner configuration; never dump .env or environment objects.

## Planned controlled run

PLANNED files: apps/web/tests/playwright.fulfillment.config.ts, apps/web/tests/fulfillment-recovery.spec.ts and an isolated backend test bootstrap/driver. These paths are proposed deliverables, not existing commands. After implementation, the intended direct command is:

~~~powershell
Set-Location 'C:\Users\taiph\.codex\worktrees\fulfillment-recovery-plan\Booking Systems\apps\web'
node node_modules\@playwright\test\cli.js test tests\fulfillment-recovery.spec.ts --config=tests\playwright.fulfillment.config.ts
~~~

The configuration must own startup and cleanup of real Next/Nest, PostgreSQL/Redis, recovery worker and stateful Stripe/supplier transport simulators. It must check service readiness and target isolation before navigation; do not silently reuse a developer server. Enable the feature only inside the disposable run. Generate run secrets; application provider credentials cannot access driver routes. Default external egress must be blocked.

1. Allocate run-scoped database, Redis, provider ledgers, scheduler and generated customer/operations identities. Apply additive migrations; initialize a controlled offer with authoritative supplier balance price distinct from traveler payment.
2. Register the scenario through the protected driver protocol, then sign in through actual customer authentication. Search, select, fill passengers, choose ancillaries, review and pay through the wired payment UI.
3. Assert browser status and real persisted booking/payment/operation/attempt/evidence facts; inspect independent provider ledgers using the driver credential only.
4. Explicitly release signed provider events to real ingress. Exercise duplicate and out-of-order delivery, lost responses, held calls, restart and operator races with barriers.
5. Advance clock/due jobs to 15 minutes and actual authorization safeguards, assert active queue and continued reconciliation, then release valid late evidence and assert auto-resolution with retained history.
6. Always teardown owned namespaces/processes/events/jobs, including failed tests; fail on leaks. Upload redacted diagnostics only.

No wall-clock sleep is needed except separately tagged actual transport-timeout checks and bounded short PostgreSQL lease-expiry checks. The suite must cover every C row in the matrix and fail if mandatory cases are absent or services unhealthy.

## Planned live sandbox contract run

Keep a separate manual/nightly entry point, small bounded scenario count and explicit credential prerequisites. Before any side effect verify Stripe test-mode keys, supplier test account/environment, permitted balance/test booking support and documented API capabilities. Abort on production keys, real-money mode, unsupported account permissions or ambiguous environment identity. Do not infer cancellation, lookup uniqueness or create idempotency from the simulator.

Verify authentic payment authorization/retrieve/capture behavior, supplier authoritative fields/order retrieval and supported cancellation, plus signed webhook ingress. Use stable test records, bounded maximum order/payment counts and finally cleanup. Record created resource IDs securely for follow-up; unresolved cleanup fails the run and preserves evidence rather than promising that cancellation succeeded. Never release/refund/cancel without validated evidence.

Missing credentials mark this separate suite skipped with reason. Deterministic CI remains mandatory and sandbox-skipped must never be reported as sandbox-passed. Exploratory browser agents can provide non-authoritative QA observations; they cannot move money, create orders or resolve production cases.


## Planned lane partition and clock rules

PLANNED apps/api/test/jest-fulfillment-sandbox.json selects only fulfillment-provider-contract.e2e-spec.ts. Generic apps/api/jest-integration.json excludes that file. The production guard executes before any effect; missing credentials report the separate run skipped.

PLANNED apps/api/test/jest-fulfillment-timeout.json selects fulfillment-provider-timeout.e2e-spec.ts and excludes it from ordinary integration discovery. Configure testTimeout >=180000 ms and matching runner/service budget. A20 exercises the actual >=130-second threshold and is required by feature CI; existing 30-second defaults do not suffice.

Planned direct commands after those files exist:
~~~powershell
Set-Location 'C:\Users\taiph\.codex\worktrees\fulfillment-recovery-plan\Booking Systems\apps\api'
node node_modules\jest\bin\jest.js --config=test\jest-fulfillment-sandbox.json --runInBand
node node_modules\jest\bin\jest.js --config=test\jest-fulfillment-timeout.json --runInBand
~~~

App-directory actions.spec.ts runs through existing web test:route-contracts, not test:unit. Wire that lane into changed-web gates.

Virtual time advances due jobs/escalation only. A11 uses a short configurable lease and actual PostgreSQL-time expiry with barriers; never substitute app-time lease predicates.

PLANNED scripts/ci/run-fulfillment-acceptance.mjs owns isolated services and enforces the expected A01-A15/A17/A18/A21 variant manifest. .github/workflows/ci.yml runs it for relevant API/web/schema/harness changes and includes A20 in required aggregate status. Unhealthy services, zero discovery, omitted/skipped required variants, leaks and failed redaction checks fail. Sandbox is a separate manual/nightly job.
