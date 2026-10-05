# Feature 029 Final Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete T055–T057 with trustworthy current-source gates, justified supplier exceptions, synchronized documentation and final-HEAD CI.
**Architecture:** Verify the existing search/ancillary/order capabilities and private core; change production only for reproduced failures. Distinct workers own separate reports; one integration worker owns verification.md and tasks.md.
**Tech Stack:** Installed NestJS, Next.js, Prisma/PostgreSQL, Redis, shared TypeScript, Python/uv, pnpm 10.34.5, GitHub Actions.
**Spec:** specs/029-duffel-provider-narrowing/spec.md; approved scope and execution requirements in GOAL.md.

## Global Constraints

- Scope T055, T056, T057 only, plus minimal fixes for verified failures or convergence gaps.
- No second supplier, new endpoint, new dependency, budget-policy change, or speculative abstraction.
- Byte-compatible HTTP/SSE and signed sel_v1_ payloads; preserve webhook signatures, PII redaction, payment holds/replay safety.
- 1,500 attempted calls per UTC day; 1,000 user-search and 500 agent-search allocations; cache hits charge zero.
- Zero any/type assertions; use runtime narrowing, exported ports and Nest constructor injection. No unused imports or variables.
- Existing tests immutable: no edits, skips, weakening or deletion without explicit human approval.
- One corrective retry for any repeated failure; stop and report if it persists.
- No shared/user database reset. Only database owner mutates dedicated disposable databases.
- No installs, lockfile churn, historical migration edits, security suppressions or graphify updates.
- All workers/reviewers gpt-6-luna with max reasoning; each handles 1–2 assigned tasks, no child agents.
- User approved bounded design and supplied both Superpowers skill paths. Run in existing user-named checkout.

## Baseline and Evidence

Pinned baseline and source HEAD: eda88f0dfa052be1a82da8134319928e5a1ac829. Starting local551c3890 fast-forwarded to already-merged remote feature head. PR370 merged into development at0b1c8468; run37189402769 successful on eda88f0 with12 jobs including ci-status. No open PR on feature branch; create final-slice PR against development after local gates/review. Never merge.

Scratch: .superpowers/sdd/2026-10-04-feature-029-final-verification/. Store commands, stdout/stderr, exit codes, source HEAD, discovery counts, pass/fail/skip counts. Do not print secrets. All shell commands PowerShell, absolute workspace C:\Booking Systems. Git writes, Docker/service access and restricted process launches use require_escalated when necessary.

Prior migration proof: slice-6-2-verification.md; harness tests/ci/supplier-identifiers-migration.e2e.mjs latest7d076055; migration latestc97b0e1c. Compare current schema/migration/harness with the recorded proof commit before reuse. Keep fresh-chain25 migrations, upgrade24 preceding,11 renamed columns,5 indexes,16 sentinels,12 links,8 null controls and unchanged webhook evidence explicitly historical. Read-only current migration/catalog inspection strengthens reuse. Harness fixed databases feature029_slice62_fresh/upgrade must not be reset/reused destructively.

## Task 1: T055 API, shared and database gates

**Files:** Report task-1-report.md and per-command logs in scratch only. No production edits or task checkboxes.
**Consumes:** Installed packages, current source, context/testing.md, quickstart sections4–6, previous migration proof.
**Produces:** Fresh API/shared gate results, actual E2E discovery and safe database evidence for Task4. Sole database owner.

- [ ] Record git rev-parse HEAD; verify pnpm --version; inspect docker compose ps and pg_isready through escalation.
- [ ] Run pnpm --filter @shared/types build; pnpm --filter @api/backend exec prisma generate; pnpm --filter @shared/types test; pnpm --filter @shared/types exec tsc --noEmit; pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit.
- [ ] Run pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings0 (use separate argument --max-warnings 0).
- [ ] Set `$env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'`; run pnpm --filter @api/backend run test:ci; capture discovered suites and final counts/exit0.
- [ ] Discover E2Es with pnpm --filter @api/backend exec jest --config test/jest-e2e.json --listTests. Select actual matching files under apps/api/test for supplier capability/module privacy, order idempotency, cancellation, booking recovery, disruption, payment compensation, search/readiness/handoff and ancillary repricing. Record exact discovered selected filenames; run them serially via pnpm --filter @api/backend exec jest --config test/jest-e2e.json --runInBand --runTestsByPath followed by exact paths relative apps/api.
- [ ] For E2Es create new disposable feature029_phase7_e2e database only after proving absent. Discover container name from docker compose ps, use docker exec PostgreSQL psql to query pg_database then CREATE DATABASE with fixed literal. Set DATABASE_URL only in worker process to this database; prisma migrate deploy/status; no shared seed/reset. External HTTP suppliers mocked. Keep historical migration databases untouched.
- [ ] Compare git diff 7d076055..HEAD -- apps/api/prisma/schema.prisma apps/api/prisma/migrations tests/ci/supplier-identifiers-migration.e2e.mjs. If unchanged, reuse explicitly pinned historical live migration evidence and inspect preserved disposable catalogs/status read-only. If changed, report before rerun: fixed-name harness requires absent targets and no reset is authorized.
- [ ] Include schema physical names/indexes/no @map evidence, current migration status and all environment limitations. Report status and required fixes; do not mark T055 complete alone.

