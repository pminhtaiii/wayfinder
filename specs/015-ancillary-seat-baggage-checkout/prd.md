# Product Requirements Document: Ancillary Seat and Baggage Checkout

**Feature**: 015 — Ancillary Seat and Baggage Checkout

**Status**: Ready for agent

**Product scope**: Seat selection, baggage add-ons, instant price tracking, authoritative checkout validation, and ancillary-aware review/recovery within the flight booking flow

## Problem Statement

Travellers can search, book, pay for, manage, cancel, and recover flight bookings, but they cannot customize a booking with paid seats or baggage before payment. This leaves a major gap between the current product and a production online travel agency: travellers cannot choose where they sit, cannot purchase additional baggage for the correct passenger and flight segment, and cannot understand how optional services change the total before committing.

The problem is more complex than displaying a list of add-ons. Seat availability is volatile and shared across every airline distribution channel. Baggage may apply to one segment or an entire journey. A booking may contain several passengers and several segments, so every selection must stay within the correct passenger and segment scope. Prices shown during browsing must update instantly, but the amount charged must still be verified by Duffel before Stripe authorization. Retries, tab closures, supplier conflicts, and payment failures must not create duplicate orders, charge the wrong amount, or attach a service to the wrong passenger.

The live product also lacks a complete, navigable passenger-to-payment frontend flow on the current development baseline. This feature therefore cannot be delivered safely as isolated seat-map components; it must first establish the real checkout foundation those components depend on.

## Solution

Add an optional Ancillary Services step between passenger details and review. The page will contain switchable Seats and Baggage sections, segment tabs, and a Tab-Based Passenger Stepper. Travellers will be able to select or skip services independently for every eligible passenger and segment while seeing an immediate Price Tracker containing the base fare, seats, baggage, and estimated grand total.

Duffel will remain the single source of truth for service availability, passenger and segment association, exact pricing, order creation, and cancellation refund amounts. Browsing interactions will be optimistic and local for speed. When the traveller continues, the system will persist a versioned, BookingIntent-owned Ancillary Selection Snapshot. At payment creation, the server will freeze that exact snapshot, validate and reprice the intended services with Duffel, and create one manual-capture Stripe PaymentIntent for the authoritative full amount. The system will create one Duffel order containing the validated services, then capture or release the Stripe authorization through the existing recovery-aware payment saga.

The review page will remain read-only and provide targeted Edit seats and Edit baggage links. A minimal, expiring local recovery record will help restore committed selections after a tab closes, but authenticated server state will always win. Existing supplier-first cancellation and refund recovery will remain unchanged: Duffel's quote determines the refundable amount, including or excluding ancillary costs as the supplier specifies.

## User Stories

