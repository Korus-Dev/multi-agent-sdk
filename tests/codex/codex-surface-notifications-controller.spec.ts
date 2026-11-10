import { describe, expect, it, vi } from 'vitest';
import type { CodexSurfaceModel, CodexSurfaceSnapshot } from 'multi-agents-sdk/surface';
import { initialAuthentication } from '../../src/providers/codex/codex-surface-authentication';
import { CodexSurfaceNotificationsController } from '../../src/providers/codex/codex-surface-notifications-controller';
import {
  createThreadRuntime,
  initialSurfaceSnapshot,
  type ThreadRuntimeState,
} from '../../src/providers/codex/codex-surface-runtime';
import { testModel, thread, threadSettings, turn } from './helpers/codex-surface-fixture';

describe('CodexSurfaceNotificationsController', () => {
  it('projects a started thread into runtime, summary, and semantic events', () => {
    const setup = createController();
    const started = { ...thread('new-thread', false), status: { type: 'active', activeFlags: [] } };

    handle(setup, 'thread/started', { thread: started });

    expect(setup.host.createRuntime).toHaveBeenCalledExactlyOnceWith('new-thread', {
      historyMode: 'paginated',
      threadStatus: { type: 'active', activeFlags: [] },
    });
    expect(setup.state.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'thread-1' }),
      expect.objectContaining({ id: 'new-thread', status: 'active' }),
    ]));
    const summary = setup.state.conversations.find((candidate) => candidate.id === 'new-thread');
    expect(setup.host.emitSummaryUpserted).toHaveBeenCalledExactlyOnceWith(
      summary, 'started', 'notification',
    );
    expect(setup.host.emitConversationActivity).toHaveBeenCalledExactlyOnceWith(
      'new-thread', 'notification',
    );
  });

  it('clears stale local active work on authoritative idle', () => {
    const setup = createController({ activeTurnId: 'turn-active' });

    handle(setup, 'thread/status/changed', { threadId: 'thread-1', status: { type: 'idle' } });

    expect(setup.runtime).toMatchObject({
      activeTurnId: null, busy: false, threadStatus: { type: 'idle' },
    });
    expect(setup.state.conversations[0]).toMatchObject({ id: 'thread-1', status: 'idle' });
    expect(setup.host.emitSummaryUpserted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'thread-1', status: 'idle' }), 'updated', 'notification',
    );
    expect(setup.host.emitConversationActivity).toHaveBeenCalledWith('thread-1', 'notification');
  });

  it('keeps a thread busy for pending starts and active server status', () => {
    const pending = createController({ turnStartPending: true });
    handle(pending, 'thread/status/changed', { threadId: 'thread-1', status: { type: 'idle' } });
    expect(pending.runtime.busy).toBe(true);

    const active = createController();
    handle(active, 'thread/status/changed', {
      threadId: 'thread-1', status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
    });
    expect(active.runtime).toMatchObject({
      busy: true, threadStatus: { type: 'active', activeFlags: ['waitingOnUserInput'] },
    });
  });

  it('clears active work and records an exact system error', () => {
    const setup = createController({ activeTurnId: 'turn-active', busy: true, turnStartPending: true });

    handle(setup, 'thread/status/changed', {
      threadId: 'thread-1', status: { type: 'systemError' },
    });

    expect(setup.runtime).toMatchObject({
      activeTurnId: null, busy: false, turnStartPending: false,
      threadStatus: { type: 'systemError' }, error: 'Codex app-server reported a system error',
    });
    expect(setup.state.conversations[0]).toMatchObject({ status: 'error' });
  });

  it('updates and emits only the matching summary in a multi-conversation list', () => {
    const setup = createController({ secondConversation: true });
    const secondRuntime = createThreadRuntime('thread-2', setup.state);
    setup.runtimes.set('thread-2', secondRuntime);

    handle(setup, 'thread/status/changed', {
      threadId: 'thread-2', status: { type: 'active', activeFlags: [] },
    });

    expect(setup.state.conversations).toMatchObject([
      { id: 'thread-1', status: 'idle' },
      { id: 'thread-2', status: 'active' },
    ]);
    expect(setup.host.emitSummaryUpserted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'thread-2', status: 'active' }), 'updated', 'notification',
    );
  });

  it('does not emit a summary when a status notification has no listed conversation', () => {
    const setup = createController();
    setup.runtimes.set('unlisted', createThreadRuntime('unlisted', setup.state));

    handle(setup, 'thread/status/changed', {
      threadId: 'unlisted', status: { type: 'idle' },
    });

    expect(setup.host.emitSummaryUpserted).not.toHaveBeenCalled();
    expect(setup.host.emitConversationActivity).toHaveBeenCalledWith('unlisted', 'notification');
  });

  it('routes thread removals with their exact reasons', () => {
    const setup = createController();
    for (const [method, reason] of [
      ['thread/archived', 'archived'],
      ['thread/deleted', 'deleted'],
    ] as const) {
      handle(setup, method, { threadId: 'thread-1' });
      expect(setup.host.removeThread).toHaveBeenLastCalledWith('thread-1', reason);
    }
    expect(setup.host.removeThread).toHaveBeenCalledTimes(2);
  });

  it('refreshes unarchived conversations and contains refresh failures', async () => {
    const success = createController();
    handle(success, 'thread/unarchived', { threadId: 'thread-1' });
    expect(success.conversations.load).toHaveBeenCalledOnce();

    const failure = createController();
    failure.conversations.load.mockRejectedValue(new Error('refresh failed'));
    handle(failure, 'thread/unarchived', { threadId: 'thread-1' });
    await vi.waitFor(() => expect(failure.state.error).toBe('refresh failed'));
  });

  it('closes a loaded thread and clears all pending work', () => {
    const setup = createController({ activeTurnId: 'turn-active', busy: true, turnStartPending: true });

    handle(setup, 'thread/closed', { threadId: 'thread-1' });

    expect(setup.runtime).toMatchObject({
      activeTurnId: null, busy: false, turnStartPending: false, threadStatus: { type: 'idle' },
    });
    expect(setup.host.clearPendingForThread).toHaveBeenCalledExactlyOnceWith(
      'thread-1', 'Codex thread closed', 'conversation_closed',
    );
    expect(setup.host.patchConversationStatus).toHaveBeenCalledWith('thread-1', 'idle');
    expect(setup.host.emitConversationActivity).toHaveBeenCalledWith('thread-1', 'notification');
  });

  it('closes an unloaded thread without creating runtime state', () => {
    const setup = createController();
    setup.runtimes.delete('thread-1');

    handle(setup, 'thread/closed', { threadId: 'thread-1' });

    expect(setup.host.patchRuntime).not.toHaveBeenCalled();
    expect(setup.host.clearPendingForThread).toHaveBeenCalledOnce();
    expect(setup.host.patchConversationStatus).toHaveBeenCalledWith('thread-1', 'idle');
  });

  it('invalidates skill discovery after a skills change without loading permissions', () => {
    const setup = createController();
    handle(setup, 'skills/changed', {});
    expect(setup.catalog.invalidateSkills).toHaveBeenCalledOnce();
    expect(setup.catalog.loadConversationCatalogs).not.toHaveBeenCalled();
  });

  it('trims an updated thread name, changes only the target, and emits its summary', () => {
    const setup = createController({ secondConversation: true });

    handle(setup, 'thread/name/updated', { threadId: 'thread-1', threadName: '  Renamed  ' });

    expect(setup.state.conversations).toMatchObject([
      { id: 'thread-1', title: 'Renamed' },
      { id: 'thread-2', title: 'Second' },
    ]);
    expect(setup.host.emitSummaryUpserted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'thread-1', title: 'Renamed' }), 'updated', 'notification',
    );
  });

  it('uses preview and untitled fallbacks for blank or unknown names', () => {
    const preview = createController();
    handle(preview, 'thread/name/updated', { threadId: 'thread-1', threadName: '   ' });
    expect(preview.state.conversations[0]?.title).toBe('Preview one');

    const unknown = createController();
    handle(unknown, 'thread/name/updated', { threadId: 'missing', threadName: null });
    expect(unknown.state.conversations).toEqual([expect.objectContaining({ id: 'thread-1' })]);
    expect(unknown.host.emitSummaryUpserted).not.toHaveBeenCalled();

    const untitled = createController();
    untitled.state.conversations[0] = { ...untitled.state.conversations[0]!, preview: '' };
    handle(untitled, 'thread/name/updated', { threadId: 'thread-1', threadName: null });
    expect(untitled.state.conversations[0]?.title).toBe('Untitled conversation');
  });

  it('uses the matching conversation preview for a blank renamed thread', () => {
    const setup = createController({ secondConversation: true });
    handle(setup, 'thread/name/updated', { threadId: 'thread-2', threadName: '  ' });
    expect(setup.state.conversations).toMatchObject([
      { id: 'thread-1', title: 'Thread one' },
      { id: 'thread-2', title: 'Preview two' },
    ]);
  });

  it('does nothing when a thread name is already authoritative', () => {
    const setup = createController();
    handle(setup, 'thread/name/updated', { threadId: 'thread-1', threadName: 'Thread one' });
    expect(setup.host.patch).not.toHaveBeenCalled();
    expect(setup.host.emitSummaryUpserted).not.toHaveBeenCalled();
  });

  it.each([
    ['approvalPreset', { approvalPolicy: 'never', activePermissionProfile: { id: ':danger-full-access', extends: null } }],
    ['selectedModelId', { model: 'gpt-mini-runtime' }],
    ['selectedReasoningEffort', { effort: 'high' }],
    ['selectedServiceTier', { serviceTier: 'priority' }],
    ['planMode', { collaborationMode: { mode: 'plan', settings: {
      model: 'gpt-5', reasoning_effort: 'medium', developer_instructions: null,
    } } }],
  ] as const)('emits settings when only %s changes', (_field, overrides) => {
    const setup = createController({
      approvalPreset: 'ask-for-approval',
      models: [surfaceModel('gpt-5', 'gpt-5'), surfaceModel('gpt-mini', 'gpt-mini-runtime')],
      planMode: false,
      selectedModelId: 'gpt-5',
      selectedReasoningEffort: 'medium',
      selectedServiceTier: null,
    });

    handle(setup, 'thread/settings/updated', {
      threadId: 'thread-1', threadSettings: threadSettings(overrides),
    });

    expect(setup.host.patchRuntime).toHaveBeenCalledWith('thread-1', expect.any(Object));
    expect(setup.host.emitConversationSettings).toHaveBeenCalledExactlyOnceWith('thread-1', 'notification');
  });

  it('patches but does not emit unchanged thread settings', () => {
    const setup = createController({
      approvalPreset: 'ask-for-approval',
      models: [surfaceModel('gpt-5', 'gpt-5')],
      selectedModelId: 'gpt-5',
      selectedReasoningEffort: 'medium',
    });

    handle(setup, 'thread/settings/updated', {
      threadId: 'thread-1', threadSettings: threadSettings(),
    });

    expect(setup.host.patchRuntime).toHaveBeenCalledOnce();
    expect(setup.host.emitConversationSettings).not.toHaveBeenCalled();
  });

  it('updates and emits a detached goal with an optional turn identity', () => {
    const setup = createController();
    const goal = goalValue();

    handle(setup, 'thread/goal/updated', { threadId: 'thread-1', turnId: 'turn-1', goal });

    expect(setup.runtime.goal).toStrictEqual(goal);
    expect(setup.runtime.goal).not.toBe(goal);
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('notification', {
      type: 'conversation.goalChanged', conversationId: 'thread-1', turnId: 'turn-1',
      payload: { goal },
    });
    expect((setup.host.emitEvent.mock.calls[0]?.[1] as { payload: { goal: unknown } }).payload.goal)
      .not.toBe(goal);
  });

  it('suppresses equal goals and omits an absent turn identity', () => {
    const goal = goalValue();
    const equal = createController({ goal });
    handle(equal, 'thread/goal/updated', { threadId: 'thread-1', turnId: null, goal: { ...goal } });
    expect(equal.host.patchRuntime).not.toHaveBeenCalled();
    expect(equal.host.emitEvent).not.toHaveBeenCalled();

    const changed = createController();
    handle(changed, 'thread/goal/updated', { threadId: 'thread-1', turnId: null, goal });
    expect(changed.host.emitEvent).toHaveBeenCalledWith('notification', expect.not.objectContaining({ turnId: expect.anything() }));
  });

  it('clears a present goal once and suppresses an already-clear goal', () => {
    const present = createController({ goal: goalValue() });
    handle(present, 'thread/goal/cleared', { threadId: 'thread-1' });
    expect(present.runtime.goal).toBeNull();
    expect(present.host.emitEvent).toHaveBeenCalledExactlyOnceWith('notification', {
      type: 'conversation.goalChanged', conversationId: 'thread-1', payload: { goal: null },
    });

    const clear = createController();
    handle(clear, 'thread/goal/cleared', { threadId: 'thread-1' });
    expect(clear.host.patchRuntime).not.toHaveBeenCalled();
    expect(clear.host.emitEvent).not.toHaveBeenCalled();
  });

  it('projects exact context usage and a detached change event', () => {
    const setup = createController();
    const tokenUsage = {
      total: {
        totalTokens: 200, inputTokens: 120, cachedInputTokens: 20,
        outputTokens: 80, reasoningOutputTokens: 30,
      },
      last: {
        totalTokens: 100, inputTokens: 60, cachedInputTokens: 10,
        outputTokens: 40, reasoningOutputTokens: 15,
      },
      modelContextWindow: 1000,
    };

    handle(setup, 'thread/tokenUsage/updated', {
      threadId: 'thread-1', turnId: 'turn-1', tokenUsage,
    });

    expect(setup.runtime.contextUsage).toStrictEqual({
      totalTokens: 200, inputTokens: 120, cachedInputTokens: 20, outputTokens: 80,
      reasoningOutputTokens: 30, lastTotalTokens: 100,
      modelContextWindow: 1000, usedPercent: 10,
    });
    expect(setup.host.emitEvent).toHaveBeenCalledWith('notification', {
      type: 'conversation.contextUsageChanged', conversationId: 'thread-1', turnId: 'turn-1',
      payload: { contextUsage: setup.runtime.contextUsage },
    });
    expect((setup.host.emitEvent.mock.calls[0]?.[1] as { payload: { contextUsage: unknown } }).payload.contextUsage)
      .not.toBe(setup.runtime.contextUsage);
  });

  it('starts a new turn with reset state, an assistant placeholder, and one event', () => {
    const setup = createController({ busy: false, error: 'old error', turnStartPending: true });
    setup.runtime.turnGitDiff = {
      turnId: 'old', addedLines: 1, removedLines: 0, diff: '+old', updatedAt: 'old',
    };
    const started = { ...turn('turn-new', 'inProgress', []), startedAt: 1500 };

    handle(setup, 'turn/started', { threadId: 'thread-1', turn: started });

    expect(setup.runtime).toMatchObject({
      activeTurnId: 'turn-new', turnIds: ['turn-new'], busy: true, turnStartPending: false,
      error: null, turnGitDiff: null,
    });
    expect(setup.runtime.messages).toEqual([
      expect.objectContaining({
        role: 'assistant', status: 'streaming', turnId: 'turn-new', createdAt: '1970-01-01T00:25:00.000Z',
      }),
    ]);
    expect(setup.host.patchConversationTurnCount).toHaveBeenCalledExactlyOnceWith('thread-1', 1);
    expect(setup.host.patchConversationStatus).toHaveBeenCalledWith('thread-1', 'active');
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('notification', {
      type: 'turn.started', conversationId: 'thread-1', turnId: 'turn-new',
      payload: { startedAt: '1970-01-01T00:25:00.000Z' },
    });
    expect(setup.host.emitConversationActivity).toHaveBeenCalledWith('thread-1', 'notification');
  });

  it('does not emit a duplicate turn-start event for an already-active turn', () => {
    const setup = createController({ activeTurnId: 'turn-active', busy: true });
    setup.runtime.turnIds = ['turn-active'];

    handle(setup, 'turn/started', {
      threadId: 'thread-1', turn: { ...turn('turn-active', 'inProgress', []), startedAt: null },
    });

    expect(setup.runtime.turnIds).toEqual(['turn-active']);
    expect(setup.host.emitEvent).not.toHaveBeenCalled();
  });

  it('routes item and turn notifications without reshaping params', () => {
    const setup = createController();
    for (const [method, target] of [
      ['item/agentMessage/delta', 'applyAgentDelta'],
      ['item/plan/delta', 'applyPlanDelta'],
      ['rawResponseItem/completed', 'applyRawResponseItem'],
      ['turn/plan/updated', 'applyPlanUpdated'],
      ['turn/completed', 'applyTurnCompleted'],
    ] as const) {
      const params = { threadId: 'thread-1', turnId: 'turn-1', marker: method };
      handle(setup, method, params);
      expect(setup.items[target]).toHaveBeenCalledExactlyOnceWith(params);
    }
  });

  it('routes item lifecycle notifications with exact completion flags', () => {
    const setup = createController();
    for (const [method, completed] of [
      ['item/started', false],
      ['item/completed', true],
    ] as const) {
      const params = { threadId: 'thread-1', turnId: 'turn-1', item: { id: method } };
      handle(setup, method, params);
      expect(setup.items.applyItem).toHaveBeenLastCalledWith(params, completed);
    }
    expect(setup.items.applyItem).toHaveBeenCalledTimes(2);
  });

  it('forwards command output only for tracked command items', () => {
    const ignored = createController();
    handle(ignored, 'item/commandExecution/outputDelta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command', delta: 'ignored',
    });
    expect(ignored.items.applyToolUpdate).not.toHaveBeenCalled();

    const forwarded = createController();
    forwarded.items.isForwardingCommandOutput.mockReturnValue(true);
    handle(forwarded, 'item/commandExecution/outputDelta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command', delta: 'output',
    });
    expect(forwarded.items.isForwardingCommandOutput).toHaveBeenCalledExactlyOnceWith('thread-1', 'command');
    expect(forwarded.items.applyToolUpdate).toHaveBeenCalledExactlyOnceWith(
      'thread-1', 'turn-1',
      expect.objectContaining({
        itemId: 'command', bodyDelta: 'output',
        fallbackToolPart: expect.objectContaining({ id: 'command', kind: 'command', status: 'running' }),
      }),
    );
  });

  it('adapts file patches and MCP progress into exact tool updates', () => {
    const setup = createController();
    const changes = [{ path: '/project/a.ts', kind: { type: 'add' }, diff: '+one' }];
    handle(setup, 'item/fileChange/patchUpdated', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'file', changes,
    });
    handle(setup, 'item/mcpToolCall/progress', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'mcp', message: 'Working',
    });

    expect(setup.items.applyToolUpdate).toHaveBeenNthCalledWith(
      1, 'thread-1', 'turn-1', expect.objectContaining({
        itemId: 'file', input: { changes }, metadata: { changes },
        fallbackToolPart: expect.objectContaining({ id: 'file', title: '1 file change' }),
      }),
    );
    expect(setup.items.applyToolUpdate).toHaveBeenNthCalledWith(
      2, 'thread-1', 'turn-1', expect.objectContaining({
        itemId: 'mcp', bodyAppend: 'Working',
        fallbackToolPart: expect.objectContaining({ id: 'mcp', kind: 'mcp' }),
      }),
    );
  });

  it('resolves external server requests through both owning controllers', () => {
    const setup = createController();
    handle(setup, 'serverRequest/resolved', { threadId: 'thread-1', requestId: 42 });
    expect(setup.clientRequests.handleServerResolved).toHaveBeenCalledExactlyOnceWith('42', 'thread-1');
    expect(setup.approvals.handleServerResolved).toHaveBeenCalledExactlyOnceWith('42');
    expect(setup.host.emitConversationActivity).toHaveBeenCalledExactlyOnceWith('thread-1', 'notification');
  });

  it('projects an exact turn diff and emits the stored detached value', () => {
    const setup = createController();
    handle(setup, 'turn/diff/updated', {
      threadId: 'thread-1', turnId: 'turn-1', diff: '@@ -1 +1,2 @@\n-old\n+new\n+line',
    });
    expect(setup.runtime.turnGitDiff).toMatchObject({
      turnId: 'turn-1', addedLines: 2, removedLines: 1,
      diff: '@@ -1 +1,2 @@\n-old\n+new\n+line', updatedAt: expect.any(String),
    });
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('notification', {
      type: 'conversation.diffUpdated', conversationId: 'thread-1',
      payload: { diff: setup.runtime.turnGitDiff },
    });
    expect((setup.host.emitEvent.mock.calls[0]?.[1] as { payload: { diff: unknown } }).payload.diff)
      .not.toBe(setup.runtime.turnGitDiff);
  });

  it('appends and emits the matching compaction marker among deceptive messages', () => {
    const setup = createController({ messages: [
      { ...message('marker-without-metadata', 'assistant', 'unused'), kind: 'compaction', metadata: undefined },
      message('ordinary-same-turn', 'assistant', 'turn-2'),
      { ...message('older-marker', 'assistant', 'turn-old'), kind: 'compaction' },
    ] });

    handle(setup, 'thread/compacted', { threadId: 'thread-1', turnId: 'turn-2' });

    const marker = setup.runtime.messages.find((candidate) => (
      candidate.kind === 'compaction' && candidate.metadata?.turnId === 'turn-2'
    ));
    expect(marker).toBeDefined();
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('notification', {
      type: 'context.compactionCompleted', conversationId: 'thread-1', turnId: 'turn-2',
      payload: { itemId: null, message: marker },
    });
    expect((setup.host.emitEvent.mock.calls[0]?.[1] as { payload: { message: unknown } }).payload.message)
      .not.toBe(marker);
  });

  it.each([
    [true, 'turn-active', true],
    [false, 'turn-other', true],
    [false, 'turn-active', false],
  ] as const)('handles retry=%s error for %s with terminal=%s', (willRetry, turnId, remainsBusy) => {
    const setup = createController({ activeTurnId: 'turn-active', busy: true, turnStartPending: true });
    handle(setup, 'error', {
      threadId: 'thread-1', turnId, willRetry,
      error: { message: 'Failed', codexErrorInfo: null, additionalDetails: null },
    });
    expect(setup.runtime).toMatchObject({
      activeTurnId: remainsBusy ? 'turn-active' : null,
      busy: remainsBusy,
      turnStartPending: remainsBusy,
      error: 'Failed',
    });
    expect(setup.host.patchConversationStatus).toHaveBeenCalledTimes(remainsBusy ? 0 : 1);
    if (!remainsBusy) expect(setup.host.patchConversationStatus).toHaveBeenCalledWith('thread-1', 'error');
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('notification', {
      type: 'turn.error', conversationId: 'thread-1', turnId,
      payload: { error: { message: 'Failed', codexErrorInfo: null, additionalDetails: null }, willRetry },
    });
    expect(setup.host.emitConversationActivity).toHaveBeenCalledWith('thread-1', 'notification');
  });

  it('merges account rate limits and emits a detached authoritative snapshot', () => {
    const setup = createController();
    const rateLimits = {
      limitId: 'codex', limitName: 'Codex',
      primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 150 },
      secondary: null, credits: null, individualLimit: null, planType: 'pro',
      rateLimitReachedType: null,
    };
    handle(setup, 'account/rateLimits/updated', { rateLimits });
    expect(setup.state.rateLimits).toMatchObject({ rateLimits: { limitId: 'codex', primary: { usedPercent: 55 } } });
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('notification', {
      type: 'rateLimits.changed', payload: { rateLimits: setup.state.rateLimits },
    });
    expect((setup.host.emitEvent.mock.calls[0]?.[1] as { payload: { rateLimits: unknown } }).payload.rateLimits)
      .not.toBe(setup.state.rateLimits);
  });

  it('refreshes account state, contains refresh failures, and routes login completion', async () => {
    const success = createController();
    handle(success, 'account/updated', {});
    expect(success.authentication.refresh).toHaveBeenCalledExactlyOnceWith('notification');

    const failure = createController();
    failure.authentication.refresh.mockRejectedValue(new Error('account failed'));
    handle(failure, 'account/updated', {});
    await vi.waitFor(() => expect(failure.state.error).toBe('account failed'));

    const login = createController();
    const params = { loginId: 'login', success: true, error: null };
    handle(login, 'account/login/completed', params);
    expect(login.authentication.handleLoginCompleted).toHaveBeenCalledExactlyOnceWith(params);
  });

  it('projects an exact realtime lifecycle event trace', () => {
    const setup = createController();
    const trace = [
      ['thread/realtime/started', { threadId: 'thread-1', realtimeSessionId: 'rtc', version: 'v2' },
        { type: 'realtime.started', conversationId: 'thread-1', payload: { realtimeSessionId: 'rtc', version: 'v2' } }],
      ['thread/realtime/itemAdded', { threadId: 'thread-1', item: { id: 'item', nested: { value: 1 } } },
        { type: 'realtime.itemAdded', conversationId: 'thread-1', payload: { item: { id: 'item', nested: { value: 1 } } } }],
      ['thread/realtime/transcript/delta', { threadId: 'thread-1', role: 'user', delta: 'partial' },
        { type: 'realtime.transcriptDelta', conversationId: 'thread-1', payload: { role: 'user', delta: 'partial' } }],
      ['thread/realtime/transcript/done', { threadId: 'thread-1', role: 'assistant', text: 'complete' },
        { type: 'realtime.transcriptCompleted', conversationId: 'thread-1', payload: { role: 'assistant', text: 'complete' } }],
      ['thread/realtime/sdp', { threadId: 'thread-1', sdp: 'v=0' },
        { type: 'realtime.sdp', conversationId: 'thread-1', payload: { sdp: 'v=0' } }],
      ['thread/realtime/error', { threadId: 'thread-1', message: 'rtc failed' },
        { type: 'realtime.error', conversationId: 'thread-1', payload: { message: 'rtc failed' } }],
      ['thread/realtime/closed', { threadId: 'thread-1', reason: 'requested' },
        { type: 'realtime.closed', conversationId: 'thread-1', payload: { reason: 'requested' } }],
    ] as const;

    for (const [method, params] of trace) handle(setup, method, params);

    expect(setup.host.emitEvent.mock.calls).toStrictEqual(
      trace.map(([, , event]) => ['notification', event]),
    );
  });

  it('projects realtime audio bytes and metadata', () => {
    const setup = createController();
    handle(setup, 'thread/realtime/outputAudio/delta', {
      threadId: 'thread-1',
      audio: {
        data: 'AQID', sampleRate: 24000, numChannels: 1, samplesPerChannel: 3, itemId: 'audio',
      },
    });
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('notification', {
      type: 'realtime.audioDelta', conversationId: 'thread-1',
      payload: {
        audio: {
          data: new Uint8Array([1, 2, 3]), sampleRate: 24000, numChannels: 1,
          samplesPerChannel: 3, itemId: 'audio',
        },
      },
    });
  });

  it('tolerates every intentionally ignored notification without reporting it unknown', () => {
    const setup = createController();
    const ignored = [
      'hook/started', 'hook/completed', 'item/autoApprovalReview/started',
      'item/autoApprovalReview/completed', 'command/exec/outputDelta', 'process/outputDelta',
      'process/exited', 'item/commandExecution/terminalInteraction', 'item/fileChange/outputDelta',
      'mcpServer/oauthLogin/completed', 'mcpServer/startupStatus/updated', 'app/list/updated',
      'externalAgentConfig/import/progress', 'externalAgentConfig/import/completed', 'fs/changed',
      'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta',
      'model/verification', 'turn/moderationMetadata',
      'model/safetyBuffering/updated', 'warning', 'guardianWarning', 'deprecationNotice',
      'configWarning', 'fuzzyFileSearch/sessionUpdated', 'fuzzyFileSearch/sessionCompleted',
      'windows/worldWritableWarning', 'windowsSandbox/setupCompleted',
    ];
    for (const method of ignored) handle(setup, method, {});
    expect(setup.host.unknownNotification).not.toHaveBeenCalled();
    expect(setup.host.emitEvent).not.toHaveBeenCalled();
  });

  it('projects remote-control status and reports an unknown notification unchanged', () => {
    const setup = createController();
    handle(setup, 'remoteControl/status/changed', {
      status: 'connected', serverName: 'remote', installationId: 'install', environmentId: 'env',
    });
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('notification', {
      type: 'remoteControl.statusChanged',
      payload: { status: { status: 'connected', serverName: 'remote', installationId: 'install', environmentId: 'env' } },
    });

    const notification = { method: 'future/notification', params: { future: true } };
    setup.controller.handle(notification as never);
    expect(setup.host.unknownNotification).toHaveBeenCalledExactlyOnceWith(notification);
  });
});

