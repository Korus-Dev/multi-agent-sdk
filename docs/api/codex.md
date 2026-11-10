# Native Codex host

Import `createCodexHost` or `CodexAppBackend` from `@korus-dev/multi-agent-sdk/codex` when your host needs Codex-specific functionality. Public host types, including `CodexConversationSnapshot`, can be imported type-only from the package root.

The host supports conversation handles and snapshots, message sends, history paging, forks, settings, approvals, model/skill/plugin catalogs, goals, usage, dynamic tools, MCP, realtime sessions, review operations, and remote-control pairing. These are native contracts; they are not portable promises for other providers.

## Extensions and host policy

`CodexHostOptions` accepts transport/client configuration, home/workspace policy, conversation defaults, and extensions. `CodexHostExtension` supplies dynamic tool implementations and per-conversation configuration hooks. Keep raw configuration, tool executors, environment variables, and arbitrary trusted paths in host code.

A native host integration can set `CodexHostAdapterOptions.inheritNativeSettings = true` to preserve loaded conversation settings while still applying application defaults to new conversations. `SessionState.selection` projects known native metadata without inventing model, reasoning effort, or service-tier evidence.

In `createHarnessDriver('codex', options)`, `codex.host` contains `CodexHostOptions`
for the native engine, and `codex.adapter` contains `CodexHostAdapterOptions` for
application policy. For example:

```ts
import { createHarnessDriver } from '@korus-dev/multi-agent-sdk';

const driver = createHarnessDriver('codex', {
  client: { name: 'my-app' },
  codex: {
    host: { codexHome: '/srv/my-app/codex-profile' },
    adapter: { inheritNativeSettings: true },
  },
});
```

## Conversations and bridges

`createCodexConversationReplica` and the host mirror helpers maintain provider-owned snapshots and incremental state. Bridge operations validate payloads before invoking a trusted target. They do not provide website authentication or application authorization.

Electron/renderer native integrations, attachments, speech, and Vue controls belong to [Agent UI SDK](https://github.com/Korus-Dev/agent-ui-sdk).

## Protocol ownership

The host uses [Codex SDK](https://github.com/Korus-Dev/codex-sdk) for the raw app-server client, generated wire types, executable discovery, and stdio/socket transports. Import that package directly for raw JSON-RPC integration and protocol compatibility information.
