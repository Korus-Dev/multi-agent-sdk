import { describe, expect, it, onTestFinished } from 'vitest';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk';
import { CodexHost } from '../../src/providers/codex';
import { MockCodexAppServer, lastRequest, thread, turn } from './helpers/host-fixture';

// An app can offer a plugin of its own in the composer. Its mention is a prompt like any other, but Codex knows
// nothing of the plugin, so the mention is not sent to Codex as one of its plugins: the prompt text still carries it.
const content = [
  { type: 'text' as const, text: 'Use ' },
  { type: 'mention' as const, kind: 'plugin' as const, id: 'korus-computer-use', value: 'computer-use', label: 'Computer Use' },
  { type: 'text' as const, text: ' and ' },
  { type: 'mention' as const, kind: 'plugin' as const, id: 'gmail@remote', value: 'gmail', label: 'Gmail' },
];
const dispatched = 'Use [@computer-use](plugin://korus-computer-use) and [@gmail](plugin://gmail@remote)';
const open = async (isAppPlugin?: (id: string) => boolean) => {
  const transport = new MockCodexAppServer({
    'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
    'turn/steer': () => ({ turnId: 'turn-live' }),
  });
  const host = new CodexHost({ client: new CodexAppServerClient(transport), ...(isAppPlugin ? { isAppPlugin } : {}) });
  onTestFinished(() => host.close());
  await host.connect();
  return { host, transport };
};
const mentions = (transport: MockCodexAppServer, method: 'turn/start' | 'turn/steer') =>
  (lastRequest(transport, method) as unknown as { params: { input: { type: string; name?: string; path?: string }[] } }).params.input.filter(input => input.type === 'mention');

describe('a plugin the app provides itself', () => {
  it('is left out of the plugins sent to Codex, while a Codex plugin next to it is sent', async () => {
    const { host, transport } = await open(id => id === 'korus-computer-use');
    await host.sendMessage(dispatched, { content });
    expect(mentions(transport, 'turn/start')).toStrictEqual([{ type: 'mention', name: 'Gmail', path: 'plugin://gmail@remote' }]);
  });

  it('is left out of a steering message as well', async () => {
    const { host, transport } = await open(id => id === 'korus-computer-use');
    await host.sendMessage('Work', { content: [{ type: 'text', text: 'Work' }] });
    await host.steerMessage(dispatched, { content });
    expect(mentions(transport, 'turn/steer')).toStrictEqual([{ type: 'mention', name: 'Gmail', path: 'plugin://gmail@remote' }]);
  });

  it('still reaches the model in the prompt text, and keeps its chip in the stored message', async () => {
    const { host, transport } = await open(id => id === 'korus-computer-use');
    await host.sendMessage(dispatched, { content });
    expect(lastRequest(transport, 'turn/start')).toMatchObject({ params: { input: [{ type: 'text', text: dispatched }, { type: 'mention', path: 'plugin://gmail@remote' }] } });
    expect(host.getSnapshot().messages.filter(message => message.role === 'user').at(-1)).toMatchObject({ metadata: { promptContent: content } });
  });

  it('is sent like any plugin when the app names none', async () => {
    const { host, transport } = await open();
    await host.sendMessage(dispatched, { content });
    expect(mentions(transport, 'turn/start').map(input => input.path)).toStrictEqual(['plugin://korus-computer-use', 'plugin://gmail@remote']);
  });
  it('keeps its chip when the conversation is read again from Codex', async () => {
    let sent: v2.TurnStartParams | undefined;
    const transport = new MockCodexAppServer({
      'turn/start': params => { sent = params; return { turn: turn('authored-turn', 'inProgress', []) }; },
      'thread/read': () => ({ readState: null, thread: thread('thread-existing', false) }),
      'thread/turns/list': () => ({ data: sent ? [turn('authored-turn', 'completed', [{
        type: 'userMessage', id: 'provider-user', clientId: sent.clientUserMessageId ?? null, content: sent.input,
      }])] : [], nextCursor: null, backwardsCursor: null }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport), isAppPlugin: id => id === 'korus-computer-use' });
    onTestFinished(() => host.close());
    await host.connect();
    await host.sendMessage(dispatched, { content });
    const id = sent!.clientUserMessageId;
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('authored-turn', 'completed', []) });
    await host.readConversationHistory('thread-existing');
    expect(host.getSnapshot().messages.find(message => message.id === id)).toMatchObject({
      parts: [{ type: 'text', text: 'Use Computer Use and Gmail' }], metadata: { promptContent: content },
    });
  });
});
