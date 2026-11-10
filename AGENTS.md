# Multi Agent SDK contributor instructions

Keep this package focused on the neutral Node harness contract, provider-native
adapters, conversation projections, and reusable runtime/catalog/MCP operations.
Raw Codex protocol/transports belong in codex-sdk. Vue/Electron/speech controls
belong in agent-ui-sdk. Product workflows and persistence belong in host apps.

Preserve admission versus completion, opaque driver-owned handles, native settings
inheritance, provider-owned state, and unknown usage/settings evidence. Do not add
SDK serialization policy or concurrent multi-home infrastructure.

Use behavioral tests at the owning boundary. Follow [testing](docs/guide/testing.md),
prove regressions red before fixing them, and keep statement coverage at 85%.
Run `npm run check` before handoff. The package check validates a real tarball;
for an unpublished Codex dependency, see [development](docs/guide/development.md).
Update the guide/API docs and runnable examples when public behavior changes.

Preserve unrelated work. Do not create branches, commit, push, or publish without
explicit user authorization. Native live tests require a separate opt-in; normal
checks must not log in, execute paid prompts, or change the user's provider homes.
