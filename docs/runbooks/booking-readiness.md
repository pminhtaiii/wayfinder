# Traveler Profile & Booking Readiness Operations Runbook

Feature 16 operations and site reliability engineering runbook. Establishes the operational contract, observability baselines, incident playbooks, cryptographic invariants, backfill governance, and emergency procedures for Traveler Profile and Booking Readiness. See the [plan](../../specs/016-traveler-profile-booking-readiness/plan.md), [spec](../../specs/016-traveler-profile-booking-readiness/spec.md), [contracts](../../specs/016-traveler-profile-booking-readiness/contracts/api.md), and [architecture](../../context/architecture.md).

---

## 1. System Topology and Decision Ownership

### 1.1 Production Request and Data Flow

```text
+---------------------------------------------------------------------------------------------------------+
|                                              BROWSER / CLIENT                                           |
|  - Protected Profile Form (/profile) -> same-origin API proxy (/api/profile)                            |
|  - Checkout Passenger Form (/checkout/passengers) -> plural readiness check                             |
|  - Checkout Review Page (/checkout/[intentId]/review) -> masked summary projections only                |
|  - ChatWidget (SSE Listener) -> metadata-only ACTION_REQUIRED event consumer                            |
+----------------------------------------------------+----------------------------------------------------+
                                                     |
                          +--------------------------+--------------------------+
                          |                                                     |
                          v                                                     v
+--------------------------------------------------+  +--------------------------------------------------+
|            NEXT.JS WEB APPLICATION               |  |               FASTAPI PYTHON AGENT               |
|  - Server Components (/profile, /checkout)       |  |  - check_booking_readiness tool (metadata-only)  |
|  - Same-origin auth proxy (/api/profile)         |  |  - LangGraph Router & Confirmation Boundary      |
|  - Server-side bearer JWT & CSRF protection      |  |  - Zero PII in memory, SSE events, or logs       |
+-------------------------+------------------------+  +-------------------------+------------------------+
                          |                                                     |
                          | Bearer JWT (User)                                   | Agent API Key + Claim Token
                          +--------------------------+--------------------------+
                                                     |
                                                     v
+---------------------------------------------------------------------------------------------------------+
|                                          NESTJS API GATEWAY                                             |
|  - /api/profile (Protected Profile CRUD, revision CAS, atomic document section)                         |
|  - /api/bookings/intents/readiness (Advisory readiness evaluation, 0 I/O writes, 0 supplier calls)       |
|  - /api/bookings/intents (Authoritative validation, atomic transactional intent + snapshot creation)   |
|  - /api/agent-gateway/bookings/readiness (PII-stripped safe projection for Python agent)                |
|  - /api/bookings/intent (Deprecated singular alias with legacy useProfile compatibility translation)    |
+----------------------------------------------------+----------------------------------------------------+
                                                     |
                                                     v
+---------------------------------------------------------------------------------------------------------+
|                                    CORE APPLICATION & DOMAIN SERVICES                                   |
|                                                                                                         |
|  [ TravelerProfileService ]                                                                             |
|    - User-scoped CRUD, revision CAS (expectedRevision), dual-write (legacy Date + bound ciphertext)     |
|                                                                                                         |
|  [ BookingReadinessEvaluator ]                                                                          |
|    - Pure, zero-I/O domain evaluator: DOMESTIC | INTERNATIONAL | UNKNOWN scope                           |
|    - Evaluates identity, contact, atomic document rules, trip completion expiry, advisory buffer        |
|                                                                                                         |
|  [ BookingReadinessService ]                                                                            |
|    - Resolves offer slices/segments, batch resolves airport countries (AirportsModule)                   |
|    - Resolves passenger sources (traveler_profile vs inline), executes evaluator without writes         |
|                                                                                                         |
|  [ BookingIntentService & PassengerSnapshotService ]                                                    |
|    - Authoritative pre-validation inside prisma.$transaction                                            |
|    - Generates immutable passenger snapshot rows with AES-256-GCM record-bound AAD                      |
|                                                                                                         |
|  [ BookingPassengerFinalValidatorService ]                                                              |
|    - Executes inside PaymentService idempotency claim owner immediately before Duffel order creation    |
|    - Decrypt-then-expiry strict order, AAD MAC verification, produces ephemeral in-memory supplier DTO |
+-----------------------------------+----------------------------------+----------------------------------+
                                    |                                  |
                                    v                                  v
+--------------------------------------------------+  +--------------------------------------------------+
|              PERSISTENCE & STORAGE               |  |           EXTERNAL THIRD-PARTY BOUNDARIES        |
|  - PostgreSQL / Prisma:                          |  |  - Duffel Flights API:                           |
|    * traveler_profiles (revision, ciphertext)    |  |    * Called ONCE during final payment capture   |
|    * booking_intents & intent_passengers         |  |    * ZERO Duffel calls during readiness/intent   |
|    * audit_logs (trace_id, correlation_id)      |  |  - Stripe API:                                   |
|  - Redis Cache Plane:                            |  |    * Payment authorization & idempotency hold    |
|    * Distributed metrics & latency percentiles   |  |    * Voided automatically on validation failure  |
+--------------------------------------------------+  +--------------------------------------------------+
```