type SetupOptions = {
  activeTurnId?: string | null;
  approvalPreset?: CodexSurfaceSnapshot['approvalPreset'];
  busy?: boolean;
  goal?: ThreadRuntimeState['goal'];
  models?: CodexSurfaceModel[];
  error?: string | null;
  messages?: ThreadRuntimeState['messages'];
  secondConversation?: boolean;
  selectedModelId?: string | null;
  selectedReasoningEffort?: string | null;
  selectedServiceTier?: string | null;
  planMode?: boolean;
  turnStartPending?: boolean;
};

function createController(options: SetupOptions = {}) {
  const state = initialSurfaceSnapshot(initialAuthentication());
  state.models = options.models ?? [];
  state.approvalPreset = options.approvalPreset ?? null;
  state.conversations = [summary('thread-1', 'Thread one', 'Preview one')];
  if (options.secondConversation) state.conversations.push(summary('thread-2', 'Second', 'Preview two'));
  const runtime = createThreadRuntime('thread-1', state, {
    activeTurnId: options.activeTurnId ?? null,
    approvalPreset: options.approvalPreset ?? null,
    busy: options.busy ?? false,
    cwd: '/project',
    error: options.error ?? null,
    goal: options.goal ?? null,
    messages: options.messages ?? [],
    planMode: options.planMode ?? false,
    selectedModelId: options.selectedModelId ?? null,
    selectedReasoningEffort: options.selectedReasoningEffort ?? null,
    selectedServiceTier: options.selectedServiceTier ?? null,
    turnStartPending: options.turnStartPending ?? false,
  });
  const runtimes = new Map<string, ThreadRuntimeState>([['thread-1', runtime]]);
  const host = {
    clearPendingForThread: vi.fn(),
    createRuntime: vi.fn((threadId: string, patch = {}) => {
      const created = createThreadRuntime(threadId, state, patch);
      runtimes.set(threadId, created);
      return created;
    }),
    emitConversationActivity: vi.fn(),
    emitConversationPermissions: vi.fn(),
    emitConversationSettings: vi.fn(),
    emitConversationSkills: vi.fn(),
    emitEvent: vi.fn(),
    emitSummaryUpserted: vi.fn(),
    getState: vi.fn(() => state),
    markRuntimeTurnActive: vi.fn((target: ThreadRuntimeState, turnId: string) => {
      target.activeTurnId = turnId;
      if (!target.turnIds.includes(turnId)) target.turnIds.push(turnId);
    }),
    patch: vi.fn((patch: Partial<CodexSurfaceSnapshot>) => Object.assign(state, patch)),
    patchConversationStatus: vi.fn((threadId: string, status: 'active' | 'error' | 'idle') => {
      state.conversations = state.conversations.map((candidate) => (
        candidate.id === threadId ? { ...candidate, status } : candidate
      ));
    }),
    patchConversationTurnCount: vi.fn((threadId: string, turnCount: number) => {
      state.conversations = state.conversations.map((candidate) => (
        candidate.id === threadId ? { ...candidate, turnCount } : candidate
      ));
    }),
    patchRuntime: vi.fn((threadId: string, patch: Partial<ThreadRuntimeState>) => {
      Object.assign(requireRuntime(runtimes, threadId), patch);
    }),
    removeThread: vi.fn(),
    requireRuntime: vi.fn((threadId: string) => requireRuntime(runtimes, threadId)),
    runtime: vi.fn((threadId: string) => runtimes.get(threadId)),
    runtimes: vi.fn(() => runtimes.values()),
    sendNextQueuedPrompt: vi.fn(),
    snapshotForRuntime: vi.fn((target: ThreadRuntimeState) => ({ ...state, ...target })),
    unknownNotification: vi.fn(),
  };
  const authentication = { refresh: vi.fn(async () => undefined), handleLoginCompleted: vi.fn() };
  const approvals = { handleServerResolved: vi.fn() };
  const catalog = {
    invalidateSkills: vi.fn(),
    loadSkills: vi.fn(async () => undefined),
    loadConversationCatalogs: vi.fn(async () => ({})),
  };
  const clientRequests = { handleServerResolved: vi.fn() };
  const conversations = { load: vi.fn(async () => undefined) };
  const items = {
    applyAgentDelta: vi.fn(), applyItem: vi.fn(), applyPlanDelta: vi.fn(), applyPlanUpdated: vi.fn(),
    applyRawResponseItem: vi.fn(), applyToolUpdate: vi.fn(), applyTurnCompleted: vi.fn(),
    isForwardingCommandOutput: vi.fn(() => false),
  };
  const controller = new CodexSurfaceNotificationsController(
    authentication as never,
    approvals as never,
    catalog as never,
    clientRequests as never,
    conversations as never,
    items as never,
    host,
  );
  return {
    approvals, authentication, catalog, clientRequests, controller, conversations,
    host, items, runtime, runtimes, state,
  };
}

