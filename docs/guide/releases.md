# Releases

Releases are explicit operations. Validation and a prepared workflow do not publish a package or change GitHub repository visibility.

1. Publish a compatible Codex SDK dependency first and update its exact dependency pin and lockfile here.
2. Choose a package version, update package/lock metadata, and document its user-visible changes in `CHANGELOG.md`.
3. Run `npm ci` and `npm run check` without local source or tarball overrides. Inspect the packed contents and confirm public metadata, license, docs, and exports.
4. Commit and push the reviewed change under the maintainer's normal approval process.
5. Configure npm trusted publishing for `Korus-Dev/multi-agent-sdk`, workflow `publish.yml` and environment `npm`. Configure that GitHub environment with the maintainer release policy. Run that workflow on `main` with the exact committed version.
6. Independently verify npm metadata, tarball integrity/contents, provenance, and a clean install from the public registry. Create release notes for that verified version.

The manual workflow validates the requested version against both manifests, reruns all checks, checks production dependency advisories, and publishes with OIDC provenance. It has no npm token secret and never runs on ordinary pushes or pull requests. Publishing is serialized and restricted to `main`.

The [documentation site](https://korus-dev.github.io/multi-agent-sdk/) is built with VitePress and hosted on GitHub Pages. The docs workflow builds and deploys on relevant pushes to `main`, and can also be dispatched manually on `main`. It publishes `docs/.vitepress/dist` using `/multi-agent-sdk/` as the site base.
