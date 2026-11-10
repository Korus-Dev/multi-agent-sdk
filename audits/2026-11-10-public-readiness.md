# Extraction and public package audit — 2026-11-10

The audit identified no missing implementation file from the original Codex App
SDK within this repository's agreed scope. The main gaps were public documentation,
quality/release automation, npm consumer validation, and TypeScript checking of
migrated tests. Those gaps are closed in this working tree. Publication remains
blocked by the dependency/release prerequisites below.

The initial extraction audit changed no file under `src/`. The subsequent approved packaging alignment changes only root exports and Codex type import paths, preserving native implementation behavior. No branch, commit, push, npm publication, repository visibility change, or workflow dispatch was performed.

## Scope and evidence

Compared all **1,608 Git-tracked files** in `codex-app-sdk` at
`564f7f6b65e327d7a63d4b18fa472320f5f3d27c` with the working trees of the three SDKs.
The starting Multi Agent SDK commit was `2bfc30148da9cc2c57cfd3deea7b2db70654b96b`.
The [file inventory](extraction-inventory.json) records destination paths, source and
destination hashes for implementation/test matches, ownership, and intentional
non-copy dispositions. Sibling repositories had concurrent work; their recorded
HEADs do not imply their working trees were clean or frozen.

The inventory distinguishes byte-identical copies, imports-only changes, adapted
files, and topic-level replacements. A matching filename is only a locator. Source
comparison, import-normalized similarity review, and the owning behavioral suite
support the conclusions; they are not proof of all native/live-provider behavior.

| Original area | Disposition |
| --- | --- |
| Core surface, events, replicas, prompt helpers and bridge | Here: `src/core`, `src/contracts`, `src/prompt.ts`. Shared DTO extraction explains the smaller core surface. Original native attachment/speech contracts belong in Agent UI SDK's host contracts. |
| Backend native Node code | 47 original files are represented here under `src/providers/codex`; 3 transport/executable files belong in Codex SDK and 3 speech files in Agent UI SDK. No missing in-scope file identified. |
| Backend tests | 66 original files are represented here; 7 protocol/transport tests belong in Codex SDK and 3 speech tests in Agent UI SDK. |
| Core tests | 7 original files here; native host capability tests in Agent UI SDK. |
| Original website transport and tests | Excluded following the explicit scope decision. The earlier inventory is historical provenance; it is not the current public API. |
| Raw client, generated protocol/schema, wire and schema tooling | Codex SDK; intentionally not duplicated here. |
| Vue, Electron, native attachments, speech helpers/assets | Agent UI SDK; intentionally not duplicated here. |
| Original conversation sidebar and its test | Host-owned navigation/history UI; intentionally excluded. Original retained. |
| Original aggregate conversation-pane test | Reorganized into Agent UI SDK's controller, controlled-pane and feature-level tests. Inventory points to the controller test; this is a responsibility mapping, not a byte-equivalence claim. |
| Old aggregate `src/` exports | Replaced by independent package exports and deliberate native compatibility seams. |
| UI samples, labs, Electron/web applications and scaffolder | App/UI concerns. This package now supplies a small typed Node lifecycle example; copying entire old apps here would cross the agreed boundary. |
| Plans, experiments, old release history | Historical material remains in the original. New package changelog describes this package's current surface. |

The non-Codex native adapters originated in Korus rather than the original SDK.
They are covered by the existing provider and consumer suites here. This assessment
does not invent Codex equivalents for their provider-owned behaviors.

## Documentation disposition

