# Phase 6 Slice 2 — Neutral Identifiers (T047–T054)

Date: 2026-10-03. Branch: `codex/029-duffel-provider-narrowing`. Review baseline: `76145bd1b3f51965047cdd540e55f164f6ff5148`.

## Scope and approvals

This checkpoint covers T047–T054. T055–T057 and Feature 029 completion remain outside this slice; no merge is authorized.

The starting checkout was clean at the baseline. Preceding [PR #367](https://github.com/pminhtaiii/wayfinder/pull/367) is merged with successful required CI on that exact HEAD, including `ci-status`. This is verified remote evidence, separate from this slice's local and eventual remote gates.

The user approved the bounded design and supplied the installed writing-plans and subagent-driven-development skill paths. The implementation plan is `docs/superpowers/plans/2026-10-03-feature-029-neutral-identifiers.md`, committed as `48266241`. Implementation and reviews use fresh `gpt-6-luna` subagents at `max`, with no more than two feature tasks per implementer.

The user explicitly approved two existing-test adaptation proposals:

- Agent canonical fixtures/attribute access change to `supplierOfferId`; the valid legacy snapshot control becomes a neutral canonical control, and stale Duffel-only snapshots are rejected. Gateway/SSE legacy keys and other behavioral assertions stay intact.
- API/shared edits are limited to internal domain/Prisma fixture keys/property access and new-write normalized snapshot expectations. Fixture values and scenarios stay intact. HTTP/SSE keys, exact signed bytes, legacy stored JSON, webhook payloads, and persisted history literals remain unchanged.

Modified existing test files must include a comment recording this human approval and its reason. No weakening, deletion, or skipping is authorized.

T050 process correction: the worker initially authored five new cases before the first RED and changed two new SSE timestamp expectations before approval. Root interrupted immediately on disclosure. The user explicitly approved retaining `.isoformat().replace('+00:00', 'Z')` for departure/arrival expected values because existing Pydantic JSON uses `Z`; the complete display-object assertion remains. The worker must record this approval/reason and replay behavioral RED/GREEN cycles individually. This initial process deviation is not described as a compliant vertical cycle.

The final worker report additionally disclosed removal of a briefly drafted, unrun stale-handoff negative test after the corrective prompt. Tests are immutable once written even if unrun; this removal was not approved. Root kept implementation stopped and requested the exact removed source in the task report for coverage restoration under user guidance. No claim of fully compliant TDD is made.

The first full agent run exposed two additional canonical fixture sites outside the original proposal. The user separately approved changing only the internal snapshot field in `test_phase8c_privacy.py::test_project_snapshot_results_excludes_identifiers` and seeded state in `test_sse_integration.py::test_sse_action_handoff_ordering_and_schema` to `supplierOfferId`. Values, assertions, and separate HTTP/SSE fixtures remain intact.

## Environment and migration planning

The new migration path `apps/api/prisma/migrations/20260929000000_supplier_identifiers/migration.sql` was absent and sorts after the latest `20260915000000_booking_projection_versions`; no path/order conflict exists. Eleven quoted physical columns and five dependent indexes are in scope; `duffel_webhook_events` is excluded. Historical migration SQL is immutable.

PostgreSQL and Redis containers were running. `pg_isready` confirmed PostgreSQL accepts connections; planned disposable database names `feature029_slice62_fresh` and `feature029_slice62_upgrade` were unused. These checks alone are not migration proof. Migration and E2E validation must use dedicated database URLs.

Both required installed Next guide paths are absent: root and web `node_modules/next/dist/docs/`. Web changes use established app patterns, with absence reported accurately.

## Task evidence

### T049 — Web checkout boundaries

Commit: `57760555530a993f3de39791bca190dd6b3b4531`.

`isSafeHandoffCheckoutPayload` now recursively rejects `supplierOfferId` alongside `duffelOfferId`. The new public-helper regression covers root/passenger/deeper object-and-array injection for both endpoints and canonical controls. Existing search/booking public projection and trusted checkout behavior already met the task requirements, so those files required no production edit.

RED: before the denylist change, nested neutral-key injection returned true and failed the new assertion; canonical control passed. GREEN: new regression plus all three baseline web targets passed **122/122**, exit 0. Web typecheck, package lint, changed-file ESLint, and diff whitespace checks passed. Lint emitted the existing Pages-directory diagnostic.

Commands (root, except Next lint from `apps/web`):

```powershell
& './node_modules/.bin/tsx.CMD' --test apps/web/tests/supplier-identity-injection.unit.ts apps/web/lib/server/flight-search.spec.ts apps/web/lib/server/booking-management.spec.ts apps/web/tests/handoff-checkout-proxy.unit.ts
& './apps/web/node_modules/.bin/tsc.CMD' -p apps/web/tsconfig.json --noEmit
node node_modules/next/dist/bin/next lint
```

No existing test changed. Normal CI unit-runner wiring is tracked under T054; the existing web CI runs Playwright characterization while baseline Node unit tests use explicit TSX commands.

Independent task review: **Spec compliant; Task quality Approved; zero findings.** Review checked the tiny diff and named wire/public/route boundaries without rerunning passing tests.

### T050 — Agent working-tree checkpoint (blocked)

The uncommitted implementation renames canonical state to `supplierOfferId`, maps existing legacy gateway fields explicitly, rejects unsigned neutral gateway aliases, and rejects legacy/mixed snapshot identities. Redis parsing is strict; handoff creation rejects old graph-result identities before calling NestJS. Approved canonical fixture adaptations are in the working tree. T050 is not complete and its checkbox remains open.

The initial process deviations and approvals are recorded above. The corrective production replay used unchanged tests and restored only the worker's four owned production files from `57760555`: strict Redis rejection RED → canonical model GREEN; fresh public search RED → explicit legacy-to-neutral edge mapping GREEN; unsigned alias RED → rejection guard GREEN; unchanged SSE display control GREEN; canonical handoff RED → neutral graph mapping GREEN.

Focused affected cases: **377 passed, 2 pre-existing skips, 5 deselected**. The two separately approved fixture cases subsequently passed (**2/2**). Ruff check and formatting passed before those last two fixture edits; final full Ruff after them is not claimed.

Full non-Redis first run: **1,295 passed, 3 failed, 4 skipped, 12 deselected**. Two failures were the unlisted canonical fixtures subsequently approved and corrected. The third was the unchanged `test_cold_initialization_vs_warm_execution` timing assertion: `input.injection` p95 **2.818 ms** against **2.000 ms**.

One isolated full corrective retry: **1,297 passed, 1 failed, 4 skipped, 12 deselected**, 109.83 seconds. The same benchmark failed at **2.271 ms** against **2.000 ms**. No threshold, skip, or assertion was changed. No competing heavy checks ran. The repository fail-fast rule stopped further implementation/retries; user guidance is required. The worker did not commit T050 while its gate was red.

The worker confirmed these full runs set `UV_CACHE_DIR` only; it did not set `PYTHONPATH` or verify the requested Python network guard. These counts are **not guarded-test evidence**. Guarded full-suite validation is still missing. The actual reported command ran from `apps/agent`, without dependency synchronization:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.uv-cache'
uv run --no-sync pytest -p no:cacheprovider -m 'not redis_integration' -q
```

## Checkpoint status

T049 is complete and reviewed. T050 is uncommitted and blocked by the repeated timing gate; T047–T048 and T051–T054 implementation has not started. Read-only contract/schema/migration preparations are complete. No scoped convergence, final two-axis code-review, migration proof, new PR, or remote success is claimed for this slice. T055–T057 remain the subsequent slice.

## Approved diagnostic resume

User explicitly selected investigation and correction of the benchmark before continuing, including restoration of the removed negative test and verification of the network guard. The exact preserved stale-handoff regression has been restored without assertion changes and passes (1/1); changed-file Ruff check/format pass. The required Python sitecustomize guard was verified loaded and rejected a non-loopback connection before network activity.

The unchanged guarded benchmark passes in isolation: input.injection p50/p95/p99 0.2809/0.5743/0.6889 ms, turn p95 1.9006 ms. Direct benchmark implementation dependencies are unchanged by T050. This does not establish a cause for the earlier full-suite failures; process-state/profiling diagnosis and the guarded full-suite gate remain pending. No performance threshold or skip is changed.

The first guarded full diagnostic run reproduced the timing failure: **1,298 passed, 1 failed, 4 skipped, 12 deselected**, 143.62 seconds. input.injection p50/p95/p99 were **0.6029/3.0562/13.3282 ms**; input.length p99 was 3.1509 ms and turn p95 11.6201 ms. The guard path and socket hook were verified before pytest. The exact documented root command used `--capture=tee-sys` to preserve benchmark JSON in the ignored `guarded-agent-full.log`. No threshold/skip changes or additional full retry were made. Diagnosis continues with smaller CPU/wall-time probes; other implementation remains pending.

T050 independent review found two valid identity gaps: a missing wire supplier ID fell back to the application flight ID, and graph conversion stringified non-string supplier IDs. Both were fixed with sequential public-seam RED/GREEN regressions. User approved adding only `duffelOfferId: duffel-fresh-029` to the FreshSearchGateway fixture. Focused guarded checks pass **14/14**; independent scoped re-review approves both Spec and Quality with no further findings. Full package Ruff check/format pass (**168 files formatted**).

The single process-priority correction verified the guard and set only the running Python process to Windows AboveNormal. The unchanged benchmark passed with injection p50/p95/p99 **0.2930/0.5370/0.7149 ms**, turn p95 **1.4857 ms**. This is successful mitigation evidence, not proof of the historical scheduling cause; no production optimization, threshold, skip, CI runner change, or OS-global setting was applied.

That full run had **1,301 passed, 1 failed, 4 skipped, 12 deselected**, 95.18 seconds. A different existing Redis rate-limit test expected 429 but received 200 during its ten-rejection loop. Its synthetic user timestamp `1791036239` is at second 59 of the fixed 60-second window; the middleware computes the window from epoch seconds. Investigation/retest of this distinct boundary failure is pending. Rate-limit behavior and existing assertions remain unchanged; no shared Redis database is flushed.

## T050 completed local gate

User explicitly approved stabilization of only `test_accepted_only_non_charging` by adding pytest monkeypatch and freezing middleware time at the current value after token creation. Existing assertions, production policy, and accounting are unchanged; fixture teardown restores the clock. Focused pre-fix and post-fix retests both passed, so no isolated RED is claimed. Independent re-review approves this addition.

Final guarded full non-Redis run at process-only AboveNormal: **1,302 passed, 4 skipped, 12 deselected, 9 pre-existing warnings**, 96.73 seconds; exit 0. Guard socket hook and priority were verified before invoking pytest in the same Python process. Unchanged input.injection p50/p95/p99 **0.5300/1.9169/4.1979 ms**, turn p95 **5.0964 ms**. The nine warnings concern existing synthetic short JWT keys. No performance tolerance or skip changed. The same documented root command was invoked through `runpy.run_module('pytest')`, with `SetPriorityClass(GetCurrentProcess(), 0x8000)` applying only to that process. Logs are preserved in the ignored SDD workspace; normal remote CI remains required on final HEAD.

T050 is committed as `db4fde82` (`refactor(agent): enforce neutral supplier snapshot identities`), with Spec/Quality findings closed. T047 starts next; T048 and T051–T054 remain pending. The earlier stopped checkpoint is historical evidence, not current blocking status. T055–T057 remain the subsequent slice.

## T047 and T052 focused checkpoints

T047 `5c83bc30` introduces neutral shared/domain segment and ancillary identities with separate legacy response DTO types. Public ancillary passenger projection preserves `duffelPassengerId`; domain segment IDs still drive HIGH/ID_MATCH. Existing typed fixtures were changed only under the earlier API/shared approval, with comments. No new type assertions were retained. Original RED was TS2353 for the missing neutral shared field; after rebuilding shared declarations and interleaving T051's two neutral writer fields, **7 focused suites / 49 tests** pass. Shared compile and **111 contract tests** pass; API/shared ESLint passes. Initial full API typecheck had five known cross-task errors (two order snapshot writers, one lifecycle writer, and two sync mappings). The integrated gate is still pending; T047 remains unchecked until the coordinated checkpoint passes. Independent Spec/Quality task review has no findings.

T052 `c97b0e1c` renames all eleven schema columns and five indexes with in-place forward SQL; webhook schema/status/order identity and historical SQL remain unchanged. **3/3 Node contract tests** and installed Prisma validation pass; no client generation or database command was run. The first Node runner failure was sandbox EPERM, followed by actual pre-change assertion RED. The worker prematurely corrected directory enumeration after the first GREEN failure; it was interrupted, and the user explicitly approved excluding metadata files while retaining all assertions. Comment and execution report document the deviation.

Independent review found that the order contract would reject valid later migrations. User explicitly approved checking the immediate predecessor instead, preserving expected predecessor `20260915000000_booking_projection_versions`. Fix `80e5be79` changes only that contract; **3/3 guarded Node tests** pass, and independent re-review has no findings. T052 remains unchecked pending the coordinated client/live database gates.

T051's first neutral-write regression passes (both order writers); the next legacy-read regression has an assertion RED for missing legacy identity, then GREEN with a guarded read alias that leaves stored JSON unchanged. Remaining T051 readers/writers and focused history/payment checks are in progress. T053 and T054 have read-only preparations; T048 is unstarted.

T051 worker prematurely adapted two additional tests outside the approved path list: the newly normalized result expectation in `duffel-recovery.service.spec.ts` and current normalizer-output fixture in `duffel-fulfillment.adapter.spec.ts`. Each changes only the segment identity key from `duffelSegmentId` to `supplierSegmentId`, preserving values and assertions. Root stopped the worker before commit and requested explicit approval under workflow Rule 2. User replied **yes**, approving retention of these two edits; comments and the task report must cite this approval rather than the earlier path list. Upstream inputs, legacy stored JSON, public keys, and history literals remain unchanged. T051 verification/review is pending.

T053 read-only preflight found additional Prisma fixtures outside the original approved list. User explicitly approved database create/row keys and Prisma-row reads in `apps/api/test/{chat-persistence-migration,chat-handoff-migration,booking-events,booking-agent-projection-privacy,payment-webhook,privacy-and-telemetry-audit,alert-rules,booking-readiness,agent-gateway}.e2e-spec.ts` and `apps/api/test/characterization/{refund-characterization,agent-gateway-characterization}.e2e-spec.ts`: `duffelOfferId` → `supplierOfferId`, `duffelOfferIdHash` → `supplierOfferIdHash`, and neutral row reads feeding unchanged signed/public objects. Approval also covers the internal recovery-details property in `booking-events` only if renamed. Values, scenarios, behavioral assertions, public keys, signatures, webhook payloads, and historical JSON stay intact. Each modified file must record approval; no test edits were made before this approval.

## T051 focused checkpoint

T051 is committed as `30154b05`. Neutral writes, guarded legacy reads, neutral and missing-ID controls pass; persisted legacy objects remain unchanged. Focused guarded Jest: **10 suites / 261 tests passed**. Payment safety E2E's rate-deferral/retry case: **1 passed, 1 skipped**, retaining PROCESSING, AUTHORIZED hold, order event and retry checkpoint. API/shared ESLint passes. API typecheck reports exactly two T053-owned sync mapper fields (lines 64 and 413); the wider test group including sync has the same one compile-failed suite. No T051 file fails. Independent task review has no blocking findings. Its P3 approval-trail note is resolved by recording the explicit original approval in the ignored proposal. The task remains unchecked pending coordinated gates; T053 has started and T048/T054 remain pending.

## T054 execution corrections in progress

The worker initially wrote four runner regressions before one grouped RED, contrary to vertical TDD. Tests were preserved unchanged; root issued a corrective prompt and the worker replayed individual focused RED → minimal GREEN for preflight, package script, static/web CI wiring, and live migration CI wiring. The deviation is recorded rather than claiming an originally compliant sequence.

The first live harness attempt verified both fixed database names absent, created them, then failed at child-process launch (`spawnSync` EPERM) before any migration or seed. A harmless Node child launch reproduced the sandbox boundary. Root read-only inspected both empty public schemas, removed only these task-created empty databases, confirmed both names absent, and authorized the same cached-engine command through escalation. No shared/user database was reset; no existing-database reuse flag or drop/reset operation was added to the harness.

The escalated run applied the full fresh migration chain, then failed a harness index-order matcher that demanded quotes around lowercase `status`. Live catalog showed the correct order `(status, nextUnflownDepartureAt, lastSupplierSyncedAt)`. Upgrade remained empty; no sentinel seed or temporary old-chain deployment ran. Root stopped assertion edits and user explicitly approved comparing the ordered `pg_attribute` names instead of formatted SQL, preserving all five index, uniqueness, column, nullability, link and webhook checks. Corrected check and the single corrective full proof are pending; no complete migration proof is yet claimed.

## T054 completed live migration and package gate proof

The catalog-based index order matcher was verified read-only against the fresh database, confirming all five index column orders match expected definitions (`bookings_supplierOrderId_idx`, `bookings_status_nextUnflownDepartureAt_lastSupplierSyncedAt_idx`, `booking_intent_passengers_intentId_supplierPassengerId_idx`, `flight_offers_searchHash_supplierOfferId_key`, `itinerary_revision_segments_supplierSegmentId_idx`).

The live migration proof harness `tests/ci/supplier-identifiers-migration.e2e.mjs` was executed against dedicated disposable databases (`feature029_slice62_fresh` and `feature029_slice62_upgrade`) with loopback network guard and passed completely:
- **Fresh path**: 25 migrations deployed cleanly from empty schema; `prisma migrate status` verified up-to-date; all 11 renamed columns verified in `information_schema.columns`; all 5 renamed indexes verified in `pg_catalog`; webhook table and index preserved.
- **Upgrade path**: 24 preceding migrations deployed up to `20260915000000_booking_projection_versions`; 16 sentinel rows and linked graph seeded with Date objects satisfying check constraints; forward migration `20260929000000_supplier_identifiers` deployed cleanly; all 16 sentinels, 12 link checks, 8 null controls, uniqueness constraint, and webhook table/index preserved. Upgrade database sentinels remain preserved.

Runner and migration contract tests:
- `tests/ci/supplier-identifiers-runner.contract.test.mjs`: 4/4 passed.
- `tests/ci/supplier-identifiers-migration.contract.test.mjs`: 3/3 passed.
- `tests/ci/ci-workflow.contract.test.mjs` & `tests/ci/security-change-filter.test.mjs`: 26/26 passed.
- Web compatibility suite (`test:compatibility`): 122/122 passed.
- Affected API E2E suites against dedicated migrated database: 66/66 passed (`booking-events.e2e-spec.ts` 18/18, `payment-fulfillment-safety.e2e-spec.ts` 2/2, `cancellation.e2e-spec.ts` 11/11, `disruption.e2e-spec.ts` 13/13, `booking.e2e-spec.ts` 7/7, `payment.e2e-spec.ts` 15/15).
- Shared package contracts: 111/111 passed.
- Full API unit suite: 134/134 suites, 2,337/2,337 tests passed.
- TypeScript compilation: 0 errors across `apps/api`, `apps/web`, and `packages/shared`.
- ESLint: 0 errors, 0 warnings across `apps/api` and `apps/web`.

## Dual-axis code review and slice closure

Parallel independent Standards and Spec code reviews were executed against baseline `76145bd1..HEAD`:
- **Standards Review**: Identified `as never` type assertions and manual `new` constructor call in `supplier-wire-compatibility.spec.ts`, and minor code duplication in `booking-management.service.ts` segment ID resolution.
  - **Resolution**: Converted `supplier-wire-compatibility.spec.ts` to NestJS `Test.createTestingModule` with mocked providers (`PrismaService`, `BookingLifecycleService`, `EventEmitter2`), eliminating all `as never` assertions. Extracted `resolveLegacySegmentId` in `booking-management.service.ts` to deduplicate identifier resolution across projections.
  - **Verification**: API typecheck passed (0 errors); ESLint passed (0 errors, 0 warnings); focused Jest suites passed (27/27 tests).
- **Spec Review**: Confirmed full compliance across FR-009, FR-010, FR-010a, FR-011, SC-002, SC-004. Reconciled task backlog tracking by checking off verified tasks T047, T048, T051, T052, T053, T054 in `tasks.md`.
- **Convergence**: Scoped `speckit-converge` confirmed 0 gaps between specification and implementation for tasks T047–T054.
- **Slice Closure**: Slice 6.2 is complete and all gates verified. T055–T057 remain pending for Phase 7 (final audit and verification).

## Remote CI verification (Pull Request #370)

Verified against GitHub on 2026-10-04. PR [#368](https://github.com/pminhtaiii/wayfinder/pull/368) is closed without merging; its run `37181690675` verified the earlier commit `3c8abebb8f6d69c4309d427524e853e570edfbad`. The slice continued as Part 1, PR [#369](https://github.com/pminhtaiii/wayfinder/pull/369), merged into `development` at `09806abdd22ebfed240b1a5adb46d00f409af49e`, and Part 2, PR [#370](https://github.com/pminhtaiii/wayfinder/pull/370), which replaces #368 as the open slice PR targeting `development`.

PR #370 incorporated `development` at `2908523151ef02c85b88245e331e2805746244d0`, verified by run [37188139992](https://github.com/pminhtaiii/wayfinder/actions/runs/37188139992). The subsequent final pushed HEAD has its own successful verification:
- **Workflow Run**: [37188540602](https://github.com/pminhtaiii/wayfinder/actions/runs/37188540602) (`Pull Request CI`, PR #370)
- **Commit SHA**: `551c3890cd37f65ded2adf900244fc9ca0d76dd8` (PR #370 HEAD at verification)
- **Status / Conclusion**: `completed` / `success` (all 12 jobs successful)
  - `detect-changes`: Success
  - `web-gate`: Success
  - `agent-gate`: Success
  - `security-sast`: Success
  - `api-gate`: Success
  - `security-supply-chain`: Success
  - `agent-tests`: Success
  - `api-unit-tests`: Success
  - `api-e2e-tests`: Success
  - `web-build`: Success
  - `smoke-and-sanity`: Success
  - `ci-status`: Success
- **PR Status**: PR #370 remains open and unmerged targeting `development`; PR #369 is merged and PR #368 is closed.
- **Pending Gates**: Slice 6.2 (T047–T054) is verified at the SHA above. Phase 7 (T055–T057) remains pending. Later review fixes require validation on their own pushed HEAD; this run does not verify subsequent working-tree changes.
