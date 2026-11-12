# State and events

`readSession(session)` returns the session's current state: messages, turns, pending requests, title, plan, goal and settings, in the same shape for every provider. Subscribe with `onEvent` to keep a view up to date. The function it returns removes the listener.

| Event | Use |
| --- | --- |
| `session.changed` | Render the session from its full state. |
| `session.patch` | Apply the same change as a small revisioned patch, to keep a copy of the state somewhere else. |
| `turn.started` / `turn.completed` | Follow a turn from start to end, with its status and error. |
| `turn.output` | Know a turn has started producing output. |
| `tool.updated` | Show a tool call, once per status. |
| `diff.updated` / `file.activity` | Show what the turn changed and which files it touched. |
| `session.error` | Show an error the conversation reported. |
| `request.created` / `request.resolved` | Present or retire an approval or a question. |
| `status.changed` | Show whether the session is idle, working, or waiting on an approval or an answer. |
| `plan.readyForReview` | Present a plan the provider wrote for review. |
| `recovery.required` | Reload the conversation with `loadConversation` before rendering further changes. |
| `usage.observed` / `requestUsage.observed` | Record what a turn or a request consumed. |

Session and provider updates such as `conversation.settingsUpdated` and `agent.conversationAttached` arrive in the same stream, in the same shape for every provider.

Sending a prompt and finishing a turn are separate: `sendPrompt` resolves when the provider accepts the prompt. Follow the turn with `run`, or match `turn.completed` against the admission's `turnId`.

Unknown usage, model, token, request and cost information stays unknown. Do not treat missing accounting as zero.

Use `harness.getCapabilities(session)` to decide which actions to offer. An operation a provider does not support rejects with `HarnessUnsupportedError`.

## Keep a copy of a session elsewhere

To show a session in another process, such as a browser window or a phone, send it a snapshot once and patches afterwards. Each patch carries only what changed: streamed text arrives as the text that was added.

On the side that owns the harness:

```ts
send({ snapshot: harness.readSessionSnapshot(session) });
harness.onEvent(event => {
  if (event.type === 'session.patch' && event.session === session) send({ patch: event.patch });
});
```

On the side that renders it, with no Node dependency:

```ts
import { applySessionPatch, SessionPatchGapError } from '@korus-dev/multi-agent-sdk/contracts';

let copy = received.snapshot;
function onPatch(patch) {
  try {
    copy = applySessionPatch(copy, patch);
  } catch (error) {
    if (!(error instanceof SessionPatchGapError)) throw error;
    requestSnapshot(); // A patch was missed: start again from a fresh snapshot.
  }
  render(copy.state);
}
```

Snapshots and patches are plain JSON. A patch applies only to the revision before it; `applySessionPatch` throws `SessionPatchGapError` when one was missed and `SessionPatchInvalidError` when a patch is not a valid change, and in both cases a fresh snapshot is the way forward.
