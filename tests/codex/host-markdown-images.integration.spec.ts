import { describe, expect, it, vi } from 'vitest';
import type { CodexEvent } from '../../src/internal';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk';
import { CodexHost } from '../../src/providers/codex';
import {
  deferred,
  MockCodexAppServer,
  generatedPngBase64,
  requestsFor,
  resumeResponse,
  thread,
  turn,
} from './helpers/host-fixture';

function historicalTurn(id: string, index: number, firstReply: string): v2.Turn {
  return turn(id, 'completed', [
    {
      type: 'userMessage',
      id: `${id}-user-1`,
      clientId: null,
      content: [{ type: 'text', text: `Older ${index} request`, text_elements: [] }],
    },
    { type: 'agentMessage', id: `${id}-agent-1`, text: firstReply, phase: null, memoryCitation: null, delivery: null, questions: null },
    {
      type: 'userMessage',
      id: `${id}-user-2`,
      clientId: null,
      content: [{ type: 'text', text: `Older ${index} follow-up`, text_elements: [] }],
    },
    { type: 'agentMessage', id: `${id}-agent-2`, text: `Older ${index} second reply`, phase: null, memoryCitation: null, delivery: null, questions: null },
    {
      type: 'userMessage',
      id: `${id}-user-3`,
      clientId: null,
      content: [{ type: 'text', text: `Older ${index} last request`, text_elements: [] }],
    },
    { type: 'agentMessage', id: `${id}-agent-3`, text: `Older ${index} last reply`, phase: null, memoryCitation: null, delivery: null, questions: null },
  ]);
}

