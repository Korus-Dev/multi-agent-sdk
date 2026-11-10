import { describe, expect, it, vi } from 'vitest';
import type { ModelDescriptor, CodexHostSnapshot } from '../../src/index';
import type { HarnessDiagnostic } from '../../src/diagnostics';
import type { v2 } from '@korus-dev/codex-sdk';
import {
  CodexHostLifecycleController,
  type CodexHostLifecycleDependencies,
} from '../../src/providers/codex/host-lifecycle-controller';
import { initialAuthentication } from '../../src/providers/codex/host-authentication';
import {
  createThreadRuntime,
  initialHostSnapshot,
  runtimeProjection,
  type ThreadRuntimePatch,
  type ThreadRuntimeState,
} from '../../src/providers/codex/host-runtime';
import { deferred, resumeResponse, thread, turn } from './helpers/host-fixture';

const models: ModelDescriptor[] = [
  {
    id: 'current-id', model: 'current-model', displayName: 'Current',
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
    defaultReasoningEffort: 'medium', serviceTiers: [], defaultServiceTier: null, isDefault: true,
  },
  {
    id: 'fast-id', model: 'fast-model', displayName: 'Fast',
    supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
    defaultReasoningEffort: 'high',
    serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Fast' }],
    defaultServiceTier: 'priority',
  },
];

