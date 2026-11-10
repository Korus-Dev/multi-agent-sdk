import { describe, expect, it, vi } from 'vitest';
import type { CodexSurfaceModel, CodexSurfaceSnapshot, SurfaceMessage } from 'multi-agents-sdk/surface';
import type { CodexAppServerClient, v2 } from '../../../codex-sdk/src/protocol';
import { initialAuthentication } from '../../src/providers/codex/codex-surface-authentication';
import { CodexSurfaceForkController } from '../../src/providers/codex/codex-surface-fork-controller';
import { createThreadRuntime, initialSurfaceSnapshot } from '../../src/providers/codex/codex-surface-runtime';
import { thread, turn } from './helpers/codex-surface-fixture';

describe('CodexSurfaceForkController', () => {
  it('rejects an unbounded fork while the source has an active turn', async () => {
    const busy = createController({ busy: true });
    await expect(busy.controller.fork('source'))
      .rejects.toThrow('Cannot fork a conversation while its current turn is still active');
    expect(busy.catalog.loadConversationCatalogs).not.toHaveBeenCalled();

    const active = createController({ activeTurnId: 'active' });
    await expect(active.controller.fork('source', {}, {}, { lastTurnId: 'active' }))
      .rejects.toThrow('Cannot fork a conversation while its current turn is still active');
    expect(active.request).not.toHaveBeenCalled();
  });

  it('allows an explicit earlier boundary while the latest turn is active', async () => {
    const setup = createController({ busy: true, activeTurnId: 'active' });

    await expect(setup.controller.fork('source', {}, {}, { lastTurnId: 'earlier' }))
      .resolves.toBe('forked');

    expect(paramsFor(setup.request, 'thread/fork')).toMatchObject({ lastTurnId: 'earlier' });
  });

  it('forks with exact default protocol, history, runtime, host memory, and events', async () => {
    const historyTurn = turnWithMessages('history', 'Request', 'Reply');
    const setup = createController({ history: [historyTurn], historyCursor: null });

    await expect(setup.controller.fork('source')).resolves.toBe('forked');

    expect(setup.catalog.loadConversationCatalogs).toHaveBeenCalledExactlyOnceWith('/source');
    expect(setup.extensions.conversationExtension).toHaveBeenCalledExactlyOnceWith({
      operation: 'start', conversationId: null, cwd: '/source', createOptions: {}, extensionContext: undefined,
    }, {}, [{ name: 'default' }]);
    expect(paramsFor(setup.request, 'thread/fork')).toStrictEqual({
      threadId: 'source', excludeTurns: true, deferGoalContinuation: true,
    });
    expect(paramsFor(setup.request, 'thread/turns/list')).toStrictEqual({
      threadId: 'forked', cursor: null, limit: 5, sortDirection: 'desc', itemsView: 'full',
    });
    expect(paramsFor(setup.request, 'thread/goal/get')).toStrictEqual({ threadId: 'forked' });
    expect(setup.createdRuntime).toMatchObject({
      threadId: 'forked', hydrated: true, historyMode: 'paginated', loadingStrategy: 'lazy', historyCursor: null,
      historyHasOlder: false, historyLoadingOlder: false, fullHistoryHydrated: true, cwd: '/forked',
      activeTurnId: null, turnIds: ['history'], busy: false, goal: { objective: 'Ship' },
    });
    expect(setup.createdRuntime?.messages).toEqual([
      expect.objectContaining({ role: 'user', turnId: 'history' }),
      expect.objectContaining({ role: 'assistant', turnId: 'history' }),
    ]);
    expect(setup.host.rememberHostOptions).toHaveBeenCalledExactlyOnceWith('forked', {
      cwd: '/forked', loadingStrategy: 'lazy', historyItemsView: 'full', mcpServers: [{ name: 'default' }],
    });
    expect(setup.state.conversations).toEqual([
      expect.objectContaining({ id: 'source' }),
      expect.objectContaining({ id: 'forked', turnCount: 1 }),
    ]);
    expectEmissions(setup);
  });

  it('applies exact fork extensions, settings, approvals, and selected overrides', async () => {
    const requested = model('requested', 'requested-runtime');
    const setup = createController({
      models: [requested],
      extension: {
        baseInstructions: '',
        developerInstructions: 'developer',
        config: { extension: true },
      },
      response: forkResponse({ model: 'requested-runtime', serviceTier: 'priority', cwd: '/response' }),
    });

    await setup.controller.fork('source', {
      approvalPreset: 'full-access',
      cwd: '/option',
      model: 'requested',
      reasoningEffort: 'high',
      serviceTier: 'priority',
    }, {
      cwd: '/host',
      extensionContext: { agent: 'one' },
      loadingStrategy: 'eager',
      mcpServers: [{ name: 'custom', transport: { type: 'stdio', command: 'server' } }],
    }, { beforeTurnId: 'before', lastTurnId: 'last' });

    expect(setup.catalog.loadConversationCatalogs).toHaveBeenCalledWith('/option');
    expect(paramsFor(setup.request, 'thread/fork')).toStrictEqual({
      threadId: 'source', beforeTurnId: 'before', lastTurnId: 'last',
      excludeTurns: true, deferGoalContinuation: true,
      cwd: '/option', model: 'requested-runtime', serviceTier: 'priority',
      baseInstructions: '', developerInstructions: 'developer', config: { extension: true },
      approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access',
    });
    expect(paramsFor(setup.request, 'thread/settings/update')).toStrictEqual({
      threadId: 'forked', effort: 'high',
      collaborationMode: {
        mode: 'default',
        settings: { model: 'requested-runtime', reasoning_effort: 'high', developer_instructions: null },
      },
    });
    expect(setup.createdRuntime).toMatchObject({
      cwd: '/response', loadingStrategy: 'eager', selectedModelId: 'requested',
      selectedReasoningEffort: 'high', selectedServiceTier: 'priority',
    });
    expect(setup.host.rememberHostOptions).toHaveBeenCalledWith('forked', {
      cwd: '/response', extensionContext: { agent: 'one' }, loadingStrategy: 'eager', historyItemsView: 'full',
      mcpServers: [{ name: 'custom', transport: { type: 'stdio', command: 'server' } }],
    });
  });

  it.each([
    [{ reasoningEffort: 'unsupported' }, "Reasoning effort 'unsupported' is not available for 'requested'"],
    [{ serviceTier: 'unsupported' }, "Service tier 'unsupported' is not available for 'requested'"],
  ] as const)('rejects an unsupported model setting before forking', async (selection, message) => {
    const setup = createController({ models: [model('requested', 'requested-runtime')] });

    await expect(setup.controller.fork('source', { model: 'requested', ...selection }))
      .rejects.toThrow(message);

    expect(setup.request).not.toHaveBeenCalled();
  });

  it('does not turn inherited model and session settings into explicit fork overrides', async () => {
    const inherited = model('inherited', 'inherited-runtime');
    const responseModel = model('response', 'response-runtime');
    const setup = createController({
      models: [inherited, responseModel],
      response: forkResponse({
        model: 'response-runtime',
        reasoningEffort: 'medium',
        serviceTier: 'flex',
      }),
      selectedModelId: 'inherited',
    });

    await setup.controller.fork('source');

    expect(paramsFor(setup.request, 'thread/fork')).not.toHaveProperty('model');
    expect(setup.request).not.toHaveBeenCalledWith('thread/settings/update', expect.anything());
    expect(setup.createdRuntime).toMatchObject({
      selectedModelId: 'response',
      selectedReasoningEffort: 'medium',
      selectedServiceTier: 'flex',
    });
  });

  it('preserves an explicit null service tier over the fork response', async () => {
    const requested = model('requested', 'requested-runtime');
    const setup = createController({
      models: [requested],
      response: forkResponse({ model: 'requested-runtime', serviceTier: 'priority' }),
    });

    await setup.controller.fork('source', { model: 'requested', serviceTier: null });

    expect(paramsFor(setup.request, 'thread/fork')).toHaveProperty('serviceTier', null);
    expect(setup.createdRuntime?.selectedServiceTier).toBeNull();
  });

  it('keeps explicit model and reasoning selections over differing fork response values', async () => {
    const requested = model('requested', 'requested-runtime');
    const responseModel = model('response', 'response-runtime');
    const setup = createController({
      models: [requested, responseModel],
      response: forkResponse({ model: 'response-runtime', reasoningEffort: 'low' }),
    });

    await setup.controller.fork('source', { model: 'requested', reasoningEffort: 'high' });

    expect(setup.createdRuntime).toMatchObject({
      selectedModelId: 'requested',
      selectedReasoningEffort: 'high',
    });
  });

  it('uses host cwd only when option and source cwd are absent', async () => {
    const setup = createController({ sourceCwd: null });
    await setup.controller.fork('source', {}, { cwd: '/host' });
    expect(setup.catalog.loadConversationCatalogs).toHaveBeenCalledWith('/host');
    expect(setup.extensions.conversationExtension).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/host' }), {}, [{ name: 'default' }],
    );
    expect(paramsFor(setup.request, 'thread/fork')).not.toHaveProperty('cwd');
  });

  it('maps legacy approval and permission modes and rejects unavailable presets', async () => {
    const ask = createController();
    await ask.controller.fork('source', { approvalMode: 'ask', permissionMode: 'read-only' });
    expect(paramsFor(ask.request, 'thread/fork')).toMatchObject({
      approvalPolicy: 'on-request', sandbox: 'read-only',
    });

    const never = createController();
    await never.controller.fork('source', { approvalMode: 'never', permissionMode: 'full-access' });
    expect(paramsFor(never.request, 'thread/fork')).toMatchObject({
      approvalPolicy: 'never', sandbox: 'danger-full-access',
    });

    const invalid = createController();
    await expect(invalid.controller.fork('source', { approvalPreset: 'missing' as never }))
      .rejects.toThrow("Approval preset 'missing' is not available");
    expect(invalid.request).not.toHaveBeenCalled();
  });

  it.each(['', 'source'])('rejects invalid forked thread id %j', async (id) => {
    const setup = createController({ response: forkResponse({ thread: thread(id, false) }) });
    await expect(setup.controller.fork('source'))
      .rejects.toThrow(`invalid new thread id '${id}'`);
    expect(setup.host.createRuntime).not.toHaveBeenCalled();
  });

  it('continues with a null goal when goal lookup fails', async () => {
    const setup = createController({ rejectGoal: true });
    await setup.controller.fork('source');
    expect(setup.createdRuntime?.goal).toBeNull();
  });

  it('projects a running initial turn and preserves lazy next-page state', async () => {
    const setup = createController({
      history: [turnWithMessages('running', 'Request', '', 'inProgress')],
      historyCursor: 'next',
    });

    await setup.controller.fork('source');

    expect(setup.createdRuntime).toMatchObject({
      activeTurnId: 'running', busy: true, historyCursor: 'next',
      historyHasOlder: true, fullHistoryHydrated: false,
    });
    expect(setup.createdRuntime?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', status: 'streaming', turnId: 'running' }),
    ]));
    expect(setup.host.hydrateCompleteHistory).not.toHaveBeenCalled();
  });

  it('preserves paginated history mode from the fork response', async () => {
    const setup = createController({
      response: forkResponse({ thread: { ...thread('forked', false), historyMode: 'paginated' } }),
    });

    await setup.controller.fork('source');

    expect(setup.createdRuntime?.historyMode).toBe('paginated');
  });

  it('reverses the descending history page into chronological runtime order', async () => {
    const setup = createController({
      history: [
        turnWithMessages('newer', 'New request', 'New reply'),
        turnWithMessages('older', 'Old request', 'Old reply'),
      ],
    });

    await setup.controller.fork('source');

    expect(setup.createdRuntime?.turnIds).toEqual(['older', 'newer']);
    expect(setup.createdRuntime?.messages.map((message) => message.turnId)).toEqual([
      'older', 'older', 'newer', 'newer',
    ]);
  });

  it('starts eager hydration for a next page and contains its rejection', async () => {
    const setup = createController({ historyCursor: 'next', loadingStrategy: 'eager' });
    setup.host.hydrateCompleteHistory.mockRejectedValue(new Error('hydrate failed'));

    await expect(setup.controller.fork('source')).resolves.toBe('forked');

    expect(setup.host.hydrateCompleteHistory).toHaveBeenCalledExactlyOnceWith('forked');
  });

  it('does not hydrate again when eager loading receives the terminal page', async () => {
    const setup = createController({ historyCursor: null, loadingStrategy: 'eager' });

    await setup.controller.fork('source');

    expect(setup.host.hydrateCompleteHistory).not.toHaveBeenCalled();
  });

  it('forks a known turn by stable id without resending content', async () => {
    const setup = createController({ messages: [assistantMessage('assistant', 'turn-2', 'Answer')] });
    const fork = vi.spyOn(setup.controller, 'fork').mockResolvedValue('forked');

    await expect(setup.controller.forkTurn('source', 'turn-2', { model: 'requested' }, { cwd: '/host' }))
      .resolves.toBe('forked');

    expect(fork).toHaveBeenCalledExactlyOnceWith(
      'source', { model: 'requested' }, { cwd: '/host' }, { lastTurnId: 'turn-2' },
    );
  });

  it('forks a user-owned turn through that complete turn', async () => {
    const setup = createController({ messages: [userMessage('user', 'turn-3', 'Continue')] });
    const fork = vi.spyOn(setup.controller, 'fork').mockResolvedValue('forked');

    await setup.controller.forkTurn('source', 'turn-3');

    expect(fork).toHaveBeenCalledWith('source', {}, {}, { lastTurnId: 'turn-3' });
  });

  it('rejects unknown turn ids before requesting a fork', async () => {
    const setup = createController({ messages: [userMessage('user', 'turn-1', 'Prompt')] });
    await expect(setup.controller.forkTurn('source', 'missing'))
      .rejects.toThrow("Cannot fork at unknown Codex turn 'missing'");
    expect(setup.request).not.toHaveBeenCalled();
  });
});

