# Feature Specification: Narrow the Duffel Supplier Boundary

**Feature Branch**: `codex/029-duffel-provider-narrowing`
**Created**: 2026-09-29
**Status**: Draft for implementation
**Input**: [Approved grilling decisions](../../docs/adr/0022-duffel-provider-narrowing.md)

## Goal and scope

Split the 1,481-line `DuffelService` into search, ancillary, and order capabilities, each with its own Duffel SDK adapter and normalizer. Keep one internal SDK configuration and total budget owner. Domain consumers use supplier or flight vocabulary; Duffel vocabulary identifies concrete SDK and webhook code. Extract behavior first, then rename code, contracts, and real Prisma columns. No second supplier, new endpoint, new dependency, or new payment authority is in scope.

This is an internal refactor with one intentional policy change from the decision record: a 1,500-call daily Duffel budget, with 1,000 user-search and 500 agent-search allocations, replaces the current monthly search/reconciliation accounting. That policy must be tested and documented as a behavior change. HTTP route paths, serialized response keys, status codes, and error codes remain compatible; existing Duffel-named wire keys are isolated in compatibility DTO/mapping code until an explicitly versioned API change.

## User Scenarios & Testing

### User Story 1 - Search and offer detail through a narrow supplier boundary (Priority: P1)

A traveler or advisory agent searches for flights and opens an offer detail. Search ranking, cache behavior, offer persistence, expiry handling, and the existing API response remain intact while the domain path stops depending on `DuffelService` and private SDK access.

**Why this priority**: Search is the entry to every booking flow and contains the private SDK escape hatch.

**Independent Test**: With a mocked Duffel endpoint and database, search as user and agent, repeat for a cache hit, and open a live and expired offer; compare status, response JSON, stored offers, provider call counts, and budget accounting with the characterized baseline except for the explicitly changed daily limit.

**Acceptance Scenarios**:

1. **Given** valid criteria and budget, **when** a user searches, **then** the same ordered offers, match metadata, search hash, and persisted offer references are returned.
2. **Given** a cached search, **when** the criteria repeat, **then** the cached result is used without another Duffel call or budget charge.
3. **Given** a stored offer, **when** its detail is requested, **then** the lookup uses a public search capability and preserves price-change and expiry behavior.
4. **Given** an agent search, **when** the caller allocation is exhausted, **then** the existing `RATE_LIMIT_EXCEEDED` response is returned without an upstream call.
5. **Given** an existing saved offer, **when** booking readiness or chat handoff reads it, **then** supplier-shaped stored JSON is normalized before domain decisions and the same passenger/expiry/segment checks apply.

### User Story 2 - Ancillary selection and repricing through its own capability (Priority: P2)

A traveler loads seat maps and services, chooses ancillaries, and receives live repricing without the ancillary and payment validation paths importing the monolithic Duffel service.

**Why this priority**: Seat and baggage selection is in the deterministic booking path and has distinct cache and freshness rules.

**Independent Test**: Run seat-map, cache, missing-map, passenger-scoping, and repricing characterization checks with mocked SDK responses; verify the same catalog and payment-bound totals.

**Acceptance Scenarios**:

1. **Given** a valid offer, **when** its catalog is requested, **then** the existing seat maps, service identities, cache TTL, and fallback behavior are preserved.
2. **Given** a selected seat and baggage snapshot, **when** payment validation reprices it, **then** the same authoritative supplier total and validation errors are produced.

### User Story 3 - Order lifecycle through its own capability (Priority: P3)

A payment saga creates and retrieves an order; cancellation and recovery continue through the same supplier order capability. The existing fulfillment port, fencing, compensation, snapshot mapping, and privacy guarantees remain intact.

**Why this priority**: This is the money and booking path; extraction must be independently verified before deleting the monolith.

**Independent Test**: Run the fulfillment, cancellation, recovery, disruption sync, and compensation suites against mocked Duffel responses and compare side effects, state transitions, errors, and redacted evidence.

