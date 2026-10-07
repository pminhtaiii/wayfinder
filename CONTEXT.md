# Flight Booking System

Core domain language and glossary for the Flight Booking System.

## Language

**Cancellation**:
The process of terminating a confirmed flight booking. Must ALWAYS be executed Supplier-First (Duffel API) to secure the release of the PNR before any financial reimbursement (Stripe) is attempted.
_Avoid_: Revocation, Undo

**Cancellation Pending**:
A transient claim state where a process has atomically claimed a booking for cancellation (via CAS update), but the supplier cancellation has not yet been attempted or confirmed. Exists to prevent concurrent cancellation attempts from racing.
_Avoid_: Cancelling, Cancel Queued

**Refund Pending**:
A transient state (`CANCELLED_PENDING_REFUND`) where the flight has been successfully cancelled with the supplier, but the financial reimbursement has not yet been confirmed by the payment gateway.

**Refund Escalation**:
The hybrid process of attempting a Stripe refund with inline retries, falling back to a cron-based background worker with exponential backoff, and finally escalating to manual admin review (`REFUND_FAILED_NEEDS_ATTENTION`) if all retries are exhausted or the idempotency key expires.

**Refund Settlement**:
The sole owner of the authoritative recognition of a verified Refund Transaction outcome. It atomically records the transaction result and ledger reversal, recalculates cumulative Payment refund progress and Cancellation Refund Obligation fulfillment, and derives the resulting Payment and Booking states. It begins only after the provider or recovery flow obtains and verifies the outcome; it never initiates reimbursement, schedules installments, or owns provider retries.
_Avoid_: Refund initiation, Refund trigger

**Cancellation Refund Obligation**:
The single financial obligation created for a booking cancellation, containing the total amount owed to the customer. One Booking has at most one cancellation refund obligation, which may be fulfilled by one or more independent Refund Transactions. Its fulfillment is measured only from successful transactions belonging to that obligation.
_Avoid_: Refund attempt, Stripe refund

**Refund Transaction**:
One independently initiated provider money movement toward a refund. Each transaction belongs to one Payment and may belong to a Cancellation Refund Obligation; it has its own provider identifier, idempotency key, amount, lifecycle, and exact ledger reversal. Multiple transactions are created only when the provider or recovery flow produces independent refunds, never as automatic installments.
_Avoid_: Refund obligation, Refund installment

**Refund Reservation**:
The amount temporarily claimed by an active Refund Transaction before its provider outcome is terminal. Creating a transaction must atomically reserve the same amount against both the Payment's remaining refundable balance and, when cancellation-related, the Cancellation Refund Obligation's remaining balance. `REFUND_PENDING`, `REFUND_PROCESSING`, and `REFUND_RETRY_SCHEDULED` retain the reservation; `SUCCEEDED` converts it to fulfilled/refunded value; a terminal failure releases it. Retries reuse the existing reservation and idempotency key.
_Avoid_: Refund installment, Retry allocation

**Cancellation Deadline**:
The fare-specific cutoff time before which a booking may be cancelled for a refund. Derived from Duffel's fare conditions at booking time and stored on the Booking row. Not a system-wide constant — varies by fare class.
_Avoid_: Cancellation Window, Refund Deadline

**Supplier Synchronization**:
The single, idempotent process that fetches the supplier-authoritative itinerary and compares it with the latest itinerary revision. Duffel webhooks are the primary trigger; scheduled reconciliation is a backup. Both converge on the same pipeline. Supplier events and scheduled verification are triggers only, never the authoritative data source.
_Avoid_: Ticket refresh, Airline polling

**Reconciliation Cron**:
A backup sync trigger that runs every 30 minutes, scanning CONFIRMED bookings with departure within 72 hours, ordered by `lastDuffelSyncedAt ASC, departureAt ASC` (stalest-then-soonest priority). Processes 20 bookings per run via cursor. Exists solely to catch changes that webhooks missed — not a primary sync mechanism. Updates `lastDuffelSyncedAt` on each processed booking.
_Avoid_: Primary sync, Full-table scan

