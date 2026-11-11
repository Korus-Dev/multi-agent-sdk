import { expect, it } from 'vitest';
import { conversationMessages } from '../../src/providers/codex/host-adapter';

it('turns a Codex question part into the neutral question request', () => {
  const [message] = conversationMessages([{ id: 'a1', role: 'assistant', status: 'complete', turnId: 'turn-1', parts: [{ type: 'question', historical: true, request: {
    id: 'async-question:item-1', kind: 'ask_user', conversationId: 'thread-1', turnId: 'turn-1', itemId: 'item-1',
    payload: { request: { itemId: 'item-1', delivery: 'async', blocking: false, questions: [{ id: 'q1', header: 'Ship?', question: 'Ship it?', isOther: false, isSecret: false, options: null }] } },
  } }] }], 'agent');
  expect(message?.parts[0]).toStrictEqual({ type: 'question', historical: true, request: {
    id: 'async-question:item-1', kind: 'question', conversationId: 'thread-1', turnId: 'turn-1', itemId: 'item-1',
    question: { itemId: 'item-1', delivery: 'async', blocking: false, questions: [{ id: 'q1', header: 'Ship?', question: 'Ship it?', isOther: false, isSecret: false, options: null }] },
  } });
});
