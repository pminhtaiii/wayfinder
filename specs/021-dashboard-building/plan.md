# Implementation Plan: Authenticated Booking Dashboard

**Branch**: `021-dashboard-building` | **Date**: 2026-08-28 | **Spec**: [spec.md](spec.md)

**Input**: Approved decisions in `docs/adr/0019-dashboard.md`, the Wayfinder prototype in `apps/web/app/prototype/dashboard/`, and the feature specification in `specs/021-dashboard-building/spec.md`.

## Summary

Deliver `/dashboard` as the authenticated hub using one owner-scoped NestJS aggregate endpoint, a shared Zod contract, a no-store Next.js server loader, and a responsive production `DashboardShell` adapted from the approved glassmorphic prototype. The implementation reads `Booking` directly through Prisma, computes four booking-only metrics, returns five recent booking projections, redirects authenticated `/` traffic to the dashboard, and explicitly excludes caching, profile reads, currency totals, fabricated AI insights, and new persistence.

## Technical Context

**Language/Version**: TypeScript 5.4 on Node.js 20+

**Primary Dependencies**: NestJS 10, Prisma 5, Next.js 14.2 App Router, React 18, NextAuth 4, Zod 3, Lucide React, Tailwind CSS 4 alpha and CSS Modules (all already installed; no new dependency)

**Storage**: Existing PostgreSQL `Booking` table via Prisma; no migration and no Redis dashboard cache

**Testing**: Jest/ts-jest and Supertest for API; Node/tsx unit tests and Playwright for web; ESLint, TypeScript and Next production build gates

**Target Platform**: Server-rendered web application on desktop, tablet and mobile browsers; NestJS API service on the existing deployment target

**Project Type**: TypeScript monorepo web application with separate Next.js frontend, NestJS backend and shared-contract package

**Performance Goals**: One dashboard API call per server render; five indexed database reads issued together; no N+1 queries; endpoint p95 target under 200 ms in the local/CI benchmark fixture; web request bounded by 10 seconds

**Constraints**: Strict tenant scoping; no client credentials; `cache: 'no-store'`; no hardcoded color literals or raw Tailwind colors in production dashboard UI; no PII/provider/payment leakage; no fabricated fallback data; no new library or database migration

**Scale/Scope**: One authenticated dashboard route, one API module/endpoint, one shared contract family, five recent records, four metrics, root auth-aware redirect, responsive production shell, and targeted automated coverage

## Constitution Check

### Pre-design gate

| Principle                                | Result | Evidence                                                                                                                        |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Flight-first architecture                | PASS   | Dashboard exposes booking/flight activity and production travel actions only; hotel/dining/trip aggregates remain out of scope. |
| Deterministic transaction boundary       | PASS   | Metrics are deterministic PostgreSQL reads. No AI output participates in booking/payment state or dashboard truth.              |
| API budget discipline                    | PASS   | No Duffel or other external API call is added. The endpoint uses existing local snapshots and indexed queries.                  |
| Observability and operational visibility | PASS   | Existing structured request pipeline is reused; tests cover failures without logging response payloads or PII.                  |
| Incremental delivery                     | PASS   | US1 is a complete live dashboard MVP; US2 and US3 add hub actions and entry/resilience without invalidating US1.                |
| Security requirements                    | PASS   | JWT-derived ownership, no client token exposure, allowlisted projections, Zod validation and no payment/PII fields.             |
| Complexity discipline                    | PASS   | A thin dedicated module and direct Prisma reads are the simplest boundary matching the aggregate contract.                      |

### Post-design gate

PASS. The contract, data model and quickstart retain the same boundaries. The only new module is a cohesive dashboard read module; shared schemas prevent response duplication, and no constitutional exception is required.

## Design Decisions and Reconciliation