**Duffel Webhook Inbox**:
A lightweight durable event table (`duffel_webhook_events`) that receives verified Duffel webhook payloads. The webhook endpoint verifies the signature, inserts one small row (event ID, order ID, event type, status, attempts, raw payload), and returns 200 immediately. A DuffelEvent processor polls pending events in small batches and runs the supplier synchronization pipeline for each. On Duffel fetch failure: increment attempts, set RETRY*SCHEDULED with exponential backoff (1m, 5m, 15m); after 5 failures escalate to FAILED_NEEDS_ATTENTION. Cron-triggered syncs need no explicit retry — `lastDuffelSyncedAt` staleness keeps failed bookings at the top of the priority queue. This is the transactional inbox pattern — the receiving-side mirror of the Notification Outbox.
\_Avoid*: Fire-and-forget, Heavy queue infrastructure

**Itinerary Revision**:
An immutable, supplier-authoritative version of a confirmed booking's flight itinerary captured after an airline-initiated change.
_Avoid_: Ticket update, Flight overwrite

**Segment Matching**:
A confidence-based cascade used by the diff engine to pair segments between two itinerary states. Primary: stable Duffel segment ID. Secondary: carrier + flightNumber + departureDate (optionally + departure airport). Fallback: origin + destination IATA pair + departureDate + time proximity. Position-based matching is a weak tie-breaker only, never a normal fallback. Unmatched old segments are classified as removed; unmatched new segments as added. Itinerary-level patterns (e.g. routing changed, segment replaced by connection) are derived from the aggregate segment-level diff results.
_Avoid_: Index-based matching, Position-only comparison

**Material Disruption**:
An airline-initiated itinerary revision requiring traveller attention. Classified by a deterministic ruleset applied to each revision's segment-level diff. Binary rules (always material): segment removed/cancelled, replacement segment added, departure or arrival airport changed, segment date changed, overnight connection introduced, connection time below Minimum Connection Time. Threshold rules (system-wide constants): departure moved earlier by >1 hour, departure moved later by >2 hours, final destination arrival shifted by the same thresholds. The 3rd material notification per booking per day carries a stabilization warning; beyond that, the booking is flagged for manual review.
_Avoid_: Routine update, Minor revision

**Minimum Connection Time (MCT)**:
A system-wide constant (60 minutes) representing the minimum acceptable duration between consecutive segments' arrival and departure. If an itinerary revision causes the connection time to drop below MCT, the change is classified as a Material Disruption. Not airport-specific or fare-specific — a single global floor.
_Avoid_: Airport-specific MCT, Dynamic connection threshold

**Notification Outbox**:
A durable record written in the same transaction as an itinerary revision and disruption classification. Represents a pending notification request that a future notification delivery service will consume, replay, and mark as delivered. Never inferred retroactively from itinerary diffs.
_Avoid_: Notification queue, Alert log

**Disruption Status**:
An orthogonal field on Booking (separate from BookingStatus) that tracks the lifecycle of a detected disruption: NONE → DETECTED → ACKNOWLEDGED → RESOLVED. Carries only the state — the cause and details live on the associated Itinerary Revision. Scoped to a specific revision via `activeDisruptionRevisionId`; when a new material revision arrives, the status resets to DETECTED with the new revision ID. Transitions: DETECTED via material revision; ACKNOWLEDGED via explicit traveller click; RESOLVED via traveller acceptance, departure passing, admin action, or booking cancellation. DETECTED also auto-resolves on departure to prevent stale unacknowledged records. The cycle can repeat — a RESOLVED booking returns to DETECTED if a new material revision arrives. Resolution is auditable: `resolvedReason` (TRAVELLER*ACCEPTED, DEPARTURE_PASSED, ADMIN_RESOLVED, BOOKING_CANCELLED), `resolvedAt`, and `resolvedBy` (traveller/system/admin) are captured on every RESOLVED transition. Cancellation and disruption are independent — travellers may cancel during a disruption, and cancellation auto-resolves the disruption. Disruptions do not affect cancellation deadlines.
\_Avoid*: Disruption reason, Disrupted booking status

**Sync Claim**:
A two-layer concurrency guard for the supplier synchronization pipeline. Primary: a CAS (compare-and-swap) update on a `syncLockedAt` timestamp field on Booking — first caller wins, stale locks self-expire. Fallback: a UNIQUE constraint on (booking*id, version) on Itinerary Revision — if two pipelines race past the CAS, the database rejects the second insert. The loser catches the unique violation and exits cleanly.
\_Avoid*: Distributed lock, Queue-based serialization

**Notification Throttle**:
A per-booking daily cap (3 material notifications/day) on outbox writes. The 3rd notification carries a stabilization warning informing the traveller that frequent changes are being monitored. Beyond the cap, no further outbox records are created and the booking is flagged for manual admin review. Revisions and materiality classification continue unconditionally regardless of the throttle.
_Avoid_: Silent suppression, Batched digest