### 1.2 Component Responsibility & Decision Ownership

| Component            | Responsibility / Scope                                                                                                             | Prohibited Actions / Invariants                                                                                                    |
| :------------------- | :--------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| **Browser / UI**     | Displays masked profile/intent state; collects form inputs; follows secure handoff links (`/profile?returnTo=...`).                | Makes zero booking or readiness decisions; stores zero unmasked sensitive PII in local storage, session storage, or URLs.          |
| **FastAPI Agent**    | Executes `check_booking_readiness` tool; emits metadata-only `ACTION_REQUIRED` SSE events.                                         | Never receives or handles passenger PII; never writes database rows; never executes financial or supplier bookings directly.       |
| **Profile Service**  | Enforces user ownership (`userId === token.sub`); executes revision CAS (`expectedRevision`); manages atomic document replacement. | Never logs decrypted document data; never leaks other users' profile records; never returns raw ciphertext.                        |
| **Pure Evaluator**   | Side-effect-free deterministic rule engine evaluating domestic vs international completeness, passport validity, and warnings.     | Performs zero database, network, cache, or external API I/O; enforces zero hard 180-day passport blocking (advisory warning only). |
| **Advisory Service** | Resolves flight segments, airport countries, and passenger sources; projects safe readiness shape with revision metadata.          | Performs zero database writes; creates zero intent or snapshot rows; makes zero external supplier API calls.                       |
| **Intent Service**   | Executes authoritative validation in transactional boundary; captures immutable passenger snapshots; creates `BookingIntent`.      | Creates zero partial state on rejection (atomic rollback); never permits unowned profile references or revision mismatches.        |
| **Final Validator**  | Authenticates context-bound AES-256-GCM ciphertext; revalidates document expiry against live clock; creates ephemeral Duffel DTO.  | Operates strictly within the winning payment claim lock; never logs decrypted PII; never proceeds if MAC tag or AAD fails.         |
| **Duffel Boundary**  | Live offer verification and order booking (`duffel.orders.create`).                                                                | Called strictly once per confirmed transaction by deterministic NestJS service; never called during readiness checks.              |
| **Stripe Boundary**  | Customer payment intent creation, authorization hold, and capture.                                                                 | Payment authorization is voided/released immediately if final passenger validation fails before Duffel order creation.             |

---

## 2. Feature Flags and Rollout Order

### 2.1 Feature Flags Specification

| Environment Variable                         | Service Layer                     | Default | Safe State / Runtime Relationship                                                                                                                                                                                                                                       |
| :------------------------------------------- | :-------------------------------- | :------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FEATURE_FLAG_BOOKING_READINESS`             | Backend NestJS API (`apps/api`)   | `false` | Master backend switch. When `true`, enables `/api/profile`, `/api/bookings/intents/readiness`, plural `/api/bookings/intents`, and agent gateway readiness endpoints. When `false`, returns 404 FEATURE_DISABLED on new-only endpoints while legacy checkout continues. |
| `NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS` | Frontend Next.js Web (`apps/web`) | `false` | Master frontend switch. When `true`, activates profile page UI (`/profile`), plural passenger checkout form, and masked review page. When `false`, falls back to legacy single-passenger checkout form.                                                                 |
| `PASSPORT_ADVISORY_BUFFER_DAYS`              | Backend NestJS API (`apps/api`)   | `180`   | Configurable advisory window (clamped between 30 and 365 days). Passports expiring within this buffer after trip completion generate `PASSPORT_VALIDITY_REQUIRES_VERIFICATION` warning without blocking booking.                                                        |
| `FEATURE_FLAG_CHAT_HANDOFF_ISSUE`            | Backend NestJS / Python Agent     | `false` | Chatbot handoff issuance toggle. Must be enabled only after booking readiness is verified in API.                                                                                                                                                                       |
| `FEATURE_FLAG_CHAT_HANDOFF_ACCEPT`           | Backend NestJS API                | `false` | Chatbot handoff acceptance toggle. Must be active before issuance.                                                                                                                                                                                                      |

### 2.2 Controlled 5-Step Rollout Order

```text
[Step 1: Additive Schema & Encryption Key Check]
  Deploy Prisma additive migration (nullable columns, revision default 0, passportExpiryCiphertext shadow).
  Verify ENCRYPTION_KEY is active and valid 32-byte hex. Feature flags remain false.
        │
        ▼
