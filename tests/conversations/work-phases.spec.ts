import { describe, expect, it } from 'vitest';
import type { ClaudeConversationSnapshot, Message, MessagePart } from '../../src/contracts';
import { createClaudeConversationReplica } from '../../src/conversations/claude-conversation-replica';
import { createCursorConversationReplica, emptyCursorSnapshot } from '../../src/conversations/cursor-conversation-replica';
import { createAntigravityConversationReplica, emptyAntigravitySnapshot } from '../../src/conversations/antigravity-conversation-replica';
import { createScriptedHarness } from '../../src/testing';
import { codexHarnessCapabilities } from '../../src/contracts-entry';

// A replica reports a conversation as the provider supplied it. Codex states each text part's work phase itself and
// says so with `capabilities.workPhases`; a phase a provider states is kept as stated.
const message = (id: string, turnId: string, role: Message['role'], parts: MessagePart[]): Message =>
  ({ id, agentId: 'agent', turnId, role, status: 'complete', createdAt: '2026-11-11T10:00:00.000Z', parts });
const tool = (id: string): MessagePart => ({ type: 'tool', id, kind: 'generic', title: id, status: 'completed' });

const supplied = [
  message('u1', 'turn-1', 'user', [{ type: 'text', text: 'Fix the bug' }]),
  message('a1', 'turn-1', 'assistant', [{ type: 'text', text: 'Looking at the code.' }, tool('read'), { type: 'text', text: 'Fixed it.' }]),
];
const stated = [message('a1', 'turn-1', 'assistant', [{ type: 'text', text: 'Fixed it.', phase: 'final_answer' }, tool('read')])];
const claudeSnapshot = (messages: Message[]): ClaudeConversationSnapshot => ({ agentId: 'agent', sessionId: 'session', activeTurnId: null, turnIds: [], turns: [], messages,
  answeredClientRequestIds: [], busy: false, historyLoading: false, historyState: { hasOlder: false, loadingOlder: false }, contextUsage: null, plan: null, error: null });

const replicas = {
  claude: (messages: Message[]) => createClaudeConversationReplica(claudeSnapshot(messages)),
  cursor: (messages: Message[]) => createCursorConversationReplica({ ...emptyCursorSnapshot('agent', 'session'), messages }),
  antigravity: (messages: Message[]) => createAntigravityConversationReplica({ ...emptyAntigravitySnapshot('agent', 'session'), messages }),
};

describe.each(Object.entries(replicas))('%s replica', (_provider, create) => {
  it('reports the conversation exactly as the provider supplied it', () => {
    expect(create(structuredClone(supplied)).getSnapshot().messages).toStrictEqual(supplied);
  });
  it('keeps a work phase the provider stated', () => {
    expect(create(structuredClone(stated)).getSnapshot().messages).toStrictEqual(stated);
  });
});

describe.each(['claude', 'cursor', 'antigravity'] as const)('%s session state', provider => {
  it('reports the conversation exactly as the provider supplied it', () => {
    const { harness, script } = createScriptedHarness(provider);
    const session = harness.open({ id: 'agent', folder: '/work' });
    const snapshot = provider === 'claude' ? claudeSnapshot(supplied)
      : { ...(provider === 'cursor' ? emptyCursorSnapshot('agent', 'session') : emptyAntigravitySnapshot('agent', 'session')), messages: supplied };
    script.emit({ type: `${provider}.conversationSnapshotChanged`, agentId: 'agent', provider, payload: { revision: 1, snapshot } } as never);
    expect(harness.readSession(session).messages).toStrictEqual(supplied);
  });
});

it('codex reports that it states work phases itself', () => {
  expect(codexHarnessCapabilities.workPhases).toBe(true);
});
