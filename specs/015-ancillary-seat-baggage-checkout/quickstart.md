# Quickstart Validation: Ancillary Seat and Baggage Checkout

This guide defines runnable proof for the completed feature. It does not replace `tasks.md` or implementation tests.

## Prerequisites

1. Docker Desktop is running with PostgreSQL and Redis from `docker compose up -d`.
2. API/web test environment variables are configured with matching project secrets and Duffel/Stripe test adapters or sandbox credentials.
3. Database migrations and seed data are current.
4. Test fixture includes an owned, unexpired BookingIntent with two adults, one lap infant, two segments, seat maps, segment baggage, journey-wide baggage, and one unavailable-seat scenario.

## Install and prepare

```powershell
pnpm install
pnpm --filter @api/backend exec prisma migrate dev
pnpm --filter @api/backend exec prisma db seed
```

## Static and unit verification

```powershell
pnpm --filter @shared/types build
pnpm --filter @api/backend lint
pnpm --filter @api/backend test
pnpm --filter @web/frontend lint
pnpm --filter @web/frontend test
```

Expected: type-safe contracts build, pure reducer/normalizer/validation tests pass, and existing suites remain green.

## API E2E verification

```powershell
npm run test:e2e --workspace=apps/api -- --runInBand
```

Required scenarios:

1. Owner can fetch catalog; another user receives the existing protected-resource behavior.
2. Cache miss calls Duffel once, normal hit calls zero times, `TTL <= 3` and force refresh call once.
3. Snapshot commit enforces passenger/segment/service/currency rules, inserts an append-only version, and atomically advances the current pointer without altering earlier versions.
4. Same idempotency key/body replays; key reuse with different body conflicts.
5. Concurrent expected-version updates produce one winner and one canonical version conflict.
6. Payment creation freezes and reprices the exact version before Stripe; a concurrent mutation conflicts and creates no PaymentIntent.
7. Payment amount equals authoritative base + services in minor units and is bound to the frozen/validated version.
8. Confirmation passes exact service IDs to Duffel, captures only after order success, and cancels authorization on order failure.
9. Duplicate confirmation/recovery creates at most one PaymentIntent/order/capture, and a Payment bound to version N still reconstructs N after the traveller commits version N+1.
10. Existing cancellation quote/refund recovery tests prove ancillary-inclusive/excluded supplier amounts are not recalculated locally.
11. Cleanup cannot delete a snapshot referenced by Payment; after the retention lifecycle releases that reference, normal parent cleanup can cascade unreferenced versions.

## Browser E2E verification

Start the full stack or use the Playwright `webServer` configuration, ensuring `NEXT_PUBLIC_API_URL=http://127.0.0.1:3001`.

```powershell
npx playwright test --config=apps/web/tests/playwright.config.ts
```

Required journeys:

1. Two adults choose distinct seats on segment one, skip segment two, and group indicators remain correct across passenger tabs.
2. Infant is skipped; unavailable/missing seat-map states are announced and cannot be selected.
3. Journey-wide baggage disables overlapping segment options and is counted once across tabs.
4. Price tracker updates instantly with zero browse-time repricing calls.
5. Continue persists snapshot; targeted review edit links return to the correct section without losing other selections.
6. Tab close/reopen hydrates an unexpired committed selection after server reconciliation; expired/mismatched local state is discarded.
7. Repricing conflict preserves valid items, marks invalid service/segment/passenger, and blocks payment until reviewed.
8. Keyboard-only navigation covers segment tabs, passenger tabs, seat grid, baggage controls, skip/continue, and live price/status announcements.
9. Desktop target and narrow viewport keep controls usable; horizontal seat-grid scrolling is acceptable under the approved desktop-first boundary.

## Focused resilience checks

- Abort after Stripe authorization and before Duffel order: retry resumes safely.
- Fail Duffel order creation: authorization is cancelled and no confirmed Booking exists.
- Fail Stripe capture after Duffel order: existing compensation/recovery behavior remains observable and auditable.
- Expire BookingIntent with committed selections: cron transitions/deletes the parent and cascade-cleans selection rows.
- Attempt tampered service/passenger/segment IDs: zero Stripe and zero Duffel order calls.

## Operational proof

Confirm dashboards/log capture expose, without PII:

- seat-map cache hit/miss/early-expiry/force-refresh;
- Duffel ancillary request rate, latency, rate-limit, and failure counts;
- selection validation conflicts by stable reason code;
- committed/validated snapshot counts and version conflicts;
- ancillary value and service counts by type/currency (no passenger identity);
- payment/order compensation and idempotent replay outcomes.

## Acceptance

Feature acceptance requires every success criterion in `spec.md` to map to passing unit/API E2E/Playwright evidence, all existing booking/payment/cancellation suites to remain green, and rollout/rollback flags to be rehearsed without deleting committed intent data.
