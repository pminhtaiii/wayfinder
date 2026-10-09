# Implementation Workflow

This document governs implementation of a user-authorized local Spec Kit feature. The user prepares and approves the feature design artifacts independently; implementation starts from those artifacts.

---

## Input Readiness

Before entering the implementation pipeline, confirm that the selected local feature has `spec.md`, `plan.md`, and `tasks.md`, and that they are consistent enough to execute safely. If an artifact is missing or a concrete inconsistency blocks implementation, report that gap and ask a targeted clarification. Do not rerun the planning pipeline by default. The planning skills remain available when the user explicitly requests them or when a specific artifact gap requires targeted work.

## Workflow Pipeline

```
build-spec (task graph and TDD) → speckit-converge (internal gate) → code-review (internal gate) → pr-feedback-loop (separately authorized)
```

```mermaid
flowchart LR
    A["build-spec\n(task graph + TDD)"] --> B["speckit-converge\n(internal gate)"]
    B --> C["code-review\n(internal gate)"]
    C --> D["pr-feedback-loop\n(separately authorized)"]
```

> **Pipeline Stages**: Local implementation through the task graph and TDD (`build-spec`) → integrated convergence (`speckit-converge`) → dual-axis code review (`code-review`) → PR / CI convergence (`pr-feedback-loop`, separately authorized).

For local Spec Kit features, `/build-spec` owns task execution and completes the convergence and review gates in Steps 2–3 against the integrated revision. After `/build-spec` reports success, do not repeat those gates on an unchanged revision. PR and CI work is Step 4 and requires separate authorization.

---

## Agent Coordination: Task Briefs, Handoffs, and Reviews

Keep `specs/<feature>/tasks.md` as the sole task-status ledger. Treat its first unchecked task as the resume candidate when the user's existing authorization covers that feature; the ledger tracks progress, does not expand authorized scope, and does not bypass the implementation gates in this document. Keep evidence in its canonical verification record instead of copying task-status tables into handoff prose.

During `/build-spec`, implementers leave task checkboxes unchanged. The merger marks a task `[X]` only after its work is integrated into the feature branch and its applicable checks pass.

### Session artifact dumps

For coordinated work, the coordinator creates one managed session folder keyed by the current chat ID with `pnpm agent:work start --session <id> [--date YYYY-MM-DD] [--root <checkout>]`. The default date uses Asia/Saigon. Reuse the recorded active folder when work resumes on another day; record its path in the handoff and give the same path to workers, who keep their files in their own subfolders. Store working design and execution-plan drafts, TDD diaries, raw logs, review notes, screenshots, and review snapshots there. Keep approved specs, task ledgers, ADRs, and concise verification records at their canonical project paths. Promote decisions worth carrying forward before finishing the session. Leave existing older artifacts in place.

The helper owns the `.agent-work/<date>/<id>/session.json` manifest and session lifecycle. `pnpm agent:work list [--root <checkout>]` shows known sessions; `pnpm agent:work finish --session <date>/<id> [--root <checkout>]` marks a session finished only after its work is complete, every worker has stopped writing, and the needed handoff is persisted. Keep the session active while its conversation is continuing or may resume. Do not infer completion from a process ending. Only a human may invoke `$agent-work-cleanup`; neither the agent nor another skill selects it. The CLI owns its runtime lock, and `.scratch/api-task.lock` is separate runtime coordination state; neither belongs in a session dump or cleanup target.

Use the `agent:work` helper only from the Booking Systems checkout. If the checkout or helper is unavailable, stop and report that condition instead of choosing another root or placing session files elsewhere.

### Dispatch a task

For feature work, give each implementer one or two original task IDs; for maintenance work, name the approved user goal instead of borrowing a feature ID. Link the plan and name its exact section when one exists; quote only the contract needed, not the full plan. Point to relevant exported interfaces, name owned source files and generated artifacts, identify prerequisite outputs for dependent work, and state observable behavior, focused commands, and acceptance criteria. Link the relevant `AGENTS.md` guardrail, `context/code-standards.md`, and `context/testing.md` sections instead of pasting their full rules. Preserve the approved design and TDD cycle; describe required behavior and contracts rather than prescribing production code before implementation.

