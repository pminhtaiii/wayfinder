# Grilling Session — Unify Server Transport into a Backend Client

> Captured from grilling session on 2026-09-24.
> Source: architecture-review-2026-09-13.html (Candidate #7: Unify server transport into a backend client).

---

## Context

`flight-search.ts` (510 lines), `booking-management.ts` (1,268 lines), and `dashboard.ts` (103 lines) each independently re-implement `apiUrl()`, `getAccessToken()`, `fetchWithRetry()`, `AbortController` timeout, and HTTP-to-outcome error mapping. Dashboard lacks retry logic entirely — a resilience gap. Six route handlers in `apps/web/app/api/booking-management/` duplicate a verbatim 25-line `mapOutcomeToResponse()`.

After completing Candidates 1–6 (Payment deepening, BookingAgentProjection relocation, Booking umbrella deletion, agent-chat extraction, guardrail registry collapse, ChatTurnRunner decomposition), this is the next refactor target.

---

## Decision 1 — Scope: core three only ✅

**Problem**: Duplication extends into `profile.ts`, `checkout.ts`, and `handoffCheckoutProxy.ts`. Should we unify all?

**Decision**: Core three only — `flight-search.ts`, `booking-management.ts`, `dashboard.ts`. The outliers have different auth/request patterns and overlap with Candidate 8's handoff consolidation scope. Extract and prove the interface first; outliers adopt it during their own refactors.

---

## Decision 2 — Return type: TransportResult\<T\> with Zod validation ✅

**Problem**: Should the client return raw `Response`, parsed `TransportResult<T>`, or domain `Outcome<T>`?

**Considered options**:

1. **Raw Response** — caller does JSON parsing + error mapping. Leaves too much duplication.
2. **TransportResult\<T\>** — client handles URL, auth, timeout, retry, JSON parsing, Zod validation.
3. **Outcome\<T\>** — client owns full pipeline including status → domain reason. Over-couples transport to domain.

**Decision**: Option 2. Zod validates at the **external trust boundary** (NestJS API → our system). Since `backend-client.ts` is an internal service we control, callers trust `data: T` without re-validation. The client never interprets what an HTTP status *means* in a specific domain.

---

## Decision 3 — Retry policy: idempotent GETs + transient failures only ✅

**Problem**: Current retry policy (`status >= 500`) is too broad. Dashboard has no retry at all.

**Decision**: Retry ON by default for idempotent GETs, scoped to transient failures:

| Condition | Retry? |
|---|---|
| GET + network error / timeout | ✅ Transient |
| GET + 502, 503, 504 | ✅ Transient gateway |
| GET + 429 with `Retry-After` | ✅ Respect header |
| GET + 400, 401, 403, 404, 409, 422, 500 | ❌ Deterministic |
| POST/PUT/PATCH/DELETE + anything | ❌ No idempotency key |

3 attempts max, exponential backoff from 100ms. Dashboard gains resilience automatically.

---

## Decision 4 — Error path: two-kind union, internal cause preserved ✅

**Problem**: Timeouts, network errors, and parse failures have no HTTP status. How do callers distinguish them from HTTP errors?

**Decision**: Two-kind discriminated union externally; full cause preserved internally for observability.

```typescript
type TransportResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'http'; status: number; body?: unknown }
  | { ok: false; kind: 'transport'; cause?: string }
```

Internally the client logs the actual cause (timeout, DNS, connection refused, invalid JSON, Zod validation failure) before collapsing to `kind: 'transport'`. Callers see a simple split; operators see the real cause in logs.

---

## Decision 5 — Auth: configurable token provider, not hard-coupled to NextAuth ✅

**Problem**: All three modules call `getAccessToken()` backed by NextAuth. Should the client call NextAuth directly?

**Decision**: Inject a token provider at factory creation. Authenticated by default, not permanently bound to NextAuth.

```typescript
type TokenProvider = () => Promise<string | null>;

function createBackendClient(config?: {
  tokenProvider?: TokenProvider;
  baseUrl?: string;
}): {
  request: <T>(path: string, schema: ZodType<T>, opts?: RequestOpts) => Promise<TransportResult<T>>;
};

// Pre-configured default instance (NextAuth + env-based URL)
export const backendClient = createBackendClient();
```

Future consumers (Candidate 8 outliers, service-to-service calls) create a client with a different token provider without forking.

---

## Decision 6 — outcome-response: booking-specific, route adapter layer ✅

**Problem**: `mapOutcomeToResponse` only handles `BookingManagementOutcome`. Should it be generic?

**Decision**: Booking-specific. Only booking-management has route handlers today. Generalize when another domain needs it. Classified as a **route adapter** (domain → HTTP), not transport infrastructure.

---

## Decision 7 — Type location: inline in backend-client.ts ✅

**Problem**: `TransportResult<T>` and `RequestOpts` are consumed by client and domain modules. Separate file?

**Decision**: Inline in `backend-client.ts`. Extract `transport-types.ts` later if types are consumed independently of the client.

---

## Decision 8 — Shared outcome reasons: duplicated per domain ✅

**Problem**: `UNAUTHENTICATED`, `FORBIDDEN`, `UPSTREAM_UNAVAILABLE` appear in all three outcome types. Extract a shared base?

**Decision**: Keep duplicated. A few string literals don't justify cross-domain coupling. Each domain module owns its complete outcome vocabulary.

---

## Post-Refactor Structure

```
apps/web/lib/server/
├── backend-client.ts              (NEW — ~130 lines)
│   └── createBackendClient, backendClient, TransportResult<T>, RequestOpts
├── outcome-response.ts            (NEW — ~30 lines)
│   └── mapOutcomeToResponse (booking-specific route adapter)
├── flight-search.ts               (SHRINKS 510 → ~200 lines)
├── booking-management.ts          (SHRINKS 1,268 → ~550 lines)
├── dashboard.ts                   (SHRINKS 103 → ~40 lines, GAINS retries)
└── *.spec.ts                      (UPDATED — mock backendClient.request)
```

## Post-Refactor Dependency Graph

```
backendClient (deep transport module)
├── resolveBaseUrl() → process.env
├── tokenProvider() → NextAuth (default) or injected
├── retryWithBackoff() → global fetch
│   └── retries: GET + transient (network/timeout/502/503/504/429)
│   └── no retry: deterministic (4xx/500) or mutations
├── timeout → AbortController (10s)
└── Zod schema.safeParse() → TransportResult<T>

flight-search.ts (domain only, ~200 lines)
├── → backendClient.request() (transport)
├── → Zod schemas (FlightSearchResponseSchema, OfferDetailSchema)
└── → statusToFlightOutcome() (status → INVALID_SEARCH / OFFER_EXPIRED / etc.)

booking-management.ts (domain only, ~550 lines)
├── → backendClient.request() (transport)
├── → Zod schemas (BookingListSchema, BookingDetailSchema, etc.)
└── → statusToBookingOutcome() (status → NOT_FOUND / STALE_REVISION / etc.)

dashboard.ts (domain only, ~40 lines, GAINS retry resilience)
├── → backendClient.request() (transport)
├── → Zod schema (DashboardSummarySchema)
└── → statusToDashboardOutcome() (status → INVALID_RESPONSE / etc.)

outcome-response.ts (route adapter, booking-specific)
└── mapOutcomeToResponse() (BookingManagementOutcome → NextResponse)

6 route handlers (~15-25 lines each)
├── → booking-management.ts (domain functions)
└── → outcome-response.ts (response mapping)
```

**Dependency direction**: All arrows point toward infrastructure. No cycles. Domain depends on transport; route handlers depend on domain + adapter. Transport depends on nothing in the application.

---

## Extraction Sequence

| Step | Extract | Rationale |
|---|---|---|
| 1 | `backend-client.ts` + tests | Factory, retry, timeout, token provider — validated in isolation |
| 2 | Migrate `dashboard.ts` (smallest) | Fastest validation; gains retries automatically |
| 3 | Migrate `flight-search.ts` | Confirms POST + GET patterns work |
| 4 | Migrate `booking-management.ts` | Largest file, 7 endpoints — full coverage |
| 5 | Extract `outcome-response.ts` + update 6 route handlers | Mechanical dedup, 150 lines removed |
| 6 | Delete orphaned utilities from all three modules | Dead code cleanup |

Each step leaves the system working. Steps 2–4 can be reordered; smallest-first gives fastest feedback.

---

## What Does NOT Change

- **API endpoints**: No changes to HTTP routes, request/response shapes, or error codes.
- **Domain outcome types**: Same reason vocabularies, same payload types.
- **Auth behavior**: Same NextAuth session extraction, same "no token → UNAUTHENTICATED."
- **Timeout**: Same 10s AbortController across all consumers.
- **Zod schemas**: Same validation, same response shapes.
- **Server Component consumption**: Pages see the same outcome types.
- **Security guarantees**: Auth ordering, token validation unchanged.
