# Flight Booking System — Architecture Decisions

> Captured from grilling session on 2026-06-22.

---

## 1. Target Audience

- **B2C platform** targeting tourists and business travelers.
- Users search and book plane tickets directly through our platform.
- Future scope: surface nearby hotels and restaurants at the destination airport — **not in v1**.

## 2. Core User Flow (Flight-First)

1. User searches for a flight (origin → destination, dates, passengers).
2. User browses results, selects a flight, and proceeds to booking.
3. _(Future)_ After selecting a flight, the system suggests hotels and restaurants near the destination airport using the airport's known coordinates.

The flight is the **anchor of the entire experience**. Hotels and restaurants are supplementary and deferred to later milestones.

## 3. Data Sources & APIs

| Concern                         | Provider                                   | Notes                                                                                                        |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Flight search, pricing, booking | **Amadeus Self-Service API**               | Free tier (2,000 calls/month). Supports search, pricing, PNR creation, and ticketing. Non-negotiable for v1. |
| Airport geolocation             | **Static dataset** (e.g., OurAirports CSV) | IATA code → lat/lng mapping. Airports don't move — store in a DB table.                                      |
| Hotels _(future)_               | **Amadeus Hotel Search API**               | Same provider, keeps booking pipeline unified.                                                               |
| Restaurants _(future)_          | **Google Places API**                      | Rich restaurant data with ratings, photos, radius-based search. Free tier ($200/month credit).               |
| Flight tracking _(optional)_    | **AviationStack**                          | Supplementary real-time flight status data. Not used for booking.                                            |

## 4. AI Agents vs. Deterministic Services (Hybrid Architecture)

### Boundary Rule

> **AI agents must NEVER be in the critical booking/payment path.** All transactional operations are handled by deterministic, auditable backend services.

### AI Agents (LLM-powered) — Advisory Role

- Smart flight search assistance and result interpretation.
- Handling edge cases and surfacing relevant information to the user.
- _(Future)_ Itinerary recommendations, customer support chatbot, price trend analysis, fraud pattern detection.

### Deterministic Backend Services — Transactional Role

- Flight search & pricing (Amadeus API calls).
- Booking & PNR creation.
- Payment processing.
- Ticket issuance & confirmation.
- Refund handling.
- User authentication & session management.
- Notification delivery (email, SMS).

### Rationale

- LLMs are non-deterministic — unsuitable for financial transactions.
- Booking transactions must be **auditable and reproducible**.
- PCI-DSS and payment regulations require strict, traceable flows.

---

## Open Questions (Not Yet Resolved)

These topics were not covered in the grilling session and should be addressed in future planning:

- **Tech stack**: Language, framework, database choice.
- **Authentication strategy**: OAuth, JWT, social login providers.
- **Search UX**: Filters (stops, airlines, price range), sorting, pagination.
- **Multi-currency / multi-language** support.
- **Rate limiting & caching** strategy for Amadeus API (2,000 calls/month is tight).
