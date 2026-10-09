# Flight Search Service — Architectural Decisions

> Compiled from grilling session on 2026-07-07.
> All decisions below were explicitly approved by the user.
> **Updated 2026-07-07: Migrated from Amadeus to Duffel API** — Amadeus Self-Service is no longer available for non-enterprise developers.

---

## Core Principle

**The flight search pipeline is fully deterministic. No AI agents touch any part of this system — search, caching, pricing, or persistence. This boundary is non-negotiable.**

---

## Decision Summary

| #   | Decision               | Choice                                                                                                                                                   |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Module structure       | Extract flight provider into its own shared module (`DuffelModule`); both `FlightsModule` and `AgentGatewayModule` import from it                        |
| D2  | Round-trip support     | Supported from day one via multi-slice `offer_request` (Duffel native concept)                                                                           |
| D3  | Persistence strategy   | Hybrid — Redis for hot lookup, PostgreSQL write-behind for durability                                                                                    |
| D4  | Write-behind latency   | Non-blocking — response returns immediately after Redis write; PostgreSQL write is async post-response                                                   |
| D5  | Re-price trigger       | On flight detail / booking page load, NOT at final confirm click                                                                                         |
| D6  | Table design           | Two tables: `flight_offers` (raw blob, hard-purge) + `search_history` (lightweight metadata, kept forever)                                               |
| D7  | Table write timing     | Both tables written simultaneously during the async write-behind step                                                                                    |
| D8  | Budget management      | Single shared Redis counter with configurable priority thresholds (env vars, not hardcoded); user-facing search gets higher cap, agent throttled earlier |
| D9  | Cache layer            | Cache raw Duffel offer response inside the shared `DuffelService`; consumers transform independently into their own DTOs                                 |
| D10 | Flight detail URL      | Internal UUID from `flight_offers` table as `flightId` — never expose Duffel offer IDs                                                                   |
| D11 | Expired offer recovery | 410 Gone with search params from `search_history`; frontend shows guided recovery with pre-filled search form; no auto-re-execute                        |
| D12 | API provider switch    | Duffel API replaces Amadeus — simpler auth (Bearer token), richer data model (slices/segments), pay-as-you-go with 1500:1 search-to-book ratio           |

---

## Duffel API Key Differences from Amadeus

| Aspect              | Amadeus (old)                             | Duffel (new)                                                          |
| ------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| **Auth**            | OAuth2 client_credentials (token refresh) | Static Bearer token (no refresh needed)                               |
| **Search endpoint** | `GET /v2/shopping/flight-offers`          | `POST /air/offer_requests`                                            |
| **Round-trip**      | `returnDate` query param                  | Multi-slice array (outbound + return slices)                          |
| **Data model**      | Itineraries → Segments                    | Slices → Segments (richer, includes operating/marketing carrier)      |
| **Re-price**        | `POST /v1/shopping/flight-offers/pricing` | `GET /air/offers/{id}` (offers have built-in expiry and live pricing) |
| **Rate limits**     | 2,000 calls/month free tier (hard cap)    | 120 requests/60s rate limit; 1500:1 search-to-book ratio              |
| **SDK**             | Raw HTTP (no official TS SDK)             | `@duffel/api` official TypeScript SDK                                 |
| **Sandbox**         | Test environment with limited routes      | "Duffel Airways" test airline with consistent test data               |

---

## Implementation Phases

### Phase 1: DuffelService & Shared Module

> **Focus area.** This is the foundational refactor — everything else depends on it.

- [ ] Create new `apps/api/src/duffel/` module directory
  - `duffel.module.ts` — NestJS module that exports `DuffelService`
  - `duffel.service.ts` — new service wrapping `@duffel/api` SDK with caching + budget
  - `duffel.types.ts` — TypeScript interfaces for raw Duffel offer responses
- [ ] Install `@duffel/api` SDK: `pnpm add @duffel/api --filter @api/backend`
- [ ] Implement `DuffelService`
  - Constructor initializes Duffel SDK client with `DUFFEL_ACCESS_TOKEN`
  - `searchFlights()` method: creates an `offer_request` with slices (one-way = 1 slice, round-trip = 2 slices)
  - Accepts `caller: 'user' | 'agent'` parameter for budget priority
