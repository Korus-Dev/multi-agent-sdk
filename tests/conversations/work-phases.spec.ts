import { describe, expect, it } from 'vitest';
import type { ClaudeConversationSnapshot, Message, MessagePart } from '../../src/contracts';
import { createClaudeConversationReplica } from '../../src/conversations/claude-conversation-replica';
import { createCursorConversationReplica, emptyCursorSnapshot } from '../../src/conversations/cursor-conversation-replica';
import { createAntigravityConversationReplica, emptyAntigravitySnapshot } from '../../src/conversations/antigravity-conversation-replica';
import * as contractsEntry from '../../src/contracts-entry';

// Codex tags each text part with its work phase natively. The other harnesses do not, so their replicas tag it:
// text before the turn's last tool call is commentary, text after it is the final answer.
const message = (id: string, turnId: string, role: Message['role'], parts: MessagePart[]): Message =>
  ({ id, agentId: 'agent', turnId, role, status: 'complete', createdAt: '2026-11-11T10:00:00.000Z', parts });
const text = (value: string, phase?: 'commentary' | 'final_answer'): MessagePart => ({ type: 'text', text: value, ...(phase ? { phase } : {}) });
const tool = (id: string): MessagePart => ({ type: 'tool', id, kind: 'generic', title: id, status: 'completed' });
const phases = (messages: readonly Message[]) => messages.flatMap(m => m.parts.flatMap(part => part.type === 'text' ? [[part.text, part.phase]] : []));

const conversation = [
  message('u1', 'turn-1', 'user', [text('Fix the bug')]),
  message('a1', 'turn-1', 'assistant', [text('Looking at the code.'), tool('read'), text('Fixed it.')]),
  message('u2', 'turn-2', 'user', [text('Thanks')]),
  message('a2', 'turn-2', 'assistant', [text('You are welcome.')]),
];
const claudeSnapshot = (messages: Message[]): ClaudeConversationSnapshot => ({ agentId: 'agent', sessionId: 'session', activeTurnId: null, turnIds: [], turns: [], messages,
  answeredClientRequestIds: [], busy: false, historyLoading: false, historyState: { hasOlder: false, loadingOlder: false }, contextUsage: null, plan: null, error: null });
const replicas = {
  claude: (messages: Message[]) => createClaudeConversationReplica(claudeSnapshot(messages)),
  cursor: (messages: Message[]) => createCursorConversationReplica({ ...emptyCursorSnapshot('agent', 'session'), messages }),
  antigravity: (messages: Message[]) => createAntigravityConversationReplica({ ...emptyAntigravitySnapshot('agent', 'session'), messages }),
};

describe.each(Object.entries(replicas))('%s replica work phases', (_provider, create) => {
  it('tags assistant text turn by turn and leaves user text and tool-free turns alone', () => {
    expect(phases(create(structuredClone(conversation)).getSnapshot().messages)).toStrictEqual([
      ['Fix the bug', undefined], ['Looking at the code.', 'commentary'], ['Fixed it.', 'final_answer'], ['Thanks', undefined], ['You are welcome.', undefined],
    ]);
  });

  it('recomputes phases, so an answer that a later tool call turns into commentary does not keep a stale tag', () => {
    const later = [message('a1', 'turn-1', 'assistant', [text('Fixed it.', 'final_answer'), tool('test'), text('Tests pass.')])];
    expect(phases(create(later).getSnapshot().messages)).toStrictEqual([['Fixed it.', 'commentary'], ['Tests pass.', 'final_answer']]);
  });
});

it('keeps the inference internal: apps read phase, they never compute it', () => {
  expect(contractsEntry).not.toHaveProperty('withInferredWorkPhases');
  expect(contractsEntry).not.toHaveProperty('withInferredTurnWorkPhases');
});
