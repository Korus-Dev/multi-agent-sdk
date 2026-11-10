# Multi Agent SDK

A unified TypeScript interface for building apps on **Codex, Claude, Cursor, and Antigravity**. Send prompts, stream conversation state, answer approvals, and restore native conversations through one Node.js API.

Public types can be imported directly from `@korus-dev/multi-agent-sdk` with `import type`.

Each adapter preserves its provider's conversation state and settings. Capabilities describe what that provider supports; usage fields remain unknown when the runtime does not report them.

```sh
npm install @korus-dev/multi-agent-sdk
```

Requires Node.js 22.19+ and an installed, authenticated provider runtime. This is an ESM package.

```ts
import { createHarnessDriver } from '@korus-dev/multi-agent-sdk';

const driver = createHarnessDriver('codex', { client: { name: 'my-app' } });
const session = driver.open({ id: 'review', folder: process.cwd() });
const unsubscribe = driver.onEvent(event => {
  if (event.type === 'session.changed' && event.session === session) {
    console.log(event.state.messages);
    // Observe event.state.turns for completion, failure, or interruption.
  }
});

try {
  const admission = await driver.sendPrompt(session, 'Explain this project');
  // Admission means the runtime accepted the prompt. Keep the driver open
  // until the admitted turn reaches a terminal state in session.changed.
  console.log(admission.turnId);
} catch (error) {
  unsubscribe();
  await driver.close();
  throw error;
}
// At application shutdown: unsubscribe(); await driver.close();
```

For a complete command-line lifecycle, run the [chat example](examples/chat.ts):

```sh
node --experimental-strip-types examples/chat.ts codex 'Explain this project'
```

| Need | Start here |
| --- | --- |
| Install and connect | [Setup](docs/guide/installation.md) · [First conversation](docs/guide/quick-start.md) |
| Restore chats and load history | [Sessions and history](docs/guide/sessions.md) |
| Approvals, MCP, and scoped work | [Tools and permissions](docs/guide/tools.md) |
| Streaming, requests, and accounting | [State and events](docs/guide/events.md) |
| Native adapters and renderer bridges | [API reference](docs/api/index.md) · [Codex surface](docs/api/codex.md) |
| Build a conversation UI | [Agent UI SDK](https://github.com/Korus-Dev/agent-ui-sdk) |
| Integrate the raw Codex protocol | [Codex SDK](https://github.com/Korus-Dev/codex-sdk) |

The host owns storage, application workflows, authorization, and attachment retention. The SDK owns provider integration and conversation projection. See the detailed [consumer contract](docs/consumer-contract.md).

## Development

```sh
npm ci
npm run check
npm run dev:docs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for local dependency source mode, tests, package validation, and release preparation.

## License

[Apache-2.0](LICENSE).
