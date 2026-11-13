# Sessions and history

`Session` and `ConversationRef` are opaque handles owned by one harness. Do not construct them, inspect their fields, or pass them to another harness. `open` copies your context; IDs must be unique within the harness.

## Restore a conversation

After the conversation has started or loaded, capture detached restoration data:

```ts
const sessionData = harness.getSessionData(session);
const ref = harness.getConversationRef(session);
const refData = ref ? harness.getRefData(ref) : null;
// Save these objects using your application's storage policy.
```

In a fresh harness for the same provider and home:

```ts
const restored = nextHarness.restoreSession({ id: 'main', folder: projectFolder }, sessionData);
await nextHarness.loadConversation(restored);
```

Restoration binds identity. Loading reads the provider's current state. Sending to a restored session loads its conversation first, so a prompt, a steer or a continue never leaves a session that shows only the new turn: it shows the history as well. A conversation the app binds with `syncSession` is read the same way, and a failed read rejects the prompt before anything is sent. The SDK does not serialize your application, choose a JSON format, or retain durable attachment bytes. Restoration data includes provider IDs and paths: store it privately and associate it with the provider home it came from.

### One name for the conversation

Session data and conversation references name the conversation `conversationId` on every harness, so storage and lookup code is the same for all of them. The `/contracts` helpers read it without interpreting provider detail:

```ts
import { sameConversationRef, sessionConversationId, sessionConversationRef } from '@korus-dev/multi-agent-sdk/contracts';

const id = sessionConversationId(sessionData.data);
const sessionRef = sessionConversationRef(sessionData.data, projectFolder);
const listed = refData ? sameConversationRef(sessionRef, refData.data) : false;
```

Claude can keep a conversation's transcript under another ID than the one it continues. Its session data then also carries `transcriptConversationId`, and `sessionConversationRef` already points at that transcript.

Two capabilities describe how conversations are stored:

| Capability | Meaning |
| --- | --- |
| `folderScopedConversations` | `true` when conversations belong to a working folder, so their references carry a `folder`. `false` when one conversation list spans all folders. |
| `subagentTranscripts` | Where a subagent's transcript can be read: `'inline'` inside its parent conversation, `'separate'` as a conversation of its own, or `'none'` when the provider keeps none. |

`subagentRef` and `subagentOfRef` follow `subagentTranscripts` for you:

```ts
import { subagentRef } from '@korus-dev/multi-agent-sdk/contracts';

if (refData) {
  const subagent = subagentRef(refData.data, subagentId); // null when the provider keeps no subagent transcripts
  if (subagent) await harness.readConversationMessages(session, harness.restoreRef({ provider: refData.provider, data: subagent }));
}
```

## Browse and resume

`listConversations(session, input?)` returns summaries with opaque refs. Pass a returned ref to `resumeConversation(session, { ref, storageState })`. Preserve the summary's active/archived storage state when choosing that argument.

Codex lists non-archived conversations by default, across working folders. Pass `cwd` to filter a workspace or `archived: true` for archived conversations. Listing starts the runtime as needed. `readConversationMessages(session, ref)` reads full Codex history without selecting, resuming, unarchiving, or mutating the conversation. Explicitly resuming an archived Codex conversation makes it active; it never archives the previous chat.

Use `loadOlderHistory` to page back through a conversation. Where `capabilities.turnHistory` is set, turns can arrive as summaries (`itemsView: 'summary'`) and `loadTurnHistory` loads one turn's full items; elsewhere every turn arrives whole. `historyState` and `historyLoading` retain native evidence; absent paging flags are unknown.

## Settings and lifecycle

`SessionState.selection` and `permission` report the model, reasoning effort, speed and permission the conversation runs with. A loaded conversation keeps its own settings unless you choose others.

Saved model settings (the `defaults` stored with the session data) apply once, when the conversation is opened. While it stays open, only an explicit selection on a prompt, or `updateDefaults`, changes them. A different Claude model does not inherit a stale reasoning effort.

```ts
harness.updateDefaults(session, { model: 'my-model', reasoningEffort: 'high' }); // sent with the next prompt
```

`release` detaches the binding. `archiveConversation` and `deleteConversation` are explicit native mutations and require the corresponding capabilities. `close` releases the provider runtime. Scoped sessions have their own continuation, cancellation, and disposal rules; see [tools and permissions](tools.md).

`readConversationContent` reads scoped content IDs belonging to the session. Runtime paths and content URLs are not durable media identifiers. Hosts own retention and must not replace this boundary with arbitrary filesystem paths supplied by browser code.
