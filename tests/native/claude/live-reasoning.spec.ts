import { describe, expect, it } from 'vitest';
import type { ClaudeSdkMessage } from '../../../src/providers/claude/protocol';
import { harnessForHost } from '../../../src/internal';
import { ClaudeHost } from '../../../src/providers/claude/host';

// What Claude writes as thinking can be the narration the person reads, so it reaches the conversation as reasoning,
// in order with the text and tool calls around it, whether it streams in or arrives with the finished message.
const session = { kind: 'claude' as const, conversationId: 'live-session', transport: 'stdio' as const };
const open = async () => {
  let emit!: (message: ClaudeSdkMessage) => void;
  const host = new ClaudeHost({ startTurn: (_params, listener) => { emit = listener; return { done: new Promise(() => {}), interrupt: async () => {} }; }, close: async () => {} },
    async () => ({ providerSession: session, messages: [] }));
  const harness = harnessForHost('claude', host);
  const opened = harness.restoreSession({ id: 'agent', folder: '/synthetic' }, { provider: 'claude', data: session, role: 'main' });
  await harness.sendPrompt(opened, 'Go');
  const send = (message: object) => emit({ session_id: session.conversationId, ...message } as ClaudeSdkMessage);
  const stream = (event: object) => send({ type: 'stream_event', event });
  const parts = () => harness.readSession(opened).messages.filter(message => message.role === 'assistant')
    .flatMap(message => message.parts.map(part => part.type === 'reasoning' ? `reasoning:${part.summary}` : part.type === 'text' ? `text:${part.text}` : part.type));
  return { send, stream, parts, close: () => harness.close() };
};
const thinkingDelta = (index: number, thinking: string) => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
const textDelta = (index: number, text: string) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });

describe('Claude thinking in a running turn', () => {
  it('shows thinking that streams in, once, when the finished message repeats it', async () => {
    const { send, stream, parts, close } = await open();
    try {
      send({ type: 'system', subtype: 'init' });
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
      stream(thinkingDelta(0, 'I will ')); stream(thinkingDelta(0, 'look.'));
      stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
      stream(textDelta(1, 'Looking.'));
      send({ type: 'assistant', message: { id: 'm-1', content: [{ type: 'thinking', thinking: 'I will look.', signature: 's' }, { type: 'text', text: 'Looking.' }] } });
      expect(parts()).toStrictEqual(['reasoning:I will look.', 'text:Looking.']);
    } finally { await close(); }
  });

  it('shows thinking that arrives only with the finished message, before the text that follows it', async () => {
    const { send, parts, close } = await open();
    try {
      send({ type: 'system', subtype: 'init' });
      send({ type: 'assistant', message: { id: 'm-1', content: [{ type: 'thinking', thinking: 'Plan first.', signature: 's' }, { type: 'text', text: 'Doing it.' }] } });
      expect(parts()).toStrictEqual(['reasoning:Plan first.', 'text:Doing it.']);
    } finally { await close(); }
  });

  it('shows thinking from each round of a turn as its own part', async () => {
    const { send, parts, close } = await open();
    try {
      send({ type: 'system', subtype: 'init' });
      send({ type: 'assistant', message: { id: 'm-1', content: [{ type: 'thinking', thinking: 'First.', signature: 's' }, { type: 'tool_use', id: 't-1', name: 'Read', input: { file_path: '/a' } }] } });
      send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't-1', content: 'ok' }] } });
      send({ type: 'assistant', message: { id: 'm-2', content: [{ type: 'thinking', thinking: 'Second.', signature: 's' }, { type: 'text', text: 'Done.' }] } });
      expect(parts()).toStrictEqual(['reasoning:First.', 'tool', 'reasoning:Second.', 'text:Done.']);
    } finally { await close(); }
  });

  it('leaves out thinking that carries no text', async () => {
    const { send, parts, close } = await open();
    try {
      send({ type: 'system', subtype: 'init' });
      send({ type: 'assistant', message: { id: 'm-1', content: [{ type: 'thinking', thinking: '', signature: 'hidden' }, { type: 'text', text: 'Answer.' }] } });
      expect(parts()).toStrictEqual(['text:Answer.']);
    } finally { await close(); }
  });
});

