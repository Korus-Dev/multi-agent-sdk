# Harness consumer contract

Import `createHarnessDriver` from `@korus-dev/multi-agent-sdk` and types from `@korus-dev/multi-agent-sdk/consumer-types`. The root is the generic Node harness interface. It contains no bridge, UI runtime or Computer Use API.

```ts
import { createHarnessDriver } from '@korus-dev/multi-agent-sdk';

const harness = createHarnessDriver('claude', {
  client: { name: 'cpa-workbench' },
  instructions: () => 'Use only verified accounting rules.',
  mcpServers: () => [{ name: 'ledger', url: 'http://localhost:9000/ledger' }],
});
const session = harness.open({ id: 'invoice-review', folder: '/accounting' });
harness.onEvent(event => {
  if (event.type === 'session.changed' && event.session === session) {
    // Message and MessagePart have the same shape for every provider.
    renderMessages(event.state.messages);
  }
});
await harness.sendPrompt(session, 'Reconcile the invoices');
```

`sendPrompt` resolves on native admission. Its result is not proof of successful completion. Observe `session.changed` and inspect the native-projected turn status (`completed`, `failed`, `interrupted`, `inProgress`). `interrupt` preserves the expected-turn guard. Native failures reject operations; partial state remains readable. Accounting observations preserve provider evidence, including unknown tokens, model, requests and costs.

`open` copies input and owns the resulting binding. Returned session identity, title, plan, usage and goal are never required in caller input. `SessionState.turns` uses the full neutral `Turn` contract: native error and retry evidence, start/completion timestamps, duration, optional detail state and execution usage pass through unchanged. `answeredClientRequestIds`, `historyLoading` and `historyState` retain native snapshot evidence; optional paging details remain absent when the provider does not supply them. Initial state does not manufacture answered IDs or history flags. `Session` and `ConversationRef` are opaque, driver-owned handles; a handle from another driver is rejected. `getSessionData` and `getRefData` return detached plain restoration data. The consumer owns its serialization, storage and preferences; the SDK does not save application state or choose a JSON format. These objects include native identities and paths, so keep them in application-private storage. `restoreSession` and `restoreRef` accept those data objects. `getConversationRef(session)` returns the current conversation reference after native admission or loading, and null before one exists. New chats can therefore be remembered without enumerating a catalog first. Restoration binds identity; `loadConversation` reads authoritative state.

### Runtime home and switching

`createHarnessDriver(provider, { client, home })` accepts an optional absolute provider-home path. Omission keeps the provider's standard home discovery. This is separate from a conversation's working folder and the SDK's auxiliary `stateDirectory`.

Applications switch homes by awaiting `driver.close()` and creating a fresh driver. Session handles belong to the old driver; retain consumer-owned restoration data only for the home it came from. Claude's native helpers use one configuration home per process: an explicit home applies to that provider runtime and closing it restores the prior environment. Close that runtime before constructing another Claude profile. No application restart is required.

### Conversation access

Codex `listConversations` starts the runtime as needed and lists normal non-archived conversations by default, including conversations other than the currently bound thread. `archived: true` explicitly requests archived conversations. `cwd` supplies an explicit workspace filter; the session's working folder does not implicitly filter the Codex catalog. `searchTerm` and `limit` apply to that selection.

`readConversationMessages` reads complete Codex history, including archived chats, without resuming, selecting, unarchiving or archiving a conversation. Resuming explicitly archived chats makes them active, but never archives the previously bound chat. The consumer controls archive policy. Native compatibility callers can explicitly request the last-message subagent view; the neutral history API uses the full read-only path.


Use `getRuntimeStatus`, `authenticate`, catalogs, generation, history and conversation/turn operations on this interface. Check `getCapabilities(session)` before presenting controls. Native Codex remote control remains available only through its explicit native surface; the neutral facade reports it unavailable. Permission choices have stable opaque IDs and optional danger flags; use `defaults.permission` or `setPermission`, without selecting a provider-specific setter. Unsupported native operations throw. `getAccountRateLimits` returns null when unavailable. Authentication exposes a generic `connected` flag and explicit `native` detail for provider-specific login flows. Provider-authored catalog names/descriptions/icons remain native data; application translation descriptors are confined to the native seam. Neutral capability choices contain no product labels or translations.

Requests arrive through `request.created` and resolve through `request.resolved`. `readSession().requests` is reconciled from authoritative native snapshots as well: Codex supplies approvals and client requests; Cursor and Antigravity supply client requests. A fresh snapshot restores missed pending requests and removes requests whose resolution frame was missed. Claude snapshots supply no pending list, so existing requests remain until native answered IDs or resolution events establish their removal. Snapshot reconciliation is exposed through `session.changed` and does not invent resolution outcomes. Respond through `respondToRequest` using the request's question IDs and supplied choices. Responses are bound to the owning session. Cancelling a request uses the native cancellation outcome; interrupting a turn uses `interrupt`. `plan.readyForReview` carries review content independently of prompt admission.

