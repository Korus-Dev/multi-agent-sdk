import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { CodexEvent } from '../../src/internal';
import { createCodexConversationReplica } from '../../src/core/index';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk';
import { CodexHost } from '../../src/providers/codex';
import { MockCodexAppServer, createHarness, deferred, lastRequest, resumeResponse, testGoal, thread, turn } from './helpers/host-fixture';

describe('CodexHost', () => {
  it('retains authored mentions and visible text when provider history replays an enriched prompt', async () => {
    let sent: v2.TurnStartParams | undefined;
    const transport = new MockCodexAppServer({
      'turn/start': params => { sent = params; return { turn: turn('authored-turn', 'inProgress', []) }; },
      'thread/read': () => ({ readState: null, thread: thread('thread-existing', false) }),
      'thread/revert': () => ({ thread: thread('thread-existing', false), turnsBackwardsCursor: null, itemsBackwardsCursor: null }),
      'thread/turns/list': () => ({ data: sent ? [turn('authored-turn', 'completed', [{
        type: 'userMessage', id: 'provider-user', clientId: sent.clientUserMessageId ?? null, content: sent.input,
      }])] : [], nextCursor: null, backwardsCursor: null }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    try {
      await host.connect();
      const content = [{ type: 'mention' as const, kind: 'custom' as const, id: 'agent-1', value: 'agent:1', label: 'Alex', groupId: 'agents' }];
      await host.sendMessage('Alex\n<context>Selected agent: agent:1</context>', { content });
      const id = sent!.clientUserMessageId;
      transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('authored-turn', 'completed', []) });
      await host.readConversationHistory('thread-existing');
      expect(host.getSnapshot().messages.find(message => message.id === id)).toMatchObject({
        parts: [{ type: 'text', text: 'Alex' }], metadata: { promptContent: content },
      });
      await host.retryTurn('authored-turn');
      expect(host.getSnapshot().messages.find(message => message.id === sent!.clientUserMessageId)?.metadata?.promptContent).toStrictEqual(content);
      transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('authored-turn', 'completed', []) });
      const edited = [...content, { type: 'text' as const, text: ' now' }];
      await host.editTurn('authored-turn', 'Alex now', { content: edited });
      expect(host.getSnapshot().messages.find(message => message.id === sent!.clientUserMessageId)?.metadata?.promptContent).toStrictEqual(edited);
    } finally {
      await host.close();
    }
  });

  it('retains selected parts through queue edits and clears them when replaced by plain text', async () => {
    const { host, transport } = createHarness('turn/start', 'turn/steer');
    try {
      await host.connect();
      await host.sendMessage('Start');
      const content = [{ type: 'mention' as const, kind: 'custom' as const, id: 'agent-1', value: 'agent:1', label: 'Alex', groupId: 'agents' }];
      await host.sendMessage('Alex', { content });
      const id = host.getSnapshot().queuedPrompts[0]!.id;
      const edited = [...content, { type: 'text' as const, text: ' later' }];
      await host.updateQueuedPrompt(id, 'Alex later', { content: edited });
      expect(host.getSnapshot().queuedPrompts[0]?.options?.content).toStrictEqual(edited);
      await host.steerQueuedPrompt(id);
      expect(host.getSnapshot().messages.find(message => message.kind === 'steer')?.metadata?.promptContent).toStrictEqual(edited);
      await host.sendMessage('Alex', { content });
      const plainId = host.getSnapshot().queuedPrompts[0]!.id;
      await host.updateQueuedPrompt(plainId, 'literal @agent:1');
      expect(host.getSnapshot().queuedPrompts[0]?.options?.content).toBeUndefined();
      await host.steerQueuedPrompt(plainId);
      expect(lastRequest(transport, 'turn/steer')).toMatchObject({ params: { input: [{ type: 'text', text: 'literal @agent:1', text_elements: [] }] } });
    } finally {
      await host.close();
    }
  });

  it.each(['response-first', 'notification-first'] as const)(
    'retains observed live turn timing until provider timing arrives (%s)', async (order) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-25T19:00:00Z'));
      const live = { ...turn('turn-clock', 'inProgress', []), startedAt: null };
      const transport = new MockCodexAppServer({
        'thread/resume': () => {
          const restored = thread('thread-existing', true);
          restored.turns[0]!.startedAt = null;
          return resumeResponse(restored);
        },
        'turn/start': () => {
          if (order === 'notification-first') {
            transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: live });
          }
          return { turn: live };
        },
      });
      const host = new CodexHost({ client: new CodexAppServerClient(transport) });
      try {
        await host.connect();
        expect(host.getSnapshot().turns.find(candidate => candidate.id === 'turn-history')?.startedAt).toBeNull();
        await host.sendMessage('Show elapsed work time');
        const current = () => host.getSnapshot().turns.find(candidate => candidate.id === live.id);
        expect(current()).toMatchObject({ status: 'inProgress', startedAt: '2026-10-25T19:00:00.000Z' });

        vi.setSystemTime(new Date('2026-10-25T19:00:10Z'));
        transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: live });
        expect(current()?.startedAt).toBe('2026-10-25T19:00:00.000Z');

        const providerStart = Date.parse('2026-10-25T18:59:58Z') / 1000;
        transport.emitNotification('turn/started', {
          threadId: 'thread-existing', turn: { ...live, startedAt: providerStart },
        });
        expect(current()?.startedAt).toBe('2026-10-25T18:59:58.000Z');
        transport.emitNotification('turn/completed', {
          threadId: 'thread-existing', turn: { ...live, status: 'completed', durationMs: 29_000 },
        });
        expect(current()).toMatchObject({
          status: 'completed', startedAt: '2026-10-25T18:59:58.000Z', durationMs: 29_000,
        });
      } finally {
        await host.close();
        vi.useRealTimers();
      }
    },
  );

  it('delivers an attachment-only file as model-visible text and restores its chip from history', async () => {
    const { host, transport } = createHarness('turn/start');
    await host.connect();
    try {
      await host.sendMessage('(no user instructions)', {
        attachments: [{ type: 'file', path: '/tmp/research.html', name: 'Research' }],
      });
      const message = lastRequest(transport, 'turn/start')!;
      if (!('params' in message)) throw new Error('Missing turn/start request');
      const request = message.params as v2.TurnStartParams;
      expect(request.input).toEqual([
        { type: 'text', text: '(no user instructions)', text_elements: [] },
        { type: 'text', text: '<attached_file>\n{"name":"Research","path":"/tmp/research.html"}\n</attached_file>', text_elements: [] },
      ]);
      transport.emitNotification('item/completed', {
        threadId: 'thread-existing', turnId: 'turn-live', completedAtMs: 1_700_000_002_000,
        item: { type: 'userMessage', id: 'attached-user', clientId: request.clientUserMessageId ?? null, content: request.input },
      });
      const expectedParts = [
        { type: 'text', text: '(no user instructions)' },
        { type: 'attachment', attachment: { kind: 'file', name: 'Research', path: '/tmp/research.html' } },
      ];
      expect(host.getSnapshot().messages.find((message) => message.id === request.clientUserMessageId)?.parts).toEqual(expectedParts);
      const restoredThread = thread('thread-existing', false);
      restoredThread.turns = [turn('turn-live', 'completed', [{
        type: 'userMessage', id: 'attached-user', clientId: null, content: request.input,
      }])];
      const restored = new CodexHost({ client: new CodexAppServerClient(new MockCodexAppServer({
        'thread/resume': () => resumeResponse(restoredThread),
      })) });
      try {
        await restored.connect();
        expect(restored.getSnapshot().messages.find((message) => message.role === 'user')?.parts).toEqual(expectedParts);
      } finally {
        await restored.close();
      }
    } finally {
      await host.close();
    }
  });

  it('preserves completion and messages received while resume is pending', async () => {
    const restored = thread('thread-existing', false);
    restored.status = { type: 'active', activeFlags: [] };
    restored.turns = [turn('race-turn', 'inProgress', [])];
    const response = deferred<ReturnType<typeof resumeResponse>>();
    const transport = new MockCodexAppServer({ 'thread/resume': () => response.promise });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const connecting = host.connect();
    await vi.waitFor(() => expect(lastRequest(transport, 'thread/resume')).toBeDefined());
    transport.emitNotification('item/agentMessage/delta', {
      threadId: 'thread-existing', turnId: 'race-turn', itemId: 'race-answer', delta: 'Finished during resume',
    });
    transport.emitNotification('turn/completed', {
      threadId: 'thread-existing', turn: turn('race-turn', 'completed', []),
    });
    response.resolve(resumeResponse(restored));
    await connecting;
    expect(host.getSnapshot()).toMatchObject({ busy: false, activeTurnId: null,
      turns: [expect.objectContaining({ id: 'race-turn', status: 'completed' })],
      messages: [expect.objectContaining({ parts: [expect.objectContaining({ text: 'Finished during resume' })] })],
    });
  });

  it('does not resurrect historical questions or execution when resuming an idle thread', async () => {
    const restored = thread('thread-existing', false);
    restored.status = { type: 'idle' };
    restored.turns = [turn('old-turn', 'inProgress', [{
      type: 'agentMessage', id: 'old-question', text: 'Pick one', phase: null,
      memoryCitation: null, delivery: 'async', questions: [{ title: 'Pick one', options: null }],
    }])];
    const transport = new MockCodexAppServer({
      'thread/resume': () => resumeResponse(restored),
      'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    expect(host.getSnapshot()).toMatchObject({ busy: false, activeTurnId: null, clientRequests: [] });
    expect(host.getSnapshot().turns).toMatchObject([{ id: 'old-turn', status: 'interrupted' }]);
    expect(host.getSnapshot().messages).not.toHaveLength(0);
    await host.sendMessage('New work');
    expect(lastRequest(transport, 'turn/start')).toBeDefined();
    expect(host.getSnapshot().queuedPrompts).toEqual([]);
  });

  it('clears stale execution on authoritative idle even when turn/completed was missed', async () => {
    const { host, transport } = createHarness('turn/start');
    await host.connect();
    const replica = createCodexConversationReplica(host.getConversationSnapshot('thread-existing'));
    host.onConversationEvent('thread-existing', (event) => replica.apply(event));
    transport.emitNotification('turn/started', {
      threadId: 'thread-existing', turn: turn('lost-completion', 'inProgress', []),
    });
    expect(host.getSnapshot().busy).toBe(true);
    transport.emitNotification('thread/status/changed', {
      threadId: 'thread-existing', status: { type: 'idle' },
    });
    expect(host.getSnapshot()).toMatchObject({ busy: false, activeTurnId: null });
    expect(host.getSnapshot().turns).toContainEqual(expect.objectContaining({
      id: 'lost-completion', status: 'inProgress',
    }));
    expect(replica.getSnapshot()).toMatchObject({ busy: false, activeTurnId: null,
      turns: expect.arrayContaining([expect.objectContaining({ id: 'lost-completion', status: 'inProgress' })]),
    });
    await host.sendMessage('New work');
    expect(lastRequest(transport, 'turn/start')).toBeDefined();
  });

  it('discards prior async questions at the next turn without reviving them on replay', async () => {
    const { host, transport } = createHarness('turn/start');
    onTestFinished(() => host.close());
    await host.connect();
    const replica = createCodexConversationReplica(host.getConversationSnapshot('thread-existing'));
    host.onConversationEvent('thread-existing', event => replica.apply(event));
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('question-turn', 'inProgress', []) });
    const item = {
      type: 'agentMessage' as const, id: 'pending-question', text: 'Choose', phase: null,
      memoryCitation: null, delivery: 'async' as const, questions: [{ title: 'Choose', options: ['One', 'Two'] }],
    };
    const question = { threadId: 'thread-existing', turnId: 'question-turn', completedAtMs: 1_700_000_002_000, item };
    transport.emitNotification('item/completed', question);
    expect(host.getSnapshot().clientRequests.map(request => request.id)).toStrictEqual(['async-question:pending-question']);
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('next-turn', 'inProgress', []) });
    expect(host.getSnapshot().clientRequests).toStrictEqual([]);
    expect(host.getSnapshot().answeredClientRequestIds).toContain('async-question:pending-question');
    expect(replica.getSnapshot().clientRequests).toStrictEqual([]);
    expect(replica.getSnapshot().answeredClientRequestIds).toContain('async-question:pending-question');
    transport.emitNotification('item/completed', question);
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('next-turn', 'completed', []) });
    expect(host.getSnapshot().clientRequests).toStrictEqual([]);
    await expect(host.conversation('thread-existing').respondToClientRequest({
      id: 'async-question:pending-question', payload: { cancelled: true },
    })).rejects.toThrow('Unknown client request');
    transport.emitNotification('item/completed', { ...question, turnId: 'next-turn', item: { ...item, id: 'new-question' } });
    expect(host.getSnapshot().clientRequests.map(request => request.id)).toStrictEqual(['async-question:new-question']);
    transport.emitNotification('item/agentMessage/delta', {
      threadId: 'thread-existing', turnId: 'question-turn', itemId: 'late-text', delta: 'Late previous-turn text',
    });
    expect(host.getSnapshot().clientRequests.map(request => request.id)).toStrictEqual(['async-question:new-question']);
  });

  it('keeps an async Skip resolved across replay and history reload without persistent host state', async () => {
    const { host, transport } = createHarness('turn/start');
    onTestFinished(() => host.close());
    await host.connect();
    const question = {
      threadId: 'thread-existing', turnId: 'question-turn', completedAtMs: 1_700_000_002_000,
      item: { type: 'agentMessage' as const, id: 'skipped-question', text: 'Choose', phase: null,
        memoryCitation: null, delivery: 'async' as const, questions: [{ title: 'Choose', options: null }] },
    };
    transport.emitNotification('item/completed', question);
    const handle = host.conversation('thread-existing');
    await handle.respondToClientRequest({ id: 'async-question:skipped-question', payload: { cancelled: true } });
    transport.emitNotification('item/completed', question);
    expect(handle.getSnapshot().clientRequests).toStrictEqual([]);
    await expect(handle.respondToClientRequest({
      id: 'async-question:skipped-question', payload: { answers: { '["request_user_input_async","skipped-question",0]': { answers: ['One'] } } },
    })).rejects.toThrow('Unknown client request');
    expect(lastRequest(transport, 'turn/start')).toBeUndefined();
    await handle.load();
    expect(handle.getSnapshot().clientRequests).toStrictEqual([]);
  });

  it('projects asynchronous agent questions as answerable host requests', async () => {
    const { host, transport } = createHarness('turn/start');
    const events: CodexEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing',
        turnId: 'turn-question',
        itemId: 'agent-question',
        delta: 'Which framework should I use?',
      });
    events.length = 0;

    transport.emitNotification('item/completed', {
        threadId: 'thread-existing',
        turnId: 'turn-question',
        completedAtMs: 1_700_000_002_000,
        item: {
          type: 'agentMessage',
          id: 'agent-question',
          text: 'Which framework should I use?\n- Vue\n- React',
          phase: null,
          memoryCitation: null,
          delivery: 'async',
          questions: [{ title: 'Which framework should I use?', options: ['Vue', 'React'] }],
        },
      });

    const request = {
      id: 'async-question:agent-question',
      kind: 'ask_user',
      conversationId: 'thread-existing',
      turnId: 'turn-question',
      itemId: 'agent-question',
      payload: {
        request: {
          itemId: 'agent-question',
          delivery: 'async',
          blocking: false,
          questions: [{
            id: '["request_user_input_async","agent-question",0]',
            header: 'Which framework should I use?',
            question: 'Which framework should I use?',
            isOther: true,
            isSecret: false,
            options: [
              { label: 'Vue', description: '' },
              { label: 'React', description: '' },
            ],
          }],
        },
      },
    } as const;
    expect(host.getConversationSnapshot('thread-existing')).toMatchObject({
      clientRequests: [request],
      messages: [
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          id: 'assistant-turn-question',
          parts: [{ type: 'question', request }],
        }),
      ],
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'message.updated',
      conversationId: 'thread-existing',
      turnId: 'turn-question',
      payload: {
        message: expect.objectContaining({
          parts: [{ type: 'question', request }],
        }),
      },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'clientRequest.requested',
      conversationId: 'thread-existing',
      turnId: 'turn-question',
      payload: { request },
    }));
    transport.emitNotification('turn/completed', {
        threadId: 'thread-existing',
        turn: turn('turn-question', 'completed', []),
      });

    await host.conversation('thread-existing').respondToClientRequest({
      id: request.id,
      payload: { answers: { [request.payload.request.questions[0].id]: { answers: ['Vue'] } } },
    });

    expect(lastRequest(transport, 'turn/start')).toMatchObject({
      params: {
        threadId: 'thread-existing',
        input: [{
          type: 'text',
          text: '<send_user_message_question_reply>\n'
            + '[{"questionItemId":"[\\"request_user_input_async\\",\\"agent-question\\",0]","question":"Which framework should I use?","answer":"Vue"}]\n'
            + '</send_user_message_question_reply>',
        }],
      },
    });
    expect(host.getConversationSnapshot('thread-existing')).toMatchObject({
      clientRequests: [],
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          parts: [{ type: 'text', text: 'Vue' }],
        }),
      ]),
    });

    await host.close();
  });

  it('connects, returns state, publishes summaries, and refreshes plugins from conversation refresh', async () => {
    let pluginLoads = 0;
    const transport = new MockCodexAppServer({
      'plugin/installed': () => {
        pluginLoads += 1;
        return { marketplaces: [], marketplaceLoadErrors: [] };
      },
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const events: CodexEvent[] = [];
    host.onEvent((event) => events.push(event));

    const snapshot = await host.refreshConversations();
    await vi.waitFor(() => expect(pluginLoads).toBe(2));

    expect(transport.start).toHaveBeenCalledOnce();
    expect(snapshot).toMatchObject({
      status: 'ready',
      conversations: [expect.objectContaining({ id: 'thread-existing' })],
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.summaryUpserted',
      origin: 'action',
      conversationId: 'thread-existing',
      payload: expect.objectContaining({ reason: 'listed' }),
    }));
    await host.close();
  });

  it('publishes the complete semantic state when creating a conversation', async () => {
    const { host } = createHarness('thread/start', 'thread/settings/update');
    const events: CodexEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    events.length = 0;

    const snapshot = await host.createConversation();

    expect(snapshot.activeConversationId).toBe('thread-new');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'conversation.summaryUpserted', origin: 'action', conversationId: 'thread-new',
        payload: expect.objectContaining({ reason: 'created' }),
      }),
      expect.objectContaining({
        type: 'conversation.selected', origin: 'action',
        payload: { conversationId: 'thread-new' },
      }),
      expect.objectContaining({
        type: 'conversation.activityChanged', origin: 'action', conversationId: 'thread-new',
      }),
      expect.objectContaining({
        type: 'conversation.settingsChanged', origin: 'action', conversationId: 'thread-new',
      }),
      expect.objectContaining({
        type: 'conversation.skillsChanged', origin: 'action', conversationId: 'thread-new',
      }),
      expect.objectContaining({
        type: 'conversation.permissionsChanged', origin: 'action', conversationId: 'thread-new',
      }),
    ]));
    await host.close();
  });

  it('restores conversation loading state when resume fails', async () => {
    const transport = new MockCodexAppServer({
      'thread/resume': () => {
        throw new Error('resume unavailable');
      },
    });
    const host = new CodexHost({
      client: new CodexAppServerClient(transport), autoSelectFirstConversation: false,
    });
    await host.connect();

    await expect(host.conversation('thread-failing').load()).rejects.toThrow('resume unavailable');

    expect(host.getConversationSnapshot('thread-failing')).toMatchObject({
      historyLoading: false,
      error: 'resume unavailable',
    });
    await host.close();
  });

  it('creates a conversation when review starts before bootstrap without a selected thread', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [], nextCursor: null }),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
      'review/start': (params) => ({
        turn: turn('turn-new-review', 'completed', []),
        reviewThreadId: (params as { threadId: string }).threadId,
      }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const events: CodexEvent[] = [];
    host.onEvent((event) => events.push(event));

    await host.startReview();

    expect(lastRequest(transport, 'initialize')).toBeDefined();
    expect(lastRequest(transport, 'thread/start')).toBeDefined();
    expect(lastRequest(transport, 'review/start')).toMatchObject({
      params: { threadId: 'thread-new', delivery: 'inline' },
    });
    expect(host.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-new',
      conversations: [expect.objectContaining({ id: 'thread-new', turnCount: 1 })],
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.activityChanged',
      origin: 'action',
      conversationId: 'thread-new',
      payload: expect.objectContaining({ busy: true }),
    }));
    await host.close();
  });

  it('hydrates older history before rolling back to a non-materialized turn', async () => {
    const oldTurn = turn('turn-old', 'completed', []);
    const transport = new MockCodexAppServer({
      'thread/resume': () => ({
        ...resumeResponse(thread('thread-existing', false)),
        initialTurnsPage: {
          data: [turn('turn-newest', 'completed', [])], nextCursor: 'older-page', backwardsCursor: null,
        },
      }),
      'thread/turns/list': () => ({ data: [oldTurn], nextCursor: null, backwardsCursor: null }),
      'thread/revert': () => ({ thread: thread('thread-existing', false), turnsBackwardsCursor: null, itemsBackwardsCursor: null }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();

    await host.conversation('thread-existing').deleteTurn('turn-old');

    expect(lastRequest(transport, 'thread/turns/list')).toMatchObject({
      params: { threadId: 'thread-existing', cursor: 'older-page', itemsView: 'full' },
    });
    expect(lastRequest(transport, 'thread/revert')).toMatchObject({
      params: { threadId: 'thread-existing', beforeTurnId: 'turn-old' },
    });
    await host.close();
  });

  it('projects review startup and authoritative completion through conversation summaries', async () => {
    const review = deferred<v2.ReviewStartResponse>();
    const transport = new MockCodexAppServer({ 'review/start': () => review.promise });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const events: CodexEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    events.length = 0;

    const start = host.startReview();
    await vi.waitFor(() => expect(lastRequest(transport, 'review/start')).toBeDefined());
    expect(host.getSnapshot()).toMatchObject({
      busy: true,
      conversations: [expect.objectContaining({ id: 'thread-existing', status: 'active' })],
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.summaryUpserted',
      origin: 'action',
      payload: expect.objectContaining({ summary: expect.objectContaining({ status: 'active' }) }),
    }));

    review.resolve({
      turn: turn('turn-review-projection', 'completed', []),
      reviewThreadId: 'thread-existing',
    });
    await start;

    expect(host.getSnapshot()).toMatchObject({
      busy: false,
      conversations: [expect.objectContaining({ id: 'thread-existing', status: 'idle', turnCount: 2 })],
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.summaryUpserted',
      origin: 'action',
      payload: expect.objectContaining({ summary: expect.objectContaining({ turnCount: 2 }) }),
    }));
    await host.close();
  });

  it('provides scoped conversation discovery, skill catalogs, attachments, and turn deletion', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': (params) => ({ readStates: null, backwardsCursor: null,
        data: [{ ...thread('thread-existing', true), cwd: String((params as { cwd?: string }).cwd ?? '/tmp/project') }],
        nextCursor: null,
      }),
      'skills/list': (params) => {
        const cwd = (params as { cwds?: string[] }).cwds?.[0] ?? '/global';
        return {
          data: [{
            cwd,
            skills: [{ pluginId: null,
              name: 'workspace-skill', description: cwd, path: `${cwd}/SKILL.md`, scope: 'repo',
              enabled: true, interface: undefined,
            }],
            errors: [],
          }],
        };
      },
      'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
      'turn/steer': () => ({ turnId: 'turn-live' }),
      'thread/revert': () => ({ thread: thread('thread-existing', false), turnsBackwardsCursor: null, itemsBackwardsCursor: null }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport), cwd: '/tmp/project' });
    const events: CodexEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();

    await expect(host.listConversations({ cwd: '/workspace/specific', limit: 5 }))
      .resolves.toMatchObject([{ id: 'thread-existing', cwd: '/workspace/specific' }]);
    expect(lastRequest(transport, 'thread/list')).toMatchObject({
      params: { cwd: '/workspace/specific', limit: 5, archived: false },
    });
    await expect(host.listSkills({ cwd: '/workspace/specific', forceReload: true }))
      .resolves.toMatchObject([{ name: 'workspace-skill', path: '/workspace/specific/SKILL.md' }]);

    await host.sendMessage('Inspect attachments', {
      attachments: [
        { type: 'image', path: '/tmp/screenshot.png', detail: 'high' },
        { type: 'file', path: '/tmp/README.md', name: 'README' },
      ],
    });
    expect(host.getSnapshot().messages.find((message) => (
      message.role === 'user' && message.parts.some((part) => part.type === 'attachment')
    ))).toMatchObject({
      parts: [
        { type: 'text', text: 'Inspect attachments' },
        { type: 'attachment', attachment: { kind: 'image', name: 'screenshot.png', path: '/tmp/screenshot.png' } },
        { type: 'attachment', attachment: { kind: 'file', name: 'README', path: '/tmp/README.md' } },
      ],
    });
    await host.sendMessage('Queued with attachment', {
      attachments: [{ type: 'file', path: '/tmp/queued.txt' }],
    });
    const queuedPromptId = host.getSnapshot().queuedPrompts[0]?.id;
    expect(queuedPromptId).toBeDefined();
    await host.steerQueuedPrompt(queuedPromptId!);
    expect(host.getSnapshot().queuedPrompts).toHaveLength(0);
    expect(lastRequest(transport, 'turn/steer')).toMatchObject({
      params: {
        input: [
          { type: 'text', text: 'Queued with attachment' },
          { type: 'text', text: '<attached_file>\n{"name":"queued.txt","path":"/tmp/queued.txt"}\n</attached_file>', text_elements: [] },
        ],
      },
    });
    expect(lastRequest(transport, 'turn/start')).toMatchObject({
      params: {
        input: [
          { type: 'text', text: 'Inspect attachments' },
          { type: 'localImage', path: '/tmp/screenshot.png', detail: 'high' },
          { type: 'text', text: '<attached_file>\n{"name":"README","path":"/tmp/README.md"}\n</attached_file>', text_elements: [] },
        ],
      },
    });
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-live', 'completed', []) });
    const conversation = host.conversation('thread-existing');
    expect(conversation.getSnapshot()).toMatchObject({
      activeTurnId: null,
      turnIds: ['turn-history', 'turn-live'],
      turns: [
        { id: 'turn-history', status: 'completed' },
        { id: 'turn-live', status: 'completed' },
      ],
    });
    expect(host.getSnapshot().conversations).toContainEqual(expect.objectContaining({
      id: 'thread-existing', turnCount: 2,
    }));
    events.length = 0;
    const rolledBack = await conversation.deleteTurn('turn-history');
    expect(lastRequest(transport, 'thread/revert')).toMatchObject({
      params: { threadId: 'thread-existing', beforeTurnId: 'turn-history' },
    });
    expect(rolledBack).toMatchObject({ activeConversationId: 'thread-existing', activeTurnId: null, turnIds: [] });
    expect(host.getSnapshot().conversations).toContainEqual(expect.objectContaining({
      id: 'thread-existing', turnCount: 0,
    }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'conversation.summaryUpserted',
        origin: 'action',
        payload: expect.objectContaining({
          reason: 'updated', summary: expect.objectContaining({ id: 'thread-existing', turnCount: 0 }),
        }),
      }),
      expect.objectContaining({
        type: 'conversation.historyReplaced',
        origin: 'action',
        conversationId: 'thread-existing',
        payload: expect.objectContaining({ reason: 'rollback', messages: [] }),
      }),
    ]));
    await expect(conversation.sendMessage('Bad attachment', {
      attachments: [{ type: 'file', path: 'relative.txt' }],
    })).rejects.toThrow('Attachment path must be absolute');
  });

  it('preserves structured attachments when retrying and editing user messages', async () => {
    const { host, transport } = createHarness('turn/start', 'thread/revert');
    await host.connect();
    const attachments = [
      {
        type: 'image' as const,
        path: '/tmp/screenshot.png',
        name: 'Screenshot',
        mimeType: 'image/png',
        previewUrl: 'data:image/png;base64,cG5n',
      },
      { type: 'file' as const, path: '/tmp/README.md', name: 'README', mimeType: 'text/markdown' },
    ];
    await host.sendMessage('Original prompt', { attachments });
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-live', 'completed', []) });
    await host.retryTurn('turn-live');
    expect(lastRequest(transport, 'turn/start')).toMatchObject({
      params: {
        input: [
          { type: 'text', text: 'Original prompt' },
          { type: 'localImage', path: '/tmp/screenshot.png' },
          { type: 'text', text: '<attached_file>\n{"name":"README","path":"/tmp/README.md"}\n</attached_file>', text_elements: [] },
        ],
      },
    });
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-live', 'completed', []) });
    await host.editTurn('turn-live', 'Edited prompt');
    expect(lastRequest(transport, 'turn/start')).toMatchObject({
      params: {
        input: [
          { type: 'text', text: 'Edited prompt' },
          { type: 'localImage', path: '/tmp/screenshot.png' },
          { type: 'text', text: '<attached_file>\n{"name":"README","path":"/tmp/README.md"}\n</attached_file>', text_elements: [] },
        ],
      },
    });
  });

  it('continues a hydrated in-progress assistant message without duplicating its segment', async () => {
    const runningThread = thread('thread-running', false);
    runningThread.status = { type: 'active', activeFlags: [] };
    runningThread.turns = [turn('turn-running', 'inProgress', [
      { type: 'userMessage', id: 'user-running', clientId: null, content: [{ type: 'text', text: 'Continue', text_elements: [] }] },
      { type: 'agentMessage', id: 'agent-running', text: 'Hello', phase: null, memoryCitation: null, delivery: null, questions: null },
    ])];
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [thread('thread-running', false)], nextCursor: null }),
      'thread/resume': () => resumeResponse(runningThread),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();

    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-running', turnId: 'turn-running', itemId: 'agent-running', delta: ' world',
      });
    transport.emitNotification('turn/completed', { threadId: 'thread-running', turn: turn('turn-running', 'completed', []) });

    const assistant = host.getSnapshot().messages.filter((message) => (
      message.role === 'assistant' && message.turnId === 'turn-running'
    ));
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatchObject({
      status: 'complete',
      metadata: { conversationId: 'thread-running', turnId: 'turn-running' },
      parts: [{ type: 'text', itemId: 'agent-running', text: 'Hello world' }],
    });
  });

  it('dispatches only explicit skills and preserves authored content while rejecting untrusted skill paths', async () => {
    const transport = new MockCodexAppServer({
      'skills/list': () => ({
        data: [{
          cwd: '/tmp/project', errors: [], skills: [
            { pluginId: null, name: 'pdf', description: 'PDF tools', path: '/trusted/pdf/SKILL.md', scope: 'user', enabled: true },
            { pluginId: null, name: 'disabled', description: 'Disabled', path: '/trusted/disabled/SKILL.md', scope: 'user', enabled: false },
          ],
        }],
      }),
      'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
      'turn/steer': () => ({ turnId: 'turn-live' }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    onTestFinished(() => host.close());
    await host.connect();
    expect(host.getSnapshot().skills).toStrictEqual([]);
    expect(host.getSnapshot().skillCatalogStatus).toBe('notLoaded');

    for (const skill of [
      { name: 'pdf', path: '/tmp/attacker/SKILL.md' },
      { name: 'disabled', path: '/trusted/disabled/SKILL.md' },
      { name: 'spoofed', path: '/trusted/pdf/SKILL.md' },
    ]) {
      await expect(host.sendMessage('bad', { skills: [skill] })).rejects.toThrow('is not an enabled skill');
      expect(lastRequest(transport, 'turn/start')).toBeUndefined();
    }
    expect(host.getSnapshot().skills).toStrictEqual([expect.objectContaining({ name: 'pdf', enabled: true })]);

    await host.sendMessage('Use $pdf and /pdf');
    expect(lastRequest(transport, 'turn/start')).toMatchObject({ params: {
      input: [{ type: 'text', text: 'Use $pdf and /pdf', text_elements: [] }],
    } });
    const content = [
      { type: 'text' as const, text: 'Literal $pdf then ' },
      { type: 'mention' as const, kind: 'skill' as const, id: '/trusted/pdf/SKILL.md', value: 'pdf', label: 'PDF tools' },
      { type: 'mention' as const, kind: 'file' as const, id: '/project/README.md', value: '/project/README.md', label: 'README.md' },
      { type: 'mention' as const, kind: 'plugin' as const, id: 'gmail@remote', value: 'gmail', label: 'Gmail' },
    ];
    const context = '\n\n<context>Keep PDF tools and $pdf exactly here.</context>';
    const visible = 'Literal $pdf then PDF toolsREADME.mdGmail';
    const dispatched = 'Literal $pdf then [$pdf](/trusted/pdf/SKILL.md)@/project/README.md[@gmail](plugin://gmail@remote)';
    const input = [
      { type: 'text', text: dispatched + context, text_elements: [] },
      { type: 'mention', name: 'README.md', path: '/project/README.md' },
      { type: 'mention', name: 'Gmail', path: 'plugin://gmail@remote' },
      { type: 'skill', name: 'pdf', path: '/trusted/pdf/SKILL.md' },
    ];
    for (const [method, prompt, skills] of [
      ['turn/steer', visible + context, undefined],
      ['turn/start', dispatched + context, [{ name: 'pdf', path: '/trusted/pdf/SKILL.md' }]],
      ['turn/start', visible + context, undefined],
    ] as const) {
      const options = { content, skills };
      if (method === 'turn/steer') await host.steerMessage(prompt, options);
      else await host.sendMessage(prompt, options);
      expect(lastRequest(transport, method)).toMatchObject({ params: { input } });
      expect(host.getSnapshot().messages.filter(message => message.role === 'user').at(-1)).toMatchObject({
        parts: [{ type: 'text', text: visible }], metadata: { promptContent: content },
      });
      transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-live', 'completed', []) });
    }
    await host.sendMessage('Use $pdf and /pdf', {
      skills: [{ name: 'pdf', path: '/trusted/pdf/SKILL.md' }],
    });
    expect(lastRequest(transport, 'turn/start')).toMatchObject({
      params: {
        input: [
          { type: 'text', text: 'Use $pdf and /pdf' },
          { type: 'skill', name: 'pdf', path: '/trusted/pdf/SKILL.md' },
        ],
      },
    });
    expect(lastRequest(transport, 'turn/start')).not.toMatchObject({ params: { cwd: expect.anything() } });
  });

  it('preserves slash command semantics and exposes structured review, rename, and non-mutating history operations', async () => {
    const goal = testGoal({ objective: 'Existing goal' });
    const transport = new MockCodexAppServer({
      'thread/goal/get': () => ({ goal }),
      'thread/resume': (params) => {
        const threadId = (params as { threadId: string }).threadId;
        if (threadId !== 'thread-running-read') return resumeResponse(thread(threadId, true));
        const running = thread(threadId, false);
        running.status = { type: 'active', activeFlags: [] };
        running.turns = [turn('turn-running-read', 'inProgress', [])];
        return resumeResponse(running);
      },
      'thread/goal/clear': () => ({ cleared: true }),
      'thread/read': (params) => {
        const threadId = (params as { threadId: string }).threadId;
        if (threadId === 'thread-running-read') {
          const running = thread(threadId, false);
          running.status = { type: 'active', activeFlags: [] };
          running.turns = [turn('turn-running-read', 'inProgress', [])];
          return { readState: null, thread: running };
        }
        return { readState: null, thread: thread(threadId, true) };
      },
      'thread/turns/list': (params) => {
        const threadId = (params as { threadId: string }).threadId;
        return {
          data: threadId === 'thread-running-read'
            ? [turn('turn-running-read', 'inProgress', [])]
            : thread(threadId, true).turns,
          nextCursor: null,
          backwardsCursor: null,
        };
      },
      'review/start': (params) => ({
        turn: turn('review-complete', 'completed', []),
        reviewThreadId: (params as { threadId: string }).threadId,
      }),
      'thread/settings/update': () => ({}),
      'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
      'thread/name/set': () => ({}),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const events: CodexEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    expect((await host.sendMessage('/goal')).goal).toMatchObject({ objective: 'Existing goal' });
    expect((await host.sendMessage('/goal edit')).goal).toMatchObject({ objective: 'Existing goal' });
    await host.sendMessage('/goal clear');
    expect(host.getSnapshot().goal).toBeNull();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.goalChanged',
      origin: 'action',
      conversationId: 'thread-existing',
      payload: { goal: null },
    }));
    await expect(host.sendMessage('/goal pause')).rejects.toThrow('not supported');

    await host.sendMessage('/plan Build a plan');
    expect(lastRequest(transport, 'thread/settings/update')).toMatchObject({
      params: { threadId: 'thread-existing', collaborationMode: { mode: 'plan' } },
    });
    expect(lastRequest(transport, 'turn/start')).toMatchObject({
      params: { threadId: 'thread-existing', input: [{ type: 'text', text: 'Build a plan' }] },
    });
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-live', 'completed', []) });

    await host.sendMessage('/review focus on regressions');
    expect(lastRequest(transport, 'review/start')).toMatchObject({
      params: { target: { type: 'custom', instructions: 'focus on regressions' }, delivery: 'inline' },
    });
    await host.startReview({ target: { type: 'baseBranch', branch: 'main' } });
    expect(lastRequest(transport, 'review/start')).toMatchObject({
      params: { target: { type: 'baseBranch', branch: 'main' } },
    });
    await host.conversation('thread-existing').startReview({ target: { type: 'commit', sha: 'abc123' } });
    expect(lastRequest(transport, 'review/start')).toMatchObject({
      params: { target: { type: 'commit', sha: 'abc123', title: null } },
    });

    await host.conversation('thread-existing').rename('Renamed');
    expect(lastRequest(transport, 'thread/name/set')).toMatchObject({
      params: { threadId: 'thread-existing', name: 'Renamed' },
    });
    await host.renameConversation('Renamed again');
    expect(lastRequest(transport, 'thread/name/set')).toMatchObject({
      params: { threadId: 'thread-existing', name: 'Renamed again' },
    });
    expect(host.getSnapshot().conversations).toContainEqual(expect.objectContaining({
      id: 'thread-existing', title: 'Renamed again',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.summaryUpserted',
      origin: 'action',
      payload: expect.objectContaining({
        reason: 'updated', summary: expect.objectContaining({ title: 'Renamed again' }),
      }),
    }));
    await expect(host.readConversationHistory()).resolves.toMatchObject({
      conversationId: 'thread-existing',
    });
    const history = await host.conversation('thread-other').readHistory();
    expect(history).toMatchObject({
      conversationId: 'thread-other',
      messages: [expect.objectContaining({ role: 'user' }), expect.objectContaining({ role: 'assistant' })],
    });
    const runningHistory = await host.readConversationHistory('thread-running-read');
    expect(runningHistory).toMatchObject({
      conversationId: 'thread-running-read',
      threadStatus: { type: 'active' },
      messages: [expect.objectContaining({
        id: 'assistant-turn-running-read', role: 'assistant', status: 'streaming', parts: [],
      })],
    });
    expect(host.getSnapshot().activeConversationId).toBe('thread-existing');
    expect(transport.sent.filter((message) => (
      'method' in message
      && message.method === 'thread/read'
      && (message.params as { includeTurns?: boolean }).includeTurns === false
    ))).toHaveLength(2);
  });

  it('validates create settings before persistence and rejects detached responses for inline reviews', async () => {
    const transport = new MockCodexAppServer({
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
      'review/start': () => ({
        turn: turn('turn-review', 'inProgress', []),
        reviewThreadId: 'thread-detached',
      }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    await expect(host.sendMessage('bad model', { model: 'missing' })).rejects.toThrow("Unknown model 'missing'");
    await expect(host.sendMessage('bad effort', { reasoningEffort: 'ultra' }))
      .rejects.toThrow("Reasoning effort 'ultra' is not available");
    expect(lastRequest(transport, 'turn/start')).toBeUndefined();
    const startsBefore = transport.sent.filter((message) => 'method' in message && message.method === 'thread/start').length;
    await expect(host.createConversation({ model: 'gpt-5', reasoningEffort: 'ultra' }))
      .rejects.toThrow("Reasoning effort 'ultra' is not available");
    expect(transport.sent.filter((message) => 'method' in message && message.method === 'thread/start')).toHaveLength(startsBefore);

    await host.createConversation({ model: 'gpt-5', reasoningEffort: 'medium' });
    expect(lastRequest(transport, 'thread/settings/update')).toMatchObject({
      params: {
        threadId: 'thread-new', effort: 'medium', collaborationMode: { mode: 'default' },
      },
    });
    await expect(host.startReview()).rejects.toThrow("unexpected review thread 'thread-detached'");
  });

  it('does not clear optimistic busy state when a stale idle status arrives during turn/start', async () => {
    const pendingTurn = deferred<v2.TurnStartResponse>();
    const transport = new MockCodexAppServer({
      'turn/start': () => pendingTurn.promise,
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    const first = host.sendMessage('First');
    await vi.waitFor(() => expect(lastRequest(transport, 'turn/start')).toBeDefined());
    transport.emitNotification('thread/status/changed', { threadId: 'thread-existing', status: { type: 'idle' } });
    expect(host.getSnapshot().busy).toBe(true);
    await host.sendMessage('Second');
    expect(host.getSnapshot().queuedPrompts).toMatchObject([{ text: 'Second' }]);
    expect(transport.sent.filter((message) => 'method' in message && message.method === 'turn/start')).toHaveLength(1);
    pendingTurn.resolve({ turn: turn('turn-pending', 'inProgress', []) });
    await first;
  });

  it('keeps plan mode selection isolated per thread across refreshed idle histories', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [thread('thread-a', false), thread('thread-b', false)], nextCursor: null }),
      'thread/resume': (params) => resumeResponse(thread((params as { threadId: string }).threadId, true)),
      'thread/settings/update': () => ({}),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    await host.updateConversationSettings({ planMode: true });
    expect(host.getSnapshot()).toMatchObject({ activeConversationId: 'thread-a', planMode: true });

    await host.selectConversation('thread-b');
    expect(host.getSnapshot()).toMatchObject({ activeConversationId: 'thread-b', planMode: false });
    await host.selectConversation('thread-a');
    expect(host.getSnapshot()).toMatchObject({ activeConversationId: 'thread-a', planMode: true });
    await host.selectConversation('thread-b');
    expect(host.getSnapshot()).toMatchObject({ activeConversationId: 'thread-b', planMode: false });
  });

  it('keeps multiple conversation handles active and readable at the same time', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null,
        data: [thread('thread-a', false), thread('thread-b', false)], nextCursor: null,
      }),
      'thread/resume': (params) => resumeResponse(thread((params as { threadId: string }).threadId, false)),
      'thread/turns/list': () => ({ data: [], nextCursor: null, backwardsCursor: null }),
      'turn/start': (params) => ({
        turn: turn(`turn-${(params as { threadId: string }).threadId}`, 'inProgress', []),
      }),
    });
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      autoSelectFirstConversation: false,
    });
    await host.connect();
    const first = host.conversation('thread-a');
    const second = host.conversation('thread-b');
    await Promise.all([first.load(), second.load()]);

    await Promise.all([
      first.sendMessage('First background task'),
      second.sendMessage('Second background task'),
    ]);

    expect(first.getSnapshot()).toMatchObject({ busy: true, activeTurnId: 'turn-thread-a' });
    expect(second.getSnapshot()).toMatchObject({ busy: true, activeTurnId: 'turn-thread-b' });
    expect(host.getSnapshot().conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'thread-a', status: 'active', turnCount: 1 }),
      expect.objectContaining({ id: 'thread-b', status: 'active', turnCount: 1 }),
    ]));
    const threadReadsBefore = transport.sent.filter((message) => (
      'method' in message && message.method === 'thread/read'
    )).length;
    const [firstHistory, secondHistory] = await Promise.all([first.readHistory(), second.readHistory()]);
    expect(firstHistory).toMatchObject({
      conversationId: 'thread-a', messages: expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
    });
    expect(secondHistory).toMatchObject({
      conversationId: 'thread-b', messages: expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
    });
    expect(transport.sent.filter((message) => (
      'method' in message && message.method === 'thread/read'
    ))).toHaveLength(threadReadsBefore);
  });

  it('does not let out-of-order resume responses steal the active selection', async () => {
    const resumeB = deferred<v2.ThreadResumeResponse>();
    const resumeC = deferred<v2.ThreadResumeResponse>();
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null,
        data: [thread('thread-existing', false), thread('thread-b', false), thread('thread-c', false)],
        nextCursor: null,
      }),
      'thread/resume': (params) => {
        const threadId = (params as { threadId: string }).threadId;
        if (threadId === 'thread-b') return resumeB.promise;
        if (threadId === 'thread-c') return resumeC.promise;
        return resumeResponse(thread(threadId, true));
      },
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    const selectingB = host.selectConversation('thread-b');
    await vi.waitFor(() => expect(host.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-b', historyLoading: true,
    }));
    const selectingC = host.selectConversation('thread-c');
    await vi.waitFor(() => expect(host.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-c', historyLoading: true,
    }));

    resumeB.resolve(resumeResponse(thread('thread-b', true)));
    await selectingB;
    expect(host.getSnapshot()).toMatchObject({ activeConversationId: 'thread-c', historyLoading: true });
    resumeC.resolve(resumeResponse(thread('thread-c', true)));
    await selectingC;
    expect(host.getSnapshot()).toMatchObject({ activeConversationId: 'thread-c', historyLoading: false });
  });

  it('reads child metadata without loading turns or mutating host state', async () => {
    const transport = new MockCodexAppServer({
      'thread/read': (params) => ({ readState: null,
        thread: {
          ...thread(String((params as { threadId: string }).threadId), false),
          sessionId: 'session-root',
          parentThreadId: 'thread-existing',
          agentNickname: 'Kuhn',
          agentRole: 'researcher',
        },
      }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    await vi.waitFor(() => expect(host.getSnapshot().pluginCatalogStatus).toBe('loaded'));
    const snapshotBefore = host.getSnapshot();
    const events: CodexEvent[] = [];
    const unsubscribe = host.onEvent((event) => events.push(event));

    const summary = await host.readConversationSummary('thread-child');
    unsubscribe();

    expect(lastRequest(transport, 'thread/read')).toMatchObject({
      params: { threadId: 'thread-child', includeTurns: false },
    });
    expect(summary).toMatchObject({
      id: 'thread-child',
      sessionId: 'session-root',
      parentConversationId: 'thread-existing',
      agentNickname: 'Kuhn',
      agentRole: 'researcher',
      turnCount: 0,
    });
    expect(host.getSnapshot()).toStrictEqual(snapshotBefore);
    expect(events).toStrictEqual([]);
    expect(transport.sent.some((message) => (
      'method' in message
      && message.method === 'thread/turns/list'
      && (message.params as { threadId?: string }).threadId === 'thread-child'
    ))).toBe(false);
    expect(transport.sent.some((message) => (
      'method' in message
      && message.method === 'thread/resume'
      && (message.params as { threadId?: string }).threadId === 'thread-child'
    ))).toBe(false);
  });

  it('rejects a summary returned for a different conversation', async () => {
    const transport = new MockCodexAppServer({
      'thread/read': () => ({ readState: null, thread: thread('thread-other', false) }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();

    await expect(host.readConversationSummary('thread-child')).rejects.toThrow(
      "Codex thread/read returned 'thread-other' for requested thread 'thread-child'",
    );
  });

});
