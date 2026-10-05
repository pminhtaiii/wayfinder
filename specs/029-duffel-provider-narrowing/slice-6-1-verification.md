# Phase 6 Slice 1 — Compatibility Baselines (T044–T046)

Date: 2026-10-03. Branch: `codex/029-duffel-provider-narrowing`. Review baseline: `640a4cbe50f3cb791d3e4588d3d37d16c088ad02`. Prior checkpoint PR: #366, already merged to `development`; this slice opens a new PR.

## Scope and approvals

This slice pins observable contracts before supplier-neutral renames. No production fields, signed payload formats, dependencies, physical schema, or migration files change. Feature 029 remains incomplete; T047–T057 remain pending.

The user approved the bounded design before implementation and supplied the installed `writing-plans` and `subagent-driven-development` skill paths. Planning used `docs/superpowers/plans/2026-10-03-feature-029-compatibility-baselines.md`; execution used fresh `gpt-6-luna` agents at `max`, one task each, sequential implementation with independent task reviews.

Approved adjustments:

- T045 characterizes current legacy booking compatibility and strict invalid/stale agent snapshots. Neutral segment identity/new-write projection remains T051; the current reader only interprets `duffelSegmentId`.
- T046 remains test-only. Both root identity names are rejected by the current allowlist and nested legacy identity is rejected recursively. The user explicitly chose: “Keep T046 test-only; defer nested rejection to T049.” No nested-neutral rejection is claimed in this slice.
- Current search input schema rejects a future `supplierOfferId` key as `UPSTREAM_UNAVAILABLE`; the characterization records this fail-closed outcome and keeps a successful legacy display control.

Installed Next.js guidance at root and web `node_modules/next/dist/docs/` was absent. This slice adds tests only and does not introduce version-specific Next.js implementation.

## Completed task evidence

### T044 — Wire keys and signed bytes

Commit: `4983af2d1ef66ce87e1c0a396713b4cfbe36988e`.

- Complete deterministic `sel_v1_` token, decoded exact JSON, HMAC, ordered offer objects, and legacy signed `duffelOfferId` are pinned through signing/verification interfaces.
- Supplier-named substitution retaining the old digest is rejected. V2 results and signer arguments retain their key/order contracts; shared public views reject both identity spellings.
- Focused guarded API: **2 suites / 57 tests passed**. Shared target: **4 suites / 27 tests passed**. API/shared typechecks and full API/shared ESLint passed.
- Sensitivity: reversing production signed-offer serialization made the new exact-token assertion fail; original bytes were restored in `finally`, and all 57 focused API tests passed again.
- Independent task review: Spec compliant and Task quality Approved; zero findings.

### T045 — Legacy snapshots and strict agent state

Task commit: `1462d5774dbb1641e29e06e361f6ac9b514f2237`. Review-fix commit: `992dc15a58b39aa5b4091a1d93f20328a0923bbb`.

- Legacy segment identity, zero order fields, itinerary facts, stored snapshot response, and ORIGINAL itinerary compatibility are pinned.
- Four normally discovered Python cases cover alias-only rejection, expiry rejection, valid legacy control, and an explicit public `search_flights.ainvoke` reaching the external gateway with fresh narration after rejection. Rejection is not claimed to automatically initiate search.
- Real repository/lifecycle and public tool behavior execute with external Redis/gateway fakes. No internal lifecycle/repository collaborator is mocked.
- Focused API: **2 suites / 25 tests passed**. New Python file: **4 collected / 4 passed**. API typecheck, full API/shared lint, Ruff check, and Ruff format passed.
- Sensitivity: temporary removal of normalized legacy ID, replacement of stored response snapshot, bypassed expiry guard, and alias acceptance each failed the targeted new assertion. All production files were restored byte-for-byte and covering tests passed.
- Initial task review found two guardrail issues: direct construction used by the new booking case and missing explicit callback return types. The fix uses `Test.createTestingModule` only for the new case and types both callbacks; existing setup and assertions are unchanged. One scoped re-review marked both findings ADDRESSED and approved task quality/spec compliance with no new blocking finding.

### T046 — Public projections and checkout boundaries

Commit: `53ccd69a263b6444921a79104f6c2093f9fa8068`.