async function flushAsyncCallbacks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe('CodexHost local Markdown images', () => {
  it('hydrates completed historical assistant images and publishes their renderer-safe update', async () => {
    const markdown = '![Current Music album play bar](/tmp/music-album-playbar.png)';
    const transport = new MockCodexAppServer({
      'thread/resume': (params) => ({
        ...resumeResponse(thread(String((params as { threadId: string }).threadId), false)),
        initialTurnsPage: {
          data: [turn('turn-image', 'completed', [
            {
              type: 'userMessage',
              id: 'user-image-reference',
              clientId: null,
              content: [{ type: 'text', text: '![do not resolve](/tmp/user-image.png)', text_elements: [] }],
            },
            { type: 'agentMessage', id: 'agent-image', text: markdown, phase: null, memoryCitation: null, delivery: null, questions: null },
          ])],
          nextCursor: null,
          backwardsCursor: null,
        },
      }),
      'fs/readFile': (params) => {
        expect(params).toStrictEqual({ path: '/tmp/music-album-playbar.png' });
        return { dataBase64: generatedPngBase64 };
      },
    });
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      cwd: '/tmp/project',
    });
    const events: CodexEvent[] = [];
    host.onEvent((event) => events.push(event));

    await host.connect();
    await host.selectConversation('thread-existing');

    const dataUrl = `data:image/png;base64,${generatedPngBase64}`;
    await vi.waitFor(() => expect(host.getSnapshot().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: `![Current Music album play bar](${dataUrl})` }),
        ]),
      }),
    ])));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message.updated',
        origin: 'lifecycle',
        conversationId: 'thread-existing',
        turnId: 'turn-image',
        payload: expect.objectContaining({
          message: expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({ type: 'text', text: `![Current Music album play bar](${dataUrl})` }),
            ]),
          }),
        }),
      }),
    ]));
    expect(host.getSnapshot().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'user',
        parts: [expect.objectContaining({ type: 'text', text: '![do not resolve](/tmp/user-image.png)' })],
      }),
    ]));
    expect(requestsFor(transport, 'fs/readFile').map((request) => (
      'params' in request ? request.params : undefined
    ))).toStrictEqual([
      { path: '/tmp/music-album-playbar.png' },
      { path: '/tmp/music-album-playbar.png' },
    ]);

    await host.close();
  });

  it('hydrates every simultaneously discovered assistant image independently', async () => {
    const transport = new MockCodexAppServer({
      'thread/resume': () => ({
        ...resumeResponse(thread('thread-existing', false)),
        initialTurnsPage: {
          data: [
            turn('turn-image-a', 'completed', [
              { type: 'agentMessage', id: 'agent-a', text: '![a](/tmp/a.png)', phase: null, memoryCitation: null, delivery: null, questions: null },
            ]),
            turn('turn-image-b', 'completed', [
              { type: 'agentMessage', id: 'agent-b', text: '![b](/tmp/b.png)', phase: null, memoryCitation: null, delivery: null, questions: null },
            ]),
          ],
          nextCursor: null,
          backwardsCursor: null,
        },
      }),
      'fs/readFile': () => ({ dataBase64: generatedPngBase64 }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });

    await host.connect();
    const dataUrl = `data:image/png;base64,${generatedPngBase64}`;
    await vi.waitFor(() => expect(host.getSnapshot().messages.flatMap((message) => message.parts))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: `![a](${dataUrl})` }),
        expect.objectContaining({ type: 'text', text: `![b](${dataUrl})` }),
      ])));
    expect(requestsFor(transport, 'fs/readFile')
      .map((request) => ('params' in request ? (request.params as { path: string }).path : undefined))
      .sort()).toStrictEqual(['/tmp/a.png', '/tmp/b.png']);
    await host.close();
  });

  it('deduplicates pending hydration and does not overwrite a replacement after the conversation is forgotten', async () => {
    const read = deferred<{ dataBase64: string }>();
    const transport = new MockCodexAppServer({
      'fs/readFile': () => read.promise,
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-stale-image', 'inProgress', []) });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing', turnId: 'turn-stale-image', itemId: 'agent-stale-image',
        delta: '![stale](/tmp/stale.png)',
      });
    const completed = {
      method: 'turn/completed',
      params: { threadId: 'thread-existing', turn: turn('turn-stale-image', 'completed', []) },
    } as const;
    transport.emitNotification(completed.method, completed.params);
    transport.emitNotification(completed.method, completed.params);
    await vi.waitFor(() => expect(requestsFor(transport, 'fs/readFile')).toHaveLength(1));

    host.forgetConversation('thread-existing');
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-stale-image', 'inProgress', []) });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing', turnId: 'turn-stale-image', itemId: 'agent-stale-image',
        delta: 'Replacement response',
      });
    expect(host.getConversationSnapshot('thread-existing').messages).toEqual([
      expect.objectContaining({
        id: 'assistant-turn-stale-image',
        parts: [expect.objectContaining({ type: 'text', text: 'Replacement response' })],
      }),
    ]);
    read.resolve({ dataBase64: generatedPngBase64 });
    await flushAsyncCallbacks();

    expect(host.getConversationSnapshot('thread-existing').messages).toEqual([
      expect.objectContaining({
        id: 'assistant-turn-stale-image',
        parts: [expect.objectContaining({ type: 'text', text: 'Replacement response' })],
      }),
    ]);
    await host.close();
  });

  it('settles a pending hydration safely when its conversation remains forgotten', async () => {
    const read = deferred<{ dataBase64: string }>();
    const transport = new MockCodexAppServer({ 'fs/readFile': () => read.promise });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-forgotten-image', 'inProgress', []) });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing', turnId: 'turn-forgotten-image', itemId: 'agent-forgotten-image',
        delta: '![forgotten](/tmp/forgotten.png)',
      });
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-forgotten-image', 'completed', []) });
    await vi.waitFor(() => expect(requestsFor(transport, 'fs/readFile')).toHaveLength(1));

    host.forgetConversation('thread-existing');
    read.resolve({ dataBase64: generatedPngBase64 });
    await flushAsyncCallbacks();

    expect(host.getConversationSnapshot('thread-existing').messages).toStrictEqual([]);
    await host.close();
  });

  it('does not resurrect a pending image when a replacement conversation lacks its message', async () => {
    const read = deferred<{ dataBase64: string }>();
    const transport = new MockCodexAppServer({ 'fs/readFile': () => read.promise });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-old-image', 'inProgress', []) });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing', turnId: 'turn-old-image', itemId: 'agent-old-image',
        delta: '![old](/tmp/old.png)',
      });
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-old-image', 'completed', []) });
    await vi.waitFor(() => expect(requestsFor(transport, 'fs/readFile')).toHaveLength(1));

    host.forgetConversation('thread-existing');
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-replacement', 'inProgress', []) });
    read.resolve({ dataBase64: generatedPngBase64 });
    await flushAsyncCallbacks();

    expect(host.getConversationSnapshot('thread-existing').messages).toEqual([
      expect.objectContaining({ id: 'assistant-turn-replacement', parts: [] }),
    ]);
    await host.close();
  });

  it('discards an already-resolved hydration callback when close wins the microtask race', async () => {
    const transport = new MockCodexAppServer({
      'fs/readFile': () => new Promise(() => undefined),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-closing-image', 'inProgress', []) });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing', turnId: 'turn-closing-image', itemId: 'agent-closing-image',
        delta: '![closing](/tmp/closing.png)',
      });
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-closing-image', 'completed', []) });
    await vi.waitFor(() => expect(requestsFor(transport, 'fs/readFile')).toHaveLength(1));
    const request = transport.lastRequest('fs/readFile');
    if (!request) throw new Error('Expected fs/readFile to be requested');
    transport.emitResult(request, { dataBase64: generatedPngBase64 });
    await host.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.getSnapshot().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        turnId: 'turn-closing-image',
        parts: [expect.objectContaining({ type: 'text', text: '![closing](/tmp/closing.png)' })],
      }),
    ]));
  });

  it('hydrates a local Markdown image when a live assistant turn completes', async () => {
    const transport = new MockCodexAppServer({
      'fs/readFile': () => ({ dataBase64: generatedPngBase64 }),
    });
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      cwd: '/tmp/project',
    });
    await host.connect();
    await host.selectConversation('thread-existing');

    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-live-image', 'inProgress', []) });
    transport.emitNotification('item/started', {
        threadId: 'thread-existing', turnId: 'turn-live-image', startedAtMs: 1,
        item: { pluginId: null, scriptPath: null,
          type: 'commandExecution', id: 'tool-before-image', command: 'pwd', cwd: '/tmp/project',
          source: 'unifiedExecInteraction', status: 'inProgress', commandActions: [],
          processId: null, aggregatedOutput: null, exitCode: null, durationMs: null,
        },
      });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing',
        turnId: 'turn-live-image',
        itemId: 'agent-live-image',
        delta: '![preview](/tmp/live-preview.png)',
      });
    expect(transport.sent.filter((message) => 'method' in message && message.method === 'fs/readFile')).toHaveLength(0);
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-live-image', 'completed', []) });

    const dataUrl = `data:image/png;base64,${generatedPngBase64}`;
    await vi.waitFor(() => expect(host.getSnapshot().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        turnId: 'turn-live-image',
        status: 'complete',
        parts: expect.arrayContaining([
          expect.objectContaining({ type: 'tool', id: 'tool-before-image' }),
          expect.objectContaining({ type: 'text', text: `![preview](${dataUrl})` }),
        ]),
      }),
    ])));
    expect(transport.sent.filter((message) => 'method' in message && message.method === 'fs/readFile')).toHaveLength(1);

    await host.close();
  });

  it('keeps an unreadable local image unchanged without publishing a fake update', async () => {
    const transport = new MockCodexAppServer({
      'fs/readFile': () => { throw new Error('unreadable'); },
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const events: CodexEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-unreadable-image', 'inProgress', []) });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing', turnId: 'turn-unreadable-image', itemId: 'agent-unreadable-image',
        delta: '![local](/tmp/unreadable.png)',
      });
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-unreadable-image', 'completed', []) });
    await vi.waitFor(() => expect(requestsFor(transport, 'fs/readFile')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.getSnapshot().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        turnId: 'turn-unreadable-image',
        parts: [expect.objectContaining({ type: 'text', text: '![local](/tmp/unreadable.png)' })],
      }),
    ]));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'message.updated',
      turnId: 'turn-unreadable-image',
    }));
    await host.close();
  });

  it('introduces an older hydrated image in history before publishing its message update', async () => {
    const markdown = '![Current Music album play bar](/tmp/music-album-playbar.png)';
    const dataUrl = `data:image/png;base64,${generatedPngBase64}`;
    const initialTurn = turn('turn-initial', 'completed', [
      {
        type: 'userMessage',
        id: 'user-initial',
        clientId: null,
        content: [{ type: 'text', text: 'Initial', text_elements: [] }],
      },
      { type: 'agentMessage', id: 'agent-initial', text: 'Initial reply', phase: null, memoryCitation: null, delivery: null, questions: null },
    ]);
    const olderTurns = Array.from({ length: 5 }, (_, index) => historicalTurn(
      `turn-older-${index}`,
      index,
      index === 0 ? markdown : `Older ${index} first reply`,
    ));
    const transport = new MockCodexAppServer({
      'thread/resume': () => ({
        ...resumeResponse(thread('thread-existing', false)),
        initialTurnsPage: { data: [initialTurn], nextCursor: 'older-page', backwardsCursor: null },
      }),
      'thread/turns/list': (params) => {
        expect(params).toMatchObject({ threadId: 'thread-existing', cursor: 'older-page', limit: 25 });
        return { data: [...olderTurns].reverse(), nextCursor: null, backwardsCursor: null };
      },
      'fs/readFile': (params) => {
        expect(params).toStrictEqual({ path: '/tmp/music-album-playbar.png' });
        return { dataBase64: generatedPngBase64 };
      },
    });
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      cwd: '/tmp/project',
    });
    const eventOrder: string[] = [];
    host.onEvent((event) => {
      if (event.type === 'conversation.historyPrepended') {
        const text = event.payload.messages.flatMap((message) => message.parts)
          .filter((part) => part.type === 'text')
          .map((part) => part.text);
        if (text.includes(`![Current Music album play bar](${dataUrl})`)) {
          eventOrder.push('history:image:hydrated');
        } else if (text.includes(markdown)) {
          eventOrder.push('history:image:local');
        } else {
          eventOrder.push('history:other');
        }
      }
      if (event.type === 'message.updated' && event.turnId === 'turn-older-0') {
        eventOrder.push('update:image');
      }
    });

    await host.connect();
    await host.conversation('thread-existing').loadOlderHistory();
    await vi.waitFor(() => expect(eventOrder).toHaveLength(3));

    expect(eventOrder).toEqual([
      'history:other',
      'history:image:hydrated',
      'update:image',
    ]);

    await host.close();
  });

  it('does not publish an image update after close while history emission is pending', async () => {
    const history = deferred<v2.ThreadTurnsListResponse>();
    const transport = new MockCodexAppServer({
      'thread/resume': () => ({
        ...resumeResponse(thread('thread-existing', false)),
        initialTurnsPage: { data: [], nextCursor: 'older-page', backwardsCursor: null },
      }),
      'thread/turns/list': () => history.promise,
      'fs/readFile': () => ({ dataBase64: generatedPngBase64 }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const events: CodexEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    await host.selectConversation('thread-existing');
    const load = host.conversation('thread-existing').loadOlderHistory();
    const settledLoad = load.catch((error: unknown) => error);
    await vi.waitFor(() => expect(requestsFor(transport, 'thread/turns/list')).toHaveLength(1));

    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-close-wait-image', 'inProgress', []) });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing', turnId: 'turn-close-wait-image', itemId: 'agent-close-wait-image',
        delta: '![closing](/tmp/closing-while-history-loads.png)',
      });
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-close-wait-image', 'completed', []) });
    const dataUrl = `data:image/png;base64,${generatedPngBase64}`;
    await vi.waitFor(() => expect(JSON.stringify(host.getSnapshot().messages)).toContain(dataUrl));

    await host.close();
    history.resolve({ data: [], nextCursor: null, backwardsCursor: null });
    await expect(settledLoad).resolves.toEqual(expect.any(Error));
    await flushAsyncCallbacks();

    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'message.updated', turnId: 'turn-close-wait-image',
    }));
  });

  it('does not publish an image update for a replacement message while history emission is pending', async () => {
    const history = deferred<v2.ThreadTurnsListResponse>();
    const transport = new MockCodexAppServer({
      'thread/resume': () => ({
        ...resumeResponse(thread('thread-existing', false)),
        initialTurnsPage: { data: [], nextCursor: 'older-page', backwardsCursor: null },
      }),
      'thread/turns/list': () => history.promise,
      'fs/readFile': () => ({ dataBase64: generatedPngBase64 }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const events: CodexEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    await host.selectConversation('thread-existing');
    const load = host.conversation('thread-existing').loadOlderHistory();
    await vi.waitFor(() => expect(requestsFor(transport, 'thread/turns/list')).toHaveLength(1));

    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-replaced-image', 'inProgress', []) });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing', turnId: 'turn-replaced-image', itemId: 'agent-replaced-image',
        delta: '![replace me](/tmp/replace-me.png)',
      });
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-replaced-image', 'completed', []) });
    const dataUrl = `data:image/png;base64,${generatedPngBase64}`;
    await vi.waitFor(() => expect(JSON.stringify(host.getSnapshot().messages)).toContain(dataUrl));

    host.forgetConversation('thread-existing');
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-replaced-image', 'inProgress', []) });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing', turnId: 'turn-replaced-image', itemId: 'agent-replaced-image',
        delta: 'Replacement response',
      });
    history.resolve({ data: [], nextCursor: null, backwardsCursor: null });
    await load;
    await flushAsyncCallbacks();

    expect(host.getConversationSnapshot('thread-existing').messages).toEqual([
      expect.objectContaining({
        id: 'assistant-turn-replaced-image',
        parts: [expect.objectContaining({ type: 'text', text: 'Replacement response' })],
      }),
    ]);
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'message.updated', turnId: 'turn-replaced-image',
    }));
    await host.close();
  });

  it('does not publish an image update after its conversation disappears during history emission', async () => {
    const history = deferred<v2.ThreadTurnsListResponse>();
    const transport = new MockCodexAppServer({
      'thread/resume': () => ({
        ...resumeResponse(thread('thread-existing', false)),
        initialTurnsPage: { data: [], nextCursor: 'older-page', backwardsCursor: null },
      }),
      'thread/turns/list': () => history.promise,
      'fs/readFile': () => ({ dataBase64: generatedPngBase64 }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const events: CodexEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    await host.selectConversation('thread-existing');
    const load = host.conversation('thread-existing').loadOlderHistory();
    await vi.waitFor(() => expect(requestsFor(transport, 'thread/turns/list')).toHaveLength(1));

    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-disappearing-image', 'inProgress', []) });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing', turnId: 'turn-disappearing-image', itemId: 'agent-disappearing-image',
        delta: '![disappearing](/tmp/disappearing.png)',
      });
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-disappearing-image', 'completed', []) });
    const dataUrl = `data:image/png;base64,${generatedPngBase64}`;
    await vi.waitFor(() => expect(JSON.stringify(host.getSnapshot().messages)).toContain(dataUrl));

    host.forgetConversation('thread-existing');
    history.resolve({ data: [], nextCursor: null, backwardsCursor: null });
    await expect(load).resolves.toMatchObject({
      conversationId: 'thread-existing', messages: [], hasOlder: false,
    });
    await flushAsyncCallbacks();

    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'message.updated', turnId: 'turn-disappearing-image',
    }));
    expect(host.getConversationSnapshot('thread-existing').messages).toStrictEqual([]);
    await host.close();
  });

  it('does not publish a stale hydrated history update after its message is replaced', async () => {
    const markdown = '![stale history](/tmp/stale-history.png)';
    const dataUrl = `data:image/png;base64,${generatedPngBase64}`;
    const olderTurns = Array.from({ length: 5 }, (_, index) => historicalTurn(
      `turn-racing-${index}`,
      index,
      index === 0 ? markdown : `Older ${index} first reply`,
    ));
    const transport = new MockCodexAppServer({
      'thread/resume': () => ({
        ...resumeResponse(thread('thread-existing', false)),
        initialTurnsPage: { data: [], nextCursor: 'older-page', backwardsCursor: null },
      }),
      'thread/turns/list': () => ({
        data: [...olderTurns].reverse(), nextCursor: null, backwardsCursor: null,
      }),
      'fs/readFile': () => ({ dataBase64: generatedPngBase64 }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const events: CodexEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    vi.useFakeTimers();
    try {
      const load = host.conversation('thread-existing').loadOlderHistory();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
      expect(JSON.stringify(host.getSnapshot().messages)).toContain(dataUrl);
      expect(events).not.toContainEqual(expect.objectContaining({
        type: 'message.updated', turnId: 'turn-racing-0',
      }));

      host.forgetConversation('thread-existing');
      transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-racing-0', 'inProgress', []) });
      transport.emitNotification('item/started', {
          threadId: 'thread-existing', turnId: 'turn-racing-0', startedAtMs: 2,
          item: { pluginId: null, scriptPath: null,
            type: 'commandExecution', id: 'replacement-history-tool', command: 'pwd', cwd: '/tmp/project',
            source: 'unifiedExecInteraction', status: 'inProgress', commandActions: [],
            processId: null, aggregatedOutput: null, exitCode: null, durationMs: null,
          },
        });
      await vi.runAllTimersAsync();
      await load;
      await Promise.resolve();

      expect(events).not.toContainEqual(expect.objectContaining({
        type: 'message.updated', turnId: 'turn-racing-0',
      }));
      expect(host.getConversationSnapshot('thread-existing').messages).toEqual([
        expect.objectContaining({
          id: 'assistant-turn-racing-0',
          parts: [expect.objectContaining({ type: 'tool', id: 'replacement-history-tool' })],
        }),
      ]);
    } finally {
      vi.useRealTimers();
      await host.close();
    }
  });
});