type SetupOptions = {
  activeTurnId?: string | null;
  busy?: boolean;
  extension?: Record<string, unknown>;
  history?: unknown[];
  historyCursor?: string | null;
  loadingStrategy?: 'eager' | 'lazy';
  messages?: SurfaceMessage[];
  models?: CodexSurfaceModel[];
  rejectGoal?: boolean;
  response?: Record<string, unknown>;
  selectedModelId?: string | null;
  sourceCwd?: string | null;
};

function createController(options: SetupOptions = {}) {
  const state = initialSurfaceSnapshot(initialAuthentication());
  state.activeConversationId = 'source';
  state.models = options.models ?? [];
  state.conversations = [summary('source')];
  const sourceRuntime = createThreadRuntime('source', state, {
    activeTurnId: options.activeTurnId ?? null,
    busy: options.busy ?? false,
    cwd: options.sourceCwd === undefined ? '/source' : options.sourceCwd,
    messages: options.messages ?? [],
    turnIds: [...new Set((options.messages ?? []).flatMap((message) => message.turnId ? [message.turnId] : []))],
    selectedModelId: options.selectedModelId ?? null,
  });
  const runtimes = new Map([['source', sourceRuntime]]);
  let createdRuntime: ReturnType<typeof createThreadRuntime> | undefined;
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'thread/fork') return options.response ?? forkResponse();
    if (method === 'thread/turns/list') {
      return { data: options.history ?? [], nextCursor: options.historyCursor ?? null };
    }
    if (method === 'thread/goal/get') {
      if (options.rejectGoal) throw new Error('goal unavailable');
      return { goal: goal('forked') };
    }
    return {};
  });
  const catalogs = {
    approvalPreset: null,
    approvalPresets: ['ask-for-approval', 'full-access'],
    permissionProfiles: [],
    skillCatalogStatus: 'loaded' as const,
    skills: [],
  };
  const catalog = {
    loadConversationCatalogs: vi.fn(async () => catalogs),
  };
  const extensions = {
    defaultMcpServers: [{ name: 'default' }],
    conversationExtension: vi.fn(async () => options.extension ?? {}),
  };
  const host = {
    createRuntime: vi.fn((threadId: string, patch = {}) => {
      createdRuntime = createThreadRuntime(threadId, state, patch);
      runtimes.set(threadId, createdRuntime);
      return createdRuntime;
    }),
    emitConversationActivity: vi.fn(),
    emitConversationPermissions: vi.fn(),
    emitConversationSettings: vi.fn(),
    emitConversationSkills: vi.fn(),
    emitHistoryReplaced: vi.fn(),
    emitSummaryUpserted: vi.fn(),
    getState: vi.fn(() => state),
    hydrateCompleteHistory: vi.fn(async () => undefined),
    patch: vi.fn((patch: Partial<CodexSurfaceSnapshot>) => Object.assign(state, patch)),
    rememberHostOptions: vi.fn(),
    requireRuntime: vi.fn((threadId: string) => {
      const runtime = runtimes.get(threadId);
      if (!runtime) throw new Error(`missing ${threadId}`);
      return runtime;
    }),
    snapshotForRuntime: vi.fn(() => state),
  };
  const controller = new CodexSurfaceForkController(
    { request } as unknown as CodexAppServerClient,
    options.loadingStrategy,
    catalog as never,
    extensions as never,
    host,
  );
  return {
    catalog,
    controller,
    extensions,
    get createdRuntime() { return createdRuntime; },
    host,
    request,
    sourceRuntime,
    state,
  };
}

