# Implementation Plan: Traveler Profile & Booking Readiness

**Branch**: `016a-traveler-profile-booking-readiness` | **Date**: 2026-08-01 | **Spec**: [spec.md](spec.md)

**Input**: Accepted ADR decisions plus the validated feature specification.

## Summary

Add an owned traveler-profile domain, one pure booking-readiness evaluator, explicit per-passenger sources, and complete immutable passenger snapshots. Deliver the work as five vertical stories: secure profile, advisory readiness, authoritative intent creation, PII-safe chat handoff, and final order validation. Reuse the existing NestJS, Next.js, FastAPI agent, Prisma, airport, encryption, audit, checkout, and Duffel boundaries; add no dependency.

## Technical Context

**Language/Version**: TypeScript 5.4 on Node.js 20+; Python 3.11+ for the agent service

**Primary Dependencies**: NestJS 10, Prisma 5.14, Next.js 14.2 App Router, React 18, class-validator, Zod, FastAPI, LangChain/LangGraph, existing Duffel client

**Storage**: PostgreSQL through Prisma; existing AES-256-GCM `EncryptionService`, extended with record/field AAD for new ciphertext; existing platform/database encryption at rest for all PII

**Testing**: Jest unit/integration, NestJS/Supertest E2E, Playwright UI E2E, pytest agent tests

**Target Platform**: Existing Linux-hosted web/API/agent services and modern browsers

**Project Type**: pnpm monorepo with NestJS API, Next.js web app, Python agent service, and shared TypeScript contracts

**Performance Goals**: Advisory readiness p95 under 300 ms when the offer and airport data are local; profile read/write p95 under 500 ms; no added supplier call for repeated readiness

**Constraints**: No PII in chat/SSE/logs/audit metadata; no LLM authority over readiness or booking state; no supplier call inside a database transaction; all first-party clients migrate without breaking existing checkout; no hard 180-day passport rule

**Scale/Scope**: One owned profile per authenticated user; up to nine passengers per existing intent rules; five user-story slices across API, web, shared types, and agent service

## Constitution Check

_GATE: Passed before research and re-checked after design._

| Principle                          | Design response                                                                                                                                                            | Result |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Flight-First Architecture          | Only flight passenger readiness and intent creation are changed; hotels, dining, companion profiles, and travel-rules providers remain out of scope.                       | PASS   |
| Deterministic Transaction Boundary | The pure evaluator and NestJS services are authoritative. Chat can request a check or initiate a confirmed command, but cannot provide PII or decide validity/order state. | PASS   |
| API Budget Discipline              | Readiness uses stored offer segments and airport countries. Live offer retrieval remains the existing intent/order responsibility and occurs once per existing flow.       | PASS   |
| Observability                      | New endpoints propagate trace/correlation IDs and emit status/count/reason metrics only; logs and audits exclude field values.                                             | PASS   |
| Incremental Delivery               | Each user story has an independent test and deployable outcome; the compatibility route keeps checkout operable between slices.                                            | PASS   |
| Security Requirements              | JWT/profile ownership, gateway claim guards, field-level passport encryption, TLS/database encryption, safe response DTOs, and PII boundary tests are mandatory.           | PASS   |

### Post-design re-check

The data model, contracts, and validation guide preserve every gate. The only transitional complexity is the additive passport-expiry ciphertext shadow and route alias; both prevent destructive migration or first-party client breakage and have explicit removal criteria.

## Design Decisions

### 1. Pure evaluator, orchestration outside

`BookingReadinessEvaluator` accepts normalized passenger data, offer segments, airport-country mappings, trip completion, supported document types, and the advisory-buffer setting. It performs no I/O. `BookingIntentService` loads owned sources and offer/airport data, invokes it for advisory and authoritative checks, and creates snapshots only after all passengers pass blocking rules.

### 2. Canonical plural contract with compatibility window

Add canonical `POST /api/bookings/intents/readiness` and `POST /api/bookings/intents`. Keep the existing singular intent endpoints as deprecated aliases while first-party web, tests, ancillary, and payment callers migrate. Remove aliases only after repository-wide callers and telemetry show no use; alias removal is not part of this feature.

