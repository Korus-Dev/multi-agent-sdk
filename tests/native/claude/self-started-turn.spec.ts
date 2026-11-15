import { describe, expect, it, vi } from 'vitest';
import { ClaudeAgentSdkTransport } from '../../../src/providers/claude/agent-sdk-transport';
import { ClaudeHost } from '../../../src/providers/claude/host';
import { harnessForHost } from '../../../src/internal';
import type { ClaudeSdkMessage } from '../../../src/providers/claude/protocol';
import type { ClaudeTurnHandle, ClaudeTurnTransport } from '../../../src/providers/claude/transport';
import { createQueryHarness } from './sdk-query-fixture';

// A background job the agent started can finish after its turn did. Claude then wakes the agent with the job's
// notification and it answers on its own, without a prompt from the app. That answer is a turn of the conversation:
// it starts, shows what the agent says as it says it, and ends.
const sessionId = 'session';
const result = { type: 'result', subtype: 'success', session_id: sessionId, is_error: false } as ClaudeSdkMessage;
const notification = { type: 'system', subtype: 'task_notification', session_id: sessionId, task_id: 'bg-1', status: 'completed', summary: 'Job done' } as unknown as ClaudeSdkMessage;
const says = (text: string, id = 'wake-1') => ({ type: 'assistant', session_id: sessionId, message: { id, content: [{ type: 'text', text }] } }) as unknown as ClaudeSdkMessage;

describe('Claude turn the agent starts on its own, in the transport', () => {
  const setup = async () => {
    const harness = createQueryHarness();
    const transport = new ClaudeAgentSdkTransport({ createQuery: harness.createQuery });
    const first: ClaudeSdkMessage[] = [];
    const turn = transport.startTurn({ cwd: '/tmp/project', sessionId, prompt: 'start the job' }, message => first.push(message));
    await vi.waitFor(() => expect(harness.inputs).toHaveLength(1));
    const taken: Array<{ sessionId: string; handle: ClaudeTurnHandle; messages: ClaudeSdkMessage[] }> = [];
    transport.onSelfStartedTurn((id, handle) => { const record = { sessionId: id, handle, messages: [] as ClaudeSdkMessage[] }; taken.push(record); return { onMessage: message => record.messages.push(message) }; });
    return { harness, transport, turn, taken };
  };

  it('hands the turn to whoever listens, with what the agent says, and ends it at the result', async () => {
    const { harness, transport, turn, taken } = await setup();
    harness.emit(result, 0); await turn.done;
    harness.emit(notification, 0); harness.emit(says('The job finished.'), 0);
    await vi.waitFor(() => expect(taken).toHaveLength(1));
    expect(taken[0]!.sessionId).toBe(sessionId);
    expect(taken[0]!.messages.map(message => message.type)).toStrictEqual(['assistant']);
    harness.emit(result, 0); await taken[0]!.handle.done;
    harness.emit(says('Again.', 'wake-2'), 0);
    await vi.waitFor(() => expect(taken).toHaveLength(2));
    await transport.close();
  });

  it('starts no turn from what a subagent says', async () => {
    const { harness, transport, turn, taken } = await setup();
    harness.emit(result, 0); await turn.done;
    harness.emit({ ...says('From a subagent'), parent_tool_use_id: 'tool-1' } as ClaudeSdkMessage, 0);
    harness.emit(notification, 0);
    harness.emit(says('Settled.', 'wake-9'), 0);
    await vi.waitFor(() => expect(taken).toHaveLength(1));
    expect(taken[0]!.messages.map(message => (message as { message?: { id?: string } }).message?.id)).toStrictEqual(['wake-9']);
    await transport.close();
  });

  it('starts no turn from what an interrupted turn still says before its result', async () => {
    const { harness, transport, turn, taken } = await setup();
    await turn.interrupt();
    harness.emit(says('Still going'), 0);
    harness.emit({ ...result, is_error: true, subtype: 'error_during_execution' } as ClaudeSdkMessage, 0);
    harness.emit(says('Woken', 'wake-2'), 0);
    await vi.waitFor(() => expect(taken).toHaveLength(1));
    expect(taken[0]!.messages.map(message => (message as { message?: { id?: string } }).message?.id)).toStrictEqual(['wake-2']);
    await transport.close();
  });

  it('drops what the agent says when nobody takes the turn', async () => {
    const { harness, transport, turn } = await setup();
    harness.emit(result, 0); await turn.done;
    transport.onSelfStartedTurn(() => null);
    harness.emit(says('Nobody listens'), 0);
    harness.emit(result, 0);
    const next = transport.startTurn({ cwd: '/tmp/project', sessionId, prompt: 'next' }, () => undefined);
    harness.emit(result, 0); await next.done;
    await transport.close();
  });
});

describe('Claude turn the agent starts on its own, in a conversation', () => {
  const open = async () => {
    let listener!: (message: ClaudeSdkMessage) => void;
    let finish!: () => void;
    let selfStarted: Parameters<NonNullable<ClaudeTurnTransport['onSelfStartedTurn']>>[0] | undefined;
    const handle = (): ClaudeTurnHandle => ({ done: new Promise<void>(resolve => { finish = resolve; }), interrupt: async () => {} });
    const transport: ClaudeTurnTransport = { startTurn: (_params, onMessage) => { listener = onMessage; return handle(); }, close: async () => {}, onSelfStartedTurn: fn => { selfStarted = fn; } };
    const host = new ClaudeHost(transport,
      async () => ({ providerSession: { kind: 'claude', conversationId: sessionId, transport: 'stdio' }, messages: [] }));
    const harness = harnessForHost('claude', host);
    const session = harness.restoreSession({ id: 'agent', folder: '/synthetic' }, { provider: 'claude', data: { kind: 'claude', conversationId: sessionId, transport: 'stdio' }, role: 'main' });
    await harness.sendPrompt(session, 'start the job');
    listener({ type: 'system', subtype: 'init', session_id: sessionId } as ClaudeSdkMessage);
    listener(says('Started.', 'm-1')); listener(result); finish();
    await vi.waitFor(() => expect(harness.readSession(session).busy).toBeFalsy());
    const texts = () => harness.readSession(session).messages.filter(message => message.role === 'assistant').flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []));
    return { harness, session, texts, startOnItsOwn: () => { let next!: (message: ClaudeSdkMessage) => void; let end!: () => void; const taken = selfStarted!(sessionId, { done: new Promise<void>(resolve => { end = resolve; }), interrupt: async () => {} }); next = taken!.onMessage; return { say: next, end }; } };
  };

  it('shows what the agent says as a turn of its own, and ends it at the result', async () => {
    const { harness, session, texts, startOnItsOwn } = await open();
    try {
      const turns = () => harness.readSession(session).turns?.length ?? 0;
      const before = turns();
      const wake = startOnItsOwn();
      wake.say(says('The job finished.', 'wake-1'));
      expect(texts()).toStrictEqual(['Started.', 'The job finished.']);
      expect(harness.readSession(session).busy).toBe(true);
      expect(turns()).toBe(before + 1);
      wake.say(result); wake.end();
      await vi.waitFor(() => expect(harness.readSession(session).busy).toBeFalsy());
    } finally { await harness.close(); }
  });
});
