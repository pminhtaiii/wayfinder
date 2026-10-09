# Plan Review Convergence

**Date**: 2026-09-21
**Scope**: [spec.md](../spec.md), [plan.md](../plan.md), [tasks.md](../tasks.md), design contracts, and [grilling decisions](../../../docs/adr/0009-booking-umbrella-deletion.md).
**Method**: Two independent subagent reviews of architecture and verification against the refreshed `origin/development` source, followed by root-agent decisions and a second pass. The named GSD convergence skill's referenced workflow files and `.planning` configuration are absent here, so its review–revise–review gate was applied to the repository's Spec Kit artifacts.

## Round 1 findings and decisions

| Severity | Finding | Decision and artifact change |
|---|---|---|
| HIGH | The event handler took a lease, but `sweepStaleBookings()` bypassed it and could overlap provider side effects. | Keep the ten-minute sweep and route both event and sweep attempts through one locked per-booking helper. Require duplicate-side-effect tests and hardening where needed. Updated plan, spec, research, event contract, quickstart, and tasks. |
| HIGH | Feature 024's `@OnEvent('booking.**')` projection listener would also receive `booking.reconciliation.requested` and hydrate/upsert a projection with an incomplete event payload. | Retain the approved event name. Filter projection input to catalogued committed events with required fields before hydration and before the existing duration-metric `try/finally`. Add a regression test for zero projection work on request events. |
| MEDIUM | Mocked browser and server-helper tests do not call the new combined Next route handlers directly. | Add direct GET/POST cancellation and quote route-handler contract coverage, including outcome mapping. |
| MEDIUM | A tracked JavaScript E2E fixture contains legacy cancellation URLs even though Jest executes TypeScript fixtures. | Make fixture cleanup explicit in tasks and include the file in the final route reference scan. |

## Round 2 status

The architecture reviewer rechecked the revised design against feature 024 and reported no remaining HIGH or MEDIUM concern. The review confirmed the request-event filter must precede the projection listener's `try/finally`, which records duration on every invocation. The verification reviewer rechecked the final T001–T038 task list and reported no remaining HIGH or MEDIUM concern. Task IDs are sequential, story labels and paths are present, and the earlier route-handler and stale-fixture gaps are covered.

## Implementation gate

This is planning convergence, not implementation evidence. Tests must still prove provider side-effect safety after lease expiry or Redis fallback, projection isolation, route-handler dispatch, and preserved authorization before implementation is considered complete.

## Post-PR route inventory correction

The project owner identified that the ZAP registry, contract test, and OpenAPI fixture still named `POST /bookings/:id/cancel`. The finding is valid: the route would disappear in US3 while the security scan would keep targeting it. US3 now includes migration of all three fixtures, and the final gate runs their contract test and scans them for legacy paths. The current security contract test passed 9/9 before implementation; that baseline still describes the old endpoint until US3 executes.
