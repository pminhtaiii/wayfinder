# Data Model: Traveler Profile & Booking Readiness

## TravelerProfile (extended)

One row per authenticated user; all additions are nullable so existing rows remain valid.

| Field                      | Type                     | Rules                                                                    |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `givenName`                | `String?`                | Required for readiness after trimming                                    |
| `middleName`               | `String?`                | Always optional                                                          |
| `familyName`               | `String?`                | Required for readiness after trimming                                    |
| `dateOfBirth`              | `DateTime? @db.Date`     | Past date; age/type validation remains intent-specific                   |
| `gender`                   | `String?`                | Supplier-supported canonical value                                       |
| `title`                    | `String?`                | Supplier-supported title compatible with passenger data                  |
| `email`                    | `String?`                | Traveler contact email; independent of login email                       |
| `phoneCountryCode`         | `String?`                | E.164 country prefix, stored separately                                  |
| `phoneNumber`              | `String?`                | National significant number                                              |
| `documentType`             | `String?`                | Passport for the initial release                                         |
| `issuingCountry`           | `String? @db.VarChar(2)` | Uppercase ISO alpha-2                                                    |
| `passportExpiryCiphertext` | `String?`                | Internal migration shadow; AES-GCM envelope for logical `passportExpiry` |
| `revision`                 | `Int @default(1)`        | Non-PII optimistic-concurrency token incremented on every profile update |

Existing `nationality`, `passportNumber`, `passportExpiry`, and preference fields retain their names. `passportNumber` uses the existing versioned AES-GCM envelope. `passportExpiry` remains as the legacy date column during migration; the service prefers ciphertext and falls back to the date only until backfill is verified.

### Ownership and validation

- `userId` remains unique and every query is scoped to the authenticated user.
- Profile completeness is not stored. It is derived for a selected itinerary.
- Updating any travel-document field submits the entire five-field document section; clearing the document clears the whole section.
- `PATCH` matches `{id,userId,revision}` and increments `revision`; zero matched rows returns `PROFILE_UPDATE_CONFLICT`.
- Readiness returns the evaluated revision. Profile-sourced intent creation must present it and rejects stale sources with `PROFILE_CHANGED`.
- Audit events record user/resource/action and changed field names only, never values.

## BookingIntentPassenger (extended snapshot)

Existing immutable rows gain the fields required for a complete supplier-bound snapshot.

| Field              | Type                     | Protection / rule                                        |
| ------------------ | ------------------------ | -------------------------------------------------------- |
| `middleName`       | `String?`                | Optional snapshot value                                  |
| `title`            | `String`                 | Required                                                 |
| `email`            | `String`                 | Contact snapshot; never returned by general intent reads |
| `phoneCountryCode` | `String`                 | Required                                                 |
| `phoneNumber`      | `String`                 | Protected response/log boundary                          |
| `documentType`     | `String?`                | Required for international scope                         |
| `issuingCountry`   | `String? @db.VarChar(2)` | Required for international scope                         |
| `snapshotVersion`  | `Int @default(1)`        | Selects canonicalization and ciphertext-AAD rules        |

Existing identity fields remain. Existing `passportNumber` and `passportExpiry` string columns continue storing AES-GCM ciphertext. New ciphertext is bound with AAD `{snapshotVersion,intentId,position,fieldName}`; valid ciphertext copied across records fails authentication. `travelerProfileId` records provenance but never acts as a live data source after creation. `duffelPassengerId` remains the supplier passenger identity.

The existing provenance relation remains `onDelete: SetNull`: deleting the source profile clears only the optional reference and never cascades to or invalidates the immutable snapshot.

## PassengerSource (request value object)

Discriminated union; not a separate table.

- `traveler_profile`: `travelerProfileId` plus `expectedProfileRevision`; service verifies ownership and rejects a changed revision.
- `inline`: complete identity/contact plus the travel-document section when international.

Exactly one variant is allowed. `useProfile` cannot be combined with `source` and is removed from first-party callers.

## ReadinessResult (derived value object)

Not persisted.

- `scope`: `DOMESTIC | INTERNATIONAL | UNKNOWN`
- `ready`: boolean based only on blocking statuses
- `sections[]`: identity, contact, travel document, and optional entry-eligibility advisory
- `fields[]`: field name, `filled | missing | invalid | warning | unknown`, safe reason code, and `blocking`
- passenger gateway projection: passenger type + one-based ordinal only

`unknown` airport-country scope is blocking. Unknown destination-specific entry eligibility is explicitly non-blocking because no authoritative provider exists.

## State and transaction rules

```text
Profile values
  -> advisory evaluation (no writes)
  -> authoritative evaluation
      -> blocking result: no intent/snapshot writes
      -> ready/warning result: one transaction creates intent + every passenger snapshot + audit
  -> existing payment/order idempotency claim freezes one owner + versions
      -> trusted final routine authenticates/decrypts bound fields
      -> validate current expiry/completeness after decryption
          -> stale/invalid/lease-lost: block before Duffel
          -> valid: create ephemeral supplier DTO and call Duffel once with stable idempotency key
```

- Offer refresh/Duffel I/O occurs before the short create transaction.
- All passengers are resolved and evaluated before any create write begins.
- A profile edit after snapshot creation has no effect on the snapshot.
- AES-GCM/AAD authentication failure, including cross-record substitution, is treated as invalid/corrupt snapshot data.

## Migration sequence

1. Add the eleven nullable profile fields, expiry ciphertext shadow, and nullable snapshot fields.
2. Deploy dual-read and dual-write profile logic; retain the legacy date throughout the rollback window.
3. Backfill shadow-null rows in bounded, checkpointed batches using `{id,revision,legacyValue,shadow:null}` as the optimistic predicate; report counts only.
4. Decrypt/authenticate each shadow and compare its normalized date to the current legacy date. Quarantine mismatches or key failures and abort according to the runbook threshold.
5. Keep legacy values available until the old release is no longer a rollback candidate. Clearing/dropping the legacy column is a separate feature.
6. Enforce required snapshot values in service validation; physical `NOT NULL` tightening is deferred until old intents are migrated and observed.
