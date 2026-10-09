---
name: coderabbit-feedback-loop
description: Batch-push and converge. Use when pushing code to GitHub in ~1000-line batches, harvesting CodeRabbit reviews, and fixing issues until every file scores ≥ 4/5.
---

Push code in **batches** (~1000 lines each), **harvest** CodeRabbit's review after each push, fix every issue raised, and repeat until the PR **converges** — every file scores ≥ 4/5 with zero unresolved comments.

## Steps

### 1. Inventory and batch

Soft-reset to the base branch tip so all local work becomes unstaged:

```bash
git reset --soft origin/main
```

Tally total changed lines (exclude lock files and generated output). Group files into **batches** of ≤ 1200 added/changed lines, ordered by dependency — foundational layers first (schemas, shared types, core services), then consumers (controllers, pages, tests), then docs.

Record the batch plan in a scratchpad artifact so later steps can reference it.

**Completion criterion**: every changed file is assigned to exactly one batch, each batch totals ≤ 1200 lines, and the first batch is staged and committed locally.

### 2. Push

```bash
git push origin <branch> --force-with-lease
```

If no PR exists yet, create one via `gh pr create` or the GitHub UI — base branch `main`, descriptive title, body summarising the batch contents.

**Completion criterion**: the remote ref matches the local HEAD, and an open PR exists targeting the base branch.

### 3. Harvest

Wait for CodeRabbit to finish its review, put timeout for 10 minutes. Poll the PR's review comments endpoint — see [retrieval-methods.md](retrieval-methods.md) for the exact API calls and browser-fallback steps.

Extract every CodeRabbit comment into a structured list:

| File | Lines | Category | Comment text | Severity |
|------|-------|----------|-------------|----------|

**Completion criterion**: every CodeRabbit comment for the current batch is captured with file path, line range, category, full text, and severity. Zero comments missed — cross-check the count against CodeRabbit's reported total.

### 4. Remediate

For each harvested comment:

1. Assess against project standards — skip only if the suggestion contradicts an explicit project rule (log the skip with rationale).
2. Implement the fix locally.
3. Run verification gate: `pnpm lint && pnpm build && pnpm test`.
4. Commit the fix with a message referencing the CodeRabbit comment.

Push fixes and re-harvest. This is a **convergence loop** — repeat steps 3–4 until:

- CodeRabbit reports **zero new comments** on the batch, **and**
- every file in the batch scores **≥ 4/5**.

If the same issue recurs after one fix attempt, stop and surface it to the user.

**Completion criterion**: re-harvest returns zero unresolved comments, every file scores ≥ 4/5, and the verification gate passes clean.

### 5. Next batch

Stage and commit the next batch from the inventory. Return to step 2.

**Completion criterion**: all batches from the inventory are pushed, harvested, and converged. The PR contains the full change set with zero open CodeRabbit comments and all file scores ≥ 4/5.
