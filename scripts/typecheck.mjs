import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceTypecheck } from './sdk-sources.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const [kind, ...args] = process.argv.slice(2);
const selected = sourceTypecheck(root, args);
try {
  const cli = require.resolve(kind === 'vue' ? 'vue-tsc/bin/vue-tsc.js' : 'typescript/bin/tsc');
  const result = spawnSync(process.execPath, [cli, ...selected.args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { selected.cleanup(); }