## Task 2: T055 web, agent, static and security gates

**Files:** task-2-report.md and uniquely named logs/artifacts in scratch only. No DB mutations, package synchronization, production/test edits.
**Consumes:** Existing installed runtime and testing/security CI commands. Wait for Task1 API heavy run before timing-sensitive full agent tests.
**Produces:** Current web/agent/CI/security evidence for Task4.

- [ ] Record source HEAD; run pnpm --filter @web/frontend lint; pnpm --filter @web/frontend check:routes; pnpm --filter @web/frontend typecheck; pnpm --filter @web/frontend run test:compatibility; pnpm --filter @web/frontend build. Use existing test-only NEXTAUTH_SECRET=local-build-only/NEXTAUTH_URL=http://localhost:3000 for build where needed. No Next source changes; installed guide required before any such fix.
- [ ] Discover and run characterization with pnpm --filter @web/frontend test:characterization; final runner exit required. T093 is conditional on affected handoff runtime; inspect previous evidence and report need explicitly, no shared test_db mutation.
- [ ] Set UV_CACHE_DIR=C:\Booking Systems\.uv-cache and PYTHONPATH=C:\Booking Systems\tests\ci\python;C:\Booking Systems\apps\agent\src. Run uv run --no-sync --package agent ruff check apps/agent; uv run --no-sync --package agent ruff format --check apps/agent. After orchestrator confirms other heavy gates idle, run uv run --no-sync --package agent pytest apps/agent/tests -m 'not redis_integration'; report existing skips/deselections separately. Redis suite only with isolated existing configured Redis if nonconflicting; report exact need.
- [ ] Run node --test tests/ci/ci-workflow.contract.test.mjs tests/ci/security-change-filter.test.mjs tests/ci/evaluate-ci-status.test.mjs tests/ci/network-guard.test.mjs tests/ci/supplier-identifiers-runner.contract.test.mjs tests/ci/supplier-identifiers-migration.contract.test.mjs.
- [ ] Run node --test tests/security/braces-patch.test.mjs tests/security/supply-chain.test.mjs tests/security/workspace-audit-ignore.test.mjs tests/security/sast-runner.test.mjs tests/security/report-privacy.test.mjs. Verify installed pnpm10.34.5 and patch metadata; no upgrades.
- [ ] Run node scripts/security/run-sast.mjs --mode full --sarif-output .superpowers/sdd/2026-10-04-feature-029-final-verification/sast.json --strict-scanner; node scripts/security/run-supply-chain.mjs --output .superpowers/sdd/2026-10-04-feature-029-final-verification/supply-chain.json --strict. Scanner unavailable/network-denied is BLOCKED, never a passing census. One environment corrective retry only.
- [ ] Capture exact commands, counts, exit codes and failures; no weakening/suppression to green.

## Task 3: T056 supplier boundary census

**Files:** task-3-report.md; own census artifacts only until Task4 releases verification.md/tasks.md.
**Consumes:** Current runtime code and supplier-boundaries contract.
**Produces:** Fully enumerated path/line exceptions, module graph and verified unresolved findings.

- [ ] Run rg -n 'DuffelService|DuffelModule|@duffel/api' apps/api/src packages/shared/src apps/web apps/agent/src excluding generated node_modules/.next/build only; separate private bracket/property access searches.
- [ ] Run rg -n -i duffel apps/api/src packages/shared/src apps/web apps/agent/src apps/api/prisma/schema.prisma with explicit source globs. Enumerate runtime versus tests, SDK/config/adapters, webhook model/signature, exact HTTP/SSE/HMAC edge aliases, legacy booking snapshots/history literals and fixtures. Every runtime match needs path/line and reason; do not blanket-waive provider text.
- [ ] Inspect supplier module imports/exports and all core SDK/config/budget consumers. Confirm non-global core, capability-to-core direction, exported ports, no cycles/raw domain readers or monolith/private access.
- [ ] Inspect neutral non-webhook schema/indexes and old duffel_order_created/DUFFEL_COST persisted compatibility. Verify findings against code, do not change production.
- [ ] On owner release, append complete T056 census to verification.md, check T056 only if satisfied, git diff --check, commit only own two files using explicit staging. Report full task evidence and self-review; orchestrator task review follows.