**Ancillary Services**:
Paid travel add-ons (specifically seat selection and baggage in Feature 15) that travellers can purchase to customize their booking. These are additive to the base fare and are retrieved/booked dynamically via the Duffel Services and Seat Maps APIs.
_Avoid_: Upgrades, Options

**Price Tracker**:
An optimistic, instant-updating client-side price summary that aggregates the base fare and all selected ancillary fees in real-time. Final price validation is performed on the server via Duffel's price verification API (`POST /air/offers/{id}/actions/price`) at the checkout commitment point before authorizing Stripe.
_Avoid_: Dynamic re-pricing, Server-side polling tracker

**Tab-Based Passenger Stepper**:
A user-interface pattern for seat and baggage selection where only one passenger's selection is active at a time to minimize cognitive load, allowing free navigation between passenger tabs while displaying existing group assignments with unique indicators.
_Avoid_: Multi-cursor selection, Color-only mapping

**Segment-Scoped Selection**:
The strict isolation of seat maps, seat designators, and segment-specific baggage to their corresponding flight segments. Selections never carry over or leak state to adjacent segments.
_Avoid_: Cross-segment selection, Global designators

**Early Expiry Cache Buffer**:
A caching strategy for volatile seat maps (60s Redis TTL) where requests arriving with very little time remaining before expiration (e.g., < 3 seconds) bypass the cache to fetch fresh supplier data. This prevents users from initiating a booking flow with near-stale seat maps.
_Avoid_: Hard expiry check

**Journey-Wide Baggage**:
A baggage service defined by the supplier as covering multiple segments (`segment_ids.length > 1`). Displayed on all relevant segment tabs with mutual exclusion logic (selecting it disables individual segment-scoped baggage of the same weight class) to prevent double-purchasing.
_Avoid_: Through-checked bag, Global bag

**Booking Readiness Evaluator**:
A shared, pure validation unit used by both the readiness endpoint (`POST /api/bookings/intents/readiness`) and intent creation (`POST /api/bookings/intents`). Determines whether a TravelerProfile satisfies a specific Duffel offer's requirements by checking core identity completeness, contact information, and — for international routes — travel document completeness (passport number, issuing country, expiry treated as one atomic document group). The readiness result is advisory, not a guarantee; intent creation re-runs the same evaluator authoritatively. Returns masked summaries and missing-field names only, never full passport or contact data.
_Avoid_: Profile validator, Eligibility checker

**Passenger Source**:
A discriminated union on the intent creation payload that declares where each passenger's data originates. `{ type: "traveler_profile", travelerProfileId: "..." }` resolves from a stored encrypted profile; `{ type: "inline", ... }` accepts per-booking manual entry. Designed so that `BookingIntentPassenger.travelerProfileId` can reference the user's own profile or a future companion profile without schema changes.
_Avoid_: useProfile flag, Passenger mode

**Passenger Snapshot**:
A complete, immutable copy of all Duffel-bound passenger fields captured at intent creation time from the resolved Passenger Source. Includes identity (name, DOB, gender, title), contact (email, phone), and — when required — the full passport document group (number, issuing country, expiry) as one atomic unit. Sensitive fields are encrypted at rest (AES-256-GCM) and stripped/masked on API read responses. Decryption occurs only inside the trusted booking service just before Duffel order creation. The snapshot is never partially populated; the Booking Readiness Evaluator ensures completeness before creation.
_Avoid_: Passenger reference, Live profile lookup

**Readiness Scope**:
The required-field checklist applied by the Booking Readiness Evaluator, determined by the offer's itinerary. `DOMESTIC`: all segments within the same country — requires identity (givenName, familyName, dateOfBirth, gender, title) and contact (email, phoneCountryCode, phoneNumber); travel documents not evaluated. `INTERNATIONAL`: any segment crossing a country border — requires identity, contact, and the full passport document group (documentType, passportNumber, passportExpiry, issuingCountry, nationality) as one atomic unit. The scope is derived by looking up origin/destination airport country codes from the airports table. Route scope determines field requirements; it does not imply immigration-entry eligibility, which requires destination-specific travel rules.
_Avoid_: Flight type, Route category

