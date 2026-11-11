import { describe, expect, it, vi } from 'vitest';
import type { ModelDescriptor } from '../../src/core/codex-client-contracts';
import type { CodexConversationSummary, CodexSnapshot } from '../../src/internal';
import {
  CodexHostConversationSettingsController,
  type CodexHostConversationSettingsDependencies,
} from '../../src/providers/codex/host-conversation-settings-controller';
import { initialAuthentication } from '../../src/providers/codex/host-authentication';
import {
  createThreadRuntime,
  initialHostSnapshot,
  runtimeProjection,
  type ThreadRuntimePatch,
  type ThreadRuntimeState,
} from '../../src/providers/codex/host-runtime';

const models: ModelDescriptor[] = [
  {
    id: 'standard-id', model: 'standard-model', displayName: 'Standard', isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Medium' },
      { reasoningEffort: 'high', description: 'High' },
    ],
    defaultReasoningEffort: 'medium',
    serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Fast' }],
    defaultServiceTier: null,
  },
  {
    id: 'fast-id', model: 'fast-model', displayName: 'Fast',
    supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
    defaultReasoningEffort: 'high',
    serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Fast' }],
    defaultServiceTier: 'priority',
  },
  {
    id: 'alternate-id', model: 'alternate-model', displayName: 'Alternate',
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
    defaultReasoningEffort: 'medium', serviceTiers: [], defaultServiceTier: null,
  },
];

