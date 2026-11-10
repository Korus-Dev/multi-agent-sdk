import { describe, expect, it, vi } from 'vitest';
import type {
  CodexConversationSummary,
  CodexHostSnapshot,
  ConversationMessage,
} from '../../src/index';
import { CodexHostRuntimeController } from '../../src/providers/codex/host-runtime-controller';
import { initialAuthentication } from '../../src/providers/codex/host-authentication';
import { initialHostSnapshot } from '../../src/providers/codex/host-runtime';

describe('CodexHostRuntimeController', () => {
  it('creates, patches, requires, forgets, and clears isolated runtimes', () => {
    const { controller } = setupRuntimeController();
    expect(controller.get('thread-1')).toBeUndefined();

    const first = controller.create('thread-1', { cwd: '/one' });
    expect(controller.get('thread-1')).toBe(first);
    expect([...controller.values()]).toStrictEqual([first]);
    expect(controller.create('thread-1', { busy: true })).toBe(first);
    expect(first).toMatchObject({ cwd: '/one', busy: true });
    expect(controller.require('thread-2').threadId).toBe('thread-2');

    controller.forget('thread-1');
    expect(controller.get('thread-1')).toBeUndefined();
    expect(controller.get('thread-2')).toBeDefined();
    controller.clear();
    expect([...controller.values()]).toStrictEqual([]);
  });

  it('resets semantic event deduplication when a runtime is forgotten or all runtimes are cleared', () => {
    const setup = setupRuntimeController();
    const value = summary('thread-1');
    const runtime = setup.controller.create('thread-1');
    setup.controller.emitSummaryUpserted(value, 'updated', 'action');
    setup.controller.emitConversationActivity('thread-1', 'action');
    setup.controller.emitConversationSettings('thread-1', 'action');
    expect(setup.host.emitEvent).toHaveBeenCalledTimes(3);

    setup.controller.forget('thread-1');
    setup.controller.create('thread-1', runtime);
    setup.controller.emitSummaryUpserted(value, 'updated', 'action');
    setup.controller.emitConversationActivity('thread-1', 'action');
    setup.controller.emitConversationSettings('thread-1', 'action');
    expect(setup.host.emitEvent).toHaveBeenCalledTimes(6);

    setup.controller.clear();
    setup.controller.create('thread-1', runtime);
    setup.controller.emitSummaryUpserted(value, 'updated', 'action');
    expect(setup.host.emitEvent).toHaveBeenCalledTimes(7);
  });

  it('projects approvals and client requests into snapshots without losing global state', () => {
    const approval = { id: 'approval-1' };
    const request = { id: 'request-1' };
    const setup = setupRuntimeController([approval], [request]);
    setup.state.status = 'ready';
    const runtime = setup.controller.create('thread-1', { busy: true });

    expect(setup.controller.projection(runtime)).toMatchObject({
      approvals: [approval],
      clientRequests: [request],
      busy: true,
    });
    expect(setup.controller.snapshot(runtime)).toMatchObject({
      status: 'ready',
      approvals: [approval],
      clientRequests: [request],
      busy: true,
    });
    expect(setup.approvalsForThread).toHaveBeenCalledWith('thread-1');
    expect(setup.requestsForThread).toHaveBeenCalledWith('thread-1');
  });

  it('activates a runtime and emits its public selection event', () => {
    const setup = setupRuntimeController();
    const runtime = setup.controller.create('thread-1', { busy: true });
    setup.controller.activate(runtime);

    expect(setup.state).toMatchObject({ activeConversationId: 'thread-1', busy: true });
    expect(setup.host.emitEvent).toHaveBeenCalledWith('action', {
      type: 'conversation.selected',
      payload: { conversationId: 'thread-1' },
    });
  });

  it('emits the current host status and error', () => {
    const setup = setupRuntimeController();
    setup.state.status = 'error';
    setup.state.error = 'disconnected';
    setup.controller.emitHostStatus('lifecycle');

    expect(setup.host.emitEvent).toHaveBeenCalledWith('lifecycle', {
      type: 'host.statusChanged',
      payload: { status: 'error', error: 'disconnected' },
    });
  });

  it('projects active runtime patches and only notifies listeners for background runtimes', () => {
    const setup = setupRuntimeController();
    setup.controller.create('active');
    setup.controller.create('background');
    setup.state.activeConversationId = 'active';

    setup.controller.patch('active', { busy: true, error: 'active error' });
    expect(setup.state).toMatchObject({ busy: true, error: 'active error' });
    expect(setup.host.patch).toHaveBeenLastCalledWith(expect.objectContaining({ busy: true }), 'active');
    expect(setup.host.notifyConversationListeners).not.toHaveBeenCalled();

    setup.controller.patch('background', { busy: true });
    expect(setup.controller.get('background')?.busy).toBe(true);
    expect(setup.host.notifyConversationListeners).toHaveBeenCalledWith('background');
  });

  it('emits changed summaries once while still scheduling every plugin refresh', () => {
    const setup = setupRuntimeController();
    const value = summary('thread-1');
    setup.controller.emitSummaryUpserted(value, 'created', 'action');
    setup.controller.emitSummaryUpserted({ ...value }, 'updated', 'notification');

    expect(setup.host.schedulePluginRefresh).toHaveBeenCalledTimes(2);
    expect(setup.host.emitEvent).toHaveBeenCalledOnce();
    expect(setup.host.emitEvent).toHaveBeenCalledWith('action', {
      type: 'conversation.summaryUpserted',
      conversationId: 'thread-1',
      payload: { summary: value, reason: 'created' },
    });

    setup.controller.emitSummaryUpserted({ ...value, preview: 'changed' }, 'updated', 'notification');
    expect(setup.host.emitEvent).toHaveBeenCalledTimes(2);
    expect(setup.host.emitEvent).toHaveBeenLastCalledWith('notification', expect.objectContaining({
      type: 'conversation.summaryUpserted',
      payload: expect.objectContaining({ reason: 'updated', summary: expect.objectContaining({ preview: 'changed' }) }),
    }));
  });

  it('deduplicates activity and settings events by their complete semantic payloads', () => {
    const setup = setupRuntimeController();
    const runtime = setup.controller.create('thread-1', {
      approvalPreset: 'ask-for-approval',
      busy: true,
      error: 'waiting',
      planMode: true,
      selectedModelId: 'model-1',
      selectedReasoningEffort: 'high',
      selectedServiceTier: 'fast',
      threadStatus: { type: 'active', activeFlags: ['waitingOnApproval'] },
    });

    setup.controller.emitConversationActivity('thread-1', 'notification');
    setup.controller.emitConversationActivity('thread-1', 'action');
    expect(setup.host.emitEvent).toHaveBeenCalledOnce();
    expect(setup.host.emitEvent).toHaveBeenLastCalledWith('notification', {
      type: 'conversation.activityChanged',
      conversationId: 'thread-1',
      payload: {
        threadStatus: { type: 'active', activeFlags: ['waitingOnApproval'] },
        busy: true,
        error: 'waiting',
      },
    });
    runtime.busy = false;
    setup.controller.emitConversationActivity('thread-1', 'action');
    expect(setup.host.emitEvent).toHaveBeenCalledTimes(2);

    setup.host.emitEvent.mockClear();
    setup.controller.emitConversationSettings('thread-1', 'notification');
    setup.controller.emitConversationSettings('thread-1', 'action');
    expect(setup.host.emitEvent).toHaveBeenCalledOnce();
    expect(setup.host.emitEvent).toHaveBeenLastCalledWith('notification', {
      type: 'conversation.settingsChanged',
      conversationId: 'thread-1',
      payload: {
        approvalPreset: 'ask-for-approval',
        selectedModelId: 'model-1',
        selectedReasoningEffort: 'high',
        selectedServiceTier: 'fast',
        planMode: true,
      },
    });
    runtime.planMode = false;
    setup.controller.emitConversationSettings('thread-1', 'action');
    expect(setup.host.emitEvent).toHaveBeenCalledTimes(2);
  });

  it('emits skills, permissions, and full history as detached payloads', () => {
    const setup = setupRuntimeController();
    const runtime = setup.controller.create('thread-1', {
      activeTurnId: 'turn-2',
      approvalPresets: ['ask-for-approval'],
      busy: true,
      cwd: '/workspace',
      historyHasOlder: true,
      historyLoadingOlder: true,
      messages: [message('assistant', 'assistant')],
      permissionProfiles: [{ id: ':workspace', description: null, allowed: true }],
      skillCatalogStatus: 'loaded',
      skills: [{ name: 'review', path: '/skills/review/SKILL.md', enabled: true }],
      threadStatus: { type: 'idle' },
      turnIds: ['turn-1', 'turn-2'],
      turns: [completedTurn('turn-1'), completedTurn('turn-2')],
    });

    setup.controller.emitConversationSkills('thread-1', 'action');
    setup.controller.emitConversationPermissions('thread-1', 'notification');
    setup.controller.emitHistoryReplaced('thread-1', 'resync', 'action');

    expect(setup.host.emitEvent).toHaveBeenNthCalledWith(1, 'action', {
      type: 'conversation.skillsChanged',
      conversationId: 'thread-1',
      payload: { cwd: '/workspace', skills: runtime.skills, status: 'loaded' },
    });
    expect(setup.host.emitEvent).toHaveBeenNthCalledWith(2, 'notification', {
      type: 'conversation.permissionsChanged',
      conversationId: 'thread-1',
      payload: {
        cwd: '/workspace',
        permissionProfiles: runtime.permissionProfiles,
        approvalPresets: ['ask-for-approval'],
      },
    });
    expect(setup.host.emitEvent).toHaveBeenNthCalledWith(3, 'action', {
      type: 'conversation.historyReplaced',
      conversationId: 'thread-1',
      payload: {
        reason: 'resync',
        messages: runtime.messages,
        threadStatus: { type: 'idle' },
        state: expect.objectContaining({
          activeTurnId: 'turn-2',
          busy: true,
          turnIds: ['turn-1', 'turn-2'],
          turns: runtime.turns,
          historyState: expect.objectContaining({ hasOlder: true, loadingOlder: true }),
        }),
      },
    });
    expect(setup.host.emitEvent.mock.calls[0]![1].payload.skills).not.toBe(runtime.skills);
  });

  it('skips empty prepends and rematerializes prepended messages from current state', () => {
    const setup = setupRuntimeController();
    const current = message('same', 'assistant', [{ type: 'text', text: 'current' }]);
    setup.controller.create('thread-1', { messages: [current] });
    setup.controller.emitHistoryPrepended('thread-1', [], 'action');
    expect(setup.host.emitEvent).not.toHaveBeenCalled();

    const historical = message('same', 'assistant', [{ type: 'text', text: 'historical' }]);
    const missing = message('missing', 'user');
    setup.controller.emitHistoryPrepended('thread-1', [historical, missing], 'notification');
    expect(setup.host.emitEvent).toHaveBeenCalledWith('notification', {
      type: 'conversation.historyPrepended',
      conversationId: 'thread-1',
      payload: {
        messages: [current, missing],
        state: expect.objectContaining({
          turnIds: [],
          turns: [],
          historyState: expect.any(Object),
        }),
      },
    });
    expect(setup.host.emitEvent.mock.calls[0]![1].payload.messages).not.toBe(setup.controller.get('thread-1')?.messages);
  });

  it('finds the matching tool message and the latest ordinary assistant message for a turn', () => {
    const setup = setupRuntimeController();
    const older = message('older', 'assistant', [], { turnId: 'turn-1' });
    const tool = message('tool-message', 'assistant', [{ type: 'tool', id: 'tool-1' }], { turnId: 'turn-1' });
    const textWithId = message('text-id', 'assistant', [{ type: 'text', id: 'tool-1', text: 'no' }], { turnId: 'turn-1' });
    const wrongTool = message('wrong-tool', 'assistant', [{ type: 'tool', id: 'other' }], { turnId: 'turn-1' });
    const noMetadata = message('no-metadata', 'assistant');
    const noMetadataLatest = message('no-metadata-latest', 'assistant');
    const special = { ...message('special', 'assistant', [], { turnId: 'turn-1' }), kind: 'steer' as const };
    const user = message('user', 'user', [], { turnId: 'turn-1' });
    setup.controller.create('thread-1', {
      messages: [noMetadata, textWithId, wrongTool, older, tool, user, special, noMetadataLatest],
    });

    expect(setup.controller.messageContainingTool('thread-1', 'turn-1', 'tool-1')).toBe(tool);
    expect(setup.controller.messageContainingTool('thread-1', 'other', 'tool-1')).toBeNull();
    expect(setup.controller.messageContainingTool('thread-1', 'turn-1', 'missing')).toBeNull();
    expect(setup.controller.assistantMessageForTurn('thread-1', 'turn-1')).toBe(tool);
    expect(setup.controller.assistantMessageForTurn('thread-1', 'missing')).toBeNull();
  });

  it('marks turns active without duplicating an existing turn id', () => {
    const setup = setupRuntimeController();
    const runtime = setup.controller.create('thread-1', { turnIds: ['turn-1'], turnStartPending: true });
    setup.controller.markTurnActive(runtime, 'turn-1');
    expect(runtime).toMatchObject({ activeTurnId: 'turn-1', busy: true, turnStartPending: false });
    expect(runtime.turnIds).toStrictEqual(['turn-1']);

    setup.controller.markTurnActive(runtime, 'turn-2');
    expect(runtime.turnIds).toStrictEqual(['turn-1', 'turn-2']);
  });

  it('patches only the matching conversation status and turn count and emits each summary', () => {
    const setup = setupRuntimeController();
    const first = summary('thread-1');
    const second = summary('thread-2');
    setup.state.conversations = [first, second];

    setup.controller.patchConversationStatus('thread-2', 'active', 'action');
    expect(setup.state.conversations[0]).toBe(first);
    expect(setup.state.conversations[1]).toMatchObject({ id: 'thread-2', status: 'active' });
    expect(setup.host.emitEvent).toHaveBeenLastCalledWith('action', expect.objectContaining({
      type: 'conversation.summaryUpserted',
      conversationId: 'thread-2',
      payload: expect.objectContaining({ reason: 'updated' }),
    }));

    setup.host.emitEvent.mockClear();
    setup.controller.patchConversationTurnCount('thread-2', 7);
    expect(setup.state.conversations[0]).toMatchObject({ id: 'thread-1', turnCount: 0 });
    expect(setup.state.conversations[1]).toMatchObject({ id: 'thread-2', turnCount: 7 });
    expect(setup.host.emitEvent).toHaveBeenCalledWith('notification', expect.objectContaining({
      type: 'conversation.summaryUpserted',
      conversationId: 'thread-2',
      payload: expect.objectContaining({ reason: 'updated' }),
    }));

    setup.host.emitEvent.mockClear();
    setup.controller.patchConversationStatus('missing', 'error');
    expect(setup.host.emitEvent).not.toHaveBeenCalled();

    setup.controller.patchConversationStatus('thread-1', 'error');
    expect(setup.host.emitEvent).toHaveBeenCalledWith('notification', expect.objectContaining({
      type: 'conversation.summaryUpserted',
      conversationId: 'thread-1',
      payload: expect.objectContaining({ reason: 'updated' }),
    }));
  });
});