1. As a traveller, I want an Ancillary Services step after passenger details, so that I can customize my flight before reviewing and paying.
2. As a traveller, I want seats and baggage grouped on one page, so that I can manage related extras without navigating through unnecessary checkout pages.
3. As a traveller, I want to switch between Seats and Baggage, so that I can focus on one kind of decision at a time.
4. As a traveller, I want both seats and baggage to be optional, so that extras never prevent me from booking the base flight.
5. As a traveller, I want to see a separate tab for every flight segment, so that I know which flight each service applies to.
6. As a traveller, I want a segment without a seat map to explain that the airline will assign seats, so that I understand why selection is unavailable and that there is no extra charge.
7. As a traveller, I want to force-refresh a seat map, so that I can request the latest available inventory when availability appears stale.
8. As a traveller, I want the system to preserve valid choices during a seat-map refresh, so that refreshing one catalog does not erase unrelated work.
9. As a traveller, I want removed or changed services called out after refresh, so that the system never silently substitutes a different seat or price.
10. As a lead traveller, I want passenger tabs to show traveller names, so that I can confidently assign services to the correct people.
11. As a traveller, I want to move freely between passenger tabs, so that I can compare and revise group assignments without completing them in a fixed order.
12. As a traveller, I want lap infants skipped during seat selection, so that I am not asked to purchase a seat service they cannot use.
13. As a traveller, I want each seat to show its designator, status, and price, so that I can compare meaningful choices.
14. As a traveller, I want unavailable seats to be visibly and semantically disabled, so that I cannot accidentally choose inventory the supplier does not offer.
15. As a traveller, I want seats selected by members of my group distinguished from unavailable seats, so that I can coordinate assignments without confusion.
16. As a traveller, I want the group indicator to identify the passenger holding a seat, so that the assignment is understandable without relying on color.
17. As a traveller, I want each eligible passenger limited to one seat per segment, so that I cannot create an invalid or duplicate assignment.
18. As a traveller, I want one group passenger prevented from taking another group passenger's selected seat, so that our local assignments remain internally consistent.
19. As a keyboard user, I want to navigate the seat map with standard keys, so that I can select a seat without a pointer.
20. As a screen-reader user, I want seat, passenger, segment, availability, and price information exposed through semantic labels, so that the custom seat map is understandable non-visually.
21. As a traveller who uses zoom or a narrow viewport, I want checkout controls and summaries to remain usable, so that the desktop-first seat map does not hide critical actions.
22. As a traveller, I want baggage options labelled as Full journey or This flight only, so that I understand their coverage.
23. As a traveller, I want baggage choices associated with the correct passenger, so that allowances are purchased for the intended person.
24. As a traveller, I want baggage quantities capped by the supplier's maximum, so that I cannot submit an invalid order.
25. As a traveller, I want journey-wide baggage reflected on every covered segment, so that I can see existing coverage wherever I review the trip.
26. As a traveller, I want an explanation when a journey-wide bag was selected from another segment tab, so that cross-segment state does not appear mysterious.
27. As a traveller, I want overlapping journey-wide and segment-specific baggage disabled for the same tier, so that I do not accidentally purchase duplicate coverage.
28. As a traveller, I want to remove journey-wide baggage and regain relevant segment choices, so that I can change my coverage strategy.
29. As a traveller, I want a savings label when journey-wide baggage is genuinely cheaper than equivalent segment coverage, so that I can make an informed comparison.
30. As a traveller, I want the Price Tracker to update immediately when I add, remove, or change a service, so that I always understand my estimated spend.
31. As a traveller, I want the Price Tracker to separate the base fare, seats, baggage, and grand total, so that the calculation is transparent.
32. As a traveller, I want price changes announced accessibly, so that I receive the same feedback whether or not I can see the sticky summary.
33. As a traveller, I want browsing interactions to avoid supplier repricing delays, so that seat and baggage selection feels immediate.
34. As a traveller, I want all displayed selections to use the offer currency, so that totals are not based on hidden currency conversion.
35. As a traveller, I want mixed-currency selections rejected, so that I cannot be charged an ambiguous or incorrectly converted amount.
36. As a traveller, I want Continue to save my chosen service references to my BookingIntent, so that review and payment use the same committed choices.
37. As a traveller, I want double-clicking Continue to produce one committed snapshot, so that impatient retries cannot duplicate selections.
38. As a traveller using two tabs, I want stale changes rejected with the current canonical version, so that one tab cannot silently overwrite newer work.
39. As a traveller, I want committed selections restored after closing and reopening a tab while the BookingIntent is valid, so that an accidental closure does not force me to start over.
40. As a traveller, I want expired or mismatched recovery data discarded, so that old selections cannot leak into another checkout.
41. As a privacy-conscious traveller, I want recovery storage to exclude contact, passport, card, and payment-secret data, so that browser persistence contains the minimum necessary information.
42. As a traveller, I want a read-only review of passengers, seats, baggage, and totals, so that I can confirm the order without accidentally changing it.
43. As a traveller, I want targeted Edit seats and Edit baggage links, so that I can return directly to the relevant section while preserving other choices.
44. As a traveller, I want the server to verify every selected service belongs to my offer, passenger, and segment, so that manipulated service identifiers cannot affect my booking.
45. As a traveller, I want the server to reprice my exact offer and services before authorizing payment, so that I am never charged from a stale client estimate.
46. As a traveller, I want an actionable explanation when a seat or baggage service becomes unavailable, so that I know exactly what must be reselected.
47. As a traveller, I want still-valid choices preserved when one service conflicts, so that resolving supplier changes requires the least repeated work.
48. As a traveller, I want to review and acknowledge an authoritative price change before payment, so that the final charge is explicit.
49. As a traveller, I want one card authorization for the base fare and all Ancillary Services, so that my card statement is clear.
50. As a traveller, I want Stripe captured only after Duffel confirms the order, so that I am not charged for an order the supplier did not create.
51. As a traveller, I want a failed supplier order to release the payment authorization, so that failed checkout does not leave an avoidable charge.
52. As a traveller, I want retries after network or process failure to resume safely, so that recovery does not create a second payment or order.
53. As a traveller, I want my confirmed booking to retain a concise summary of purchased seats and baggage, so that I can understand what the order includes without reloading volatile supplier catalogs.
54. As a traveller cancelling a booking, I want the refund quote to explain its destination and any non-refundable ancillary amount, so that I understand what Duffel will return.
55. As a traveller, I want ancillary refunds to follow the supplier's cancellation quote, so that the platform does not invent a conflicting refund calculation.
56. As an operator, I want supplier requests, cache outcomes, validation conflicts, retries, and compensation events recorded without PII, so that failures can be diagnosed safely.
57. As an operator, I want Ancillary Services enabled in controlled stages, so that catalog, selection, and financial risks can be isolated during rollout.
58. As an operator, I want to disable ancillary payment independently while preserving base-fare checkout and durable records, so that rollback does not destroy recovery evidence.
59. As a product owner, I want the real passenger-to-payment checkout foundation restored before ancillary release, so that Feature 15a does not depend on deleted demo behavior.
60. As a product owner, I want existing booking, payment, ledger, cancellation, refund, and disruption behavior to remain compatible, so that ancillary revenue does not destabilize the core flight transaction.

