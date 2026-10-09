# Research and Planning Decisions

**Date**: 2026-09-04. Primary input: `docs/adr/0028-llm-guardrail-architecture.md`. Supporting ADRs: `0030-output-guardrails-architecture.md`, `0002-agent-tool-calling-architecture.md`, `0014-chatbot-backend-architecture.md`, all under `docs/adr/`. The primary guardrail ADR was amended after PR review on 2026-09-04 to align Decisions 2/7/10 with the refined resource and privacy contracts; supporting ADRs remain unchanged.

## Code Evidence

- `apps/agent/src/agent/streaming/sse.py`: input checks live in transport; missing guardrail instance skips classifier.
- `apps/agent/src/agent/chat_turn/runner.py`: output pipeline only; existing causal cleanup must survive.
- `apps/agent/src/agent/graph/nodes.py`: global `ToolNode(get_tools())` executes before raw messages/signals are consumed.
- `apps/agent/src/agent/tools/registry.py`: scoped tool sets already exist, so reuse them for dispatch enforcement.
- `apps/agent/src/agent/guardrails/nemo.py`: guardrails currently call Mimo; output pipeline also permits disabled passthrough.
- `.github/workflows/ci.yml`: lint/type/build/test chains exist, but no named SAST/DAST scanner jobs.
- Existing mocked `apps/agent/tests/test_e2e_output_guardrails.py` is useful integration coverage, not live-stack DAST.

## Resolved Decisions

| Decision | Rationale | Alternative rejected |
|---|---|---|
| Runner supplies mandatory gateway-controlled executor | Validate before ToolMessage/state/model/traces; runner on_tool_end is too late | Event-only checks cannot undo exposure |
| Preserve intent enums; retain valid low-confidence fallback, deny malformed/unknown authority | Seal authority after router/gate with provenance; use explicit downgrade/single-agent policy; see boundary contract | Renaming to ADR shorthand breaks contracts |
| Remove security classifier calls/probes only | Primary/router inference remains; shared Mimo settings may still be needed | Blind deletion of all model configuration |
| Mandatory production registry layers, validated prerequisites | Input size precedes decode; tool size precedes schema/scans; buffer precedes output scan | Unrestricted toggles permit bypass |
| Resource bounds now; new session tool budgets deferred | Amended ADR Decision 7 requires parser/transport safety bounds and defers only new session tool budgets | Unbounded parser/decode pipeline |
| Output hard-stop with withheld suffix | Preserve earlier hard-stop semantics; no already-emitted PII can be recalled | Redact-and-continue or late look-back only |
| Restricted audit subjectRef, not raw userId | Keyed HMAC with keyId permits anomaly correlation while preserving existing telemetry policy | Raw identifiers in general logs/metric labels |
| Per-tool typed models and private control fields | Tool results mix text/JSON; generic JSON shape cannot enforce meaning | Passing raw minimized-looking dicts |
| Semgrep + behavioral contracts; ZAP + custom SSE tests | Static and generic HTTP scanners cannot prove lifecycle/LLM invariants | One scanner score as security proof |
| Coverage/performance targets are proposed acceptance gates | ADR rates retained; actual measurements still required | Claiming regex is inherently sub-millisecond or universally secure |

Initial resource policy proposal: existing MAX_MESSAGE_LENGTH plus 64 KiB raw request envelope; tool envelope 256 KiB; JSON depth 16 and 10,000 nodes; decoding <=2 rounds and <=4x expansion within 64 KiB; pending stream buffer <=8 KiB. T001 validates compatibility and records any evidence-based adjustments before coding. Original and normalized copies are inspected without silently rewriting trusted travel values. Use the explicit 512-scalar detector/lookaround span and raw-source mapping contract; overlong candidates or >8 KiB pending raw text fail closed before emission.

General greetings and contextual follow-ups must pass TopicBoundary; substantive out-of-domain requests redirect. Test-only layer selection is constructor injection, not production configuration. The pseudonymous audit identifier remains access-controlled data with retention/rotation policy and never appears in metric labels.

## Tool Sources Checked 2026-09-04

- ZAP supports OpenAPI scans/authenticated contexts; exit codes distinguish configured findings, warnings and execution failures. Evaluate report policy as well as process status. [ZAP API scan](https://www.zaproxy.org/docs/docker/api-scan/).
- Authenticated scan coverage needs reachability/auth statistics, not repeated 401s. [ZAP target scanning guidance](https://www.zaproxy.org/docs/getting-further/automation/target-scanning-issues/).
- Custom Semgrep rules encode project-specific patterns and require safe/unsafe fixtures. [Semgrep examples](https://semgrep.dev/docs/writing-rules/rule-ideas).
- Pin the OWASP taxonomy edition: the GenAI index exposes 2025 while the foundation landing page advertises 2026. Record the downloaded edition/hash during corpus curation; do not mix numbered categories. OWASP is taxonomy, not a payload benchmark. [GenAI index](https://genai.owasp.org/llm-top-10/), [foundation project](https://owasp.org/www-project-top-10-for-large-language-model-applications/).

Tool installation and version pinning belong to implementation. No scanner ran during planning. Public payload sets require source/license/label review before import; development and holdout variants stay separated by family.

## Deferred

Production canaries, live-model campaigns, neural judges, general toxicity filtering, new transport endpoints and new per-session tool quotas. None exempts structural authorization/privacy gates.

Review refinement: raw byte ceilings apply before JSON parsing, not only inside post-parse pipelines; bound chunked and decompressed reads. Treat persisted history/summaries as untrusted model input. Include all changed boundary modules in measured coverage, including transport, tools and memory. These resolve implementation gaps; the subsequent PR-review amendment aligns the source ADR resource and telemetry requirements with these contracts.

Cycle-1 convergence decisions are specified in `contracts/guardrail-boundaries.md`: revised invalid-router fallback authority, stage-local detector denominators, test-profile quotas/reset/sharding, bounded output format inventory, lower-trust memory framing, generated-summary validation and model callback isolation. These are explicit changes to old behavior, not claims that current code implements them.