`executeScopedPrompt` accepts an optional host-local `signal: AbortSignal` and owns a separate binding and tool configuration. The signal targets that private scope before its first event, through pending native admission and active work. Cancellation waits for native settlement and final cleanup, rejects with the signal reason, and cannot cancel the main session or other scopes. Already-aborted calls do not admit work. Native adapter implementations must support `cancelScopedPrompt` to accept a cancellable scope; unsupported adapters reject before execution. Fresh scopes clone the main parent's native defaults (model, reasoning, service tier and permission), while explicit prompt selection remains an override. Its returned session is a scoped handle tied to that parent. Continue it through `executeScopedPrompt(parent, { ...input, session: scope })`; a main handle or another parent's scope is rejected. Scoped handles support state/content reads, capabilities, restoration data, history hydration, request responses and interruption. Generic conversation mutations, catalogs and generation use the main handle. Scoped execution, hydration and disposal cannot overlap.

`disposeScopedSession` requires an idle scope and waits for both native disposal and native binding release before invalidating the handle. Failed disposal retains a retryable handle. If native deletion succeeded but release failed, retry finishes release without deleting again; operations that could revive deleted work are blocked. `release(parent)` requires all child scopes to be disposed or released first, and pending parent release rejects new or restored children. Serialized scopes retain their role and parent identity; restore the main parent first, then restore and hydrate the scope. Main conversation state is not replaced by scoped work. Native tool admission, permission checks and cancellation remain authoritative.

Each provider's existing replica owns transcript changes. The facade only dispatches to those replicas and projects snapshots. Duplicate/stale revisions are ignored; missing frames or replica failures emit `recovery.required`. Reload with `loadConversation` to obtain a fresh native snapshot. Provider hosts still own replay validation and session replacement. There is no universal transcript reducer.

## Native and bridge imports

| Import | Contract |
| --- | --- |
| `@korus-dev/multi-agent-sdk` | Neutral factory, driver and types |
| `@korus-dev/multi-agent-sdk/consumer-types` | Types only; no provider initialization |
| `@korus-dev/multi-agent-sdk/ui-types` | Neutral serializable presentation DTOs; types only |
| `@korus-dev/multi-agent-sdk/prompt` | Pure prompt authoring helpers and types |
| `@korus-dev/multi-agent-sdk/capabilities` | Pure native capability constants; safe for browser consumers |
| `@korus-dev/multi-agent-sdk/diagnostics` | Structured diagnostic types only |
| `@korus-dev/multi-agent-sdk/native` | `createNativeHarnessDriver`, `NativeHarnessOptions`, existing native driver/context/event/contracts |
| `@korus-dev/multi-agent-sdk/backend` | Compatibility native `createHarnessDriver` |
| `@korus-dev/multi-agent-sdk/providers/codex` | Explicit Codex surface/runtime adapter |
| `@korus-dev/multi-agent-sdk/providers/claude` | Claude host, transport and replica |
| `@korus-dev/multi-agent-sdk/providers/cursor` | Cursor host and replica |
| `@korus-dev/multi-agent-sdk/providers/antigravity` | Antigravity host and replica |
| `@korus-dev/multi-agent-sdk/bridge` | Existing native Codex surface, bridge, replica and state APIs |
| `@korus-dev/multi-agent-sdk/web` | Explicit WebSocket transport |
| `/core`, `/surface`, `/surface-bridge`, `/conversation-replica`, `/events`, `/codex` | Existing native compatibility entries |

Korus native wire consumers should import native driver/context/event types from `/native`, and surface contracts from `/surface`. Contracts, conversation replicas and ACP compatibility entries remain usable. Provider-native APIs use the explicit provider index entries; internal provider modules are not public exports. Native events retain provider prefixes and reducers retain their original wire contracts. The native factory and neutral factory deliberately have different names at `/native` and root.

## Public name map

| Deprecated alias | Canonical type |
| --- | --- |
| `RendererMessage` | `Message` |
| `RendererMessagePart` | `MessagePart` |
| `RendererMessageAttachment` | `MessageAttachment` |
| `RendererMessageMedia` | `MessageMedia` |
| `RendererToolPart` | `ToolPart` |
| `RendererToolPartUpdate` | `ToolPartUpdate` |
| `RendererPromptAttachment` | `PromptReferenceAttachment` |
| `RendererSendPromptOptions` | `ReferenceSendPromptOptions` |
| `CreateCodexRendererConversationOptions` | `CreateCodexClientConversationOptions` |
| `CodexRendererAttachment` | `CodexClientAttachment` |
| `CodexRendererSendMessageOptions` | `CodexClientSendMessageOptions` |
| `CodexSurfaceRendererApi` | `CodexSurfaceClientApi` |

Aliases preserve native source compatibility. Reference attachments remain distinct from host filesystem attachments. These are declaration renames in the existing files, not source relocation.