**Acceptance Scenarios**:

1. **Given** an authorized payment, **when** fulfillment runs, **then** one order is created under the existing `FULFILLMENT_GATEWAY_PORT` contract and its evidence omits passenger PII.
2. **Given** a cancellable order, **when** quote and confirmation run, **then** the same refund amount, idempotency behavior, and booking transitions result.
3. **Given** a stale or disrupted order, **when** recovery or sync runs, **then** the same snapshots and state decisions result without an additional provider call.

### User Story 4 - Neutral domain and persistence vocabulary (Priority: P4)

Maintainers can trace supplier identities through domain code, shared types, database columns, web mapping, and the Python agent using `Supplier` for infrastructure and `Flight` for domain objects. Duffel names remain where the Duffel SDK or webhook payload is genuinely involved, and only where required for existing serialized API compatibility.

**Why this priority**: Renaming after extraction keeps structural and naming changes separately reviewable.

**Independent Test**: Apply migrations to a clean database, generate Prisma types, run cross-service contract tests, and audit references so non-integration internal code has neutral names while current HTTP and SSE payloads remain byte-compatible.

**Acceptance Scenarios**:

1. **Given** a clean database, **when** migrations run, **then** supplier-named columns exist without `@map` aliases and `DuffelWebhookEvent` remains Duffel-named.
2. **Given** an existing browser or agent client, **when** it calls current endpoints, **then** route, response key, status, and error-code contracts remain unchanged.
3. **Given** the completed refactor, **when** module dependencies and names are audited, **then** no domain module imports the Duffel core or SDK, and no consumer imports `DuffelService` or `DuffelModule`.

### Edge Cases

- Missing or malformed `DUFFEL_API_URL` and missing token retain current fast-fail/configuration behavior.
- A budget counter must prevent an upstream call when exhausted, count every attempted upstream Duffel call once, and not charge cache hits; concurrent callers cannot exceed the configured limit.
- If an already-created order cannot be confirmed cancelled, the system must retain recoverable booking/payment state and order evidence; it must not void the payment hold and terminally fail the booking while the supplier order may remain active.
- Budget store failure must not silently create an unlimited call path; the same rate-limit failure semantics apply.
- Offer 404/410, missing seat map, price drift, provider timeout, cancellation replay, and recovery after partial payment must retain current externally observed outcomes.
- Raw Duffel order evidence may be stored only through existing redaction; the rename must not broaden PII exposure in logs, snapshots, agent results, or web views.
- Existing migration history must remain reproducible on a clean database; a forward migration performs real column/index renames.
- Existing `sel_v1_` attestations must keep the signed JSON byte shape. Old strict Redis search snapshots may fail closed to a fresh search, while persisted booking snapshot JSON must remain readable during local schema migration.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST expose three capability modules for search, ancillary, and order operations, with an internal shared Duffel SDK configuration module.
- **FR-002**: Search and order fulfillment MUST expose only the approved `FLIGHT_SEARCH_PORT` and existing `FULFILLMENT_GATEWAY_PORT` to provider-blind consumers. Ancillary, cancellation, and recovery remain concrete capabilities.
- **FR-003**: SDK calls MUST be contained in Duffel adapters. Capability-local normalizers MUST convert live and persisted supplier-shaped data to provider-neutral domain values before booking readiness, agent readiness, handoff, ranking, or other domain consumers interpret it.
- **FR-004**: Search MUST preserve ranking, personalization, cache/hash behavior, persistence, offer freshness, user/agent caller attribution, and current response/error contracts.
- **FR-005**: Ancillary MUST preserve catalog caching, seat/passenger identity mapping, repricing, and authoritative payment totals.
- **FR-006**: Order MUST preserve fulfillment port signatures, pre-invocation fencing, idempotency, cancellation, recovery, snapshots, and PII redaction.
- **FR-007**: One shared Duffel budget owner MUST enforce 1,500 attempted API calls per day. Search MUST enforce daily allocations of 1,000 user and 500 agent calls without sharing one caller's allowance with the other. Cache hits and skipped reconciliation runs MUST not charge either counter. Budget checks and reservations MUST be atomic across concurrent processes; legacy monthly charging in search and reconciliation MUST be removed.
- **FR-007a**: Any unconfirmed supplier cancellation during inline compensation, background handoff compensation, or stale-booking recovery MUST preserve a recoverable booking/payment state and supplier order evidence. The saga MUST leave its order-created idempotency checkpoint retryable. The sweeper MUST defer until the budget retry time or bounded failure backoff, then confirm cancellation before releasing the payment hold and terminally failing the booking.
- **FR-008**: Search cache policy MUST remain in search service; Duffel-specific admission control MUST remain in adapters. No new external request or retry is introduced just by the split.
- **FR-009**: Internal domain/shared/persistence identifiers MUST use `Supplier` or `Flight` vocabulary as appropriate; actual Prisma columns and indexes MUST be renamed by a forward migration, without `@map` aliases.
- **FR-010**: Existing HTTP/SSE paths, serialized payload keys, response status codes, and error codes MUST remain compatible. Duffel-named wire keys that are already exposed MUST be handled only by explicit edge compatibility DTOs/mappers and enumerated in the final audit.
- **FR-010a**: Selection-attestation HMAC payloads MUST retain their current serialized key order and values. Neutralized persisted booking snapshot JSON MUST read legacy `duffelSegmentId`; incompatible transient agent search snapshots MUST fail closed to a fresh search.
- **FR-011**: `DuffelWebhookEvent`, Duffel signature verification, and Duffel-specific webhook payload handling MUST retain Duffel names and behavior.
- **FR-012**: Extraction checkpoints MUST compile and pass focused characterization checks before deleting the old service/module; final gates MUST cover API, shared, web, agent, migrations, and provider-boundary audit.

