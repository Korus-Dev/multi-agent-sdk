# Multi Agent SDK

A unified TypeScript interface for building apps on **Codex, Claude, Cursor, and Antigravity**. Send prompts, stream conversation state, answer approvals, and restore native conversations through one Node.js API.

[![npm version](https://img.shields.io/npm/v/%40korus-dev%2Fmulti-agent-sdk?color=0b7a65)](https://www.npmjs.com/package/@korus-dev/multi-agent-sdk)
[![CI](https://github.com/Korus-Dev/multi-agent-sdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Korus-Dev/multi-agent-sdk/actions/workflows/ci.yml)
[![Documentation](https://github.com/Korus-Dev/multi-agent-sdk/actions/workflows/docs.yml/badge.svg?branch=main)](https://korus-dev.github.io/multi-agent-sdk/)
[![License](https://img.shields.io/badge/license-Apache--2.0-0b7a65.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/%40korus-dev%2Fmulti-agent-sdk?color=339933)](package.json)

**[Documentation →](https://korus-dev.github.io/multi-agent-sdk/)** · [Getting started](https://korus-dev.github.io/multi-agent-sdk/guide/quick-start.html) · [API reference](https://korus-dev.github.io/multi-agent-sdk/api/) · [Contributing](CONTRIBUTING.md)

Public types can be imported directly from `@korus-dev/multi-agent-sdk` with `import type`.

Each adapter preserves its provider's conversation state and settings. Capabilities describe what that provider supports; usage fields remain unknown when the runtime does not report them.

```sh
npm install @korus-dev/multi-agent-sdk
```

Requires Node.js 22.19+ and an installed, authenticated provider runtime. This is an ESM package.

```ts
import { createHarness } from '@korus-dev/multi-agent-sdk';

const harness = createHarness('codex', { client: { name: 'my-app' } });
const session = harness.open({ id: 'review', folder: process.cwd() });
try {
  const run = harness.run(session, 'Explain this project');
  for await (const event of run.events) {
    if (event.type === 'tool.updated') console.log(event.tool.kind, event.tool.status);
  }
  const { status, error, messages } = await run.result; // completed, failed or interrupted
  console.log(status, error, messages);
} finally {
  await harness.close();
}
```

From the repository root, run the complete [chat example](https://korus-dev.github.io/multi-agent-sdk/guide/quick-start.html):

```sh
node --experimental-strip-types examples/chat.ts codex 'Explain this project'
```

| Need | Start here |
| --- | --- |
| Install and connect | [Setup](https://korus-dev.github.io/multi-agent-sdk/guide/installation.html) · [First conversation](https://korus-dev.github.io/multi-agent-sdk/guide/quick-start.html) |
| Restore chats and load history | [Sessions and history](https://korus-dev.github.io/multi-agent-sdk/guide/sessions.html) |
| Approvals, MCP, and scoped work | [Tools and permissions](https://korus-dev.github.io/multi-agent-sdk/guide/tools.html) |
| Streaming, requests, and accounting | [State and events](https://korus-dev.github.io/multi-agent-sdk/guide/events.html) |
| Every operation, entry and type | [API reference](https://korus-dev.github.io/multi-agent-sdk/api/) |
| Build a conversation UI | [Agent UI SDK](https://github.com/Korus-Dev/agent-ui-sdk) |
| Integrate the raw Codex protocol | [Codex SDK](https://github.com/Korus-Dev/codex-sdk) |

The host owns storage, application workflows, authorization, and attachment retention. The SDK owns provider integration and conversation projection. See the detailed [consumer contract](https://korus-dev.github.io/multi-agent-sdk/consumer-contract.html).

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run dev:docs
```

See the [development guide](https://korus-dev.github.io/multi-agent-sdk/guide/development.html) for local dependency source mode, tests, package validation, and release preparation.

## License

[Apache-2.0](LICENSE).
