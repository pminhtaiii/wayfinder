# Data Model: Fulfillment Recovery

Additive migration; preserve Booking, BookingIntent, Payment, IdempotencyKey, PaymentEvent and existing wire readers. This specifies semantics; exact SQL is implementation work.

## Existing records reused
- BookingIntent exists before Payment and Booking; it anchors the workflow and preserves offer/passenger/price context.
- Payment represents one Stripe PaymentIntent and has attemptNumber for the allowed payment retry. It owns the customer amount/currency, not supplier price.
- Booking continues to store supplierOrderId, PNR, status, and its existing payment/intent links.
- IdempotencyKey continues to validate request hash and replay the response. Its lockedAt cannot remain a competing workflow owner.
- PaymentEvent remains the immutable audit/evidence stream. Extend it with nullable providerOperationId, providerAttemptId, provider, evidenceKind, outcomeClass, and sanitized linkage fields as needed. Evidence events may keep previousStatus == newStatus; they must not imply a Payment status transition. Preserve webhook stripeEventId uniqueness and current event consumers.

## FulfillmentWorkflow
One row per BookingIntent, unique bookingIntentId, created before first external authorization. It is both durable workflow root and sole claim row.
- id UUID, bookingIntentId unique FK, bookingId nullable unique FK, currentPaymentId nullable FK.
- state: AUTHORIZING, READY_FOR_SUPPLIER, SUPPLIER_UNCERTAIN, SUPPLIER_CONFIRMED, CAPTURE_UNCERTAIN, COMPENSATING, COMPLETED, DEFINITIVE_FAILURE. Operator queue eligibility is tracked separately by escalatedAt; it never replaces the financial phase.
- currentCheckpoint; version; createdAt/updatedAt.
- firstUncertainAt nullable write-once; escalatedAt nullable first queue-eligibility time; nextReconcileAt and lastReconciledAt.
- ownerToken nullable opaque random owner; fence bigint monotonically increasing per successful claim; leaseExpiresAt database timestamp; renewedAt and actor type/id.
- indexes on state+nextReconcileAt, firstUncertainAt, and bookingId.
- Claim acquire: one conditional DB write on absent/expired owner, database clock, incremented fence, returning token/fence. Default 180s lease and 30s renewal. Renewal and all workflow mutation require matching owner token, fence, and an unexpired lease.

## ProviderOperation
One stable logical operation under a workflow, unique on workflowId, provider, purpose, and permitted logical sequence. Identity is generated once and never derived from caller key, worker, fence, or retry ordinal.
- id UUID; workflowId FK; paymentId nullable FK; provider STRIPE/DUFFEL; purpose PAYMENT_INTENT_CREATE, AUTHORIZATION, ORDER_CREATE, CAPTURE, ORDER_CANCEL, AUTHORIZATION_RELEASE, REFUND, RECONCILE; logicalSequence.
- status NOT_STARTED, PREPARED, UNRESOLVED, CONFIRMED, DEFINITIVE_FAILURE, COMPENSATED.
- verified providerObjectId/linkedOrderId nullable; firstUncertainAt write-once; lastOutcome/lastObservedAt; timestamps.
- A new payment attempt after prior attempt definitively closes creates a new logical sequence; takeover does not.

## ProviderAttempt
One distinct durable row per provider dispatch or reconciliation execution.
- id UUID; operationId FK; kind DISPATCH or RECONCILIATION; status PREPARED, RESPONSE_RECEIVED, CONFIRMED, DEFINITIVE_FAILURE, UNRESOLVED, ABANDONED_BEFORE_DISPATCH only with positive proof no dispatch began.
- claimFence; startedAt, dispatchedAt, completedAt; provider request/object IDs; non-PII request fingerprint; normalized failure/outcome.
- index by operationId+startedAt and claimFence.
- Create after read-only preflight and immediately before an uncovered provider side effect. PREPARED means possibly sent. Every later execution receives a new attempt ID.
- Provider outcomes/evidence are appended to PaymentEvent referencing operation/attempt; never update/delete evidence events.

## Relationships and ownership
BookingIntent 1:1 FulfillmentWorkflow; workflow 1:N Payment attempts and ProviderOperations; operation 1:N ProviderAttempts; PaymentEvent optionally references the relevant attempt/operation; workflow 0:1 Booking after created. The saga, sweeper, and admin service claim the same workflow row. PaymentIdempotencyService does only HTTP replay/hash semantics, and the Redis stale-booking lock is removed from financial ownership in the same rollout cohort.

Existing PaymentEvent provides durable evidence; add a separate audit action row only if existing audit service cannot persist actor, action, workflow ID, and evidence references. Do not add a generic evidence table.

