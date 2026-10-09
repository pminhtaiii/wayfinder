# Output Guardrails Architecture

**Date**: 2026-07-03 | **Source**: Grilling session — UI-to-backend integration

---

## Problem

The LLM streams tokens directly to the user's browser via SSE. Without output-side filtering, the model may:

- Leak PII (emails, phone numbers, passport numbers, credit card numbers) from its training data or conversation context.
- Generate harmful, inappropriate, or policy-violating content.

Input guardrails (NeMo) already validate the **user's message** before it reaches the LLM. This document covers guardrails on the **LLM's response** before it reaches the user.

---

## Decisions

### 1. Sentence-Boundary Chunking (not fixed token size)

**Decision**: Split LLM output into chunks at sentence boundaries (`.`, `!`, `?`, `\n`) instead of fixed token counts.

**Rationale**: Fixed-size chunks (e.g., 50–100 tokens) may split a sentence mid-thought, giving the guardrail incomplete semantic context. A sentence like _"The passenger's passport number is"_ split at token 50 might pass the guardrail, with the actual number appearing in the next chunk as bare digits — harder to flag without context. Sentence-boundary chunking ensures the guardrail always sees complete thoughts.

**Implementation**: Accumulate tokens from the LLM stream. Detect sentence-ending punctuation followed by whitespace or end-of-stream. When a boundary is found, the accumulated tokens form a complete chunk ready for guardrail processing.

---

### 2. Pipeline Parallelism

**Decision**: While streaming chunk N to the user, simultaneously run guardrail checks on chunk N+1.

**Rationale**: Without pipelining, the user experiences a pause between every chunk while the guardrail runs (~100–300ms for NeMo). Pipeline parallelism hides this latency — the guardrail check for the next chunk happens concurrently with the user receiving the current chunk.

**Flow**:

```text
Time →
───────────────────────────────────────────────
Chunk 1:  [Guard ✓] [Stream to user ──────────]
Chunk 2:             [Guard ✓] [Stream to user ──────────]
Chunk 3:                        [Guard ✓] [Stream to user ──]
```

The first chunk has unavoidable latency (no previous chunk to overlap with). All subsequent chunks benefit from the overlap.

---

### 3. Cross-Chunk Sliding Window for Boundary PII

**Decision**: Even with sentence-boundary chunking, run an additional boundary check that tests the **tail of chunk N-1** concatenated with the **head of chunk N**.

**Rationale**: Some PII patterns span sentence boundaries. Example:

> _"Please contact John at john.doe@. gmail.com for details."_

Or multi-sentence PII reveals:

> _"The cardholder's name is John Smith. His card ends in 4242."_

Each sentence individually may pass guardrails, but concatenated they reveal PII.

**Implementation**: Maintain a sliding window of the last 30 tokens from the previous chunk. Before running the main guardrail on chunk N, concatenate `[tail of N-1] + [head of N]` (60-token overlap) and run the regex PII scanner on this overlap region. If the overlap check fails, treat it as a chunk N failure (hard stop).

---

### 4. Layered Guardrail Checks (Regex PII + NeMo Output Rail)

**Decision**: Run two guardrail layers on every chunk, in order:

1. **Regex PII scanner** (~1ms, near-instant):
   - Pattern-match for: email addresses, phone numbers, passport numbers, credit card numbers, SSNs, and other structured PII formats.
   - Runs on the chunk AND the sliding window overlap region.
   - If this fails → hard stop immediately (no need to run NeMo).

2. **NeMo output rail** (~100–300ms):
   - Runs the NeMo Guardrails engine in output-check mode.
   - Catches nuanced harmful content: policy violations, toxic language, prompt injection artifacts, subtle PII references that don't match regex patterns.
   - Only runs if the regex PII scan passes.

**Rationale**: Layering provides both speed and depth. The regex scan is essentially free and catches the most common, structured PII leaks instantly. NeMo catches the subtle, unstructured threats that regex can't. Running regex first avoids wasting ~200ms on a NeMo call when the violation is obvious.

---

### 5. Hard Stop on Failure

**Decision**: If any chunk fails any guardrail layer, **immediately kill the stream**.

**Actions on failure**:

1. Stop consuming tokens from the LLM.
2. Send an SSE error event to the browser: `event: error`, `data: {"code": "OUTPUT_GUARDRAIL_BLOCKED", "message": "Response was blocked for safety reasons.", "partialMessageId": "uuid | null"}`.
3. Persist the user's message and the partial agent response (up to the last safe chunk) to NestJS via the batch message endpoint.
4. Log a structured security event (no PII in logs — log the guardrail rule that triggered, not the content).

**Rejected alternative — Redact and continue**: Replacing the offending chunk with `[redacted]` and continuing the stream was considered and rejected. The surrounding context (previous and subsequent chunks) may still reveal the sensitive information through inference. Hard stop is the only safe failure mode.

---

## Full Pipeline Flow

```text
LLM generates tokens continuously
        ↓
Accumulate tokens in buffer
        ↓
Sentence boundary detected? (. ! ? \n + whitespace/EOF)
        ├── No  → continue accumulating
        └── Yes → chunk ready
                    ↓
            ┌─ Sliding window boundary check ─┐
            │  [tail 30 tokens of chunk N-1]   │
            │  + [head 30 tokens of chunk N]   │
            │  → Regex PII scan               │
            └──────────────────────────────────┘
                    ↓ Pass?
            ┌─ Layer 1: Regex PII scan ────────┐
            │  Full chunk N content             │
            │  → Pattern match PII formats      │
            └──────────────────────────────────┘
                    ↓ Pass?
            ┌─ Layer 2: NeMo output rail ──────┐
            │  Full chunk N content             │
            │  → Safety + harmful content check │
            └──────────────────────────────────┘
                    ↓ Pass?
            Stream chunk N to browser via SSE
                    ↓
            Meanwhile: pipeline-parallel guardrail
            check on chunk N+1 runs concurrently
```

**On any failure at any layer**: Hard stop → error SSE event → persist partial → log security event.

---

## SSE Event Extension

New error code added to the SSE contract:

| Code                       | HTTP Status | Description                                    |
| -------------------------- | ----------- | ---------------------------------------------- |
| `OUTPUT_GUARDRAIL_BLOCKED` | 200 (SSE)   | LLM output blocked by output safety guardrails |

This is returned as an SSE error event (HTTP 200) because the SSE connection is already established when the output guardrail triggers.

---

## Open Questions (for implementation phase)

1. **Sentence detection edge cases**: How to handle code blocks, URLs, or numbered lists where `.` doesn't indicate a sentence boundary? Likely need a lightweight sentence tokenizer rather than pure regex.
2. **Sliding window token count**: The ~20 token overlap is a starting estimate. May need tuning based on real PII patterns observed during testing.
3. **NeMo output rail configuration**: Need to define the specific Colang rules for output checking. The existing NeMo config handles input rails only.
4. **Streaming UX**: With sentence-boundary chunking, the user sees text appear in sentence bursts rather than token-by-token. Verify this feels acceptable in the chat UI — may need a typewriter animation on the frontend to smooth out the bursty arrival.
