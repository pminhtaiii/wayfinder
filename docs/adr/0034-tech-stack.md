# Flight Booking System — Tech Stack Decisions

> Captured from grilling session on 2026-06-23.

---

## 1. Backend: Node.js + NestJS (TypeScript)

- **Language**: TypeScript (end-to-end, shared with frontend).
- **Framework**: NestJS — opinionated, modular architecture with dependency injection, guards, interceptors.
- **Rationale**: Same language across the full stack enables shared types. NestJS provides structured patterns for observability, input validation, and audit logging. First-class Amadeus SDK support via npm.

## 2. Database: PostgreSQL

- **Engine**: PostgreSQL — relational, ACID-compliant.
- **Use case**: User accounts, booking records, PNR references, payment transaction logs, audit trails, passenger details.
- **Rationale**: Booking data is highly relational (bookings → passengers → flights → payments). Referential integrity enforced at the database layer. `jsonb` support for storing raw Amadeus API responses without needing a separate document store.

## 3. AI Agent Data Access: Sanitized Read-Only API Gateway

- **Rule**: AI agents NEVER get a direct database connection. No SQL access.
- **Pattern**: A purpose-built internal API sits between AI agents and the database:
  - Exposes only anonymized, non-PII data points (e.g., preferred routes, cabin class preferences).
  - Strips/redacts PII before returning results.
  - Enforces rate limiting and audit logging on every call.
  - Uses scoped API keys per agent type (principle of least privilege).
- **Rationale**: Sensitive user data (email, passport, payment info) must never be accessible to non-deterministic AI agents. Aligns with the Deterministic Transaction Boundary constitutional principle.

## 4. Frontend: Next.js (React + TypeScript)

- **Framework**: Next.js with App Router and Server Components.
- **Rationale**: TypeScript end-to-end with shared types from the NestJS backend. SSR for SEO (destination pages indexable by search engines). Server Components keep API keys off the browser. Massive React ecosystem for UI components, forms, and state management.

## 5. Authentication: NextAuth.js (Email/Password Only for v1)

- **Library**: NextAuth.js (Auth.js) with JWT tokens.
- **v1 scope**: Email and password only — social login (Google, Facebook, Apple) deferred to a later milestone.
- **Rationale**: Minimizes complexity for v1. NextAuth makes it trivial to add social providers later without refactoring session or JWT logic. JWT tokens are stateless, allowing the NestJS backend and AI Sanitized API to validate tokens independently.
- **Deferred**: Social login providers (Google, Facebook, Apple) — no architectural debt from this deferral.

## 6. Caching & Rate Limiting: Redis

- **Engine**: Redis — in-memory key-value store.
- **Use cases**:
  - **Search result caching** (TTL-based, 15–30 min) — constitutional requirement under API Budget Discipline.
  - **Rate limiting** — app-layer enforcement before Amadeus API calls.
  - **API budget counters** — atomic `INCR` to track monthly call usage with alerts at 50%/75%/90%.
- **Rationale**: Sub-millisecond reads for cached results. Prevents duplicate Amadeus API calls within the 2,000/month free tier. Team has prior experience with the PostgreSQL + Redis combination.

## 7. Deployment: Deferred

- **Status**: Not decided — deferred to a later milestone.
- **Rationale**: Focus on building a working, testable system first. Security hardening will be addressed before deployment. Aligns with Incremental Delivery principle.

## 8. Code Review: CodeRabbit

- **Tool**: CodeRabbit — automated AI code review on every PR.
- **Purpose**: Catches security issues, code quality problems, and potential bugs to ensure the codebase is deployable at any time with no critical issues remaining.

## 9. AI/LLM Integration: Mimo + LangChain.js + LangSmith

- **Model**: Mimo (accessed via OpenAI-compatible API URL).
- **Framework**: LangChain.js — agent chains, tool calling, conversation memory. Provider-agnostic (easy model swap).
- **Observability**: LangSmith — full trace of every agent run (tool calls, inputs/outputs, execution order). Extends the constitutional Observability principle into the AI layer.
- **Rationale**: LangChain.js stays in the TypeScript ecosystem (no Python microservice). Mimo's OpenAI-compatible API means standard `ChatOpenAI` client works with a custom base URL.

## 10. ORM: Prisma

- **Library**: Prisma ORM.
- **Features used**: Type-safe generated client, declarative `schema.prisma`, automatic SQL migrations, raw SQL escape hatch.
- **Rationale**: Compile-time type safety for all database queries. Migration files are version-controlled and auditable. Clean NestJS integration via injectable service.

## 11. Payment Processor: Stripe

- **Provider**: Stripe — Payment Intents API + Stripe Elements (frontend).
- **PCI-DSS**: Handled entirely by Stripe. Application code never touches raw card numbers.
- **Fee structure**: No monthly fee. 2.9% + $0.30 per successful transaction.
- **Features**: Multi-currency, full sandbox/test mode, webhook-driven events for audit logging, refund handling.
- **Rationale**: Industry-standard developer experience. Webhook events map directly to audit logging requirements.

---

## Cost Summary

| Component                                                                                 | Cost for v1                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| NestJS, Next.js, TypeScript, PostgreSQL, Redis, Prisma, NextAuth.js, LangChain.js, Docker | **$0** (all open source)                                     |
| Amadeus API                                                                               | **$0** (free tier: 2,000 calls/month)                        |
| LangSmith                                                                                 | **$0** (free tier: 5,000 traces/month)                       |
| Mimo                                                                                      | **Usage-based** (per-token pricing)                          |
| Stripe                                                                                    | **2.9% + $0.30 per transaction** (no upfront cost)           |
| CodeRabbit                                                                                | **$0** (open-source repos) / ~$12/seat/month (private repos) |

**Bottom line**: The entire core stack can be built and tested at effectively $0. Variable costs scale only with real user activity.

---

## Open Questions (Still Unresolved)

- **Search UX**: Filters (stops, airlines, price range), sorting, pagination.
- **Multi-currency / multi-language** support.
- **Testing framework**: Jest, Vitest, or other.
- **Monorepo structure**: Turborepo, Nx, or separate repos.
- **Email/notification service**: For booking confirmations, password resets.
