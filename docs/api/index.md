# API reference

## Entry points

| Import | Contract |
| --- | --- |
| `@korus-dev/multi-agent-sdk` | Neutral factory and `TypedEventBus`; consumer/UI/native surface types, generation types, diagnostic types, and distinct `NativeHarnessEvent` / `NativeHarnessDriver` / `NativeHarnessContext` types. |
| `/prompt.js` | Pure prompt authoring helpers for browser consumers. |
| `/renderer.js` | Browser-safe capability constants, work-phase helpers, Codex conversation replica, and provider presentation projections. |
| `/surface-bridge.js` | Codex bridge operations and snapshot subscription helpers. |
| `/native.js` | `createNativeHarnessDriver`, Claude/Cursor/Antigravity hosts and native helpers, `sessionMcpServer`, and provider-native integration contracts. |
| `/codex.js` | Native Codex surface/backend and runtime compatibility. |

Paths in this table are appended to `@korus-dev/multi-agent-sdk`. The package root resolves through `main` and `types`; optional modules have small static forwarding files. Application imports do not reference build directories. Use root `import type` declarations for public types. Import optional values from the named modules to preserve browser/Node separation.

```ts
import { createHarnessDriver } from '@korus-dev/multi-agent-sdk';
import type { CodexConversationSnapshot, HarnessEvent, NativeHarnessEvent } from '@korus-dev/multi-agent-sdk';
import { normalizePromptContent } from '@korus-dev/multi-agent-sdk/prompt.js';
```

`HarnessEvent` is the neutral session event contract. `NativeHarnessEvent` retains provider-specific event envelopes; they are intentionally distinct types.

Renderer integrations import `createCodexConversationReplica`, `projectSessionSelection`,
the four `project*Conversation` helpers, capability constants and
`withInferredWorkPhases` / `withInferredTurnWorkPhases` from `/renderer.js`.
Its `CodexConversationReplica`, `ConversationPresentation` and `WorkPhasePart`
types are also available there. This entry loads no native hosts or Node modules.

Node integrations use `/native.js` for `ClaudeConversationHost`,
`ClaudeAgentSdkTransport`, `CursorHost`, `AntigravityHost`, `AcpRuntime`, `AcpSession`,
`installAcpRuntime` and `sessionMcpServer`. Claude skills, transcript, launch and
local authentication helpers are exported there with their option types.

## Factory

`createHarnessDriver(provider, options): HarnessDriver`

Providers are `codex`, `claude`, `cursor`, and `antigravity`. `options.client.name` is required. Optional fields include `home`, `stateDirectory`, context-dependent `instructions` and `mcpServers`, `formatPrompt`, and named provider options. Native provider configuration remains in those named options rather than becoming generic policy.

For a custom Cursor executable, supply the same resolver through `cursor.resolveCommand` (authentication and runtime status) and `cursor.sessionOptions.resolveCommand` (session launch).

## Driver operations

| Group | Methods |
| --- | --- |
| Session lifecycle | `open`, `readSession`, `release`, `close` |
| Restoration | `getSessionData`, `restoreSession`, `getConversationRef`, `getRefData`, `restoreRef` |
| Runtime/account | `getRuntimeStatus`, `authenticate`, `getAccountRateLimits`, `getCapabilities` |
| Catalogs | `listModels`, `listSkills`, `listPlugins` |
| Prompting | `sendPrompt`, `steerPrompt`, `interrupt`, `respondToRequest`, `setPermission` |
| History | `listConversations`, `resumeConversation`, `loadConversation`, `loadOlderHistory`, `loadTurnHistory`, `readConversationMessages`, `readConversationContent` |
| Native mutations | `setConversationTitle`, `archiveConversation`, `deleteConversation`, `forkConversation`, `replaceConversationWithSummary`, `deleteTurn`, `editTurn`, `retryTurn` |
| Goals | `setGoal`, `clearGoal` |
| Auxiliary work | `executeScopedPrompt`, `disposeScopedSession`, `generateText`, `generateImage` |
| Events | `onEvent` returns an unsubscribe function |

Every session operation takes a handle owned by that driver. Methods unsupported by a provider reject. `sendPrompt` returns `Admission`, independently of terminal turn status. Request responses carry an ID and an explicit decision, answers, or cancellation outcome.

See the [consumer contract](../consumer-contract.md) for detailed lifecycle rules and the published declarations for exact parameter/result types. Guides cover [state/events](../guide/events.md), [sessions](../guide/sessions.md), and [tools](../guide/tools.md).
