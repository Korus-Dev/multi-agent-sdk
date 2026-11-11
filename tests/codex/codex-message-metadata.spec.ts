import { expect, it } from 'vitest';
import { conversationMessages } from '../../src/providers/codex/host-adapter';

it('keeps the answers given to non-blocking questions when Codex messages become neutral messages', () => {
  const answers = { 'question-1': { answers: ['Ship it'] } };
  const [message] = conversationMessages([{ id: 'u1', role: 'user', status: 'complete', parts: [{ type: 'text', text: 'Go' }],
    metadata: { asyncQuestionAnswers: answers, promptContent: [{ type: 'text', text: 'Go' }] } }], 'agent');
  expect(message?.metadata?.asyncQuestionAnswers).toStrictEqual(answers);
  expect(message?.metadata?.promptContent).toBeDefined();
});

it('lifts a turn Codex records only in message metadata onto the neutral message', () => {
  const [message] = conversationMessages([{ id: 'a1', role: 'assistant', status: 'complete', parts: [{ type: 'text', text: 'Done' }],
    metadata: { conversationId: 'thread', turnId: 'turn-7' } }], 'agent');
  expect(message?.turnId).toBe('turn-7');
});
