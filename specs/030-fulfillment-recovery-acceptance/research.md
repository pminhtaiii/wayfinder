# Research: Safe Booking Fulfillment Recovery

**Status**: Based on accepted project ADRs, source inspection at baseline 99e78031, and official provider documentation checked 2026-10-07.

## Decisions

### Customer and supplier money remain separate
Follow the accepted Stripe authorization -> Duffel instant order with balance -> Stripe capture sequence. Derive Duffel amount/currency from current validated supplier price and balance contract, not Payment.amount/currency by assumption. Existing saga passes the customer amount to createOrder, so this is an implementation prerequisite. The current checkout UI is a disabled placeholder despite existing authenticated create, confirm, and status APIs; implement tokenized Stripe client wiring.

### Results are confirmed, definitively failed, or unresolved
A timeout or 5xx does not prove whether a provider mutation occurred. Reconcile unknown create, capture, cancellation, release, and refund before the next financial action. Duffel order list filters by offer_id and booking_reference and can find candidates, but neither a candidate nor an empty result uniquely proves which request created it. The docs do not promise create replay idempotency.

### One workflow row is the only claim authority
Key FulfillmentWorkflow by BookingIntent because it exists before Booking. Store owner token, monotonic fence, lease expiry, and renewal on that row. Saga, recovery, and operator code share it. Current baseline has request-key ownership in PaymentIdempotencyService and a separate Redis key in BookingRecoveryService; they must stop competing in the same deploy cohort.

### Operation identity differs from execution and HTTP identity
Generate a stable operation for workflow/provider/purpose and a fresh ProviderAttempt per dispatch/reconciliation. Keep HTTP idempotency for request response replay only. Stripe may prune idempotency keys after at least 24 hours, and Duffel does not document a corresponding create replay guarantee.

### Fence transitions, not facts
Write PREPARED after preflight and immediately before an uncovered side effect. Stale response evidence is appended to existing PaymentEvent with the attempt ID, but stale owners cannot update workflow/checkpoints/payment/booking. A new owner reconciles the unfinished attempt first. Keep existing checkpoint placement if it covers its following side effect.

### Reconcile immediately; escalation does not stop recovery
Keep immutable firstUncertainAt. Start immediately with bounded jittered backoff; initial 15-minute queue escalation or an earlier actual Stripe-expiry safeguard is operational policy, not provider truth. Automatic reconciliation continues after escalation. Duffel response handling allows upstream create work up to 120 seconds and recommends client timeout >=130 seconds.

### Operators use role-protected evidence actions
Use current JwtAuthGuard, RolesGuard, ADMIN pattern and audit service. Allowed operations are inspection, reconciliation request, and evidence-permitted resume. No force result, unsafe release, or blind create retry.

### Verify provider contract before enablement
Stripe capture requires current PaymentIntent requires_capture and success is a retrieved succeeded status. Expand latest_charge and inspect card capture_before when available. Current repository retrieves payment_method but not latest_charge. Duffel official docs distinguish balance payment currency from a customer's Stripe currency; verify current-offer and order mapping in isolated sandbox. Unknown or absent provider evidence blocks live mutation.

## Alternatives rejected
- Charge customer first, then create supplier booking: no confirmed inventory at charge time.
- Reuse customer price/currency for supplier balance: financial legs can differ.
- Retry unknown supplier create with same key: no provider guarantee.
- Treat empty discovery as failed create: delayed indexing/no results are not proof.
- Keep Redis, request-key, and workflow claim concurrently: stale owner can win through another lock.
- New generic orchestration framework, new runtime dependency, or AI financial operator: unnecessary and outside deterministic boundary.

## Repository evidence at baseline
- apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts performs authorize/create/capture and currently checks request-bound ownership.
- apps/api/src/payment-fulfillment/ports/payment-gateway.port.ts and fulfillment-gateway.port.ts are provider-blind seams.
- apps/api/src/idempotency/payment-idempotency.service.ts owns HTTP idempotency and current saga locking/checkpoints.
- apps/api/src/booking-lifecycle/booking-recovery.service.ts has a separate Redis stale-booking lock.
- apps/api/src/supplier/order/duffel-fulfillment.adapter.ts owns supplier calls.
- apps/api/src/payment/payment.controller.ts already exposes payment create/confirm/status.
- apps/web/app/checkout/[intentId]/payment/page.tsx currently disables card inputs and Pay Now.
- apps/api/prisma/schema.prisma contains BookingIntent, Payment, Booking, IdempotencyKey, and PaymentEvent.

## Official references checked 2026-10-07
- Duffel [Orders API](https://duffel.com/docs/api/v2/orders): instant create accepts payments, list filters include offer_id and booking_reference.
- Duffel [response handling](https://duffel.com/docs/api/overview/response-handling) and [response times](https://duffel.com/docs/api/overview/response-times): upstream order creation can take up to 120s; client timeout should be at least 130s.
- Duffel [Payments API](https://duffel.com/docs/api/v2/payments/create-payment): balance is a payment type; currency rules are supplier/account specific; status can be pending, succeeded, failed, cancelled.
- Duffel [Offers API](https://duffel.com/docs/api/v2/offers): an offer list is incomplete/stale; retrieve the individual offer for complete current data.
- Stripe [capture PaymentIntent](https://docs.stripe.com/api/payment_intents/capture) and [retrieve PaymentIntent](https://docs.stripe.com/api/payment_intents/retrieve): only requires_capture is capturable; retrieve current state before retry.
- Stripe [idempotent requests](https://docs.stripe.com/api/idempotent_requests): keys can be pruned after 24h.
- Official [stripe-node Charge type](https://github.com/stripe/stripe-node/blob/master/src/resources/Charges.ts): card capture_before is a future timestamp; confirm availability for configured payment method.

## Release verification still required
1. Fresh offer, Duffel balance payment amount/currency, and returned order totals agree in configured agency currency; Stripe authorization remains separate.
2. Sandbox confirms Duffel pending/terminal states, retrieval, candidate discovery, and cancellation behavior for configured account.
3. Stripe expanded latest_charge/capture_before availability is verified. Determine conservative fallback margin; fail closed if adequate pre-create margin cannot be proven.
4. Claim acquisition/renewal/fenced update and append-only PaymentEvent evidence pass concurrency tests on deployed PostgreSQL.
