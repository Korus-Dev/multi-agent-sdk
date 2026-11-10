import { afterEach, expect, it, vi } from 'vitest';
import { acpEnvironment, antigravityHome, resolveAcpRuntime } from '../../../src/providers/antigravity/runtime';
const fixture = vi.hoisted(() => ({ files: new Set<string>() }));
vi.mock('../../../src/runtime/discovery', () => ({
  resolveRuntimeExecutable: (file: string) => fixture.files.has(file) ? file : null,
  withDiscoveredRuntimePath: () => ({ PATH: '/node/bin:/usr/bin' }),
}));
afterEach(() => { fixture.files.clear(); vi.unstubAllEnvs(); });

it('ignores application runtime environment and retains neutral CLI discovery', () => {
  vi.stubEnv('APP_ANTIGRAVITY_COMMAND', '/product/agy');
  vi.stubEnv('ANTIGRAVITY_HARNESS_PATH', '');
  const command = process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par';
  const harness = process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external';
  fixture.files.add(command); fixture.files.add(harness);
  expect(resolveAcpRuntime('/data')).toMatchObject({ command, harness });
});

it('uses explicit host paths without falling back when the configured command is missing', () => {
  fixture.files.add('/host/agy'); fixture.files.add('/host/harness');
  expect(resolveAcpRuntime('/data', { command: '/host/agy', harnessPath: '/host/harness' })).toMatchObject({ command: '/host/agy', harness: '/host/harness' });
  expect(resolveAcpRuntime('/data', { command: '/missing/agy', harnessPath: '/host/harness' })).toBeNull();
});

it('preserves vendor-native home and child runtime PATH', () => {
  vi.stubEnv('GEMINI_HOME', '/native/gemini');
  expect(antigravityHome('/data')).toBe('/native/gemini');
  expect(acpEnvironment('/native/gemini', '/host/harness', '/temp')).toMatchObject({ PATH: '/node/bin:/usr/bin', GEMINI_HOME: '/native/gemini', ANTIGRAVITY_HARNESS_PATH: '/host/harness' });
});
