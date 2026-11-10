# Sessions and history

`Session` and `ConversationRef` are opaque handles owned by one driver. Do not construct them, inspect their fields, or pass them to another driver. `open` copies your context; IDs must be unique within the driver.

## Restore a conversation

After admission or loading, capture detached restoration data:

```ts
const sessionData = driver.getSessionData(session);
const ref = driver.getConversationRef(session);
const refData = ref ? driver.getRefData(ref) : null;
// Save these objects using your application's storage policy.
```

In a fresh driver for the same provider and home:

```ts
const restored = nextDriver.restoreSession({ id: 'main', folder: projectFolder }, sessionData);
await nextDriver.loadConversation(restored);
```

Restoration binds identity. Loading reads authoritative native state. The SDK does not serialize your application, choose a JSON format, or retain durable attachment bytes. Restoration data includes native IDs and paths: store it privately and associate it with the provider home it came from.

## Browse and resume

`listConversations(session, input?)` returns summaries with opaque refs. Pass a returned ref to `resumeConversation(session, { ref, storageState })`. Preserve the summary's active/archived storage state when choosing that argument.

Codex lists non-archived conversations by default, across working folders. Pass `cwd` to filter a workspace or `archived: true` for archived conversations. Listing starts the runtime as needed. `readConversationMessages(session, ref)` reads full Codex history without selecting, resuming, unarchiving, or mutating the conversation. Explicitly resuming an archived Codex conversation makes it active; it never archives the previous chat.

Use `loadOlderHistory` and `loadTurnHistory` for provider-supported paging. `historyState` and `historyLoading` retain native evidence; absent paging flags are unknown.

## Settings and lifecycle

`SessionState.selection` and `permission` report native settings. Omitted defaults preserve a loaded conversation's native policy. Explicit host or prompt choices can override it. A different Claude model does not inherit a stale reasoning effort. Settings recovery does not require an SDK preference store.

`release` detaches the binding. `archiveConversation` and `deleteConversation` are explicit native mutations and require the corresponding capabilities. `close` releases the driver runtime. Scoped sessions have their own continuation, cancellation, and disposal rules; see [tools and permissions](tools.md).

`readConversationContent` reads scoped content IDs belonging to the session. Runtime paths and content URLs are not durable media identifiers. Hosts own retention and must not replace this boundary with arbitrary renderer-provided filesystem paths.
