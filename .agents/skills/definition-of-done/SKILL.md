---
name: definition-of-done
description: Verify Multi Agent SDK work before handoff, commit, or push. Use after repository changes.
---

# Definition of Done

Use proportional evidence. The user's requested validation depth is authoritative.

## Before handoff

- Inspect `git status --short`; preserve unrelated changes. Do not create
  branches, commit, push, or publish unless the user asks: verification, commit,
  push, and publish are separate actions.
- Behavior changes get tests at the owning boundary, proven red before the fix
  and green after, following `docs/guide/testing.md`. Test behavior that exists;
  do not add tests that assert a removed behavior is gone.
- Iterate with `npm run test:ai -- <name-or-path>`, or `npm run test:ai` for the
  whole unit suite. Never call `vitest`, `npx vitest`, or `npm test` directly.
- Run `npm run check` before handoff. It owns typecheck, test typecheck, tests
  with the 85% statement coverage floor, the build, installed-package validation
  (`check:package`), and the docs build with its runnable examples. Set
  `SDK_LOCAL_SOURCE=0` when no sibling SDK source should be used, always for a
  release.
- Do not launch installed harnesses, use live accounts, or run paid prompts.
  Native live tests need a separate opt-in.
- Run `git diff --check` after the final edit.

## Design checks

- Consumer code never branches on the harness. Differences are reported as
  capabilities, and harness-specific classes stay internal. The provider-neutral
  core (`src/harness.ts`) names no harness.
- The root entry stays harness-neutral. Changing the `./contracts` exports means
  updating `scripts/contracts-entry-allowlist.json`; `check:package` enforces it.
- A change to saved or wire shapes (session data, references, patches) is a
  breaking change: say so in the changelog.

## Documentation gate

Treat the docs as the public SDK surface. For every change, decide and report one:

- **Updated:** public API, behavior, configuration, defaults, or recommended
  workflows changed. Update `docs/api/` for exact contracts, `docs/guide/` for
  usage, `docs/consumer-contract.md` for lifecycle rules, and `README.md` only
  for discovery. Update `docs/.vitepress/config.mts` when pages move or are
  added, then run `npm run build:docs`.
- **No impact:** state why the change is internal.

Docs describe the current state only, in terms of what an app builder can do,
with no history and no application-specific wording. In prose, "harness" means
Codex, Claude Code, Cursor, and Antigravity, never the SDK itself.

A user-visible change also gets a bullet under "Unreleased" in `CHANGELOG.md`,
written as an outcome. Mark breaking changes.

## Versioning

Consumers such as `agent-ui-sdk` and apps pin exact versions. A patch release
changes nothing a consumer uses: types, contract fields, option names, events.
Anything breaking goes in a minor release. Releases follow
`docs/guide/releases.md` and need their own authorization.

## Report

Summarize the outcome and public API or contract impact, checks actually run and
their results, documentation impact (Updated or No impact), the changelog entry,
the version impact for consumers, and remaining unrelated changes. Explain any
failures or warnings. Commit or push only when requested.
