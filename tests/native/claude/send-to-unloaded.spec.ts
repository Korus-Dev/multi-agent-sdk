import { describe, expect, it, vi } from 'vitest';
import type { ClaudeSdkMessage } from '../../../src/providers/claude/protocol';
import { harnessForHost } from '../../../src/internal';
import { ClaudeHost } from '../../../src/providers/claude/host';
import { claudeTranscriptToMessages } from '../../../src/providers/claude/transcript-history-adapter';

const session = { kind: 'claude' as const, conversationId: 'stored-session', transport: 'stdio' as const };
const stored = Array.from({ length: 3 }, (_, i) => [
  { type: 'user', uuid: `user-${i}`, message: { content: `Earlier question ${i}` } },
  { type: 'assistant', uuid: `assistant-${i}`, message: { content: `Earlier answer ${i}` } },
]).flat().map(row => JSON.stringify(row)).join('\n');

// Another agent sends a message to a Claude conversation the app has not opened: restored, never loaded.
describe('Claude conversation that was sent a prompt before it was loaded', () => {
  const open = () => {
    let emit!: (message: ClaudeSdkMessage) => void;
    const history = vi.fn(async () => ({ providerSession: session, messages: claudeTranscriptToMessages(stored, 'agent', session.conversationId) }));
    const host = new ClaudeHost({ startTurn: (_params, listener) => { emit = listener; return { done: new Promise(() => {}), interrupt: async () => {} }; }, close: async () => {} }, history);
    const harness = harnessForHost('claude', host);
    const restored = harness.restoreSession({ id: 'agent', folder: '/synthetic' }, { provider: 'claude', data: session, role: 'main' });
    const texts = () => harness.readSession(restored).messages.flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []));
    return { harness, restored, texts, history, reply: () => {
      emit({ type: 'system', subtype: 'init', session_id: session.conversationId } as ClaudeSdkMessage);
      emit({ type: 'assistant', session_id: session.conversationId, message: { content: 'The reply' } });
      emit({ type: 'result', subtype: 'success', session_id: session.conversationId, is_error: false });
    }, close: () => harness.close() };
  };
  const earlier = ['Earlier question 0', 'Earlier answer 0', 'Earlier question 1', 'Earlier answer 1', 'Earlier question 2', 'Earlier answer 2'];

  it('shows its history with the new message and the reply', async () => {
    const { harness, restored, texts, reply, close } = open();
    try {
      await harness.sendPrompt(restored, 'New message from another agent');
      reply();
      expect(texts()).toStrictEqual([...earlier, 'New message from another agent', 'The reply']);
    } finally { await close(); }
  });

  it('keeps its history when the app opens it afterwards', async () => {
    const { harness, restored, texts, history, reply, close } = open();
    try {
      await harness.sendPrompt(restored, 'New message from another agent');
      reply();
      await harness.loadConversation(restored);
      expect(texts()).toStrictEqual([...earlier, 'New message from another agent', 'The reply']);
      expect(history).toHaveBeenCalledOnce();
    } finally { await close(); }
  });
});