### 3. Additive passport-expiry protection

The live profile schema stores `passportExpiry` as `DateTime?`, which cannot contain AES ciphertext. Preserve that column and logical API name. Add an internal nullable ciphertext shadow and dual-read/dual-write throughout the rollback window. Backfill only shadow-null rows with an optimistic `id + revision + legacy value` predicate, then authenticate/decrypt and compare every normalized date. Quarantine failures and abort the batch above the documented threshold. Legacy values remain until rollback support ends; dropping or clearing them is a later feature.

### 4. Revision-bound source and immutable snapshot

Add `TravelerProfile.revision`. Advisory readiness returns the non-PII revision used for each profile source, and authoritative intent creation requires it as `expectedProfileRevision`; a mismatch returns `409 PROFILE_CHANGED`. Extend `BookingIntentPassenger` for middle name, title, contact, document type, issuing country, and `snapshotVersion`. The source union is request-only; the snapshot retains `travelerProfileId` for provenance. New passport ciphertext uses AAD `{snapshotVersion,intentId,position,fieldName}` so cross-intent or cross-passenger substitution fails. Intent read/review DTOs expose masked document summaries, never decrypted values.

### 5. Chat is metadata-only

The agent gateway maps internal readiness to passenger type/ordinal, section/field names, statuses, safe reason codes, and navigation action. Python tools and SSE schemas reject value-bearing properties. Inline/multi-passenger chat requests hand off to checkout; a ready single-profile request may call a deterministic, confirmation-gated intent command.

### 6. Unknown-scope mapping

The pure evaluator always returns `scope: UNKNOWN`, `ready: false`, and blocking reason `AIRPORT_COUNTRY_UNAVAILABLE` when any required country is absent. Advisory HTTP maps that result to `200` so the user receives the normal readiness shape. Authoritative intent creation maps the identical result to `422 BOOKING_NOT_READY` with the same body. `503` is reserved for genuine infrastructure failure, not missing reference data.

### 7. Final validation inside the existing single-owner pipeline

Reuse the current payment/order idempotency claim and frozen intent/ancillary version; do not invent a second submission state machine. Only the claim owner re-reads the frozen passenger rows, verifies AAD/authentication, decrypts inside the trusted routine, validates completeness and expiry at the current clock instant, creates an ephemeral supplier DTO, and calls Duffel with the existing stable booking/payment idempotency key. Lease loss, expiry, authentication failure, and unknown supplier outcome follow the existing replay/recovery path and never permit a second unowned call.

## Bite-Sized Delivery Phases

| Phase                                             | Scope and owned files                                                                                           | Entry → exit criteria                                                                                                   | Focused verification                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1. Shared contracts + observability               | `packages/shared/src/types/*`, `apps/api/src/app.module.ts`, feature metric/trace helpers, environment examples | Existing builds green → shared schemas, flags, metric names, trace propagation, dashboard/alert contract compile        | shared build; observability contract tests                                 |
| 2. Additive schema + dual-write migration         | `apps/api/prisma/schema.prisma`, new migration/backfill command and tests                                       | Phase 1 → nullable fields/revision/shadow/snapshot fields applied; rollback-safe dual-write and bounded backfill proven | migration test; decrypt/compare/quarantine tests                           |
| 3. Profile API (US1)                              | new `apps/api/src/profile/*`, `apps/api/src/app.module.ts`                                                      | Phase 2 → owned GET/PATCH, revision CAS, atomic document section, no-store/redaction/audit behavior                     | profile unit/controller/API E2E                                            |
| 4. Secure profile UI (US1)                        | `apps/web/app/profile/page.tsx`, `components/profile/*`, web API helper/tests                                   | Phase 3 → traveler can review/correct all fields; no PII in URL/storage/cache                                           | Playwright profile flow and privacy assertions                             |
| 5. Pure evaluator (US2)                           | new evaluator/types/specs under `apps/api/src/booking-intent/`                                                  | Phase 1 → complete domestic/international/unknown/document matrix with zero I/O                                         | evaluator Jest matrix/clock tests                                          |
| 6. Advisory endpoint (US2)                        | booking-intent DTO/controller/service/module, Airports imports                                                  | Phases 3+5 → server-derived scope and revision-bearing readiness response; no writes/supplier call                      | controller/API parity and latency E2E                                      |
| 7. Snapshot/source foundation (US3)               | source DTOs, snapshot persistence, bound encryption helpers                                                     | Phases 2+5 → source union and AAD-bound complete snapshots; cross-owner/cipher-swap rejected                            | source/encryption/transaction unit tests                                   |
| 8. Atomic intent + response/route migration (US3) | intent orchestration, plural controller, `apps/web/lib/checkout.ts`, checkout/review UI/tests                   | Phases 6+7 → expected revision CAS, zero-write rejection, plural client, masked responses; singular aliases remain safe | intent E2E, route-shape matrix, existing checkout regression               |
| 9. Gateway/SSE handoff (US4)                      | Nest gateway DTO/service/controller; Python client/tool/registry/SSE; web handoff surface                       | Phases 6+8 → allowlisted metadata-only readiness and secure profile/checkout navigation                                 | gateway E2E, pytest payload injection, Playwright handoff                  |
| 10. Final order safety (US5)                      | payment/order validation seam, Duffel assembly, focused recovery tests                                          | Phases 7+8 → only existing claim owner validates/decrypts/calls supplier; concurrency and expiry boundaries converge    | concurrent-submit, lease-loss, expiry, AAD swap, supplier-not-called tests |

