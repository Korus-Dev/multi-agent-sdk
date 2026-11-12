# Harness consumer contract

Import `createHarness` from `@korus-dev/multi-agent-sdk` and public types from the same package root. The root is the generic Node harness interface. It contains no bridge, UI runtime or Computer Use API.

```ts
import { createHarness } from '@korus-dev/multi-agent-sdk';

const harness = createHarness('claude', {
  client: { name: 'my-app' },
  instructions: () => 'Follow the project conventions.',
  mcpServers: () => [{ name: 'tools', url: 'http://localhost:9000/mcp' }],
});
const session = harness.open({ id: 'review', folder: '/projects/app' });
harness.onEvent(event => {
  if (event.type === 'session.changed' && event.session === session) {
    // Message and MessagePart have the same shape for every provider.
    renderMessages(event.state.messages);
  }
});
await harness.sendPrompt(session, 'Review the open changes');
```

`sendPrompt` resolves on native admission. Its result is not proof of successful completion. Observe `session.changed` and inspect the native-projected turn status (`completed`, `failed`, `interrupted`, `inProgress`). `interrupt` preserves the expected-turn guard. Native failures reject operations; partial state remains readable. Accounting observations preserve provider evidence, including unknown tokens, model, requests and costs.

`open` copies input and owns the resulting binding. Returned session identity, title, plan, usage and goal are never required in caller input. `SessionState.turns` uses the full neutral `Turn` contract: native error and retry evidence, start/completion timestamps, duration, optional detail state and execution usage pass through unchanged. `answeredClientRequestIds`, `historyLoading` and `historyState` retain native snapshot evidence; optional paging details remain absent when the provider does not supply them. Initial state does not manufacture answered IDs or history flags. `Session` and `ConversationRef` are opaque handles owned by their harness; a handle from another harness is rejected. `getSessionData` and `getRefData` return detached plain restoration data. The consumer owns its serialization, storage and preferences; the SDK does not save application state or choose a JSON format. These objects include native identities and paths, so keep them in application-private storage. `restoreSession` and `restoreRef` accept those data objects. `getConversationRef(session)` returns the current conversation reference after native admission or loading, and null before one exists. Session data and conversation references name the conversation `conversationId` on every harness; Claude session data may also carry `transcriptConversationId` when its transcript lives under another ID. `getCapabilities` reports `folderScopedConversations` (whether references carry a `folder`) and `subagentTranscripts` (`'inline'`, `'separate'` or `'none'`) so storage code never branches on the provider. New chats can therefore be remembered without enumerating a catalog first. Restoration binds identity; `loadConversation` reads authoritative state.

`SessionState.selection` exposes the model, reasoning effort and service tier the conversation runs with. Missing provider evidence remains absent or null. Saved model settings (the `defaults` stored with session data) apply once, when a conversation is opened. While it stays open, only an explicit selection on a prompt, or `updateDefaults`, changes them; a different model does not inherit the previous model's effort.

Every harness has one permission model. `getCapabilities(session).permissions` lists the permission IDs the harness offers, each with an optional `dangerous` flag. The IDs are the provider's own native modes, kept as they are so an app offers what each provider's tool offers; the app labels them. `defaults.permission` holds one of them, `setPermission(session, id)` changes it, and `SessionState.permission` reports the one the conversation runs with. Omitted caller defaults keep a loaded conversation's own permission; explicit defaults or a host policy callback may override it. Set `inheritNativeSettings` to keep all of a loaded conversation's settings while still applying defaults to new conversations.

`authenticate` returns `account`, the signed-in account in the same terms for every harness: `{ kind: 'subscription' | 'apiKey' | 'cloud'; email?; plan?; team? }`. It is `null` when no one is signed in or the harness does not say.

### Runtime home and switching

`createHarness(provider, { client, home })` accepts an optional absolute provider-home path. Omission keeps the provider's standard home discovery. This is separate from a conversation's working folder and the SDK's auxiliary `stateDirectory`.