describe('CodexHostLifecycleController', () => {
  it('remembers, forgets, and clears per-thread host options', () => {
    const setup = setupLifecycle();
    setup.controller.rememberHostOptions('one', { cwd: '/one' });
    setup.controller.rememberHostOptions('two', { cwd: '/two' });
    expect(setup.controller.hostOptions('one')).toStrictEqual({ cwd: '/one' });

    setup.controller.forget('one');
    expect(setup.controller.hostOptions('one')).toBeUndefined();
    expect(setup.controller.hostOptions('two')).toStrictEqual({ cwd: '/two' });
    setup.controller.clear();
    expect(setup.controller.hostOptions('two')).toBeUndefined();
  });

  it('creates a conversation with the chosen model, inherited defaults, extensions, and events', async () => {
    const setup = setupLifecycle({ conversationDefaults: { threadSource: 'app' } });
    Object.assign(setup.state, {
      models,
      selectedModelId: 'current-id',
      selectedReasoningEffort: 'medium',
      selectedServiceTier: null,
      approvalPreset: 'ask-for-approval',
      conversations: [summary('old')],
      planMode: true,
    });
    setup.extensions.conversationExtension.mockResolvedValue({
      baseInstructions: 'base', developerInstructions: 'developer', config: { feature: true },
    });
    setup.extensions.hasDynamicTools.mockReturnValue(true);
    setup.extensions.dynamicToolSpecs.mockReturnValue([{ name: 'lookup' }]);

    const snapshot = await setup.controller.create({ cwd: '/new', model: 'fast-id' }, {
      extensionContext: { tenant: 'one' },
    });

    expect(setup.host.ensureConnected).toHaveBeenCalledOnce();
    expect(setup.catalog.loadConversationCatalogs).toHaveBeenCalledWith('/new');
    expect(setup.settings.threadStartSettings).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/new', model: 'fast-id', threadSource: 'app', approvalPreset: 'ask-for-approval',
    }), ['ask-for-approval', 'full-access']);
    expect(setup.extensions.conversationExtension).toHaveBeenCalledWith({
      operation: 'start', conversationId: null, cwd: '/new',
      createOptions: expect.objectContaining({ cwd: '/new', model: 'fast-id', threadSource: 'app' }),
      extensionContext: { tenant: 'one' },
    }, expect.objectContaining({ model: 'fast-id' }), []);
    expect(setup.client.request).toHaveBeenCalledWith('thread/start', {
      cwd: '/new', model: 'fast-model', baseInstructions: 'base', developerInstructions: 'developer',
      config: { feature: true }, dynamicTools: [{ name: 'lookup' }], approvalPolicy: 'on-request',
      serviceTier: 'priority', threadSource: 'app', serviceName: 'codex_app_sdk',
    });
    expect(setup.client.request).toHaveBeenCalledWith('thread/settings/update', {
      threadId: 'thread-new', effort: 'high',
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'fast-model', reasoning_effort: 'high', developer_instructions: null },
      },
    });
    expect(setup.runtimes.get('thread-new')).toMatchObject({
      hydrated: true, historyMode: 'paginated', cwd: '/tmp/project', activeTurnId: null, turnIds: [], messages: [],
      answeredClientRequestIds: [], selectedModelId: 'fast-id', selectedReasoningEffort: 'high',
      selectedServiceTier: 'priority', approvalPreset: 'ask-for-approval',
    });
    expect(setup.controller.hostOptions('thread-new')).toStrictEqual({
      cwd: '/new', extensionContext: { tenant: 'one' }, mcpServers: [],
    });
    expect(snapshot.activeConversationId).toBe('thread-new');
    expect(snapshot.conversations.map(({ id }) => id)).toStrictEqual(['old', 'thread-new']);
    expect(setup.host.emitSummaryUpserted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'thread-new' }), 'created', 'action',
    );
    expect(setup.host.emitSelected).toHaveBeenCalledWith('thread-new');
    expectConversationEvents(setup.host, 'thread-new');
  });

  it('rejects unavailable approval presets before starting a thread', async () => {
    const setup = setupLifecycle();
    await expect(setup.controller.create({ approvalPreset: 'approve-for-me' })).rejects.toThrow(
      "Approval preset 'approve-for-me' is not available",
    );
    expect(setup.client.request).not.toHaveBeenCalledWith('thread/start', expect.anything());
  });

  it('activates a hydrated live runtime but resumes idle and missing conversations', async () => {
    const setup = setupLifecycle();
    const live = setup.createRuntime('live', { hydrated: true, busy: true, activeTurnId: 'turn-live' });
    await expect(setup.controller.select('live')).resolves.toBe(setup.state);
    expect(setup.host.activateRuntime).toHaveBeenCalledWith(live);
    expect(setup.client.request).not.toHaveBeenCalledWith('thread/resume', expect.anything());

    const activeOnly = setup.createRuntime('active-only', {
      hydrated: true, busy: false, activeTurnId: 'turn-active',
    });
    await setup.controller.select('active-only');
    expect(setup.host.activateRuntime).toHaveBeenCalledWith(activeOnly);
    expect(setup.client.request).not.toHaveBeenCalledWith('thread/resume', expect.anything());

    setup.createRuntime('hydrated-idle', { hydrated: true, busy: false, activeTurnId: null });
    await setup.controller.select('hydrated-idle');
    expect(setup.client.request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
      threadId: 'hydrated-idle',
    }));

    await setup.controller.select('idle');
    expect(setup.client.request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
      threadId: 'idle', excludeTurns: true,
    }));
    expect(setup.host.activateRuntime).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'idle' }));

    await setup.controller.resumeDuringBootstrap('bootstrap');
    expect(setup.client.request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
      threadId: 'bootstrap',
    }));
  });

  it('returns a hydrated runtime immediately only when no load overrides are requested', async () => {
    const setup = setupLifecycle();
    const ready = setup.createRuntime('ready', { hydrated: true });
    await expect(setup.controller.ensureReady('ready')).resolves.toBe(ready);
    expect(setup.client.request).not.toHaveBeenCalledWith('thread/resume', expect.anything());

    await setup.controller.ensureReady('ready', { cwd: '/override' });
    expect(setup.client.request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
      threadId: 'ready', cwd: '/override',
    }));
    expect(setup.host.activateRuntime).not.toHaveBeenCalled();
    expect(setup.host.emitHistoryReplaced).toHaveBeenCalledWith('ready', 'load', 'action');
  });

  it('shares an in-flight hydration and permits retry after it rejects', async () => {
    const diagnostics: HarnessDiagnostic[] = [];
    const setup = setupLifecycle({ onDiagnostic: (record: HarnessDiagnostic) => diagnostics.push(record) });
    const firstResume = deferred<unknown>();
    setup.client.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'thread/resume') return firstResume.promise;
      return responseFor(method, params);
    });
    const first = setup.controller.ensureReady('shared');
    const second = setup.controller.ensureReady('shared');
    await vi.waitFor(() => {
      expect(setup.client.request.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(1);
    });
    firstResume.reject(new Error('resume failed'));
    await expect(first).rejects.toThrow('resume failed');
    await expect(second).rejects.toThrow('resume failed');
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('shared', {
      historyLoading: false, error: 'resume failed',
    });

    expect(diagnostics).toContainEqual(expect.objectContaining({
      layer: 'codex-sdk', stage: 'resume.failed', threadId: 'shared', stageMs: expect.any(Number), elapsedMs: expect.any(Number),
    }));
    setup.client.request.mockImplementation(async (method: string, params?: unknown) => responseFor(method, params));
    await expect(setup.controller.ensureReady('shared')).resolves.toMatchObject({
      threadId: 'shared', hydrated: true,
    });
    expect(setup.client.request.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(2);
  });

  it('isolates diagnostic observers and error handlers from successful and failed resumes', async () => {
    const observerError = new Error('diagnostic sink failed');
    const onListenerError = vi.fn(() => { throw new Error('error sink failed'); });
    const setup = setupLifecycle({ onDiagnostic: () => { throw observerError; }, onListenerError });
    await expect(setup.controller.ensureReady('healthy')).resolves.toMatchObject({ hydrated: true });
    expect(onListenerError).toHaveBeenCalledWith(observerError);
    setup.client.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'thread/resume') throw new Error('native resume failed');
      return responseFor(method, params);
    });
    await expect(setup.controller.ensureReady('failed')).rejects.toThrow('native resume failed');
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('failed', { historyLoading: false, error: 'native resume failed' });
  });

  it('keeps a live compaction marker in persisted history order during hydration', async () => {
    const setup = setupLifecycle();
    const resume = deferred<unknown>();
    setup.client.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'thread/resume') return resume.promise;
      return responseFor(method, params);
    });

    const hydration = setup.controller.ensureReady('compacted');
    await vi.waitFor(() => expect(setup.runtimes.has('compacted')).toBe(true));
    const loadingRuntime = setup.runtimes.get('compacted');
    if (!loadingRuntime) throw new Error('Missing loading runtime');
    loadingRuntime.messages = [{
      id: 'compaction-turn-compaction',
      kind: 'compaction',
      role: 'assistant',
      status: 'streaming',
      turnId: 'turn-compaction',
      parts: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      metadata: { conversationId: 'compacted', turnId: 'turn-compaction' },
    }];

    const resumedThread: v2.Thread = {
      ...thread('compacted', false),
      status: { type: 'active', activeFlags: [] },
      turns: [turn('turn-compaction', 'inProgress', [
        {
          type: 'userMessage', id: 'user-compaction', clientId: null,
          content: [{ type: 'text', text: 'Continue after compaction.', text_elements: [] }],
        },
        { type: 'agentMessage', id: 'before', text: 'Before.', phase: null, memoryCitation: null, delivery: null, questions: null },
        { type: 'contextCompaction', id: 'compaction' },
        { type: 'agentMessage', id: 'after', text: 'After.', phase: null, memoryCitation: null, delivery: null, questions: null },
      ])],
    };
    resume.resolve(resumeResponse(resumedThread));
    await hydration;

    expect(setup.runtimes.get('compacted')?.messages.map(({ id }) => id)).toStrictEqual([
      'user-compacted-turn-compaction-user-compaction',
      'assistant-turn-compaction',
      'compaction-turn-compaction',
      'assistant-turn-compaction-segment-1',
    ]);
  });

  it.each(['forget', 'clear', 'resetHydrations'] as const)(
    '%s invalidates an in-flight hydration so a replacement load can start',
    async (method) => {
      const setup = setupLifecycle();
      const firstResume = deferred<unknown>();
      const secondResume = deferred<unknown>();
      let resumeCount = 0;
      setup.client.request.mockImplementation(async (requestMethod: string, params?: unknown) => {
        if (requestMethod === 'thread/resume') {
          resumeCount += 1;
          return resumeCount === 1 ? firstResume.promise : secondResume.promise;
        }
        return responseFor(requestMethod, params);
      });
      const first = setup.controller.ensureReady('replace');
      await vi.waitFor(() => expect(resumeCount).toBe(1));
      if (method === 'forget') setup.controller.forget('replace');
      else setup.controller[method]();
      const second = setup.controller.ensureReady('replace');
      await vi.waitFor(() => expect(resumeCount).toBe(2));

      firstResume.resolve(resumeResponse(thread('replace', true)));
      await first;
      const third = setup.controller.ensureReady('replace', { cwd: '/replacement' });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(resumeCount).toBe(2);
      secondResume.resolve(resumeResponse(thread('replace', true)));
      await Promise.all([second, third]);
    },
  );

  it('omits absent thread options and does not invent selections without a model', async () => {
    const setup = setupLifecycle();
    const started = resumeResponse({ ...thread('thread-new', false), cwd: '/thread-cwd' });
    started.cwd = '/response-cwd';
    setup.client.request.mockImplementation(async (method: string, params?: unknown) => (
      method === 'thread/start' ? started : responseFor(method, params)
    ));

    await setup.controller.create();

    expect(setup.client.request).toHaveBeenCalledWith('thread/start', {
      cwd: '/default', approvalPolicy: 'on-request', serviceTier: null, serviceName: 'codex_app_sdk',
    });
    expect(setup.client.request).not.toHaveBeenCalledWith('thread/settings/update', expect.anything());
    expect(setup.runtimes.get('thread-new')).toMatchObject({
      historyMode: 'paginated', cwd: '/response-cwd', selectedModelId: null, selectedReasoningEffort: 'medium',
      selectedServiceTier: null, approvalPreset: 'ask-for-approval',
    });
  });

  it('preserves paginated history mode across create, resume, and history resync', async () => {
    const setup = setupLifecycle();
    const paginatedThread = (id: string): v2.Thread => ({
      ...thread(id, false), historyMode: 'paginated',
    });
    setup.client.request.mockImplementation(async (method: string, params?: unknown) => {
      const threadId = String((params as { threadId?: string } | undefined)?.threadId ?? 'thread-new');
      if (method === 'thread/start') return resumeResponse(paginatedThread('thread-new'));
      if (method === 'thread/resume') return resumeResponse(paginatedThread(threadId));
      if (method === 'thread/read') return { thread: paginatedThread(threadId) };
      return responseFor(method, params);
    });

    await setup.controller.create();
    await setup.controller.select('resumed');
    await setup.controller.readHistory('resumed');

    expect(setup.runtimes.get('thread-new')?.historyMode).toBe('paginated');
    expect(setup.runtimes.get('resumed')?.historyMode).toBe('paginated');
  });

  it.each([
    { approvalMode: 'never' as const },
    { permissionMode: 'full-access' as const },
  ])('does not inherit an approval preset when legacy policy is explicit', async (policy) => {
    const setup = setupLifecycle();
    setup.state.approvalPreset = 'ask-for-approval';
    await setup.controller.create(policy);
    expect(setup.settings.threadStartSettings).toHaveBeenCalledWith(
      expect.not.objectContaining({ approvalPreset: expect.anything() }),
      ['ask-for-approval', 'full-access'],
    );
  });

  it('retains current model selections and rejects an unavailable explicit service tier', async () => {
    const current = { ...models[1]!, isDefault: true };
    const setup = setupLifecycle();
    Object.assign(setup.state, {
      models: [current], selectedModelId: 'fast-id', selectedReasoningEffort: 'high',
      selectedServiceTier: null,
    });
    await setup.controller.create();
    expect(setup.client.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      model: 'fast-model', serviceTier: null,
    }));
    expect(setup.runtimes.get('thread-new')).toMatchObject({
      selectedModelId: 'fast-id', selectedReasoningEffort: 'high', selectedServiceTier: null,
    });

    const selectedTier = setupLifecycle();
    selectedTier.state.models = [{
      ...current,
      serviceTiers: [
        { id: 'standard', name: 'Standard', description: 'Normal' },
        { id: 'priority', name: 'Priority', description: 'Fast' },
      ],
    }];
    selectedTier.state.selectedModelId = 'fast-id';
    selectedTier.state.selectedReasoningEffort = 'high';
    selectedTier.state.selectedServiceTier = 'standard';
    await selectedTier.controller.create();
    expect(selectedTier.client.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      serviceTier: 'standard',
    }));

    const invalid = setupLifecycle();
    invalid.state.models = [current];
    await expect(invalid.controller.create({ model: 'fast-id', serviceTier: 'unavailable' })).rejects.toThrow(
      "Service tier 'unavailable' is not available for 'Fast'",
    );
    expect(invalid.client.request).not.toHaveBeenCalledWith('thread/start', expect.anything());
  });

  it('returns an isolated history snapshot for a busy conversation without resyncing', async () => {
    const setup = setupLifecycle();
    const runtime = setup.createRuntime('busy', {
      hydrated: true,
      busy: true,
      activeTurnId: 'turn-live',
      messages: [conversationMessage('message-1', 'Working')],
      threadStatus: { type: 'active', activeFlags: [] },
    });
    const history = await setup.controller.readHistory('busy');

    expect(history).toEqual({
      conversationId: 'busy', messages: runtime.messages, threadStatus: runtime.threadStatus,
    });
    expect(history.messages).not.toBe(runtime.messages);
    expect(history.threadStatus).not.toBe(runtime.threadStatus);
    expect(setup.client.request).not.toHaveBeenCalledWith('thread/read', expect.anything());
    await expect(setup.controller.readHistory('')).rejects.toThrow('There is no active conversation');
  });

  it('resyncs complete history, updates the active projection, and emits semantic events', async () => {
    const setup = setupLifecycle();
    setup.state.activeConversationId = 'history';
    const runtime = setup.createRuntime('history', {
      hydrated: true,
      activeTurnId: 'turn-live',
      turnIds: ['turn-old', 'turn-live'],
      messages: [conversationMessage('message-history', 'Complete history')],
      loadingStrategy: 'eager',
      historyCursor: 'old-cursor',
      historyHasOlder: true,
      historyLoadingOlder: true,
      threadStatus: { type: 'active', activeFlags: [] },
    });
    const result = await setup.controller.readHistory('history');

    expect(setup.client.request).toHaveBeenCalledWith('thread/read', {
      threadId: 'history', includeTurns: false,
    });
    expect(setup.conversations.refreshCompleteHistory).toHaveBeenCalledWith('history');
    expect(setup.host.createRuntime).toHaveBeenCalledWith('history', {
      historyLoading: true, error: null,
    });
    expect(setup.host.activateRuntime).toHaveBeenCalledWith(runtime);
    expect(runtime).toMatchObject({
      hydrated: true, historyMode: 'paginated', historyLoading: false, activeTurnId: 'turn-live',
      turnIds: ['turn-old', 'turn-live'], loadingStrategy: 'eager', historyCursor: null,
      historyHasOlder: false, historyLoadingOlder: false, fullHistoryHydrated: true,
      busy: true, threadStatus: { type: 'idle' },
    });
    expect(setup.state).toMatchObject({
      busy: true, messages: runtime.messages, historyLoading: false,
      conversations: [expect.objectContaining({ id: 'history', turnCount: 2 })],
    });
    expect(setup.host.emitSummaryUpserted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'history', turnCount: 2 }), 'updated', 'action',
    );
    expect(setup.host.emitHistoryReplaced).toHaveBeenCalledWith('history', 'resync', 'action');
    expect(setup.host.emitConversationActivity).toHaveBeenCalledWith('history', 'action');
    expect(result).toEqual({
      conversationId: 'history', messages: runtime.messages, threadStatus: { type: 'idle' },
    });
  });

  it('does not project background history and reports mismatched or failed reads', async () => {
    const background = setupLifecycle();
    background.state.activeConversationId = 'foreground';
    background.createRuntime('background', { hydrated: true, messages: [conversationMessage('bg', 'Background')] });
    await background.controller.readHistory('background');
    expect(background.host.activateRuntime).not.toHaveBeenCalled();
    expect(background.host.runtimeProjection).not.toHaveBeenCalled();

    const mismatch = setupLifecycle();
    mismatch.createRuntime('requested', { hydrated: true });
    mismatch.client.request.mockImplementation(async (method: string, params?: unknown) => (
      method === 'thread/read' ? { thread: thread('different', false) } : responseFor(method, params)
    ));
    await expect(mismatch.controller.readHistory('requested')).rejects.toThrow(
      "Codex thread/read returned 'different' for requested thread 'requested'",
    );
    expect(mismatch.host.patchRuntime).toHaveBeenCalledWith('requested', {
      historyLoading: false,
      error: "Codex thread/read returned 'different' for requested thread 'requested'",
    });
  });

  it('resumes fallback-paged history with goal, extensions, eager hydration, and exact state', async () => {
    const setup = setupLifecycle({ loadingStrategy: 'eager' });
    setup.state.models = models;
    setup.state.selectedModelId = 'current-id';
    setup.state.activeConversationId = 'target';
    setup.controller.rememberHostOptions('target', { cwd: '/remembered', extensionContext: { tenant: 'old' } });
    setup.extensions.conversationExtension.mockResolvedValue({
      baseInstructions: 'resume base', developerInstructions: 'resume developer', config: { resume: true },
    });
    const completed = turn('turn-old', 'completed', [
      { type: 'userMessage', id: 'user-old', clientId: null, content: [{ type: 'text', text: 'Old', text_elements: [] }] },
    ]);
    const running = turn('turn-live', 'inProgress', [
      { type: 'agentMessage', id: 'agent-live', text: 'Working', phase: null, memoryCitation: null, delivery: null, questions: null },
    ]);
    const resumedThread = { ...thread('target', false), historyMode: 'legacy' as const };
    resumedThread.status = { type: 'active', activeFlags: [] };
    const response = resumeResponse(resumedThread) as unknown as Record<string, unknown>;
    delete response.initialTurnsPage;
    response.cwd = null;
    setup.client.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'thread/resume') return response;
      if (method === 'thread/goal/get') return { goal: goal('target') };
      if (method === 'thread/turns/list') {
        return { data: [running, completed], nextCursor: 'older', backwardsCursor: null };
      }
      return responseFor(method, params);
    });

    const result = await setup.controller.select('target');

    expect(setup.extensions.conversationExtension).toHaveBeenCalledWith({
      operation: 'resume', conversationId: 'target', cwd: '/remembered',
      extensionContext: { tenant: 'old' },
    }, {}, []);
    expect(setup.client.request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'target', excludeTurns: true,
      initialTurnsPage: { limit: 5, sortDirection: 'desc', itemsView: 'full' },
      cwd: '/remembered', baseInstructions: 'resume base', developerInstructions: 'resume developer',
      config: { resume: true },
    });
    expect(setup.client.request).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'target', cursor: null, limit: 5, sortDirection: 'desc', itemsView: 'full',
    });
    expect(setup.client.request).toHaveBeenCalledWith('thread/goal/get', { threadId: 'target' });
    expect(setup.catalog.loadConversationCatalogs).toHaveBeenCalledWith('/tmp/project');
    const runtime = setup.runtimes.get('target');
    expect(runtime).toMatchObject({
      hydrated: true, historyMode: 'legacy', loadingStrategy: 'eager', historyCursor: 'older', historyHasOlder: true,
      historyLoadingOlder: false, fullHistoryHydrated: false, cwd: '/tmp/project', historyLoading: false,
      activeTurnId: 'turn-live', turnIds: ['turn-old', 'turn-live'], busy: true,
      goal: goal('target'), threadStatus: { type: 'active', activeFlags: [] },
    });
    expect(runtime?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({ role: 'assistant', status: 'streaming' }),
    ]));
    expect(setup.host.emitSummaryUpserted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'target', turnCount: 2 }), 'resumed', 'action',
    );
    expect(setup.host.emitHistoryReplaced).toHaveBeenCalledWith('target', 'resume', 'action');
    expectConversationEvents(setup.host, 'target');
    expect(setup.conversations.hydrateCompleteHistory).toHaveBeenCalledWith('target', {
      cursor: 'older', initialPageLoaded: true,
    });
    expect(result).toBe(setup.state);
  });

  it('omits absent resume extensions and marks a terminal initial page fully hydrated', async () => {
    const setup = setupLifecycle();
    await setup.controller.select('terminal');

    expect(setup.client.request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'terminal', excludeTurns: true,
      initialTurnsPage: { limit: 5, sortDirection: 'desc', itemsView: 'full' },
    });
    expect(setup.runtimes.get('terminal')).toMatchObject({
      historyMode: 'paginated', historyCursor: null, historyHasOlder: false,
      fullHistoryHydrated: true, loadingStrategy: 'lazy',
    });
    expect(setup.conversations.hydrateCompleteHistory).not.toHaveBeenCalled();
  });

  it('keeps a lazy nonterminal history page demand-loaded', async () => {
    const setup = setupLifecycle();
    setup.client.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'thread/resume') {
        const response = resumeResponse(thread('lazy', false));
        response.initialTurnsPage = { data: [], nextCursor: 'older', backwardsCursor: null };
        return response;
      }
      return responseFor(method, params);
    });
    await setup.controller.select('lazy');
    expect(setup.runtimes.get('lazy')).toMatchObject({
      historyCursor: 'older', historyHasOlder: true, fullHistoryHydrated: false, loadingStrategy: 'lazy',
    });
    expect(setup.conversations.hydrateCompleteHistory).not.toHaveBeenCalled();
  });

  it('does not launch eager background hydration for a terminal page', async () => {
    const setup = setupLifecycle({ loadingStrategy: 'eager' });
    await setup.controller.select('eager-terminal');
    expect(setup.runtimes.get('eager-terminal')).toMatchObject({
      historyCursor: null, fullHistoryHydrated: true, loadingStrategy: 'eager',
    });
    expect(setup.conversations.hydrateCompleteHistory).not.toHaveBeenCalled();
  });

  it('tolerates goal lookup failure but rejects a mismatched resumed thread and records the error', async () => {
    const setup = setupLifecycle();
    setup.client.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'thread/resume') return resumeResponse(thread('wrong', false));
      if (method === 'thread/goal/get') throw new Error('unsupported');
      return responseFor(method, params);
    });
    await expect(setup.controller.select('expected')).rejects.toThrow(
      "Codex thread/resume returned 'wrong' for requested thread 'expected'",
    );
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('expected', {
      historyLoading: false,
      error: "Codex thread/resume returned 'wrong' for requested thread 'expected'",
    });
  });
});