## Implementation Decisions

- Insert one optional Ancillary Services step between passenger details and read-only review. Seats and Baggage are switchable sections, not separate checkout pages.
- Treat restoration of a real, authenticated passenger-to-payment checkout shell as the first delivery prerequisite because the current live frontend lacks those production routes.
- Keep the transactional boundary deterministic. AI agents have no role in catalog selection, validation, repricing, payment, order creation, or refund calculation.
- Make Duffel authoritative for seat availability, baggage services, passenger and segment associations, exact price, order acceptance, and cancellation quote values.
- Build a custom seat-map renderer rather than use a supplier drop-in widget. The renderer must support group assignment, immediate pricing, project styling, keyboard navigation, semantic state, and non-color indicators.
- Use segment tabs above a Tab-Based Passenger Stepper. Seat selections are strictly Segment-Scoped Selections and are keyed by stable supplier segment and passenger identities.
- Store the supplier service identifier as the actionable seat identity. Seat designators are display-only and never used to authorize or create an order.
- Persist the supplier passenger identity alongside each BookingIntent passenger so services cannot be attached by fragile name, type, or array-position matching.
- Model committed selections as append-only, BookingIntent-owned Ancillary Selection Snapshot versions with normalized seat, baggage, coverage, currency, and totals data. BookingIntent points to the current editable version; older versions remain immutable.
- Enforce one seat per eligible passenger per segment, prevent duplicate group seat assignments, exclude lap infants, and validate all passenger/segment/service relationships on the server.
- Represent journey-wide baggage once, associate it with all supplier-covered segments, and deduplicate it by service identity before pricing and order creation.
- Enforce mutual exclusion between journey-wide and overlapping segment baggage for the same passenger and normalized tier. Apply the rule in the client experience and repeat it during server validation.
- Keep pre-Continue browsing state local to a focused client reducer. Do not introduce a global client state framework.
- Persist a minimal local recovery record only after Continue. Bind it to the BookingIntent, selection version, and expiry; authenticated server state is canonical during hydration.
- Keep passenger, contact, document, card, and payment-secret data out of localStorage, Redis, error envelopes, and operational logs.
- Calculate the browsing Price Tracker locally from supplier-provided amounts using decimal-safe single-currency arithmetic. Do not call Duffel repricing for each interaction.
- Cache supplier-native, PII-free seat-map catalogs for 60 seconds. Cached values may contain Duffel passenger IDs but never local BookingIntent/passenger IDs or names; construct that mapping per authenticated request. Treat entries with three seconds or less remaining as misses and support explicit force refresh.
- Keep supplier transport, catalog normalization, selection commands, payment orchestration, caching, and shared wire contracts in their existing domain boundaries rather than building a new deployable service.
- Extend the existing idempotency mechanism for selection commits, but first scope replay by authenticated customer, request path, and request hash in both normal and race paths.
- Use expected-version compare-and-swap when committing selections so stale tabs receive the current canonical snapshot instead of overwriting it.
- Freeze the exact selection ID/version during payment creation, store a restrictive Payment reference to that immutable snapshot, release database locks before the external Duffel price call, and conditionally accept the result only if the same frozen version still owns checkout. Recovery follows the Payment reference, never the intent's newer current pointer.
- Perform authoritative Duffel repricing before consuming a payment attempt or creating a Stripe PaymentIntent. A supplier failure must not burn an attempt or authorize a card.
- Preserve separate base, seat, baggage, ancillary, and authoritative grand totals. Convert major units to Stripe minor units once at the payment boundary.
- Create one manual-capture Stripe PaymentIntent for the full authoritative amount and one Duffel order containing canonical, deduplicated service lines.
- Preserve the existing payment recovery sequence and compensation behavior. Do not create a parallel ancillary payment state machine.
- Block selection edits after the bound version enters payment processing, with explicit safe-resume rules for pre-authorization failures.
- Repair the existing BookingIntent status mismatch before integration so fresh intents follow legal checkout transitions.
- Keep the review page read-only. Targeted edit navigation carries only UI location; selections and PII never appear in URLs.
- Persist only the minimum confirmed ancillary summary needed for booking display and audit. Do not retain or repeatedly load the volatile full seat map after purchase.
- Keep cancellation and refund calculations supplier-first. Surface Duffel's refund destination and excluded non-refundable ancillary amounts without locally recomputing refundability.
- Use independent rollout controls for catalog/read, selection commit/UI, and ancillary payment/order services. Roll back in reverse order while preserving durable records.
- Use existing structured logging, audit, tracing, and health seams. Do not claim or introduce an observability framework that the repository does not currently operate.
- Use semantic design tokens for all new interface styling. Do not introduce hardcoded hex values or raw Tailwind color classes.
- Keep the initial seat-map experience desktop-first while maintaining keyboard, screen-reader, zoom, and narrow-viewport usability for critical controls.

