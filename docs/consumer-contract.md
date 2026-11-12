# Harness consumer contract

Import `createHarness` from `@korus-dev/multi-agent-sdk` and public types from the same package root. The root is the generic Node harness interface. It contains no bridge, UI runtime or Computer Use API.

```ts
import { createHarness } from '@korus-dev/multi-agent-sdk';

const harness = createHarness('claude', {
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

`open` copies input and owns the resulting binding. Returned session identity, title, plan, usage and goal are never required in caller input. `SessionState.turns` uses the full neutral `Turn` contract: native error and retry evidence, start/completion timestamps, duration, optional detail state and execution usage pass through unchanged. `answeredClientRequestIds`, `historyLoading` and `historyState` retain native snapshot evidence; optional paging details remain absent when the provider does not supply them. Initial state does not manufacture answered IDs or history flags. `Session` and `ConversationRef` are opaque handles owned by their harness; a handle from another harness is rejected. `getSessionData` and `getRefData` return detached plain restoration data. The consumer owns its serialization, storage and preferences; the SDK does not save application state or choose a JSON format. These objects include native identities and paths, so keep them in application-private storage. `restoreSession` and `restoreRef` accept those data objects. `getConversationRef(session)` returns the current conversation reference after native admission or loading, and null before one exists. New chats can therefore be remembered without enumerating a catalog first. Restoration binds identity; `loadConversation` reads authoritative state.

`SessionState.selection` exposes model, reasoning effort and service tier reported by the native runtime. Codex restores these from the resumed thread; Claude recovers model and effort from its transcript and publishes subsequent native settings changes. Missing provider evidence remains absent or null. Explicit prompt selection and host defaults take precedence over restored Claude settings; a different model does not inherit the restored model's effort. Reading provider-retained settings requires no application serialization. `SessionState.permission` carries the backend-confirmed opaque permission ID, including Codex approval settings restored on resume. Native permission events and successful permission changes update that field; unsupported or unavailable evidence stays unknown. Successful changes describe the active runtime. Reload reads provider-retained settings, without an SDK-owned preference store. Omitted caller permission preferences preserve the loaded native policy; explicit caller defaults or a host policy callback may override it. Native host integrations that keep separate application preferences can set `inheritNativeSettings` to preserve all loaded thread settings while retaining defaults for new conversations.

### Runtime home and switching

`createHarness(provider, { client, home })` accepts an optional absolute provider-home path. Omission keeps the provider's standard home discovery. This is separate from a conversation's working folder and the SDK's auxiliary `stateDirectory`.

Applications switch homes by awaiting `harness.close()` and creating a fresh harness. Session handles belong to the old harness; retain consumer-owned restoration data only for the home it came from. Claude's native helpers use one configuration home per process: an explicit home applies to that provider runtime and closing it restores the prior environment. Close that runtime before constructing another Claude profile. No application restart is required.

### Conversation access

Codex `listConversations` starts the runtime as needed and lists normal non-archived conversations by default, including conversations other than the currently bound thread. `archived: true` explicitly requests archived conversations. `cwd` supplies an explicit workspace filter; the session's working folder does not implicitly filter the Codex catalog. `searchTerm` and `limit` apply to that selection.

`readConversationMessages` reads complete Codex history, including archived chats, without resuming, selecting, unarchiving or archiving a conversation. Resuming explicitly archived chats makes them active, but never archives the previously bound chat. The consumer controls archive policy. Native compatibility callers can explicitly request the last-message subagent view; the neutral history API uses the full read-only path.


Use `getRuntimeStatus`, `authenticate`, catalogs, generation, history and conversation/turn operations on this interface. Check `getCapabilities(session)` before presenting controls. Remote control, realtime and login are capability-gated operations on the same interface; they report as unsupported (`HarnessUnsupportedError`) on providers without them, and `getCapabilities` says in advance. available. Permission choices have stable opaque IDs and optional danger flags; use `defaults.permission` or `setPermission`, without selecting a provider-specific setter. Unsupported native operations throw. `getAccountRateLimits` returns null when unavailable. Authentication exposes a generic `connected` flag and explicit `native` detail for provider-specific login flows. Provider-authored catalog names/descriptions/icons remain native data; application translation descriptors are confined to the native seam. Neutral capability choices contain no product labels or translations.

Requests arrive through `request.created` and resolve through `request.resolved`. `readSession().requests` is reconciled from authoritative native snapshots as well: Codex supplies approvals and client requests; Cursor and Antigravity supply client requests. A fresh snapshot restores missed pending requests and removes requests whose resolution frame was missed. Claude snapshots supply no pending list, so existing requests remain until native answered IDs or resolution events establish their removal. Snapshot reconciliation is exposed through `session.changed` and does not invent resolution outcomes. Respond through `respondToRequest` using the request's question IDs and supplied choices. Responses are bound to the owning session. Cancelling a request uses the native cancellation outcome; interrupting a turn uses `interrupt`. `plan.readyForReview` carries review content independently of prompt admission.

`executeScopedPrompt` accepts an optional host-local `signal: AbortSignal` and owns a separate binding and tool configuration. The signal targets that private scope before its first event, through pending native admission and active work. Cancellation waits for native settlement and final cleanup, rejects with the signal reason, and cannot cancel the main session or other scopes. Already-aborted calls do not admit work. Native adapter implementations must support `cancelScopedPrompt` to accept a cancellable scope; unsupported adapters reject before execution. Fresh scopes clone the main parent's native defaults (model, reasoning, service tier and permission), while explicit prompt selection remains an override. Its returned session is a scoped handle tied to that parent. Continue it through `executeScopedPrompt(parent, { ...input, session: scope })`; a main handle or another parent's scope is rejected. Scoped handles support state/content reads, capabilities, restoration data, history hydration, request responses and interruption. Generic conversation mutations, catalogs and generation use the main handle. Scoped execution, hydration and disposal cannot overlap.

`disposeScopedSession` requires an idle scope and waits for both native disposal and native binding release before invalidating the handle. Failed disposal retains a retryable handle. If native deletion succeeded but release failed, retry finishes release without deleting again; operations that could revive deleted work are blocked. `release(parent)` requires all child scopes to be disposed or released first, and pending parent release rejects new or restored children. Serialized scopes retain their role and parent identity; restore the main parent first, then restore and hydrate the scope. Main conversation state is not replaced by scoped work. Native tool admission, permission checks and cancellation remain authoritative.

Each provider's existing replica owns transcript changes. The facade only dispatches to those replicas and projects snapshots. Duplicate/stale revisions are ignored; missing frames or replica failures emit `recovery.required`. Reload with `loadConversation` to obtain a fresh native snapshot. Provider hosts still own replay validation and session replacement. There is no universal transcript reducer.

## Imports

| Import | Contract |
| --- | --- |
| `@korus-dev/multi-agent-sdk` | `createHarness`, `HarnessUnsupportedError`, `TypedEventBus`, `TtlCache` and the public types |
| `@korus-dev/multi-agent-sdk/prompt` | Pure prompt authoring helpers |
| `@korus-dev/multi-agent-sdk/contracts` | Capability tables, provider and reference guards (`isHarnessProvider`, `isProviderConversationRef`) and data helpers with no Node dependencies |

Providers are reached only through `createHarness`. Provider engines, hosts and transports are internal and have no import path.

## Portable contracts and native detail

`Turn`, `TurnError`, `TurnExecutionUsage`, `TokenUsage`, `RequestUsage`, `SafetyFindings` and `JsonValue` are underlying neutral definitions in `contracts/turn.ts`; old Codex host names re-export them for native compatibility. Internal code uses canonical `Message`, `MessagePart`, `ToolPart`, `ClientApi` and `PromptPart` vocabulary. Deprecated Renderer and Codex prompt aliases remain only for existing imports. Public types are available from the root; runtime entries keep browser and Node code apart.

Portable consumers must not interpret `Authentication.native`, `SessionStatus.native`, `TurnError.codexErrorInfo`, arbitrary catalog `providerMetadata`, or other provider-specific escape data. Those fields preserve native evidence for integrations that deliberately accept provider coupling. Generic errors use `message` and `additionalDetails`; native details are retained without being reinterpreted. Catalog IDs/model values are selection identities. Display names, descriptions and icons are optional provider-authored metadata, not required portable behavior. Applications supply labels for SDK-default permission IDs.

The package root type-exports provider-neutral contracts from `contracts/`, below the native host. Shared DTO names have no provider prefixes. Codex's client contracts (`conversationId`/`turnId`/`itemId`-shaped messages, requests and approvals) are internal to the Codex provider; `/codex` names the ones its snapshots and events carry with a `Codex` prefix, and `check-public-api` fails when any other entry exports them. Legacy client request envelopes are compatibility DTOs for controlled presentation; generic request actions use `AgentRequest`. `/prompt` contains only prompt authoring helpers and neutral `PromptPart`/`PromptMention` types. Provider hosts, reducers and transports are internal.

## Claude embedding identity

An explicit `client.entrypoint` takes precedence over an outer process's entrypoint. Without that embedding identity, an explicit transport `env.CLAUDE_CODE_ENTRYPOINT` is honored, including runtime/auth attribution. Otherwise a non-generic inherited identity is retained; empty, `cli` and inherited `sdk-*` values use `sdk-multi-agents`. `client.clientApp` controls the SDK client-app attribution independently. Launch environments are copied before SDK configuration, preserving the caller's environment object, command, path and authentication variables. Configuration-home consistency and existing runtime safety filtering remain authoritative.

## MCP availability and trust

`enabledTools` controls availability independently of approval. Endpoint/server `approval` is omitted or `inherit` by default; that never grants automatic trust. `approval: 'auto'` explicitly opts into automatic approval on Codex or Claude. Cursor and Antigravity reject that unsupported policy. `required: true` is supported by Codex and rejected by Claude/ACP; unspecified requiredness is left to the native runtime. Invalid policy values reject before execution.

These rules apply to ordinary factory sessions, scoped work and utility generation. Claude checks `enabledMcpTools` before permission or explicit trust checks; an empty list disables the server's tools. Native `allowedTools` remains an explicit trust escape hatch and cannot override an availability restriction. Utilities without an interactive permission route deny inherited MCP calls instead of implicitly trusting them. Applications that intentionally trust a Claude utility server must opt into `approval: 'auto'`. ACP utilities retain native permission behavior and never manufacture an automatic grant.
