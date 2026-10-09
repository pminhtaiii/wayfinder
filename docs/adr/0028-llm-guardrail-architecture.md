# Deterministic LLM Guardrail Architecture Decisions

> **Date**: 2026-09-04
> **Status**: Accepted (resource and telemetry contracts amended 2026-09-04)
> **Scope**: Deterministic LLM Guardrail System — Unified gateway, layer composition, enforcement points, and threat mitigation.
> **Builds on**: [0030-output-guardrails-architecture.md](./0030-output-guardrails-architecture.md), [0002-agent-tool-calling-architecture.md](./0002-agent-tool-calling-architecture.md), [0014-chatbot-backend-architecture.md](./0014-chatbot-backend-architecture.md)

---

## Context

To secure the flight booking conversational agent against prompt injections, PII leakage, and unauthorized tool execution, the system requires an end-to-end security boundary. Previous validation logic was fragmented across transport adapters (`sse.py`) and partial output pipelines, introducing bypass vectors and inconsistent enforcement. This document codifies decisions from the grilling session to establish a deterministic, high-throughput, and structurally enforced guardrail architecture across the turn lifecycle.

---

## Decision 1: GuardrailGateway Architecture (Unified Facade)

**Decision**: Create a standalone `GuardrailGateway` facade class that centrally owns all input validation, tool output inspection, and streaming output validation as a cohesive pipeline.

**Considered Options**:
- *Scattered guardrails across `sse.py` and `output_pipeline.py`*: Rejected. Distributing security checks across transport layers and pipeline helpers creates split responsibilities, maintenance drift, and high risk of bypassing validation on new transport adapters (e.g., WebSocket, Batch).
- *Adding contract tests without architectural refactoring*: Rejected. Tests verify existing behavior but do not eliminate the structural defect of fragmented enforcement points.

**Rationale**: The `GuardrailGateway` establishes a single chokepoint and single source of truth for security enforcement. All validation logic lives behind a clean facade, ensuring every interaction passes uniform checks regardless of entry point.

---

## Decision 2: ChatController Layer & Decoupled Transports

**Decision**: Introduce a thin `ChatController` layer positioned between transport adapters (SSE, WebSocket, Batch) and the `ChatTurnRunner`. The controller operates as a dumb delegator following the Ports & Adapters (Hexagonal) pattern. Transport adapters own no guardrail content policy; authentication/admission and bounded raw-body framing remain transport responsibilities before JSON parsing. Redundant modules such as `SessionManager` or `HistoryLogger` are explicitly omitted.

**Considered Options**:
- *Transport adapters directly instantiating `ChatTurnRunner`*: Rejected. Direct coupling leaks orchestration internals into transport handlers and duplicates session wiring across transports.
- *Introducing new `SessionManager` and `HistoryLogger` modules*: Rejected. Session fencing is already handled via Redis distributed locks/fencing tokens, and encrypted chat persistence is managed by NestJS `ChatService` using AES-256-GCM. Adding wrapper modules in the agent runner introduces unnecessary indirection and state synchronization overhead.

**Rationale**: `ChatController` cleanly decouples protocol ingestion from domain execution while avoiding reinventing session and persistence guarantees already provided by the existing infrastructure.

---

## Decision 3: Runner Owns Enforcement Points (Lifecycle Control)

**Decision**: The `ChatTurnRunner` owns all three guardrail enforcement points across the turn lifecycle:
1. **Pre-execution**: Before graph execution → `InputPipeline`
2. **Post-tool execution**: After tool execution → `ToolOutputPipeline`
3. **Stream generation**: During token streaming → `OutputPipeline`

The runner decides **WHEN** to invoke guardrails; the `GuardrailGateway` decides **HOW** validation is executed.

**Considered Options**:
- *Controller-owned guardrail enforcement*: Rejected. The controller lacks visibility into graph execution states, intermediate tool invocations, and streaming chunk generation.

**Rationale**: Clear separation of concerns: execution lifecycle belongs to the runner, while security policies belong to the gateway. Placing invocation points inside the runner guarantees enforcement at critical state transitions.

---

## Decision 4: Closed Plugin Registry for Layer Composition

**Decision**: Compose guardrail layers via an in-code closed plugin registry. Available layers conform to a strict `GuardrailLayer` protocol and are pre-registered with string keys (e.g., `'length'`, `'pii'`, `'injection'`, `'topic'`). Runtime configuration can toggle or reorder trusted layers, but dynamic loading of arbitrary Python classes from configuration strings is strictly forbidden.