function setupLifecycle(options: Record<string, unknown> = {}) {
  const state = initialHostSnapshot(initialAuthentication());
  const runtimes = new Map<string, ThreadRuntimeState>();
  const host: CodexHostLifecycleDependencies = {
    activateRuntime: vi.fn((runtime: ThreadRuntimeState) => {
      state.activeConversationId = runtime.threadId;
      Object.assign(state, runtimeProjection(runtime, [], []));
    }),
    createRuntime: vi.fn((threadId: string, patch: ThreadRuntimePatch = {}) => {
      const current = runtimes.get(threadId);
      if (current) {
        Object.assign(current, patch);
        return current;
      }
      const runtime = createThreadRuntime(threadId, state, patch);
      runtimes.set(threadId, runtime);
      return runtime;
    }),
    emitConversationActivity: vi.fn(), emitConversationPermissions: vi.fn(),
    emitConversationSettings: vi.fn(), emitConversationSkills: vi.fn(),
    emitHistoryReplaced: vi.fn(), emitSelected: vi.fn(), emitSummaryUpserted: vi.fn(),
    ensureConnected: vi.fn(async () => undefined), getSnapshot: vi.fn(() => state),
    observeEmptyConversation: vi.fn(),
    getState: vi.fn(() => state), patch: vi.fn((patch: Partial<CodexHostSnapshot>) => Object.assign(state, patch)),
    patchRuntime: vi.fn((threadId: string, patch: ThreadRuntimePatch) => {
      const runtime = runtimes.get(threadId);
      if (runtime) Object.assign(runtime, patch);
    }),
    requireRuntime: vi.fn((threadId: string) => {
      const runtime = runtimes.get(threadId);
      if (!runtime) throw new Error(`Missing runtime '${threadId}'`);
      return runtime;
    }),
    runtime: vi.fn((threadId: string) => runtimes.get(threadId)),
    runtimeProjection: vi.fn((runtime: ThreadRuntimeState) => runtimeProjection(runtime, [], [])),
    snapshotForRuntime: vi.fn((runtime: ThreadRuntimeState) => ({
      ...state, ...runtimeProjection(runtime, [], []), activeConversationId: runtime.threadId,
    })),
  };
  const client = {
    request: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async (method, params) => responseFor(method, params),
    ),
  };
  const catalog = {
    loadConversationCatalogs: vi.fn(async () => catalogs()),
  };
  const extensions = {
    defaultMcpServers: [],
    conversationExtension: vi.fn(async () => ({})),
    hasDynamicTools: vi.fn(() => false),
    dynamicToolSpecs: vi.fn<() => unknown[]>(() => []),
  };
  const settings = {
    threadStartSettings: vi.fn(() => ({ approvalPolicy: 'on-request' })),
  };
  const conversations = {
    loadLoadedTurnHistory: vi.fn(async () => undefined),
    hydrateCompleteHistory: vi.fn(async () => undefined),
    refreshCompleteHistory: vi.fn(async () => undefined),
  };
  const controller = new CodexHostLifecycleController(
    client as never,
    { cwd: '/default', loadingStrategy: 'lazy', ...options } as never,
    catalog as never,
    extensions as never,
    settings as never,
    conversations as never,
    host,
  );
  const createRuntime = (threadId: string, patch: ThreadRuntimePatch = {}) => host.createRuntime(threadId, patch);
  return { catalog, client, controller, conversations, createRuntime, extensions, host, runtimes, settings, state };
}

