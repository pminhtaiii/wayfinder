# Phase 0 Research: Traveler Profile & Booking Readiness

## Decision 1: Canonical field rules

**Decision**: Use the named field list, not the ADR's counts. Eleven new profile fields are required. Domestic readiness requires five identity fields plus three contact fields; `middleName` is optional. International adds the five-field travel-document section.

**Rationale**: `CONTEXT.md` is the canonical glossary and resolves both arithmetic inconsistencies in the accepted ADR.

**Alternatives considered**: Treating `middleName` as required or treating the ADR's “10 fields” statement as authoritative; both contradict explicit decisions.

## Decision 2: Additive passport-expiry migration

**Decision**: Keep the logical `passportExpiry` name and legacy `DateTime?` column, add an internal nullable AES-GCM ciphertext shadow, and dual-read/dual-write for the full rollback window. Backfill with revision/value predicates and decrypt/compare verification. Defer clearing and legacy-column removal.

**Rationale**: The live schema cannot store ciphertext in a date column, and an in-place type conversion is not safely reversible for production data.

**Alternatives considered**: Rename the field; destructively convert the column to text; leave expiry unprotected. Each violates an ADR or security/rollback constraint.

## Decision 3: Scope from stored itinerary data

**Decision**: Derive scope server-side by resolving every segment origin/destination through the existing airport country data. Missing airport-country data produces an unknown/non-ready result.

**Rationale**: The current browser heuristic checks only the first origin and final destination and can misclassify mixed routes. The evaluator must not trust client-provided scope.

**Alternatives considered**: Browser-derived scope; supplier call on each readiness request. The first is unsafe and the second wastes API budget.

## Decision 4: One evaluator for advisory and authoritative checks

**Decision**: Implement a pure evaluator inside `booking-intent/`, with I/O orchestration in existing services.

**Rationale**: It guarantees rule parity and keeps offer/profile concerns out of `profile/` without creating a one-function module.

**Alternatives considered**: Duplicate endpoint validation; evaluator in `profile/`; standalone readiness module. All were rejected in the ADR.

## Decision 5: Compatible contract migration

**Decision**: Make plural intent endpoints and the passenger `source` union canonical, while retaining temporary singular endpoint aliases. Reject payloads that mix the legacy `useProfile` flag with `source`; migrate first-party callers before alias removal.

**Rationale**: Existing checkout, payment, ancillary, and tests use the singular route and legacy flag. A compatibility window preserves deployability.

**Alternatives considered**: Immediate breaking replacement; permanent duplicate contracts. The first is big-bang, the second creates permanent drift.

## Decision 6: PII exposure rules

**Decision**: Full profile values are available only to the authenticated secure profile form. Booking-intent reads expose masked summaries. Gateway/chat/SSE payloads contain only passenger type/ordinal, names of fields/sections, statuses, reason codes, and safe navigation metadata.

**Rationale**: This satisfies the accepted trust boundary while still allowing a traveler to correct stored data.

**Alternatives considered**: Decrypted passport values on intent reads; partial identity collection in chat. Both violate the ADR.

## Decision 7: No new dependency

**Decision**: Use the installed NestJS, Prisma, class-validator, Next.js, FastAPI/LangChain, and existing encryption/audit utilities.

**Rationale**: Every capability already exists in the repository; adding a library would increase review and supply-chain surface without value.

**Alternatives considered**: A validation framework or standalone encryption package. Existing pure TypeScript and `EncryptionService` are sufficient.

## Decision 8: Revision tokens and bound ciphertext

**Decision**: Add a non-PII profile revision token used by PATCH, readiness, and profile-sourced intent creation. Bind new snapshot ciphertext to schema version, intent, passenger position, and field using AES-GCM AAD.

**Rationale**: Revision checks prove the authoritative snapshot is the profile version the traveler reviewed. AAD detects otherwise-valid ciphertext copied between passengers or intents.

**Alternatives considered**: Timestamp-only best effort; database row locks spanning advisory/user time; authentication tags without record identity. None closes both concurrency and substitution gaps.

## Decision 9: Final validation uses the existing idempotency owner

**Decision**: Authenticate/decrypt and validate only inside the current payment/order claim after versions are frozen and immediately before the one owned Duffel call.

**Rationale**: Expiry cannot be validated before decrypting it, and a separate `SUBMITTING` state machine would duplicate existing payment idempotency/recovery behavior.

**Alternatives considered**: Validation outside the claim; a second lease/state machine. The first has a race and the second adds conflicting ownership.

## Decision 10: Missing country data is a domain result

**Decision**: Advisory readiness returns `200` with blocking `scope: UNKNOWN`; authoritative creation returns `422 BOOKING_NOT_READY` embedding the same result. Reserve `503` for infrastructure failure.

**Rationale**: The evaluator remains identical in both paths while HTTP semantics distinguish advisory display from an attempted mutation.

**Alternatives considered**: `503 SCOPE_UNAVAILABLE` for all cases. That conflates incomplete reference data with service failure and hides the normal status structure.

## Resolved unknowns

No `NEEDS CLARIFICATION` items remain. Deferred product capabilities are companion profiles, frequent-flyer/KTN/redress data, and destination-specific immigration rules.
