# First conversation

Create a driver, open a session, subscribe, and send a prompt:

```ts
import { createHarnessDriver } from '@korus-dev/multi-agent-sdk';

const driver = createHarnessDriver('claude', { client: { name: 'my-app' } });
const session = driver.open({ id: 'main', folder: process.cwd() });
const unsubscribe = driver.onEvent(event => {
  if (event.type === 'session.changed' && event.session === session) {
    for (const turn of event.state.turns) {
      console.log(turn.id, turn.status);
    }
  }
});
const admission = await driver.sendPrompt(session, 'Explain the project');
console.log('Accepted:', admission.turnId);
// Keep processing events until completion or application shutdown.
// Then: unsubscribe(); await driver.close();
```

`open` creates a local binding; it does not execute a model turn. `sendPrompt` resolves when the provider accepts the prompt. It does **not** wait for completion. Subscribe before sending and track the admitted turn's status: `inProgress`, `completed`, `failed`, or `interrupted`. A fast turn may already be terminal when admission resolves, so also read `driver.readSession(session)` after admission.

The [complete Node example](https://github.com/Korus-Dev/multi-agent-sdk/blob/main/examples/chat.ts) handles completion, errors, interruption, timeout, and cleanup. From the repository root:

```sh
npm run build
node --experimental-strip-types examples/chat.ts codex 'Explain this project'
```

The example fails explicitly if a tool approval or question requires an interactive host. In a UI, render `SessionState.requests` and route decisions through `respondToRequest`; see [tools and permissions](tools.md).

Always close drivers during application shutdown. Use `release(session)` to detach a local session without deleting its provider conversation. For concurrent auxiliary work, use the scoped execution interface rather than treating a scoped handle as a main session.
