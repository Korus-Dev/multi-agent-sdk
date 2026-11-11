# Changelog

## Unreleased

- The SDK adds no prompt text or policy of its own. Plan-exit denial, session-handoff wording, the handoff model and Antigravity's inspection and schema wording are removed; consumers supply them through `claude.decideTool`, `codex.handoff` and their own prompts. `outputSchema` is rejected where the provider cannot enforce it.
- `startReview` runs a provider's own review. Codex's `/review` prompt command now starts the native review instead of sending text.
- Capabilities cover text and image generation, structured output, review, banked resets, conversation deletion, titles and scoped execution; a conformance test keeps each flag in step with the operation behind it. Antigravity reports account usage; Codex no longer claims it.
- `createHarness` is the only way to reach a provider. The `/native`, `/codex` and `/host-bridge` entries are removed; provider hosts, transports and the Codex engine are internal.
- `Harness` covers login, remote control, realtime, conversation summaries and storage, interrupted-turn continuation, conversation reconciliation, session syncing and provider-level capabilities. Operations a provider lacks reject with `HarnessUnsupportedError`.
- `harness.onEvent` forwards provider events, including those without a session, as `provider.event`.
- Persisted and wire names use `provider` instead of `backend`.
- `/testing` provides `createScriptedHarness`, `createScriptedCodexHarness` and `createScriptedClaudeHarness`: Harnesses whose provider is scripted by the test.
- `/runtime` finds provider executables and builds their search path.
- `/renderer` exports `harnessProviders`, `isHarnessProvider` and `isProviderConversationRef`.
- `npm run check:package` fails when the public types reach a provider engine, so provider engines cannot leak back in.

## 0.26.0 (2026-11-10)

- Public subpaths use extensionless imports such as `@korus-dev/multi-agent-sdk/codex`, resolved through an explicit exports map. Replace previous `.js` subpath imports; root forwarding files are removed.
- Native hosts use `CodexHost`, `ClaudeHost`, `CursorHost` and `AntigravityHost`. Shared message contracts use `ConversationMessage*`; portable contracts use canonical names without a provider prefix.
- The bridge entry is `/host-bridge`. Codex engine options use `codex.host`; adapter policy uses `codex.adapter`. SDK host events use `host.statusChanged` and `host_disconnected`.
- The generic `TtlCache` is available from the package root; text generation uses the shared `HarnessTextGenerationResult`.
- Updates the Codex SDK dependency to `0.167.1`.

## 0.25.1 (2026-11-10)

- Browser-safe renderer entry for conversation replicas, presentation, capabilities, requests and work phases.
- Native entry exposes provider hosts, transcript/authentication helpers, runtime discovery and session MCP bridging.

## 0.25.0 (2026-11-10)

- Unified Node.js harness API for Codex, Claude, Cursor, and Antigravity.
- Opaque sessions and conversation references with consumer-owned restoration data.
- Provider-owned messages, turns, approvals, history, settings, and usage observations.
- Scoped execution, runtime/catalog integration, MCP policy, and native Codex compatibility seams.
- Public guides, API reference, runnable Node example, and isolated package validation.
