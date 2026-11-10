# Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm run typecheck:tests
npm run test:ai
npm run build
npm run check:package
npm run build:docs
```

`npm run check` is the final handoff gate and runs the full suite with coverage. Use `test:ai` for quiet unit-test iteration. Use Node 26.12.1 for development; CI covers Node 22.19.0, 24 and 26. Coverage requires at least 85% statements across `src/**/*.ts`. Tests use two workers so process-backed fixtures stay within their deadlines on shared machines. Native authenticated model calls are not part of the default suite.

Vite builds ESM JavaScript and TypeScript emits declarations unchanged. The package uses `main` and `types`, with ESNext modules and Bundler resolution. Static public forwarding files keep optional browser and native modules separate. Package validation creates and installs an actual npm tarball into a temporary consumer, imports public runtime entries in plain Node, and typechecks consumer code. It does not start a provider or execute a model turn.

## Dependency maintenance

Direct SDK dependencies are pinned, including the Claude Agent SDK's Anthropic,
MCP and Zod peers, so package consumers receive the validated versions.
VitePress uses a scoped Vite 6.4.6 override. Validate both documentation builds and
the development server when changing this override.

## Dependency source mode

Published npm dependencies are the default. Set `SDK_LOCAL_SOURCE=1` in `.env` to use sibling SDK source in Vite/tests. `SDK_SOURCE_ROOT` selects another common parent containing `codex-sdk`, `multi-agent-sdk`, and `agent-ui-sdk`. Build dependencies in that order. Typechecking uses the local dependency declarations; runtime tests use source. `SDK_LOCAL_SOURCE=0` explicitly disables source mode.

Source mode is development tooling, not a runtime package feature. Package validation
installs dependencies from npm and verifies the same public entry points consumers
use. Publish sibling dependencies before running release qualification.

## Documentation and audit

`npm run dev:docs` starts VitePress. `npm run build:docs` typechecks runnable examples and builds every documentation page with dead-link checks. Keep prose focused on supported behavior and host outcomes.

The repository's `audits/` directory records the extraction audit, source ownership,
and file-level provenance. Assessment scripts are not part of the published SDK.
