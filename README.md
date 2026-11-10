# @korus-dev/multi-agent-sdk

A unified Node.js interface for Codex, Claude, Cursor and Antigravity coding harnesses. Provider-owned replicas preserve native conversation state. See the [consumer contract](docs/consumer-contract.md) for sessions, requests, scoped execution and optional native entry points.

## Local development

Install dependencies with `npm ci` in this repository. npm packages are used by default. Set `SDK_LOCAL_SOURCE=1` in `.env` to run dependency source from sibling SDK repositories; `SDK_SOURCE_ROOT` can point to another directory containing `codex-sdk`, `multi-agent-sdk` and `agent-ui-sdk`. Build local dependencies first, in that order. Vite and tests use live source; typechecking uses the local builds’ declarations. `SDK_LOCAL_SOURCE=0` explicitly selects installed npm packages.
