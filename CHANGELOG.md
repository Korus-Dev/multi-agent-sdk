# Changelog

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