[Step 2: Backfill Warmup & Verification]
  Run PassportExpiryBackfillService dry-run / initial batch.
  Verify processed > 0, quarantined === 0, abort threshold not breached.
        │
        ▼
[Step 3: Backend API Readiness Activation]
  Set FEATURE_FLAG_BOOKING_READINESS=true on apps/api.
  Verify GET /health/booking-readiness returns status: "ok" and featureFlags.bookingReadiness: true.
  Verify singular alias routes (/api/bookings/intent) translate legacy useProfile seamlessly.
        │
        ▼
[Step 4: Frontend Web UI Activation]
  Set NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS=true on apps/web.
  Verify /profile loads and saves all sections; verify /checkout/passengers handles plural sources.
        │
        ▼
[Step 5: Agent Chat Integration Activation]
  Enable check_booking_readiness tool on Python Agent.
  Verify chat emits metadata-only ACTION_REQUIRED and hands off cleanly to /profile or /checkout.
```

### 2.3 Invalid & Unsafe Configuration Combinations

- ❌ **INVALID**: `NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS=true` with backend `FEATURE_FLAG_BOOKING_READINESS=false`.
  _Impact_: Web frontend attempts to invoke `/api/bookings/intents/readiness` and `/api/profile`, receiving 503 errors and crashing checkout flows.
- ❌ **INVALID**: `FEATURE_FLAG_CHAT_HANDOFF_ISSUE=true` with `FEATURE_FLAG_BOOKING_READINESS=false`.
  _Impact_: Chat emits handoffs that cannot complete readiness evaluation or plural snapshot persistence.
- ❌ **UNSAFE**: Setting `FEATURE_FLAG_BOOKING_READINESS=true` without a verified `ENCRYPTION_KEY` in environment.
  _Impact_: `EncryptionService` fails fast on boot or throws `SNAPSHOT_INTEGRITY_FAILURE` during intent creation, blocking all checkouts.
- ❌ **UNSAFE**: Prematurely dropping the legacy `passportExpiry` column before backfill completion and dual-write deprecation sign-off.

### 2.4 Instant Emergency Rollback

To instantly roll back the feature without service interruption or database restoration:

1. Set `NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS=false` in web deployment and deploy immediately.
2. Set `FEATURE_FLAG_BOOKING_READINESS=false` in API deployment.
3. Web application immediately reverts to legacy single-passenger checkout form with `useProfile` parameter.
4. API singular endpoints (`POST /api/bookings/intent`) gracefully handle legacy payloads using dual-written legacy columns.
5. All previously created `BookingIntent` and `TravelerProfile` rows remain safe and uncorrupted.

---

## 3. Telemetry, Metrics & Observability

### 3.1 The 11 Standardized Metric Counters

The system implements 11 standardized, PII-free Prometheus/OpenTelemetry metric counters declared in `BOOKING_READINESS_METRIC_COUNTERS` (`apps/api/src/common/observability/booking-readiness.metrics.ts`):

| Metric Counter Identifier                           | Type    | Trigger / Call Site                                    | Operational Meaning & Anomaly Trigger                                                                                 |
| :-------------------------------------------------- | :------ | :----------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| `traveler_profile_reads_total`                      | Counter | `GET /api/profile`                                     | Total profile read requests. A drop to 0 indicates web-to-API routing failure.                                        |
| `traveler_profile_updates_total`                    | Counter | `PATCH /api/profile`                                   | Total successful profile creations and revision increments.                                                           |
| `traveler_profile_conflicts_total`                  | Counter | `PATCH /api/profile` (HTTP 409)                        | CAS revision conflicts (`PROFILE_UPDATE_CONFLICT`). Spike indicates concurrent multi-tab edits or stale client forms. |
| `booking_readiness_checks_total`                    | Counter | `POST /api/bookings/intents/readiness` & Agent Gateway | Total advisory readiness checks requested by web and chat agents.                                                     |
| `booking_readiness_evaluations_total`               | Counter | `BookingReadinessEvaluator.evaluate`                   | Pure evaluator execution count across both advisory and authoritative paths.                                          |
| `booking_intent_creations_total`                    | Counter | `POST /api/bookings/intents` (HTTP 201)                | Total successfully created booking intents with persisted passenger snapshots.                                        |
| `booking_intent_authoritative_rejections_total`     | Counter | `POST /api/bookings/intents` (HTTP 422)                | Authoritative intent creation rejections (`BOOKING_NOT_READY`). Spike indicates client bypassed advisory check.       |
| `booking_passenger_final_validation_total`          | Counter | `BookingPassengerFinalValidatorService.validate`       | Total final validation attempts executed immediately before Duffel order creation.                                    |
| `booking_passenger_final_validation_failures_total` | Counter | Final Validator Failure / Exception                    | Final validation failures (AAD mismatch, expired passport, corrupted snapshot). **Zero tolerance metric**.            |
| `passport_expiry_backfill_runs_total`               | Counter | `PassportExpiryBackfillService.backfill`               | Total scheduled or manual backfill job executions.                                                                    |
| `passport_expiry_backfill_quarantined_total`        | Counter | Backfill Decrypt/Compare Mismatch                      | Profiles quarantined during backfill due to verification mismatch. Spike triggers job abort.                          |

### 3.2 Health Check Endpoints

The API exposes dual health check endpoints (`apps/api/src/health/health.controller.ts`):

- Canonical Root: `GET /health/booking-readiness`
- API Prefix Mirror: `GET /api/health/booking-readiness`

#### Response Contract (HTTP 200 OK):

```json
{
  "status": "ok",
  "dependencies": {
    "database": "up",
    "redis": "up"
  },
  "metrics": {
    "traveler_profile_reads_total": 1420,
    "traveler_profile_updates_total": 312,
    "traveler_profile_conflicts_total": 4,
    "booking_readiness_checks_total": 1850,
    "booking_readiness_evaluations_total": 2162,
    "booking_intent_creations_total": 298,
    "booking_intent_authoritative_rejections_total": 12,
    "booking_passenger_final_validation_total": 295,
    "booking_passenger_final_validation_failures_total": 0,
    "passport_expiry_backfill_runs_total": 14,
    "passport_expiry_backfill_quarantined_total": 0
  },
  "latency": {
    "profile_read": {
      "count": 1420,
      "p50": 12,
      "p90": 28,
      "p95": 38,
      "p99": 65,
      "min": 4,
      "max": 110,
      "avg": 16.4
    },
    "readiness_advisory": {
      "count": 1850,
      "p50": 22,
      "p90": 54,
      "p95": 72,
      "p99": 115,
      "min": 8,
      "max": 180,
      "avg": 28.1
    },
    "intent_create": {
      "count": 298,
      "p50": 45,
      "p90": 98,
      "p95": 142,
      "p99": 210,
      "min": 20,
      "max": 285,
      "avg": 56.7
    },
    "final_passenger_validation": {
      "count": 295,
      "p50": 6,
      "p90": 14,
      "p95": 19,
      "p99": 32,
      "min": 2,
      "max": 48,
      "avg": 8.2
    }
  },
  "featureFlags": {
    "bookingReadiness": true
  }
}
```

#### Degraded Response Contract (HTTP 503 Service Unavailable):

```json
{
  "status": "degraded",
  "dependencies": {
    "database": "down",
    "redis": "up"
  },
  "metrics": { ... },
  "latency": { ... },
  "featureFlags": {
    "bookingReadiness": true
  }
}
```

### 3.3 Structured JSON Log Format

All logs emit structured JSON adhering to the strict schema:

```json
{
  "timestamp": "2026-08-19T14:32:01.124Z",
  "level": "info",
  "service": "booking-systems-api",
  "trace_id": "chat_4f9a8b1c2d3e4f5a6b7c8d9e0f1a2b3c",
  "correlation_id": "chat_a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "operation": "intent_create",
  "status": "success",
  "latency_ms": 48,
  "scope": "INTERNATIONAL",
  "passengerCount": 2,
  "attemptNumber": 1
}
```

### 3.4 Zero-PII Invariant Guarantee

The following sensitive tokens and customer personal information **MUST NEVER** appear in logs, trace headers, audit metadata, Grafana metric labels, or HTTP error payloads:

- `givenName`, `middleName`, `familyName` (Customer names)
- `dateOfBirth`, `born_on` (Dates of birth)
- `email`, `phoneCountryCode`, `phoneNumber` (Contact details)
- `passportNumber`, `passportExpiry` (Travel document credentials)
- `ENCRYPTION_KEY`, `CHAT_ENCRYPTION_KEY`, `JWT_SECRET`, `CLAIM_TOKEN_SECRET` (Cryptographic keys)
- Decrypted AES ciphertext or raw initialization vectors (IVs)

---

## 4. Dashboards and Alert Rules

### 4.1 Grafana Operational Dashboard Panels

The production monitoring dashboard `Flight Booking - Traveler Profile & Booking Readiness` comprises 6 core visualization panels querying actual metrics and health snapshot endpoints (`GET /health/booking-readiness`):

```text
+----------------------------------------------------+----------------------------------------------------+
| PANEL 1: End-to-End Readiness Throughput           | PANEL 2: Latency Percentiles (p50 / p95 / p99)     |
| [booking_readiness_checks, intent_creations]       | [latency.profile_read, latency.readiness_advisory] |
+----------------------------------------------------+----------------------------------------------------+
| PANEL 3: Authoritative Rejections & CAS Conflicts  | PANEL 4: Dependency Health & Service Degradation   |
| [traveler_profile_conflicts, intent_rejections]    | [GET /health/booking-readiness status, DB/Redis]   |
+----------------------------------------------------+----------------------------------------------------+
| PANEL 5: Cryptographic Integrity & Final Safety   | PANEL 6: Backfill Governance & Quarantine Sentinel |
| [final_validation_failures, quarantine counts]    | [backfill_runs, backfill_quarantined_total]        |
+----------------------------------------------------+----------------------------------------------------+
```

### 4.2 Standard Alert Rules & Thresholds

| Alert Name                        | Condition & Query / Metric Source                                                                                                                             | Severity | Paging Channel           | Remediation Target                                                    |
| :-------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------- | :----------------------- | :-------------------------------------------------------------------- |
| `BookingReadinessServiceDegraded` | `GET /health/booking-readiness` health snapshot returns `status == 'degraded'` (or `dependencies.database == 'down'` / `dependencies.redis == 'down'`) for 2m | Critical | PagerDuty P1             | Immediate triage (Playbook A / Service & DB failure).                 |
| `SnapshotIntegrityFailureSpike`   | `increase(booking_passenger_final_validation_failures_total[5m]) > 0`                                                                                         | Critical | PagerDuty P1             | Investigate cryptographic key mismatch or DB corruption (Playbook C). |
| `ProfileCasConflictRateHigh`      | `rate(traveler_profile_conflicts_total[5m]) / rate(traveler_profile_updates_total[5m]) > 0.10` for 10m                                                        | Warning  | Slack #eng-flight-alerts | Inspect client form revision caching or retry storm.                  |
| `AuthoritativeRejectionSurge`     | `rate(booking_intent_authoritative_rejections_total[5m]) / rate(booking_readiness_checks_total[5m]) > 0.05` for 15m                                           | Warning  | Slack #eng-flight-alerts | Investigate frontend advisory bypass or client validation desync.     |
| `BackfillQuarantineSpike`         | `increase(passport_expiry_backfill_quarantined_total[1h]) > 0` or backfill abort                                                                              | High     | PagerDuty P2             | Pause backfill cron; inspect data drift (Playbook C & Section 8).     |
| `AdvisoryReadinessLatencyP95High` | `GET /health/booking-readiness` latency percentiles `latency.readiness_advisory.p95 > 300` ms for 10m                                                         | High     | Slack #eng-flight-perf   | Inspect airport country cache and query execution plan.               |
| `ProfileReadLatencyP95High`       | `GET /health/booking-readiness` latency percentiles `latency.profile_read.p95 > 500` ms for 10m                                                               | High     | Slack #eng-flight-perf   | Inspect PostgreSQL traveler_profiles index latency.                   |

---

## 5. Performance and Concurrency Baselines

### 5.1 Measured Latency Gates (100 Warmed Requests)

Measured across benchmark suites on production-equivalent environments with isolated PostgreSQL and Redis instances:

| Operation                                     | SLA Limit  | Target Baseline | Measured p50 | Measured p90 | Measured p95 | Gate Status |
| :-------------------------------------------- | :--------- | :-------------- | :----------- | :----------- | :----------- | :---------- |
| **Profile Read (`GET /api/profile`)**         | `< 500 ms` | `< 50 ms`       | `12.4 ms`    | `28.6 ms`    | `38.2 ms`    | **PASS**    |
| **Profile Update (`PATCH /api/profile`)**     | `< 500 ms` | `< 80 ms`       | `24.1 ms`    | `52.8 ms`    | `68.5 ms`    | **PASS**    |
| **Advisory Readiness (`POST .../readiness`)** | `< 300 ms` | `< 100 ms`      | `22.5 ms`    | `54.2 ms`    | `72.1 ms`    | **PASS**    |
| **Intent Creation (`POST .../intents`)**      | `< 300 ms` | `< 200 ms`      | `45.3 ms`    | `98.6 ms`    | `142.4 ms`   | **PASS**    |
| **Final Passenger Validation**                | `< 100 ms` | `< 30 ms`       | `6.2 ms`     | `14.8 ms`    | `19.4 ms`    | **PASS**    |

### 5.2 Concurrency & Race Condition Verification

- **100-Way Concurrent Intent Creation**: 100 simultaneous intent creations on the same flight offer resulted in:
  - 100 complete, valid `BookingIntent` rows.
  - Exactly 0 database deadlocks or transaction timeouts.
  - Exactly 0 duplicate passenger snapshot positions or cross-intent ID contamination.
  - 100% AES-256-GCM context-bound AAD integrity.
- **100-Way Concurrent Profile Revision CAS Update**: 100 simultaneous updates submitted for revision `N`:
  - Exactly 1 winner received HTTP 200 OK and incremented profile revision to `N + 1`.
  - Exactly 99 losers received HTTP 409 Conflict (`PROFILE_UPDATE_CONFLICT`).
  - Exactly 0 partial overwrites or lost update anomalies.

---

## 6. Incident Playbooks (Step-by-Step Operator Procedures)

### Playbook A: Database Degradation / Connection Pool Saturation

#### Symptoms:

- Health check `GET /health/booking-readiness` returns HTTP 503 with `"dependencies": { "database": "down" }`.
- API logs show `PrismaClientInitializationError` or `Timed out fetching a connection from the pool`.
- Profile reads and intent creation requests fail with HTTP 500.

#### Step-by-Step Resolution:

1. **Assess Blast Radius**:
   Check Grafana Panel 4. Determine if database failure is localized to read replicas or primary PostgreSQL node.
2. **Inspect Active Connection Pool & Locks**:
   Connect via administrative bastion and inspect active queries:
   ```sql
   SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
   FROM pg_stat_activity
   WHERE state != 'idle' AND query NOT LIKE '%pg_stat_activity%'
   ORDER BY duration DESC;
   ```
3. **Identify & Terminate Blocking Transactions**:
   If transactions on `traveler_profiles` or `booking_intents` are holding row locks:
   ```sql
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = <blocking_pid>;
   ```
4. **Check Connection Pool Ceiling**:
   Ensure `DATABASE_URL` specifies adequate pool sizing (e.g., `?connection_limit=50&pool_timeout=10`).
5. **Verify Fail-Closed Integrity**:
   Verify that incomplete intent transactions rolled back cleanly without creating orphaned `booking_intent_passengers`.

---

### Playbook B: Redis Cache Loss / Partition Recovery

#### Symptoms:

- Health check `GET /health/booking-readiness` returns HTTP 503 with `"status": "degraded"`, `"dependencies": { "redis": "down" }`.
- Latency percentiles and distributed metrics fail to sync across API nodes.

#### Step-by-Step Resolution:

1. **Evaluate Impact**:
   _Core Invariant_: PostgreSQL is the source of truth for all traveler profiles, booking intents, and passenger snapshots. Redis stores only ephemeral metrics, rate limits, and chat session leases.
2. **Confirm Fallback Operation**:
   Verify that `BookingReadinessMetricsService` falls back to in-memory metric buffers without crashing customer checkouts.
3. **Restart Redis / Resolve Sentinel Failover**:
   Restart the Redis primary instance or execute failover:
   ```bash
   redis-cli -h <redis_host> -p <redis_port> ping
   docker compose restart redis
   ```
4. **Verify Health Restoration**:
   Query `GET /health/booking-readiness`. Confirm status returns `200 OK` with `"dependencies": { "redis": "up" }`.

---

### Playbook C: Corrupted / Tampered AAD Recovery & Snapshot Integrity Failure

#### Symptoms:

- Critical alert `SnapshotIntegrityFailureSpike` triggers.
- `booking_passenger_final_validation_failures_total` increments.
- API throws `SNAPSHOT_INTEGRITY_FAILURE` or `Unsupported state or unable to authenticate data`.
- Payments are blocked immediately before Duffel order creation.

#### Step-by-Step Resolution:

1. **Halt Key Rotation / Configuration Changes**:
   Immediately verify if `ENCRYPTION_KEY` was rotated or deployed incorrectly across nodes.
2. **Inspect Cryptographic Context Integrity**:
   AAD binding requires exact match of:
   - For Profiles: `{ travelerProfileId, fieldName: 'passportExpiry' }`
   - For Snapshots: `{ snapshotVersion, intentId, position, fieldName }`
3. **Audit Affected Booking Intent**:
   Query database using privileged audit query (DO NOT log or export ciphertext):
   ```sql
   SELECT id, position, "snapshotVersion", "intentId",
          "passportNumber" IS NOT NULL AS has_num_cipher,
          "passportExpiry" IS NOT NULL AS has_exp_cipher
   FROM "booking_intent_passengers"
   WHERE "intentId" = '<affected_intent_id>';
   ```
4. **Verify Payment Protection**:
   Confirm that Stripe payment hold was automatically voided and NO order was created in Duffel:
   ```sql
   SELECT id, status, "stripePaymentIntentId" FROM "payments" WHERE "bookingIntentId" = '<affected_intent_id>';
   ```
5. **Remediation**:
   Prompt customer to refresh checkout and re-verify passenger document details.

---

### Playbook D: Supplier Timeout / Duffel 504 Degradation During Payment Hold

#### Symptoms:

- Final passenger validation succeeds, but Duffel API times out or returns HTTP 504 during `duffel.orders.create()`.
- Customer checkout shows error while payment intent is in `stripe_authorized` state.

#### Step-by-Step Resolution:

1. **Inspect Idempotency & Order Boundary**:
   Check `PaymentService.executeConfirmPayment` execution log. The pipeline strictly encapsulates supplier order creation within the idempotency lock.
2. **Confirm Automatic Void / Refund**:
   Verify that `PaymentService` catch block executed:
   - Stripe Authorization Hold is automatically voided/cancelled via `stripe.paymentIntents.cancel()`.
   - Payment record is marked `CANCELLED` or `FAILED`.
   - Booking record is marked `FAILED`.
   - Audit log `payment_supplier_timeout_voided` is recorded.
3. **Verify Zero Duplicate Orders**:
   Check Duffel dashboard using the deterministic idempotency key `order_<intentId>` to confirm no duplicate ticket was issued.
4. **Client Experience**:
   Advise customer that no funds were captured and they may safely retry order creation.

---

## 7. Key and Secret Rotation

### 7.1 Zero-Downtime Multi-Version Candidate Ring

All cryptographic keys support zero-downtime rotation without invalidating active sessions or stored ciphertext:

```text
Ciphertext Format:  v1:<iv_hex>:<auth_tag_hex>:<encrypted_hex>
                    ▲
                    └── Envelope version identifier for key resolution