## Testing Decisions

- Tests will assert externally observable behavior and durable invariants rather than private method call order. Supplier and payment calls will be stubbed at stable adapters; CI will not depend on live Duffel or Stripe.
- The feature will use five established seams because no single seam can safely prove browser accessibility, database concurrency, supplier normalization, and financial recovery together:
  1. Pure catalog normalization, selection, baggage-overlap, reconciliation, and price functions.
  2. The authenticated ancillary REST API with a real test database and Duffel/cache stubs.
  3. The existing payment saga with a real test database and Stripe/Duffel stubs.
  4. Existing cancellation/refund API and service seams for quote-authoritative ancillary disclosure.
  5. The Playwright traveller journey for rendered behavior, navigation, accessibility, recovery, and network-call assertions.
- Pure tests will cover Segment-Scoped Selection, passenger isolation, infant exclusion, duplicate seats, baggage coverage and deduplication, currency arithmetic, catalog refresh reconciliation, and stable error classification.
- Supplier adapter tests will use redacted fixtures covering multiple cabins, aisles, exit rows, missing seat maps, unavailable services, multiple passengers, single-segment baggage, Journey-Wide Baggage, unknown fields, timeouts, rate limits, and price changes.
- Cache tests will cover hits, misses, the Early Expiry Cache Buffer boundaries, force refresh, missing/no-expiry TTL values, Redis failure fallback, supplier call counts, and two BookingIntents sharing one offer without sharing local passenger projections.
- Database-backed API tests will cover authentication, ownership, expiry, malformed identifiers, service tampering, optimistic concurrency, transaction rollback, idempotent replay, cross-user and cross-route key reuse, empty-selection skip, and cascade cleanup.
- Payment tests will prove authoritative major-to-minor conversion, exact snapshot ID/version binding, one PaymentIntent/order/capture, no Stripe call on stale or invalid services, authorization release on supplier failure, safe resume from every existing recovery point, and recovery of version N after version N+1 becomes current.
- Cancellation/refund tests will prove that confirmed totals include purchased Ancillary Services while Duffel's cancellation quote continues to flow unchanged into the refund process.
- Playwright will cover passenger and segment navigation, custom seat-grid keyboard interaction, group indicators, missing-map messaging, baggage scope/mutual exclusion, instant Price Tracker updates, zero browse-time repricing, Continue double-submit protection, review/edit, local recovery, price/service conflicts, and checkout completion.
- Accessibility proof will include semantic tab and grid roles, accessible seat names, disabled reasons, roving focus, Arrow/Enter/Space behavior, live price/status announcements, visible focus, reduced motion, non-color meaning, zoom, and usable narrow layouts.
- Migration verification will run against both an empty database and representative existing Feature 14 data to prove base-fare BookingIntents and Payments remain compatible.
- Resilience checks will simulate stale catalogs, concurrent tabs, a crash after snapshot freeze, repricing timeout, Redis outage, Stripe authorization followed by Duffel failure, Duffel success followed by capture failure, and retry from each recovery point.
- Full acceptance requires shared/API/web builds, typecheck, lint, focused unit suites, complete backend E2E, Playwright, and every existing booking/payment/ledger/cancellation/refund/disruption suite to remain green.

