import { describe, expect, it } from 'vitest';
import {
  conversationRefId, conversationSessionData, defaultsPermission, isProviderSessionData, sameConversationRef, sessionConversationId, sessionConversationRef,
  sessionHasConversation, subagentOfRef, subagentRef,
} from '../../src/contracts-entry';
import type { ProviderConversationRef, ProviderSessionData } from '../../src/contracts';

// An app stores what a harness hands out for persistence and asks these readers about it, never its provider's shape.
const sessions: ProviderSessionData[] = [
  { kind: 'codex', threadId: 'thread-1' },
  { kind: 'claude', sessionId: 'session-1', transport: 'stdio' },
  { kind: 'cursor', sessionId: 'session-1' },
  { kind: 'antigravity', sessionId: 'session-1' },
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
    const claude: ProviderConversationRef = { provider: 'claude', folder: '/work', sessionId: 's' };
    expect(sameConversationRef(claude, { ...claude })).toBe(true);
    expect(sameConversationRef(claude, { ...claude, folder: '/elsewhere' })).toBe(false);
    expect(sameConversationRef(claude, { ...claude, subagentId: 'a' })).toBe(false);
    expect(sameConversationRef(claude, { provider: 'cursor', folder: '/work', sessionId: 's' })).toBe(false);
    expect(sameConversationRef({ provider: 'codex', threadId: 't' }, { provider: 'codex', threadId: 't' })).toBe(true);
  });

  it.each([
    { provider: 'codex', threadId: 'root' },
    { provider: 'claude', folder: '/work', sessionId: 'root' },
  ] as ProviderConversationRef[])('finds a subagent of %o by reference, and the reference by subagent', root => {
    const ref = subagentRef(root, 'agent-1')!;
    expect(subagentOfRef(ref, root)).toBe('agent-1');
    expect(subagentOfRef(root, root)).toBeUndefined();
  });

  it('keeps no subagent transcripts for providers without them', () => {
    expect(subagentRef({ provider: 'cursor', folder: null, sessionId: 's' }, 'a')).toBeNull();
  });

  it('follows a Claude session to the transcript it continues', () => {
    const data: ProviderSessionData = { kind: 'claude', sessionId: 'live', transport: 'stdio', transcriptSessionId: 'transcript', transcriptFolder: '/store' };
    expect(sessionConversationRef(data, '/work')).toEqual({ provider: 'claude', folder: '/store', sessionId: 'transcript' });
    expect(sessionHasConversation(data, { provider: 'claude', folder: null, sessionId: 'live' })).toBe(true);
  });

  it('rejects data no harness can restore', () => {
    for (const value of [null, {}, { kind: 'other', sessionId: 's' }, { kind: 'codex' }, { kind: 'claude', sessionId: 's' }, { kind: 'cursor', sessionId: ' ' }]) {
      expect(isProviderSessionData(value)).toBe(false);
    }
  });

  it('reads the permission persisted defaults select', () => {
    expect(defaultsPermission({ kind: 'codex', approvalPreset: 'full-access' })).toBe('full-access');
    expect(defaultsPermission({ kind: 'claude', permissionMode: 'acceptEdits' })).toBe('acceptEdits');
    expect(defaultsPermission(undefined)).toBeUndefined();
  });
});
