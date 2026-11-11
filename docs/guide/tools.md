# Tools and permissions

## Permissions and requests

Query `getCapabilities(session).permissions` for supported opaque permission IDs. Pass one to `setPermission(session, id)` only after an explicit host/user choice. Omission of a caller preset preserves the native policy when loading existing conversations.

Listen for requests and answer them through the owning session:

```ts
await driver.respondToRequest(session, {
  id: request.id,
  outcome: { kind: 'decision', decision: 'deny' },
});
```

Question outcomes use `{ kind: 'answered', answers }`; cancellation uses `{ kind: 'cancelled', reason? }`. Answer shapes and allowed scopes come from the request. Do not silently convert a request to approval.

## MCP

Hosts supply named HTTP MCP endpoints through `mcpServers`:

```ts
const driver = createHarness('codex', {
  client: { name: 'my-app' },
  mcpServers: () => [{
    name: 'ledger',
    url: 'http://127.0.0.1:9000/mcp',
    enabledTools: ['read_balance'],
    approval: 'inherit',
  }],
});
```

Tool availability and approval policy are separate. Omitted `approval`, or `inherit`, uses native policy. `auto` explicitly trusts the selected tools and is supported only by Codex and Claude. `required: true` enforces startup connection only on Codex. Unsupported policy requests reject. `required: false` remains optional and is a no-op on providers without startup enforcement.

## Scoped work and generation

`executeScopedPrompt(parent, { prompt, cwd, scope, session?, signal? })` runs auxiliary work under an explicit scope ID, instructions, tools, and MCP configuration. It returns text and a scoped session handle. Continue that handle through its parent with the same scope contract; do not use main-session sends on it. Cancellation affects only that scope. Await `disposeScopedSession(scopeSession)` when done, before releasing its parent.

`generateText` supports explicit model selection, output schemas, optional read-only inspection tools, authorized image attachments, cancellation, and invocation-local MCP capabilities. `generateImage` uses a provider-supported native path. These utilities do not imply that every provider implements every option; preserve native errors and consult catalogs/capabilities where available.

Model and reasoning selections belong to the provider. Use `listModels` rather than maintaining an application-wide list of model names. Usage observations describe reported evidence, including fields that remain unknown.
