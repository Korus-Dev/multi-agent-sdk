import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, type ServerNotification, type ServerRequest } from '@korus-dev/codex-sdk';
import { CodexSurface } from '../../src/providers/codex';
import type { CodexSurfaceEvent } from '../../src/index';
import { invokeCodexSurfaceBridgeOperation } from '../../src/core/surface-bridge';
import { MockCodexAppServer, createSurface, lastRequest, lastResponse, requestsFor, thread, turn } from './helpers/codex-surface-fixture';

describe('CodexSurface', () => {
  it('preserves the status of a newly announced background thread', async () => {
    const { surface, transport } = createSurface();
    const events: CodexSurfaceEvent[] = [];
    surface.onEvent((event) => events.push(event));
    await surface.connect();
    events.length = 0;

    transport.emitNotification('thread/started', {
      thread: { ...thread('thread-announced', false), status: { type: 'active', activeFlags: [] } },
    });

    expect(surface.getConversationSnapshot('thread-announced').threadStatus).toEqual({
      type: 'active', activeFlags: [],
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.activityChanged',
      origin: 'notification',
      conversationId: 'thread-announced',
      payload: expect.objectContaining({ threadStatus: { type: 'active', activeFlags: [] } }),
    }));
    await surface.close();
  });

  it('publishes pending-work resolution when a thread closes', async () => {
    const { surface, transport } = createSurface();
    const events: CodexSurfaceEvent[] = [];
    surface.onEvent((event) => events.push(event));
    await surface.connect();

    transport.emitServerRequest('closed-approval', 'item/commandExecution/requestApproval', { kind: 'command', startedAtMs: 1,
        threadId: 'thread-existing', turnId: 'turn-closed', itemId: 'command-closed',
        command: 'npm test', cwd: '/tmp/project', reason: null, environmentId: null,
        commandActions: [], networkApprovalContext: null, additionalPermissions: null,
        availableDecisions: ['accept', 'decline'], proposedExecpolicyAmendment: null,
      });
    transport.emitServerRequest('closed-input', 'item/tool/requestUserInput', { isBlocking: false,
        threadId: 'thread-existing', turnId: 'turn-closed', itemId: 'input-closed',
        autoResolutionMs: null,
        questions: [{
          id: 'answer', header: 'Answer', question: 'Continue?', isOther: false, isSecret: false,
          options: null,
        }],
      });
    await vi.waitFor(() => expect(surface.getSnapshot()).toMatchObject({
      approvals: [expect.objectContaining({ id: 'closed-approval' })],
      clientRequests: [expect.objectContaining({ id: 'closed-input' })],
    }));
    events.length = 0;

    transport.emitNotification('thread/closed', { threadId: 'thread-existing' });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'approval.resolved',
        origin: 'notification',
        payload: expect.objectContaining({ reason: 'conversation_closed' }),
      }),
      expect.objectContaining({
        type: 'clientRequest.resolved',
        origin: 'notification',
        payload: expect.objectContaining({ reason: 'conversation_closed' }),
      }),
    ]));
    await surface.close();
  });

  it('emits headless sub-agent events without adding standard message UI', async () => {
    const { surface, transport } = createSurface();
    const events: CodexSurfaceEvent[] = [];
    surface.onEvent((event) => events.push(event));
    await surface.connect();

    transport.emitNotification('item/started', {
        threadId: 'thread-existing', turnId: 'turn-subagent', startedAtMs: 1,
        item: {
          type: 'collabAgentToolCall', id: 'collab-1', tool: 'spawnAgent', status: 'inProgress',
          senderThreadId: 'thread-existing', receiverThreadIds: ['thread-child'], prompt: 'Inspect tests',
          model: 'gpt-5', reasoningEffort: 'high',
          agentsStates: { 'thread-child': { status: 'running', message: null } },
        },
      });
    transport.emitNotification('item/completed', {
        threadId: 'thread-existing', turnId: 'turn-subagent', completedAtMs: 2,
        item: { model: null, reasoningEffort: null,
          type: 'subAgentActivity', id: 'activity-1', kind: 'interacted',
          agentThreadId: 'thread-child', agentPath: '/root/scout',
        },
      });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'subagent.toolCallChanged',
        conversationId: 'thread-existing',
        turnId: 'turn-subagent',
        payload: {
          lifecycle: 'started',
          toolCall: {
            id: 'collab-1', tool: 'spawnAgent', status: 'inProgress',
            senderConversationId: 'thread-existing', receiverConversationIds: ['thread-child'],
            prompt: 'Inspect tests', model: 'gpt-5', reasoningEffort: 'high',
            agentStates: { 'thread-child': { status: 'running', message: null } },
          },
        },
      }),
      expect.objectContaining({
        type: 'subagent.activity',
        conversationId: 'thread-existing',
        turnId: 'turn-subagent',
        payload: {
          lifecycle: 'completed',
          activity: {
            id: 'activity-1', kind: 'interacted',
            agentConversationId: 'thread-child', agentPath: '/root/scout',
          },
        },
      }),
    ]));
    expect(surface.getSnapshot().messages.flatMap((message) => message.parts)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'collab-1' })]),
    );
  });

  it('renders and resolves MCP confirmations that are not associated with a turn', async () => {
    const { surface, transport } = createSurface();
    await surface.connect();
    transport.emitServerRequest('mcp-thread-level', 'mcpServer/elicitation/request', {
        threadId: 'thread-existing', turnId: null, serverName: 'calendar', mode: 'form',
        message: 'Allow calendar.list?', requestedSchema: { type: 'object', properties: {} },
        _meta: {
          codex_approval_kind: 'mcp_tool_call', tool_name: 'list', persist: null, tool_params: {},
        },
      });
    await vi.waitFor(() => expect(surface.getSnapshot().messages.flatMap((message) => message.parts)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool', id: 'approval-mcp-thread-level', status: 'running',
          metadata: expect.objectContaining({ confirmationRequestId: 'mcp-thread-level' }),
        }),
      ]),
    ));
    await surface.respondToClientRequest({ id: 'mcp-thread-level', payload: { decision: 'allow' } });
    expect(lastResponse(transport, 'mcp-thread-level')).toMatchObject({ result: { action: 'accept' } });
    expect(surface.getSnapshot()).toMatchObject({
      busy: false,
      answeredClientRequestIds: ['mcp-thread-level'],
    });
    expect(surface.getSnapshot().messages.flatMap((message) => message.parts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool', id: 'approval-mcp-thread-level', status: 'running' }),
    ]));
  });

  it('completes plan items and finalizes orphaned running tools with the turn', async () => {
    const { surface, transport } = createSurface();
    await surface.connect();
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-plan', 'inProgress', []) });
    transport.emitNotification('item/plan/delta', { threadId: 'thread-existing', turnId: 'turn-plan', itemId: 'plan-item', delta: 'draft' });
    transport.emitNotification('item/started', {
        threadId: 'thread-existing', turnId: 'turn-plan', startedAtMs: 1,
        item: { mcpAppUi: null, readOnlyHint: null,
          type: 'mcpToolCall', id: 'mcp-orphan', server: 'tools', tool: 'run', status: 'inProgress',
          arguments: {}, appContext: null, pluginId: null, result: null, error: null, durationMs: null,
        },
      });
    transport.emitNotification('item/completed', {
        threadId: 'thread-existing', turnId: 'turn-plan', completedAtMs: 2,
        item: { type: 'plan', id: 'plan-item', text: '# Final plan' },
      });
    expect(surface.getSnapshot().messages.flatMap((message) => message.parts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'plan-progress-turn-plan', status: 'completed', body: '# Final plan' }),
      expect.objectContaining({ id: 'mcp-orphan', status: 'running' }),
    ]));
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-plan', 'interrupted', []) });
    expect(surface.getSnapshot().messages.flatMap((message) => message.parts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'plan-progress-turn-plan', status: 'completed' }),
      expect.objectContaining({ id: 'mcp-orphan', status: 'failed' }),
    ]));
  });

  it('merges rate limits, preserves waiting status, and applies thread lifecycle events', async () => {
    const transport = new MockCodexAppServer({
      'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
      'account/rateLimits/read': () => ({
        rateLimits: {
          limitId: 'codex', limitName: 'Codex',
          normalModelSlug: null,
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 100 },
          secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 200 },
          credits: { hasCredits: true, unlimited: false, balance: '42' },
          individualLimit: null, spendControlReached: null, planType: 'pro', rateLimitReachedType: null,
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: { availableCount: 2n, credits: null },
        ordinaryUsageAllowed: true,
        accountId: 'account-1',
        rateLimitUpsell: null,
      }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();
    expect(surface.getSnapshot().rateLimits).toMatchObject({
      rateLimits: { limitName: 'Codex', primary: { usedPercent: 10 }, credits: { balance: '42' } },
      rateLimitResetCredits: { availableCount: '2' },
    });
    transport.emitNotification('account/rateLimits/updated', {
        rateLimits: { normalModelSlug: null, spendControlReached: null,
          limitId: 'codex', limitName: null,
          primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 150 },
          secondary: null, credits: null, individualLimit: null, planType: null,
          rateLimitReachedType: null,
        },
      });
    expect(surface.getSnapshot().rateLimits).toMatchObject({
      rateLimits: {
        limitName: 'Codex', primary: { usedPercent: 55, resetsAt: 150 },
        secondary: { usedPercent: 20 }, credits: { balance: '42' }, planType: 'pro',
      },
    });

    transport.emitNotification('thread/status/changed', {
        threadId: 'thread-existing',
        status: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] },
      });
    expect(surface.getSnapshot()).toMatchObject({
      busy: true,
      threadStatus: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] },
      conversations: [expect.objectContaining({ id: 'thread-existing', status: 'active' })],
    });
    transport.emitNotification('thread/status/changed', { threadId: 'thread-existing', status: { type: 'idle' } });
    expect(surface.getSnapshot()).toMatchObject({ busy: false, threadStatus: { type: 'idle' } });

    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-error', 'inProgress', []) });
    transport.emitNotification('error', {
        threadId: 'thread-existing', turnId: 'turn-error', willRetry: true,
        error: { message: 'Retrying', codexErrorInfo: null, additionalDetails: null, misalignment: null },
      });
    expect(surface.getSnapshot()).toMatchObject({ busy: true, error: 'Retrying' });
    transport.emitNotification('error', {
        threadId: 'thread-existing', turnId: 'turn-error', willRetry: false,
        error: { message: 'Stopped', codexErrorInfo: null, additionalDetails: null, misalignment: null },
      });
    expect(surface.getSnapshot()).toMatchObject({ busy: false, error: 'Stopped' });

    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-system-error', 'inProgress', []) });
    transport.emitNotification('thread/status/changed', { threadId: 'thread-existing', status: { type: 'systemError' } });
    expect(surface.getSnapshot()).toMatchObject({
      busy: false,
      error: 'Codex app-server reported a system error',
      threadStatus: { type: 'systemError' },
    });
    transport.emitNotification('thread/archived', { threadId: 'thread-existing' });
    expect(surface.getSnapshot()).toMatchObject({ activeConversationId: null, conversations: [], messages: [] });
    transport.emitNotification('thread/unarchived', { threadId: 'thread-existing' });
    await vi.waitFor(() => expect(surface.getSnapshot().conversations).toHaveLength(1));
    await surface.selectConversation('thread-existing');
    await surface.sendMessage('Running');
    transport.emitNotification('thread/closed', { threadId: 'thread-existing' });
    expect(surface.getSnapshot()).toMatchObject({ busy: false, threadStatus: { type: 'idle' } });
    transport.emitNotification('thread/deleted', { threadId: 'thread-existing' });
    expect(surface.getSnapshot()).toMatchObject({ activeConversationId: null, conversations: [] });
  });

  it('contains rejected fire-and-forget conversation refreshes after unarchive', async () => {
    let failRefresh = false;
    const transport = new MockCodexAppServer({
      'thread/list': () => {
        if (failRefresh) throw new Error('refresh unavailable');
        return { readStates: null, backwardsCursor: null, data: [thread('thread-existing', false)], nextCursor: null };
      },
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();
    failRefresh = true;

    transport.emitNotification('thread/unarchived', { threadId: 'thread-existing' });
    await vi.waitFor(() => expect(surface.getSnapshot().error).toBe('refresh unavailable'));
    expect(surface.getSnapshot().conversations).toHaveLength(1);
  });

  it('exposes realtime voice as a typed conversation session', async () => {
    const { surface, transport } = createSurface(
      'thread/realtime/start',
      'thread/realtime/appendAudio',
      'thread/realtime/appendText',
      'thread/realtime/appendSpeech',
      'thread/realtime/stop',
    );
    await surface.connect();
    const conversation = surface.conversation('thread-existing');
    const events: CodexSurfaceEvent[] = [];
    conversation.onEvent((event) => events.push(event));

    const session = await conversation.startRealtime({
      outputModality: 'audio',
      version: 'v3',
      voice: 'marin',
      includeStartupContext: true,
      flushTranscriptTailOnSessionEnd: true,
    });
    expect(lastRequest(transport, 'thread/realtime/start')).toMatchObject({
      params: {
        threadId: 'thread-existing',
        outputModality: 'audio',
        version: 'v3',
        voice: 'marin',
        includeStartupContext: true,
        flushTranscriptTailOnSessionEnd: true,
        transport: { type: 'websocket' },
      },
    });

    await session.appendAudio({
      data: new Uint8Array([1, 2, 3, 4]),
      sampleRate: 16_000,
      numChannels: 1,
    });
    expect(lastRequest(transport, 'thread/realtime/appendAudio')).toMatchObject({
      params: {
        threadId: 'thread-existing',
        audio: {
          data: 'AQIDBA==',
          sampleRate: 16_000,
          numChannels: 1,
          samplesPerChannel: 2,
          itemId: null,
        },
      },
    });

    await session.appendText('check the tests', 'user');
    await session.appendSpeech('I am checking the tests');
    expect(lastRequest(transport, 'thread/realtime/appendText')).toMatchObject({
      params: { threadId: 'thread-existing', text: 'check the tests', role: 'user' },
    });
    expect(lastRequest(transport, 'thread/realtime/appendSpeech')).toMatchObject({
      params: { threadId: 'thread-existing', text: 'I am checking the tests' },
    });

    transport.emitNotification('thread/realtime/started', { threadId: 'thread-existing', realtimeSessionId: 'rtc_123', version: 'v3' });
    transport.emitNotification('thread/realtime/transcript/delta', { threadId: 'thread-existing', role: 'user', delta: 'check the' });
    transport.emitNotification('thread/realtime/transcript/done', { threadId: 'thread-existing', role: 'user', text: 'check the tests' });
    transport.emitNotification('thread/realtime/outputAudio/delta', {
        threadId: 'thread-existing',
        audio: {
          data: 'AQID',
          sampleRate: 24_000,
          numChannels: 1,
          samplesPerChannel: 3,
          itemId: 'audio-1',
        },
      });
    transport.emitNotification('thread/realtime/closed', { threadId: 'thread-existing', reason: 'requested' });

    expect(events.map((event) => event.type)).toStrictEqual([
      'realtime.started',
      'realtime.transcriptDelta',
      'realtime.transcriptCompleted',
      'realtime.audioDelta',
      'realtime.closed',
    ]);
    expect(events[3]).toMatchObject({
      payload: {
        audio: {
          data: new Uint8Array([1, 2, 3]),
          sampleRate: 24_000,
          numChannels: 1,
          samplesPerChannel: 3,
          itemId: 'audio-1',
        },
      },
    });

    await session.stop();
    await session.stop();
    expect(requestsFor(transport, 'thread/realtime/stop')).toHaveLength(1);
    await expect(session.appendText('too late')).rejects.toThrow(
      "Realtime session for 'thread-existing' is stopped",
    );
  });

  it('hydrates an unloaded conversation before starting its realtime session', async () => {
    const { surface, transport } = createSurface('thread/realtime/start', 'thread/realtime/stop');
    await surface.connect();

    const session = await surface.conversation('thread-unloaded').startRealtime({
      outputModality: 'text',
      version: 'v2',
    });

    expect(lastRequest(transport, 'thread/resume')).toMatchObject({
      params: { threadId: 'thread-unloaded' },
    });
    expect(lastRequest(transport, 'thread/realtime/start')).toMatchObject({
      params: { threadId: 'thread-unloaded', outputModality: 'text' },
    });
    await session.stop();
  });

  it('negotiates WebRTC realtime before returning the session handle', async () => {
    const { surface, transport } = createSurface('thread/realtime/start', 'thread/realtime/stop');
    await surface.connect();
    const conversation = surface.conversation('thread-existing');

    const sessionPromise = conversation.startRealtime({
      outputModality: 'audio',
      version: 'v1',
      transport: {
        type: 'webrtc',
        sdp: 'v=0\r\no=codex-remote-offer\r\n',
      },
    });
    await vi.waitFor(() => {
      expect(requestsFor(transport, 'thread/realtime/start')).toHaveLength(1);
    });
    expect(lastRequest(transport, 'thread/realtime/start')).toMatchObject({
      params: {
        threadId: 'thread-existing',
        outputModality: 'audio',
        version: 'v1',
        transport: {
          type: 'webrtc',
          sdp: 'v=0\r\no=codex-remote-offer\r\n',
        },
      },
    });

    transport.emitNotification('thread/realtime/sdp', {
        threadId: 'thread-existing',
        sdp: 'v=0\r\no=codex-remote-answer\r\n',
      });
    const session = await sessionPromise;
    expect(session).toMatchObject({
      conversationId: 'thread-existing',
      transport: 'webrtc',
      remoteSdp: 'v=0\r\no=codex-remote-answer\r\n',
    });
    await expect(session.appendAudio({
      data: new Uint8Array([0, 0]),
      sampleRate: 24_000,
      numChannels: 1,
    })).rejects.toThrow('must be sent through its negotiated media track');
    await session.stop();
  });

  it('negotiates renderer live chat and forwards its canonical transcript on the specified thread', async () => {
    const { surface, transport } = createSurface('thread/realtime/start', 'thread/realtime/stop');
    try {
      await surface.connect();
      const events: CodexSurfaceEvent[] = [];
      surface.onEvent((event) => { if (event.type.startsWith('realtime.')) events.push(event); });
      const start = invokeCodexSurfaceBridgeOperation(surface, 'startLiveChat', ['thread-other', {
        sdp: 'offer', voice: 'marin', prompt: null, includeStartupContext: true, flushTranscriptTailOnSessionEnd: true,
      }]);
      await vi.waitFor(() => expect(requestsFor(transport, 'thread/realtime/start')).toHaveLength(1));
      expect(lastRequest(transport, 'thread/realtime/start')).toEqual(expect.objectContaining({ params: {
        threadId: 'thread-other', outputModality: 'audio', version: 'v3', transport: { type: 'webrtc', sdp: 'offer' },
        voice: 'marin', prompt: null, includeStartupContext: true, flushTranscriptTailOnSessionEnd: true,
      } }));
      transport.emitNotification('thread/realtime/sdp', { threadId: 'thread-other', sdp: 'answer' });
      await expect(start).resolves.toEqual({ sdp: 'answer' });
      events.length = 0;
      const item = { type: 'transcriptSegment' as const, id: 'item-1', realtimeSessionId: 'session-1', role: 'user' as const, text: '' };
      transport.emitNotification('thread/realtime/item/started', { threadId: 'thread-other', item });
      transport.emitNotification('thread/realtime/item/transcript/delta', { threadId: 'thread-other', itemId: 'item-1', delta: 'Hello' });
      transport.emitNotification('thread/realtime/item/completed', { threadId: 'thread-other', item: { ...item, text: 'Hello!' } });
      expect(events.map(({ type, payload, ...event }) => ({ type, payload, conversationId: 'conversationId' in event ? event.conversationId : null }))).toEqual([
        { type: 'realtime.itemStarted', conversationId: 'thread-other', payload: { item } },
        { type: 'realtime.itemTranscriptDelta', conversationId: 'thread-other', payload: { itemId: 'item-1', delta: 'Hello' } },
        { type: 'realtime.itemCompleted', conversationId: 'thread-other', payload: { item: { ...item, text: 'Hello!' } } },
      ]);
      await invokeCodexSurfaceBridgeOperation(surface, 'stopLiveChat', ['thread-other']);
      expect(lastRequest(transport, 'thread/realtime/stop')).toEqual(expect.objectContaining({ params: { threadId: 'thread-other' } }));
    } finally { await surface.close(); }
  });

  it('rejects live chat promptly when signaling fails before the start response', async () => {
    const transport = new MockCodexAppServer({ 'thread/realtime/start': () => new Promise(() => undefined) });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport), cwd: '/tmp/project' });
    try {
      await surface.connect();
      let failure: string | undefined;
      const start = surface.startLiveChat('thread-existing', { sdp: 'offer' }).catch((error: unknown) => {
        failure = error instanceof Error ? error.message : String(error);
      });
      await vi.waitFor(() => expect(requestsFor(transport, 'thread/realtime/start')).toHaveLength(1));
      transport.emitNotification('thread/realtime/error', { threadId: 'thread-existing', message: 'Voice unavailable' });
      await vi.waitFor(() => expect(failure).toBe('Voice unavailable'), { timeout: 200 });
      await start;
    } finally { await surface.close(); }
  });

  it('projects remote-control status changes as a host event', async () => {
    const { surface, transport } = createSurface();
    await surface.connect();
    const events: CodexSurfaceEvent[] = [];
    surface.onEvent((event) => events.push(event));

    transport.emitNotification('remoteControl/status/changed', {
        status: 'connected',
        serverName: 'Codex remote control',
        installationId: 'installation-1',
        environmentId: 'environment-1',
      });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'remoteControl.statusChanged',
      origin: 'notification',
      payload: {
        status: {
          status: 'connected',
          serverName: 'Codex remote control',
          installationId: 'installation-1',
          environmentId: 'environment-1',
        },
      },
    }));
  });

  it('ignores and reports notifications added by a newer app-server schema', async () => {
    const transport = new MockCodexAppServer();
    const onUnknownNotification = vi.fn();
    const surface = new CodexSurface({
      client: new CodexAppServerClient(transport),
      onUnknownNotification,
    });
    await surface.connect();
    const before = surface.getSnapshot();
    const notification = {
      method: 'future/notification',
      params: { threadId: 'thread-existing', future: true },
    };

    expect(() => transport.emitRaw(notification)).not.toThrow();
    expect(onUnknownNotification).toHaveBeenCalledOnce();
    expect(onUnknownNotification).toHaveBeenCalledWith(notification);
    expect(surface.getSnapshot()).toStrictEqual(before);

    const withoutCallback = createSurface();
    await withoutCallback.surface.connect();
    expect(() => withoutCallback.transport.emitRaw(notification)).not.toThrow();
  });

  it('reports typed notifications that are not projected by the surface', async () => {
    const transport = new MockCodexAppServer();
    const onUnknownNotification = vi.fn();
    const surface = new CodexSurface({
      client: new CodexAppServerClient(transport),
      onUnknownNotification,
    });
    await surface.connect();
    const notification = {
      method: 'thread/environment/connected',
      params: { threadId: 'thread-existing', environmentId: 'environment-1' },
    } satisfies ServerNotification;

    transport.emitNotificationFrame(notification);

    expect(onUnknownNotification).toHaveBeenCalledOnce();
    expect(onUnknownNotification).toHaveBeenCalledWith(notification);
  });

  it('makes every non-UI server-request policy explicit and fail-closed', async () => {
    const { surface, transport } = createSurface();
    await surface.connect();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_123_999);
    transport.emitServerRequest('time', 'currentTime/read', { threadId: 'thread-existing' });
    await vi.waitFor(() => expect(lastResponse(transport, 'time')).toMatchObject({
      result: { currentTimeAt: 1_700_000_123 },
    }));
    now.mockRestore();

    const unsupported: Array<{ request: ServerRequest; message: string }> = [
      {
        request: {
          id: 'dynamic', method: 'item/tool/call',
          params: { threadId: 'thread-existing', turnId: 'turn', callId: 'call', namespace: null, tool: 'host', arguments: {} },
        },
        message: "Unknown dynamic host tool 'host'",
      },
      {
        request: {
          id: 'auth', method: 'account/chatgptAuthTokens/refresh',
          params: { reason: 'unauthorized', previousAccountId: null },
        },
        message: 'ChatGPT token refresh must be provided by the host application',
      },
      {
        request: { id: 'attestation', method: 'attestation/generate', params: {} },
        message: 'Client attestation must be provided by the host application',
      },
    ];
    for (const { request, message } of unsupported) {
      transport.emitServerRequestFrame(request);
      await vi.waitFor(() => expect(lastResponse(transport, request.id)).toMatchObject({
        error: { code: -32601, message },
      }));
    }
  });

  it('removes externally resolved approvals from the active surface', async () => {
    const { surface, transport } = createSurface();
    await surface.connect();
    transport.emitServerRequest('external-approval', 'item/commandExecution/requestApproval', { kind: 'command', startedAtMs: 1,
        threadId: 'thread-existing', turnId: 'turn', itemId: 'command', command: 'npm test',
        cwd: '/tmp/project', reason: null, environmentId: null, commandActions: [],
        networkApprovalContext: null, additionalPermissions: null, availableDecisions: null,
        proposedExecpolicyAmendment: null,
      });
    await vi.waitFor(() => expect(surface.getSnapshot().approvals).toHaveLength(1));
    transport.emitNotification('serverRequest/resolved', { threadId: 'thread-existing', requestId: 'external-approval' });
    expect(surface.getSnapshot().approvals).toStrictEqual([]);
    await expect(surface.resolveApproval('external-approval', 'approve')).rejects.toThrow('Unknown approval');
  });

  it('labels notification-driven summary changes and removal with notification origin', async () => {
    const { surface, transport } = createSurface();
    const events: CodexSurfaceEvent[] = [];
    surface.onEvent((event) => events.push(event));
    await surface.connect();
    events.length = 0;

    transport.emitNotification('thread/status/changed', { threadId: 'thread-existing', status: { type: 'active', activeFlags: [] } });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.summaryUpserted',
      origin: 'notification',
      payload: expect.objectContaining({ summary: expect.objectContaining({ status: 'active' }) }),
    }));
    events.length = 0;

    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-origin', 'inProgress', []) });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.summaryUpserted',
      origin: 'notification',
      payload: expect.objectContaining({ summary: expect.objectContaining({ turnCount: 2 }) }),
    }));
    transport.emitNotification('thread/closed', { threadId: 'thread-existing' });
    expect(events.filter((event) => event.type === 'conversation.summaryUpserted').at(-1))
      .toMatchObject({ origin: 'notification', payload: { summary: { status: 'idle' } } });
    events.length = 0;

    transport.emitNotification('thread/deleted', { threadId: 'thread-existing' });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.summaryRemoved',
      origin: 'notification',
      payload: { reason: 'deleted' },
    }));
    await surface.close();
  });

});
