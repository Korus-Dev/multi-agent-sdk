# Multi Agent SDK contributor instructions

## Role

This package is one interface to any agent harness (Codex, Claude Code, Cursor, Antigravity). An app is written once and runs against any provider unchanged, or mixes providers and relies on polymorphism so its own code stays simple. Consumer code must never branch on the provider: differences are reported as capabilities, and provider-specific classes and engines stay internal. The Host interface is allowed to be large, because a harness does a lot. It stays stateless and does no agent coordination, persistence, pricing or workflows; those are application concerns. Apps decide how permission ids, labels and settings are presented.

Keep this package focused on the neutral Node harness contract, provider-native
adapters, conversation projections, and reusable runtime/catalog/MCP operations.
Raw Codex protocol/transports belong in codex-sdk. Vue/Electron/speech controls
belong in agent-ui-sdk. Product workflows and persistence belong in host apps.

Preserve admission versus completion, opaque driver-owned handles, native settings
inheritance, provider-owned state, and unknown usage/settings evidence. Do not add
SDK serialization policy or concurrent multi-home infrastructure.

Use behavioral tests at the owning boundary. Follow [testing](docs/guide/testing.md),
prove regressions red before fixing them, and keep statement coverage at 85%.
Run `npm run check` before handoff. The package check validates a real installed
tarball with plain Node ESM imports and strict Bundler types.
Update the guide/API docs and runnable examples when public behavior changes.

Preserve unrelated work. Do not create branches, commit, push, or publish without
explicit user authorization. Native live tests require a separate opt-in; normal
checks must not log in, execute paid prompts, or change the user's provider homes.

Keep ESM-only output and TypeScript ES2022 / ESNext / Bundler settings. Build
runtime JavaScript with Vite and declarations with `tsconfig.build.json`;
`tsconfig.tests.json` checks source, fixtures and test configuration without emit.
Dependency versions are exact pins. Keep verification, commits, pushes and npm
publication as separate explicitly authorized actions.

## Agent test runs

During development, agents run tests only with `npm run test:ai -- <name-or-path>`
or `npm run test:ai` for the whole unit suite. Do not call `vitest`, `npx vitest`,
or `npm test` directly. `npm run check` remains the final handoff gate;
`test:ai` is for iteration.

Off-limits to agents without explicit authorization: tests that launch installed
native providers or use live accounts, browser/Playwright suites, and publishing.
Mocked/scripted provider fixtures in the unit suite do not launch real providers.
