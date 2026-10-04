# Feature 029 Neutral Identifiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete T047–T054 with neutral internal and physical identifiers while preserving current wire contracts and durable history.

**Architecture:** Rename existing domain and Prisma fields together, with explicit mappings at established HTTP/SSE/HMAC boundaries. Normalize legacy booking JSON at reads and write neutral segment JSON. Strict ephemeral agent state uses neutral identities and rejects incompatible old state.

**Tech Stack:** Installed TypeScript, NestJS, Prisma/PostgreSQL, Next.js 14.2.3, Python/Pydantic, Jest, Node tests, pytest; no dependency changes.

**Spec:** `specs/029-duffel-provider-narrowing/spec.md`, `data-model.md`, `contracts/supplier-boundaries.md`, and `GOAL.md`.

## Global Constraints

- Complete T047–T054 only. T055–T057 remain pending; do not merge.
- Zero `any` or type assertions; runtime-narrow unknown inputs. No unused imports/variables.
- Depend on exported ports; Nest dependencies use constructor injection. Maintain non-global private supplier core and an acyclic module graph.
- No second supplier, new endpoint, dependency upgrade, speculative abstraction, changed budget accounting, or weakened security/PII/payment protection.
- Keep pnpm 10.34.5 patch metadata stable; avoid implicit package-manager reconciliation or unrelated lockfile churn.
- Preserve all pinned external keys and attestation bytes.
- Keep historical migration SQL, webhook schema/signatures, `duffel_order_created`, and `DUFFEL_COST` intact. Retain existing recovery-point literal to avoid an unnecessary deployment transition.
- Tests are immutable without explicit human approval. New regression files are preferred; obtain approval for concrete fixture adaptations when required by renamed internal types.
- Every new behavior follows RED → GREEN → REFACTOR. Run focused tests, typecheck, and package lint; capture failures honestly.
- Use only dedicated disposable databases for migration/E2E checks; never reset a shared database.
- Skip graphify updates. Use Windows PowerShell syntax and absolute paths.

## Approved design and checkpoint

User approved the bounded design on 2026-10-03 and supplied writing-plans/subagent-driven-development skills. Baseline is `76145bd1b3f51965047cdd540e55f164f6ff5148`; clean branch `codex/029-duffel-provider-narrowing`. PR #367 is merged, and all required CI checks passed at that exact HEAD. Review this slice against this baseline.

The migration path `20260929000000_supplier_identifiers` is absent and follows latest `20260915000000_booking_projection_versions`. PostgreSQL/Redis containers are running; disposable DB validation requires explicit URLs and creation of new databases.

## Rename and compatibility matrix

| Owner / field | Neutral internal or physical field | Compatibility boundary |
| --- | --- | --- |
| Booking.duffelOrderId | supplierOrderId | Existing booking/cancellation/admin HTTP key stays duffelOrderId |
| Booking.duffelCancellationQuoteId | supplierCancellationQuoteId | Existing HTTP key stays duffelCancellationQuoteId |
| Booking.lastDuffelSyncedAt | lastSupplierSyncedAt | Internal only |
| Booking.nextDuffelSyncAt | nextSupplierSyncAt | Internal only |
| BookingIntent.duffelOfferId | supplierOfferId | Trusted lookup only; client cannot choose either spelling |
| BookingIntentPassenger.duffelPassengerId | supplierPassengerId | Existing ancillary wire key retained by mapping |
| SeatSelection.duffelPassengerId | supplierPassengerId | Existing ancillary wire key retained by mapping |
| BaggageSelection.duffelPassengerId | supplierPassengerId | Existing ancillary wire key retained by mapping |
| FlightOffer.duffelOfferId | supplierOfferId | Search/gateway HTTP key remains duffelOfferId |
| ItineraryRevisionSegment.duffelSegmentId | supplierSegmentId | Public segment wire key stays legacy where already exposed |
| ChatHandoff.duffelOfferIdHash | supplierOfferIdHash | Same hash input/computation; not a new wire field |
| FlightSegmentSnapshot.duffelSegmentId | supplierSegmentId | Read legacy persisted JSON; new JSON neutral; legacy HTTP projection |
| Python trusted result.duffelOfferId | supplierOfferId | Explicit gateway/SSE projection; stale Redis rejects |
| Signed SelectionAttestationOffer.duffelOfferId | Legacy signed type retained | Exact key order, bytes, signature; map outside signed object |
| Webhook order ID/status/table | Unchanged Duffel names | Concrete integration exception |
| Payment event/recovery/ledger literals | Unchanged historic literals | Preserve audit meaning and compensation retry behavior |