function responseFor(method: string, params?: unknown): unknown {
  const threadId = String((params as { threadId?: string } | undefined)?.threadId ?? 'thread-new');
  if (method === 'thread/start') return resumeResponse(thread('thread-new', false));
  if (method === 'thread/resume') return resumeResponse(thread(threadId, true));
  if (method === 'thread/goal/get') return { goal: null };
  if (method === 'thread/turns/list') {
    return { data: [turn('turn-fallback', 'completed', [])], nextCursor: null, backwardsCursor: null };
  }
  if (method === 'thread/read') return { thread: thread(threadId, false) };
  return {};
}

function catalogs() {
  return {
    approvalPresets: ['ask-for-approval', 'full-access'] as const,
    permissionProfiles: [{ id: ':workspace', description: null, allowed: true }],
    skillCatalogStatus: 'loaded' as const,
    skills: [],
  };
}

function summary(id: string) {
  return {
    id, title: id, preview: '', cwd: `/workspace/${id}`, status: 'idle' as const, turnCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function conversationMessage(id: string, text: string) {
  return {
    id, role: 'assistant' as const, status: 'complete' as const,
    parts: [{ type: 'text' as const, text }],
  };
}

function goal(threadId: string) {
  return {
    threadId, objective: 'Ship it', status: 'active' as const, tokenBudget: null,
    tokensUsed: 10, timeUsedSeconds: 20, createdAt: 1, updatedAt: 2,
  };
}

function expectConversationEvents(host: CodexHostLifecycleDependencies, threadId: string) {
  expect(host.emitConversationActivity).toHaveBeenCalledWith(threadId, 'action');
  expect(host.emitConversationSettings).toHaveBeenCalledWith(threadId, 'action');
  expect(host.emitConversationSkills).toHaveBeenCalledWith(threadId, 'action');
  expect(host.emitConversationPermissions).toHaveBeenCalledWith(threadId, 'action');
}