function setupRuntimeController(approvals: unknown[] = [], requests: unknown[] = []) {
  const state = initialHostSnapshot(initialAuthentication());
  const approvalsForThread = vi.fn(() => approvals);
  const requestsForThread = vi.fn(() => requests);
  const host = {
    emitEvent: vi.fn(),
    getState: vi.fn(() => state),
    notifyConversationListeners: vi.fn(),
    patch: vi.fn((patch: Partial<CodexHostSnapshot>) => Object.assign(state, patch)),
    schedulePluginRefresh: vi.fn(),
  };
  const controller = new CodexHostRuntimeController(
    { approvalsForThread } as never,
    { requestsForThread } as never,
    host,
  );
  return { approvalsForThread, controller, host, requestsForThread, state };
}

function summary(id: string): CodexConversationSummary {
  return {
    id,
    title: `Title ${id}`,
    preview: `Preview ${id}`,
    cwd: `/workspace/${id}`,
    status: 'idle',
    turnCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function message(
  id: string,
  role: ConversationMessage['role'],
  parts: unknown[] = [],
  metadata?: Record<string, unknown>,
): ConversationMessage {
  return { id, role, status: 'complete', parts, metadata } as ConversationMessage;
}

function completedTurn(id: string) {
  return {
    id,
    status: 'completed' as const,
    error: null,
    willRetry: false,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}
