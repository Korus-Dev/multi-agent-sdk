import { describe, expect, it } from 'vitest';
import {
  absoluteCodexHome,
  isUnixSocketTransportOptions,
  surfaceTransportOptions,
} from '../../src/providers/codex/codex-surface-transport-options';

describe('Codex surface transport options', () => {
  it('validates and normalizes the Codex home path', () => {
    expect(absoluteCodexHome(' /tmp/codex-home ')).toBe('/tmp/codex-home');
    expect(() => absoluteCodexHome('  ')).toThrow('cannot be empty');
    expect(() => absoluteCodexHome('relative/home')).toThrow('must be an absolute path');
  });

  it('merges top-level and explicit transport settings', () => {
    expect(surfaceTransportOptions({ codexHome: ' /tmp/codex-home ' })).toStrictEqual({
      codexHome: '/tmp/codex-home',
    });
    expect(surfaceTransportOptions({ transport: { command: 'codex-test' } })).toStrictEqual({
      command: 'codex-test',
    });
    expect(surfaceTransportOptions({
      codexHome: '/tmp/codex-home',
      transport: { command: 'codex-test', codexHome: '/tmp/codex-home' },
    })).toStrictEqual({ command: 'codex-test', codexHome: '/tmp/codex-home' });
    expect(() => surfaceTransportOptions({
      codexHome: '/tmp/one', transport: { codexHome: '/tmp/two' },
    })).toThrow('conflicts with transport.codexHome');
  });

  it('recognizes only the explicit unix-socket transport', () => {
    expect(isUnixSocketTransportOptions({ type: 'unixSocket', socketPath: '/tmp/codex.sock' })).toBe(true);
    expect(isUnixSocketTransportOptions({ command: 'codex' })).toBe(false);
    expect(isUnixSocketTransportOptions({ type: 'stdio' } as never)).toBe(false);
  });
});