Use the repository task commands to derive a handoff from the canonical ledger and plan:

```powershell
pnpm agent:context handoff --tasks specs/<feature>/tasks.md [--root <checkout>]
pnpm agent:context task --tasks specs/<feature>/tasks.md --task <task-id> [--plan specs/<feature>/plan.md] [--root <checkout>]
```

Replace `<task-id>` and the paths with the selected task and feature. The handoff command reports ledger counts and the first unchecked candidate; the task command supplies the selected task with plan context. Neither command changes task state.

### Record a live handoff

Use `collaboration.list_agents` for current worker IDs and states, and record when that observation was made. A `send_message` only notifies a worker; use `followup_task` to resume an idle or completed worker, then confirm its state. Do not report that a worker restarted based only on a sent message. Message a different user task only with explicit user authorization.

Keep one concise handoff with these fields:

```text
Checkout: <absolute root> | branch <name> | revision <hash> | dirty scope <owned paths>
Ledger: <canonical tasks.md> | next candidate <first unchecked ID>
Goal / next authorized step: <one sentence>
Blockers and gates: <passed command + exit status>; <failed>; <unrun + reason>
Ownership: <source paths> -> <generated outputs>; <prerequisites for dependent work>
Workers: <ID, observed state, observation time>
Evidence: <verification record, test logs, or other paths>
```

Refresh worker observations before acting on them. Preserve prior handoffs below the current one or in an archive; do not overwrite history or create a second task-status ledger.

### Pin and report a review

Declare the review's base and target revisions, or capture a file snapshot before review. Save the JSON emitted by `snapshot` and verify it against the same checkout before relying on findings:

```powershell
$snapshotDir = Join-Path $sessionPath 'reviews'
New-Item -ItemType Directory -Force $snapshotDir | Out-Null
$snapshotPath = Join-Path $snapshotDir 'agent-context-snapshot.json'
node scripts/ci/agent-context.mjs snapshot --files <repo-relative-path>... [--root <checkout>] | Set-Content -Encoding utf8 $snapshotPath
node scripts/ci/agent-context.mjs verify --snapshot $snapshotPath [--root <same-checkout>]
```

Set `$sessionPath` to the absolute active session path recorded in the handoff. The snapshot records schema version, checkout root, branch, HEAD, and SHA-256 for each declared file. Verification checks checkout identity and file bytes; HEAD or branch drift is reported separately when declared files remain unchanged. If a declared file changes or disappears, refresh the snapshot and review the changed scope. Recheck each finding against current source before acting on it.

Report the reviewed revision or source hashes, owned paths, focused commands with exit statuses, evidence paths, and remaining applicable gates with reasons. Keep worker reports compact; mention a commit only when one exists. Do not claim completion while an applicable gate remains unrun.

---

## Step 1: Implement with TDD (`/build-spec`)

**Purpose**: Implement the authorized local feature by executing `tasks.md` as a dependency graph with implementer workers and a serial merger.

`/build-spec` reuses the authorized feature branch as its integration branch, dispatches disjoint ready tasks to isolated worktrees, and records task completion only after merge and checks. It owns the convergence and code-review gates in Steps 2–3 on the integrated revision. Those sections define the gates; they are not extra runs after a successful `/build-spec` completion.

### TDD Vertical-Slice Cycle

Every task is executed as a RED → GREEN → REFACTOR loop. The agent does NOT write all tests first — it writes one test, implements, then writes the next test.

For each task:

```
1. RED    → Write a failing test for one behavior described in the task
           → Run the test → confirm it fails
2. GREEN  → Write the minimal code to make the test pass
           → Run all tests → confirm they all pass
3. RED    → Write the next failing test for the next behavior
           → Run the test → confirm it fails
4. GREEN  → Add code to pass the new test
           → Run all tests → confirm they all pass
5. Repeat → Until all behaviors for this task are covered
6. REFACTOR → Clean up the code while all tests remain green
           → Run all tests → confirm they still pass
7. DONE   → Hand the task branch to the merger → after integration and applicable checks, the merger marks [X] in tasks.md → recompute the ready frontier
```