**Considered Options**:
- *Fixed hardcoded pipeline*: Rejected. Prevents toggling layers for testing environments or adjusting layer ordering based on performance metrics.
- *Open registry loading classes dynamically from config paths*: Rejected. Loading classes from arbitrary strings creates an untrusted code execution / class-injection vulnerability.

**Rationale**: The closed registry provides operational flexibility to reorder and toggle security stages while enforcing an immutable code boundary that cannot be hijacked via configuration tampering.

---

## Decision 5: Deterministic-Only Guardrails (No LLM Judge)

**Decision**: Implement exclusively deterministic guardrail layers for the initial phase (regular expressions, compiled pattern matching, token bounds, PII detectors, and Pydantic schema validation). Replace existing Mimo LLM classifier calls in the output pipeline with deterministic checks. LLM-as-a-judge evaluators are deferred to a future phase.

**Considered Options**:
- *LLM-based security evaluator (LLM Judge / NeMo neural classifier)*: Rejected for Phase 1. Secondary LLM calls introduce significant token costs, 200–500ms latency per check, non-deterministic false positives, and introduce their own prompt injection and jailbreak attack surface.

**Rationale**: The primary LLM is already a non-deterministic boundary. Defending non-determinism with another non-deterministic model compounds complexity and failure modes. Deterministic checks guarantee sub-millisecond execution, zero token cost, and predictable, testable behavior.

---

## Decision 6: Guardrail Layer Inventory

**Decision**: Deploy a focused 10-layer inventory distributed across the three pipeline stages:

1. **InputPipeline (4 layers)**:
   - `LengthValidator`: Rejects oversized payloads to prevent buffer saturation and context exhaustion.
   - `PIIDetector`: Scans and intercepts user-submitted sensitive credentials and identity markers.
   - `InjectionDetector`: Comprehensive injection defense expanded from 4 basic regexes to 50+ patterns, paired with Unicode normalization (NFKC), control token stripping, and multi-encoding decoding (Base64/Hex/URL).
   - `TopicBoundary`: Enforces conversational adherence strictly within travel and flight booking domains.

2. **ToolOutputPipeline (4 layers)**:
   - `SizeStructureValidator`: Enforces payload byte limits and valid structural envelopes.
   - `SchemaValidator`: Validates data structures against rigid Pydantic tool schemas.
   - `PIIScanner`: Inspects upstream tool payloads to prevent upstream data leaks from entering the prompt context.
   - `UntrustedContentInjectionDetector`: Scans third-party API payloads for indirect prompt injections attempting to hijack model execution.

3. **OutputPipeline (2 layers)**:
   - `ChunkBuffer`: Sliding-window token/sentence buffer preventing PII patterns from spanning chunk boundaries unnoticed.
   - `PIIScanner`: Real-time streaming redaction and interception for generated tokens.
   - *Deferred*: General toxicity and harmful content filters, as the agent operates read-only under a tightly constrained system prompt.

**Considered Options**:
- *Monolithic full-scan on final output*: Rejected. Breaks token streaming user experience and introduces severe latency spikes.
- *Omitting tool output scanning*: Rejected. Exposes the agent to indirect prompt injection vulnerabilities originating from third-party vendor responses.

**Rationale**: Layered, stage-specific boundaries address distinct threat vectors: direct attacks on input, data pollution and indirect injection on tools, and privacy leakage on output streaming.

---

## Decision 7: Least Privilege Controls (Allowlisting & Minimization)

**Decision**: Enforce two structural least-privilege mechanisms:
1. **Per-turn tool allowlisting**: The intent router categorizes queries (`travel`, `checkout`, `general`). Each intent maps to an explicit tool whitelist. A general conversation turn is assigned zero tools, mitigating blast radius if an injection manages to bypass input filters.
2. **Tool payload data minimization**: Raw tool responses are filtered and stripped of extraneous metadata before ingestion into LLM context, exposing only the exact schema fields needed.
3. **Required resource-safety bounds in the initial delivery**: Enforce bounded raw request reads before JSON decoding and bounded upstream tool-response reads before JSON parsing, including decompressed bytes. Missing, incorrect, or chunked `Content-Length` must not bypass the limits. Bound JSON depth/node count, decoding rounds/expansion, and pending output buffers; fail closed on overflow. These parser and transport safety limits are distinct from business quotas and are not deferred.
4. **Deferred beyond the initial delivery**: New per-session tool invocation budgets. Existing admission and API quotas remain enforced. The initial numeric limits and compatibility checks are defined in [Feature 023 research](../../specs/023-security-systems/research.md); enforcement and overflow behavior follow the [boundary contracts](../../specs/023-security-systems/contracts/guardrail-boundaries.md).