function handle(setup: ReturnType<typeof createController>, method: string, params: unknown): void {
  setup.controller.handle({ method, params } as never);
}

function requireRuntime(runtimes: Map<string, ThreadRuntimeState>, threadId: string): ThreadRuntimeState {
  const runtime = runtimes.get(threadId);
  if (!runtime) throw new Error(`missing ${threadId}`);
  return runtime;
}

function summary(id: string, title: string, preview: string) {
  return {
    id, title, preview, cwd: '/project', status: 'idle' as const, turnCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function surfaceModel(id: string, runtime: string): CodexSurfaceModel {
  return {
    ...testModel(id, runtime, false), id, model: runtime, displayName: id,
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Medium' },
      { reasoningEffort: 'high', description: 'High' },
    ],
    serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Priority' }],
  };
}

function goalValue() {
  return {
    threadId: 'thread-1', objective: 'Ship', status: 'active' as const, tokenBudget: 100,
    tokensUsed: 10, timeUsedSeconds: 5, createdAt: 1, updatedAt: 2,
  };
}

function message(id: string, role: 'assistant' | 'system' | 'user', turnId: string) {
  return {
    id, role, status: 'complete' as const, turnId, parts: [{ type: 'text' as const, text: id }],
    metadata: { conversationId: 'thread-1', turnId },
  };
}