## Ownership and execution order

Execute the coordinated checkpoint as T049 → T050 → T047/T052 → T051 → T053 → T048 → T054. T052 schema/SQL/Node-contract work can run alongside T047 because it does not generate the client or migrate a database. Interleave only T051's first neutral-writer vertical before T047's focused GREEN/commit; T051 legacy-reader edits follow that commit. One fresh implementer owns each task (the T047 implementer resumes for T048, at most two tasks), with task review after each and a separate commit. The order was refined during read-only preflight because current shared snapshot and ancillary shapes also serve as public wire DTOs. Finish wire projections after neutral schema consumers exist. No simultaneous edits to the same file. Serialize Git index mutations even when independent file work runs in parallel. API/shared domain renames and Prisma schema/client consumers form one coordinated checkpoint: intermediate compiler failures caused only by pending matrix changes are recorded and cannot be called passing. Task checkboxes remain open until their required checks pass. No partial checkpoint is pushed.

Root owns task checkboxes, context synchronization, verification record, and final PR/CI. Implementers own task production/new regression files and report all test adaptation needs before touching existing tests.

## Exact validation runners

Use installed binaries, not global pnpm. Root commands:

```powershell
& '.\packages\shared\node_modules\.bin\tsc.CMD' -p packages/shared/tsconfig.json
node --test packages/shared/dist/types/flight-search.types.spec.js packages/shared/dist/types/booking-management.types.spec.js packages/shared/dist/types/dashboard.types.spec.js packages/shared/dist/types/traveler-profile.types.spec.js
& '.\apps\api\node_modules\.bin\tsc.CMD' -p apps/api/tsconfig.json --noEmit
& '.\node_modules\.bin\eslint.CMD' 'apps/api/**/*.ts' 'packages/shared/**/*.ts' --max-warnings 0
& '.\apps\web\node_modules\.bin\tsc.CMD' -p apps/web/tsconfig.json --noEmit
& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/flight-search.spec.ts apps/web/lib/server/booking-management.spec.ts apps/web/tests/handoff-checkout-proxy.unit.ts
node --test tests/ci/ci-workflow.contract.test.mjs
$env:UV_CACHE_DIR = 'C:\Booking Systems\.uv-cache'
$env:PYTHONPATH = 'C:\Booking Systems\tests\ci\python;C:\Booking Systems\apps\agent\src'
uv run --no-sync --package agent pytest apps/agent/tests -m 'not redis_integration' -p no:cacheprovider
uv run --no-sync --package agent ruff check apps/agent
uv run --no-sync --package agent ruff format --check apps/agent
```

API Jest runs from `C:\Booking Systems\apps\api`:

```powershell
$env:DUFFEL_ACCESS_TOKEN = 'duffel_test_ci_not_a_secret'
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
node node_modules/jest/bin/jest.js --config jest.config.json --runInBand
node node_modules/jest/bin/jest.js --config test/jest-e2e.json --runInBand
```

Web build/lint run from `C:\Booking Systems\apps\web`, with synthetic local NextAuth environment as in `context/testing.md`:

```powershell
node node_modules/next/dist/bin/next lint
node node_modules/next/dist/bin/next build
```

### Task 1: T049 — Web checkout boundaries

