# Development

```sh
npm ci
npm run typecheck
npm run typecheck:tests
npm run test:coverage
npm run build
npm run check:package
npm run build:docs
```

`npm run check` runs these gates together. Coverage requires at least 85% statements across `src/**/*.ts`. Tests use two workers so process-backed fixtures stay within their deadlines on shared machines. Native authenticated model calls are not part of the default suite.

Vite builds ESM JavaScript and TypeScript emits declarations unchanged. The package uses `main` and `types`, with ESNext modules and Bundler resolution. Static public forwarding files keep optional browser and native modules separate. Package validation creates and installs an actual npm tarball into a temporary consumer, imports public runtime entries in plain Node, and typechecks consumer code. It does not start a provider or execute a model turn.

## Dependency source mode

Published npm dependencies are the default. Set `SDK_LOCAL_SOURCE=1` in `.env` to use sibling SDK source in Vite/tests. `SDK_SOURCE_ROOT` selects another common parent containing `codex-sdk`, `multi-agent-sdk`, and `agent-ui-sdk`. Build dependencies in that order. Typechecking uses the local dependency declarations; runtime tests use source. `SDK_LOCAL_SOURCE=0` explicitly disables source mode.

Source mode is development tooling, not a runtime package feature or an alternative to installing dependencies. Before the Codex dependency is published, validate a local package explicitly:

```sh
# Build codex-sdk, then pack it outside either repository.
(cd ../codex-sdk && npm pack --pack-destination /tmp)
SDK_CODEX_TARBALL=/tmp/korus-dev-codex-sdk-0.167.0.tgz npm run check:package
```

The override applies only to the isolated package consumer. It does not change this package's dependency manifest or prove public registry availability. A clean registry install requires the pinned Codex SDK release to exist first.

## Documentation and audit

`npm run dev:docs` starts VitePress. `npm run build:docs` typechecks runnable examples and builds every documentation page with dead-link checks. Keep prose focused on supported behavior and host outcomes.

The repository's `audits/` directory records the extraction audit, source ownership,
and file-level provenance. Assessment scripts are not part of the published SDK.
