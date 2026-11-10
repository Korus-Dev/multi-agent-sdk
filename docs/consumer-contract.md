# Harness consumer contract

Import `createHarnessDriver` from `multi-agents-sdk` and types from `multi-agents-sdk/consumer-types`. The root is the generic Node harness interface. It contains no bridge, UI runtime or Computer Use API.

```ts
import { createHarnessDriver } from 'multi-agents-sdk';

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

`open` copies input and owns the resulting binding. Returned session identity, title, plan, usage and goal are never required in caller input. `Session` and `ConversationRef` are opaque, driver-owned handles; a handle from another driver is rejected. `serializeSession`/`restoreSession` and `serializeRef`/`restoreRef` support durable storage. Persisted strings contain native metadata and paths: store them as application-private data, treat their contents as opaque, and retain the corresponding workspace context. Session serialization requires native admission or loading first. Restoration binds identity; call `loadConversation` to load authoritative state.

Use `getRuntimeStatus`, `authenticate`, catalogs, generation, history and conversation/turn operations on this interface. Check `getCapabilities(session)` before presenting controls. Native Codex remote control remains available only through its explicit native surface; the neutral facade reports it unavailable. Permission choices have stable opaque IDs and optional danger flags; use `defaults.permission` or `setPermission`, without selecting a provider-specific setter. Unsupported native operations throw. `getAccountRateLimits` returns null when unavailable. Authentication exposes a generic `connected` flag and explicit `native` detail for provider-specific login flows. Provider-authored catalog names/descriptions/icons remain native data; application translation descriptors are confined to the native seam. Neutral capability choices contain no product labels or translations.

Requests arrive through `request.created`, resolve through `request.resolved`, and remain in `readSession().requests` until native resolution. Respond through `respondToRequest` using the request's question IDs and supplied choices. Responses are bound to the owning session. Cancelling a request uses the native cancellation outcome; interrupting a turn uses `interrupt`. `plan.readyForReview` carries review content independently of prompt admission.

`executeScopedPrompt` owns a separate binding and tool configuration. Its returned session can be continued explicitly or disposed with `disposeScopedSession`. Main conversation state is not replaced by scoped work. Native tool admission, permission checks and cancellation remain authoritative.

Each provider's existing replica owns transcript changes. The facade only dispatches to those replicas and projects snapshots. Duplicate/stale revisions are ignored; missing frames or replica failures emit `recovery.required`. Reload with `loadConversation` to obtain a fresh native snapshot. Provider hosts still own replay validation and session replacement. There is no universal transcript reducer.

## Native and bridge imports

| Import | Contract |
| --- | --- |
| `multi-agents-sdk` | Neutral factory, driver and types |
| `multi-agents-sdk/consumer-types` | Types only; no provider initialization |
| `multi-agents-sdk/capabilities` | Pure native capability constants; safe for browser consumers |
| `multi-agents-sdk/native` | `createNativeHarnessDriver`, `NativeHarnessOptions`, existing native driver/context/event/contracts |
| `multi-agents-sdk/backend` | Compatibility native `createHarnessDriver` |
| `multi-agents-sdk/providers/codex` | Explicit Codex surface/runtime adapter |
| `multi-agents-sdk/providers/claude` | Claude host, transport and replica |
| `multi-agents-sdk/providers/cursor` | Cursor host and replica |
| `multi-agents-sdk/providers/antigravity` | Antigravity host and replica |
| `multi-agents-sdk/bridge` | Existing native Codex surface, bridge, replica and state APIs |
| `multi-agents-sdk/web` | Explicit WebSocket transport |
| `/core`, `/surface`, `/surface-bridge`, `/conversation-replica`, `/events`, `/codex` | Existing native compatibility entries |

Korus native wire consumers should import native driver/context/event types from `/native`, and surface contracts from `/surface`. Existing contracts/conversations/ACP/tool paths remain usable. Existing product-used provider deep imports have exact package exports; arbitrary provider deep imports are not exported. Native events retain provider prefixes and reducers retain their original wire contracts. The native factory and neutral factory deliberately have different names at `/native` and root.

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

Vendor dependencies remain mandatory because provider construction is statically loaded. The unused direct `@anthropic-ai/sdk` dependency is absent; the Claude Agent SDK remains. Local package names, private status and versions remain unchanged. Build/test aliases are repository-local; source imports use relative paths. No ACP transport substitution is included.