- [ ] Move caching logic INTO `DuffelService`
  - Cache the **raw** Duffel `OfferRequest` response in Redis
  - Cache key: SHA-256 of normalized query (origin, destination, departureDate, returnDate, passengers)
  - TTL: 900 seconds (15 minutes)
- [ ] Move budget checking INTO `DuffelService`
  - Single shared counter: `budget:duffel:YYYY-MM`
  - Configurable thresholds via environment variables:
    - `DUFFEL_BUDGET_LIMIT_USER` (default: 1800) — user-facing search cap
    - `DUFFEL_BUDGET_LIMIT_AGENT` (default: 1200) — agent/chatbot cap
    - `DUFFEL_BUDGET_LIMIT_TOTAL` (default: 2000) — absolute monthly cap
  - Priority logic: agent gets throttled at its lower threshold; user-facing search continues until the higher threshold; both hard-stop at the total cap
- [ ] Update `AgentGatewayModule` to import `DuffelModule` instead of its own `AmadeusService`
- [ ] Refactor `AgentGatewayService.searchFlights()` to call `DuffelService.searchFlights()` and transform the raw response into `FlightResultDto` (5 results, simplified) as before
- [ ] Remove `apps/api/src/agent-gateway/amadeus/` directory entirely
- [ ] Update `apps/api/src/app.module.ts` to import `DuffelModule`
- [ ] Verify all existing agent-gateway E2E tests still pass

---

### Phase 2: Database Schema — `flight_offers` & `search_history`

- [ ] Create Prisma model `FlightOffer`
  - `id` — UUID, primary key
  - `searchHash` — SHA-256 of the search query (links to the cache key)
  - `duffelOfferId` — the Duffel-assigned offer ID within its response
  - `rawOffer` — JSON blob storing the full Duffel offer object
  - `origin` — IATA code
  - `destination` — IATA code
  - `departureDate` — date
  - `returnDate` — date (nullable, for one-way flights)
  - `passengers` — integer
  - `price` — decimal
  - `currency` — string
  - `createdAt` — timestamp
  - Indexes: `searchHash`, `createdAt` (for cron cleanup)
- [ ] Create Prisma model `SearchHistory`
  - `id` — UUID, primary key
  - `userId` — foreign key to User
  - `origin` — IATA code
  - `destination` — IATA code
  - `departureDate` — date
  - `returnDate` — date (nullable)
  - `passengers` — integer
  - `resultCount` — how many offers were returned
  - `minPrice` — lowest price in results
  - `maxPrice` — highest price in results
  - `currency` — string
  - `searchHash` — SHA-256 linking to the cached/stored offers
  - `createdAt` — timestamp
  - Index: `userId`, `createdAt`, composite `[userId, createdAt]`
- [ ] Run `npx prisma migrate dev` to generate and apply migration
- [ ] Implement cron job for `flight_offers` cleanup
  - Configurable retention window via `FLIGHT_OFFERS_RETENTION_DAYS` env var (default: 7)
  - `DELETE FROM flight_offers WHERE created_at < NOW() - INTERVAL 'N days'`
  - Schedule: daily (off-peak hours)

---

### Phase 3: FlightsModule — Deterministic Search Endpoint

- [ ] Create `apps/api/src/flights/` module directory
  - `flights.module.ts` — imports `DuffelModule`, `PrismaModule`, `CacheModule`
  - `flights.controller.ts` — `POST /api/flights/search`
  - `flights.service.ts` — orchestrates search, transformation, and persistence
  - DTOs: `FlightSearchRequestDto`, `FlightSearchResponseDto`, `FlightOfferDto`
- [ ] `FlightsController`
  - `POST /api/flights/search` — JWT-protected
  - Validates request body via class-validator
  - Returns transformed flight offers with pagination metadata
