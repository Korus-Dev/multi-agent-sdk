import { describe, expect, it, vi } from 'vitest';
import type { CodexHostSnapshot } from '../../src/index';
import { RpcRemoteError } from '@korus-dev/codex-sdk';
import {
  CodexHostConnectionController,
  type CodexHostConnectionDependencies,
} from '../../src/providers/codex/host-connection-controller';
import { initialAuthentication } from '../../src/providers/codex/host-authentication';
import {
  createThreadRuntime,
  initialHostSnapshot,
  type ThreadRuntimeState,
} from '../../src/providers/codex/host-runtime';

describe('CodexHostConnectionController', () => {
  it('returns a ready snapshot without starting and rejects a closed host', async () => {
    const ready = setupConnection();
    ready.state.status = 'ready';
    await expect(ready.controller.connect()).resolves.toBe(ready.state);
    expect(ready.client.start).not.toHaveBeenCalled();

    const closed = setupConnection();
    closed.isClosed.mockReturnValue(true);
    await expect(closed.controller.connect()).rejects.toThrow('Codex host is closed');
    expect(closed.host.patch).not.toHaveBeenCalled();
  });

  it.each([undefined, false, true])('initializes the session with opt-in human approval capability (%s)', async (requiredHumanApproval) => {
    const started = deferred<void>();
    const setup = setupConnection({ requiredHumanApproval });
    setup.client.start.mockReturnValueOnce(started.promise);
    const first = setup.controller.connect();
    const second = setup.controller.connect();
    expect(second).toBe(first);
    expect(setup.state).toMatchObject({ status: 'connecting', error: null });
    started.resolve();

    await expect(first).resolves.toBe(setup.state);
    expect(setup.client.initialize).toHaveBeenCalledWith({
      clientInfo: { name: 'codex_app_sdk', title: 'Codex Host', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false, ...(requiredHumanApproval ? { requiredHumanApproval: true } : {}) },
    });
    expect(setup.client.request).toHaveBeenCalledWith('experimentalFeature/list', {
      cursor: null,
      limit: 100,
      threadId: null,
    });
    expect(setup.catalog.reset).toHaveBeenCalledWith(true);
    expect(setup.runtimeState.clear).toHaveBeenCalledOnce();
    expect(setup.lifecycle.resetHydrations).toHaveBeenCalledOnce();
    expect(setup.conversations.reset).toHaveBeenCalledOnce();
    expect(setup.items.reset).toHaveBeenCalledOnce();
    expect(setup.authentication.load).toHaveBeenCalledWith('lifecycle');
    expect(setup.state).toMatchObject({ status: 'ready', error: null });
    expect(setup.host.emitHostStatus).toHaveBeenNthCalledWith(1, 'lifecycle');
    expect(setup.host.emitHostStatus).toHaveBeenNthCalledWith(2, 'lifecycle');
    expect(setup.catalog.schedulePluginRefresh).toHaveBeenCalledWith();
  });

  it('forwards custom client identity while normalizing an omitted title', async () => {
    const setup = setupConnection({
      clientInfo: { name: 'desktop', version: '2.0.0' },
    });
    await setup.controller.connect();
    expect(setup.client.initialize).toHaveBeenCalledWith(expect.objectContaining({
      clientInfo: { name: 'desktop', title: null, version: '2.0.0' },
    }));
  });

  it('paginates feature discovery and enables supported SDK runtime features', async () => {
    const setup = setupConnection();
    setup.client.request.mockImplementation(async (method: string, value?: unknown) => {
      const params = value as { cursor?: string | null } | undefined;
      if (method === 'experimentalFeature/list') {
        return params?.cursor === null
          ? {
            data: [{ name: 'default_mode_request_user_input', enabled: false }],
            nextCursor: 'page-2',
          }
          : { data: [{ name: 'compaction_image_budget', enabled: false }], nextCursor: null };
      }
      if (method === 'experimentalFeature/enablement/set') return {};
      return {};
    });
    await setup.controller.connect();

    expect(setup.client.request).toHaveBeenCalledWith('experimentalFeature/list', {
      cursor: 'page-2', limit: 100, threadId: null,
    });
    expect(setup.client.request).toHaveBeenCalledWith('experimentalFeature/enablement/set', {
      enablement: {
        compaction_image_budget: true,
        default_mode_request_user_input: true,
      },
    });
  });

  it('does not rewrite an enabled feature and tolerates only method-not-found discovery errors', async () => {
    const enabled = setupConnection();
    enabled.client.request.mockResolvedValue({
      data: [
        { name: 'compaction_image_budget', enabled: true },
        { name: 'default_mode_request_user_input', enabled: true },
      ],
      nextCursor: null,
    });
    await enabled.controller.connect();
    expect(enabled.client.request).toHaveBeenCalledTimes(1);

    const legacy = setupConnection();
    legacy.client.request.mockRejectedValueOnce(new RpcRemoteError({ code: -32601, message: 'missing' }));
    await expect(legacy.controller.connect()).resolves.toBe(legacy.state);

    const broken = setupConnection();
    broken.client.request.mockRejectedValueOnce(new RpcRemoteError({ code: -32000, message: 'broken' }));
    await expect(broken.controller.connect()).rejects.toThrow('broken');
    expect(broken.state).toMatchObject({ status: 'error', error: 'broken' });
  });

  it('clears authenticated data when identity changes before rebuilding the new account catalogs', async () => {
    const setup = setupConnection();
    setup.authentication.load.mockResolvedValueOnce(true);
    setup.state.conversations = [summary('old')];
    await setup.controller.connect();

    expect(setup.approvals.denyAll).toHaveBeenCalledOnce();
    expect(setup.clientRequests.rejectAll).toHaveBeenCalledWith('Codex account signed out');
    expect(setup.lifecycle.clear).toHaveBeenCalledOnce();
    expect(setup.host.clearConversationHandles).toHaveBeenCalledOnce();
    expect(setup.catalog.loadModels).toHaveBeenCalledOnce();
    expect(setup.catalog.schedulePluginRefresh).toHaveBeenCalledWith(false);
  });

  it('clears account data but skips bootstrap while authentication is blocked', async () => {
    const setup = setupConnection();
    setup.authentication.blocksBootstrap.mockReturnValue(true);
    setup.state.conversations = [summary('old')];
    await setup.controller.connect();

    expect(setup.approvals.denyAll).toHaveBeenCalledOnce();
    expect(setup.catalog.loadModels).not.toHaveBeenCalled();
    expect(setup.catalog.schedulePluginRefresh).not.toHaveBeenCalled();
    expect(setup.state).toMatchObject({ conversations: [], activeConversationId: null, status: 'ready' });
  });

  it('reports connection failures and permits a later retry', async () => {
    const setup = setupConnection();
    setup.client.start.mockRejectedValueOnce('offline').mockResolvedValueOnce(undefined);
    await expect(setup.controller.connect()).rejects.toBe('offline');
    expect(setup.state).toMatchObject({ status: 'error', error: 'offline' });
    expect(setup.host.emitHostStatus).toHaveBeenLastCalledWith('lifecycle');

    await expect(setup.controller.connect()).resolves.toBe(setup.state);
    expect(setup.client.start).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent bootstrap and resumes the active unhydrated conversation', async () => {
    const setup = setupConnection();
    setup.state.status = 'ready';
    setup.state.conversations = [summary('first'), summary('active')];
    setup.state.activeConversationId = 'active';
    const models = deferred<void>();
    setup.catalog.loadModels.mockReturnValueOnce(models.promise);

    const first = setup.controller.bootstrapHostData();
    const second = setup.controller.bootstrapHostData();
    models.resolve();
    await Promise.all([first, second]);

    expect(setup.catalog.loadModels).toHaveBeenCalledOnce();
    expect(setup.catalog.loadSkills).not.toHaveBeenCalled();
    expect(setup.lifecycle.resumeDuringBootstrap).toHaveBeenCalledWith('active');
    expect(setup.catalog.schedulePluginRefresh).toHaveBeenCalledWith(false);

    await setup.controller.bootstrapHostData();
    expect(setup.catalog.loadModels).toHaveBeenCalledOnce();
    await setup.controller.bootstrapHostData(true);
    expect(setup.catalog.loadModels).toHaveBeenCalledTimes(2);
    expect(setup.catalog.loadSkills).not.toHaveBeenCalled();
  });

  it('honors a forced bootstrap requested while an ordinary bootstrap is still pending', async () => {
    const setup = setupConnection();
    const firstModels = deferred<void>();
    setup.catalog.loadModels.mockReturnValueOnce(firstModels.promise);

    const ordinary = setup.controller.bootstrapHostData();
    const forced = setup.controller.bootstrapHostData(true);
    firstModels.resolve();
    await Promise.all([ordinary, forced]);

    expect(setup.catalog.loadModels).toHaveBeenCalledTimes(2);
    expect(setup.catalog.loadSkills).not.toHaveBeenCalled();
    expect(setup.catalog.schedulePluginRefresh).toHaveBeenNthCalledWith(1, false);
    expect(setup.catalog.schedulePluginRefresh).toHaveBeenNthCalledWith(2, true);
  });

  it('retries bootstrap after a failed catalog load', async () => {
    const setup = setupConnection();
    setup.catalog.loadModels.mockRejectedValueOnce(new Error('catalog offline'));

    await expect(setup.controller.bootstrapHostData()).rejects.toThrow('catalog offline');
    await expect(setup.controller.bootstrapHostData()).resolves.toBeUndefined();
    expect(setup.catalog.loadModels).toHaveBeenCalledTimes(2);
  });

  it('honors auto-selection and hydration when choosing a bootstrap conversation', async () => {
    const disabled = setupConnection({ autoSelectFirstConversation: false });
    disabled.state.conversations = [summary('first')];
    await disabled.controller.bootstrapHostData();
    expect(disabled.lifecycle.resumeDuringBootstrap).not.toHaveBeenCalled();

    const hydrated = setupConnection();
    hydrated.state.conversations = [summary('first')];
    hydrated.runtimeState.get.mockReturnValue(createThreadRuntime('first', hydrated.state, { hydrated: true }));
    await hydrated.controller.bootstrapHostData();
    expect(hydrated.lifecycle.resumeDuringBootstrap).not.toHaveBeenCalled();
  });

  it('waits for both authentication refresh and host bootstrap to settle', async () => {
    const setup = setupConnection();
    setup.state.status = 'ready';
    const refresh = deferred<void>();
    const models = deferred<void>();
    setup.authentication.pendingRefresh
      .mockReturnValueOnce(refresh.promise)
      .mockReturnValue(null);
    setup.catalog.loadModels.mockReturnValueOnce(models.promise);
    const bootstrap = setup.controller.bootstrapHostData();
    const connected = setup.controller.ensureConnected();
    let settled = false;
    void connected.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    models.resolve();
    await bootstrap;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    refresh.resolve();
    await connected;
    expect(settled).toBe(true);
  });

  it('patches authentication and emits the complete changed value', () => {
    const setup = setupConnection();
    setup.controller.patchAuthentication({ status: 'loaded', error: 'expired' }, 'notification');
    expect(setup.state.authentication).toMatchObject({ status: 'loaded', error: 'expired', account: null });
    expect(setup.host.emitAuthenticationChanged).toHaveBeenCalledWith(
      setup.state.authentication,
      'notification',
    );
  });

  it('resets every runtime and pending collection on disconnect unless already closed', () => {
    const setup = setupConnection();
    const first = createThreadRuntime('first', setup.state, {
      activeTurnId: 'turn-1', busy: true, turnStartPending: true, historyLoading: true,
    });
    const second = createThreadRuntime('second', setup.state, { busy: true });
    setup.runtimeState.values.mockReturnValue([first, second][Symbol.iterator]());
    setup.state.clientRequests = [{
      id: 'request-1', kind: 'ask_user', conversationId: 'first', turnId: 'turn-1', itemId: 'item-1',
      payload: { request: { itemId: 'item-1', delivery: 'tool', blocking: true, questions: [] } },
    }];
    setup.state.historyLoading = true;
    setup.controller.handleDisconnect(new Error('socket lost'));

    expect(setup.catalog.reset).toHaveBeenCalledWith(false);
    expect(setup.host.clearPendingForThread).toHaveBeenNthCalledWith(1, 'first', 'socket lost', 'host_disconnected');
    expect(setup.host.clearPendingForThread).toHaveBeenNthCalledWith(2, 'second', 'socket lost', 'host_disconnected');
    expect(first).toMatchObject({
      activeTurnId: null, busy: false, turnStartPending: false, historyLoading: false, error: 'socket lost',
    });
    expect(setup.approvals.denyAll).toHaveBeenCalledOnce();
    expect(setup.clientRequests.clear).toHaveBeenCalledOnce();
    expect(setup.state).toMatchObject({
      status: 'error', activeTurnId: null, busy: false,
      clientRequests: [], historyLoading: false, error: 'socket lost',
    });
    expect(setup.host.emitHostStatus).toHaveBeenCalledWith('lifecycle');

    const closed = setupConnection();
    closed.isClosed.mockReturnValue(true);
    closed.controller.handleDisconnect(new Error('ignored'));
    expect(closed.catalog.reset).not.toHaveBeenCalled();
  });

  it('clears all account-scoped state and catalog selections', async () => {
    const setup = setupConnection();
    Object.assign(setup.state, {
      conversations: [summary('old')],
      activeConversationId: 'old',
      activeTurnId: 'turn-old',
      turns: [{ id: 'turn-old' }],
      messages: [{ id: 'message' }],
      approvals: [{ id: 'approval' }],
      clientRequests: [{ id: 'request' }],
      answeredClientRequestIds: ['answered-request'],
      models: [{ id: 'model' }],
      skills: [{ name: 'skill' }],
      plugins: [{ id: 'plugin' }],
      permissionProfiles: [{ id: ':workspace', description: null, allowed: true }],
      approvalPresets: ['ask-for-approval'],
      selectedModelId: 'model',
      planMode: true,
      queuedPrompts: [{ id: 'queued-1', text: 'later' }],
      busy: true,
      historyLoading: true,
      error: 'old error',
    });
    await setup.controller.clearAuthenticatedHostData();

    expect(setup.approvals.denyAll).toHaveBeenCalledOnce();
    expect(setup.clientRequests.rejectAll).toHaveBeenCalledWith('Codex account signed out');
    expect(setup.runtimeState.clear).toHaveBeenCalledOnce();
    expect(setup.lifecycle.clear).toHaveBeenCalledOnce();
    expect(setup.conversations.reset).toHaveBeenCalledOnce();
    expect(setup.host.clearConversationHandles).toHaveBeenCalledOnce();
    expect(setup.items.reset).toHaveBeenCalledOnce();
    expect(setup.catalog.reset).toHaveBeenCalledWith(true);
    expect(setup.state).toMatchObject({
      conversations: [], activeConversationId: null, activeTurnId: null, turns: [],
      messages: [], approvals: [], clientRequests: [],
      answeredClientRequestIds: [],
      models: [], modelCatalogStatus: 'notLoaded', skills: [], skillCatalogStatus: 'notLoaded',
      plugins: [], pluginCatalogStatus: 'notLoaded', approvalPresets: [], approvalPreset: null,
      permissionProfiles: [], queuedPrompts: [],
      selectedModelId: null, selectedReasoningEffort: null, selectedServiceTier: null,
      planMode: false, busy: false, historyLoading: false, error: null,
    });
  });

  it('waits for in-flight bootstrap before clearing account-scoped state', async () => {
    const setup = setupConnection();
    const models = deferred<void>();
    setup.catalog.loadModels.mockReturnValueOnce(models.promise);
    void setup.controller.bootstrapHostData();

    const clearing = setup.controller.clearAuthenticatedHostData();
    await Promise.resolve();
    expect(setup.approvals.denyAll).not.toHaveBeenCalled();
    models.resolve();
    await clearing;
    expect(setup.approvals.denyAll).toHaveBeenCalledOnce();
  });
});