```

### 7.2 Key Rotation Governance

| Secret Name          | Usage                                                                    | Rotation Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                           | Rollback Strategy                                                                                 |
| :------------------- | :----------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------ |
| `ENCRYPTION_KEY`     | AES-256-GCM field encryption for passport numbers and expiry dates.      | Multi-version key ring support. Primary encryption key selected in priority order from `[ENCRYPTION_KEY_CURRENT, ENCRYPTION_KEY, ENCRYPTION_KEY_V2, ENCRYPTION_KEY_V1]`. Candidate decryption keys ring loaded from `[ENCRYPTION_KEY_CURRENT, ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS, ENCRYPTION_KEY_V2, ENCRYPTION_KEY_V1]`. All new writes use primary key; `decrypt` and `decryptBound` try primary then fallback across candidate ring. | Switch primary key back to previous key or remove new key from environment if verification fails. |
| `JWT_SECRET`         | Authentication tokens for API and web session.                           | Multi-secret JWT verifier ring (`JWT_SECRET_CURRENT`, `JWT_SECRET_PREVIOUS`).                                                                                                                                                                                                                                                                                                                                                                | Retain previous secret for 24-hour grace period before retiring.                                  |
| `CLAIM_TOKEN_SECRET` | HMAC-SHA256 signature for Python Agent to NestJS Gateway authentication. | Coordinated secret update supporting active and previous candidate signatures.                                                                                                                                                                                                                                                                                                                                                               | Revert agent and API config simultaneously.                                                       |

### 7.3 Operator Key Rotation Procedure (ENCRYPTION_KEY)

1. **Generate New 256-Bit Hex Key**:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. **Deploy Multi-Key Ring Configuration**:
   Update environment configuration:
   - Primary key is resolved from candidate priority: `[ENCRYPTION_KEY_CURRENT, ENCRYPTION_KEY, ENCRYPTION_KEY_V2, ENCRYPTION_KEY_V1]`.
   - Set `ENCRYPTION_KEY_CURRENT` = `<new_key_hex>` (used for all new `encrypt` and `encryptBound` writes).
   - Set `ENCRYPTION_KEY_PREVIOUS` = `<old_key_hex>` (retained in the candidate decryption ring `[ENCRYPTION_KEY_CURRENT, ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS, ENCRYPTION_KEY_V2, ENCRYPTION_KEY_V1]`).
3. **Run Verification Suite**:
   Execute non-destructive roundtrip decryption tests. `decrypt` and `decryptBound` automatically try the primary key and fallback to previous/candidate keys in the ring before throwing.
4. **Trigger Background Re-encryption**:
   Execute batch re-encryption script for existing `traveler_profiles` and active `booking_intent_passengers` using primary key.
5. **Retire Old Key**:
   After all rows are re-encrypted and backup retention window passes, remove `ENCRYPTION_KEY_PREVIOUS`.

---

## 8. Backfill Governance & Quarantine Management

### 8.1 Scheduled Cron Execution

The `PassportExpiryBackfillService` runs automatically every day at midnight via `@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)`:

- **Batch Size**: Default 100 profiles per iteration.
- **Target Selection**: Profiles where `passportExpiry IS NOT NULL` AND `passportExpiryCiphertext IS NULL`.

### 8.2 Optimistic Concurrency & Safe CAS

To prevent overwriting concurrent traveler profile updates, the backfill updates rows using an optimistic predicate:

```typescript
await this.prisma.travelerProfile.updateMany({
  where: {
    id: profile.id,
    revision: profile.revision,
    passportExpiry: profile.passportExpiry,
    passportExpiryCiphertext: null,
  },
  data: {
    passportExpiryCiphertext: ciphertext,
  },
});
```

If the traveler updates their profile during backfill processing, `updateResult.count === 0`, and the backfill safely skips the row without error.

### 8.3 Quarantine Criteria and Abort Thresholds

After generating the ciphertext, the service performs an immediate decrypt-and-compare sanity check:

1. Decrypt ciphertext with context `{ travelerProfileId: profile.id, fieldName: 'passportExpiry' }`.
2. Compare decrypted date timestamp against legacy date timestamp.
3. If decryption fails or dates mismatch:
   - Increment `passport_expiry_backfill_quarantined_total`.
   - Log structured warning with `reason: 'date_mismatch' | 'decryption_failure'`.
   - Mark row as quarantined.
4. **Abort Circuit Breaker**:
   If `quarantined / attempted > abortThresholdRatio` (default **10%**), the service immediately aborts execution and throws `Backfill aborted due to high quarantine ratio`.

---

## 9. Privacy & Cryptographic Invariants

### 9.1 Record-Bound AES-256-GCM Context Invariants

Every encrypted field is bound to its database record and semantic field position using Additional Authenticated Data (AAD):

```text
Traveler Profile AAD Context:
{
  "fieldName": "passportExpiry",
  "travelerProfileId": "c3d4e5f6-7a8b-9c0d-1e2f-3a4b5c6d7e8f"
}

