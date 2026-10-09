# Cancellation and Refund Failure Handling

We decided to use a hybrid architecture for handling failures during the flight cancellation and Stripe refund processes. When a user requests a cancellation, the system will ALWAYS attempt to cancel the flight with the supplier (Duffel API) first, before attempting to refund the user's money (Stripe).

For Duffel API cancellation failures: The system will perform short, synchronous retries (e.g. 1s, 3s, 5s, 10s) inline with the request. If it ultimately fails, it synchronously rejects the request to avoid indefinitely queueing a time-sensitive operation (since flight cancellation deadlines may pass).

For Stripe refund failures (after a successful Duffel cancellation): The system will attempt the refund synchronously with short inline retries (1s, 3s, 5s). If all inline retries fail, the system falls back to an asynchronous cron-based background worker with exponential backoff (1min, 5min, 30min, 2hr). If all background retries are exhausted, the booking enters a `REFUND_FAILED_NEEDS_ATTENTION` state for manual admin escalation, and the user is proactively notified. This prevents a user from losing both their flight and their money without resolution, providing a clear audit trail and resilient UX.

## Concurrency Control

Both user-initiated cancellation and the stale-booking cron sweep use an atomic conditional update (CAS) as a claim mechanism (`WHERE status = 'CONFIRMED' OR (status = 'CANCELLATION_PENDING' AND updatedAt < NOW() - INTERVAL '2 minutes')`) instead of pessimistic row-level locking. This avoids holding database locks during long-running HTTP calls to Duffel or Stripe, while allowing retries to reclaim orphaned `CANCELLATION_PENDING` claims if a process crashed mid-flight. Whichever process executes the CAS first wins; the loser gets zero rows and skips. The same CAS pattern applies to refund processing — the cron worker claims refund rows atomically before retrying Stripe.

## Duffel Crash Recovery

On retry after a crash, the system does not trust local state alone. It queries Duffel first: if the order is already cancelled (`cancelled_at` exists), it skips straight to the refund phase. If not cancelled and no local cancellation quote ID exists, it checks Duffel for unconfirmed quotes before calling `create()` again. This "remote-first verification" pattern handles the unavoidable gap between an external API call succeeding and the local DB write committing.

## Stripe Error Classification

Not all Stripe failures are retryable. Transient errors (5xx, timeouts, 429 rate limits, connection resets) are routed to retry. Deterministic errors (card declined, charge already refunded, invalid amount, charge disputed) skip retries entirely and escalate to `REFUND_FAILED_NEEDS_ATTENTION` immediately — retrying them is pointless and delays the admin action that's actually needed.

## Idempotency Key Safety Rail

All retry attempts for a single logical refund reuse the same Stripe idempotency key. Since Stripe keys expire after 24 hours, the retry worker checks key age before every attempt. If the key is older than 22 hours (safety margin), the worker forces escalation to `REFUND_FAILED_NEEDS_ATTENTION` instead of retrying — preventing a stale key from accidentally creating a duplicate refund.

## Refund Amount

The customer refund amount is a straight passthrough of Duffel's cancellation quote `refund_amount`. The platform does not absorb airline cancellation penalties — the user bears the cost of their cancellation decision. Both the airline refund amount and the customer refund amount are stored on the Refund record for auditability.
