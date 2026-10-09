# Data Model: Ancillary Seat and Baggage Checkout

## Design goals

- Keep BookingIntent as the user-owned checkout aggregate.
- Preserve supplier identities needed for validation and order creation.
- Enforce one seat per passenger/segment and one stored copy of journey-wide baggage.
- Preserve every committed snapshot version needed by payment recovery.
- Bind payment to a validated, immutable snapshot row and version.
- Cascade cleanup only when no payment/recovery reference protects a snapshot.

## BookingIntent additions

| Field                         | Type                     | Rules                                                                                                                                  |
| ----------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ancillaryVersion`            | Integer, default 0       | Increment atomically whenever a committed selection snapshot changes. Client updates require the version they read.                    |
| `currentAncillarySelectionId` | UUID, nullable           | Points to the latest committed AncillarySelection. Updated atomically with `ancillaryVersion`; never used to recover an older Payment. |
| `ancillaryStatus`             | Enum                     | `EMPTY`, `DRAFT_COMMITTED`, `VALIDATED`, `STALE`; starts `EMPTY`.                                                                      |
| `ancillaryCurrency`           | String(3), nullable      | Required once any selection is committed; must equal offer/payment currency.                                                           |
| `seatTotal`                   | Decimal(10,2), default 0 | Derived server-side from committed seat rows.                                                                                          |
| `baggageTotal`                | Decimal(10,2), default 0 | Derived server-side from committed baggage rows.                                                                                       |
| `ancillaryTotal`              | Decimal(10,2), default 0 | `seatTotal + baggageTotal`; stored for audit, recomputed during validation.                                                            |
| `validatedTotal`              | Decimal(10,2), nullable  | Read projection of the current snapshot's authoritative grand total; not a recovery source.                                            |
| `ancillariesValidatedAt`      | DateTime, nullable       | Read projection of the current snapshot's validation time; cleared when the current pointer advances.                                  |

The existing `confirmedPrice` remains the base-offer amount. BookingIntent totals/status are conveniences for the current checkout view. Payment and recovery use authoritative values on the referenced AncillarySelection, never these mutable projections.

## AncillarySelection

Append-only parent record for one committed snapshot version. Committing version N+1 inserts a new parent and child rows; it never replaces or deletes version N.

| Field                     | Type                    | Rules                                                                                  |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `id`                      | UUID                    | Primary key.                                                                           |
| `bookingIntentId`         | UUID                    | Owning BookingIntent; many immutable versions may belong to one intent.                |
| `version`                 | Integer                 | Mirrors BookingIntent `ancillaryVersion`; unique with intent.                          |
| `status`                  | Enum                    | `DRAFT_COMMITTED`, `VALIDATED`, `STALE`, or `PAYMENT_BOUND`; transitions only forward. |
| `currency`                | String(3)               | Must equal BookingIntent/offer currency.                                               |
| `seatTotal`               | Decimal(10,2)           | Server-derived.                                                                        |
| `baggageTotal`            | Decimal(10,2)           | Server-derived.                                                                        |
| `total`                   | Decimal(10,2)           | Server-derived ancillary total.                                                        |
| `catalogFingerprint`      | String                  | Hash of normalized supplier catalog used to validate the submitted IDs. No PII.        |
| `committedAt`             | DateTime                | Audit/recovery timestamp.                                                              |
| `validatedBaseAmount`     | Decimal(10,2), nullable | Authoritative base amount returned by Duffel for this version.                         |
| `validatedGrandTotal`     | Decimal(10,2), nullable | Authoritative base-plus-services amount used to create Payment.                        |
| `validatedAt`             | DateTime, nullable      | Set only after authoritative validation/repricing.                                     |
| `createdAt` / `updatedAt` | DateTime                | Standard timestamps.                                                                   |

Relationship: one BookingIntent has many versioned AncillarySelections and references the current one through `currentAncillarySelectionId`. `(bookingIntentId, version)` is unique and `bookingIntentId` is indexed. Selection rows are append-only after commit; only validation/freeze lifecycle metadata may transition before payment binding. Once a Payment references a snapshot, the snapshot and all service rows are immutable.

## SeatSelection

| Field                     | Type          | Rules                                                                   |
| ------------------------- | ------------- | ----------------------------------------------------------------------- |
| `id`                      | UUID          | Primary key.                                                            |
| `ancillarySelectionId`    | UUID          | Parent with cascade delete.                                             |
| `intentPassengerId`       | UUID          | Must belong to the same BookingIntent and not be a lap infant.          |
| `duffelPassengerId`       | String        | Supplier passenger identity captured from the offer.                    |
| `segmentId`               | String        | Supplier segment identity.                                              |
| `serviceId`               | String        | Authoritative Duffel service identity.                                  |
| `seatDesignator`          | String        | Display-only label such as `12A`; unique only inside a segment/catalog. |
| `amount`                  | Decimal(10,2) | Supplier amount validated at commit.                                    |
| `currency`                | String(3)     | Same as parent.                                                         |
| `createdAt` / `updatedAt` | DateTime      | Standard timestamps.                                                    |

Constraints:

- Unique `(ancillarySelectionId, intentPassengerId, segmentId)` — one seat per passenger per segment.
- Unique `(ancillarySelectionId, segmentId, serviceId)` — no duplicate service in the group.
- Server verifies passenger ownership, segment membership, service/passenger binding, and availability.

## BaggageSelection

| Field                     | Type                  | Rules                                                                                               |
| ------------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| `id`                      | UUID                  | Primary key.                                                                                        |
| `ancillarySelectionId`    | UUID                  | Parent with cascade delete.                                                                         |
| `intentPassengerId`       | UUID                  | Must belong to the same BookingIntent.                                                              |
| `duffelPassengerId`       | String                | Supplier passenger identity.                                                                        |
| `serviceId`               | String                | Authoritative Duffel service identity.                                                              |
| `type`                    | Enum/string           | Normalized `CHECKED` or `CARRY_ON`; preserve unknown supplier values only in redacted catalog data. |
| `weightValue`             | Integer, nullable     | Supplier weight when present.                                                                       |
| `weightUnit`              | Enum/string, nullable | Normalized unit such as `kg`.                                                                       |
| `quantity`                | Integer               | Positive and within supplier maximum.                                                               |
| `amount`                  | Decimal(10,2)         | Per-service or normalized extended amount; contract must state which and use it consistently.       |
| `currency`                | String(3)             | Same as parent.                                                                                     |
| `createdAt` / `updatedAt` | DateTime              | Standard timestamps.                                                                                |

## BaggageSelectionSegment

Join table representing supplier coverage without duplicating the baggage purchase.

| Field                | Type   | Rules                       |
| -------------------- | ------ | --------------------------- |
| `baggageSelectionId` | UUID   | Parent with cascade delete. |
| `segmentId`          | String | One covered Duffel segment. |

Primary key: `(baggageSelectionId, segmentId)`.

Validation rejects overlapping baggage selections for the same passenger, normalized type/weight tier, and segment coverage when one is journey-wide and another covers an included segment.

## Payment addition

| Field                       | Type              | Rules                                                                                                                          |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ancillarySelectionId`      | UUID, nullable    | Foreign key to the exact snapshot used for pricing/order recovery; `ON DELETE RESTRICT` while Payment exists.                  |
| `ancillarySelectionVersion` | Integer, nullable | Denormalized audit value that must match the referenced snapshot; immutable after Payment creation. Required with snapshot ID. |

