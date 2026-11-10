# Testing policy

Tests must protect observable SDK behavior. Test count and coverage are
constraints, not goals.

## Value gate

For every test added or kept, identify:

1. the production regression it prevents;
2. the externally observable contract that proves the regression;
3. why an existing test does not already cover that risk.

The test should survive an equivalent implementation, harmless rewording, or
file move. Prefer a meaningful workflow or state transition over a call-through
check; after a mutation, observe its result through a read, event, rendered
state, persistence check, or cleanup. Do not repeat the same contract at every
layer: give its detailed assertion to the closest owner and use only a distinct
integration risk to justify another test.

A test that still passes when the owner always returns one constant result does
not prove its claimed behavior. Use table cases for distinct mappings, not to
inflate the case count.

Prove the test red under the defect, missing behavior, or an intentional
mutation before accepting it green. If the value gate cannot be met, improve an
existing test or remove the new one.

## Test the boundary

Use the smallest layer that observes the real contract. For app-server
translation, drive the schema-typed `MockCodexAppServer` through the real
`CodexAppServerClient`, adapters, controllers, replicas, and hosts. Assert
the outbound JSON-RPC shape and the public TypeScript result of inbound
responses or events, including ordering, identity, concurrency, and cleanup
when relevant.

The mock is a programmable fixture, not a second product. App-server internals
outside its emitted protocol are not SDK contracts. Boundary call assertions
are appropriate when the call is the public wire or host contract; SDK-internal
call assertions should become observable-result assertions. Mock external
boundaries, not SDK logic; when the full public payload is the contract, assert
its complete shape rather than cherry-picking fields. Keep fixtures independent
and clean up streams, processes, and subscriptions in `finally`.

For native process fixtures, observe emitted protocol/state and always close streams,
processes, sessions, and subscriptions. Use deferred promises or observable events
instead of fixed sleeps. Keep authenticated/paid model calls outside the default suite.

Owning unit and integration tests import local source files directly. Package-name imports are reserved for installed-tarball consumer checks; external dependencies keep their own package imports.

Run `npm run typecheck:tests` as well as the executable suite. TypeScript must check
fixtures against the same public/generated contracts as production consumers.

## Put checks in the right tool

Tests must never read committed implementation or configuration files to assert
their text or source structure. This includes manifests, npm scripts, source
files, imports, CSS, and filenames. Test observable behavior instead; enforce
structural and security rules through executable compiler, lint, AST,
dependency, build, pack, or release validation. There is no source-text test
exception for architecture or security checks.

The only file-content exception is output created by the system under test. A
scaffolder may therefore assert the temporary `package.json` or source files it
generates.

## Completion

A test change is done when the claimed regression was red, the public boundary
is green, no existing scenario proves the same risk, coverage remains above its
current thresholds without filler, and the affected `check` command passes.

## Agent test runs

During development, agents run tests only with `npm run test:ai -- <name-or-path>`
or `npm run test:ai` for the whole unit suite. Do not call `vitest`, `npx vitest`,
or `npm test` directly. `npm run check` remains the final handoff gate;
`test:ai` is for iteration.

Off-limits to agents without explicit authorization: tests that launch installed
native providers or use live accounts, browser/Playwright suites, and publishing.
Mocked/scripted provider fixtures in the unit suite do not launch real providers.