- Search rejects the injected future identity through the current strict ranked-offer schema; the successful legacy control preserves public display data.
- Booking projection preserves booking/passenger/segment display data while omitting five provider identity keys and their sentinel values.
- Both checkout endpoints reject both root identity names and accept canonical payloads; nested legacy rejection is pinned. Nested neutral rejection remains T049.
- All three files were discovered by the root TSX node:test runner: **120/120 passed** (56 search, 59 booking, 5 checkout). Web typecheck, Next lint, and direct changed-file ESLint passed. Next lint emitted its existing “Pages directory cannot be found at .” diagnostic; direct ESLint was clean.
- Temporary ranked-schema passthrough, public provider-value projection, readiness allowlist expansion, and recursive legacy-deny removal each failed the intended new assertion. Original production bytes were restored and focused suites passed again. An initial base-schema mutation stayed green because the ranked wrapper remained strict; it was restored and the correct boundary was tested.
- Independent review: Spec compliant; Task quality Approved; zero Critical/Important findings. The existing Next lint diagnostic was a Minor evidence note.

## Scoped convergence

Current-code assessment found no actionable gaps in T044–T046: two applicable FRs (FR-010/010a), US4 AC2, two related edge obligations, five plan decisions, and three applicable governing checks. All nine named test files contain the expected cases through public interfaces. No new tasks were appended. This is scoped convergence only; T047–T057 and Feature 029 remain incomplete.

## Shared validation

| Gate | Result |
| --- | --- |
| Full network-guarded API suite | 130 suites / 2,331 tests passed, exit 0 |
| Static CI contract | 24/24 passed, exit 0 |
| Shared package contracts (all four normal script targets) | 24 suites / 111 tests passed, exit 0 |
| Web production build | Passed, exit 0, installed Next.js 14.2.3 |
| Full agent non-Redis suite | Isolated retry passed, exit 0: 1,291 passed, 4 pre-existing skips, 12 Redis deselected |
| Full agent Ruff check / format | Passed; 167 files already formatted |

The first full agent run had a near-limit performance p95 of 360.219 ms against the existing 100 ms limit while API tests ran concurrently. One retry with competing checks paused passed. Thresholds and assertions were unchanged. Nine warnings come from existing short synthetic JWT keys.

The first final-code full API run had 129 passing suites and 2,330 passing tests; its sole failing test lacked `DUFFEL_ACCESS_TOKEN`. The CI-defined synthetic token was supplied for one corrective full retry, with the network guard retained; all 130 suites / 2,331 tests passed (exit 0).

## Commands

Commands use installed binaries or `uv run --no-sync`; global pnpm 12.5.1 is not used. No dependency installation or lockfile rewrite occurred.

```powershell
# Root: static/shared contracts
node --test tests/ci/ci-workflow.contract.test.mjs
& './packages/shared/node_modules/.bin/tsc.CMD' -p packages/shared/tsconfig.json
node --test packages/shared/dist/types/flight-search.types.spec.js packages/shared/dist/types/booking-management.types.spec.js packages/shared/dist/types/dashboard.types.spec.js packages/shared/dist/types/traveler-profile.types.spec.js

# Root: API/shared static gates
& './apps/api/node_modules/.bin/tsc.CMD' -p apps/api/tsconfig.json --noEmit
& './packages/shared/node_modules/.bin/tsc.CMD' -p packages/shared/tsconfig.json --noEmit
& './node_modules/.bin/eslint.CMD' 'apps/api/**/*.ts' 'packages/shared/**/*.ts' --max-warnings 0

# apps/api: focused and full guarded API
$env:DUFFEL_ACCESS_TOKEN = 'duffel_test_ci_not_a_secret'
$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
node node_modules/jest/bin/jest.js --runInBand src/agent-gateway/selection-attestation.service.spec.ts src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts src/disruption/domain/itinerary-normalizer.spec.ts src/booking-management/booking-management.service.spec.ts
node node_modules/jest/bin/jest.js --config jest.config.json --runInBand

# Root: Python discovery, focused/full tests and package Ruff
$env:UV_CACHE_DIR = 'C:\Booking Systems\.uv-cache'
$env:PYTHONPATH = 'C:\Booking Systems\tests\ci\python;C:\Booking Systems\apps\agent\src'
uv run --no-sync --package agent pytest --collect-only apps/agent/tests/test_trusted_search_snapshot.py -p no:cacheprovider
uv run --no-sync --package agent pytest apps/agent/tests/test_trusted_search_snapshot.py -p no:cacheprovider
uv run --no-sync --package agent pytest apps/agent/tests -m 'not redis_integration' -p no:cacheprovider
uv run --no-sync --package agent ruff check apps/agent
uv run --no-sync --package agent ruff format --check apps/agent
```

