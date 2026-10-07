# Contract: Provider Operations and Recovery

Provider-blind semantics for saga, adapters, recovery, admin and durable workflow. Exact provider status DTOs remain subject to sandbox verification.

## Workflow result
Confirmation returns CONFIRMED only with a validated supplier order and successful Stripe capture. Verified completed compensation returns a resolved failure (COMPENSATED_FAILURE), never booking success. Return DEFINITIVE_FAILURE only when evidence proves no uncertain side effect remains. Return PENDING with stable workflow/status reference for any unresolved state; it must survive reload and a new HTTP request key. REJECTED means preflight or authorization failed before the next side effect. The existing confirm controller may map PENDING to HTTP 202.

## Operation and attempt
- Stable operation identity is persisted per workflow/provider/purpose/allowed logical sequence; independent of HTTP key, actor, lease, or retry count.
- Every actual dispatch and reconciliation read gets a distinct attempt.
- Complete read-only preflight, then atomically verify current claim and persist PREPARED before invoking the provider port. PREPARED means possibly sent.
- Use existing PAYMENT_GATEWAY_PORT, FULFILLMENT_GATEWAY_PORT and current search capability; keep vendor SDK shapes inside adapters.
- Normalize outcome to CONFIRMED, DEFINITIVE_FAILURE, NONFINAL, or UNRESOLVED; append sanitized PaymentEvent evidence linked to attempt.
- Current owner alone advances workflow/checkpoints under token+fence+unexpired lease. Stale valid response appends evidence but cannot mutate state.
- Takeover reconciles every unfinished PREPARED operation before any follow-up action. It never retries unknown supplier create.

## Result rules
| Operation | Confirmed | Unresolved examples |
|---|---|---|
| Stripe authorization | Current retrieved intent is capturable with expected customer amount/currency and recorded expiry | processing, unavailable retrieve, nonfinal |
| Duffel create | Valid response/retrieved order linked to intent/offer/passengers/itinerary | timeout, 5xx, pending payment, empty discovery, unlinked/ambiguous candidate |
| Stripe capture | Provider says succeeded and amount matches | timeout, nonfinal, retrieve unavailable, authorization expired with order |
| Duffel cancel | Target linked order confirmed cancelled | timeout, pending, unavailable retrieve, unlinked evidence |
| Release/refund | Provider confirms requested state | timeout, pending, event/API conflict |

Definitive failure is action-specific. Capture failure does not prove cancellation. Cancellation does not prove refund. Empty list does not prove no order.

## Claim
FulfillmentWorkflow is the single claim row keyed by BookingIntent. Acquire only when empty/expired using database time and an atomic update that increments fence. Default lease 180s, renew each 30s. All state mutation checks owner token, fence, and unexpired lease in the same DB write/transaction. Provider calls are outside transactions. Expiry enables takeover but is not evidence the call stopped.

## Existing payment HTTP surface
- POST /bookings/payment/create creates/replays PaymentIntent for authenticated booking intent. Required Idempotency-Key validates request hash and cached response only.
- POST /bookings/payment/confirm resumes the durable workflow reserved by payment creation; it does not create a new financial operation merely because the HTTP key changed. A new key cannot create a second workflow.
- GET /bookings/payment/:paymentId/status reports authenticated owner-scoped pending/confirmed/definitive state and safe next step.
- Browser uses Stripe publishable key plus client secret/Elements; no secret API key or raw card number is passed through application server fields.

## Admin surface
Suggested ADMIN-only routes: GET /admin/booking-reconciliation?status=active&cursor=..., GET /admin/booking-reconciliation/:workflowId, POST /admin/booking-reconciliation/:workflowId/reconcile, POST /admin/booking-reconciliation/:workflowId/resume. Use existing JWT and role guards and audit service. Mutations acquire same workflow claim, re-read evidence, validate linkage, and record actor/evidence/action/time/outcome. The UI requests evaluation; deterministic policy chooses safe actions. No force status, arbitrary patch, unverified release, or blind create retry.

## Compatibility and privacy
Keep existing booking/payment DTOs and webhook signatures compatible; add only optional status fields protected by contract tests. Verify and dedupe Stripe webhooks through existing endpoint; reduce delayed events under claim. Persist allowlisted provider status, amount/currency, safe IDs, timestamps and linkage facts only. Never store PAN, API secret, auth header, or unredacted passport/contact payload in recovery evidence.
## Create, browser authorization and confirmation lifecycle

Payment creation reserves workflow, Payment and PAYMENT_INTENT_CREATE operation under the shared claim, then journals Stripe creation before dispatch. Persist the returned ID/evidence under the fence before exposing a client secret. Concurrent different HTTP keys converge on that reserved operation; reconcile lost responses rather than starting a second payment.

Record authorization before the browser invokes Stripe confirmation. Provider retrieval/webhooks, not the browser's assertion, establish capturability, amounts and expiry. Confirm resumes the existing workflow. Pre-confirm cleanup and direct release/refund paths in PaymentService also use the shared claim/evidence policy. This journal cannot make a browser action atomic with a DB transaction.

Enrollment determines routing independently of the global enable flag. Off-mode never exposes existing unresolved workflows to legacy compensation. Ownership loss is control flow, not definitive provider failure.

## Authoritative observation capabilities

Extend exported provider-blind ports with authoritative Stripe intent/capture/release/refund observation and supplier order/payment/cancellation observation plus supported candidate discovery. Keep provider request schemas and SDK objects inside adapters. Existing snapshot retrieval remains for historical rendering; its persisted-evidence fallback is never evidence of current provider cancellation or order status.

Observation results include provenance, observation time, validated resource linkage and normalized facts, or an explicit unavailable/nonfinal outcome. Network failure, absence or ambiguous discovery stays unresolved; a historical snapshot cannot upgrade it. Candidate discovery uses only verified provider filters/pagination and validates linkage; no invented operation-ID lookup or unique offer match. T021 defines these capabilities, T023/T024 implement them, and T034 consumes only the exported authoritative interfaces.