### Key Entities

- **FlightOffer**: Provider-neutral search result used by ranking, detail, and booking selection; retains an opaque supplier offer identity and freshness.
- **FlightSearchResult**: Offers plus existing `searchHash` and `cached` metadata needed by persistence and response mapping.
- **SupplierOrder identity**: Provider-neutral persisted order, quote, passenger, and segment identifiers; linked to existing booking, intent, ancillary, and disruption state.
- **DuffelWebhookEvent**: Duffel-specific inbound event and payload; intentionally unchanged.
- **DuffelRateBudget**: Daily total attempt count plus user/agent search allocation counts, stored with a shared expiry boundary.

## Success Criteria

- **SC-001**: Search, offer detail, ancillary, fulfillment, cancellation, recovery, and disruption integration checks pass at every corresponding extraction checkpoint.
- **SC-002**: All existing HTTP/SSE contract fixtures pass with unchanged serialized keys, statuses, and error codes.
- **SC-003**: No direct `DuffelService`, `DuffelModule`, private SDK, or `@duffel/api` import remains outside the intended supplier implementation and Duffel webhook boundary.
- **SC-004**: Clean database migration and Prisma generation succeed; all intended non-webhook supplier ID columns are physically renamed and no `@map` aliases retain old column names.
- **SC-005**: Concurrent budget tests prove no more than 1,500 total daily attempts, 1,000 user search attempts, or 500 agent search attempts; cache hits consume zero.
- **SC-006**: Redaction tests show no passenger PII in persisted fulfillment evidence, logs, web views, or agent projections.

## Assumptions and exclusions

- There is no production data, but committed migrations remain the source of truth for fresh development and CI databases.
- The 1,500/1,000/500 values are an application policy from the grilling decisions, not a claim about Duffel's published quota. Existing monthly environment variables and keys need an explicit migration path.
- No second supplier, generic cancellation/ancillary port, API version, or new dependency is added.
- The existing public wire names are a compatibility exception to the internal neutral-vocabulary goal; a future versioned API may remove them.