Applications switch homes by awaiting `harness.close()` and creating a fresh harness. Session handles belong to the old harness; retain consumer-owned restoration data only for the home it came from. Claude's native helpers use one configuration home per process: an explicit home applies to that provider runtime and closing it restores the prior environment. Close that runtime before constructing another Claude profile. No application restart is required.

### Conversation access

Codex `listConversations` starts the runtime as needed and lists normal non-archived conversations by default, including conversations other than the currently bound thread. `archived: true` explicitly requests archived conversations. `cwd` supplies an explicit workspace filter; the session's working folder does not implicitly filter the Codex catalog. `searchTerm` and `limit` apply to that selection.

`readConversationMessages` reads complete Codex history, including archived chats, without resuming, selecting, unarchiving or archiving a conversation. Resuming explicitly archived chats makes them active, but never archives the previously bound chat. The consumer controls archive policy. Native compatibility callers can explicitly request the last-message subagent view; the neutral history API uses the full read-only path.


Use `getRuntimeStatus`, `authenticate`, catalogs, generation, history and conversation/turn operations on this interface. Check `getCapabilities(session)` before presenting controls. Remote control, realtime and login are capability-gated operations on the same interface; they report as unsupported (`HarnessUnsupportedError`) on providers without them, and `getCapabilities` says in advance. Permission choices have stable opaque IDs and optional danger flags; use `defaults.permission` or `setPermission` on every harness. Unsupported native operations throw. `getAccountRateLimits` returns null when unavailable. Authentication exposes a generic `connected` flag, the neutral `account`, and explicit `native` detail for provider-specific login flows. Provider-authored catalog names/descriptions/icons remain native data; application translation descriptors are confined to the native seam. Neutral capability choices contain no product labels or translations.

Requests arrive through `request.created` and resolve through `request.resolved`. `readSession().requests` is reconciled from authoritative native snapshots as well: Codex supplies approvals and client requests; Cursor and Antigravity supply client requests. A fresh snapshot restores missed pending requests and removes requests whose resolution frame was missed. Claude snapshots supply no pending list, so existing requests remain until native answered IDs or resolution events establish their removal. Snapshot reconciliation is exposed through `session.changed` and does not invent resolution outcomes. Respond through `respondToRequest` using the request's question IDs and supplied choices. Responses are bound to the owning session. Cancelling a request uses the native cancellation outcome; interrupting a turn uses `interrupt`. `plan.readyForReview` carries review content independently of prompt admission.

`executeScopedPrompt` returns the turn's final answer as `text`, never the commentary written along the way. It accepts an optional host-local `signal: AbortSignal` and owns a separate binding and tool configuration. The signal targets that private scope before its first event, through pending native admission and active work. Cancellation waits for native settlement and final cleanup, rejects with the signal reason, and cannot cancel the main session or other scopes. Already-aborted calls do not admit work. Native adapter implementations must support `cancelScopedPrompt` to accept a cancellable scope; unsupported adapters reject before execution. Fresh scopes clone the main parent's native defaults (model, reasoning, service tier and permission), while explicit prompt selection remains an override. Its returned session is a scoped handle tied to that parent. Continue it through `executeScopedPrompt(parent, { ...input, session: scope })`; a main handle or another parent's scope is rejected. Scoped handles support state/content reads, capabilities, restoration data, history hydration, request responses and interruption. Generic conversation mutations, catalogs and generation use the main handle. Scoped execution, hydration and disposal cannot overlap.

`disposeScopedSession` requires an idle scope and waits for both native disposal and native binding release before invalidating the handle. Failed disposal retains a retryable handle. If native deletion succeeded but release failed, retry finishes release without deleting again; operations that could revive deleted work are blocked. `release(parent)` requires all child scopes to be disposed or released first, and pending parent release rejects new or restored children. Serialized scopes retain their role and parent identity; restore the main parent first, then restore and hydrate the scope. Main conversation state is not replaced by scoped work. Native tool admission, permission checks and cancellation remain authoritative.