**Files:** Modify `apps/web/lib/server/flight-search.ts`, `booking-management.ts`, `apps/web/lib/handoffCheckoutPayload.ts`, `apps/web/lib/checkout.ts`; create `apps/web/tests/supplier-identity-injection.unit.ts`.

**Interfaces:** Consume existing legacy HTTP schemas; produce unchanged public views and `isSafeHandoffCheckoutPayload(value: unknown, pathname: '/api/bookings/intents/readiness' | '/api/bookings/intents'): value is Record<string, unknown>` denying both provider identity spellings at every depth.

- [ ] Add a public-helper regression with `{ passengers: [{ supplierOfferId: 'injected' }] }`, and array/object nested cases; assert `false` for both endpoints and canonical controls `true`.
```typescript
assert.equal(isSafeHandoffCheckoutPayload({ passengers: [{ supplierOfferId: 'injected' }] }, '/api/bookings/intents'), false);
```
- [ ] Run installed TSX runner on the new file; confirm assertion fails before implementation.
- [ ] Add `'supplierOfferId'` to the recursive forbidden-key set; inspect checkout parsing to retain trusted server identity and public wire aliases.
- [ ] Run new and all three baseline web targets, web typecheck/lint; inspect absent installed Next docs accurately (both root/web guide paths are absent).
- [ ] Commit only T049 files with `refactor(web): enforce neutral supplier identity boundary` and write report.

### Task 2: T050 — Agent canonical state

**Files:** Modify `apps/agent/src/agent/trusted_search_snapshot/models.py`, `tools/search_flights.py`, `graph/nodes.py`, `guardrails/schemas/tools.py`, and necessary lifecycle/consumer files; create `apps/agent/tests/test_supplier_snapshot_compatibility.py`.

**Interfaces:** Trusted canonical result requires `supplierOfferId: str`; gateway/SSE keeps `duffelOfferId`; strict Redis deserialization accepts only canonical neutral state. Existing `TrustedSearchSnapshotRepository` and public search tool remain the seam.

- [ ] Add one repository regression storing legacy Redis result identity and asserting full snapshot rejection; run focused pytest to confirm RED.
- [ ] Separate gateway alias translation from strict canonical validation; never configure a Redis model to silently accept legacy identity aliases.
```python
supplier_identity = wire_result["duffelOfferId"]
canonical_result = {**wire_result, "supplierOfferId": supplier_identity}
del canonical_result["duffelOfferId"]
```
- [ ] Add neutral valid control and fresh-search public-tool behavior, one RED/GREEN cycle each; reject unsigned alias substitution and preserve SSE display fields.
- [ ] Run focused agent tests, Ruff check/format, full non-Redis suite; request approval for existing internal fixture changes before changing them.
- [ ] Commit with `refactor(agent): neutralize trusted supplier identities`; report counts and discovery.

### Task 3: T047 — Shared and domain names

**Files:** Modify `packages/shared/src/booking-types.ts`, `disruption-types.ts`, `types/ancillary.types.ts`; API domain consumers in disruption/booking/ancillary paths. Create `apps/api/src/disruption/domain/supplier-identifiers.spec.ts`.

**Interfaces:** Internal snapshots/normalized segments expose `supplierSegmentId: string | null` (snapshot optional string); internal ancillary records use `supplierPassengerId: string`. Distinct legacy response DTOs keep current wire fields; retain concrete webhook DTOs.

- [ ] Add a public normalization/domain regression asserting a neutral identity survives segment matching; run focused Jest RED.
```typescript
expect(normalized[0]).toMatchObject({ supplierSegmentId: 'seg_legacy' });
```
- [ ] Apply only the internal matrix; do not replace signed/wire/webhook/history fields. Use neutral types for domain input and explicit legacy DTO shapes for exposed responses.
- [ ] Run domain regressions/shared compile/contracts and API typecheck/lint. Record pending T051/T053 dependencies accurately; leave task open until coordinated gates pass.
- [ ] Commit verified T047 work with `refactor(shared): introduce neutral supplier domain fields`.