## State invariants
1. SUPPLIER_CONFIRMED requires a verified order ID plus validated linkage to this intent/offer/passengers/itinerary and evidence event.
2. COMPLETED requires confirmed supplier order, Stripe capture success evidence, and existing booking completion.
3. Unresolved ORDER_CREATE cannot dispatch another create. Takeover reconciles it; no candidate or empty list does not prove failure.
4. Unknown CAPTURE is retrieved from Stripe before supplier cancellation. Confirmed cancellation is persisted before authorization release after definitive capture failure.
5. Natural authorization expiry is payment evidence, never proof that supplier did not create an order. Late order confirmation after expiry follows compensation or operator review; never blind recapture/create.
6. Only current workflow owner token, fence, and unexpired database-time lease can advance workflow, operation, checkpoint, Booking/Payment state, or compensation.
7. Stale provider response can append immutable PaymentEvent linked to its old attempt; a current owner validates it before transition.
8. firstUncertainAt never resets on retry, takeover, renewal, or escalation. Resolved workflows leave the active queue but retain rows/evidence.
9. Missing/contradictory legacy dispatch or supplier evidence remains unresolved and fails closed.

## Additive migration and rollout
1. Add workflow, operation, attempt tables; PaymentEvent nullable linkage/evidence columns; FKs, uniqueness and indexes. Keep old migration history unchanged. Add server release switch default off.
2. Dry-run and report backfill from Payment, BookingIntent, Booking, PaymentEvent, request idempotency checkpoints, and verified supplier IDs. Preserve source IDs/timestamps. Never infer no-provider-call from missing rows.
3. Backfill only verifiable in-flight cases. A legacy supplier checkpoint without verified order ID is not success. Ambiguous rows remain visible for reconciliation.
4. Deploy all saga, cron, operator mutations using the workflow fence together while disabled. No deployment may run old Redis/request-key ownership beside new ownership for the same cases.
5. Verify dual readers, migration on clean and existing fixtures, provider simulator and isolated sandbox contract; enable canary only after gates pass.
6. Rollback disables new mutations; additive rows/events remain readable and legacy compatibility stays available.

## Ownership
Stripe adapter owns Stripe SDK/expiry normalization. Supplier adapter owns Duffel SDK and candidate parsing. Saga owns user-initiated transitions; recovery owns scheduled reads; admin service owns redacted queue and evidence-permitted requests. Web shows payment and booking status and tokenized details only. Simulators expose provider ledgers to assertions, never to production application code.
## Payment reservation before Stripe creation

The current Payment.stripePaymentIntentId is required, so PaymentEvent cannot record evidence before a Payment exists. Use an additive reservation: make stripePaymentIntentId nullable (retain uniqueness for non-null IDs), add an internal RESERVED payment status, and reserve Payment with immutable amount/currency, allowed attempt number and original HTTP idempotency FK under the workflow claim before Stripe intent creation. PaymentEvent then references a real Payment from the beginning; no fabricated provider ID or orphan evidence. Generate the stable PAYMENT_INTENT_CREATE operation identity in this reservation transaction.

Update every reader assuming a Stripe ID: no provider request accepts null, reserved rows return safe pending responses, and existing ready-intent wire responses retain their fields. Link the real Stripe ID only after verified evidence under the fence. Preserve RESERVED and possibly-sent evidence when the response is lost; never return a fake client secret.

Before exposing a client secret, persist the intent and bind its authorization operation. Browser confirmation is external: the server records prepared/possibly-sent authorization, but cannot fence a customer's already-issued Stripe confirmation. Retrieve/webhooks establish capturability, amount/currency and actual expiry before Duffel dispatch. New HTTP keys do not create another unresolved operation. Takeover reconciles incomplete creation/authorization first. Stripe replay requires its verified same-key/same-body retention contract; unknown creation beyond that contract remains unresolved.

## Quiescence, enrollment and rollback routing

Before backfill/cutover, stop admitting affected legacy mutators, drain/isolate in-flight calls, and prove no old saga, recovery cron, webhook reducer, refund/release or admin mutator advances enrolled cases. New fencing cannot stop an old worker that ignores it.

Persist enrollment per workflow. Switching off prevents NEW enrollment and may freeze new financial actions; it never routes enrolled unresolved cases to legacy saga/Redis/request-key ownership. Keep those cases readable and pending evidence retained; verified late callbacks may append evidence and permitted current-version reconciliation continues. If rollback cannot retain a compatible reconciler, pause actions and surface operator review. Never redeploy legacy financial mutators against enrolled cases.
