# API Contract: Ancillary Seat and Baggage Checkout

All routes are NestJS backend routes under `/api` (or the repository's configured global prefix), require JWT authentication, and scope BookingIntent access to `req.user.id`. UUID parameters use existing validation pipes. Monetary request fields are informational only; the server derives committed values from Duffel.

## `GET /bookings/intent/:intentId/ancillaries`

Returns the normalized ancillary catalog plus the current committed selection snapshot.

The offer-scoped cache stores only supplier-native catalog data and Duffel passenger IDs. The `passengers` array below is projected for the authenticated BookingIntent after the cache read and is never part of the cached value.

Query:

- `refresh=true` bypasses the seat-map cache and fetches fresh supplier data.

Response `200`:

```json
{
  "intentId": "uuid",
  "selectionId": "uuid",
  "selectionVersion": 2,
  "selectionStatus": "DRAFT_COMMITTED",
  "currency": "USD",
  "baseAmount": "420.00",
  "catalog": {
    "fetchedAt": "2026-07-26T10:00:00.000Z",
    "cache": { "status": "HIT", "ttlSeconds": 42 },
    "segments": [
      {
        "segmentId": "seg_123",
        "origin": "SGN",
        "destination": "SIN",
        "seatMapAvailable": true,
        "seatMap": { "cabins": [] }
      }
    ],
    "baggageServices": []
  },
  "passengers": [
    {
      "intentPassengerId": "uuid",
      "duffelPassengerId": "pas_123",
      "displayName": "Tram",
      "type": "ADULT",
      "seatEligible": true
    }
  ],
  "selection": {
    "seats": [],
    "baggage": [],
    "totals": {
      "seats": "0.00",
      "baggage": "0.00",
      "ancillaries": "0.00",
      "estimatedGrandTotal": "420.00"
    }
  }
}
```

The read contract never returns raw Duffel payloads or passenger PII beyond the minimum display identity already authorized for this intent.

## `PUT /bookings/intent/:intentId/ancillaries`

Commits the traveller's current selection snapshot. Requires `Idempotency-Key` and optimistic `expectedVersion`.

Request:

```json
{
  "expectedVersion": 2,
  "catalogFingerprint": "sha256:...",
  "seats": [
    {
      "intentPassengerId": "uuid",
      "segmentId": "seg_123",
      "serviceId": "ase_123"
    }
  ],
  "baggage": [
    {
      "intentPassengerId": "uuid",
      "serviceId": "ase_456",
      "quantity": 1
    }
  ]
}
```

Response `200`:

```json
{
  "intentId": "uuid",
  "selectionId": "uuid",
  "selectionVersion": 3,
  "selectionStatus": "DRAFT_COMMITTED",
  "intentExpiresAt": "2026-07-26T10:30:00.000Z",
  "selection": {
    "seats": [],
    "baggage": [],
    "totals": {
      "seats": "18.00",
      "baggage": "35.00",
      "ancillaries": "53.00",
      "estimatedGrandTotal": "473.00",
      "currency": "USD"
    }
  }
}
```

Rules:

- Empty arrays explicitly skip/remove selections.
- Every successful commit inserts a new snapshot ID/version and advances the intent's current pointer; it never replaces an older snapshot that may be referenced by Payment recovery.
- Submitted service IDs are looked up in a fresh-enough supplier catalog and joined through the current owned intent's request-scoped Duffel-to-local passenger mapping; request amounts/designators/coverage and mappings from any other intent are never trusted.
- Same key + same body replays the response; same key + different body returns idempotency conflict.
- Version mismatch returns current canonical selection without overwriting it.

## Existing payment contract changes

### `POST /bookings/payment/create`

Extend request:

```json
{
  "bookingIntentId": "uuid",
  "ancillarySelectionId": "uuid",
  "ancillarySelectionVersion": 3,
  "paymentMethodId": "pm_...",
  "saveCard": false
}
```

Additional preconditions:

- the intent is owned, active, and unexpired;
- the supplied selection ID/version equals the current BookingIntent pointer/version;
- the server CAS-freezes that exact snapshot so edits cannot race checkout;
- the server calls Duffel `offers.getPriced` with canonical deduplicated intended services outside the database transaction and before consuming a payment attempt or creating Stripe;
- the authoritative result is persisted only if the same frozen version still owns checkout;
- Payment amount is the authoritative grand total converted once to minor units.

On success, the response retains the existing Payment contract and may add the authoritative pricing breakdown/version. When Duffel reports a price/service change, the route returns the structured conflict envelope and creates no Stripe PaymentIntent. No client-provided amount is accepted.

A separate repricing preview, if added later, can improve review UX but never replaces this mandatory payment-creation validation.

### `POST /bookings/payment/confirm`

Request remains compatible. `PaymentService` passes the validated selection's service IDs to the extended Duffel order adapter, verifies Stripe `requires_capture`, creates the supplier order, then captures or compensates using the existing recovery-point state machine.

Payment persists the exact ancillary selection ID/version used during creation. Confirmation and every recovery path load services through that Payment relationship rather than the BookingIntent current pointer, so committing a later selection cannot change an in-flight or recovering order.

## Error envelope

```json
{
  "statusCode": 409,
  "code": "ANCILLARY_SELECTION_STALE",
  "message": "One or more selections must be reviewed.",
  "intentId": "uuid",
  "currentVersion": 4,
  "invalidSelections": [
    {
      "kind": "SEAT",
      "serviceId": "ase_123",
      "intentPassengerId": "uuid",
      "segmentIds": ["seg_123"],
      "reason": "UNAVAILABLE"
    }
  ],
  "pricing": {
    "previousGrandTotal": "473.00",
    "currentGrandTotal": "485.00",
    "currency": "USD"
  }
}
```

Stable codes/statuses:

| Status  | Code                               | Client action                                              |
| ------- | ---------------------------------- | ---------------------------------------------------------- |
| 403     | `INTENT_FORBIDDEN`                 | Do not reveal existence/details.                           |
| 404     | `INTENT_NOT_FOUND`                 | Return to flight selection.                                |
| 410     | `INTENT_EXPIRED` / `OFFER_EXPIRED` | Discard recovery state and restart.                        |
| 409     | `ANCILLARY_VERSION_CONFLICT`       | Hydrate canonical server snapshot.                         |
| 409     | `ANCILLARY_SELECTION_STALE`        | Refresh catalog, mark invalid items, preserve valid items. |
| 409     | `ANCILLARY_PRICE_CHANGED`          | Show authoritative delta and require review/revalidation.  |
| 400     | `ANCILLARY_SCOPE_INVALID`          | Reject tampered passenger/segment/coverage input.          |
| 400     | `ANCILLARY_CURRENCY_MISMATCH`      | Reject mixed or non-offer currency.                        |
| 429     | `UPSTREAM_RATE_LIMITED`            | Retry with backoff; do not create payment/order.           |
| 502/503 | `UPSTREAM_UNAVAILABLE`             | Preserve committed snapshot and allow retry.               |

## Compatibility guarantees

- Empty ancillary selection preserves existing base-fare payment behavior.
- Existing payment response fields and confirmation route remain backward compatible.
- Existing cancellation/refund endpoints continue to expose Duffel-authoritative quote values; only presentation may add ancillary refund disclosure.
- Raw supplier payloads, payment secrets, passport data, and localStorage contents never appear in error/log contracts.
