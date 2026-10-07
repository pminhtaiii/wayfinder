# Controlled test harness contract

Status: PLANNED. This describes implementation requirements, not an available harness. See [provider operations](provider-operations.md), [data model](../data-model.md), and [acceptance matrix](../acceptance-matrix.md).

## Boundary and fidelity

Run real Next.js routes/server actions and authenticated sessions, NestJS controllers/guards/application orchestration, PostgreSQL migrations/repositories, Redis coordination, recovery workers, production provider adapters, signature verification and response classification. Drive the customer browser through sign-in, search, selection, passengers, ancillary selection, review, payment and confirmation. Persist and assert the selected itinerary/passengers/ancillaries, authoritative price, customer payment, supplier order and workflow evidence.

Substitute external Stripe and Duffel only at HTTP transport or installed SDK transport configuration. No fulfillment/payment core service overrides, fake successful adapter responses, or direct writes of final booking outcomes are permitted. Search and ancillary transport fixtures must support the actual server-side calls. Application-facing Stripe endpoints expose realistic manual-authorization, capture, retrieve, cancel and refund contracts; Duffel exposes supported search/offer/service/order/cancellation contracts with independently stored records. Test fixtures follow verified provider fields; unsupported discovery or idempotency guarantees must not be invented.

Customer Stripe amount/currency and supplier instant-order balance amount/currency are separate ledger fields. Use a deliberately different valid pair to detect incorrect mapping. Successful create uses the supplier authoritative balance values, never the traveler charge. Validate itinerary, passenger and durable booking linkage before capture or compensation.

Stripe Elements/payment browser wiring must invoke the actual create/confirm/status APIs and show pending/resume status. A narrowly scoped test implementation of the external browser Stripe client may tokenize/confirm through the simulator, preserving the application integration calls, validation and resulting PaymentIntent transitions. It must not replace the application's payment UI or payment service. Real SDK/Elements behavior requires the separate sandbox contract check; controlled tests do not prove real card-network behavior.

## Isolation and access

Each test allocates an opaque run ID, unique disposable PostgreSQL database or schema with its own migration lifecycle, Redis prefix/database, provider ledgers, signing secret, scheduler clock, generated users and scenario seed. All processes for that run must share its explicit identifiers; reject cross-run reads/writes. Do not reuse development databases or provider accounts.

Run simulators on loopback only. Provider requests use a run-scoped simulator API credential; driver routes use a different secret unavailable to application processes. Application credentials grant only provider capabilities. A test runner owns inspection routes, and no production application code can fetch inspection/control endpoints. Do not place driver authentication tokens in frontend bundles. Startup fails on production provider keys, non-loopback provider origins, missing isolation metadata or an unexpected database target. Production builds must omit the test server/driver modules and ignore/reject test configuration; verify this exclusion.

## Proposed driver API

These shapes are a test-control protocol, not a supplier/payment production API. Require loopback source and bearer driver credential, validate run ID on every route, return 404 for another run, and return redacted JSON.

| Operation | Driver request | Meaning |
| --- | --- | --- |
| Allocate | POST /driver/runs with scenario, seed, startTime | Create isolated namespace; return runId and application-facing origins/credentials separately from driver token. |
| Select fault | POST /driver/runs/{runId}/scenarios with provider, operation, match and outcome | Before dispatch, select a registered operation-specific scenario; match uses a ledger record or booking correlation known by fixtures, never an invented provider unique lookup. |
| Inspect | GET /driver/runs/{runId}/ledger?provider=stripe or duffel | Read independent records, received requests, side-effect counts, pending events and ordered observations. Application has no access. |
| Release event | POST /driver/runs/{runId}/events/{eventId}/release with copies and deliveryOrder | Send genuine serialized payload, signed with the run webhook secret, to the real application ingress; allow duplicate and selected out-of-order delivery. Record ingress status. |
| Release response | POST /driver/runs/{runId}/responses/{responseId}/release | Finish a held transport request or deliver a deliberately stale response after claim takeover. |
| Advance clock | POST /driver/runs/{runId}/clock/advance with milliseconds | Advance the injected recovery scheduling clock and due-time scheduler only; never claim this advances PostgreSQL lease time. Drain only due tasks within an explicit maximum work budget. Return executed job IDs and nextDueAt. |
| Step scheduler | POST /driver/runs/{runId}/scheduler/drain with maxJobs | Run due real worker work to quiescence or fail on exceeded budget; never manufacture a workflow outcome. |
| Teardown | DELETE /driver/runs/{runId} | Cancel pending deliveries/jobs, stop owned processes and remove only the proven run namespace; return cleanup report. |

The scheduling clock seam supplies recovery due-time interfaces; production uses real time. Claim acquisition, renewal and expiry predicates always use PostgreSQL time. Lease-expiry scenarios use an isolated short-lease configuration, real elapsed DB time and response barriers; a virtual scheduler advance is not lease-expiry evidence. It changes elapsed time, not provider evidence. Explicitly configure provider authorization expiry evidence separately. Webhook signing timestamps and verification clock must remain coherent; stale-signature scenarios intentionally exceed tolerance and must fail.

Scenario registration is finite, versioned and rejects unsupported operation/outcome pairs. Required create modes: confirmed; verified definitive rejection; no-create/lost response; create committed/lost response; processing; unavailable/rate-limited read; zero/multiple/unlinked discovery candidates; held late response. Required capture modes: confirmed; definitive rejection; committed/lost response; uncommitted/lost response; processing. Cancellation, authorization release and refund need confirmed/definitive/unknown modes with independent ledger effects. A timeout without a ledger order is not application proof of absence.

All dispatches have an observation sequence, operation correlation and separate request/side-effect counts. Assert real persisted logical operation identity across retries and new attempt identities per execution. Retain pre-dispatch possibly-sent evidence even if the simulator saw no request. Inspection reveals ground truth to assertions only; the application must reach conclusions solely through supported retrieve/discovery/events.

## Deterministic execution and evidence

Default event delivery is explicit. Advance 15 minutes and worker due times without wall-clock sleeps; assert polling starts immediately, remains bounded by retry/rate budgets, continues after escalation and never resets first uncertainty time. Use barriers to stage a provider request in flight, process restart, expired lease takeover and operator/worker races. Release the old response afterwards; it may add valid evidence but cannot advance state with a stale fence.

Only targeted transport-timeout tests and short PostgreSQL lease-expiry checks use real elapsed time. Preserve production create timeout of at least 130 seconds for a provider that may take 120 seconds; a reduced test timeout does not demonstrate that production threshold. Tag the actual-threshold test separately with a suitable test timeout and service budget.

Collect browser trace, redacted transport transcript, ledger snapshot, persisted evidence/claim/operation/attempt state and operator audit. Strip secrets, client secrets, credentials and personal payment details before artifact upload. Do not print environment files or full environment objects. Reliable teardown runs in finally/runner shutdown and reports leaked resources as failure; orphan cleanup verifies ownership before deletion.