describe('CodexHostConversationSettingsController', () => {
  it('derives the preferred approval preset from every host-default combination', () => {
    const cases = [
      [{ approvalPreset: 'full-access' as const }, 'full-access'],
      [{ approvalMode: 'never' as const, permissionMode: 'full-access' as const }, 'full-access'],
      [{ approvalMode: 'ask' as const, permissionMode: 'workspace-write' as const }, 'ask-for-approval'],
      [{ approvalMode: 'ask' as const, permissionMode: 'full-access' as const }, null],
      [{ approvalMode: 'never' as const }, null],
      [{ permissionMode: 'workspace-write' as const }, null],
      [{}, 'ask-for-approval'],
    ] as const;

    for (const [defaults, expected] of cases) {
      expect(setupSettings({ defaults }).controller.preferredApprovalPreset()).toBe(expected);
    }
  });

  it('selects explicit, preferred, first-available, and legacy thread-start policies', () => {
    const standard = setupSettings();
    expect(standard.controller.threadStartSettings({}, ['ask-for-approval', 'full-access'])).toStrictEqual({
      approvalPolicy: 'on-request', approvalsReviewer: 'user', permissions: ':workspace',
    });
    expect(standard.controller.threadStartSettings(
      { approvalPreset: 'full-access' }, ['ask-for-approval', 'full-access'],
    )).toStrictEqual({
      approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access',
    });
    expect(standard.controller.threadStartSettings({}, ['full-access'])).toStrictEqual({
      approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access',
    });
    expect(standard.controller.threadStartSettings({}, [])).toStrictEqual({
      approvalPolicy: 'never', sandbox: 'read-only',
    });

    const legacy = setupSettings({
      defaults: { approvalMode: 'ask', permissionMode: 'workspace-write' },
    });
    expect(legacy.controller.threadStartSettings(
      { approvalMode: 'never', permissionMode: 'full-access' }, ['ask-for-approval'],
    )).toStrictEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
    expect(legacy.controller.threadStartSettings(
      { approvalMode: 'ask' }, ['ask-for-approval'],
    )).toStrictEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect(legacy.controller.threadStartSettings(
      { permissionMode: 'read-only' }, ['ask-for-approval'],
    )).toStrictEqual({ approvalPolicy: 'on-request', sandbox: 'read-only' });

    const incompatibleLegacy = setupSettings({
      defaults: { approvalMode: 'ask', permissionMode: 'full-access' },
    });
    expect(incompatibleLegacy.controller.threadStartSettings({}, ['ask-for-approval'])).toStrictEqual({
      approvalPolicy: 'on-request', sandbox: 'danger-full-access',
    });
  });

  it('renames only the requested conversation with a normalized title and emits its updated summary', async () => {
    const setup = setupSettings();
    setup.state.conversations = [summary('thread-1'), summary('thread-2')];

    await setup.controller.rename('thread-2', '  New title  ');

    expect(setup.host.ensureThreadReady).toHaveBeenCalledWith('thread-2');
    expect(setup.client.request).toHaveBeenCalledWith('thread/name/set', {
      threadId: 'thread-2', name: 'New title',
    });
    expect(setup.state.conversations).toStrictEqual([
      summary('thread-1'), { ...summary('thread-2'), title: 'New title' },
    ]);
    expect(setup.host.emitSummaryUpserted).toHaveBeenCalledWith(
      { ...summary('thread-2'), title: 'New title' }, 'updated', 'action',
    );
  });

  it('rejects an empty normalized title and does not emit when the renamed summary is absent', async () => {
    const setup = setupSettings();
    await expect(setup.controller.rename('missing', ' \n ')).rejects.toThrow(
      'Conversation title cannot be empty',
    );
    expect(setup.client.request).not.toHaveBeenCalled();

    await setup.controller.rename('missing', 'Valid');
    expect(setup.client.request).toHaveBeenCalledWith('thread/name/set', {
      threadId: 'missing', name: 'Valid',
    });
    expect(setup.host.emitSummaryUpserted).not.toHaveBeenCalled();
  });

  it('updates a zero-thread selection locally and rejects unavailable approval presets before patching', async () => {
    const setup = setupSettings();
    setup.state.activeConversationId = null;

    await expect(setup.controller.update({
      modelId: 'fast-id', reasoningEffort: 'high', serviceTier: 'priority', planMode: true,
      approvalPreset: 'full-access',
    })).resolves.toMatchObject({
      selectedModelId: 'fast-id', selectedReasoningEffort: 'high', selectedServiceTier: 'priority',
      planMode: true, approvalPreset: 'full-access',
    });
    expect(setup.host.patch).toHaveBeenCalledWith({
      selectedModelId: 'fast-id', selectedReasoningEffort: 'high', selectedServiceTier: 'priority',
      planMode: true, approvalPreset: 'full-access',
    });
    expect(setup.client.request).not.toHaveBeenCalled();

    setup.host.patch.mockClear();
    await expect(setup.controller.update({ approvalPreset: 'approve-for-me' })).rejects.toThrow(
      "Approval preset 'approve-for-me' is not available",
    );
    expect(setup.host.patch).not.toHaveBeenCalled();
  });

  it('sends every changed thread setting in one exact app-server update and publishes the new runtime', async () => {
    const setup = setupSettings();

    await setup.controller.updateForThread('thread-1', {
      approvalPreset: 'full-access', modelId: 'fast-id', reasoningEffort: 'high',
      serviceTier: 'priority', planMode: true,
    });

    expect(setup.client.request).toHaveBeenCalledWith('thread/settings/update', {
      threadId: 'thread-1', approvalPolicy: 'never', approvalsReviewer: 'user',
      permissions: ':danger-full-access', model: 'fast-model', effort: 'high',
      serviceTier: 'priority',
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'fast-model', reasoning_effort: 'high', developer_instructions: null },
      },
    });
    expect(setup.runtimes.get('thread-1')).toMatchObject({
      approvalPreset: 'full-access', selectedModelId: 'fast-id',
      selectedReasoningEffort: 'high', selectedServiceTier: 'priority', planMode: true,
    });
    expect(setup.host.emitConversationSettings).toHaveBeenCalledWith('thread-1', 'action');
  });

  it('emits isolated changes with only their protocol fields', async () => {
    const cases = [
      [{ approvalPreset: 'full-access' as const }, {
      approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access',
      }],
      [{ modelId: 'fast-id' }, {
      model: 'fast-model', effort: 'high', serviceTier: null,
      collaborationMode: {
        mode: 'default',
        settings: { model: 'fast-model', reasoning_effort: 'high', developer_instructions: null },
      },
      }],
      [{ reasoningEffort: 'high' }, {
      effort: 'high',
      collaborationMode: {
        mode: 'default',
        settings: { model: 'standard-model', reasoning_effort: 'high', developer_instructions: null },
      },
      }],
      [{ serviceTier: 'priority' }, { serviceTier: 'priority' }],
      [{ planMode: true }, {
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'standard-model', reasoning_effort: 'medium', developer_instructions: null },
      },
      }],
    ] as const;

    for (const [settings, fields] of cases) {
      const setup = setupSettings();
      await setup.controller.updateForThread('thread-1', settings);
      expect(setup.client.request).toHaveBeenCalledWith('thread/settings/update', {
        threadId: 'thread-1', ...fields,
      });
      expect(setup.host.emitConversationSettings).toHaveBeenCalledOnce();
    }
  });

  it('sends and emits an explicit service-tier clear', async () => {
    const setup = setupSettings({ runtimePatch: { selectedServiceTier: 'priority' } });
    await setup.controller.updateForThread('thread-1', { serviceTier: null });
    expect(setup.client.request).toHaveBeenCalledWith('thread/settings/update', {
      threadId: 'thread-1', serviceTier: null,
    });
    expect(setup.host.emitConversationSettings).toHaveBeenCalledOnce();
  });

  it('detects a model-only semantic change when effort and service tier stay the same', async () => {
    const setup = setupSettings();
    await setup.controller.updateForThread('thread-1', { modelId: 'alternate-id' });
    expect(setup.client.request).toHaveBeenCalledWith('thread/settings/update', {
      threadId: 'thread-1', model: 'alternate-model', effort: 'medium', serviceTier: null,
      collaborationMode: {
        mode: 'default',
        settings: { model: 'alternate-model', reasoning_effort: 'medium', developer_instructions: null },
      },
    });
    expect(setup.host.emitConversationSettings).toHaveBeenCalledOnce();
  });

  it('sends an empty settings update without falsely reporting a semantic change', async () => {
    const setup = setupSettings();
    await setup.controller.updateForThread('thread-1', {});
    expect(setup.client.request).toHaveBeenCalledWith('thread/settings/update', { threadId: 'thread-1' });
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('thread-1', {
      approvalPreset: 'ask-for-approval', selectedModelId: 'standard-id',
      selectedReasoningEffort: 'medium', selectedServiceTier: null, planMode: false,
    });
    expect(setup.host.emitConversationSettings).not.toHaveBeenCalled();
  });

  it('rejects a thread approval preset unavailable to that runtime before sending', async () => {
    const setup = setupSettings();
    await expect(setup.controller.updateForThread('thread-1', {
      approvalPreset: 'approve-for-me',
    })).rejects.toThrow("Approval preset 'approve-for-me' is not available");
    expect(setup.client.request).not.toHaveBeenCalled();
    expect(setup.host.patchRuntime).not.toHaveBeenCalled();
  });

  it('creates a conversation when needed, normalizes a goal, and emits the authoritative response', async () => {
    const setup = setupSettings({ activeConversationId: null });
    const responseGoal = goal('created-thread', 'Ship safely', 800);
    setup.client.request.mockResolvedValue({ goal: responseGoal });
    setup.host.createConversation.mockImplementation(async () => {
      setup.state.activeConversationId = 'created-thread';
      setup.createRuntime('created-thread');
    });

    await expect(setup.controller.setGoal('  Ship safely  ', 800)).resolves.toBe(setup.state);

    expect(setup.host.ensureConnected).toHaveBeenCalledOnce();
    expect(setup.host.createConversation).toHaveBeenCalledOnce();
    expect(setup.client.request).toHaveBeenCalledWith('thread/goal/set', {
      threadId: 'created-thread', objective: 'Ship safely', status: 'active', tokenBudget: 800,
    });
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('created-thread', { goal: responseGoal });
    expect(setup.host.emitEvent).toHaveBeenCalledWith('action', {
      type: 'conversation.goalChanged', conversationId: 'created-thread',
      payload: { goal: responseGoal },
    });
    const emitted = setup.host.emitEvent.mock.calls[0]![1] as { payload: { goal: unknown } };
    expect(emitted.payload.goal).not.toBe(responseGoal);
  });

  it('omits an unspecified goal budget, suppresses an unchanged event, and still refreshes runtime state', async () => {
    const existing = goal('thread-1', 'Same goal', null);
    const setup = setupSettings({ runtimePatch: { goal: existing } });
    setup.client.request.mockResolvedValue({ goal: { ...existing } });

    await setup.controller.setGoalForThread('thread-1', ' Same goal ');

    expect(setup.client.request).toHaveBeenCalledWith('thread/goal/set', {
      threadId: 'thread-1', objective: 'Same goal', status: 'active',
    });
    const params = setup.client.request.mock.calls[0]![1] as Record<string, unknown>;
    expect(params).not.toHaveProperty('tokenBudget');
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('thread-1', { goal: existing });
    expect(setup.host.emitEvent).not.toHaveBeenCalled();
  });

  it('sets a goal on the active conversation without creating a replacement thread', async () => {
    const setup = setupSettings();
    setup.client.request.mockResolvedValue({ goal: goal('thread-1', 'Keep thread', null) });

    await setup.controller.setGoal('Keep thread', null);

    expect(setup.host.createConversation).not.toHaveBeenCalled();
    expect(setup.client.request).toHaveBeenCalledWith('thread/goal/set', {
      threadId: 'thread-1', objective: 'Keep thread', status: 'active', tokenBudget: null,
    });
  });

  it('rejects empty goals, missing created threads, and mismatched authoritative goal responses', async () => {
    const setup = setupSettings();
    await expect(setup.controller.setGoalForThread('thread-1', ' \n ')).rejects.toThrow(
      'Goal objective cannot be empty',
    );
    expect(setup.client.request).not.toHaveBeenCalled();

    setup.client.request.mockResolvedValue({ goal: goal('other-thread', 'Wrong thread', null) });
    await expect(setup.controller.setGoalForThread('thread-1', 'Wrong thread')).rejects.toThrow(
      "Codex thread/goal/set returned a goal for 'other-thread' instead of 'thread-1'",
    );
    expect(setup.host.patchRuntime).not.toHaveBeenCalled();

    const missing = setupSettings({ activeConversationId: null });
    await expect(missing.controller.setGoal('New goal')).rejects.toThrow(
      'Codex did not create a conversation',
    );
  });

  it('clears an active goal and emits exactly one authoritative null transition', async () => {
    const setup = setupSettings({ runtimePatch: { goal: goal('thread-1', 'Existing', null) } });

    await expect(setup.controller.clearGoal()).resolves.toBe(setup.state);

    expect(setup.host.ensureConnected).toHaveBeenCalledOnce();
    expect(setup.client.request).toHaveBeenCalledWith('thread/goal/clear', { threadId: 'thread-1' });
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('thread-1', { goal: null });
    expect(setup.host.emitEvent).toHaveBeenCalledWith('action', {
      type: 'conversation.goalChanged', conversationId: 'thread-1', payload: { goal: null },
    });
  });

  it('returns immediately without an active thread and suppresses duplicate clear-goal events', async () => {
    const inactive = setupSettings({ activeConversationId: null });
    await expect(inactive.controller.clearGoal()).resolves.toBe(inactive.state);
    expect(inactive.client.request).not.toHaveBeenCalled();

    const empty = setupSettings();
    await empty.controller.clearGoalForThread('thread-1');
    expect(empty.client.request).toHaveBeenCalledWith('thread/goal/clear', { threadId: 'thread-1' });
    expect(empty.host.patchRuntime).toHaveBeenCalledWith('thread-1', { goal: null });
    expect(empty.host.emitEvent).not.toHaveBeenCalled();
  });
});

