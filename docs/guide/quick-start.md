# First conversation

Create a driver, open a session, and run a prompt:

```ts
import { createHarness } from '@korus-dev/multi-agent-sdk';

const driver = createHarness('claude', { client: { name: 'my-app' } });
const session = driver.open({ id: 'main', folder: process.cwd() });
const run = driver.run(session, 'Explain the project');
for await (const event of run.events) {
  if (event.type === 'tool.updated') console.log(event.tool.kind, event.tool.status);
}
const result = await run.result;
console.log(result.status, result.error, result.messages);
await driver.close();
```

`open` creates a local binding; it does not execute a model turn. `run` sends the prompt and follows its turn: `run.events` yields that session's events for the turn and ends when the turn does, and `run.result` resolves with the turn's status (`completed`, `failed` or `interrupted`), its error and its messages. A turn the provider retries keeps the run going. `run.result` rejects when the prompt is not accepted, when the session needs recovery, or when the session is released or the driver closed first. `run.steer` and `run.interrupt` act on the run's turn.

`sendPrompt` remains for apps that follow sessions through `onEvent` themselves: it resolves on admission and does **not** wait for completion.

The [complete Node example](https://github.com/Korus-Dev/multi-agent-sdk/blob/main/examples/chat.ts) handles completion, errors, interruption, and cleanup. From the repository root:

```sh
npm run build
node --experimental-strip-types examples/chat.ts codex 'Explain this project'
```

The example fails explicitly if a tool approval or question requires an interactive host. In a UI, render `SessionState.requests` and route decisions through `respondToRequest`; see [tools and permissions](tools.md).

Always close drivers during application shutdown. Use `release(session)` to detach a local session without deleting its provider conversation. For concurrent auxiliary work, use the scoped execution interface rather than treating a scoped handle as a main session.