- [ ] `FlightsService.searchFlights()`
  - Calls `DuffelService.searchFlights()` with `caller: 'user'`
  - Transforms raw Duffel offer response into rich user-facing DTOs
  - Returns up to 20 results (vs agent-gateway's 5)
  - Includes: airline name, flight number, full segment details, duration, stops, price, currency, fare class, baggage allowance, **internal UUID** (from `flight_offers` table)
  - **Async write-behind**: after returning the response, fire-and-forget writes to both `flight_offers` and `search_history` tables simultaneously
- [ ] Register `FlightsModule` in `app.module.ts`
- [ ] Write E2E tests for the search endpoint

---

### Phase 4: Flight Detail & Re-price Endpoint

- [ ] `FlightsController`
  - `GET /api/flights/:id` — JWT-protected
  - `:id` is the internal UUID from `flight_offers`
- [ ] `FlightsService.getFlightDetail()`
  - Lookup chain: Redis (by searchHash + duffelOfferId) → PostgreSQL `flight_offers` table
  - If found: call Duffel `GET /air/offers/{duffel_offer_id}` to get live re-confirmed price
  - Return enriched detail view with confirmed pricing
  - If NOT found (both Redis and PostgreSQL miss):
    - Query `search_history` for the original search parameters
    - Return **410 Gone** with the original search params (origin, destination, dates, passengers)
- [ ] Frontend handles 410 response:
  - Shows "Offer expired" notice
  - Pre-fills search form with recovered parameters
  - User clicks Search to get fresh results — no auto-re-execute

---

### Phase 5: Frontend Integration

- [ ] Wire the existing search form's "Search Flights" button to `POST /api/flights/search`
  - Origin, destination, departure date, return date (toggle), passengers
  - Loading state during API call
- [ ] Render flight results list below the search form
  - Each result row: airline, flight number, times, duration, stops, price, fare class, baggage
  - "View Details" navigates to `/search/[flightId]` using internal UUID
  - "Book" action (placeholder for future booking feature)
- [ ] Flight detail page (`/search/[flightId]`)
  - Calls `GET /api/flights/:id`
  - Shows full segment breakdown, confirmed price, fare details
  - Handles 410 expired offer with guided recovery UX
- [ ] Round-trip toggle in search form
  - One-way: single date picker
  - Round-trip: departure + return date pickers

---

### Phase 6: E2E Testing & Verification

- [ ] Backend E2E tests
  - `POST /api/flights/search` — valid search, missing fields, budget exceeded
  - `GET /api/flights/:id` — valid offer, expired offer (410), not-found
  - Cache hit verification — same query returns cached results without API call
  - Budget counter increment verification
  - Async write-behind verification — `flight_offers` and `search_history` rows created
- [ ] Verify agent-gateway still works end-to-end
  - Chatbot's `search_flights` tool calls the same `DuffelService`
  - Budget counter shared correctly
  - Agent gets throttled at its lower threshold
- [ ] Frontend smoke tests
  - Search form submission → results rendered
  - Click "View Details" → detail page loads with confirmed price
  - Expired offer → recovery UX shown

---

## Environment Variables (Updated)

| Variable                       | Default | Purpose                                                                     |
| ------------------------------ | ------- | --------------------------------------------------------------------------- |
| `DUFFEL_ACCESS_TOKEN`          | —       | Duffel API access token (replaces `AMADEUS_API_KEY` + `AMADEUS_API_SECRET`) |
| `DUFFEL_BUDGET_LIMIT_USER`     | 1800    | User-facing search throttle threshold                                       |
| `DUFFEL_BUDGET_LIMIT_AGENT`    | 1200    | Agent/chatbot throttle threshold                                            |
| `DUFFEL_BUDGET_LIMIT_TOTAL`    | 2000    | Absolute monthly cap (hard stop for all callers)                            |
| `FLIGHT_OFFERS_RETENTION_DAYS` | 7       | Days before cron purges `flight_offers` rows                                |

---

## Architecture Invariants (Reinforced)

1. **AI agents NEVER call `FlightsService` or `FlightsController` directly.** Agent data access goes through the agent-gateway only.
2. **`DuffelService` is the single point of contact with the Duffel API.** No other service makes direct HTTP calls to Duffel.
3. **`DuffelService` owns the cache and budget.** No consumer manages its own Duffel caching or budget tracking.
4. **The frontend never sees Duffel offer IDs.** All URLs and API contracts use our internal UUIDs.
5. **The re-price call happens on detail page load, not at booking confirm.** Users see the real price before entering payment details.