### Task 4: T048 — Explicit wire/HMAC mappings

**Files:** Modify `apps/api/src/flights/dto/search-flight.dto.ts`, flights mapping/service, `booking-management/dto/booking-response.dto.ts`, `agent-gateway/dto/attested-flight-search.dto.ts`, `agent-gateway/selection-attestation.service.ts`, and boundary consumers. Create `apps/api/src/agent-gateway/supplier-wire-compatibility.spec.ts`.

**Interfaces:** Consume neutral internal offers; return legacy DTOs. `SelectionAttestationOffer` remains the legacy signed envelope `{flightOfferId: string; duffelOfferId: string}`; unsigned neutral aliases never override verified identity.

- [ ] Add neutral-input/public-output regression preserving exact keys and signature; run RED.
```typescript
const signedOffer = { flightOfferId: offer.id, duffelOfferId: offer.supplierOfferId };
expect(Object.keys(signedOffer)).toEqual(['flightOfferId', 'duffelOfferId']);
```
- [ ] Map neutral domain identity before signing; retain existing ordered signed payload serialization and verifier identity comparisons. Keep persistence using neutral values independently of returned wire DTO.
- [ ] Run new regression and unchanged T044 attestation/attested-search fixtures, shared public projection tests, API typecheck/lint.
- [ ] Commit with `refactor(api): preserve legacy supplier wire mappings`.

### Task 5: T051 — Legacy snapshot reads and neutral writes

**Files:** Modify `apps/api/src/supplier/order/order-snapshot.normalizer.ts`, affected snapshot readers in booking/disruption/recovery; create `apps/api/src/supplier/order/supplier-snapshot-compatibility.spec.ts`.

**Interfaces:** Supplier order normalization emits neutral segment IDs; durable JSON read normalizes either legacy or neutral identity into domain `supplierSegmentId`. HTTP DTO mapping restores existing legacy key when contractual.

- [ ] Add new-write regression asserting supplierSegmentId and absence of duffelSegmentId; run RED, then minimal normalizer change.
```typescript
expect(snapshot.segments[0]).toHaveProperty('supplierSegmentId', 'seg_1');
expect(snapshot.segments[0]).not.toHaveProperty('duffelSegmentId');
```
- [ ] Add legacy-read regression, run RED, normalize legacy key without changing stored historic JSON; repeat with neutral-read/order/zero-field control.
- [ ] Preserve historic payment event/recovery-point/ledger literals; exercise unconfirmed cancellation retaining PROCESSING, hold, event, and retry checkpoint.
- [ ] Run baseline T045 plus order/recovery/payment/disruption suites, API typecheck/lint; commit `refactor(api): normalize legacy snapshots and neutral writes`.

### Task 6: T052 — Physical schema rename

**Files:** Modify `apps/api/prisma/schema.prisma`; create `apps/api/prisma/migrations/20260929000000_supplier_identifiers/migration.sql`; create `tests/ci/supplier-identifiers-migration.contract.test.mjs`.

**Interfaces:** Eleven matrix columns and five dependent indexes become supplier-named. Webhook model/table untouched; no `@map` aliases or historic migration edits.

- [ ] Add a migration contract regression covering every matrix rename and webhook exclusions; run Node test RED before SQL exists.
- [ ] Rename columns in place and corresponding Prisma fields/index references.
```sql
ALTER TABLE "bookings" RENAME COLUMN "duffelOrderId" TO "supplierOrderId";
ALTER INDEX "bookings_duffelOrderId_idx" RENAME TO "bookings_supplierOrderId_idx";
```
- [ ] Rename other indexes: bookings composite sync, booking_intent_passengers passenger, flight_offers unique, itinerary_revision_segments identity. Preserve all definitions/nullability/relationships.
- [ ] Run contract GREEN and installed Prisma validate; API compilation awaits T053 generated client/consumers and is recorded accordingly.
- [ ] Commit `refactor(db): physically rename supplier identifiers`.