Phases 3 and 5 may run in parallel after Phase 2/Phase 1 respectively. Phase 4 may run alongside Phase 6 once the profile contract is stable. Agent work in Phase 9 does not touch final-order files. Exact checklist tasks and file-level parallel markers are generated in `tasks.md`.

## Requirement Traceability

| Requirements / outcomes            | Owning phases | Required proof                                                                                                |
| ---------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| FR-001–003, FR-022; SC-001, SC-005 | 2–4           | owner/CAS/document-atomic API tests; secure UI; cache/log/audit privacy assertions                            |
| FR-004–011; SC-002                 | 5–6           | pure matrix plus advisory/authoritative parity and unknown-scope mapping                                      |
| FR-012–017; SC-003–004             | 7–8           | union conflict, ownership, expected revision, zero-write, immutability, cipher binding, masked response tests |
| FR-019–021; SC-005, SC-007         | 9             | gateway/SSE allowlist and chat-to-secure-form E2E                                                             |
| FR-018, FR-022; SC-006             | 10            | claim-owner concurrency, final clock/expiry/integrity checks, no-supplier-call assertions                     |

## Project Structure

### Documentation (this feature)

```text
specs/016-traveler-profile-booking-readiness/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── api.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/api/
├── prisma/schema.prisma
├── prisma/migrations/<timestamp>_traveler_profile_readiness/
├── src/profile/
│   ├── dto/
│   ├── profile.controller.ts
│   ├── profile.service.ts
│   └── profile.module.ts
├── src/booking-intent/
│   ├── dto/
│   ├── booking-readiness.evaluator.ts
│   ├── booking-intent.controller.ts
│   └── booking-intent.service.ts
├── src/agent-gateway/
├── src/health/health.controller.ts
└── test/

apps/web/
├── app/profile/page.tsx
├── app/checkout/passengers/page.tsx
├── components/profile/TravelerProfileForm.tsx
├── components/checkout/PassengerFormClient.tsx
├── lib/checkout.ts
└── tests/

apps/agent/
├── src/agent/tools/check_booking_readiness.py
├── src/agent/tools/nestjs_client.py
├── src/agent/tools/registry.py
├── src/agent/streaming/sse.py
└── tests/

packages/shared/src/
├── types/booking-intent.types.ts
├── types/traveler-profile.types.ts
└── types/index.ts

docs/runbooks/
└── booking-readiness.md
```

**Structure Decision**: Extend existing domain modules and create only the ADR-approved `profile/` module. The evaluator stays inside `booking-intent/`; no standalone readiness service or new package is introduced.

## Compatibility and Rollout

