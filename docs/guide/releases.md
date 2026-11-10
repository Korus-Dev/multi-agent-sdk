# Releases

Releases are explicit operations. Validation and a prepared workflow do not publish a package or change GitHub repository visibility.

1. Publish a compatible Codex SDK dependency first and update its exact dependency pin and lockfile here.
2. Choose a package version, update package/lock metadata, and document its user-visible changes in `CHANGELOG.md`.
3. Run `npm ci --ignore-scripts` and `npm run check` without local source overrides. Inspect the packed contents and confirm public metadata, license, and entry points.
4. Commit and push the reviewed change under the maintainer's normal approval process.
5. Run `publish.yml` on `main` with the exact committed version. The workflow uses npm trusted publishing.
6. Independently verify npm metadata, tarball integrity/contents, provenance, and a clean install from the public registry. Create release notes for that verified version.

The manual workflow checks that the requested version matches `package.json`, runs the standard quality gates, and packs the checked tree with scripts disabled. It publishes that tarball with OIDC provenance, without rebuilding. The workflow has no npm token secret and runs only when dispatched on `main`. The GitHub release is created after publication succeeds.

The [documentation site](https://korus-dev.github.io/multi-agent-sdk/) is built with VitePress and hosted on GitHub Pages. The docs workflow builds and deploys on relevant pushes to `main`, and can also be dispatched manually on `main`. It publishes `docs/.vitepress/dist` using `/multi-agent-sdk/` as the site base.
