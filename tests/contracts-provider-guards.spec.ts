import { describe, expect, it } from 'vitest';
import { harnessProviders, isHarnessProvider, isProviderConversationRef } from '../src/renderer';

describe('provider guards', () => {
  it('recognises exactly the supported providers', () => {
    for (const provider of harnessProviders) expect(isHarnessProvider(provider)).toBe(true);
    expect([undefined, null, 'gemini', 7, {}].some(isHarnessProvider)).toBe(false);
  });

  it('accepts a well-formed conversation reference for every provider', () => {
    expect(isProviderConversationRef({ provider: 'codex', threadId: 't' })).toBe(true);
    expect(isProviderConversationRef({ provider: 'claude', folder: null, sessionId: 's', subagentId: 'a' })).toBe(true);
    expect(isProviderConversationRef({ provider: 'cursor', folder: '/work', sessionId: 's' })).toBe(true);
    expect(isProviderConversationRef({ provider: 'antigravity', folder: null, sessionId: 's' })).toBe(true);
  });

  it('rejects malformed references', () => {
    for (const value of [null, [], 'codex', { provider: 'codex' }, { provider: 'codex', threadId: ' ' }, { provider: 'claude', sessionId: 's' }, { provider: 'cursor', folder: 1, sessionId: 's' }, { provider: 'cursor', folder: ' ', sessionId: 's' }, { provider: 'claude', folder: null, sessionId: 's', subagentId: 1 }, { provider: 'claude', folder: null, sessionId: 's', subagentId: ' ' }, { provider: 'other', threadId: 't' }]) {
      expect(isProviderConversationRef(value)).toBe(false);
    }
  });
});
