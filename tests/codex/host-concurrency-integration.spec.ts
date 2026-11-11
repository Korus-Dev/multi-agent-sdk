import { describe, expect, it, vi } from 'vitest';
import {
  invokeCodexConversationBridgeOperation,
  subscribeCodexConversationBridge,
  type CodexConversationBridgeNotification,
} from '../../src/core/host-bridge';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk';
import { CodexHost, createCodexHost } from '../../src/providers/codex';
import {
  createHarness,
  deferred,
  MockCodexAppServer,
  lastRequest,
  lastResponse,
  requestsFor,
  resumeResponse,
  thread,
  turn,
} from './helpers/host-fixture';

describe('CodexHost', () => {
  it('forgets local conversation state without deleting the thread and recreates it on load', async () => {
    const transport = new MockCodexAppServer({
      'thread/read': (params) => ({ readState: null, thread: thread(String((params as { threadId: string }).threadId), false) }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    const oldHandle = host.conversation('thread-existing');
    expect(host.conversation('thread-existing')).toBe(oldHandle);
    const staleListener = vi.fn();
    oldHandle.onStateChange(staleListener);
    const sentCount = transport.sent.length;
    const events: string[] = [];
    host.onEvent((event) => {
      if (event.type === 'conversation.summaryRemoved') events.push(event.type);
    });

    host.forgetConversation('thread-existing');

    expect(transport.sent).toHaveLength(sentCount);
    expect(events).toStrictEqual([]);
    expect(host.getSnapshot()).toMatchObject({
      activeConversationId: null,
      messages: [],
      conversations: [expect.objectContaining({ id: 'thread-existing' })],
      answeredClientRequestIds: [],
      approvals: [],
      contextUsage: null,
      goal: null,
      turnGitDiff: null,
      threadStatus: null,
      queuedPrompts: [],
      busy: false,
      historyLoading: false,
      historyState: {
        loadingStrategy: 'lazy',
        hasOlder: false,
        loadingOlder: false,
        fullyLoaded: false,
      },
      error: null,
    });

    const newHandle = host.conversation('thread-existing');
    expect(newHandle).not.toBe(oldHandle);
    await newHandle.load();
    expect(newHandle.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-existing',
      messages: [
        expect.objectContaining({ id: 'user-thread-existing-turn-history-user-history' }),
        expect.objectContaining({ id: 'assistant-turn-history' }),
      ],
    });
    expect(transport.sent.filter((message) => 'method' in message && message.method === 'thread/resume')).toHaveLength(2);
    expect(staleListener).not.toHaveBeenCalled();

    host.forgetConversation('thread-existing');
    const historyHandle = host.conversation('thread-existing');
    await expect(historyHandle.readHistory()).resolves.toMatchObject({
      conversationId: 'thread-existing',
      messages: expect.arrayContaining([
        expect.objectContaining({ id: 'user-thread-existing-turn-history-user-history' }),
      ]),
    });
  });

  it('forgets a background conversation without clearing the active selection', async () => {
    const { host } = createHarness();
    await host.connect();
    await host.conversation('thread-background').load();

    host.forgetConversation('thread-background');

    expect(host.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-existing',
      messages: expect.arrayContaining([
        expect.objectContaining({ id: 'user-thread-existing-turn-history-user-history' }),
      ]),
    });
    expect(host.getConversationSnapshot('thread-background').messages).toStrictEqual([]);
  });

  it('clears remembered host context and item-event deduplication when forgetting', async () => {
    const execute = vi.fn(async () => 'done');
    const transport = new MockCodexAppServer();
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      extensions: [{
        dynamicTools: [{ name: 'inspect', description: 'Inspect', inputSchema: {}, execute }],
      }],
    });
    const fileEvents: unknown[] = [];
    host.onEvent((event) => {
      if (event.type === 'file.activity' && event.conversationId === 'thread-background') {
        fileEvents.push(event);
      }
    });
    await host.connect();
    await host.conversation('thread-background').load({
      extensionContext: { stale: true },
    });
    const emitRead = () => transport.emitNotification('item/started', {
        threadId: 'thread-background', turnId: 'turn-read', startedAtMs: 1,
        item: { pluginId: null, scriptPath: null,
          type: 'commandExecution', id: 'read-file', command: 'cat README.md', cwd: '/tmp/project',
          source: 'unifiedExecInteraction', status: 'inProgress',
          commandActions: [{ type: 'read', command: 'cat README.md', name: 'README.md', path: 'README.md' }],
          processId: null, aggregatedOutput: null, exitCode: null, durationMs: null,
        },
      });
    emitRead();
    expect(fileEvents).toHaveLength(1);

    host.forgetConversation('thread-background');
    await host.conversation('thread-background').load();
    emitRead();
    expect(fileEvents).toHaveLength(2);
    transport.emitServerRequest('dynamic-after-forget', 'item/tool/call', {
        threadId: 'thread-background', turnId: 'turn-read', callId: 'call', namespace: null,
        tool: 'inspect', arguments: {},
      });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ extensionContext: undefined }));
  });

  it('starts an independent history load after forgetting an in-flight one', async () => {
    const firstPage = deferred<v2.ThreadTurnsListResponse>();
    const secondPage = deferred<v2.ThreadTurnsListResponse>();
    let pageIndex = 0;
    const transport = new MockCodexAppServer({
      'thread/resume': (params) => ({
        ...resumeResponse(thread(String((params as { threadId: string }).threadId), false)),
        initialTurnsPage: { data: [], nextCursor: 'older', backwardsCursor: null },
      }),
      'thread/turns/list': () => [firstPage, secondPage][pageIndex++]!.promise,
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    const firstHandle = host.conversation('thread-background');
    await firstHandle.load();
    const firstLoad = firstHandle.loadOlderHistory();
    await vi.waitFor(() => expect(requestsFor(transport, 'thread/turns/list')).toHaveLength(1));

    host.forgetConversation('thread-background');
    const secondHandle = host.conversation('thread-background');
    await secondHandle.load();
    const secondLoad = secondHandle.loadOlderHistory();
    await vi.waitFor(() => expect(requestsFor(transport, 'thread/turns/list')).toHaveLength(2));
    firstPage.resolve({ data: [], nextCursor: null, backwardsCursor: null });
    secondPage.resolve({ data: [], nextCursor: null, backwardsCursor: null });

    await expect(Promise.all([firstLoad, secondLoad])).resolves.toHaveLength(2);
  });

  it('invalidates the handle and in-flight history cache when a conversation is archived', async () => {
    const firstPage = deferred<v2.ThreadTurnsListResponse>();
    const secondPage = deferred<v2.ThreadTurnsListResponse>();
    let pageIndex = 0;
    const transport = new MockCodexAppServer({
      'thread/resume': (params) => ({
        ...resumeResponse(thread(String((params as { threadId: string }).threadId), false)),
        initialTurnsPage: { data: [], nextCursor: 'older', backwardsCursor: null },
      }),
      'thread/turns/list': () => [firstPage, secondPage][pageIndex++]!.promise,
      'thread/unarchive': (params) => ({
        thread: thread(String((params as { threadId: string }).threadId), false),
      }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    const firstHandle = host.conversation('thread-existing');
    const firstLoad = firstHandle.loadOlderHistory();
    await vi.waitFor(() => expect(requestsFor(transport, 'thread/turns/list')).toHaveLength(1));

    transport.emitNotification('thread/archived', { threadId: 'thread-existing' });
    await host.unarchiveConversation('thread-existing');
    const secondHandle = host.conversation('thread-existing');
    expect(secondHandle).not.toBe(firstHandle);
    await secondHandle.load();
    const secondLoad = secondHandle.loadOlderHistory();
    await vi.waitFor(() => expect(requestsFor(transport, 'thread/turns/list')).toHaveLength(2));
    firstPage.resolve({ data: [], nextCursor: null, backwardsCursor: null });
    secondPage.resolve({ data: [], nextCursor: null, backwardsCursor: null });

    await expect(Promise.all([firstLoad, secondLoad])).resolves.toHaveLength(2);
  });

  it('clears remembered extension context when a conversation is archived', async () => {
    const execute = vi.fn(async () => 'done');
    const transport = new MockCodexAppServer({
      'thread/unarchive': (params) => ({
        thread: thread(String((params as { threadId: string }).threadId), false),
      }),
    });
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      extensions: [{
        dynamicTools: [{ name: 'inspect', description: 'Inspect', inputSchema: {}, execute }],
      }],
    });
    await host.connect();
    await host.conversation('thread-existing').load({ extensionContext: { stale: true } });

    transport.emitNotification('thread/archived', { threadId: 'thread-existing' });
    await host.unarchiveConversation('thread-existing');
    await host.conversation('thread-existing').load();
    transport.emitServerRequest('dynamic-after-archive', 'item/tool/call', {
        threadId: 'thread-existing', turnId: 'turn-after-archive', callId: 'call', namespace: null,
        tool: 'inspect', arguments: {},
      });

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ extensionContext: undefined }));
  });

  it('removes a runtime-only conversation after its summary falls out of the catalog', async () => {
    const transport = new MockCodexAppServer();
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const removed: string[] = [];
    host.onEvent((event) => {
      if (event.type === 'conversation.summaryRemoved') removed.push(event.conversationId);
    });
    await host.connect();
    const runtimeOnlyHandle = host.conversation('thread-background');
    await runtimeOnlyHandle.load();
    expect(host.getSnapshot().conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'thread-background' }),
    ]));

    await host.refreshConversations();
    expect(host.getSnapshot().conversations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'thread-background' }),
    ]));
    expect(runtimeOnlyHandle.getSnapshot().messages).not.toStrictEqual([]);

    transport.emitNotification('thread/deleted', { threadId: 'thread-background' });

    expect(host.conversation('thread-background')).not.toBe(runtimeOnlyHandle);
    expect(host.getConversationSnapshot('thread-background').messages).toStrictEqual([]);
    expect(removed).toContain('thread-background');
  });

  it('enforces active-conversation defaults through the public factory', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [], nextCursor: null }),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
    });
    const host = createCodexHost({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(transport),
    });
    await host.connect();

    await expect(host.readConversationHistory()).rejects.toThrow('There is no active conversation');
    await expect(host.loadOlderConversationHistory()).rejects.toThrow('Conversation id cannot be empty');
    await expect(host.renameConversation('Name')).rejects.toThrow('There is no active conversation');
    await expect(host.forkTurn('turn-1')).rejects.toThrow('There is no active conversation');
    await expect(host.deleteTurn('turn-1')).rejects.toThrow('There is no active conversation');
    await expect(host.editTurn('turn-1', 'text')).rejects.toThrow('There is no active conversation');
    await expect(host.retryTurn('turn-1')).rejects.toThrow('There is no active conversation');
    await expect(host.compactConversation()).resolves.toStrictEqual(host.getSnapshot());

    await host.sendMessage('/plan');
    expect(lastRequest(transport, 'thread/start')).toBeDefined();
    expect(lastRequest(transport, 'thread/settings/update')).toMatchObject({
      params: { threadId: 'thread-new', collaborationMode: { mode: 'plan' } },
    });
  });

  it('stops both host and conversation state delivery after unsubscription', async () => {
    const { host, transport } = createHarness('turn/start');
    await host.connect();
    const hostListener = vi.fn();
    const conversationListener = vi.fn();
    const unsubscribeHost = host.onStateChange(hostListener);
    const unsubscribeConversation = host.conversation('thread-existing').onStateChange(conversationListener);
    await host.conversation('thread-background').load();
    const backgroundListener = vi.fn();
    const unsubscribeBackground = host.conversation('thread-background').onStateChange(backgroundListener);

    await host.sendMessage('Trigger state');
    expect(hostListener).toHaveBeenCalled();
    expect(conversationListener).toHaveBeenCalled();
    backgroundListener.mockClear();
    await host.refreshConversations();
    expect(backgroundListener).toHaveBeenCalledWith(expect.objectContaining({
      activeConversationId: 'thread-background',
    }));
    hostListener.mockClear();
    conversationListener.mockClear();
    backgroundListener.mockClear();
    unsubscribeHost();
    unsubscribeConversation();
    unsubscribeBackground();
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing', turnId: 'turn-live', itemId: 'agent-live', delta: 'done',
      });

    expect(hostListener).not.toHaveBeenCalled();
    expect(conversationListener).not.toHaveBeenCalled();
    expect(backgroundListener).not.toHaveBeenCalled();
  });

  it('keeps live runtime, approvals, client requests, and queued drains isolated per thread', async () => {
    let turnNumber = 0;
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null,
        data: [thread('thread-a', false), thread('thread-b', false)],
        nextCursor: null,
      }),
      'thread/resume': (params) => resumeResponse(thread((params as { threadId: string }).threadId, true)),
      'turn/start': (params) => ({
        turn: turn(`${(params as { threadId: string }).threadId}-turn-${++turnNumber}`, 'inProgress', []),
      }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    await host.sendMessage('A first');
    await host.sendMessage('A queued');
    expect(host.getSnapshot().queuedPrompts).toMatchObject([{ text: 'A queued' }]);

    await host.selectConversation('thread-b');
    expect(host.getSnapshot()).toMatchObject({ activeConversationId: 'thread-b', approvals: [] });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-a', turnId: 'thread-a-turn-1', itemId: 'agent-a', delta: 'Background A',
      });
    transport.emitServerRequest('ask-a', 'item/tool/requestUserInput', { isBlocking: false,
        threadId: 'thread-a', turnId: 'thread-a-turn-1', itemId: 'ask-a-item', autoResolutionMs: null,
        questions: [{ id: 'q', header: 'Q', question: 'Continue A?', isOther: false, isSecret: false, options: null }],
      });
    transport.emitServerRequest('approval-a', 'item/commandExecution/requestApproval', { kind: 'command', startedAtMs: 1,
        threadId: 'thread-a', turnId: 'thread-a-turn-1', itemId: 'command-a',
        command: 'npm test', cwd: '/tmp/project', reason: null, environmentId: null,
        commandActions: [], networkApprovalContext: null, additionalPermissions: null,
        availableDecisions: ['accept', 'decline'], proposedExecpolicyAmendment: null,
      });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(host.getSnapshot()).toMatchObject({ activeConversationId: 'thread-b', approvals: [] });
    expect(host.getSnapshot().clientRequests).toStrictEqual([]);
    expect(host.conversation('thread-a').getSnapshot().clientRequests).toMatchObject([{
      id: 'ask-a', kind: 'ask_user', conversationId: 'thread-a', turnId: 'thread-a-turn-1',
    }]);
    expect(lastResponse(transport, 'ask-a')).toBeUndefined();
    await host.respondToClientRequest({ id: 'ask-a', payload: { answers: { q: { answers: ['yes'] } } } });
    expect(lastResponse(transport, 'ask-a')).toMatchObject({ result: { answers: { q: { answers: ['yes'] } } } });
    expect(host.conversation('thread-a').getSnapshot().clientRequests).toStrictEqual([]);

    const resumeACount = () => transport.sent.filter((message) => (
      'method' in message
      && message.method === 'thread/resume'
      && 'params' in message
      && (message.params as { threadId?: string }).threadId === 'thread-a'
    )).length;
    expect(resumeACount()).toBe(1);
    await host.selectConversation('thread-a');
    expect(resumeACount()).toBe(1);
    expect(host.getSnapshot().messages.flatMap((message) => message.parts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'Background A' }),
      expect.objectContaining({ type: 'tool', id: 'ask-a-item', status: 'running' }),
    ]));
    expect(host.getSnapshot().answeredClientRequestIds).toContain('ask-a');
    expect(host.getSnapshot().approvals).toMatchObject([{ id: 'approval-a', conversationId: 'thread-a' }]);
    await host.resolveApproval('approval-a', 'deny');

    await host.selectConversation('thread-b');
    transport.emitNotification('turn/completed', { threadId: 'thread-a', turn: turn('thread-a-turn-1', 'completed', []) });
    await vi.waitFor(() => expect(
      transport.sent.filter((message) => 'method' in message && message.method === 'turn/start'),
    ).toHaveLength(2));
    expect(lastRequest(transport, 'turn/start')).toMatchObject({
      params: { threadId: 'thread-a', input: [{ type: 'text', text: 'A queued' }] },
    });
    expect(host.getSnapshot()).toMatchObject({ activeConversationId: 'thread-b', busy: false });

    await host.selectConversation('thread-a');
    expect(resumeACount()).toBe(1);
    expect(host.getSnapshot()).toMatchObject({ activeConversationId: 'thread-a', busy: true });
    expect(host.getSnapshot().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', parts: [{ type: 'text', text: 'A queued' }] }),
    ]));
  });

  it('hydrates an uncached background thread before projecting its live status', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null,
        data: [thread('thread-a', false), thread('thread-b', false)],
        nextCursor: null,
      }),
      'thread/resume': (params) => resumeResponse(thread((params as { threadId: string }).threadId, true)),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    transport.emitNotification('thread/status/changed', { threadId: 'thread-b', status: { type: 'active', activeFlags: [] } });

    await host.selectConversation('thread-b');
    expect(transport.sent.filter((message) => (
      'method' in message && message.method === 'thread/resume'
    ))).toHaveLength(2);
    expect(host.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-b',
      messages: [expect.objectContaining({ role: 'user' }), expect.objectContaining({ role: 'assistant' })],
    });
  });

  it('runs independent conversation handles concurrently and delivers background state and approvals', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null,
        data: [thread('thread-a', false), thread('thread-b', false)],
        nextCursor: null,
      }),
      'thread/resume': (params) => {
        const { threadId, cwd } = params as { threadId: string; cwd?: string };
        return { ...resumeResponse({ ...thread(threadId, true), cwd: cwd ?? '/tmp/project' }), cwd: cwd ?? '/tmp/project' };
      },
      'skills/list': (params) => {
        const cwd = (params as { cwds?: string[] }).cwds?.[0] ?? '/global';
        return {
          data: [{
            cwd,
            skills: [{ pluginId: null,
              name: `skill-${cwd}`, description: `Skill for ${cwd}`, path: `${cwd}/SKILL.md`,
              scope: 'repo', enabled: true, interface: undefined,
            }],
            errors: [],
          }],
        };
      },
      'turn/start': (params) => ({
        turn: turn(`turn-${(params as { threadId: string }).threadId}`, 'inProgress', []),
      }),
    });
    const host = new CodexHost({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(transport),
    });
    await host.connect();
    const a = host.conversation('thread-a');
    const b = host.conversation('thread-b');
    const aListener = vi.fn();
    const bListener = vi.fn();
    a.onStateChange(aListener);
    b.onStateChange(bListener);

    await Promise.all([
      a.load({ cwd: '/workspace/a', extensionContext: { agent: 'a' } }),
      b.load({ cwd: '/workspace/b', extensionContext: { agent: 'b' } }),
    ]);
    await Promise.all([a.sendMessage('Run A'), b.sendMessage('Run B')]);
    await Promise.all([host.listSkills({ cwd: '/workspace/a' }), host.listSkills({ cwd: '/workspace/b' })]);

    expect(host.getSnapshot().conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'thread-a', turnCount: 2 }),
      expect.objectContaining({ id: 'thread-b', turnCount: 2 }),
    ]));
    await host.refreshConversations();
    expect(host.getSnapshot().conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'thread-a', turnCount: 2 }),
      expect.objectContaining({ id: 'thread-b', turnCount: 2 }),
    ]));

    expect(host.getSnapshot().activeConversationId).toBeNull();
    expect(a.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-a', activeTurnId: 'turn-thread-a', busy: true,
      skills: [{ name: 'skill-/workspace/a' }],
    });
    expect(b.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-b', activeTurnId: 'turn-thread-b', busy: true,
      skills: [{ name: 'skill-/workspace/b' }],
    });
    expect(lastRequest(transport, 'turn/start')).toMatchObject({ params: { threadId: 'thread-b' } });

    await a.select();
    aListener.mockClear();
    bListener.mockClear();
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-a', turnId: 'turn-thread-a', itemId: 'agent-a', delta: 'Foreground A',
      });
    await vi.waitFor(() => expect(a.getSnapshot().messages.flatMap((message) => message.parts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'Foreground A' }),
    ])));
    expect(aListener).toHaveBeenCalled();
    expect(bListener).not.toHaveBeenCalled();

    aListener.mockClear();
    bListener.mockClear();
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-b', turnId: 'turn-thread-b', itemId: 'agent-b', delta: 'Background B',
      });
    await vi.waitFor(() => expect(bListener).toHaveBeenCalledWith(expect.objectContaining({
      activeConversationId: 'thread-b',
      messages: expect.arrayContaining([
        expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: 'Background B' }),
          ]),
        }),
      ]),
    })));
    bListener.mockClear();
    transport.emitServerRequest('approval-b', 'item/commandExecution/requestApproval', { kind: 'command', startedAtMs: 1,
        threadId: 'thread-b', turnId: 'turn-thread-b', itemId: 'command-b', command: 'npm test',
        cwd: '/workspace/b', reason: null, environmentId: null, commandActions: [],
        networkApprovalContext: null, additionalPermissions: null, availableDecisions: ['accept', 'decline'],
        proposedExecpolicyAmendment: null,
      });
    await vi.waitFor(() => expect(b.getSnapshot().approvals).toMatchObject([{ id: 'approval-b' }]));
    expect(host.getSnapshot()).toMatchObject({ activeConversationId: 'thread-a', approvals: [] });
    expect(b.getSnapshot().messages.flatMap((message) => message.parts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'Background B' }),
    ]));
    expect(bListener).toHaveBeenCalled();
    expect(aListener).not.toHaveBeenCalledWith(expect.objectContaining({ approvals: [expect.anything()] }));
    await expect(a.resolveApproval('approval-b', 'deny')).rejects.toThrow("belongs to conversation 'thread-b'");
    await host.resolveApproval('approval-b', 'deny');
    expect(lastResponse(transport, 'approval-b')).toMatchObject({ result: { decision: 'decline' } });
  });

  it('bridges concurrent conversation mutations and streams without selection cross-talk', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null,
        data: [thread('thread-a', false), thread('thread-b', false)],
        nextCursor: null,
      }),
      'thread/resume': (params) => resumeResponse(thread(
        String((params as { threadId: string }).threadId),
        true,
      )),
      'turn/start': (params) => ({
        turn: turn(`turn-${(params as { threadId: string }).threadId}`, 'inProgress', []),
      }),
    });
    const host = new CodexHost({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(transport),
    });
    await host.connect();
    await Promise.all([
      host.conversation('thread-a').load(),
      host.conversation('thread-b').load(),
    ]);
    const aNotifications: CodexConversationBridgeNotification[] = [];
    const bNotifications: CodexConversationBridgeNotification[] = [];
    const unsubscribeA = subscribeCodexConversationBridge(
      host,
      'thread-a',
      (notification) => aNotifications.push(notification),
    );
    const unsubscribeB = subscribeCodexConversationBridge(
      host,
      'thread-b',
      (notification) => bNotifications.push(notification),
    );

    const [a, b] = await Promise.all([
      invokeCodexConversationBridgeOperation(host, 'thread-a', 'sendMessage', ['Run A']),
      invokeCodexConversationBridgeOperation(host, 'thread-b', 'sendMessage', ['Run B']),
    ]);

    expect(a).toMatchObject({ activeConversationId: 'thread-a', activeTurnId: 'turn-thread-a', busy: true });
    expect(b).toMatchObject({ activeConversationId: 'thread-b', activeTurnId: 'turn-thread-b', busy: true });
    expect(host.getSnapshot().activeConversationId).toBeNull();
    expect(requestsFor(transport, 'turn/start')).toMatchObject([
      { params: { threadId: 'thread-a' } },
      { params: { threadId: 'thread-b' } },
    ]);

    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-a', turnId: 'turn-thread-a', itemId: 'agent-a', delta: 'Stream A',
      });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-b', turnId: 'turn-thread-b', itemId: 'agent-b', delta: 'Stream B',
      });
    await vi.waitFor(() => expect(aNotifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event', conversationId: 'thread-a', event: expect.objectContaining({ type: 'message.delta' }),
      }),
    ])));
    await vi.waitFor(() => expect(bNotifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event', conversationId: 'thread-b', event: expect.objectContaining({ type: 'message.delta' }),
      }),
    ])));
    expect(aNotifications.every((notification) => notification.conversationId === 'thread-a')).toBe(true);
    expect(bNotifications.every((notification) => notification.conversationId === 'thread-b')).toBe(true);
    expect(host.getSnapshot().activeConversationId).toBeNull();

    unsubscribeA();
    unsubscribeB();
  });

  it('applies product-neutral host extensions on start and resume and executes dynamic tools', async () => {
    const configureConversation = vi.fn((context: {
      operation: 'start' | 'resume';
      extensionContext?: unknown;
    }) => ({
      config: { extensionAgent: (context.extensionContext as { agent: string }).agent },
      developerInstructions: `extension-${context.operation}`,
    }));
    const execute = vi.fn(({ extensionContext, arguments: input }) => ({
      success: true,
      content: [{
        type: 'text' as const,
        text: `${(extensionContext as { agent: string }).agent}:${JSON.stringify(input)}`,
      }],
    }));
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [thread('thread-existing', false)], nextCursor: null }),
      'thread/resume': (params) => resumeResponse(thread((params as { threadId: string }).threadId, true)),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
    });
    const host = new CodexHost({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(transport),
      extensions: [{
        configureConversation,
        dynamicTools: [{
          name: 'lookup_ticket',
          description: 'Look up one product ticket',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
          execute,
        }],
      }],
    });
    await host.connect();
    await host.createConversation({
      cwd: '/workspace/a', config: { explicit: true }, developerInstructions: 'host-start',
    }, { extensionContext: { agent: 'a' } });
    expect(lastRequest(transport, 'thread/start')).toMatchObject({
      params: {
        cwd: '/workspace/a',
        config: { extensionAgent: 'a', explicit: true },
        developerInstructions: 'extension-start\n\nhost-start',
        dynamicTools: [{
          type: 'function', name: 'lookup_ticket', description: 'Look up one product ticket',
        }],
      },
    });

    await host.conversation('thread-existing').load({
      cwd: '/workspace/b', extensionContext: { agent: 'b' },
    });
    expect(lastRequest(transport, 'thread/resume')).toMatchObject({
      params: {
        threadId: 'thread-existing', cwd: '/workspace/b',
        config: { extensionAgent: 'b' }, developerInstructions: 'extension-resume',
      },
    });

    transport.emitServerRequest('dynamic-b', 'item/tool/call', {
        threadId: 'thread-existing', turnId: 'turn-b', callId: 'call-b', namespace: null,
        tool: 'lookup_ticket', arguments: { id: 'SDK-42' },
      });
    await vi.waitFor(() => expect(lastResponse(transport, 'dynamic-b')).toMatchObject({
      result: { success: true, contentItems: [{ type: 'inputText', text: 'b:{"id":"SDK-42"}' }] },
    }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'thread-existing', extensionContext: { agent: 'b' },
    }));
    expect(configureConversation).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'resume', conversationId: 'thread-existing', cwd: '/workspace/b',
    }));
  });

  it('applies typed main-process MCP servers on conversation start and resume', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [thread('thread-existing', false)], nextCursor: null }),
      'thread/resume': (params) => resumeResponse(thread((params as { threadId: string }).threadId, true)),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
    });
    const host = new CodexHost({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(transport),
      mcpServers: [{
        name: 'relay',
        transport: { type: 'http', url: 'http://127.0.0.1:8767/mcp' },
        toolApprovalMode: 'approve',
        required: true,
        enabledTools: ['get_shipments', 'update_shipment'],
        startupTimeoutMs: 12_500,
        toolTimeoutMs: 30_000,
      }],
    });
    await host.connect();

    await host.createConversation();
    expect(lastRequest(transport, 'thread/start')).toMatchObject({
      params: {
        config: {
          'mcp_servers.relay': {
            url: 'http://127.0.0.1:8767/mcp',
            default_tools_approval_mode: 'approve',
            required: true,
            enabled_tools: ['get_shipments', 'update_shipment'],
            startup_timeout_sec: 12.5,
            tool_timeout_sec: 30,
          },
        },
      },
    });

    await host.conversation('thread-existing').load();
    expect(lastRequest(transport, 'thread/resume')).toMatchObject({
      params: {
        threadId: 'thread-existing',
        config: {
          'mcp_servers.relay': expect.objectContaining({ url: 'http://127.0.0.1:8767/mcp' }),
        },
      },
    });
    expect(JSON.stringify(host.getSnapshot())).not.toContain('127.0.0.1:8767');
  });

  it('supports stdio MCP definitions and per-conversation replacement or disabling', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [thread('thread-existing', false)], nextCursor: null }),
      'thread/resume': (params) => resumeResponse(thread((params as { threadId: string }).threadId, true)),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
    });
    const host = new CodexHost({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(transport),
      mcpServers: [{ name: 'default_server', transport: { type: 'http', url: 'http://127.0.0.1:9000/mcp' } }],
    });
    await host.connect();

    await host.createConversation({}, {
      mcpServers: [{
        name: 'shipment_worker',
        transport: {
          type: 'stdio',
          command: '/usr/bin/node',
          args: ['/opt/relay/mcp.mjs'],
          cwd: '/opt/relay',
          env: { RELAY_MODE: 'test' },
          envVars: ['RELAY_TOKEN'],
        },
        toolApprovalMode: 'prompt',
      }],
    });
    expect(lastRequest(transport, 'thread/start')).toMatchObject({
      params: {
        config: {
          'mcp_servers.shipment_worker': {
            command: '/usr/bin/node',
            args: ['/opt/relay/mcp.mjs'],
            cwd: '/opt/relay',
            env: { RELAY_MODE: 'test' },
            env_vars: ['RELAY_TOKEN'],
            default_tools_approval_mode: 'prompt',
          },
        },
      },
    });
    expect(lastRequest(transport, 'thread/start')).not.toMatchObject({
      params: { config: { 'mcp_servers.default_server': expect.anything() } },
    });

    await host.conversation('thread-existing').load({ mcpServers: [] });
    expect(lastRequest(transport, 'thread/resume')).toMatchObject({ params: { threadId: 'thread-existing' } });
    expect(lastRequest(transport, 'thread/resume')).not.toHaveProperty('params.config');
  });

  it('validates typed MCP definitions and raw-config collisions', async () => {
    const client = () => new CodexAppServerClient(new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [], nextCursor: null }),
    }));
    expect(() => new CodexHost({
      client: client(),
      mcpServers: [{ name: 'bad.name', transport: { type: 'http', url: 'http://127.0.0.1/mcp' } }],
    })).toThrow('name must match');
    expect(() => new CodexHost({
      client: client(),
      mcpServers: [
        { name: 'duplicate', transport: { type: 'http', url: 'http://127.0.0.1/a' } },
        { name: 'duplicate', transport: { type: 'http', url: 'http://127.0.0.1/b' } },
      ],
    })).toThrow("Duplicate Codex MCP server 'duplicate'");
    expect(() => new CodexHost({
      client: client(),
      mcpServers: [{ name: 'invalid_url', transport: { type: 'http', url: 'file:///tmp/mcp' } }],
    })).toThrow('URL must use HTTP or HTTPS');
    expect(() => new CodexHost({
      client: client(),
      mcpServers: [{
        name: 'invalid_cwd', transport: { type: 'stdio', command: 'node', cwd: 'relative' },
      }],
    })).toThrow('cwd must be an absolute path');
    expect(() => new CodexHost({
      client: client(),
      mcpServers: [{
        name: 'invalid_timeout', transport: { type: 'stdio', command: 'node' }, startupTimeoutMs: 0,
      }],
    })).toThrow('startup timeout must be a positive finite number');

    const host = new CodexHost({
      autoSelectFirstConversation: false,
      client: client(),
      mcpServers: [{ name: 'relay', transport: { type: 'http', url: 'http://127.0.0.1/mcp' } }],
    });
    await host.connect();
    await expect(host.createConversation({
      config: { 'mcp_servers.relay.url': 'http://127.0.0.1:9999/mcp' },
    })).rejects.toThrow("conflicts with its typed definition");
  });

});
