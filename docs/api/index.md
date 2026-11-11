# API reference

## Entry points

| Import | Contract |
| --- | --- |
| `@korus-dev/multi-agent-sdk` | `createHarness`, `HarnessUnsupportedError`, `TypedEventBus`, `TtlCache` and the public types |
| `/prompt` | Pure prompt authoring helpers for browser consumers. |
| `/runtime` | Node helpers that find a provider's executable and build the search path it runs with. |
| `/testing` | Harnesses over scripted providers, for testing an application without a real provider. |
| `/renderer` | Browser-safe capability constants, work-phase helpers, the Codex conversation replica, conversation projections and provider guards. |

Paths in this table are appended to `@korus-dev/multi-agent-sdk`. An explicit exports map resolves the root and extensionless subpaths directly into the published build. Use root `import type` declarations for public types.

```ts
import { createHarness } from '@korus-dev/multi-agent-sdk';
import type { HarnessEvent } from '@korus-dev/multi-agent-sdk';
import { normalizePromptContent } from '@korus-dev/multi-agent-sdk/prompt';
```

Renderer integrations import `createCodexConversationReplica`, `projectSessionSelection`,
the four `project*Conversation` helpers, capability constants, `isHarnessProvider`,
`isProviderConversationRef` and `withInferredWorkPhases` / `withInferredTurnWorkPhases` from `/renderer`.
This entry loads no provider code or Node modules.

## Shared contracts

The common application API is `Harness`, created by `createHarness`. Every provider (Codex, Claude, Cursor, Antigravity) is reached through it.
Shared presentation contracts include `ConversationMessage`, `ConversationMessagePart`,
`Approval`, `ClientAttachment`, `Turn`, `PromptPart` and `ModelDescriptor`.
`Message` remains the agent-bound SDK message type; `ConversationMessage` describes
the presentation transcript.

`TtlCache` and its `TtlCacheOptions`, `TtlCacheRecord`, `TtlCacheScheduler`,
`TtlCacheTimer` and `TtlCacheEvictionContext` types are available from the root.
The caller supplies cache identity, eviction policy and cleanup callbacks.

## Factory

`createHarness(provider, options): Harness`

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
