import { describe, expect, it, vi } from 'vitest';
import { createCodexConversationReplica } from '../../src/core/index';
import type { CodexHostEvent } from '../../src/index';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk';
import { CodexHost } from '../../src/providers/codex';
import {
  MockCodexAppServer,
  createHost,
  lastRequest,
  lastResponse,
  resumeResponse,
  testGoal,
  thread,
  turn,
} from './helpers/host-fixture';

describe('CodexHost', () => {
  it('routes item-only turn activity through the host runtime and summary', async () => {
    const { host, transport } = createHost();
    const events: CodexHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    events.length = 0;

    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing', turnId: 'turn-item-only', itemId: 'agent-item-only',
        delta: 'Recovered from item event',
      });

    expect(host.getSnapshot()).toMatchObject({
      busy: true,
      messages: [
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          id: 'assistant-turn-item-only',
          parts: [expect.objectContaining({ type: 'text', text: 'Recovered from item event' })],
        }),
      ],
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'message.delta',
      origin: 'notification',
      conversationId: 'thread-existing',
      turnId: 'turn-item-only',
      payload: {
        messageId: 'assistant-turn-item-only', itemId: 'agent-item-only', delta: 'Recovered from item event',
      },
    }));

    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-item-only', 'completed', []) });

    expect(host.getSnapshot()).toMatchObject({
      busy: false,
      conversations: [expect.objectContaining({ id: 'thread-existing', status: 'idle', turnCount: 2 })],
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.summaryUpserted',
      origin: 'notification',
      payload: expect.objectContaining({
        summary: expect.objectContaining({ id: 'thread-existing', status: 'idle', turnCount: 2 }),
        reason: 'updated',
      }),
    }));
    await host.close();
  });

  it('publishes activity when a started turn completes', async () => {
    const { host, transport } = createHost();
    const events: CodexHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    events.length = 0;

    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-activity', 'inProgress', []) });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.activityChanged',
      origin: 'notification',
      conversationId: 'thread-existing',
      payload: expect.objectContaining({ busy: true }),
    }));
    events.length = 0;

    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-activity', 'completed', []) });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.activityChanged',
      origin: 'notification',
      conversationId: 'thread-existing',
      payload: expect.objectContaining({ busy: false }),
    }));
    await host.close();
  });

  it('projects approval-only activity and clears busy state only without an active turn', async () => {
    const { host, transport } = createHost();
    const events: CodexHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    events.length = 0;

    transport.emitServerRequest('legacy-approval-only', 'execCommandApproval', {
        conversationId: 'thread-existing', callId: 'legacy-item', approvalId: null,
        command: ['npm', 'test'], cwd: '/tmp/project', reason: null, parsedCmd: [],
      });
    await vi.waitFor(() => expect(host.getSnapshot()).toMatchObject({
      busy: true,
      approvals: [expect.objectContaining({ id: 'legacy-approval-only' })],
      conversations: [expect.objectContaining({ id: 'thread-existing', status: 'active' })],
    }));
    transport.emitNotification('serverRequest/resolved', { threadId: 'thread-existing', requestId: 'legacy-approval-only' });
    expect(host.getSnapshot()).toMatchObject({ busy: false, approvals: [] });

    transport.emitServerRequest('turn-approval-only', 'item/commandExecution/requestApproval', { kind: 'command', startedAtMs: 1,
        threadId: 'thread-existing', turnId: 'turn-from-approval', itemId: 'command-from-approval',
        command: 'npm test', cwd: '/tmp/project', reason: null, environmentId: null,
        commandActions: [], networkApprovalContext: null, additionalPermissions: null,
        availableDecisions: ['accept', 'decline'], proposedExecpolicyAmendment: null,
      });
    await vi.waitFor(() => expect(host.getSnapshot().approvals).toHaveLength(1));
    transport.emitNotification('serverRequest/resolved', { threadId: 'thread-existing', requestId: 'turn-approval-only' });

    expect(host.getSnapshot()).toMatchObject({ busy: true, approvals: [] });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'approval.requested', origin: 'notification', conversationId: 'thread-existing',
      }),
      expect.objectContaining({
        type: 'approval.resolved', origin: 'notification', conversationId: 'thread-existing',
        payload: expect.objectContaining({ reason: 'server' }),
      }),
    ]));
    await host.close();
  });

  it('keeps approval-only work busy while resolving a turnless MCP confirmation', async () => {
    const { host, transport } = createHost();
    const events: CodexHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    events.length = 0;
    transport.emitServerRequest('legacy-pending', 'execCommandApproval', {
        conversationId: 'thread-existing', callId: 'legacy-pending-item', approvalId: null,
        command: ['npm', 'test'], cwd: '/tmp/project', reason: null, parsedCmd: [],
      });
    await vi.waitFor(() => expect(host.getSnapshot().approvals).toHaveLength(1));

    transport.emitServerRequest('mcp-turnless', 'mcpServer/elicitation/request', {
        threadId: 'thread-existing', turnId: null, serverName: 'calendar', mode: 'form',
        message: 'Allow calendar lookup?', requestedSchema: { type: 'object', properties: {} },
        _meta: {
          codex_approval_kind: 'mcp_tool_call', tool_name: 'lookup', persist: null, tool_params: {},
        },
      });
    await vi.waitFor(() => expect(host.getSnapshot().clientRequests).toHaveLength(1));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.started',
      origin: 'notification',
      conversationId: 'thread-existing',
      turnId: 'client-request-mcp-turnless',
      payload: expect.objectContaining({ messageId: 'assistant-client-request-mcp-turnless' }),
    }));

    await host.respondToClientRequest({ id: 'mcp-turnless', payload: { decision: 'deny' } });
    expect(host.getSnapshot()).toMatchObject({
      busy: true,
      approvals: [expect.objectContaining({ id: 'legacy-pending' })],
      clientRequests: [],
    });
    await host.resolveApproval('legacy-pending', 'deny');
    expect(host.getSnapshot()).toMatchObject({ busy: false, approvals: [] });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.activityChanged',
      origin: 'action',
      conversationId: 'thread-existing',
      payload: expect.objectContaining({ busy: false }),
    }));

    transport.emitServerRequest('question-active-turn', 'item/tool/requestUserInput', { isBlocking: false,
        threadId: 'thread-existing', turnId: 'turn-question', itemId: 'question-item', autoResolutionMs: null,
        questions: [{
          id: 'answer', header: 'Answer', question: 'Continue?', isOther: false, isSecret: false,
          options: null,
        }],
      });
    await vi.waitFor(() => expect(host.getSnapshot().clientRequests).toHaveLength(1));
    transport.emitNotification('serverRequest/resolved', { threadId: 'thread-existing', requestId: 'question-active-turn' });
    expect(host.getSnapshot()).toMatchObject({ busy: true, clientRequests: [] });
    await host.close();
  });

  it('publishes activity when a turnless client request becomes idle', async () => {
    const { host, transport } = createHost();
    const events: CodexHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    events.length = 0;

    transport.emitServerRequest('mcp-turnless-only', 'mcpServer/elicitation/request', {
        threadId: 'thread-existing', turnId: null, serverName: 'calendar', mode: 'form',
        message: 'Allow calendar lookup?', requestedSchema: { type: 'object', properties: {} },
        _meta: {
          codex_approval_kind: 'mcp_tool_call', tool_name: 'lookup', persist: null, tool_params: {},
        },
      });
    await vi.waitFor(() => expect(host.getSnapshot()).toMatchObject({
      busy: true,
      clientRequests: [expect.objectContaining({ id: 'mcp-turnless-only' })],
    }));

    await host.respondToClientRequest({ id: 'mcp-turnless-only', payload: { decision: 'deny' } });

    expect(host.getSnapshot()).toMatchObject({ busy: false, clientRequests: [] });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.activityChanged',
      origin: 'action',
      conversationId: 'thread-existing',
      payload: expect.objectContaining({ busy: false }),
    }));
    await host.close();
  });

  it('renders app-server plans and raw response tools instead of dropping them', async () => {
    const { host, transport } = createHost();
    await host.connect();
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-plan', 'inProgress', []) });
    transport.emitNotification('item/plan/delta', { threadId: 'thread-existing', turnId: 'turn-plan', itemId: 'plan-item', delta: '# Plan\n' });
    transport.emitNotification('turn/plan/updated', {
        threadId: 'thread-existing', turnId: 'turn-plan', explanation: 'Implementation',
        plan: [{ step: 'Copy the component', status: 'completed' }, { step: 'Wire events', status: 'inProgress' }],
      });
    transport.emitNotification('rawResponseItem/completed', {
        threadId: 'thread-existing', turnId: 'turn-plan',
        item: {
          type: 'local_shell_call', call_id: 'raw-shell', status: 'completed',
          action: {
            type: 'exec', command: ['npm', 'test'], working_directory: '/tmp/project',
            timeout_ms: null, env: null, user: null,
          },
        },
      });

    const tools = host.getSnapshot().messages.flatMap((message) => (
      message.parts.filter((part) => part.type === 'tool')
    ));
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'plan-progress-turn-plan', title: 'plan', status: 'completed' }),
      expect.objectContaining({ id: 'raw-shell', kind: 'command', title: 'npm test', status: 'completed' }),
    ]));
  });

  it('surfaces app-server user questions and MCP confirmations and sends their answers back', async () => {
    const { host, transport } = createHost();
    await host.connect();
    transport.emitServerRequest('ask-1', 'item/tool/requestUserInput', {
      threadId: 'thread-existing', turnId: 'turn-input', itemId: 'ask-user-item', autoResolutionMs: null,
      isBlocking: false,
      questions: [{
        id: 'target', header: 'Target', question: 'Which file?', isOther: true, isSecret: false,
        options: [{ label: 'README.md', description: 'Read the README.' }],
      }],
    });
    await vi.waitFor(() => expect(host.getSnapshot().messages.some((message) => (
      message.parts.some((part) => part.type === 'tool' && part.id === 'ask-user-item')
    ))).toBe(true));
    expect(host.getSnapshot().messages.flatMap((message) => message.parts)).toContainEqual(expect.objectContaining({
      id: 'ask-user-item', title: 'ask_user_question', status: 'running',
      statusText: expect.stringContaining('"requestId":"ask-1"'),
    }));
    expect(host.getSnapshot().clientRequests).toStrictEqual([{
      id: 'ask-1',
      kind: 'ask_user',
      conversationId: 'thread-existing',
      turnId: 'turn-input',
      itemId: 'ask-user-item',
      payload: {
        request: {
          itemId: 'ask-user-item',
          delivery: 'tool',
          blocking: false,
          questions: [{
            id: 'target', header: 'Target', question: 'Which file?', isOther: true, isSecret: false,
            options: [{ label: 'README.md', description: 'Read the README.' }],
          }],
        },
      },
    }]);
    await host.respondToClientRequest({
      id: 'ask-1', payload: { answers: { target: { answers: ['README.md'] } } },
    });
    expect(lastResponse(transport, 'ask-1')).toMatchObject({
      result: { answers: { target: { answers: ['README.md'] } } },
    });
    expect(host.getSnapshot().clientRequests).toStrictEqual([]);

    transport.emitServerRequest('mcp-1', 'mcpServer/elicitation/request', {
        threadId: 'thread-existing', turnId: 'turn-input', serverName: 'calendar', mode: 'form',
        message: 'Allow calendar.create_event?', requestedSchema: { type: 'object', properties: {} },
        _meta: {
          codex_approval_kind: 'mcp_tool_call', tool_name: 'create_event', persist: ['session', 'always'],
          connector_name: 'Team Calendar',
          tool_params: { title: 'Planning' },
        },
      });
    await vi.waitFor(() => expect(host.getSnapshot().messages.some((message) => (
      message.parts.some((part) => part.type === 'tool' && part.id === 'approval-mcp-1')
    ))).toBe(true));
    expect(host.getSnapshot().clientRequests).toStrictEqual([{
      id: 'mcp-1',
      kind: 'confirm_tool',
      conversationId: 'thread-existing',
      turnId: 'turn-input',
      itemId: 'approval-mcp-1',
      payload: {
        confirmation: {
          argumentsPreview: '{\n  "title": "Planning"\n}',
          integrationId: 'calendar',
          integrationName: 'Team Calendar',
          summary: 'Allow calendar.create_event?',
          toolName: 'create_event',
          allowConversation: true,
          allowAlways: true,
        },
      },
    }]);
    await host.respondToClientRequest({ id: 'mcp-1', payload: { decision: 'allow_conversation' } });
    expect(lastResponse(transport, 'mcp-1')).toMatchObject({
      result: { action: 'accept', content: null, _meta: { persist: 'session' } },
    });
  });

  it('executes built-in slash commands and drains queued prompts after a turn', async () => {
    const goal = testGoal({ objective: 'Ship it' });
    const transport = new MockCodexAppServer({
      'thread/goal/set': () => ({ goal }),
      'thread/compact/start': () => ({}),
      'thread/settings/update': () => ({}),
      'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport), cwd: '/tmp/project' });
    const events: CodexHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    events.length = 0;
    await host.sendMessage('/compact');
    expect(lastRequest(transport, 'thread/compact/start')).toMatchObject({ params: { threadId: 'thread-existing' } });
    await host.sendMessage('/plan');
    expect(lastRequest(transport, 'thread/settings/update')).toMatchObject({ params: { collaborationMode: { mode: 'plan' } } });
    await host.sendMessage('/goal Ship it');
    expect(host.getSnapshot().goal).toMatchObject({ objective: 'Ship it' });

    await host.sendMessage('First');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.activityChanged',
      origin: 'action',
      conversationId: 'thread-existing',
      payload: expect.objectContaining({ busy: true }),
    }));
    await host.sendMessage('Second');
    expect(host.getSnapshot().queuedPrompts).toMatchObject([{ text: 'Second' }]);
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-live', 'completed', []) });
    await vi.waitFor(() => expect(
      transport.sent.filter((message) => 'method' in message && message.method === 'turn/start'),
    ).toHaveLength(2));
    expect(host.getSnapshot()).toMatchObject({ busy: true, queuedPrompts: [] });
  });

  it('shows one compaction marker when the provider item arrives after the compact action resolves', async () => {
    const transport = new MockCodexAppServer({ 'thread/compact/start': () => ({}) });
    const host = new CodexHost({ client: new CodexAppServerClient(transport), cwd: '/tmp/project' });
    await host.connect();
    const replica = createCodexConversationReplica(host.conversation('thread-existing').getSnapshot());
    host.onEvent((event) => {
      if ('conversationId' in event && event.conversationId === 'thread-existing') replica.apply(event);
    });

    await host.sendMessage('/compact');
    transport.emitNotification('item/started', {
        threadId: 'thread-existing',
        turnId: 'turn-compaction',
        startedAtMs: 1,
        item: { type: 'contextCompaction', id: 'compact-1' },
      });

    expect(replica.getSnapshot().messages.filter((message) => message.kind === 'compaction')).toHaveLength(1);
  });

  it('exposes skills, goals, context usage, diffs, and revert-backed turn deletion', async () => {
    const transport = new MockCodexAppServer({
      'skills/list': () => ({
        data: [{
          cwd: '/tmp/project', errors: [], skills: [{ pluginId: null,
            name: 'reviewer', description: 'Review code', path: '/tmp/reviewer/SKILL.md',
            scope: 'repo', enabled: true, interface: { iconSmallUrl: null, iconLargeUrl: null, displayName: 'Reviewer' },
          }],
        }],
      }),
      'thread/revert': () => ({ thread: thread('thread-existing', false), turnsBackwardsCursor: null, itemsBackwardsCursor: null }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport), cwd: '/tmp/project' });
    await host.connect();
    const replica = createCodexConversationReplica(host.conversation('thread-existing').getSnapshot());
    host.onEvent((event) => {
      if ('conversationId' in event && event.conversationId === 'thread-existing') replica.apply(event);
    });
    await host.listSkills({ cwd: '/tmp/project' });
    expect(host.getSnapshot().skills).toMatchObject([{ name: 'reviewer', displayName: 'Reviewer' }]);
    transport.emitNotification('thread/tokenUsage/updated', {
        threadId: 'thread-existing', turnId: 'turn-history',
        tokenUsage: {
          total: { cacheWriteInputTokens: 0, totalTokens: 200, inputTokens: 120, cachedInputTokens: 20, outputTokens: 80, reasoningOutputTokens: 30 },
          last: { cacheWriteInputTokens: 0, totalTokens: 100, inputTokens: 60, cachedInputTokens: 10, outputTokens: 40, reasoningOutputTokens: 15 },
          modelContextWindow: 1000,
        },
      });
    transport.emitNotification('turn/diff/updated', { threadId: 'thread-existing', turnId: 'turn-history', diff: '@@ -1 +1,2 @@\n-old\n+new\n+line' });
    transport.emitNotification('thread/goal/updated', {
        threadId: 'thread-existing', turnId: null,
        goal: {
          threadId: 'thread-existing', objective: 'Finish', status: 'active', tokenBudget: 1000,
          tokensUsed: 200, timeUsedSeconds: 10, createdAt: 1, updatedAt: 2,
        },
      });
    expect(host.getSnapshot()).toMatchObject({
      contextUsage: { totalTokens: 200, lastTotalTokens: 100, usedPercent: 10 },
      goal: { objective: 'Finish', tokenBudget: 1000 },
      turnGitDiff: { addedLines: 2, removedLines: 1 },
    });
    await host.conversation('thread-existing').deleteTurn('turn-history');
    expect(lastRequest(transport, 'thread/revert')).toMatchObject({
      params: { threadId: 'thread-existing', beforeTurnId: 'turn-history' },
    });
    expect(host.getSnapshot().messages).toStrictEqual([]);
    expect(replica.getSnapshot()).toMatchObject({ messages: [], turnIds: [], turns: [] });
  });

  it('rejects legacy-history mutations without changing or submitting conversation content', async () => {
    const legacy = { ...thread('thread-existing', true), historyMode: 'legacy' as const };
    const transport = new MockCodexAppServer({
      'thread/resume': () => resumeResponse(legacy),
      'turn/start': () => ({ turn: turn('turn-continued', 'inProgress', []) }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    try {
      await host.connect();
      const conversation = host.conversation('thread-existing');
      await vi.waitFor(() => expect(host.getSnapshot().pluginCatalogStatus).toBe('loaded'));
      const before = conversation.getSnapshot();
      const requestCount = transport.sent.length;
      for (const action of [
        () => conversation.deleteTurn('turn-history'),
        () => conversation.editTurn('turn-history', 'Replacement'),
        () => conversation.retryTurn('turn-history'),
      ]) {
        await expect(action()).rejects.toThrow('Legacy conversation history does not support deleting, editing, or retrying turns');
        expect(conversation.getSnapshot()).toStrictEqual(before);
        expect(transport.sent).toHaveLength(requestCount);
      }
      await conversation.sendMessage('Continue this conversation');
      expect(lastRequest(transport, 'turn/start')).toMatchObject({
        params: { threadId: legacy.id, input: [{ type: 'text', text: 'Continue this conversation' }] },
      });
      expect(conversation.getSnapshot().turnIds).toStrictEqual(['turn-history', 'turn-continued']);
      expect(conversation.getSnapshot().messages.slice(0, before.messages.length)).toStrictEqual(before.messages);
    } finally {
      await host.close();
    }
  });

  it('uses thread/revert to delete from paginated history without hydrating the full thread', async () => {
    const firstTurn = turn('turn-first', 'completed', [
      { type: 'userMessage', id: 'user-first', clientId: null, content: [{ type: 'text', text: 'First', text_elements: [] }] },
      { type: 'agentMessage', id: 'agent-first', text: 'First answer', phase: null, memoryCitation: null, delivery: null, questions: null },
    ]);
    const secondTurn = turn('turn-second', 'completed', [
      { type: 'userMessage', id: 'user-second', clientId: null, content: [{ type: 'text', text: 'Second', text_elements: [] }] },
      { type: 'agentMessage', id: 'agent-second', text: 'Second answer', phase: null, memoryCitation: null, delivery: null, questions: null },
    ]);
    const paginatedThread: v2.Thread = {
      ...thread('thread-existing', false),
      historyMode: 'paginated',
      turns: [firstTurn, secondTurn],
    };
    const transport = new MockCodexAppServer({
      'thread/resume': () => resumeResponse(paginatedThread),
      'thread/revert': () => ({
        thread: { ...paginatedThread, turns: [] },
        turnsBackwardsCursor: 'retained-tail',
        itemsBackwardsCursor: 'retained-item-tail',
      }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport), cwd: '/tmp/project' });
    await host.connect();

    await host.deleteTurn('turn-second');

    expect(lastRequest(transport, 'thread/revert')).toMatchObject({
      params: { threadId: 'thread-existing', beforeTurnId: 'turn-second' },
    });
    expect(lastRequest(transport, 'thread/turns/list')).toBeUndefined();
    expect(host.conversation('thread-existing').getSnapshot()).toMatchObject({
      turnIds: ['turn-first'],
      historyState: { hasOlder: true, fullyLoaded: false },
    });
    expect(host.getSnapshot().messages.every((message) => message.turnId === 'turn-first')).toBe(true);
  });

  it('waits beyond the ordinary request timeout for a paginated revert before reconciling its retained tail', async () => {
    vi.useFakeTimers();
    const firstTurn = turn('turn-first', 'completed', [
      { type: 'userMessage', id: 'user-first', clientId: null, content: [{ type: 'text', text: 'First', text_elements: [] }] },
    ]);
    const secondTurn = turn('turn-second', 'completed', [
      { type: 'userMessage', id: 'user-second', clientId: null, content: [{ type: 'text', text: 'Second', text_elements: [] }] },
    ]);
    const paginatedThread: v2.Thread = {
      ...thread('thread-existing', false),
      historyMode: 'paginated',
      turns: [firstTurn, secondTurn],
    };
    let resolveRevert!: (value: v2.ThreadRevertResponse) => void;
    const revertResponse = new Promise<v2.ThreadRevertResponse>((resolve) => {
      resolveRevert = resolve;
    });
    const transport = new MockCodexAppServer({
      'thread/resume': () => resumeResponse(paginatedThread),
      'thread/revert': () => revertResponse,
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport), cwd: '/tmp/project' });

    try {
      await host.connect();
      const conversation = host.conversation('thread-existing');
      const deletion = conversation.deleteTurn('turn-second');
      const completion = expect(deletion).resolves.toMatchObject({ turnIds: ['turn-first'] });

      await vi.advanceTimersByTimeAsync(15_001);
      expect(conversation.getSnapshot().turnIds).toStrictEqual(['turn-first', 'turn-second']);

      resolveRevert({
        thread: { ...paginatedThread, turns: [] },
        turnsBackwardsCursor: 'retained-tail',
        itemsBackwardsCursor: 'retained-item-tail',
      });
      await completion;
      expect(conversation.getSnapshot()).toMatchObject({
        turnIds: ['turn-first'],
        historyState: { hasOlder: true, fullyLoaded: false },
      });
    } finally {
      vi.useRealTimers();
      await host.close();
    }
  });

  it('uses app-server cwd defaults and reports unavailable conversation operations precisely', async () => {
    const goal = testGoal({ threadId: 'thread-new', objective: 'Ship' });
    const transport = new MockCodexAppServer({
      'skills/list': () => { throw new Error('skills unavailable'); },
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [], nextCursor: null }),
      'thread/goal/set': () => ({ goal }),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
      'thread/goal/clear': () => ({ cleared: true }),
      'thread/compact/start': () => ({}),
      'review/start': () => ({ turn: turn('review-complete', 'completed', []), reviewThreadId: 'thread-new' }),
    });
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      conversationLimit: 0,
    });
    await host.connect();
    expect(host.getSnapshot()).toMatchObject({
      activeConversationId: null,
      skillCatalogStatus: 'notLoaded',
      skills: [],
    });
    expect(lastRequest(transport, 'thread/list')).toBeUndefined();
    expect(lastRequest(transport, 'skills/list')).toBeUndefined();
    await expect(host.listSkills()).rejects.toThrow();
    expect(lastRequest(transport, 'permissionProfile/list')).toMatchObject({ params: { cursor: null } });
    await expect(host.clearGoal()).resolves.toMatchObject({ activeConversationId: null });
    await expect(host.sendMessage('/goal')).resolves.toMatchObject({ activeConversationId: null });
    await expect(host.sendMessage('/goal edit')).resolves.toMatchObject({ activeConversationId: null });
    await expect(host.sendMessage('/goal clear')).resolves.toMatchObject({ activeConversationId: null });
    await expect(host.sendMessage('/compact')).resolves.toMatchObject({ activeConversationId: null });
    await expect(host.sendMessage('/goal pause')).rejects.toThrow('not supported');
    expect(lastRequest(transport, 'thread/start')).toBeUndefined();
    expect(lastRequest(transport, 'thread/goal/clear')).toBeUndefined();
    expect(lastRequest(transport, 'thread/compact/start')).toBeUndefined();

    await host.setGoal('Ship');
    expect(lastRequest(transport, 'thread/start')).not.toMatchObject({ params: { cwd: expect.anything() } });
    expect(lastRequest(transport, 'thread/goal/set')).toMatchObject({
      params: { threadId: 'thread-new', objective: 'Ship', status: 'active' },
    });
    await expect(host.setGoal('   ')).rejects.toThrow('cannot be empty');
    const activeConversation = host.conversation('thread-new');
    await activeConversation.setGoal(' Ship ', null);
    expect(lastRequest(transport, 'thread/goal/set')).toMatchObject({
      params: { threadId: 'thread-new', objective: 'Ship', status: 'active', tokenBudget: null },
    });
    await activeConversation.clearGoal();
    expect(lastRequest(transport, 'thread/goal/clear')).toMatchObject({ params: { threadId: 'thread-new' } });
    await host.compactConversation();
    await activeConversation.compact();
    expect(transport.sent.filter((message) => (
      'method' in message && message.method === 'thread/compact/start'
    ))).toHaveLength(2);
    await host.sendMessage('/review');
    expect(host.getSnapshot().busy).toBe(false);
  });

  it('creates zero-config conversations only for slash commands that need a thread', async () => {
    const goal = testGoal({ threadId: 'thread-new', objective: 'Ship it' });
    const goalTransport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [], nextCursor: null }),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
      'thread/goal/set': () => ({ goal }),
    });
    const goalHost = new CodexHost({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(goalTransport),
      conversationDefaults: { model: 'gpt-5', reasoningEffort: 'medium' },
    });
    await goalHost.connect();
    await goalHost.sendMessage('/goal Ship it');
    expect(lastRequest(goalTransport, 'thread/start')).toMatchObject({ params: { model: 'gpt-5' } });
    expect(lastRequest(goalTransport, 'thread/goal/set')).toMatchObject({
      params: { threadId: 'thread-new', objective: 'Ship it' },
    });
    expect(lastRequest(goalTransport, 'turn/start')).toBeUndefined();

    const reviewTransport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [], nextCursor: null }),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
      'review/start': () => ({
        turn: turn('review-turn', 'inProgress', [{
          type: 'userMessage', id: 'review-turn', clientId: null,
          content: [{ type: 'text', text: 'current changes', text_elements: [] }],
        }]),
        reviewThreadId: 'thread-new',
      }),
    });
    const reviewHost = new CodexHost({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(reviewTransport),
      conversationDefaults: { model: 'gpt-5', reasoningEffort: 'medium' },
    });
    await reviewHost.connect();
    const reviewEvents: unknown[] = [];
    reviewHost.onEvent((event) => reviewEvents.push(event));
    await reviewHost.sendMessage('/review');
    expect(lastRequest(reviewTransport, 'thread/start')).toMatchObject({ params: { model: 'gpt-5' } });
    expect(lastRequest(reviewTransport, 'review/start')).toMatchObject({
      params: {
        threadId: 'thread-new', delivery: 'inline',
        target: { type: 'uncommittedChanges' },
      },
    });
    expect(lastRequest(reviewTransport, 'turn/start')).toBeUndefined();
    expect(reviewHost.getSnapshot().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'user',
        parts: [{
          type: 'text',
          text: 'Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.',
        }],
        metadata: expect.objectContaining({ reviewPrompt: true }),
      }),
    ]));
    expect(reviewEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message.appended', origin: 'action',
        payload: expect.objectContaining({
          message: expect.objectContaining({
            parts: [{
              type: 'text',
              text: 'Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.',
            }],
          }),
        }),
      }),
    ]));
  });

  it('inherits zero-thread UI selections when the first normal prompt creates a conversation', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [], nextCursor: null }),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
      'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
    });
    const host = new CodexHost({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(transport),
    });
    await host.connect();
    await host.updateConversationSettings({
      approvalPreset: 'full-access',
      modelId: 'gpt-mini',
      reasoningEffort: 'high',
      planMode: true,
    });

    await host.sendMessage('Build the app');

    expect(lastRequest(transport, 'thread/start')).toMatchObject({
      params: {
        approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access',
        model: 'gpt-mini-runtime',
      },
    });
    expect(lastRequest(transport, 'thread/settings/update')).toMatchObject({
      params: {
        threadId: 'thread-new', effort: 'high',
        collaborationMode: {
          mode: 'plan',
          settings: { model: 'gpt-mini-runtime', reasoning_effort: 'high' },
        },
      },
    });
    expect(lastRequest(transport, 'turn/start')).toMatchObject({
      params: {
        threadId: 'thread-new', model: 'gpt-mini-runtime', effort: 'high',
        collaborationMode: {
          mode: 'plan',
          settings: { model: 'gpt-mini-runtime', reasoning_effort: 'high' },
        },
      },
    });
    expect(host.getSnapshot()).toMatchObject({
      approvalPreset: 'full-access', selectedModelId: 'gpt-mini', selectedReasoningEffort: 'high', planMode: true,
    });
    await host.conversation('thread-new').updateSettings({ planMode: false });
    expect(lastRequest(transport, 'thread/settings/update')).toMatchObject({
      params: { threadId: 'thread-new', collaborationMode: { mode: 'default' } },
    });
  });

  it('uses an explicitly switched model default instead of inheriting incompatible reasoning', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [], nextCursor: null }),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
    });
    const host = new CodexHost({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(transport),
    });
    await host.connect();
    await host.updateConversationSettings({ modelId: 'gpt-mini', reasoningEffort: 'high' });

    await expect(host.createConversation({ model: 'gpt-5' })).resolves.toMatchObject({
      selectedModelId: 'gpt-5', selectedReasoningEffort: 'medium',
    });
    expect(lastRequest(transport, 'thread/settings/update')).toMatchObject({
      params: {
        threadId: 'thread-new', effort: 'medium',
        collaborationMode: { settings: { model: 'gpt-5', reasoning_effort: 'medium' } },
      },
    });
  });

  it('backs edit, retry, delete, and queued prompt actions with real host operations', async () => {
    const edited = createHost('thread/revert', 'turn/start');
    await edited.host.connect();
    const editedReplica = createCodexConversationReplica(
      edited.host.conversation('thread-existing').getSnapshot(),
    );
    edited.host.onEvent((event) => {
      if ('conversationId' in event && event.conversationId === 'thread-existing') editedReplica.apply(event);
    });
    await expect(edited.host.deleteTurn('missing')).rejects.toThrow("unknown Codex turn 'missing'");
    await expect(edited.host.editTurn('missing', 'Nope')).rejects.toThrow("user prompt for Codex turn 'missing'");
    await expect(edited.host.editTurn('turn-history', '   ')).rejects.toThrow('empty content');
    await edited.host.conversation('thread-existing').editTurn('turn-history', 'Edited prompt');
    expect(lastRequest(edited.transport, 'thread/revert')).toMatchObject({ params: { beforeTurnId: 'turn-history' } });
    expect(lastRequest(edited.transport, 'turn/start')).toMatchObject({
      params: { input: [{ type: 'text', text: 'Edited prompt' }] },
    });
    expect(editedReplica.getSnapshot()).toMatchObject({
      activeTurnId: 'turn-live',
      busy: true,
      turnIds: ['turn-live'],
      messages: [
        expect.objectContaining({ role: 'user', parts: [expect.objectContaining({ text: 'Edited prompt' })] }),
        expect.objectContaining({ role: 'assistant', turnId: 'turn-live' }),
      ],
    });

    const retried = createHost('thread/revert', 'turn/start');
    await retried.host.connect();
    await retried.host.conversation('thread-existing').retryTurn('turn-history');
    expect(lastRequest(retried.transport, 'thread/revert')).toMatchObject({ params: { beforeTurnId: 'turn-history' } });
    expect(lastRequest(retried.transport, 'turn/start')).toMatchObject({
      params: { input: [{ type: 'text', text: 'Hello' }] },
    });

    const retriedThroughHost = createHost('thread/revert', 'turn/start');
    await retriedThroughHost.host.connect();
    await retriedThroughHost.host.retryTurn('turn-history');
    expect(lastRequest(retriedThroughHost.transport, 'turn/start')).toMatchObject({
      params: { input: [{ type: 'text', text: 'Hello' }] },
    });

    const steered = createHost('turn/start', 'turn/steer', 'turn/interrupt');
    await steered.host.connect();
    const steeredConversation = steered.host.conversation('thread-existing');
    await steeredConversation.sendMessage('First');
    await steeredConversation.steerMessage('Refine this');
    expect(lastRequest(steered.transport, 'turn/steer')).toMatchObject({
      params: { threadId: 'thread-existing', input: [{ type: 'text', text: 'Refine this' }] },
    });
    await steeredConversation.interrupt();
    expect(lastRequest(steered.transport, 'turn/interrupt')).toMatchObject({
      params: { threadId: 'thread-existing', turnId: 'turn-live' },
    });

    const queued = createHost('turn/start', 'turn/steer');
    await queued.host.connect();
    await queued.host.sendMessage('First');
    const firstQueue = await queued.host.sendMessage('Delete me');
    const deleteId = firstQueue.queuedPrompts[0]!.id;
    const queuedConversation = queued.host.conversation('thread-existing');
    await queuedConversation.deleteQueuedPrompt(deleteId);
    await expect(queued.host.deleteQueuedPrompt(deleteId)).rejects.toThrow('Unknown queued prompt');
    await queued.host.sendMessage('Keep my position');
    const secondQueue = await queued.host.sendMessage('Edit me');
    const editId = secondQueue.queuedPrompts[1]!.id;
    await expect(queued.host.updateQueuedPrompt(editId, '   ')).rejects.toThrow('empty content');
    const updatedQueue = await queuedConversation.updateQueuedPrompt(editId, 'Edited in place');
    expect(updatedQueue.queuedPrompts.map(({ id, text }) => ({ id, text }))).toStrictEqual([
      { id: secondQueue.queuedPrompts[0]!.id, text: 'Keep my position' },
      { id: editId, text: 'Edited in place' },
    ]);
    await queuedConversation.steerQueuedPrompt(editId, 'Edited and steered');
    expect(lastRequest(queued.transport, 'turn/steer')).toMatchObject({
      params: { input: [{ type: 'text', text: 'Edited and steered' }] },
    });
    await expect(queued.host.steerQueuedPrompt('missing')).rejects.toThrow('Unknown queued prompt');
  });

});