Each provider's existing replica owns transcript changes. The facade only dispatches to those replicas and projects snapshots. Duplicate/stale revisions are ignored; missing frames or replica failures emit `recovery.required`. Reload with `loadConversation` to obtain a fresh native snapshot. Provider hosts still own replay validation and session replacement. There is no universal transcript reducer.

## Imports

| Import | Contract |
| --- | --- |
| `@korus-dev/multi-agent-sdk` | `createHarness`, `HarnessUnsupportedError`, `TypedEventBus`, `TtlCache` and the public types |
| `@korus-dev/multi-agent-sdk/prompt` | Pure prompt authoring helpers |
| `@korus-dev/multi-agent-sdk/contracts` | Capability tables, session patches, provider and reference guards, conversation identity helpers (`sessionConversationId`, `sessionConversationRef`, `sameConversationRef`, `subagentRef`) and request conversions, with no Node dependencies |

Providers are reached only through `createHarness`. Provider engines, hosts and transports are internal and have no import path.

## Portable contracts and native detail

`Turn`, `TurnError`, `TurnExecutionUsage`, `TokenUsage`, `RequestUsage`, `SafetyFindings` and `JsonValue` are underlying neutral definitions in `contracts/turn.ts`. Use `Message`, `MessagePart`, `ToolPart` and `PromptPart` for conversation content. Public types are available from the root; runtime entries keep browser and Node code apart.

Portable consumers must not interpret `Authentication.native`, `SessionStatus.native`, `TurnError.codexErrorInfo`, arbitrary catalog `providerMetadata`, or other provider-specific escape data. Those fields preserve native evidence for integrations that deliberately accept provider coupling. Generic errors use `message` and `additionalDetails`; native details are retained without being reinterpreted. Catalog IDs/model values are selection identities. Display names, descriptions and icons are optional provider-authored metadata, not required portable behavior. Applications supply labels for SDK-default permission IDs.

The package root type-exports provider-neutral contracts from `contracts/`, below the native host. Shared DTO names have no provider prefixes. Codex's client contracts (`conversationId`/`turnId`/`itemId`-shaped messages, requests and approvals) are internal to the Codex provider; `/codex` names the ones its snapshots and events carry with a `Codex` prefix, and `check-public-api` fails when any other entry exports them. Legacy client request envelopes are compatibility DTOs for controlled presentation; generic request actions use `AgentRequest`. `/prompt` contains only prompt authoring helpers and neutral `PromptPart`/`PromptMention` types. Provider hosts, reducers and transports are internal.

## Claude embedding identity

An explicit `client.entrypoint` takes precedence over an outer process's entrypoint. Without that embedding identity, an explicit transport `env.CLAUDE_CODE_ENTRYPOINT` is honored, including runtime/auth attribution. Otherwise a non-generic inherited identity is retained; empty, `cli` and inherited `sdk-*` values use `sdk-multi-agents`. `client.clientApp` controls the SDK client-app attribution independently. Launch environments are copied before SDK configuration, preserving the caller's environment object, command, path and authentication variables. Configuration-home consistency and existing runtime safety filtering remain authoritative.

## MCP availability and trust

`enabledTools` controls availability independently of approval. Endpoint/server `approval` is omitted or `inherit` by default; that never grants automatic trust. `approval: 'auto'` explicitly opts into automatic approval on Codex or Claude. Cursor and Antigravity reject that unsupported policy. `required: true` is supported by Codex and rejected by Claude/ACP; unspecified requiredness is left to the native runtime. Invalid policy values reject before execution.

These rules apply to ordinary factory sessions, scoped work and utility generation. Claude checks `enabledMcpTools` before permission or explicit trust checks; an empty list disables the server's tools. Native `allowedTools` remains an explicit trust escape hatch and cannot override an availability restriction. Utilities without an interactive permission route deny inherited MCP calls instead of implicitly trusting them. Applications that intentionally trust a Claude utility server must opt into `approval: 'auto'`. ACP utilities retain native permission behavior and never manufacture an automatic grant.
