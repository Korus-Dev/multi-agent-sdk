# Native Codex surface

Import `createCodexSurface` or `CodexAppBackend` from `@korus-dev/multi-agent-sdk/codex.js` when your host needs Codex-specific functionality. Public surface types, including `CodexConversationSnapshot`, can be imported type-only from the package root.

The surface supports conversation handles and snapshots, message sends, history paging, forks, settings, approvals, model/skill/plugin catalogs, goals, usage, dynamic tools, MCP, realtime sessions, review operations, and remote-control pairing. These are native contracts; they are not portable promises for other providers.

## Extensions and host policy

`CodexSurfaceOptions` accepts transport/client configuration, home/workspace policy, conversation defaults, and extensions. `CodexSurfaceExtension` supplies dynamic tool implementations and per-conversation configuration hooks. Keep raw configuration, tool executors, environment variables, and arbitrary trusted paths in host code.

A native host integration can set `CodexHostOptions.inheritNativeSettings = true` to preserve loaded conversation settings while still applying application defaults to new conversations. `SessionState.selection` projects known native metadata without inventing model, reasoning effort, or service-tier evidence.

## Conversations and bridges

`createCodexConversationReplica` and the surface mirror helpers maintain provider-owned snapshots and incremental state. Bridge operations validate payloads before invoking a trusted target. They do not provide website authentication or application authorization.

Use [web integration](../guide/web.md) to project an authorized Codex surface over WebSockets. Electron/renderer native integrations, attachments, speech, and Vue controls belong to [Agent UI SDK](https://github.com/Korus-Dev/agent-ui-sdk).

## Protocol ownership

The surface uses [Codex SDK](https://github.com/Korus-Dev/codex-sdk) for the raw app-server client, generated wire types, executable discovery, and stdio/socket transports. Import that package directly for raw JSON-RPC integration and protocol compatibility information.