Child-process-based tests/builds required the sandbox escalation path after `spawn EPERM`. Git commits required `.git` write access. No tests or security gates were weakened to accommodate the sandbox. The existing Prisma client was regenerated from the unchanged schema after baseline compilation found missing generated models; subsequent compilation passed.

## Web commands

```powershell
# Root
& './node_modules/.bin/tsx.CMD' --test apps/web/lib/server/flight-search.spec.ts apps/web/lib/server/booking-management.spec.ts apps/web/tests/handoff-checkout-proxy.unit.ts
& './apps/web/node_modules/.bin/tsc.CMD' -p apps/web/tsconfig.json --noEmit
& './apps/web/node_modules/.bin/eslint.CMD' apps/web/lib/server/flight-search.spec.ts apps/web/lib/server/booking-management.spec.ts apps/web/tests/handoff-checkout-proxy.unit.ts --max-warnings 0
# apps/web, with local-only build authentication/backend configuration
& './node_modules/.bin/next.CMD' lint
node node_modules/next/dist/bin/next build
```

## Orchestration rulings

- Use the existing feature checkout because GOAL names its branch/checkpoint; a wrong checkout choice would require relocation.
- Implement sequentially with a fresh Luna Max worker per task; the tradeoff is slower execution.
- Use native PowerShell equivalents for unavailable bash artifact scripts; artifact extraction requires manual verification.
- Review against the explicit feature spec/GOAL without unrelated issue-tracker scaffolding; tracker setup remains separate work.

