---
description: Instructions for building the Flight Booking System
globs: *
alwaysApply: true
---

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## Context Pointers

Never read all context files at once. Selectively read only the document required for the active task:

| Task / Intent | Document to Read |
| --- | --- |
| In-flight feature checkpoints & immediate tasks | `context/active-feature.md` |
| Master milestone progress & completed features | `context/progress-checker.md` |
| System topology, module boundaries & ports | `context/architecture.md` |
| Linting, conventions, naming & code guidelines | `context/code-standards.md` |
| Third-party libraries & vendor configurations | `context/library-docs.md` |
| High-level system overview & business concepts | `context/project-overview.md` |
| TDD development workflow & lifecycle phases | `context/workflow.md` |
| Testing, E2E runners & pre-PR validation gates | `context/testing.md` |

When dispatching, handing off, or reviewing agent work, follow **Agent coordination** in `context/workflow.md`; use `agent:context` for checkout-aware task, handoff, and source-snapshot commands.

## Core Invariants

- **Sub-Agent Delegation**: Always use subagents for code implementation and code reviews to avoid context rot.
- **Styling Rules**: Never use hardcoded hex values or raw Tailwind color classes. Always use semantic design tokens.
- **Third-Party Libraries**: Load the library's installed skill first, then consult `context/library-docs.md` for repo-specific rules.
- **Documentation Sync**: Update all relevant files in `context/` (e.g. `context/active-feature.md`, `context/architecture.md`) after completing any feature or slice.
- **Fail-Fast on Repeated Failure**: If the same problem persists after one corrective prompt, stop immediately, explain the blockage, and ask the user for guidance.
- **Parallel Work Ownership**: When coordinating parallel work, track generated artifacts alongside source files and generate or build prerequisites before dependent test workers start.

## Subagent Implementer Guardrails

When dispatching an implementer subagent, enforce these standards in the task prompt:
1. **No `any` or Type Casts**: Use `unknown` and narrow values with runtime guards. Never use `any` or cast values with `as SomeType`, `<SomeType>value`, or double assertions. `as const` may preserve literal inference without bypassing type checks.
2. **Clean Lint**: No unused imports or variables. Run the applicable package lint from `context/testing.md`.
3. **Ports & Adapters**: Depend only on exported port interfaces (e.g. `FLIGHT_SEARCH_PORT`), never internal vendor SDKs or implementations directly.
4. **Constructor Injection**: Inject dependencies via NestJS constructor injection; never instantiate services with `new`.
5. **Verify Before Returning**: Use the applicable checks in `context/testing.md`. Report each check with its actual command and exit status, mark it passed or failed, and list applicable unrun checks with the reason. A focused pass does not complete the task while applicable gates remain.

## Windows & Environment Rules

- **PowerShell Syntax**: The shell is Windows PowerShell. Use `;` or separate command calls, never bash `&&` chains.
- **Path Formatting**: Always use native Windows backslashes or valid absolute paths (`C:\Booking Systems\...`) when calling file tools.
- **Background Tasks**: Never poll `manage_task status` in a loop; wait for the system's reactive background task notification.
- **Windows Editing**: Follow the [Windows Editing Policy](context/workflow.md#windows-editing-policy).

## Local Development Startup

To run the full stack locally (Next.js frontend, NestJS backend, and Python agent service):

1. **Docker Services**: Ensure Docker Desktop is active, then start PostgreSQL and Redis:
   ```bash
   docker compose up -d
   ```
2. **Database Setup**: Run migrations and seeding from the workspace root (or using local `prisma` package in `apps/api`):
   ```bash
   pnpm --filter @api/backend exec prisma migrate dev
   pnpm --filter @api/backend exec prisma db seed
   ```
3. **Shared Secrets (.env)**: Ensure both `apps/api/.env` and `apps/agent/.env` contain matching secret configuration variables:
   - `JWT_SECRET` (NextAuth token generation)
   - `AGENT_SERVICE_API_KEY` (Gateway protection)
   - `CLAIM_TOKEN_SECRET` (Agent user claim verification)
4. **Execution**: Start the development servers:
   - **Full Stack (Frontend & Backend concurrently)**: `pnpm dev`
   - **Next.js Frontend only (Port 3000)**: `pnpm --filter @web/frontend dev`
   - **NestJS Backend only (Port 3001)**: `pnpm --filter @api/backend dev`
   - **Python Agent only (Port 3002)**: `uv run uvicorn agent.main:app --port 3002 --app-dir src` inside `apps/agent/`

<!-- SPECKIT START -->
For additional context about technologies, project structure, shell commands,
and other important information, read the current plan at
specs/030-fulfillment-recovery-acceptance/plan.md.
<!-- SPECKIT END -->
