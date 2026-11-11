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
type Rules = { isBookkeepingTool?: (tool: { title?: string }) => boolean };
const replicas = {
  claude: (messages: Message[], rules?: Rules) => createClaudeConversationReplica(claudeSnapshot(messages), rules),
  cursor: (messages: Message[], rules?: Rules) => createCursorConversationReplica({ ...emptyCursorSnapshot('agent', 'session'), messages }, rules),
  antigravity: (messages: Message[], rules?: Rules) => createAntigravityConversationReplica({ ...emptyAntigravitySnapshot('agent', 'session'), messages }, rules),
};

describe.each(Object.entries(replicas))('%s replica work phases', (_provider, create) => {
  it('tags assistant text turn by turn and leaves user text and tool-free turns alone', () => {
    expect(phases(create(structuredClone(conversation)).getSnapshot().messages)).toStrictEqual([
      ['Fix the bug', undefined], ['Looking at the code.', 'commentary'], ['Fixed it.', 'final_answer'], ['Thanks', undefined], ['You are welcome.', undefined],
    ]);
  });

  it('does not count the app\'s bookkeeping tools as work', () => {
    const bookkeeping = (part: { title?: string }) => part.title === 'finish';
    const turn = [message('a1', 'turn-1', 'assistant', [text('Reading.'), tool('read'), text('All done.'), tool('finish')])];
    expect(phases(create(turn, { isBookkeepingTool: bookkeeping }).getSnapshot().messages)).toStrictEqual([['Reading.', 'commentary'], ['All done.', 'final_answer']]);
    expect(phases(create(turn).getSnapshot().messages)).toStrictEqual([['Reading.', 'commentary'], ['All done.', 'commentary']]);
  });

  it('gives a message without a turn its own group', () => {
    const loose = [{ ...message('a0', 'x', 'assistant', [text('Preamble.')]), turnId: undefined }, message('a1', 'turn-1', 'assistant', [tool('read'), text('Answer.')])];
    expect(phases(create(loose).getSnapshot().messages)).toStrictEqual([['Preamble.', undefined], ['Answer.', 'final_answer']]);
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

it('hands the app\'s bookkeeping rule to every harness that tags phases itself', async () => {
  const { harnesses } = await import('../../src/harnesses');
  const isBookkeepingTool = () => true;
  const options = { client: { name: 'x' }, isBookkeepingTool };
  expect(harnesses.claude.mapOptions(options).claude?.host?.isBookkeepingTool).toBe(isBookkeepingTool);
  expect(harnesses.cursor.mapOptions(options).cursor?.sessionOptions?.isBookkeepingTool).toBe(isBookkeepingTool);
  expect(harnesses.antigravity.mapOptions(options).antigravity?.isBookkeepingTool).toBe(isBookkeepingTool);
});