**Document Validation Model**:
A three-tier passport validation architecture. Hard validation: passport fields present when required, expiry after trip completion date, document type supported by Duffel offer — returns `invalid` and blocks booking. Advisory validation: configurable system-wide `PASSPORT_ADVISORY_BUFFER_DAYS` (default 180) — returns `warning` with reason `PASSPORT_VALIDITY_REQUIRES_VERIFICATION` if passport expires within the buffer period after the trip, but does not block. Destination-specific validation: deferred to a future maintained travel-rules provider (e.g. Timatic) for authoritative itinerary-specific eligibility — returns `unknown` when the system cannot determine eligibility. Statuses: `valid`, `warning`, `invalid`, `unknown`.
_Avoid_: Universal expiry rule, Hard 180-day blocker

### Booking Payment and Fulfillment

**Supplier Order**:
A supplier's independent record of a flight booking. Its existence and state are established from supplier evidence, not inferred from whether the create request returned a response.
_Avoid_: Order response, Booking attempt

**Supplier Dispatch Readiness**:
The precondition for a new supplier create: the Stripe authorization is valid and has enough time for order creation, capture, and the configured recovery margin. If this is absent before the first attempt, obtain renewed authorization; if an attempt is unresolved, reconcile it instead of creating again.
_Avoid_: Retry eligibility, Request readiness

**Supplier Fulfillment Outcome**:
The evidence-backed result of an attempt to create the supplier order: confirmed, definitively failed, or unresolved. Unresolved means available evidence does not establish either success or failure.
_Avoid_: Request result, Assumed failure

**Customer Payment**:
The payment collected from the traveller through Stripe. It is a separate financial leg from the amount charged by the flight supplier.
_Avoid_: Supplier payment

**Supplier Payment**:
The amount charged by the supplier for the order, using the supplier's authoritative amount and currency. It is separate from the traveller's Stripe payment.
_Avoid_: Customer charge

**Operator Review Case**:
An auditable case for a booking whose provider outcome remains unresolved at the initial configurable 15-minute escalation threshold after uncertainty begins, or earlier when action is needed before the actual Stripe authorization expires. Reconciliation continues after escalation, and new provider evidence can resolve the active case while its history remains available.
_Avoid_: Forced failure, Manual override

**Reconciliation Claim**:
Time-bounded ownership of an unresolved booking case by one actor authorized to advance or compensate it. The actor validates current persisted state before acting, and expiry permits recovery if the actor stalls.
_Avoid_: Permanent lock, Parallel ownership

**Provider Operation**:
One logical supplier or payment side effect in a booking workflow, with an identity that remains stable across customer requests and recovery actors. Each execution is a separate attempt, and the identity belongs to the workflow operation rather than its request or current owner.
_Avoid_: HTTP request, Execution attempt

**Provider Attempt Evidence**:
A durable record that an execution attempt for a provider operation was prepared and may have been sent. It does not prove the provider received or completed the call; recovery reconciles it before replay.
_Avoid_: Dispatch success, Provider confirmation

### Chatbot Booking Orchestration

**Conversational Handoff**:
The design principle that the AI chatbot assists with flight discovery, evaluation, and intent capture but never executes transactional operations (booking creation, payment, cancellation). When the user commits to booking, the chatbot hands off to the deterministic web checkout flow via a Handoff Token. The LLM has zero write tools.
_Avoid_: Agent-driven booking, Chat-based checkout

**Handoff Token**:
A short-lived, server-issued, single-use credential that bridges the chatbot conversation and the deterministic checkout pipeline. Created by a deterministic LangGraph node (never by the LLM) after validating offer freshness, session ownership, and duplicate prevention. Resolved by the checkout backend to verify user ownership, expiry, and consumption status before displaying the checkout page. Internal provider identifiers (Duffel offer IDs) are referenced by the token, not exposed in the browser URL.
_Avoid_: Deep link, Checkout URL, Offer link

**Action Handoff Event**:
A structured SSE event (`type: ACTION_HANDOFF`) emitted alongside the LLM's text stream that carries a handoff token and presentational display metadata. The frontend renders a rich checkout card from this event. The display metadata is presentational only — the checkout page loads authoritative data from the backend. The event schema is versioned and the frontend accepts only an explicit action registry (e.g., `begin_checkout`), never arbitrary URLs.
_Avoid_: Chat link, Inline URL, Markdown deep link

**Checkout Intent Signal**:
A read-only LangGraph tool (`signal_checkout_intent`) that the LLM calls when it recognizes the user's explicit intent to book a specific flight. The tool validates the offer index against the most recent search results and sets a graph state flag. It has no side effects — downstream deterministic nodes (validate*handoff, create_handoff_token) handle offer validation and token creation. Replaces the former stub `book_flight` tool.
\_Avoid*: Book action, Write tool, Booking trigger

