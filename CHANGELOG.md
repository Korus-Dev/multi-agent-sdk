# Changelog

## Unreleased

- `createHarness(provider, options)` is the only way to reach a provider. Each provider is one class behind a single registry, and shared code never branches on the provider. Options are typed per provider: a Codex harness takes no `claude` block.
- The root entry is provider-neutral. `/codex`, `/claude`, `/cursor` and `/antigravity` export that provider's types only; `/native` and `/host-bridge` are removed, and provider hosts, transports and the Codex engine are internal.
- `/renderer` is now `/contracts`: data contracts, guards and capability tables for code that runs without Node. Its list of exports is frozen and only shrinks. The `Renderer*` type aliases and the per-provider conversation projections are removed.
- `forkConversation(session, target, turnId?)` forks into the target session's folder. Without a turn, a running source forks from its last completed turn, and the result reports `forkedFromTurnId`. It resolves `null` when the provider cannot fork the conversation yet. `forkWorktreeConversation` is removed.
- Assistant text carries its work phase (`commentary` or `final_answer`) for every provider. `isBookkeepingTool` tells the harness which of the app's own tool calls are not work. The phase inference helpers and Claude's `inferWorkPhases` option are removed.
- The SDK adds no prompt text or policy of its own. Plan-exit denial, session-handoff wording and Antigravity's inspection and schema wording are removed; apps supply them through `claude.decideTool` and their own prompts. `outputSchema` is rejected where the provider cannot enforce it.
- `startReview` runs a provider's own review. Codex's `/review` prompt command now starts the native review instead of sending text.
- Every optional operation has a capability flag, kept in step with its implementation by a conformance test. New flags cover interrupted-turn continuation, conversation content and storage, turn history, and MCP support for required servers and automatic approval. Claude reports reasoning effort and service tiers.
- `Harness` covers login, remote control, realtime, conversation summaries and storage, interrupted-turn continuation, conversation reconciliation, session syncing and provider-level capabilities. Operations a provider lacks reject with `HarnessUnsupportedError`.
- `session.patch` events carry each change to a session as plain JSON ops with a revision, so a session's state can cross a wire incrementally. `readSessionSnapshot` returns the state at a revision to start from, `applySessionPatch` applies a patch, and a missed revision throws `SessionPatchGapError` and an invalid patch throws `SessionPatchInvalidError`, so the consumer reads a fresh snapshot. `session.changed` carries the same revision.
- `SessionState.planMode` reports whether the session plans before acting, for providers that track it.
- Tool confirmation requests carry the `itemId` of the transcript tool call they confirm, so an app can show the two as one.
- `harness.onEvent` forwards provider events, including those without a session, as `provider.event`.
- Persisted and wire names use `provider` instead of `backend`.
- `/testing` provides `createScriptedHarness`, `createScriptedCodexHarness` and `createScriptedClaudeHarness`: Harnesses whose provider is scripted by the test.
- `/runtime` finds provider executables and builds their search path.
- `npm run check:package` fails when the public types reach a provider engine or use display wording, so neither can leak back in.

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
