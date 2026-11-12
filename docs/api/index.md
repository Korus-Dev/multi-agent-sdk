# API reference

## Entry points

| Import | Contract |
| --- | --- |
| `@korus-dev/multi-agent-sdk` | `createHarness`, `HarnessUnsupportedError`, `TypedEventBus`, `TtlCache` and the public types |
| `/prompt` | Pure prompt authoring helpers for browser consumers. |
| `/runtime` | Node helpers that find a provider's executable and build the search path it runs with. |
| `/testing` | Harnesses over scripted providers, for testing an application without a real provider. |
| `/contracts` | Capability tables, session patches, guards and data helpers with no Node dependencies, for code that runs in a browser. |
| `/codex`, `/claude`, `/cursor`, `/antigravity` | That provider's own types, for apps that deliberately read provider-specific detail. |

Paths in this table are appended to `@korus-dev/multi-agent-sdk`. An explicit exports map resolves the root and extensionless subpaths directly into the published build. Use root `import type` declarations for public types.

```ts
import { createHarness } from '@korus-dev/multi-agent-sdk';
import type { HarnessEvent } from '@korus-dev/multi-agent-sdk';
import { normalizePromptContent } from '@korus-dev/multi-agent-sdk/prompt';
```

Browser code imports `applySessionPatch`, the capability tables (`codexHarnessCapabilities` and its siblings), `isHarnessProvider`, `isProviderConversationRef`,
the session-data helpers (`sessionConversationId`, `sessionConversationRef`, `sameConversationRef`) and the request conversions from `/contracts`.
This entry loads no provider code or Node modules.

## Shared contracts

The common application API is `Harness`, created by `createHarness`. Every provider (Codex, Claude, Cursor, Antigravity) is reached through it.
Shared contracts are provider-neutral: `Message`, `MessagePart`, `AgentRequest`,
`AgentRequestResponse`, `ProviderApprovalRequest`, `ProviderApprovalDecision`, `Turn`,
`PromptPart`, `PromptReferenceAttachment` and `ModelOption`.
Codex's own message and request shapes are available as `CodexConversationMessage` and
`CodexClientRequest` from `/codex`, for apps that read Codex snapshots and events.

`TtlCache` and its `TtlCacheOptions`, `TtlCacheRecord`, `TtlCacheScheduler`,
`TtlCacheTimer` and `TtlCacheEvictionContext` types are available from the root.
The caller supplies cache identity, eviction policy and cleanup callbacks.

## Factory

`createHarness(provider, options): Harness`

Providers are `codex`, `claude`, `cursor`, and `antigravity`. `options.client.name` is required. Optional fields include `home`, `stateDirectory`, context-dependent `instructions` and `mcpServers`, `formatPrompt`, and named provider options. Native provider configuration remains in those named options rather than becoming generic policy.

Each provider runs the CLI installed on the machine. To use another executable, name it in that provider's options: `cursor.command`, `antigravity.command`, or `claude.launch`.

## Harness operations

| Group | Methods |
| --- | --- |
| Session lifecycle | `open`, `readSession`, `readSessionSnapshot`, `syncSession`, `updateDefaults`, `release`, `close` |
| Restoration | `getSessionData`, `restoreSession`, `getConversationRef`, `getRefData`, `restoreRef` |
| Runtime and account | `getRuntimeStatus`, `authenticate`, `getAccountRateLimits`, `getBankedResets`, `useBankedReset`, `getCapabilities`, `getProviderCapabilities` |
| Catalogs | `listModels`, `listSkills`, `listPlugins` |
| Prompting | `run`, `sendPrompt`, `steerPrompt`, `interrupt`, `continueInterruptedTurn`, `respondToRequest`, `setPermission`, `handlePromptCommand`, `preparePromptOptions` |
| History | `listConversations`, `resumeConversation`, `loadConversation`, `loadOlderHistory`, `loadTurnHistory`, `readConversationMessages`, `readConversationSummary`, `readConversationContent`, `reconcileConversations` |
| Conversations and turns | `setConversationTitle`, `archiveConversation`, `deleteConversation`, `setConversationStorage`, `forkConversation`, `deleteTurn`, `editTurn`, `retryTurn` |
| Goals and reviews | `setGoal`, `clearGoal`, `startReview` |
| Scoped work and generation | `openScope`, `executeScopedPrompt`, `disposeScopedSession`, `generateText`, `generateImage` |
| Realtime and remote control | `startRealtime`, `getRemoteControl`, `setRemoteControl`, `startDevicePairing`, `checkDevicePairing`, `listPairedDevices`, `revokePairedDevice` |
| Events | `onEvent` returns an unsubscribe function |

Every session operation takes a handle owned by that harness. Every optional operation has a capability flag; an operation a provider does not support rejects with `HarnessUnsupportedError`. `run` returns a `Run`: its `events` and a `result` that settles when the turn ends. `sendPrompt` returns `Admission`, independently of terminal turn status. Request responses carry an ID and an explicit decision, answers, or cancellation outcome.

See the [consumer contract](../consumer-contract.md) for detailed lifecycle rules and the published declarations for exact parameter/result types. Guides cover [state/events](../guide/events.md), [sessions](../guide/sessions.md), and [tools](../guide/tools.md).
