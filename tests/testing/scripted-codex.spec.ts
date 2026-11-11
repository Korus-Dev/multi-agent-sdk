import { expect, it } from 'vitest';
import { createScriptedCodexHarness, scriptedCodexSnapshot } from '../../src/testing';

it('derives session state from scripted engine events through the SDK adapter', async () => {
  const { harness, conversation } = createScriptedCodexHarness();
  const session = harness.restoreSession({ id: 'agent', folder: '/repo' }, { provider: 'codex', data: { kind: 'codex', threadId: 'thread-1' }, role: 'main' });
  const seen: string[] = [];
  harness.onEvent(event => { if (event.type === 'provider.event') seen.push(event.event.type); });
  await harness.loadConversation(session);
  const thread = conversation('thread-1');
  thread.setSnapshot({ busy: false });
  expect(thread.listenerCount()).toBeGreaterThan(0);
  thread.emit({ conversationId: 'thread-1', seq: 1, occurredAt: '2026-01-01T00:00:00.000Z', origin: 'notification', type: 'turn.started', payload: { turn: { id: 't', status: 'inProgress', items: [], error: null } } } as never);
  expect(seen).toContain('codex.conversationEventReceived');
  expect(scriptedCodexSnapshot('x').activeConversationId).toBe('x');
});