1. **ADR semantics override prototype mock content**: keep the four-card composition, but render Total, Upcoming, Completed and Cancelled Bookings. Do not publish the mocked Disruption Shield percentage.
2. **Visual fidelity without fake intelligence**: retain the Wayfinder hierarchy, atmospheric surface treatment, quick actions and recent timeline. Static fare-drop and seat-availability claims are omitted until a separately specified data contract exists.
3. **Tokenize before production use**: add semantic dashboard/glass tokens to `apps/web/app/globals.css`, including light/dark/fallback values, then consume them through CSS Modules or semantic Tailwind utilities. Prototype literals and inline styles are not copied.
4. **One server boundary**: `apps/web/lib/server/dashboard.ts` owns session access, backend URL resolution, timeout, no-store fetch, status mapping and shared-schema validation. `DashboardShell` receives only validated display data.
5. **Direct read model**: `DashboardService` injects only `PrismaService`, captures one clock value, and executes four counts plus one `findMany` concurrently. Completed counts include canonical `COMPLETED` plus unreconciled past `CONFIRMED`; cancelled counts use the five canonical cancellation/refund lifecycle states. A pure mapper extracts allowlisted display fields from `flightSnapshot`; malformed optional fields become `null`.
6. **No dynamic dashboard cache**: every page navigation fetches fresh data. There is no Redis dependency, tag revalidation or client polling.
7. **Feature-scoped navigation**: implement the approved desktop sidebar and sticky top bar inside `DashboardShell` only, with a compact mobile navigation replacement. Do not refactor the global layout or force other routes to adopt a sidebar.
8. **Only available actions**: quick actions always target `/search`, `/bookings?tab=upcoming`, and `/bookings?tab=past`. The `/dashboard` Server Component evaluates the existing `isBookingReadinessEnabled()` helper and exposes `/profile` only when the traveler-profile workspace is enabled; the dashboard feature itself remains independently deployable. The existing global `ChatWidget` remains available, while generic chat and disruption-center routes stay deferred because they do not exist.

## Project Structure

### Documentation (this feature)

```text
specs/021-dashboard-building/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── dashboard-summary.openapi.yaml
└── tasks.md
```

### Source Code (repository root)

```text
packages/shared/src/types/
├── dashboard.types.ts
├── dashboard.types.spec.ts
└── index.ts

apps/api/src/dashboard/
├── dashboard.controller.ts
├── dashboard.controller.spec.ts
├── dashboard.module.ts
├── dashboard.service.ts
└── dashboard.service.spec.ts

apps/api/src/
├── app.module.ts
└── app.module.spec.ts

apps/api/test/
└── dashboard.e2e-spec.ts

apps/web/app/
├── page.tsx
├── globals.css
└── dashboard/
    ├── dashboard.module.css
    ├── error.tsx
    ├── loading.tsx
    └── page.tsx

apps/web/components/dashboard/
├── DashboardShell.tsx
├── DashboardStats.tsx
├── DashboardRecentBookings.tsx
├── DashboardQuickActions.tsx
├── DashboardQuickSearch.tsx
├── dashboard-actions.ts
├── dashboard-actions.spec.ts
├── dashboard-search.ts
└── dashboard-search.spec.ts

apps/web/components/search/
└── SearchFormClient.tsx         # Add typed initial-value support

apps/web/app/search/
└── page.tsx                     # Sanitize query state and pass initial values

apps/web/lib/server/
├── dashboard.ts
└── dashboard.spec.ts

apps/web/tests/
└── dashboard.spec.ts
```

**Structure Decision**: Keep contract ownership in `packages/shared`, the aggregate/read model in its own NestJS `DashboardModule`, authenticated transport in a server-only web module, and visual composition in dashboard-specific React components. `DashboardShell` owns the prototype-approved dashboard-only desktop sidebar/sticky top bar and compact mobile equivalent; the global `Header` and other routes remain unchanged.

## Implementation Phases

### Phase 0 - Contract and deterministic query foundation

