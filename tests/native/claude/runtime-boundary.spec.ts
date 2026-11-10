import { afterEach, expect, it, vi } from 'vitest';
import { resolveClaudeLaunch } from '../../../src/providers/claude/claude-command';

vi.mock('node:module', () => ({ createRequire: () => ({ resolve: () => '/vendor/claude' }) }));
vi.mock('node:fs', () => ({ existsSync: (file: string) => file === '/vendor/claude' }));
afterEach(() => vi.unstubAllEnvs());

it('ignores application command and resource environment during neutral discovery', () => {
  vi.stubEnv('APP_CLAUDE_COMMAND', '/product/claude');
  vi.stubEnv('APP_ASSETS_PATH', '/product/resources');
  const discover = vi.fn((command: string) => ({ command, env: { PATH: '/node/bin', APP_ASSETS_PATH: '/product/resources' } }));
  expect(resolveClaudeLaunch(undefined, undefined, {}, discover).command).toBe('/vendor/claude');
  expect(discover).toHaveBeenCalledWith('claude', undefined, {});
});

it('launches an explicit host command with its discovered Node PATH and native environment', () => {
  const env = { PATH: '/node/bin:/usr/bin', CODEX_HOME: '/native/codex', GEMINI_HOME: '/native/gemini' };
  const discover = vi.fn((command: string) => ({ command, env }));
  expect(resolveClaudeLaunch('/host/claude', env, {}, discover)).toEqual({ command: '/host/claude', env });
  expect(discover).toHaveBeenCalledWith('/host/claude', env, {});
});

it('prefers the discovered CLI over the optional vendor binary', () => {
  const discover = vi.fn(() => ({ command: '/login/bin/claude', env: { PATH: '/node/bin' } }));
  expect(resolveClaudeLaunch(undefined, undefined, {}, discover).command).toBe('/login/bin/claude');
});

it('uses real discovery to augment an explicit launch with the login-shell Node PATH', () => {
  const env = { PATH: '/inherited/bin', GEMINI_HOME: '/vendor/home' };
  const launch = resolveClaudeLaunch('/host/claude', env, {
    platform: 'darwin', homedir: () => '/test-home',
    existsSync: file => file === '/host/claude',
    execFileSync: () => '__APP_RUNTIME_PATH_START__/node/bin:/usr/bin__APP_RUNTIME_PATH_END__',
  });
  expect(launch.command).toBe('/host/claude');
  expect(launch.env.PATH).toBe('/node/bin:/usr/bin:/inherited/bin');
  expect(launch.env.GEMINI_HOME).toBe('/vendor/home');
});