### Test Types Required

For every feature, the agent must write:

| Test Type                | Scope                                                                                                | Always Required |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | --------------- |
| **Unit tests**           | Individual services, functions, utilities                                                            | ✅ Always       |
| **Integration tests**    | Controller endpoints, service-to-service interactions                                                | ✅ Always       |
| **Guard/boundary tests** | Constitutional invariants (AI never in booking path, budget checks before API calls, no PII in logs) | ✅ Always       |
| **E2E tests**            | Full system flows across multiple modules                                                            | ⚠️ Conditional  |

### E2E Test Triggers

E2E tests are required when the feature:

- **Touches the database** — any Prisma schema changes or new migrations.
- **Affects the booking or payment pipeline** — any change to the transactional critical path.
- **Impacts user-facing transactional flows** — anything that changes what the user experiences during search → book → pay → confirm.
- **Spans multiple modules** — changes that touch more than one NestJS module (e.g., flights + bookings + payments).
- **Changes system architecture** — new services, modified data flow, altered module boundaries.

If any of these conditions are met, the agent MUST write E2E tests before marking the feature complete.

> For E2E test runner setup, T093 script, Playwright integration guidelines, and the pre-PR validation gate matrix, see `context/testing.md`.

---

## Step 2: Converge (`/speckit-converge`, owned by `/build-spec`)

**Purpose**: Post-implementation gap analysis — verify the codebase satisfies the plan and tasks.

For a local Spec Kit feature, `/build-spec` runs this gate after current tasks are integrated. Run `/speckit-converge` separately when implementation happened outside `/build-spec` or when the integrated source changed after the recorded convergence.

The agent must:

1. Run `speckit-converge` to assess the implemented code against the plan and tasks.
2. If gaps are found: new tasks are appended to `tasks.md` under a Convergence phase.
3. Send appended tasks through `/build-spec`'s task graph and merger flow (still with TDD).
4. Run `/speckit-converge` again to verify gaps are closed.
5. Repeat until converged — no remaining actionable findings.

**Gate**: Convergence must report "✅ Converged" before the feature is considered complete.

After a clean convergence on the final integrated revision, do not repeat this gate unless that revision changes.

---

## Step 3: Dual-Axis Code Review (`/code-review`, owned by `/build-spec`)

**Purpose**: Independent two-axis code review running parallel sub-agents to verify that the implementation adheres to repository standards and faithfully fulfills the originating spec and plan with zero unrequested scope creep.

`/build-spec` runs this review once after convergence on a pinned integrated revision. Route blocking findings into the canonical task graph, merge and verify their fixes, then review the changed revision. Run `/code-review` separately when implementation happened outside `/build-spec`; do not repeat an unchanged review.

The agent must:

1. **Pin the fixed point**: Determine the diff baseline against the feature branch base / merge-base (`git diff <fixed-point>...HEAD`).
2. **Spawn parallel review sub-agents**:
   - **Standards Sub-Agent**: Checks against `context/code-standards.md`, architecture invariants, and Fowler smell baseline (Mysterious Name, Duplicated Code, Feature Envy, Speculative Generality, etc.). Reports hard violations and judgment calls.
   - **Spec Sub-Agent**: Cross-checks the diff directly against the feature specification and plan. Flags missing/partial requirements, behavioral deviations, and unauthorized scope creep.
3. **Aggregate and Resolve**:
   - Present both reports under `## Standards` and `## Spec` side-by-side without merging or masking findings.
   - Fix all blocking findings (P0/P1/critical issues) before final completion.

**Gate**: Zero blocking findings across both Standards and Spec axes before PR creation and feature completion.

---

## Step 4: PR / CI Verification & Convergence (`/pr-feedback-loop`)

**Purpose**: Verify remote GitHub Actions CI pipeline passes clean on the opened PR, triaging failures and applying fixes until green.

The agent must:

