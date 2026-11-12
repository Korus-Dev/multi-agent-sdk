import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acpEnvironment, acpHomeArguments, antigravityHome, antigravityVersion, resolveAcpRuntime } from '../../../src/providers/antigravity/runtime';
const fixture = vi.hoisted(() => ({ files: new Set<string>() }));
vi.mock('../../../src/runtime/discovery', () => ({
  resolveRuntimeExecutable: (file: string) => fixture.files.has(file) ? file : null,
  withDiscoveredRuntimePath: () => ({ PATH: '/node/bin:/usr/bin', GEMINI_API_KEY: 'secret', GOOGLE_CLOUD_PROJECT: 'project' }),
}));
afterEach(() => { fixture.files.clear(); vi.unstubAllEnvs(); });
const cli = process.platform === 'win32' ? 'agy.exe' : 'agy';

it('runs the globally installed CLI as an ACP server, like every other harness', () => {
  expect(resolveAcpRuntime()).toBeNull();
  fixture.files.add(cli);
  expect(resolveAcpRuntime()).toStrictEqual({ command: cli, args: ['acp'] });
});

it('uses an explicit host path without falling back when it is missing', () => {
  fixture.files.add(cli); fixture.files.add('/host/agy');
  expect(resolveAcpRuntime({ command: '/host/agy' })).toStrictEqual({ command: '/host/agy', args: ['acp'] });
  expect(resolveAcpRuntime({ command: '/missing/agy' })).toBeNull();
});

it('points the CLI at a home by its path from the user\'s home, and leaves the CLI\'s own home alone', () => {
  expect(antigravityHome()).toBe(path.join(homedir(), '.gemini'));
  expect(antigravityHome('/data')).toBe('/data/antigravity-home');
  expect(acpHomeArguments(path.join(homedir(), '.gemini'))).toStrictEqual([]);
  expect(acpHomeArguments(path.join(homedir(), '.app', 'antigravity-home'))).toStrictEqual(['--gemini-dir', path.join('.app', 'antigravity-home')]);
  // A folder outside the user's home is still reached by a relative path, which is all the CLI accepts.
  expect(acpHomeArguments('/var/app-home')).toStrictEqual(['--gemini-dir', path.relative(homedir(), '/var/app-home')]);
});

it('keeps API keys and cloud credentials out of the CLI, which signs in with its own account', () => {
  expect(acpEnvironment('/temp')).toStrictEqual({ PATH: '/node/bin:/usr/bin', TMPDIR: '/temp' });
});

it('compares CLI versions, since the CLI updates itself', () => {
  expect(antigravityVersion('1.5.6')! > antigravityVersion('1.5.1')!).toBe(true);
  expect(antigravityVersion('1.4.5')! < antigravityVersion('1.5.1')!).toBe(true);
  expect(antigravityVersion('nightly')).toBeNull();
});
