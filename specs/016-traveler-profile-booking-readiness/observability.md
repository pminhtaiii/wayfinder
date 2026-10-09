# Observability Contract: Traveler Profile & Booking Readiness

## Structured events

Every event contains `timestamp`, `level`, `service`, `trace_id`, `correlation_id`, `operation`, `status`, and `latency_ms`. Allowed metadata is limited to scope, safe reason code, passenger count, field-name list, revision conflict flag, and aggregate counts. Values, names, DOB, contact data, document data, profile IDs, and ciphertext are forbidden.

Required operations: profile read/update, readiness advisory, intent authoritative validation/create, gateway readiness, final passenger validation, and expiry backfill batch.

## Metrics

- Request/error/latency histograms for profile, readiness, gateway, and final validation
- Readiness outcomes by `DOMESTIC | INTERNATIONAL | UNKNOWN`
- `PROFILE_UPDATE_CONFLICT` and `PROFILE_CHANGED` counts
- Snapshot authentication/integrity failure count
- Backfill processed/skipped/quarantined counts
- Final validation blocks by safe reason and supplier-call attempts

## Trace propagation

Web and agent callers forward `x-trace-id` and `x-correlation-id`. NestJS passes them through service/audit/metric boundaries and outbound gateway calls. Tests assert continuity and ensure headers never contain PII.

## Dashboard and alerts

The implementation runbook must define panels and alerts for:

- readiness p95 >300 ms or profile p95 >500 ms;
- endpoint error rate >2× baseline for five minutes;
- any snapshot-integrity failure;
- any backfill quarantine or abort;
- unknown-scope rate spike;
- final validation blocks and supplier-call duplication;
- feature-flag state and rollback health.

## Verification

E2E tests assert metric changes, trace continuity, event fields, and negative PII corpus matches. The performance profile uses 100 warmed local requests with supplier calls disabled. Dashboard/alert/runbook artifacts are release-gating deliverables, not follow-up documentation.