1. **Verify Local Gates**: Ensure the pre-PR local gate validation matrix passes (`context/testing.md`).
2. **Push & Inspect**: Open or update the PR branch and monitor CI execution using `node .agents/skills/pr-feedback-loop/scripts/inspect-ci.mjs --head --watch`.
3. **Harvest & Converge**: If any CI job or step fails, activate the `pr-feedback-loop` skill ([`pr-feedback-loop`](../.agents/skills/pr-feedback-loop/SKILL.md)) to harvest errors, remediate locally, push fixes, and verify remote convergence.
4. **Circuit Breaker**: Stop after 1 failed retry if the exact same issue persists, and ask the user for guidance.

**Gate**: Remote GitHub Actions CI reaches `Verdict: CI PASSED ✔` (`ci-status` conclusion is `success`) before merge.

---

## TDD Strict Rules

These rules are **non-negotiable**. Any agent that violates them is producing invalid work.

### Rule 1: Preserve Approved Behavioral Coverage

> Tests protect approved behavior and its unique coverage, not the literal contents of a test file.

When a test fails during implementation, first determine whether it reached the behavior under test. Agents must not make tests pass by:

- Removing or skipping unique behavioral coverage, including with `.skip`, `xit`, or `xdescribe`.
- Weakening or removing unique assertions, changing an expected behavior, or relaxing a timeout or safety contract.
- Changing expectations to match incorrect implementation output or dropping an edge case the implementation does not yet handle.

These changes alter a protected behavioral contract and require explicit user approval before editing. A valid RED fails because intended behavior is missing or incorrect, or because an explicitly identified capability is missing; it may surface as a missing module or export when that absence is the behavior under test. Unrelated collection, environment, harness, configuration, or fixture errors do not establish a behavioral RED and must be resolved before claiming the RED step is complete.

### Rule 2: Classify Test Changes and Record Evidence

Agents may maintain test fixtures and structure autonomously within the approved scope when approved behavior and unique coverage remain intact. This includes SQL seeding, import ordering, helper types, cleanup, removing exact redundant duplicates when the covered behavior remains represented, and strengthening assertions while retaining existing expectations.

For every test change, classify it as maintenance or a behavioral-contract change, record the reason, and provide focused regression evidence. Reviewers verify the classification, reason, and evidence. If the change would remove unique coverage, skip a test, change expected behavior, or relax a timeout or safety contract, stop and get explicit user approval before editing the test.

### Rule 3: Tests Describe Behavior, Not Implementation

Tests must verify behavior through public interfaces. A good test survives internal refactoring. The agent must follow the `tdd` skill's philosophy:

- Test what the system **does**, not how it does it.
- Use public APIs and interfaces — never test private methods.
- Mock only external boundaries (Amadeus API, Stripe, database) — never mock internal collaborators.
- If a test breaks during refactoring but behavior hasn't changed, classify and document any necessary test maintenance under Rule 2; seek approval only when the edit changes a protected behavioral contract under Rule 1.

### Rule 4: All Tests Must Pass Before Task Completion

The agent MUST NOT mark a task as `[X]` in `tasks.md` until:

- All tests for that task pass (GREEN).
- All previously passing tests still pass (no regressions).
- The refactor step is complete.

If any test fails, the task remains `[ ]` and the agent continues working on it.

---

## Windows Editing Policy

- Use the first-party `apply_patch` tool for focused changes.
- For necessary scripted PowerShell writes, use literal here-strings and avoid nested template interpolation.
- Keep edits small, inspect each diff, and run syntax or focused checks immediately for code changes.
- Use installed Prettier for whitespace and run the formatter before committing.

---

## Checkpoint Summary

| Step                    | Gate                                | Who Approves                 |
| ----------------------- | ----------------------------------- | ---------------------------- |
| 1. build-spec (TDD graph) | Every task integrated and checked    | Merger / task evidence          |
| 2. speckit-converge       | "✅ Converged" on final revision     | Build-spec gate                 |
| 3. code-review            | Zero blocking findings (both axes)   | Build-spec / Dual-Axis Sub-agents |
| 4. pr-feedback-loop       | Remote CI green (Verdict: CI PASSED) | Separately authorized           |