## Task 4: Integrate and commit T055 evidence

**Files:** specs/029-duffel-provider-narrowing/verification.md, tasks.md. Sole writer after Tasks1–2 and before Task3 integration.
**Consumes:** Task1 and Task2 reports/logs and actual migration evidence.
**Produces:** Auditable T055 record, exact passing/blocked state and separate task commit.

- [ ] Read both reports against actual logs/current source. All required gates must pass before marking T055; classify blocked scan separately from regression. Existing skips never counted as passed.
- [ ] Append Phase7 current-source gate matrix, test totals, exact commands, source HEAD, discovery, migration reuse proof and security limitations. Preserve prior sections as historical.
- [ ] If valid failure: delegate one minimal fix with new public regression RED then GREEN, unchanged existing tests, focused tests/typecheck/lint and separate fix commit. Revalidate affected gates. Stop after repeated same failure one corrective attempt.
- [ ] git diff --check; stage only verification.md/tasks.md; commit 'docs(029): record final verification gates (T055)' when complete. If blocked commit accurate checkpoint, keep checkbox open. Independent task review must assess evidence/spec and quality.

## Task 5: T057 synchronize final documentation

**Files:** context/architecture.md, progress-checker.md, active-feature.md, directly affected library-docs.md, verification.md and tasks.md. One owner after verification/census committed and reviewed.
**Consumes:** Verified Tasks1–4, merged PR370 status, capability census, final limitations.
**Produces:** Accurate documentation and separate T057 commit.

- [ ] Update implemented ownership, non-global core, neutral physical names, explicit wire/history boundaries, UTC budget/cache semantics, compensation/recovery safety from verified code.
- [ ] Qualify outdated current pending-phase/open-PR statements without deleting historical evidence. Distinguish final implementation/verification from final-slice integration pending merge; never claim merged new PR.
- [ ] Mark T057 only after doc requirements satisfied; no T055 checkbox if any required gate blocked. Record separate Standards/Spec counts only after review actually occurs.
- [ ] git diff --check; validate links and task/status consistency; commit 'docs(029): synchronize final supplier boundary status (T057)' with only owned files; independent task review follows.

## Task 6: Whole-feature convergence, code review and final CI

**Files:** scoped convergence report, independent review reports, final verification/context evidence as needed. Each agent one review/convergence task; no production writes.
**Consumes:** Whole Feature029 spec/plan/tasks/constitution and actual capability code, all Phase7 evidence.
**Produces:** Whole-feature convergence, separate Standards/Spec outcomes, appropriate PR and final-HEAD CI.

- [ ] Apply speckit-converge: prerequisites script -Json -RequireTasks -IncludeTasks; no before/after convergence hooks registered. Inventory all FR/SC/user-story acceptance, plan decisions and constitution principles. Inspect current code, not only final diff. Append-only tasks only for verified actionable gaps, then delegate TDD fix and recheck; otherwise tasks unchanged.
- [ ] Resolve baseline with git rev-parse eda88f0; prove nonempty git diff eda88f0...HEAD; capture git log eda88f0..HEAD --oneline and full diff package. Whole-feature evidence supplements slice delta.
- [ ] Run code-review independent Luna Max Standards and Spec agents in parallel. Standards sources AGENTS.md/context/code-standards.md/architecture and full Fowler smell baseline from .agents/skills/code-review/SKILL.md; explicit spec source bypasses unrelated issue-tracker setup. Reports under400 words each, separate counts/worst findings. Resolve blocking findings with one fix dispatch and scoped rereview.
- [ ] Write final pre-push evidence/status, commit, git push origin codex/029-duffel-provider-narrowing. Verify no open appropriate PR then gh pr create --base development --head codex/029-duffel-provider-narrowing --title 'Complete Feature029 final verification and boundary audit' --body-file exact temporary Markdown. Attach created PR.
- [ ] Use CI helper node .agents/skills/ci-feedback-loop/scripts/inspect-ci.mjs --head --watch. Bounded waits allow commentary within60 seconds. Require aggregate ci-status success on exact pushed HEAD; changed-source final gates required even if documentation paths route CI to skipped domains.
- [ ] Record final run URL/SHA and separate final source versus evidence-only commits. Any committed CI evidence update must itself be pushed and CI checked; avoid falsely claiming earlier run covers later HEAD. No auto merge. Final report exact status, task commits, reviews, CI and remaining merge approval.