1. Add `FEATURE_FLAG_BOOKING_READINESS` to the API Zod config in `apps/api/src/app.module.ts` and `.env.example`, default `false`; add `NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS` to web env/config, default `false` outside tests. Flags gate only new readiness/profile UI/chat entry points; existing singular checkout stays active.
2. Apply the additive nullable schema, revision, ciphertext-shadow, and snapshot migration. Old code remains readable because legacy fields are retained.
3. Deploy dual-read/dual-write profile code. Backfill shadow-null rows with checkpoints, optimistic predicates, key-versioned envelopes, per-row decrypt/compare verification, quarantine, and abort if any mismatch exceeds the runbook threshold. Retain legacy values for rollback.
4. Introduce plural routes. Route matrix: plural readiness/create/get are canonical; singular create/get/prefill remain aliases; ancillary/payment routes retain their current paths. Before hardening GET, deploy web code that consumes the new masked summary. Then make both GET aliases return identical safe shapes; legacy passport keys may remain `null` for shape compatibility.
5. Enable API readiness for internal/test traffic, then secure web profile/readiness UI, then agent handoff. Disabling either flag hides new entry points and returns `404 FEATURE_DISABLED` from new-only endpoints while legacy checkout continues.
6. Keep aliases and legacy expiry values through the observation window. Their removal is a separately reviewed cleanup feature driven by zero-use telemetry and verified backfill, not part of 016.

## Observability Deliverables

- Emit PII-safe structured events for profile read/update outcome, advisory readiness outcome/scope, authoritative rejection/create, gateway handoff, final validation, and backfill batches. Required fields: timestamp, level, service, trace ID, correlation ID, operation, status/reason, latency, and counts only.
- Propagate trace/correlation headers web → NestJS and agent → gateway → NestJS; include them in audit records and tests, never in response bodies.
- Extend health/metrics exposure with request/error/latency histograms for profile and readiness, unknown-scope count, profile-conflict count, snapshot-integrity failures, backfill processed/quarantined counts, and final-validation blocks.
- Add `docs/runbooks/booking-readiness.md` defining dashboard panels and alerts: p95 above 300/500 ms, error rate above 2× baseline for five minutes, unknown-scope spike, any snapshot-integrity failure, any backfill quarantine, and feature health/rollback steps.
- Add E2E assertions for metric increments, trace propagation, required structured fields, dashboard/alert contract presence, and negative PII corpus matching across logs/audits/traces.

## Verification Strategy

- **Unit**: evaluator scope/field/document matrix; profile encryption/masking; source-union validation; final snapshot validation.
- **Integration**: owned profile GET/PATCH revision CAS; advisory vs authoritative evaluator parity; transaction rollback on invalid/stale passengers; plural/singular path and response-shape compatibility.
- **Boundary/security**: no PII in gateway/SSE/log/audit DTOs; cross-user profile rejection; no decrypted snapshot in intent reads; agent cannot bypass deterministic validation.
- **E2E**: profile completion → readiness → intent → ancillaries; inline/multi-passenger checkout handoff; chat action-required flow; expired/corrupt/swapped snapshot blocked before Duffel; concurrent submit produces one owned supplier attempt.
- **Performance**: dedicated local/test-profile E2E seeds 100 warmed requests, computes p95, and gates readiness below 300 ms and profile operations below 500 ms; no external supplier calls are permitted in the profile.
- **Browser privacy**: assert no PII appears in URLs, route state, local/session storage, cacheable responses, error UI, or SSE payloads.
- **Regression**: existing booking-intent, ancillary, payment, checkout, and agent-gateway suites.

## Complexity Tracking

| Transitional complexity                                  | Why needed                                                                                                       | Simpler alternative rejected because                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Ciphertext shadow + backfill for profile passport expiry | Preserves the production `DateTime` column while moving the value behind AES-GCM without destructive conversion. | In-place type conversion cannot encrypt data and risks loss/rollback failure. |
| Temporary singular/plural route compatibility            | Lets the ADR contract ship without breaking checkout, ancillary, payment, and existing tests.                    | Immediate route replacement creates a coordinated big-bang deployment.        |
