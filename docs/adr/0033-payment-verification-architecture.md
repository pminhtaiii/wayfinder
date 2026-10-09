# Payment and Fulfillment Verification Architecture

> Status: Accepted target architecture.

Use a layered verification strategy: unit tests cover retry, backoff, and error classification; backend integration tests cover broader failure, persistence, idempotency, replay, and recovery behavior; a controlled Playwright suite with the real frontend, backend, database, and orchestration is the primary repeatable CI gate. Keep a smaller set of real provider sandbox checks for contract confidence. Browser-based exploratory verifier agents complement these gates but do not replace explicit repeatable assertions.

Provider simulations are stateful and isolated per test. The payment simulator keeps independent payment records and events, sends signed webhook requests through the application's real push endpoint, and exposes an explicit test-driver release of provider events as the default. Use actual delays only in timeout tests. The supplier simulator keeps orders independently of HTTP responses and can model both a timeout with no order and a created order whose response was lost. The application interacts only through verified provider capabilities; a separate test-only inspection ledger lets assertions examine simulator state without exposing that state to application code. Run the application against its real database during these scenarios.

This design makes ambiguous external side effects reproducible while keeping the normal CI gate deterministic. It does not imply the harness or all recovery behavior is already implemented.

## Open questions (not approved)

The exact sandbox account support and the detailed provider contract types/classification remain undecided. Test-specific API shapes and the worker/operator ownership mechanism are also open.
