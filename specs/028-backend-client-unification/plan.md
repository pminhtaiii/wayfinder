# Implementation Plan: Backend Client Unification

**Branch**: `codex/027-028-specs-review` | **Date**: 2026-09-25 | **Spec**: [spec.md](./spec.md)

**Input**: [Feature specification](./spec.md), [decision record](../../docs/adr/0005-backend-client-unification.md), and [research reconciliation](./research.md).

## Summary

Extract one server-side backend client for the three core consumers. It owns URL resolution, token provider, timeout, method-safe retry, JSON parsing, and validation. Domain services keep their outcome vocabularies and mapping; a separate booking route adapter removes six duplicate response mappers. Existing contracts remain, except the ADR's intentional GET retry-policy change and dashboard resilience gain.

## Technical Context

**Language/Version**: Repository TypeScript/Next.js server runtime
**Primary Dependencies**: Existing NextAuth, Zod, Fetch/AbortController, shared view schemas; no new package
**Storage**: None; no schema or migration
**Testing**: Existing web server/route specs plus new isolated client spec; web lint, typecheck, build
**Target Platform**: Next.js server and route handlers
**Project Type**: Internal web transport refactor
**Performance Goals**: At most three attempts and 31 seconds total for eligible GET; one attempt for mutations; no request for missing token
**Constraints**: At most 10 seconds per attempt, no-store, auth and public outcome compatibility, PII-safe logs
**Scale/Scope**: Three server modules, one new client, one booking-specific route adapter, six route files, focused tests

## Constitution Check

*Gate reviewed before research and after design: PASS.*

| Principle | Design evidence |
|---|---|
| Flight-first and deterministic transaction boundary | No booking/payment authority changes; writes have no automatic replay. |
| API budget discipline | Retry is bounded and GET-only on transient conditions; no new provider call path. |
| Observability | Transport records safe internal failure categories and detailed diagnostics without bodies, tokens, or PII. |
| Incremental delivery | Client, dashboard, flight, booking, and routes are separately testable migrations. |
| Security | Default session auth and no-token behavior remain; successful backend data is validated at the trust boundary. |

No constitution violation. The factory is justified by the ADR's different-token-provider use case, while a generic domain outcome or route adapter is deliberately avoided.

## Project Structure

### Documentation (this feature)

```text
specs/028-backend-client-unification/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/backend-client.md
├── quickstart.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/web/lib/server/
├── backend-client.ts               # Factory, default client, inline transport types
├── backend-client.spec.ts
├── dashboard.ts                     # Dashboard-specific outcome mapping
├── dashboard.spec.ts
├── flight-search.ts                 # Flight-specific validation, projection, outcomes
├── flight-search.spec.ts
├── booking-management.ts           # Eight existing operations and booking outcomes
├── booking-management.spec.ts
└── outcome-response.ts             # BookingManagementOutcome → NextResponse

apps/web/app/api/booking-management/bookings/[bookingId]/
├── route.ts
├── cancellation/route.ts
├── cancellation/quote/route.ts
├── revisions/route.ts
├── disruptions/acknowledge/route.ts
└── disruptions/accept/route.ts
```

**Structure Decision**: Client is server-only transport infrastructure. Domain services import it and their existing schemas; route handlers import booking service plus booking-specific adapter. Profile, checkout, and handoff proxy remain as-is. Do not relocate shared view schemas or introduce a shared reason vocabulary.

## Phase 0: Research

[research.md](./research.md) records five choices. Current flight and booking helpers retry any 5xx GET, whereas the ADR narrows to 502/503/504 and 429 with Retry-After; dashboard currently has no retry. A 31-second total deadline prevents an unbounded Retry-After wait. Dashboard invalid successful JSON/schema data maps to `INVALID_RESPONSE`; malformed non-2xx bodies retain HTTP status so booking 400/422 fallback messages survive. Acknowledge/accept disruption accept bodyless 2xx via explicit none mode. No `NEEDS CLARIFICATION` remains.

## Phase 1: Design and Contracts

- [data-model.md](./data-model.md) defines transient result/token/request concepts; no persisted data.
- [contracts/backend-client.md](./contracts/backend-client.md) fixes factory API, retry matrix, failure mapping, and route adapter boundary.
- [quickstart.md](./quickstart.md) gives runnable checks and expected outcomes.

### Migration steps

1. Create and isolate-test `backend-client.ts`: default/injected auth and URL, missing-token short circuit, 10-second per-attempt and 31-second total deadline, no-store, HTTP error status with optional body, JSON/none success modes, schema validation, retry matrix, safe cause code and structured diagnostics.
2. Migrate `dashboard.ts` first; retain `INVALID_RESPONSE` for invalid JSON/schema and existing 401/403/unavailable wording. Add transient GET retry.
3. Migrate `flight-search.ts` request paths; preserve local input validation, domain transformations, outcome mapping, and final view validation. Search POST remains single-attempt; offer GET uses narrow retries.
4. Migrate all eight exported operations in `booking-management.ts`. Use raw schemas for list/detail/cancellation status/quote/cancel/revisions and none mode for disruption acknowledge/accept; retain booking-specific status/error-body mapping, domain view projections, and bodyless 2xx success. Each mutation remains single-attempt.
5. Move `mapOutcomeToResponse` to booking-specific `outcome-response.ts`; update all six route handlers. Run route parity tests and static duplicate census.
6. Delete orphaned transport helpers from the three consumers after parity checks; run full web gate.

**Gate after each step**: Relevant isolated/domain/route specs from quickstart. No backend service is needed for mocked transport tests.

## Complexity Tracking

None. The only new abstraction is the requested shared client. Safe cause codes are necessary to preserve the dashboard's existing invalid-response outcome within the ADR's two-kind failure union.