| Original documentation topics | Current owner / result |
| --- | --- |
| README, installation, quick start | Rewritten here for the neutral package and its native runtime prerequisites. |
| Architecture, backend, surface, native capabilities | Here: API exports/operations, native Codex surface reference, detailed consumer contract. Raw protocol documentation remains in Codex SDK. |
| Authentication | Here: setup and account/runtime guidance; provider-native details remain explicit. |
| Conversations, history | Here: sessions/restoration/history/settings guide, including read-only Codex history and archive behavior. |
| Events, messages/tools, approvals, MCP, extensions | Here: state/events and tools/permissions guides plus native surface extension guidance. |
| Original website integration guide | Excluded from this package following the scope decision. |
| Security | Here: trusted host boundary, credentials, restoration data, attachments and single-home limitations. UI HTML/Electron policy belongs in Agent UI SDK. |
| Development, testing | Here: contributor instructions, behavioral test policy adapted from the original, strict fixture typechecking, coverage, packaging and source-mode tooling. Original testing policy was copied and byte-compared before adapting its UI-only sections. |
| Troubleshooting | Here: runtime, authentication, admission/completion, settings, handles, recovery, previews and development failures. |
| API node/surface/events/web | Here: supported entry points and driver operation reference; exact signatures remain in published declarations. |
| API JSON-RPC, generated schema inventory | Codex SDK. |
| Vue, providers UI, app UI, conversation pane, composer, presentation, Electron, dictation | Agent UI SDK; this SDK documents the neutral state/adapter integration boundary only. |
| Samples/scaffolding | Node example here; UI/application examples and generator stay outside this package. |
| Remote control/realtime/review | Native Codex surface seam here; not promoted into unsupported neutral capabilities. |

Documentation is a **VitePress site** with navigation, local search, API and guide
sections, and dead-link-checked production build. Published npm contents include
Markdown guides and the typed example; generated site output and assessment
artifacts are excluded from the tarball.

## Gaps closed

- Expanded README with installation, lifecycle semantics, documentation links,
  package boundaries, development and license information.
- Added VitePress guides/reference, runnable Node example, contributor instructions
  and changelog.
- The final package uses `main`/`types` without an export map. Public types live at the root; optional values use static public forwarding modules without build-directory paths.
- Added package metadata and build-before-pack. Vite builds runtime output and plain TypeScript emits declarations; there is no declaration finalizer. Consumer qualification targets ESNext/Bundler.
- Added actual tarball installation, public runtime import, all-entry declaration,
  and external consumer compilation checks. An explicit local Codex tarball can
  qualify local artifacts while the dependency is unpublished; CI/release do not
  use that override.
- Added strict test TypeScript checking. Fixed stale private imports, product-only
  fixture fields, incomplete protocol payloads, unused symbols and un-narrowed
  recorded message access. Removed one test that only asserted an untouched mock
  had never been called; it exercised no retirement behavior. Removed the obsolete
  host-owned delegation-field assertion while preserving the native send workflow.
- Bounded the suite to two workers after a four-worker run hit the existing
  process-fixture deadline. No deadlines or coverage thresholds were weakened.
- Added pull-request/main quality CI on Node 22.19 and 24, including source/test
  types, coverage, build, actual package consumer checks, docs and production audit.
- Added serialized manual npm trusted publishing on main with committed version/
  lockfile checks, placeholder-version rejection, provenance, an `npm` environment,
  quality gates and GitHub release creation.
- Added docs build workflow and explicitly dispatched GitHub Pages deployment.
- Removed the one-off assessment generator and temporary repair script. Retained
  only build/package/release tooling needed for ongoing quality and publication.

## Validation

| Check | Result |
| --- | --- |
| Complete `npm run check`, installed dependency mode with explicitly supplied local Codex tarball | Passed: source types, test types, suite/coverage, build, package consumer, example types and VitePress. |
| Behavioral suite | **1,806 passed, 1 skipped**; 129 passing files, one skipped file. |
| Statement coverage | **87.03%**, unchanged from the baseline, above the 85% gate. |
| Actual packed consumer | **536 files, 69 runtime exports**; plain Node imports and ESNext/Bundler TypeScript checks, `skipLibCheck: false`. Every public runtime entry also imported as a type namespace. |
| Local-source mode | Source and test typechecks passed against sibling declarations. |
| VitePress | Production build and link checks passed. |
| Workflow YAML | All three workflows parsed successfully. Hosted Actions/OIDC/Pages were not executed. |
| Release negative probe | Placeholder version `0.0.0` rejected as intended. |
| Registry consumer | Fails with npm 404 for the pinned `@korus-dev/codex-sdk@0.0.0`; local qualification is not registry availability. |
| Production dependency audit | 2 high and 1 moderate advisory findings; not silently ignored or auto-upgraded. |
| Native implementation diff | Packaging alignment adds root exports and changes type import paths; no native behavior changes. |