### Task 7: T053 — Generated client and consumers

**Files:** Update actual Prisma consumers across API booking-intent, ancillaries, payment, cancellation, disruption, agent-gateway, chat-handoff, lifecycle/projection, search; generated client is regenerated, never hand edited. Create `apps/api/src/supplier/supplier-persistence.spec.ts`.

**Interfaces:** Consume generated neutral Prisma fields; map at public DTO edges. No compatibility casts or old physical column maps.

- [ ] Run new persistence regression against neutral database identity; confirm RED on old consumer access.
- [ ] Generate client using installed Prisma CLI, then update query/select/data objects, property access, and local names from exact matrix. Wire object keys and webhook data remain legacy.
```powershell
& '.\apps\api\node_modules\.bin\prisma.CMD' generate --schema apps/api/prisma/schema.prisma
```
- [ ] Run shared/API/web typechecks and focused Prisma-consumer regressions; obtain explicit approval for internal test fixture adaptations before modifying existing tests.
- [ ] Run complete guarded API/shared lint/tests; commit `refactor(api): consume neutral Prisma supplier fields`.

### Task 8: T054 — Migration and cross-service proof

**Files:** Create `apps/api/test/supplier-identifiers-migration.e2e-spec.ts` or executable migration verification harness under `tests/ci/`; update `specs/029-duffel-provider-narrowing/slice-6-2-verification.md` with exact evidence.

**Interfaces:** Two disposable databases `feature029_slice62_fresh` and `feature029_slice62_upgrade`; seed representative rows/links against preceding schema, then deploy forward rename.

- [ ] Verify empty-chain deployment and clean migration status using installed Prisma migrate deploy/status with explicit dedicated URLs.
- [ ] Apply preceding chain separately; insert representative Booking/Intent/Passenger/Seat/Baggage/Offer/RevisionSegment/Handoff rows and null/duplicate controls; capture identities, links, sync clock/indexes, and uniqueness before rename.
- [ ] Deploy new migration; assert preserved values/relationships/nullability/unique behavior and inspect pg_catalog for all eleven columns/five indexes and unchanged webhook identity.
- [ ] Run existing affected booking/payment/recovery/disruption E2Es with dedicated migrated DB; run full shared/API/web/agent gates, web build/injection cases, unchanged signed-byte fixtures, new regressions and discovery counts.
- [ ] Run scoped speckit-converge for T047–T054, close valid gaps, then independent Standards and Spec code-review against baseline. Fix blocking findings and re-review.
- [ ] Sync relevant context/tasks only after passing gates; commit task proof with `test(db): verify supplier rename migrations and compatibility`.
- [ ] Open a new PR to development on this branch (preceding PR is merged), attach it, verify all required remote CI on final pushed HEAD. Preserve T055–T057 pending.

## Plan self-review

Execution refinement after T051 commit: reuse the T051 worker for T048 (two feature tasks total). T054 may implement its independent `tests/ci/`, web package script, and CI wiring while T053 updates API consumers; no source ownership overlaps. T054 database, package and E2E execution still waits for T053/T048 to close the coordinated dependencies. Root serializes task commits and keeps intermediate checkboxes open.

Coverage: matrix names implement FR-009/T047/T052/T053; explicit wire and signed bytes implement FR-010/T048/T049/T050; legacy JSON and strict state implement FR-010a/T050/T051; webhook exception implements FR-011; migrations and package gates implement scoped FR-012/T054. No new endpoint, module, library, or budget changes.

Shared boundaries are serialized: T047 produces domain identities consumed by T048/T051/T053; T052 produces schema consumed by T053; T053 closes compiler dependencies before T054. Public/signed types are deliberately legacy; strict Redis canonical types deliberately neutral. Interim dependency errors never count as passing validation or task completion.