The Payment amount remains in minor currency units. At payment creation, the submitted current selection ID/version must be `VALIDATED`, unexpired, and unchanged. Payment converts that snapshot's `validatedGrandTotal` to minor units and atomically binds the snapshot as `PAYMENT_BOUND`. Recovery loads totals and service rows through `Payment.ancillarySelectionId`, never through BookingIntent's current pointer, so a later version cannot alter the recovering order.

## Supplier catalog cache (not a database entity)

The offer-scoped cached value contains supplier-native data only:

- offer ID, currency, fetched-at timestamp, expiry/TTL, and PII-free fingerprint;
- ordered segments with origin/destination and availability state;
- seat-map cabins/rows/elements and available seat services associated with Duffel passenger IDs;
- baggage services with Duffel passenger IDs, segment coverage, type, weight, maximum quantity, amount, and currency.

The cached value MUST NOT contain local BookingIntent IDs, local passenger IDs, traveller names, or any intent-specific projection. After authenticating and loading the requested BookingIntent, the ancillary read service maps the cached Duffel passenger IDs to that intent's persisted `BookingIntentPassenger.duffelPassengerId` values and constructs the intent-specific passenger/read model in request scope. This projection is never written back to the offer cache.

Redis key: `seatmap:{duffelOfferId}`. TTL: 60 seconds. Reads with TTL `<=3` seconds and force-refresh requests fetch from Duffel.

## State transitions

```text
No current snapshot
  | commit version N
  v
N: DRAFT_COMMITTED
  | authoritative validation + Duffel repricing succeeds
  v
N: VALIDATED
  | Payment atomically binds N
  v
N: PAYMENT_BOUND (immutable)

Current DRAFT_COMMITTED / VALIDATED / STALE
  | traveller commits revised choices
  v
insert N+1 as DRAFT_COMMITTED and move current pointer;
leave N and its child rows unchanged
```

`STALE` applies only to the unbound current snapshot when supplier validation invalidates it. A Payment-bound snapshot never transitions to `STALE`; recovery must reproduce the originally attempted order and let the supplier/payment saga determine its outcome.

- Payment creation is allowed only from `VALIDATED` for the exact current selection ID/version, or `EMPTY` when no services are selected.
- Intent expiry remains terminal and prevents any further selection/payment mutation.
- Booking confirmation copies only presentation/audit data required by the existing Booking read model; supplier order remains authoritative.

## Transactional invariants

1. A commit inserts a new snapshot and child rows, updates the BookingIntent current pointer/version/totals with CAS, and writes the audit event in one transaction. It never updates or deletes an older snapshot's service rows.
2. External Duffel calls never occur inside the database transaction.
3. Payment amount is computed from server-authoritative values, never request totals.
4. Checkout revalidates intent ownership, status, expiry, current snapshot ID/version, and validation timestamp/catalog before Stripe, then stores that snapshot ID/version on Payment.
5. Payment recovery reads only the Payment-bound snapshot even when BookingIntent points to a newer version.
6. A failed supplier order cannot result in a captured Stripe payment; existing compensation/recovery semantics remain authoritative.
7. `ON DELETE RESTRICT` prevents deletion of Payment-bound snapshots. BookingIntent cleanup must skip intents with retained payment/recovery references; otherwise, parent deletion cascades all unreferenced snapshot versions. LocalStorage expiry is independent defense-in-depth.