Vendor dependencies remain mandatory because provider construction is statically loaded. The unused direct `@anthropic-ai/sdk` dependency is absent; the Claude Agent SDK remains. The package uses versioned npm dependencies under the `@korus-dev` scope. Build/test aliases are repository-local; source imports use relative paths. No ACP transport substitution is included.

## Diagnostics

`CodexSurfaceOptions.onDiagnostic` and `CodexHostOptions.onDiagnostic` accept the same `(record: HarnessDiagnostic) => void` observer. Import `HarnessDiagnostic` from `/diagnostics` or as a type from root. Records preserve native layer/stage identifiers and thread identity, epoch `at`, optional `startAt`, monotonic `stageMs`/`elapsedMs`, and optional projection counters (`revision`, `messages`, `projectMs`, `emitMs`). Host-adapter records also include `agentId`. Resume failures retain their `resume.failed` stage; failed native binding emits `bind.failed` before propagating the original error.

The caller owns enablement, filtering, storage and log formatting. The SDK does not read application trace flags. Supply a sink separately to the surface and adapter to collect both layers. Observer exceptions are isolated and reported through each options object's `onListenerError`; an error handler that throws is also isolated. Without an error handler, the shared listener utility reports a process warning. Diagnostic observers never change native operation success or failure.

Low-level RPC settlement is separate: `CodexSurfaceOptions.onRequestSettled` forwards the Codex client's generic settlement observer when the surface creates its client. An injected client owns its own settlement observer. Every admitted method is observed without application filtering; records contain RPC ID, method, outcome, epoch start and monotonic duration, with no request parameters. Hosts can correlate IDs with their own context and choose which records to display.

## Portable contracts and native detail

`Turn`, `TurnError`, `TurnExecutionUsage`, `TokenUsage`, `RequestUsage`, `SafetyFindings` and `JsonValue` are underlying neutral definitions in `contracts/turn.ts`; old Codex surface names re-export them for native compatibility. Internal code uses canonical `Message`, `MessagePart`, `ToolPart`, `ClientApi` and `PromptPart` vocabulary. Deprecated Renderer and Codex prompt aliases remain only for existing imports. `/backend` is a deprecated native compatibility factory; use the neutral root or explicit `/native` factory according to the intended contract. Compatibility leaves remain available while native consumers migrate; there is no automatic removal date.

Portable consumers must not interpret `Authentication.native`, `SessionStatus.native`, `TurnError.codexErrorInfo`, arbitrary catalog `providerMetadata`, or other provider-specific escape data. Those fields preserve native evidence for integrations that deliberately accept provider coupling. Generic errors use `message` and `additionalDetails`; native details are retained without being reinterpreted. Catalog IDs/model values are selection identities. Display names, descriptions and icons are optional provider-authored metadata, not required portable behavior. Applications supply labels for SDK-default permission IDs.

The pure `/ui-types` entry exports shared definitions from `contracts/ui.ts`, `contracts/turn.ts` and `contracts/prompt.ts`, below the native surface. Common message contracts import those modules directly. Native surface names re-export compatibility aliases; portable DTOs have no dependency on the native surface. The entry names the shared DTOs without provider prefixes. `SurfaceMessage` remains distinct from the facade's `Message`, which also carries an agent identity. Legacy client request envelopes are compatibility DTOs for controlled presentation; generic request actions use `AgentRequest`. `/prompt` contains only prompt authoring helpers and neutral `PromptPart`/`PromptMention` types. Provider hosts, reducers and transports remain under explicit provider/native entries.

## Claude embedding identity

An explicit `client.entrypoint` takes precedence over an outer process's entrypoint. Without that embedding identity, an explicit transport `env.CLAUDE_CODE_ENTRYPOINT` is honored, including runtime/auth attribution. Otherwise a non-generic inherited identity is retained; empty, `cli` and inherited `sdk-*` values use `sdk-multi-agents`. `client.clientApp` controls the SDK client-app attribution independently. Launch environments are copied before SDK configuration, preserving the caller's environment object, command, path and authentication variables. Configuration-home consistency and existing runtime safety filtering remain authoritative.

## MCP availability and trust

`enabledTools` controls availability independently of approval. Endpoint/server `approval` is omitted or `inherit` by default; that never grants automatic trust. `approval: 'auto'` explicitly opts into automatic approval on Codex or Claude. Cursor and Antigravity reject that unsupported policy. `required: true` is supported by Codex and rejected by Claude/ACP; unspecified requiredness is left to the native runtime. Invalid policy values reject before execution.

These rules apply to ordinary factory sessions, scoped work and utility generation. Claude checks `enabledMcpTools` before permission or explicit trust checks; an empty list disables the server's tools. Native `allowedTools` remains an explicit trust escape hatch and cannot override an availability restriction. Utilities without an interactive permission route deny inherited MCP calls instead of implicitly trusting them. Applications that intentionally trust a Claude utility server must opt into `approval: 'auto'`. ACP utilities retain native permission behavior and never manufacture an automatic grant.