The final two-axis code review compares the complete slice against `640a4cbe50f3cb791d3e4588d3d37d16c088ad02`. Remote CI results belong to the final pushed HEAD of the new slice PR targeting development; [prior checkpoint PR #366](https://github.com/pminhtaiii/wayfinder/pull/366) is already merged; this local record does not claim remote success in advance. No merge is authorized or performed.
## Final two-axis review

Compared against baseline 640a4cbe50f3cb791d3e4588d3d37d16c088ad02. Reviewed implementation and checkpoint docs; the final amendment only preserves these reviewed reports.

# Final Standards Review — T044–T046

Baseline: `640a4cbe50f3cb791d3e4588d3d37d16c088ad02...HEAD` (final commit `4710f38f`). The diff contains test and context/spec documentation changes only.

**Documented-standard findings: 0.** The added TypeScript callbacks declare return types and add no `any` or type assertions; the new Nest test obtains its service through `Test.createTestingModule`. The agent coverage exercises the public `search_flights.ainvoke` path with Redis and gateway fakes. Assertions cover observable wire bytes, snapshot outcomes, and browser/checkout projections. These match `context/code-standards.md` typing and testing rules (lines 24–28, 560–564) and the relevant public boundaries in `context/architecture.md`. No changed production code alters module, port, or client/server boundaries.

**Heuristic smell findings: 0 actionable.** Reviewed the supplied smell categories; none warrants a change. The repeated per-test snapshot setup at `apps/agent/tests/test_trusted_search_snapshot.py:103–177` is short isolation boilerplate; the recurring owner/result/payload shapes are already named by helpers at lines 67–99. Extracting the remaining setup would add indirection without improving the tests.

**Severity:** none.

# Final Spec Review — Feature 029 Compatibility Baselines

Baseline: `640a4cbe50f3cb791d3e4588d3d37d16c088ad02`
Reviewed HEAD: `4710f38f`
Scope: T044–T046 and final slice/context documentation.

## Findings

None. **Critical: 0 · Important: 0 · Minor: 0.**

The tests cover the approved slice: exact `sel_v1_` JSON/HMAC bytes, ordering, legacy `duffelOfferId`, and rejection of a supplier-key substitution; public ranked-view keys and both identity spellings; legacy booking/itinerary reads; strict invalid and expired agent snapshots, including a public fresh-search call after rejection; web booking projection; and checkout rejection for both root keys plus nested legacy identity. The successful legacy display and canonical checkout controls remain covered. No production behavior or later task was added.

The final task and verification documents accurately record the approved adjustments: neutral segment/new-write coverage remains T051, and nested `supplierOfferId` rejection remains T049. The T046 search test records the current strict-schema `UPSTREAM_UNAVAILABLE` result. These deferrals match the slice boundary and the spec’s compatibility requirements: “Existing `sel_v1_` attestations must keep the signed JSON byte shape” and stale snapshots “may fail closed to a fresh search” (spec.md:82); current HTTP/SSE keys remain compatible (spec.md:98–99).

**Assessment: Spec compliant; approved.** This is a scoped slice review. Feature 029 remains incomplete; T047–T057 are pending.

## CI correction — approved HMAC fixture configuration lookup

The new slice PR is [#367](https://github.com/pminhtaiii/wayfinder/pull/367). First final-HEAD run [37118928496](https://github.com/pminhtaiii/wayfinder/actions/runs/37118928496), commit bbe24647, passed ten jobs including API unit/database E2E, web build, agent tests, smoke/sanity and supply chain. SAST step 10 flagged the new test's duplicated literal HMAC key; aggregate status consequently failed.

The user explicitly approved changing only the new test to obtain the same synthetic key from its injected ConfigService. An unknown value is narrowed to string. The expected complete token, serialized JSON, signature and all assertions remain unchanged; the approval/reason is documented in the test. No production change, security baseline exception or scanner suppression was added.

Correction validation: attestation 27/27, API/shared no-emit typechecks, combined API/shared ESLint, and full network-guarded API 130 suites/2,331 tests passed (exit 0, 295.313 seconds). The worker initially invoked pnpm, which stopped at package-manager reconciliation before Jest; no lockfile change was present, and all successful checks used direct installed Node entrypoints. Further pnpm use was stopped.

Exact strict local SAST command was attempted with process permission, but the Windows Semgrep wrapper lacked its executable. The 824-file census is not a completed scan or clean result. Strict remote SAST remains required on the corrective final HEAD. No local scanner install or dependency change was made.

### Correction Standards review

# Standards Review — Approved CI Correction

Baseline `bbe24647`; reviewed `d1c0c64a` plus the uncommitted verification appendix. Scope is the HMAC fixture lookup in `apps/api/src/agent-gateway/selection-attestation.service.spec.ts` and its documentation.

**Documented-standard findings: 0.** The test reads the configured fixture as `unknown` and narrows it before use; no `any` or assertion is introduced. `expectedHmacKey` is clear, and the failure message identifies a missing test fixture. The expected token, JSON, signature, and existing assertions are preserved. The recorded user approval and rationale in the test comment and verification appendix satisfy workflow Rule 2’s approval and documentation requirements (`context/workflow.md:222–231`; `slice-6-1-verification.md:155–163`). This follows the TypeScript typing rules and behavior-focused test guidance (`context/code-standards.md:23–28, 560–565`; `context/workflow.md:233–240`).

**Heuristic smell findings: 0 actionable.** No Mysterious Name, duplicated logic, Feature Envy, Data Clumps, domain Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, speculative abstraction, problematic Message Chain, Middle Man, or Refused Bequest is introduced. The lookup and narrow guard are local to the one oracle assertion; extracting them would add indirection without reuse.

**Severity:** Critical 0 · Important 0 · Minor 0.

### Correction Spec review

# Spec Review — HMAC fixture CI correction

Baseline: `bbe24647`
Reviewed HEAD: `d1c0c64add71bd2a5373798e1e7f3341f7211fa1`
Scope: the committed HMAC test correction and the unstaged CI-correction appendix.

## Findings

None. **Critical: 0 · Important: 0 · Minor: 0.** Missing: 0 · Partial: 0 · Wrong: 0 · Scope creep: 0.

The governing requirement says: “Selection-attestation HMAC payloads MUST retain their current serialized key order and values” (spec.md, FR-010a). The correction changes only the new test's digest-oracle key lookup: it reads the existing synthetic `ATTESTATION_SECRET` fixture through injected `ConfigService`, stores the result as `unknown`, and narrows it with a runtime string check. It preserves the literal complete expected token, decoded serialized JSON assertion, and digest assertion. The pinned token still fixes the exact digest independently of the derived fixture key.

This also matches the plan's goal, “Test-only characterization through current public interfaces. No production behavior or persistence changes.” The diff contains no production behavior, task, schema, dependency, or unrelated test changes. The earlier clean T044–T046 reviews remain applicable to the unchanged slice; this review covers the corrective delta.

The appendix accurately records the 130-suite / 2,331-test API pass and other stated checks. Exact strict local SAST did not run because the Windows scanner wrapper lacked its executable; the census is correctly not called a clean scan. Strict remote SAST on this corrective HEAD remains pending and is not counted as passing. No suppression is claimed.

**Assessment: Spec compliant; approved.**
