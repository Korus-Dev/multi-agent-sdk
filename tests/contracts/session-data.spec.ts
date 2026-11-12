import { describe, expect, it } from 'vitest';
import {
  conversationRefId, conversationSessionData, isProviderSessionData, sameConversationRef, sessionConversationId, sessionConversationRef,
  sessionHasConversation, subagentOfRef, subagentRef,
} from '../../src/contracts-entry';
import type { ProviderConversationRef, ProviderSessionData } from '../../src/contracts';

// An app stores what a harness hands out for persistence and asks these readers about it, never its provider's shape.
const sessions: ProviderSessionData[] = [
  { kind: 'codex', conversationId: 'thread-1' },
  { kind: 'claude', conversationId: 'session-1', transport: 'stdio' },
  { kind: 'cursor', conversationId: 'session-1' },
  { kind: 'antigravity', conversationId: 'session-1' },
];

describe('session data readers', () => {
  it.each(sessions)('names the conversation of %o and finds it again by reference', data => {
    expect(sessionConversationId(conversationSessionData(data.kind, sessionConversationId(data)))).toBe(sessionConversationId(data));
    const ref = sessionConversationRef(data, '/work');
    expect(conversationRefId(ref)).toBe(sessionConversationId(data));
    expect(sessionHasConversation(data, ref)).toBe(true);
    expect(isProviderSessionData(data)).toBe(true);
  });

  it('tells conversations apart by provider, id, folder and subagent transcript', () => {
    const claude: ProviderConversationRef = { provider: 'claude', folder: '/work', conversationId: 's' };
    expect(sameConversationRef(claude, { ...claude })).toBe(true);
    expect(sameConversationRef(claude, { ...claude, folder: '/elsewhere' })).toBe(false);
    expect(sameConversationRef(claude, { ...claude, subagentId: 'a' })).toBe(false);
    expect(sameConversationRef(claude, { provider: 'cursor', folder: '/work', conversationId: 's' })).toBe(false);
    expect(sameConversationRef({ provider: 'codex', conversationId: 't' }, { provider: 'codex', conversationId: 't' })).toBe(true);
  });

  it.each([
    { provider: 'codex', conversationId: 'root' },
    { provider: 'claude', folder: '/work', conversationId: 'root' },
  ] as ProviderConversationRef[])('finds a subagent of %o by reference, and the reference by subagent', root => {
    const ref = subagentRef(root, 'agent-1')!;
    expect(subagentOfRef(ref, root)).toBe('agent-1');
    expect(subagentOfRef(root, root)).toBeUndefined();
  });

  it('keeps no subagent transcripts for providers without them', () => {
    expect(subagentRef({ provider: 'cursor', folder: null, conversationId: 's' }, 'a')).toBeNull();
  });

  it('follows a Claude session to the transcript it continues', () => {
    const data: ProviderSessionData = { kind: 'claude', conversationId: 'live', transport: 'stdio', transcriptConversationId: 'transcript', transcriptFolder: '/store' };
    expect(sessionConversationRef(data, '/work')).toEqual({ provider: 'claude', folder: '/store', conversationId: 'transcript' });
    expect(sessionHasConversation(data, { provider: 'claude', folder: null, conversationId: 'live' })).toBe(true);
  });

  it('rejects data no harness can restore', () => {
    for (const value of [null, {}, { kind: 'other', sessionId: 's' }, { kind: 'codex' }, { kind: 'claude', conversationId: 's' }, { kind: 'cursor', conversationId: ' ' }]) {
      expect(isProviderSessionData(value)).toBe(false);
    }
  });

  it('reads the permission persisted defaults select', () => {
  });
});