## Out of Scope

- Mobile-specific or native-app seat-map redesign; the first release is desktop-first.
- Post-booking seat or baggage changes through Duffel order-change APIs.
- AI-generated seat recommendations, automatic seat assignment, or AI involvement in transactional decisions.
- Round-trip or multi-city search expansion beyond itineraries already represented by the selected offer.
- Loyalty-program benefits, frequent-flyer ancillary entitlements, vouchers, bundles, meals, priority boarding, lounge access, or upgrades.
- Client-side seat soft locks or claims intended to reserve inventory across distribution channels.
- Repricing on every seat or baggage interaction.
- Local currency conversion or mixed-currency checkout.
- Separate charges or PaymentIntents for base fare and Ancillary Services.
- A new ancillary microservice, distributed queue, global client state library, or general observability platform.
- A locally calculated ancillary refund or separate ancillary refund recovery pipeline.
- Notification delivery for ancillary purchases or changes.
- Restoring historical demo checkout behavior, fake PNR creation, or preview-only bookings.
- Publishing raw Duffel payloads, passenger PII, card data, or payment secrets to client storage or operational telemetry.

## Further Notes

- The product vocabulary in this PRD follows the project glossary: Ancillary Services, Price Tracker, Tab-Based Passenger Stepper, Segment-Scoped Selection, Early Expiry Cache Buffer, Journey-Wide Baggage, BookingIntent, and supplier-first cancellation/refund recovery.
- The primary product success measure is that two passengers on two segments can select or skip seats and baggage, review the correct assignments, and complete one authoritative payment without any selection crossing passenger or segment scope.
- Price Tracker updates should be visible within 100 milliseconds and create zero Duffel repricing requests during browsing.
- Every submitted service must be validated against the owned offer, supplier passenger, and covered segments before payment authorization.
- Reusing an idempotency key must result in at most one committed snapshot, one Stripe PaymentIntent, one Duffel order, and one capture.
- Seat-map cache hits must avoid supplier calls while more than three seconds remain; Early Expiry Cache Buffer and force-refresh paths must retrieve fresh supplier data.
- A failed Duffel order after Stripe authorization must result in no captured charge and a cancelled or safely recoverable authorization.
- Keyboard-only users must be able to complete the Ancillary Services step without relying on color or pointer input.
- Rollout should progress from schema/contracts, to internal catalog, protected catalog reads, canary selection UI, validation-only observation, canary financial integration, and finally broader availability.
- Related feature artifacts: [feature specification](./spec.md), [implementation plan](./plan.md), [research decisions](./research.md), [data model](./data-model.md), [API contract](./contracts/api.md), and [validation quickstart](./quickstart.md).