function setupConnection(options: Record<string, unknown> = {}) {
  const state = initialHostSnapshot(initialAuthentication());
  const isClosed = vi.fn(() => false);
  const host: CodexHostConnectionDependencies = {
    clearConversationHandles: vi.fn(),
    clearPendingForThread: vi.fn(),
    closed: isClosed,
    emitAuthenticationChanged: vi.fn(),
    emitHostStatus: vi.fn(),
    getSnapshot: vi.fn(() => state),
    getState: vi.fn(() => state),
    patch: vi.fn((patch: Partial<CodexHostSnapshot>) => Object.assign(state, patch)),
  };
  const client = {
    initialize: vi.fn<() => Promise<unknown>>(async () => ({})),
    request: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async (method) => (
      method === 'experimentalFeature/list' ? { data: [], nextCursor: null } : {}
    )),
    start: vi.fn<() => Promise<void>>(async () => undefined),
  };
  const authentication = {
    blocksBootstrap: vi.fn(() => false),
    cancelLogin: vi.fn(),
    load: vi.fn<() => Promise<boolean>>(async () => false),
    logout: vi.fn(),
    pendingRefresh: vi.fn<() => Promise<void> | null>(() => null),
    refresh: vi.fn(),
    startChatGptDeviceCodeLogin: vi.fn(),
    startChatGptLogin: vi.fn(),
  };
  const approvals = { denyAll: vi.fn() };
  const catalog = {
    loadModels: vi.fn<() => Promise<void>>(async () => undefined),
    loadPermissionProfiles: vi.fn<() => Promise<void>>(async () => undefined),
    loadRateLimits: vi.fn<() => Promise<void>>(async () => undefined),
    loadSkills: vi.fn<() => Promise<void>>(async () => undefined),
    reset: vi.fn(),
    schedulePluginRefresh: vi.fn(),
  };
  const clientRequests = { clear: vi.fn(), rejectAll: vi.fn() };
  const conversations = { load: vi.fn<() => Promise<void>>(async () => undefined), reset: vi.fn() };
  const items = { reset: vi.fn() };
  const lifecycle = { clear: vi.fn(), resetHydrations: vi.fn(), resumeDuringBootstrap: vi.fn() };
  const runtimeState = {
    clear: vi.fn(),
    get: vi.fn<() => ThreadRuntimeState | undefined>(),
    values: vi.fn<() => IterableIterator<ThreadRuntimeState>>(() => [][Symbol.iterator]()),
  };
  const controller = new CodexHostConnectionController(
    client as never,
    options,
    authentication as never,
    approvals as never,
    catalog as never,
    clientRequests as never,
    conversations as never,
    items as never,
    lifecycle as never,
    runtimeState as never,
    host,
  );
  return {
    approvals, authentication, catalog, client, clientRequests, controller, conversations,
    host, isClosed, items, lifecycle, runtimeState, state,
  };
}

function summary(id: string) {
  return {
    id, title: id, preview: '', cwd: `/workspace/${id}`, status: 'idle' as const, turnCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => { resolve = next; });
  return { promise, resolve };
}
