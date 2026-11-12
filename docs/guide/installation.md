# Setup

Install in a Node.js 22.19+ application:

```sh
npm install @korus-dev/multi-agent-sdk
```

The package is ESM-only. Use `"type": "module"` in your application and configure TypeScript with `module: "ESNext"` and `moduleResolution: "Bundler"`. Use extensionless package subpaths, such as `@korus-dev/multi-agent-sdk/contracts`. The legacy `node10` resolution mode cannot resolve these exports. Code that runs in a browser imports `/contracts` and receives session state from the app, rather than importing the Node harness root.

## Provider runtimes

| Provider | Runtime and authentication |
| --- | --- |
| `codex` | A Codex CLI with app-server support, authenticated in the selected Codex home. The adapter uses `@korus-dev/codex-sdk` for transport and discovery. |
| `claude` | Claude Code and the bundled Claude Agent SDK transport, using native authentication and configuration. |
| `cursor` | Cursor's `agent` or `cursor-agent` executable with ACP support. The adapter requires version 2026.10.08 or newer. |
| `antigravity` | The Antigravity CLI (`agy`) 1.5.1 or later, signed in. |

The package does not provision provider subscriptions or store application API keys. Check `driver.getRuntimeStatus()` for discovery status and use `await driver.authenticate({ action: 'check' })` for native account status. Authentication actions and account details differ by provider.

## Homes and working folders

`home` selects a provider configuration/data home. It must be absolute. Omit it to use native discovery. A session's `folder` selects its workspace and is independent of `home`.

```ts
import { createHarness } from '@korus-dev/multi-agent-sdk';

const driver = createHarness('codex', {
  client: { name: 'my-app', version: '1.0.0' },
  home: '/srv/my-app/codex-profile',
});
```

Use one home per driver. Switch by awaiting `close()` and constructing a fresh driver. Claude's configuration home is process-wide: close the current Claude runtime before opening another profile. This interface does not provide concurrent multi-home isolation.

Continue with [your first conversation](quick-start.md).
