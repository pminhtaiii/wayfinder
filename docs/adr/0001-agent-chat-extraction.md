# Grilling Session — Extract Agent-Chat from ChatModule

> Captured from grilling session on 2026-09-22.
> Source: architecture-review-2026-09-13.html (Candidate #4: Extract agent-chat from ChatModule).

---

## Context

`ChatModule` hosts both the user-facing `ChatController` (`/chat/*` with `JwtAuthGuard`) and the agent-facing `AgentChatController` (`/agent-gateway/chat/*` with `AgentApiKeyGuard` + `ClaimTokenGuard`). This forces ChatModule to import `AgentAuthModule` from `agent-gateway/auth/` — a dependency that only exists to serve the agent controller. The dependency direction is inverted: a core domain module imports from an edge gateway module.

Additionally, `AttestedFlightSearchModule` (inside `agent-gateway/`) imports the entire `ChatModule` solely to access `ChatMessageCryptoService` for decrypting user messages during honest-degradation keyword checks.

After this refactor, ChatModule becomes a focused, independent module with no gateway dependencies, and the agent-facing chat adapter lives alongside the other agent-gateway sub-modules.

---

## Decision 1 — AgentChatModule lives at `agent-gateway/agent-chat/` ✅

**Problem**: `AgentChatController` and `AgentChatAccessService` currently live in `apps/api/src/chat/` but serve the agent gateway (`/agent-gateway/chat/*` routes). This breaks locality — agent gateway routes are scattered across the `chat/` directory instead of living with the other agent gateway sub-modules.

**Considered options**:

1. **Move to `apps/api/src/agent-gateway/agent-chat/`** — colocated with existing agent-gateway sub-modules (`attested-flight-search/`, `safe-booking-read/`, `booking-readiness/`, `traveler-preferences/`).
2. **Keep in `apps/api/src/chat/` as a separate NestJS module** — an `AgentChatModule` file in the existing `chat/` directory, registered under `AgentGatewayModule`.

**Decision**: Option 1. The other agent-gateway sub-modules already follow this pattern. Physical locality ensures all `/agent-gateway/*` routes, guards, and services live in one subtree. The `chat/` directory becomes purely about user-facing chat.

**What moves**:

| File | Action |
|------|--------|
| `chat/agent-chat.controller.ts` | Move → `agent-gateway/agent-chat/` |
| `chat/agent-chat-access.service.ts` | Move → `agent-gateway/agent-chat/` |
| `chat/agent-chat.controller.spec.ts` | Move → `agent-gateway/agent-chat/` |
| `chat/agent-chat-access.service.spec.ts` | Move → `agent-gateway/agent-chat/` |
| *(new)* `agent-gateway/agent-chat/agent-chat.module.ts` | Create — imports ChatModule, AgentAuthModule, PrismaModule, CacheModule |

---

## Decision 2 — Extract ChatMessageCryptoService to shared infrastructure ✅

**Problem**: `AttestedFlightSearchModule` (in `agent-gateway/`) imports the entire `ChatModule` solely to access `ChatMessageCryptoService`. While the dependency direction is correct (edge → core), it creates unnecessary coupling — AttestedFlightSearch pulls in the full ChatModule (controllers, providers, and all) for one crypto service.

**Considered options**:

1. **Leave it** — the dependency direction is correct, not a seam leak. Don't scope-creep.
2. **Move `ChatMessageCryptoService` whole to `common/`** — pure relocation, consumers import a new `ChatMessageCryptoModule` instead of reaching through `ChatModule`.
3. **Split into generic `AesCryptoService` + chat-specific wrapper** — extract a generic crypto layer to shared infra, keep convenience methods in ChatModule.
4. **Create a `ChatCryptoModule` sub-module inside `chat/`** — more granular module boundary, but AttestedFlightSearch would still import from `chat/`.

**Decision**: Option 2. The service's only dependency is `ConfigService` (globally available). It uses structural typing — no Prisma imports, no chat-internal dependencies. Moving it whole avoids splitting a cohesive ~250-line service into two halves that always get used together. Option 3 over-engineers a split nobody needs yet (no second encryption domain). Option 4 doesn't solve the real coupling — AttestedFlightSearch would still import from `chat/`.

**Key constraint — do NOT merge with existing `EncryptionService`**:

The codebase already has a separate `EncryptionService` at `common/encryption.service.ts`. These two services have intentionally different designs:

| Aspect | `EncryptionService` | `ChatMessageCryptoService` |
|--------|---------------------|---------------------------|
| Key source | `ENCRYPTION_KEY` env vars | `CHAT_ENCRYPTION_KEY` via ConfigService |
| Key management | Multi-key rotation (`candidateKeys[]`) | Single key version |
| Serialization | Colon-delimited string (`iv:authTag:ciphertext`) | Structured object `{ ciphertext, nonce, authTag, keyVersion }` |
| Consumers | Profile, BookingIntent, PassengerSnapshot | ChatService, AttestedFlightSearch |

They remain separate services. This is a relocation, not a redesign.

**Target structure**:

```
apps/api/src/common/
├── encryption.service.ts          (existing, unchanged)
├── encryption.service.spec.ts     (existing, unchanged)
├── chat-message-crypto.service.ts (moved from chat/)
├── chat-message-crypto.module.ts  (new — owns and exports ChatMessageCryptoService)
└── ...
```

**Import changes**:

| Module | Before | After |
|--------|--------|-------|
| `ChatModule` | Owns `ChatMessageCryptoService` as provider + export | Imports `ChatMessageCryptoModule` |
| `AttestedFlightSearchModule` | Imports `ChatModule` for `ChatMessageCryptoService` | Imports `ChatMessageCryptoModule` (drops `ChatModule` import entirely) |
| ~12 test files | Import from `@/chat/chat-message-crypto.service` | Import from `@/common/chat-message-crypto.service` |

---

## Decision 3 — ChatModule exports shrink to `ChatService` only ✅

**Problem**: ChatModule currently exports three services: `ChatService`, `ChatMessageCryptoService`, and `AgentChatAccessService`. After extractions, only `ChatService` remains.

**Post-refactor ChatModule**:

```typescript
@Module({
  imports: [PrismaModule, AuditModule, CacheModule, ChatMessageCryptoModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
```

**What was removed**:
- `AgentChatController` → moved to `AgentChatModule`
- `AgentChatAccessService` → moved to `AgentChatModule`
- `ChatMessageCryptoService` → moved to `ChatMessageCryptoModule`
- `AgentAuthModule` source import and its `imports`-array entry → both removed (the seam leak is fixed); module-metadata/static coverage proves `ChatModule` has no agent-gateway dependency

**Downstream impact**: None. `AgentChatModule` imports `ChatModule` for `ChatService`. `AttestedFlightSearchModule` imports `ChatMessageCryptoModule` for crypto. No consumer loses access to anything it needs.

---

## Post-Refactor Dependency Graph

```
AppModule
├── ChatModule (user-facing /chat/* routes)
│   └── imports: PrismaModule, AuditModule, CacheModule, ChatMessageCryptoModule
│   └── exports: ChatService
│
└── AgentGatewayModule
    ├── AgentChatModule (agent-facing /agent-gateway/chat/* routes)
    │   └── imports: ChatModule, AgentAuthModule, PrismaModule, CacheModule
    ├── AttestedFlightSearchModule
    │   └── imports: PrismaModule, AuditModule, ChatMessageCryptoModule, AgentAuthModule, ...
    ├── SafeBookingReadModule
    ├── AgentBookingReadinessModule
    └── TravelerPreferencesModule

ChatMessageCryptoModule (shared infrastructure)
└── exports: ChatMessageCryptoService
```

**Dependency direction**: All arrows flow from edge → core. No core module imports from edge. The `forwardRef`-free, inversion-free dependency graph is preserved.

---

## What does NOT change

- **API contract**: All routes keep identical paths, request/response shapes, HTTP status codes.
- **Encryption behavior**: `ChatMessageCryptoService` preserves `CHAT_ENCRYPTION_KEY`, ConfigService-based config, structured `{ ciphertext, nonce, authTag, keyVersion }` format, and AAD semantics.
- **Guard behavior**: `AgentApiKeyGuard` + `ClaimTokenGuard` continue protecting all `/agent-gateway/chat/*` routes.
- **ChatService internals**: No changes to session CRUD, message encryption, fencing token validation, or handoff invalidation.