The local checks ran on macOS / Node 26.12.1. The committed CI matrix supplies
Linux and supported Node-version qualification once the pinned dependency is
installable. No authenticated provider execution was performed during this audit.

## Remaining launch blockers and decisions

1. **Publish Codex SDK first.** This package now pins `0.167.0` and the local tarball is qualified separately from public registry installation. Publish that dependency through its owner, then regenerate/verify the registry lock entry. Clean registry installation and hosted CI require that dependency to exist.
2. **Resolve production dependency advisories with approval.** `npm audit
   --omit=dev` reports high findings for `@modelcontextprotocol/sdk` and `zod`,
   and a moderate finding for `@hono/node-server` in the installed peer/transitive
   graph. The new high-severity CI/release gate deliberately blocks on them. These
   are advisory results, not an exploitability determination. Runtime dependency
   upgrades were deferred to respect the instruction to confirm code-related gaps.
   The full audit also reports dev-tool advisories, including Vite/VitePress/Vitest;
   those need compatible toolchain remediation, not an unreviewed force upgrade.
3. **Configure release infrastructure.** The initial Multi version is `0.25.0`; configure npm's
   trusted publisher for the repository/workflow/environment, configure the `npm`
   GitHub environment, and select Actions as the GitHub Pages source if hosting the
   site. Repository visibility, publication, commits and pushes require their own
   explicit actions; none was taken here.
4. **Qualify the final release artifacts.** After dependency remediation, run clean
   registry installation, the Linux Node matrix and the release checks; verify npm
   tarball/provenance and the deployed docs after an authorized release.

No native runtime code port is proposed from this comparison. If subsequent
behavioral or live-provider evidence exposes a missing implementation, confirm its
scope before changing the proven runtime.

## Final packaging alignment

The approved package contract uses `main: ./dist/index.js` and
`types: ./dist/index.d.ts`, without an exports map or declaration finalizer.
Ordinary public types, including UI DTOs, `CodexConversationSnapshot`,
`CodexSurface`, and distinct native harness aliases, are type-only root exports.
`TypedEventBus` is also a root value export for Node hosts. Browser-only prompt
and bridge values remain isolated behind their small static public entry files.
The optional native/Codex modules have static entry files. The later explicit scope decision removes standalone website hosting support.

Owning tests import local source, not their own package. Codex dependency imports
now use that package's root and `v2` type namespace, pinned at `0.167.0`.
The retained local-source helper resolves `main`, `types`, and static public files;
it no longer depends on an exports map.

Final validation: full check passed with a locally packed Codex dependency,
1,806 tests passed / one skipped, 87.03% statement coverage, source and test
TypeScript checks passed in installed-dependency and local-source modes, VitePress
built, and the actual package qualified 552 packed files / nine root-and-optional
entry points with ESNext/Bundler compilation and plain Node imports. Dependency
advisories and publication prerequisites remain separate release blockers.

## Standalone website support removed

Following the explicit scope decision, this package no longer contains the
WebSocket website transport, its public forwarding files, tests, guide, navigation,
or package/build/typecheck entries. The historical file inventory marks the
original website package as outside the current scope. Generic renderer bridges
used by Electron and native provider/realtime transports remain intact.

Validation after removal: 1,676 tests passed, one skipped, 86.67% statement coverage;
source/test typechecks passed in installed-dependency and local-source modes;
VitePress built; and the installed tarball passed plain Node imports and
ESNext/Bundler compilation for 529 packed files and five entry points. Package
validation was first demonstrated failing against the prior artifact and now
rejects any residual website transport files in new tarballs.
