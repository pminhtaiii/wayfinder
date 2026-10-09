# Frontend–Backend Integration Decisions

Grilling session — 2026-07-05. Covers how the Next.js frontend connects to the NestJS backend and Python agent service.

---

## 1. API Client Architecture

**Decision:** Single server-side `apiClient` in `apps/web/lib/api-client.ts`. No client-side variant.

- Wraps `fetch()`, injects JWT from `getServerSession()`, handles errors, enforces typed contracts via `packages/shared`.
- No TanStack Query — the App Router Server Component model handles data loading server-side. No page in v1 needs background refetching, stale-while-revalidate, or optimistic updates. TanStack can be layered in later without restructuring.

---

## 2. Server Components + Server Actions — No Browser-to-NestJS Calls

**Decision:** Server Components fetch data via `apiClient` directly. Client Components trigger mutations through Server Actions (`"use server"`), which call the same `apiClient`. The browser never talks to NestJS.

- `NEXT_PUBLIC_API_URL` eliminated for NestJS calls → plain server-only `API_URL` env var.
- JWT never reaches the browser. Browser auth is the NextAuth httpOnly session cookie only.
- CORS to NestJS becomes a non-issue for the browser.
- Architecture invariant preserved: _"Frontend components contain no business logic or direct API calls to external services."_

---

## 3. SSE Chat — Proxied Through a Route Handler

**Decision:** The AI chatbot SSE stream is proxied through a Next.js Route Handler (`app/api/chat/stream/route.ts`), not connected directly from the browser.

- Route Handler holds the JWT server-side via `getServerSession()`, opens the upstream connection to the Python agent service, and pipes chunks back to the browser.
- Browser only needs a valid NextAuth session cookie (httpOnly) to hit the route handler.
- Token-never-leaves-server invariant holds without exceptions — including chat.

---

## 4. Error Handling — Three-Tier Model

**Decision:** Errors classified by response body shape, not status code range.

| Category                             | Trigger                                                              | Examples                                                               | Mechanism                                                                          |
| ------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Session expiry**                   | `401` status                                                         | Token expired, token revoked                                           | `apiClient` intercepts → redirect to `/login` before any result reaches the caller |
| **Expected business error**          | Response body has `{ code, message }` structure                      | `auth_locked`, `email_exists`, `validation_failed`, `booking_conflict` | Typed `ApiResult<T>` with `ok: false` — component pattern-matches on `error.code`  |
| **Exceptional / contract violation** | Body does **not** have `{ code, message }` shape, OR network failure | Malformed 400, network down, unrecognized error shape                  | Thrown error → Error Boundary                                                      |

Key insight: a well-formed 4xx with a recognized `code` is expected. A malformed 4xx with an unrecognized body is a contract bug — same severity as a 5xx.

```typescript
type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };
```

---

## 5. Token Refresh — Transparent with 7-Day Hard Cap

**Decision:** NextAuth `jwt` callback refreshes the JWT transparently. Hard session cap at 7 days.

| Concern               | Value                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JWT TTL               | 24 hours per token                                                                                                                                                                                     |
| Refresh trigger       | NextAuth `jwt` callback checks expiry on every request; refreshes when <2h remaining                                                                                                                   |
| Refresh mechanism     | New `POST /auth/refresh` on NestJS — accepts valid-but-near-expiry JWT, returns fresh 24h token                                                                                                        |
| Hard cap              | 7 days from original login. JWT payload carries `sessionStart` (set at login, preserved across refreshes). When `now - sessionStart > 7 days` → skip refresh, set error flag on token → force re-login |
| apiClient 401 handler | Safety net for revoked/truly-invalid tokens — should rarely fire under normal flow                                                                                                                     |

Implementation notes:

- `sessionStart` lives in the JWT payload itself (set by NestJS at login, carried through every refresh) so the NextAuth callback can check the 7-day cap without a database call.
- The `/auth/refresh` endpoint preserves `sessionStart` when minting a new token.

---

## 6. Retry Policy — GET Only, Fail Fast on Mutations

**Decision:** Retry transient failures on reads only. Mutations never retry.

| Concern          | Value                                                             |
| ---------------- | ----------------------------------------------------------------- |
| Retry scope      | `GET` requests only                                               |
| Retry conditions | Network errors (connection refused, timeout), 502/503/504         |
| Limits           | Max 2 retries, exponential backoff (200ms → 400ms), ~2s total cap |
| Mutations        | Fail fast, no retry — avoids duplicate bookings/payments          |

---

## 7. apiClient Interface — Generic Methods + Domain Modules

**Decision:** `apiClient` exposes generic HTTP methods (`get<T>`, `post<T>`). Domain-specific endpoint modules wrap `apiClient` with typed, discoverable functions.

Call chain:

```text
Server Component / Server Action
        ↓
Domain Module  (lib/api/flights.ts)
        ↓
apiClient.get<T>() / apiClient.post<T>()
        ↓
NestJS
```

- **`apiClient`**: auth, errors, retries, 401 redirect — never knows about flights or bookings. Stable, rarely changes.
- **Domain modules**: typed wrappers — autocomplete, discoverability, compile-time contracts from `packages/shared`.
- **Server Actions**: form/UI glue — the only thing Client Components import.

---

## 8. File Structure

```text
apps/web/
├── lib/
│   ├── api-client.ts          ← generic apiClient (one file, stable)
│   └── api/
│       ├── auth.ts            ← domain module: login, register, refresh, me
│       ├── flights.ts         ← domain module: searchFlights, getFlightDetails
│       ├── bookings.ts        ← domain module: createBooking, listBookings
│       └── profile.ts         ← domain module: getProfile, updateProfile
│
├── app/
│   ├── search/
│   │   ├── page.tsx           ← Server Component, calls domain module
│   │   └── actions.ts         ← "use server" Server Actions for search mutations
│   ├── bookings/
│   │   ├── page.tsx
│   │   └── actions.ts
│   └── api/
│       └── chat/
│           └── stream/
│               └── route.ts   ← Route Handler, SSE proxy
```

- Domain modules in `lib/api/` — importable from anywhere.
- Server Actions colocated with their page in `app/[feature]/actions.ts`.
- Route Handlers only for SSE proxy.
- `apiClient` is a single file that domain modules import; nothing else touches it directly.