function forkResponse(overrides: Record<string, unknown> = {}) {
  return {
    thread: thread('forked', false),
    model: null,
    modelProvider: 'openai',
    serviceTier: null,
    cwd: '/forked',
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: {
      type: 'workspaceWrite', writableRoots: ['/forked'], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    },
    activePermissionProfile: { id: ':workspace', extends: null },
    reasoningEffort: null,
    multiAgentMode: 'explicitRequestOnly',
    ...overrides,
  };
}

function model(id: string, runtime: string): CodexSurfaceModel {
  return {
    id, model: runtime, displayName: id,
    supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
    defaultReasoningEffort: 'high',
    serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Priority' }],
    defaultServiceTier: null,
  };
}

function goal(threadId: string) {
  return {
    threadId, objective: 'Ship', status: 'active' as const, tokenBudget: null,
    tokensUsed: 1, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2,
  };
}

function summary(id: string) {
  return {
    id, title: id, preview: '', cwd: '/source', status: 'idle' as const, turnCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function turnWithMessages(id: string, user: string, assistant: string, status: v2.TurnStatus = 'completed') {
  const items: v2.ThreadItem[] = [{
    type: 'userMessage', id: `user-${id}`, clientId: null,
    content: [{ type: 'text', text: user, text_elements: [] }],
  }];
  if (assistant) items.push({
    type: 'agentMessage', id: `agent-${id}`, text: assistant, phase: null, memoryCitation: null,
    delivery: null, questions: null,
  });
  return turn(id, status, items);
}

function userMessage(
  id: string,
  turnId: string,
  text: string,
  extraParts: SurfaceMessage['parts'] = [],
): SurfaceMessage {
  return {
    id, role: 'user', status: 'complete', turnId,
    parts: [...(text ? [{ type: 'text' as const, text }] : []), ...extraParts],
    metadata: { conversationId: 'source', turnId },
  };
}

function assistantMessage(id: string, turnId: string, text: string): SurfaceMessage {
  return {
    id, role: 'assistant', status: 'complete', turnId, parts: [{ type: 'text', text }],
    metadata: { conversationId: 'source', turnId },
  };
}

function paramsFor(request: ReturnType<typeof vi.fn>, method: string): Record<string, unknown> {
  return request.mock.calls.find(([candidate]) => candidate === method)?.[1] as Record<string, unknown>;
}

function expectEmissions(setup: ReturnType<typeof createController>): void {
  expect(setup.host.emitSummaryUpserted).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: 'forked', turnCount: 1 }),
  );
  expect(setup.host.emitHistoryReplaced).toHaveBeenCalledExactlyOnceWith('forked');
  expect(setup.host.emitConversationActivity).toHaveBeenCalledExactlyOnceWith('forked');
  expect(setup.host.emitConversationSettings).toHaveBeenCalledExactlyOnceWith('forked');
  expect(setup.host.emitConversationSkills).toHaveBeenCalledExactlyOnceWith('forked');
  expect(setup.host.emitConversationPermissions).toHaveBeenCalledExactlyOnceWith('forked');
}
