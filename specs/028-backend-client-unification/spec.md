# Feature Specification: Backend Client Unification

**Feature Branch**: `codex/027-028-specs-review`
**Created**: 2026-09-25
**Status**: Draft for review
**Input**: [Backend client decision record](../../docs/adr/0005-backend-client-unification.md)

## User Scenarios & Testing

### User Story 1 - Resilient dashboard reads (Priority: P1)

As a signed-in traveler, I see the same dashboard data and errors while brief network or gateway failures receive bounded automatic retries.

**Independent Test**: Exercise the client with fake fetch/token providers, then the dashboard read with success, transient failure, invalid payload, and absent authentication.

**Acceptance Scenarios**:

1. **Given** a transient failed dashboard GET, **when** the backend recovers within the attempt limit, **then** the same successful summary appears.
2. **Given** no valid session token, **when** a dashboard read starts, **then** the existing unauthenticated outcome occurs without an unauthorized request.
3. **Given** malformed backend data, **when** read, **then** the existing safe unavailable or invalid response occurs.

---

### User Story 2 - Preserve flight outcomes (Priority: P2)

As a traveler, I search and view offers with the same domain outcomes while transport and response validation are handled consistently.

**Independent Test**: Run flight-search characterization for success, validation, expired offer, status mapping, timeout, and request method; assert only eligible GETs retry.

**Acceptance Scenarios**:

1. **Given** any existing flight request, **when** it completes, **then** the public outcome reason and payload are unchanged.
2. **Given** a mutating request fails, **when** handled, **then** it is not replayed automatically.

---

### User Story 3 - Preserve booking outcomes (Priority: P3)

As a traveler managing a booking, I receive the same list, detail, cancellation, revision, disruption, and error outcomes after transport is unified.

**Independent Test**: Run booking-management characterization for all operations, including authorization, stale revision, conflict, transport failure, and malformed response.

**Acceptance Scenarios**:

1. **Given** an existing booking-management request, **when** it completes, **then** its domain reason and payload match the established contract.
2. **Given** a booking mutation fails, **when** it returns, **then** the request was sent at most once.

---

### User Story 4 - Share booking route response mapping (Priority: P4)

As an API maintainer, I update the booking-management outcome-to-HTTP mapping in one place without changing route responses.

**Independent Test**: Compare six route handlers' status, body, and headers for representative outcomes before and after extraction.

**Acceptance Scenarios**:

1. **Given** any supported booking outcome, **when** a route responds, **then** status and body are unchanged.
2. **Given** a mapping change, **when** inspected, **then** one booking-specific adapter owns it.

### Edge Cases

- Network error, timeout, malformed successful JSON, and successful-payload schema failure have no HTTP status in the transport result; internal causes remain observable without secrets or PII. A malformed non-2xx error body retains its HTTP status with no parsed body, so booking 400/422 uses its existing default message.
- GET retries apply to network/timeout, 502/503/504, and 429 with Retry-After. Other statuses, including 500, are not retried. A Retry-After beyond the bounded request deadline returns the current 429 rather than waiting or retrying early.
- Mutations never retry without an idempotency key. Maximum three total GET attempts, exponential backoff starting at 100 ms.
- Missing tokens preserve current unauthenticated outcomes and avoid unauthorized backend calls.
- Malformed backend payloads fail validation at the trust boundary.
- Disruption acknowledge/accept actions retain status-only success even when the successful response has an empty body.

## Requirements

### Functional Requirements

- **FR-001**: Flight-search, booking-management, and dashboard server modules MUST share one client for base URL, token acquisition, timeout, retry, JSON parsing, and response validation.
- **FR-002**: The client MUST return a typed result distinguishing success, HTTP failure with status/body, and transport failure without status; callers MUST retain domain-specific status mapping.
- **FR-003**: The client MUST validate successful JSON payloads with a caller-provided schema before returning trusted data. For operations whose success is defined only by HTTP status, it MUST support an explicit no-content mode that does not parse a body and returns a void result.
- **FR-004**: A factory MUST accept an optional token provider and base URL; the default instance MUST retain session-based authentication and environment URL behavior.
- **FR-005**: GET MUST make at most three total attempts, retrying only network errors/timeouts, 502/503/504, and 429 with Retry-After, with exponential backoff from 100 ms and respect for the header. Total request time, including attempts and waits, MUST be bounded to 31 seconds; if the required Retry-After cannot fit that deadline, return the 429 without an early retry.
- **FR-006**: POST, PUT, PATCH, and DELETE MUST never retry automatically; GET MUST not retry 400, 401, 403, 404, 409, 422, 500, or other deterministic responses.
- **FR-007**: The client MUST use the existing 10-second request timeout and log internal transport, parse, and validation causes without sensitive response data.
- **FR-008**: Each domain module MUST preserve its complete outcome vocabulary, payloads, and status mapping, including dashboard INVALID_RESPONSE for malformed JSON/schema data. No shared outcome-reason base is introduced.
- **FR-009**: One booking-specific route adapter MUST replace duplicate mapOutcomeToResponse functions in the six booking-management handlers, preserving their HTTP contract.
- **FR-010**: Profile, checkout, and handoff proxy modules MUST remain outside this refactor.
- **FR-011**: No public endpoint, request/response shape, authentication rule, database schema, package dependency, or feature flag may change.
- **FR-012**: Tests MUST cover retry matrix, method safety, timeout, auth, parsing/validation, domain outcome parity, and route response parity.
- **FR-013**: Malformed non-2xx error bodies MUST retain the HTTP status with an absent parsed body; malformed successful JSON MUST return a transport failure. Booking 400/422 MUST keep its default message when the error body cannot be parsed.

### Key Runtime Entities

- **Transport result**: Success with validated data, HTTP failure with status/body, or transport failure without status.
- **Token provider**: Pluggable source of a bearer token.
- **Domain outcome**: Existing flight, booking, or dashboard interpretation of transport status and data.
- **Booking route response**: Existing HTTP representation of a booking-management outcome.

## Success Criteria

### Measurable Outcomes

- **SC-001**: All in-scope domain and route characterization tests pass with zero intentional public contract changes.
- **SC-002**: Covered mutations are sent once or fewer; eligible GETs make no more than three attempts, and ineligible failures make one.
- **SC-003**: Every JSON-consuming success is validated once at the backend trust boundary; malformed data is rejected before domain use. Both status-only disruption actions accept bodyless 2xx without parsing.
- **SC-004**: Static inspection finds one in-scope owner of base URL, token, timeout, retry, and parsing logic and one booking response mapper.
- **SC-005**: Dashboard succeeds after a transient read failure when the backend recovers within the bounded retry window.
- **SC-006**: A far-future Retry-After produces no wait beyond the 31-second total deadline, and bodyless successful disruption actions still succeed.

## Assumptions

- Existing backend API and domain outcomes are the compatibility authority where the ADR does not enumerate every status or payload.
- The client is internal to the server runtime; browser and outlier modules are outside scope.
- The 10-second timeout applies per attempt within the 31-second total request deadline.