**Trusted Search Snapshot**:
A compact, code-only record of the most recent `search_flights` tool results stored in the LangGraph state by the `custom_tool_node` — not by the LLM. Contains only the fields needed for downstream validation and handoff token creation (Duffel offer ID, airline, route, departure time, price, currency). The LLM never sees this snapshot; it sees only a formatted text summary without provider identifiers. When `signal_checkout_intent(offer_index=N)` is called, the deterministic `validate_handoff` node resolves the index against this snapshot to obtain the authoritative offer ID. Overwritten on each new search — "Flight 3" always refers to the latest search.
_Avoid_: Full tool response cache, LLM-visible offer IDs

**Booking Summary Tier**:
The default, compact data projection returned by `list_user_booking_summaries` — airline, route, departure/arrival times, status, duration, stops, and an opaque booking reference. Financial data (price, currency), fare class, passenger count, baggage, flight number, and all PII are excluded. Designed to answer logistics questions ("When is my flight?") while minimizing the LLM's data surface.
_Avoid_: Full booking view, Booking dump

**Booking Detail Tier**:
A narrow, on-demand data projection returned by `get_booking_detail` when the user explicitly requests additional information ("What's my flight number?", "How much luggage can I bring?"). Adds flight number, baggage allowance, and user-friendly fare conditions (changeable/refundable flags). Price requires a separate protected capability. Passenger PII, passport data, payment details, provider payloads, database IDs, and PNR references are never exposed to the agent.
_Avoid_: Full booking record, Unfiltered detail

**Agent Tool Boundary**:
The principle that the chatbot's tool inventory is minimal, read-only, and fixed: `search_flights`, `get_user_preferences`, `list_user_booking_summaries`, `get_booking_detail`, `check_booking_readiness`, and `signal_checkout_intent`. No tool can create, modify, or delete any resource. The handoff token is created by a deterministic graph node, not a tool. The LLM constructs no URLs, selects no offer IDs from free text, and populates no security-sensitive action fields.
_Avoid_: Full API access, Write-capable agent

**Agent Decomposition**:
The multi-agent architecture for the chatbot system. Four agents — Router (stateless intent classifier, no tools), General-Purpose Agent (greetings, FAQ, general chat, no tools), Travel Assistant (`search_flights`, `get_user_preferences`, `list_user_booking_summaries`, `get_booking_detail`, `check_booking_readiness`), and Checkout Orchestrator (`signal_checkout_intent` only) — plus a deterministic handoff pipeline (`validate_handoff` → `create_handoff_token`, no LLM). Each agent has a narrow system prompt and minimal tool set. The user perceives a single assistant.
_Avoid_: Monolithic agent, Single-agent pipeline

**Intent Router**:
A lightweight, stateless LLM-based classifier that routes every user message to the correct specialist agent. Uses structured output (JSON with intent enum and confidence score) validated against a strict schema. Categories: `GENERAL`, `SEARCH`, `BOOKING_INQUIRY`, `CHECKOUT`. Falls back to Travel Assistant when confidence is below all thresholds. Can use a smaller/faster model than the specialist agents.
_Avoid_: Keyword router, Rule-based classifier

**Checkout Gate**:
An asymmetric, multi-criteria routing condition that must be fully satisfied before a message reaches the Checkout Orchestrator. All of the following must hold: `intent == CHECKOUT`, confidence ≥ a higher threshold than other routes (e.g., 0.85), an active Trusted Search Snapshot exists in graph state, the message expresses commitment rather than curiosity, and the selection reference (e.g., "Flight 3") can be resolved against the snapshot. If any condition fails, the message is routed for Routing Disambiguation instead of silently falling back.
_Avoid_: Confidence-only routing, Silent fallback to checkout

**Routing Disambiguation**:
The pattern for handling ambiguous checkout-like messages (e.g., "Flight 3 looks good" — curiosity or commitment?). When the Router detects possible checkout intent but the Checkout Gate is not fully satisfied, the message is routed to the Travel Assistant with a `disambiguation: possible_checkout` metadata flag. The Travel Assistant — which has the search context — asks an informed clarification question ("Would you like more details about Flight 3, or are you ready to check out?"). The user's clarified response goes through the Router again. The Router never generates conversational responses; it stays single-purpose.
_Avoid_: Silent downgrade, Generic clarification
