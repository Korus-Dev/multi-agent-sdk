import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform === 'darwin')('skips macOS speech helper validation on other hosts', () => {
  const script = fileURLToPath(new URL('../../../scripts/verify-native-assets.mjs', import.meta.url));
  expect(execFileSync(process.execPath, [script], { encoding: 'utf8' })).toContain('skipping macOS-only Apple speech helper');
});
