type Part = { type: string; text?: string; phase?: string };
type TurnMessage = { role: string; turnId?: string; parts: readonly Part[] };

const texts = (parts: readonly Part[]) => parts.flatMap(part => part.type === 'text' && typeof part.text === 'string' && part.text.trim() ? [part.text] : []);

/**
 * The answer a turn ends with, as one text: the parts marked as the final answer, or else the text after the turn's
 * last tool call or question, so the commentary written along the way is left out. A turn that stopped on a tool
 * answers with the last text it wrote.
 */
export function finalAnswerText(messages: readonly TurnMessage[], turnId: string): string {
  const parts = messages.filter(message => message.role === 'assistant' && message.turnId === turnId).flatMap(message => message.parts);
  const marked = texts(parts.filter(part => part.phase === 'final_answer'));
  if (marked.length) return marked.join('\n').trim();
  let lastAction = -1;
  parts.forEach((part, index) => { if (part.type === 'tool' || part.type === 'question') lastAction = index; });
  const after = texts(parts.slice(lastAction + 1));
  return (after.length ? after.join('\n') : texts(parts).at(-1) ?? '').trim();
}
