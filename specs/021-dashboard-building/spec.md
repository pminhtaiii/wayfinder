# Feature Specification: Authenticated Booking Dashboard

**Feature Branch**: `021-dashboard-building`

**Created**: 2026-08-28

**Status**: Approved for planning

**Input**: Build the production dashboard from the approved Wayfinder prototype and the decisions in `docs/adr/0019-dashboard.md`.

## User Scenarios & Testing

### User Story 1 - View a trustworthy booking overview (Priority: P1)

As an authenticated traveler, I can open `/dashboard` and immediately see current booking totals and my five most recent bookings so I understand my travel activity without visiting several pages.

**Why this priority**: The dashboard currently returns 404. A live, owner-scoped overview is the minimum useful dashboard increment.

**Independent Test**: Seed bookings in multiple statuses for two users, sign in as one user, open `/dashboard`, and verify that the four metrics and recent-booking list reflect only that user's data and the current time boundary.

**Acceptance Scenarios**:

1. **Given** an authenticated user with bookings, **When** they visit `/dashboard`, **Then** they see lifetime, upcoming, completed, and cancelled booking counts computed from their own records.
2. **Given** more than five bookings, **When** the dashboard loads, **Then** it shows only the five newest bookings ordered by creation time descending.
3. **Given** another user has bookings, **When** the current user loads the dashboard, **Then** no metric or recent item includes the other user's data.
4. **Given** the user has no bookings, **When** the dashboard loads, **Then** all metrics are zero and an actionable empty state is shown.

---

### User Story 2 - Start the next travel task (Priority: P2)

As an authenticated traveler, I can use the dashboard's quick-search and action areas to continue to flight search, upcoming or past booking management, and—when booking readiness is enabled—the live traveler-profile workspace; the globally available travel assistant remains accessible through its existing widget.

**Why this priority**: The approved prototype makes the dashboard a working hub, not a passive report.

**Independent Test**: Render the dashboard with a valid summary, submit the quick-search inputs, and activate each supported action; each interaction reaches an existing production route with expected query state and no prototype-only URL.

**Acceptance Scenarios**:

1. **Given** valid origin, destination, and departure inputs, **When** the user submits quick search, **Then** the app navigates to the production flight-search flow with those values preserved.
2. **Given** the dashboard, **When** the user activates a quick action, **Then** the destination is a production route and the action is keyboard accessible.
3. **Given** a recent booking, **When** the user selects it, **Then** they reach the owned booking detail route.
4. **Given** booking readiness is disabled, **When** the dashboard renders, **Then** the Profile quick action is omitted while search and booking actions remain available.
5. **Given** booking readiness is enabled, **When** the dashboard renders, **Then** the Profile quick action is visible and links to the live traveler-profile workspace.

---

### User Story 3 - Enter and recover safely (Priority: P3)

As a visitor or traveler, I get the correct entry experience: authenticated users entering at `/` reach the dashboard, unauthenticated users keep the marketing page, and expired or unavailable dashboard data produces a safe recovery state.

**Why this priority**: The dashboard becomes the authenticated hub only if routing and failure behavior are deterministic and understandable.

**Independent Test**: Exercise `/` and `/dashboard` with authenticated, unauthenticated, expired-session, invalid-response, and unavailable-API scenarios and verify the expected redirect or recovery UI.

**Acceptance Scenarios**:

1. **Given** an authenticated session, **When** the user opens `/`, **Then** they are redirected to `/dashboard`.
2. **Given** no authenticated session, **When** a visitor opens `/`, **Then** the marketing landing page remains available.
3. **Given** no authenticated session, **When** a visitor opens `/dashboard`, **Then** they are redirected to `/login` without dashboard data being requested.
4. **Given** an expired backend token, **When** dashboard loading returns unauthorized, **Then** the user is sent to the session-expired login flow.
5. **Given** a timeout, malformed response, or upstream failure, **When** the dashboard renders, **Then** it shows a non-sensitive retry path and does not display stale or fabricated metrics.

### Edge Cases

- A booking whose `departureAt` equals the captured request time is upcoming, not completed.
- Confirmed bookings with `departureAt = null` count toward lifetime totals but neither upcoming nor completed totals.
- Non-confirmed future bookings do not count as upcoming; non-confirmed past bookings do not count as completed.
- A booking in any canonical cancellation lifecycle state remains included in `totalBookings` and `cancelledBookings`, including pending-refund and refund-attention states.
- Fewer than five recent bookings are returned without placeholder records.
- Malformed or provider-heavy `flightSnapshot` data is reduced to nullable, allowlisted display fields rather than passed through.
- Search input validation rejects same-airport routes and past departure dates before navigation.
- Narrow screens replace the prototype's fixed desktop side navigation with an accessible compact navigation treatment.
- Reduced-motion and no-backdrop-filter environments remain legible and operable.

## Requirements

### Functional Requirements