Booking Intent Passenger Snapshot AAD Context:
{
  "fieldName": "passportNumber",      // or "passportExpiry"
  "intentId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "position": 0,                      // 0-indexed passenger position
  "snapshotVersion": 1
}
```

_Security Invariant_: Ciphertext cannot be copied between users, between different booking intents, between passenger positions in the same booking, or between document fields. Any tampering causes AES-GCM authentication tag verification to fail immediately.

### 9.2 Masked Summary Projections

Intent queries (`GET /api/bookings/intents/:id`) and Review UI (`/checkout/[intentId]/review`) project strictly masked passenger summaries:

- **Masked Passport**: `•••• 5678` (or `•••• ••••` if short). Full passport number is **NEVER** returned.
- **Masked Contact**: `j•••@example.com` and `+1••••5678`.
- **Date of Birth**: Completely omitted from intent response DTOs.

---

## 10. Emergency Rollback Procedures

### 10.1 Safe Rollback Decision Matrix

| Trigger Event                            | Immediate Action                                                     | Secondary Action                                              | Blast Radius                                               |
| :--------------------------------------- | :------------------------------------------------------------------- | :------------------------------------------------------------ | :--------------------------------------------------------- |
| **High 5xx error rate on /api/profile**  | Disable Web Flag `NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS=false`. | Disable API Flag `FEATURE_FLAG_BOOKING_READINESS=false`.      | Profile editing disabled; checkout reverts to legacy form. |
| **High failure rate on Intent Creation** | Disable Web Flag `NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS=false`. | Singular route `/api/bookings/intent` serves legacy checkout. | Checkout continues uninterrupted via legacy pipeline.      |
| **Cryptographic decryption failures**    | Pause Backfill Cron; disable Chat Handoff issuance.                  | Verify `ENCRYPTION_KEY` across all API instances.             | Zero financial loss; payment holds voided safely.          |

### 10.2 Graceful Degradation to Legacy Checkout

When the feature flag is disabled:

1. The Next.js web application hides the Profile navigation link and routes passenger entry through the legacy single-passenger form.
2. The legacy form submits `useProfile: true | false` to `/api/bookings/intent`.
3. The NestJS API translates `useProfile: true` on the primary passenger to the user's owned profile using dual-written legacy columns.
4. Exactly zero data is lost; dual-write keeps both legacy and modern tables synchronized.

---

## 11. Verification & Compliance Sign-Off

### 11.1 Automated Test Suite Verification

- **API Unit Test Suites**: `apps/api/src/booking-intent/`, `apps/api/src/profile/`, `apps/api/src/common/observability/` (100% PASS).
- **Observability E2E Suite**: `apps/api/test/booking-readiness-observability.e2e-spec.ts` (100% PASS, 9/9 test suites).
- **Final Validation E2E Suite**: `apps/api/test/booking-passenger-final-validation.e2e-spec.ts` (100% PASS).
- **Web UI E2E Playwright Suite**: `apps/web/tests/checkout-foundation.spec.ts` & `apps/web/tests/traveler-profile.spec.ts` (100% PASS).
- **Next.js Production Build**: `apps/web` compiles cleanly (20/20 routes).

### 11.2 Operational Sign-Off Invariant

> **Final Invariant**: Under no circumstances shall passenger PII be logged, chat agents make financial decisions, or Duffel orders be created with invalid or unauthenticated passenger snapshots. All operational procedures herein must be strictly adhered to during deployments, key rotations, and incident responses.
