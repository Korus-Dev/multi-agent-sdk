# Contributing

Use Node.js 26.12.1 and npm for development. CI also covers Node 22.19.0 and 24. Start with `npm ci --ignore-scripts`, then `npm run check`.

- [Development](docs/guide/development.md): dependency source mode and package checks.
- [Testing](docs/guide/testing.md): behavioral regression tests and coverage.
- [Releases](docs/guide/releases.md): versioning, registry prerequisites, and trusted publishing.

Keep raw Codex protocol work in codex-sdk, UI/Electron/speech work in agent-ui-sdk,
and product workflows/storage in host applications. This repository owns the neutral
harness contract, native adapters, conversation projections, and reusable runtime operations.

Describe the user-visible problem and validation in pull requests. Update documentation
and examples when changing the public contract. Avoid credentials and private provider
history in issues, fixtures, logs, and screenshots.

The package is ESM-only. TypeScript uses ES2022 output syntax, ESNext modules and
Bundler resolution. Public root and extensionless subpaths are declared in `package.json` exports; Vite emits JavaScript and the declaration build uses
`tsconfig.build.json`. Package validation checks a real installed tarball in plain
Node ESM and a strict TypeScript consumer. Release workflows publish a tarball
from the checked tree without running build scripts again.

## Agent test runs

During development, agents run tests only with `npm run test:ai -- <name-or-path>`
or `npm run test:ai` for the whole unit suite. Do not call `vitest`, `npx vitest`,
or `npm test` directly. `npm run check` remains the final handoff gate;
`test:ai` is for iteration.

Off-limits to agents without explicit authorization: tests that launch installed
native providers or use live accounts, browser/Playwright suites, and publishing.
Mocked/scripted provider fixtures in the unit suite do not launch real providers.