- **FR-001**: The API MUST expose authenticated `GET /api/dashboard/summary`.
- **FR-002**: The endpoint MUST derive the requesting user ID exclusively from the validated JWT and MUST scope every query by that user ID.
- **FR-003**: The response MUST include `totalBookings`, `upcomingBookings`, `completedBookings`, and `cancelledBookings`, preserving the ADR's metric intent through the canonical status mappings in `data-model.md`.
- **FR-004**: The service MUST capture one `now` value per request and use it consistently for upcoming/completed boundaries.
- **FR-005**: The response MUST include at most five recent bookings ordered by `createdAt` descending.
- **FR-006**: The recent-booking projection MUST expose only contract-allowlisted display fields and MUST NOT expose provider identifiers, raw snapshots, passenger PII, payment identifiers, or tokens.
- **FR-007**: `DashboardSummarySchema` and its nested schemas in `packages/shared/src/types/dashboard.types.ts` MUST be the single response-shape source of truth.
- **FR-008**: `DashboardService` MUST query PostgreSQL directly through `PrismaService`; Redis caching and dependencies on booking-management/profile services are prohibited for this feature.
- **FR-009**: The Next.js server loader MUST authenticate server-side, send the bearer token only server-to-server, use `cache: 'no-store'`, bound request duration, and validate the response using the shared Zod schema.
- **FR-010**: `/dashboard` MUST be an authenticated Server Component and MUST render through a typed `DashboardShell` interface.
- **FR-011**: The production UI MUST translate the approved Wayfinder glassmorphic visual hierarchy into existing semantic design tokens; it MUST NOT copy hardcoded prototype hex values or raw Tailwind color classes.
- **FR-012**: The fourth stat card MUST display cancelled bookings. The prototype-only Disruption Shield percentage and static AI insight claims MUST NOT be presented as live data.
- **FR-013**: The dashboard MUST always provide quick actions for flight search, upcoming bookings, and past bookings. It MUST provide the traveler-profile action only when `isBookingReadinessEnabled()` returns true; dashboard rollout itself MUST NOT require booking readiness. The existing global `ChatWidget` remains the assistant entry point, and absent generic disruption-center or `/chat` routes MUST NOT be invented or replaced with prototype links.
- **FR-014**: The quick-search control MUST preserve valid origin, destination, and departure values when entering the production search flow.
- **FR-015**: Recent-booking items MUST link to `/bookings/[bookingId]` and the complete-list affordance MUST link to `/bookings`.
- **FR-016**: The root route MUST redirect authenticated users to `/dashboard` while preserving the marketing page for unauthenticated visitors.
- **FR-017**: The dashboard MUST provide distinct zero-data, unauthenticated/session-expired, and upstream-unavailable behavior without fabricated fallback metrics.
- **FR-018**: The dashboard MUST meet keyboard, focus, landmark, contrast, reduced-motion, and responsive-layout requirements.
- **FR-019**: Unit, contract, integration, and browser tests MUST cover metric definitions, tenant isolation, response validation, auth redirects, empty/error states, navigation, and responsive accessibility.
- **FR-020**: This iteration MUST NOT add a database migration, Redis keys, profile completeness query, currency aggregation, trip aggregate, or AI match-score aggregation.
- **FR-021**: `completedBookings` MUST count canonical `COMPLETED` records plus legacy/stale `CONFIRMED` records whose `departureAt` is before the captured request time, without double counting.
- **FR-022**: `cancelledBookings` MUST count the canonical cancellation-family statuses `CANCELLATION_PENDING`, `CANCELLED_PENDING_REFUND`, `CANCELLED_AND_REFUNDED`, `CANCELLED_NO_REFUND`, and `REFUND_FAILED_NEEDS_ATTENTION`; implementation MUST NOT reference nonexistent `BookingStatus.CANCELLED`.

### Key Entities

- **DashboardSummary**: Request-time projection containing one booking-stat snapshot and up to five recent booking projections for one authenticated user.
- **DashboardStats**: Four non-negative integer booking counts with explicit time/status semantics.
- **DashboardRecentBooking**: PII-safe display projection derived from `Booking` plus allowlisted route/airline fields extracted from the stored flight snapshot.
- **DashboardOutcome**: Web-layer success/failure union that keeps transport/auth failures out of the visual component contract.

## Success Criteria

### Measurable Outcomes

- **SC-001**: All four displayed metrics match the approved Prisma query definitions across boundary-time and mixed-status test fixtures.
- **SC-002**: Cross-user test fixtures yield zero leaked counts and zero leaked recent records.
- **SC-003**: The summary returns no more than five recent bookings, newest first, with zero prohibited provider/payment/PII fields.
- **SC-004**: Dashboard navigation performs one backend summary request per server render and no Redis dashboard operation.
- **SC-005**: Authenticated root entry reaches `/dashboard`; unauthenticated root entry still renders marketing content; direct unauthenticated dashboard entry reaches login.
- **SC-006**: The production dashboard has no prototype banner/switcher, no prototype-only links, and no hardcoded color values in dashboard production components/styles.
- **SC-007**: At 360 px, 768 px, and desktop widths, all dashboard content remains readable without horizontal overflow and all primary actions are keyboard reachable.
- **SC-008**: The API unit/contract tests, web unit tests, dashboard Playwright tests, lint, typecheck, and production build pass.
- **SC-009**: With booking readiness disabled, zero dashboard links lead to the disabled profile fallback; with it enabled, the Profile action is present and reaches `/profile`.

## Assumptions

- Existing JWT/NextAuth behavior, Booking records, stored flight snapshots, and booking detail routes are reused unchanged.
- No new third-party package is required; NestJS, Prisma, Next.js, React, Zod, Lucide, Jest, and Playwright are already installed.
- The approved visual reference is authoritative for hierarchy, spacing, glass surfaces, and responsive intent; the ADR is authoritative for live domain semantics and data scope.
- Unsupported prototype content may remain only in the isolated `/prototype/dashboard` route and is not copied into production as factual data.

## Out of Scope

- Multi-currency spending totals or conversion.
- Trips, hotels, dining aggregates, average match scores, and profile completeness.
- A generic activity/audit feed.
- Dashboard Redis caching or background refresh polling.
- New AI-generated insights, fare-drop claims, seat-availability claims, or a dashboard notification system.
- Reworking the booking lifecycle, payment flow, or traveler profile domain.
