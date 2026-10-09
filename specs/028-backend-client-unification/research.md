# Research: Backend Client Unification

**Source**: [Approved decision record](../../docs/adr/0005-backend-client-unification.md) and codebase census on 2026-09-25.

## R1. Scope and sequencing

**Decision**: Create the client with isolated tests; migrate dashboard, flight search, and booking management; then deduplicate six booking route adapters. Leave profile, checkout, and handoff proxy untouched.

**Rationale**: Dashboard is the smallest consumer and gains retries. Flight search proves mixed method handling. Booking management exercises the widest outcome set. The route adapter is booking-specific.

**Alternative considered**: One broad migration of all server modules would enlarge the review surface and overlap the handoff refactor.

## R2. Transport contract and response validation

**Decision**: Keep the ADR's success / HTTP / transport result union. The transport branch exposes only stable, safe cause codes (`missing_token`, `network`, `timeout`, `invalid_json`, `invalid_payload`) while detailed causes stay in internal structured logs. Each caller maps HTTP statuses and safe transport codes to its existing domain outcomes. Parse 400/422 HTTP bodies when possible so booking error messages remain available; retain status and default wording when parsing fails. Validate successful JSON responses with caller-supplied Zod schemas before returning data; use explicit none mode for status-only success and retain domain-view validation after mapping where it protects projections.

**Rationale**: Dashboard currently distinguishes malformed successful JSON/schema as non-retryable `INVALID_RESPONSE`; a completely opaque transport failure would erase that distinction. Booking and flight usually map these failures to `UPSTREAM_UNAVAILABLE`. Malformed non-2xx bodies retain HTTP status and fall back to existing booking 400/422 wording. Cause codes retain the two-kind failure union without exposing exception text. Six booking operations consume JSON and need raw schemas that preserve current tolerated fields/defaults; acknowledge and accept disruption currently inspect status only and must also accept bodyless 2xx through explicit none mode.

**Alternative considered**: Returning raw Response keeps duplicate parse/validation logic; returning domain Outcome couples transport to three vocabularies.

## R3. Retry and timeout

**Decision**: GET only; at most three total attempts; retry network/timeout and 502/503/504; retry 429 only with valid Retry-After; exponential base 100 ms, honoring the header; no mutation retries. Bound all attempts and waits to 31 seconds, with each attempt at most 10 seconds. If a Retry-After delay would exceed the remaining budget, return 429 without waiting or retrying early. Preserve `no-store` behavior.

**Rationale**: Current flight and booking helpers retry any 5xx GET, including 500. The ADR deliberately narrows this policy. Dashboard currently does not retry. This is the only intended resilience behavior change.

**Alternative considered**: Retrying all 5xx or mutations risks replaying deterministic failures or uncertain writes.

The ADR says seven booking endpoints; the current server module exports eight upstream operations. This plan enumerates the eight actual operations; six route handler files are a separate count.

## R4. Auth and route mapping

**Decision**: Default token provider retains NextAuth session extraction and current base URL precedence (`API_URL`, then `NEXT_PUBLIC_API_URL`, then local fallback). Missing token returns a safe transport cause before fetch; callers preserve their existing unauthenticated wording. `outcome-response.ts` owns only BookingManagementOutcome-to-NextResponse mapping.

**Rationale**: The factory stays reusable without tying its core to NextAuth; domain wording and route semantics remain local.

**Alternative considered**: A generic route adapter or shared domain reason enum creates unnecessary cross-domain coupling.

## R5. Scope and verification

**Decision**: No public route, API shape, Prisma, lockfile, or flag changes. Characterize the client retry/error matrix, each of the three domain modules, and six route mappings; run web lint, typecheck, and build.

**Rationale**: Existing tests cover the public outcomes; isolated client tests cover the new transport boundary.
