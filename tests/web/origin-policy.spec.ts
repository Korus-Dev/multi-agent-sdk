import { describe, expect, it } from 'vitest';
import { isAllowedCodexWebSocketOrigin } from '../../src/web/server';

const allowed = ['http://127.0.0.1:3000', 'https://app.example.com/'];

describe('Codex WebSocket origin policy', () => {
  it.each([
    ['the exact app origin', 'http://127.0.0.1:3000', true],
    ['an equivalent origin spelling', 'HTTPS://App.Example.com:443', true],
    ['a cross-site page', 'https://attacker.example', false],
    ['the same host on another port', 'http://127.0.0.1:3001', false],
    ['a DNS-rebinding host name', 'http://attacker.example:3000', false],
    ['an opaque origin', 'null', false],
    ['a malformed origin', 'not a url', false],
  ])('treats %s as allowed=%s', (_label, origin, expected) => {
    expect(isAllowedCodexWebSocketOrigin({ headers: { origin } }, allowed)).toBe(expected);
  });

  it('rejects upgrades without exactly one Origin header', () => {
    expect(isAllowedCodexWebSocketOrigin({ headers: {} }, allowed)).toBe(false);
    expect(isAllowedCodexWebSocketOrigin({
      headers: { origin: ['http://127.0.0.1:3000', 'https://attacker.example'] },
    }, allowed)).toBe(false);
  });

  it('fails loudly on a misconfigured allowlist', () => {
    expect(() => isAllowedCodexWebSocketOrigin(
      { headers: { origin: 'http://127.0.0.1:3000' } },
      ['127.0.0.1:3000'],
    )).toThrow('Invalid allowed Codex WebSocket origin');
  });
});