**Considered Options**:
- *Global tool availability for every turn*: Rejected. Giving every turn full access to all tools maximizes the blast radius of any prompt extraction or tool hijack attempt.

**Rationale**: Restricting tool availability per intent drastically limits an attacker's exploitation window even in the event of an injection bypass.

---

## Decision 8: Block Response Strategy (Static Responses)

**Decision**: Guardrail blocks return static, deterministic messages defined in code. Guardrail responses are NEVER synthesized by the LLM.
- **PII blocks**: Transparent and helpful (instructs user to remove sensitive credentials/information).
- **Injection blocks**: Opaque and generic (e.g., *"I was unable to process that request. Could you please rephrase?"*), denying attackers feedback regarding triggered signatures.
- **Topic boundary violations**: Polite domain redirect back to flight search and booking assistance.
- **Tool pipeline blocks**: Fail-closed internally without exposing internal error envelopes to the user (returns clean fallback or scrubbed result).

**Considered Options**:
- *Dynamic LLM-generated refusal explanations*: Rejected. LLMs can hallucinate, echo malicious payloads, or be jailbroken during refusal generation.
- *Detailed diagnostic error codes to client on injection*: Rejected. Exposing exact matched patterns or layer names assists attackers in tailoring evasion payloads.

**Rationale**: Deterministic block messages prevent feedback loops that facilitate adversarial evasion while providing constructive guidance to benign users.

---

## Decision 9: Two-Tier Testing Strategy

**Decision**: Establish a quantitative, two-tier validation suite:
- **Tier 1 (Unit Tests)**: Granular per-layer unit tests covering known-bad inputs (must block), known-good inputs (must pass), and edge-case boundary conditions.
- **Tier 2 (DAST Adversarial Suite)**: End-to-end evaluation pipeline using 200+ attack payloads compiled from public benchmarks (HuggingFace prompt-injections, OWASP Top 10 for LLM Applications).
- **Success Criteria**: Minimum 95% True Positive Rate (TPR) for attacks, maximum 2% False Positive Rate (FPR) on benign queries.
- **Deferred**: Automated production canary probing deferred to Phase 2.

**Considered Options**:
- *Relying solely on unit tests with synthetic strings*: Rejected. Synthetic unit tests fail to reflect the diversity of obfuscated adversarial injection attacks.

**Rationale**: High-volume adversarial testing against standardized datasets provides empirical confidence in boundary effectiveness prior to release.

---

## Decision 10: Unified Observability & Security Metrics

**Decision**: Implement a centralized `SecurityEventEmitter` that publishes structured audit events on every guardrail decision. Log records include `layerName`, `decision` (`PASS` / `BLOCK`), `durationMs`, and the established structured trace fields. Restricted security audit records may also include `subjectRef` (a keyed HMAC of the authenticated user identity) and `keyId` for controlled anomaly correlation. Raw `userId`, prompts, tool/model payloads, credentials, and PII must not be emitted. Pseudonyms remain access-controlled data with documented key rotation and retention; neither raw identifiers nor `subjectRef` may be metric labels. Metrics use bounded labels for per-layer block rates and latency; false-positive trends come from labeled evaluation or triage, not block counts alone. See the [SecurityEvent model](../../specs/023-security-systems/data-model.md) and tasks T042–T045 in the [canonical checklist](../../specs/023-security-systems/tasks.md).

**Considered Options**:
- *Unstructured stderr/stdout application logging*: Rejected. Prevents real-time alerting, trend analysis, and immediate anomaly detection.

**Rationale**: Structured telemetry allows operators to identify attack campaigns, monitor latency overhead per layer, and detect regression anomalies promptly without persisting sensitive payload data.

## Amendment: Resource and Telemetry Contract Alignment (2026-09-04)

PR review identified conflicts between Decisions 7/10 and the refined Feature 023 acceptance contracts. This amendment supersedes the original deferral of rigid payload byte caps and raw `userId` audit field: bounded pre-parse resource controls are required, while new per-session tool budgets remain deferred; audit correlation uses restricted pseudonymous `subjectRef`/`keyId` with no identifier metric labels. Decision 2 now distinguishes content guardrails from required transport authentication and framing. These are accepted design requirements, not a claim that runtime enforcement is already implemented.