- Define shared Zod schemas and inferred types for stats, recent bookings, summary and web outcomes.
- Build the dashboard module with JWT guard, user-derived identity, direct Prisma counts and five-item projection.
- Verify time boundaries, null departures, `COMPLETED` plus stale-past-`CONFIRMED` semantics, all five cancellation-family statuses, tenant isolation, ordering, field allowlisting and 401 behavior before UI work.

### Phase 1 - Server data boundary and live dashboard MVP

- Implement the server-only loader with session acquisition, bounded no-store fetch and schema validation.
- Implement authenticated `/dashboard` Server Component behavior and typed `DashboardShell` composition.
- Tokenize the approved glassmorphic visual language and build responsive stats, recent-booking and empty/error/loading states.
- Confirm the production dashboard contains no prototype controls, static claims, hardcoded colors or client credentials.

### Phase 2 - Hub actions and route integration

- Implement quick-search validation/navigation using the existing production flight-search route and its accepted state format.
- Derive quick actions through a pure helper: always include `/search`, `/bookings?tab=upcoming`, and `/bookings?tab=past`, add `/profile` only when `isBookingReadinessEnabled()` is true, keep the global assistant widget available, and omit the unavailable generic disruption center.
- Verify keyboard interactions, focus visibility, accessible labels and mobile navigation.

### Phase 3 - Entry routing and end-to-end verification

- Make `/` session-aware: authenticated users redirect to `/dashboard`; anonymous users keep the marketing landing page.
- Add focused API E2E and Playwright coverage for live, empty, unauthorized, expired, malformed and unavailable states.
- Run shared/API/web static gates, targeted tests and production build; update architecture/progress documentation with verified results.

## Data Flow

```text
Browser -> Next.js /dashboard Server Component
        -> getDashboardSummary() [server-only, NextAuth JWT, no-store, timeout]
        -> GET /api/dashboard/summary [Bearer JWT]
        -> DashboardController [JwtAuthGuard, req.user.id]
        -> DashboardService [one now value]
        -> Prisma Booking counts x4 + recent findMany x1 [all user-scoped]
        -> allowlisted DashboardSummary contract
        -> shared Zod validation
        -> DashboardShell [display data only]
```

## Verification Strategy

- **Shared contract**: accept correct summaries; reject negative counts, prohibited/extra fields, invalid timestamps and over-five arrays.
- **Service unit**: exact Prisma filters, one clock boundary, canonical completed/cancellation status sets, null departures, `take: 5`, descending order and safe snapshot mapping.
- **Controller unit/API E2E**: JWT required, user identity forwarded, tenant isolation and exact response contract.
- **Web loader unit**: missing session, 401/403/5xx, timeout, malformed JSON, schema mismatch, no-store and zero credential leakage.
- **Page/browser**: start an in-process local API fixture on the configured port so Server Component fetches can exercise valid, 401, malformed and unavailable responses; cover root redirects, auth gate, populated/empty/error states, profile-action presence/absence for both booking-readiness flag values, quick actions, search handoff, recent links, 360/768/desktop layouts, keyboard focus and reduced motion.
- **Regression gates**: shared/API/web lint and typecheck, targeted Jest/Node/Playwright suites, then Next production build.

## Risks and Mitigations

| Risk                                                      | Mitigation                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Historical `flightSnapshot` shapes vary                   | Use a pure allowlist mapper; nullable display fields; fixtures for malformed/legacy shapes.         |
| Stats drift at the current-time boundary                  | Capture one `now` and pass it to all filters; test equality explicitly.                             |
| Prototype conflicts with current global navigation/tokens | Preserve hierarchy, add semantic tokens, reuse production routes, document intentional deviations.  |
| Authenticated root detection adds server work             | Use existing NextAuth session only; do not call the dashboard API from `/`.                         |
| Endpoint becomes a dumping ground                         | Limit scope to booking summary + five recent records; future aggregates require separate decisions. |

## Complexity Tracking

No constitution violations or exceptional complexity are introduced.