function setupSettings(options: {
  activeConversationId?: string | null;
  defaults?: ConstructorParameters<typeof CodexHostConversationSettingsController>[1];
  runtimePatch?: ThreadRuntimePatch;
} = {}) {
  const state = initialHostSnapshot(initialAuthentication());
  Object.assign(state, {
    activeConversationId: options.activeConversationId === undefined ? 'thread-1' : options.activeConversationId,
    models,
    approvalPresets: ['ask-for-approval', 'full-access'],
    approvalPreset: 'ask-for-approval',
    selectedModelId: 'standard-id',
    selectedReasoningEffort: 'medium',
    selectedServiceTier: null,
  });
  const runtimes = new Map<string, ThreadRuntimeState>();
  const createRuntime = (threadId: string, patch: ThreadRuntimePatch = {}) => {
    const runtime = createThreadRuntime(threadId, state, patch);
    runtimes.set(threadId, runtime);
    return runtime;
  };
  if (state.activeConversationId) createRuntime(state.activeConversationId, options.runtimePatch);

  const client = {
    request: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({})),
  };
  const host = {
    createConversation: vi.fn(async () => undefined),
    emitConversationSettings: vi.fn(),
    emitEvent: vi.fn(),
    emitSummaryUpserted: vi.fn(),
    ensureConnected: vi.fn(async () => undefined),
    ensureThreadReady: vi.fn(async (threadId: string) => {
      const runtime = runtimes.get(threadId);
      if (!runtime) return createRuntime(threadId);
      return runtime;
    }),
    getSnapshot: vi.fn(() => state),
    getState: vi.fn(() => state),
    patch: vi.fn((patch: Partial<CodexSnapshot>) => Object.assign(state, patch)),
    patchRuntime: vi.fn((threadId: string, patch: ThreadRuntimePatch) => {
      const runtime = runtimes.get(threadId);
      if (runtime) Object.assign(runtime, patch);
      if (state.activeConversationId === threadId) Object.assign(state, patch);
    }),
    snapshotForRuntime: vi.fn((runtime: ThreadRuntimeState) => ({
      ...state, ...runtimeProjection(runtime, [], []), activeConversationId: runtime.threadId,
    })),
  } satisfies CodexHostConversationSettingsDependencies;
  const controller = new CodexHostConversationSettingsController(
    client as never, options.defaults ?? {}, host,
  );
  return { client, controller, createRuntime, host, runtimes, state };
}

function summary(id: string): CodexConversationSummary {
  return {
    id, title: id, preview: '', cwd: `/workspace/${id}`, status: 'idle', turnCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function goal(threadId: string, objective: string, tokenBudget: number | null) {
  return {
    threadId, objective, status: 'active' as const, tokenBudget,
    tokensUsed: 10, timeUsedSeconds: 20, createdAt: 1, updatedAt: 2,
  };
}
