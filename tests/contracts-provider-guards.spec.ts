import { describe, expect, it } from 'vitest';
import { harnessProviders, isHarnessProvider, isProviderConversationRef } from '../src/contracts-entry';

describe('provider guards', () => {
  it('recognises exactly the supported providers', () => {
    for (const provider of harnessProviders) expect(isHarnessProvider(provider)).toBe(true);
    expect([undefined, null, 'gemini', 7, {}].some(isHarnessProvider)).toBe(false);
  });

  it('accepts a well-formed conversation reference for every provider', () => {
    expect(isProviderConversationRef({ provider: 'codex', conversationId: 't' })).toBe(true);
    expect(isProviderConversationRef({ provider: 'claude', folder: null, conversationId: 's', subagentId: 'a' })).toBe(true);
    expect(isProviderConversationRef({ provider: 'cursor', folder: '/work', conversationId: 's' })).toBe(true);
    expect(isProviderConversationRef({ provider: 'antigravity', folder: null, conversationId: 's' })).toBe(true);
  });

  it('rejects malformed references', () => {
    for (const value of [null, [], 'codex', { provider: 'codex' }, { provider: 'codex', conversationId: ' ' }, { provider: 'claude', conversationId: 's' }, { provider: 'cursor', folder: 1, conversationId: 's' }, { provider: 'cursor', folder: ' ', conversationId: 's' }, { provider: 'claude', folder: null, conversationId: 's', subagentId: 1 }, { provider: 'claude', folder: null, conversationId: 's', subagentId: ' ' }, { provider: 'other', threadId: 't' }]) {
      expect(isProviderConversationRef(value)).toBe(false);
    }
  });
});
