# Contributing

Use Node.js 22.19+ and npm. Start with `npm ci`, then `npm run check`.

- [Development](docs/guide/development.md): dependency source mode and package checks.
- [Testing](docs/guide/testing.md): behavioral regression tests and coverage.
- [Releases](docs/guide/releases.md): versioning, registry prerequisites, and trusted publishing.

Keep raw Codex protocol work in codex-sdk, UI/Electron/speech work in agent-ui-sdk,
and product workflows/storage in host applications. This repository owns the neutral
harness contract, native adapters, conversation projections, and reusable runtime operations.

Describe the user-visible problem and validation in pull requests. Update documentation
and examples when changing the public contract. Avoid credentials and private provider
history in issues, fixtures, logs, and screenshots.
