# Tools and permissions

## Permissions and requests

Every harness has one permission model. `getCapabilities(session).permissions` (or `getProviderCapabilities().permissions` before a session exists) lists the permissions the harness offers, each with a stable ID and a `dangerous` flag for the unrestricted ones.

Permission IDs are the provider's own modes, not an SDK vocabulary: Codex offers its approval presets (`ask-for-approval`, `approve-for-me`, `full-access`), Claude its permission modes (`default`, `acceptEdits`, `dontAsk`, `auto`, `bypassPermissions`), and Cursor and Antigravity their CLI modes. Your app therefore offers what each provider's own tool offers, and users who know a provider find the same choices. Build the list from the capabilities rather than hard-coding it, and label the IDs you present. Where the provider is known when you write the code, `PermissionFor<'claude'>`, `CodexPermission` (from `/codex`) and `ClaudePermission` (from `/claude`) type the IDs.

```ts
// Before a conversation exists, read the harness's capabilities; afterwards, read the session's.
const { permissions } = harness.getProviderCapabilities();
const cautious = permissions.find(permission => !permission.dangerous);

// Start a conversation with one permission, then change it after an explicit choice by the user.
const session = harness.open({ id: 'main', folder: process.cwd(), defaults: { permission: cautious?.id } });
await harness.setPermission(session, permissions[0]!.id);
```

`defaults.permission` holds one permission ID, and `setPermission(session, id)` changes it. `SessionState.permission` reports the permission the conversation runs with. A loaded conversation keeps its own permission unless you set another.

Listen for requests and answer them through the owning session:

```ts
await harness.respondToRequest(session, {
  id: request.id,
  outcome: { kind: 'decision', decision: 'deny' },
});
```

Question outcomes use `{ kind: 'answered', answers }`; cancellation uses `{ kind: 'cancelled', reason? }`. Answer shapes and allowed scopes come from the request. Do not silently convert a request to approval.

## MCP

Hosts supply named HTTP MCP endpoints through `mcpServers`:

```ts
import { createHarness } from '@korus-dev/multi-agent-sdk';

const harness = createHarness('codex', {
  client: { name: 'my-app' },
  mcpServers: () => [{
    name: 'ledger',
    url: 'http://127.0.0.1:9000/mcp',
    enabledTools: ['read_balance'],
    approval: 'inherit',
  }],
});
```

Tool availability and approval policy are separate. Omitted `approval`, or `inherit`, uses native policy. `auto` explicitly trusts the selected tools and is supported only by Codex and Claude. Antigravity runs the tools of connected MCP servers without asking in every permission mode, so connect only servers you trust there. `required: true` enforces startup connection only on Codex. Unsupported policy requests reject. `required: false` remains optional and is a no-op on providers without startup enforcement.

## Scoped work and generation

`executeScopedPrompt(parent, { prompt, cwd, scope, session?, signal? })` runs auxiliary work under an explicit scope ID, instructions, tools, and MCP configuration. It returns the turn's final answer as `text`, never the commentary written along the way, and a scoped session handle. Continue that handle through its parent with the same scope contract; do not use main-session sends on it. Cancellation affects only that scope. Await `disposeScopedSession(scopeSession)` when done, before releasing its parent.

`generateText` supports explicit model selection, output schemas, optional read-only inspection tools, authorized image attachments, cancellation, and invocation-local MCP capabilities. `generateImage` uses a provider-supported native path. These utilities do not imply that every provider implements every option; preserve native errors and consult catalogs/capabilities where available.

Model and reasoning selections belong to the provider. Use `listModels` rather than maintaining an application-wide list of model names. Usage observations describe reported evidence, including fields that remain unknown.
