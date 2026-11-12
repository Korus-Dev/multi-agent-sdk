import { describe, expect, it } from 'vitest';
import { finalAnswerText } from '../../src/conversations/final-answer';

const assistant = (turnId: string, parts: unknown[]) => ({ role: 'assistant' as const, turnId, parts: parts as never });
const text = (value: string, phase?: string) => ({ type: 'text', text: value, ...(phase ? { phase } : {}) });
const tool = { type: 'tool', tool: { id: 't', name: 'read' } };

describe('the answer a turn ends with', () => {
  it('is the text after the last tool, without the commentary that led to it', () => {
    const messages = [assistant('turn', [text("I'll look up the schema first."), tool, text('Checking one more file.')]), assistant('turn', [tool, text('done')])];
    expect(finalAnswerText(messages, 'turn')).toBe('done');
  });

  it('is the text marked as the final answer when the harness marks one', () => {
    expect(finalAnswerText([assistant('turn', [text('Looking around.', 'commentary'), text('The answer.', 'final_answer'), tool])], 'turn')).toBe('The answer.');
  });

  it('is every text part when the turn used no tools', () => {
    expect(finalAnswerText([assistant('turn', [text('First.'), text('Second.')])], 'turn')).toBe('First.\nSecond.');
  });

  it('keeps the answer when thinking or status follows it', () => {
    expect(finalAnswerText([assistant('turn', [tool, text('answer'), { type: 'reasoning', text: 'thought' }, { type: 'status' }])], 'turn')).toBe('answer');
  });

  it('is the last text written when the turn stopped on a tool', () => {
    expect(finalAnswerText([assistant('turn', [text('Reading it.', 'commentary'), tool, text('Now the next file.', 'commentary'), tool])], 'turn')).toBe('Now the next file.');
  });

  it('ignores other turns and the person’s own messages', () => {
    const messages = [{ role: 'user' as const, turnId: 'turn', parts: [text('question')] as never }, assistant('other', [text('elsewhere')]), assistant('turn', [text('answer')])];
    expect(finalAnswerText(messages, 'turn')).toBe('answer');
  });
});
