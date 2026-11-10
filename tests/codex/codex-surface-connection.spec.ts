import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, type CodexRequestSettledInfo, type v2 } from '@korus-dev/codex-sdk';
import { CodexSurface } from '../../src/providers/codex';
import type { HarnessDiagnostic } from '../../src/diagnostics';
import type { CodexSurfaceEvent } from '../../src/index';
import { configRequirements, MockCodexAppServer, createSurface, deferred, lastRequest, pluginSummary, requestsFor, resumeResponse, thread, turn } from './helpers/codex-surface-fixture';

describe('CodexSurface', () => {
  it('validates the trusted top-level CODEX_HOME seam and rejects transport conflicts', () => {
    const client = new CodexAppServerClient(new MockCodexAppServer());
    expect(() => new CodexSurface({ client, codexHome: 'relative/home' })).toThrow(
      'codexHome must be an absolute path',
    );
    expect(() => new CodexSurface({ client, codexHome: '   ' })).toThrow('codexHome cannot be empty');
    expect(() => new CodexSurface({
      client,
      codexHome: '/tmp/codex-a',
      transport: { codexHome: '/tmp/codex-b' },
    })).toThrow('codexHome conflicts with transport.codexHome');
    expect(() => new CodexSurface({
      client,
      codexHome: '/tmp/codex-a',
      transport: { codexHome: '/tmp/codex-a' },
    })).not.toThrow();
  });

  it('enters an error state after disconnect and reconnects the app-server', async () => {
    const transport = new MockCodexAppServer({ 'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }) });
    const settled: CodexRequestSettledInfo[] = [];
    const diagnostics: HarnessDiagnostic[] = [];
    const surface = new CodexSurface({
      client: new CodexAppServerClient(transport, { onRequestSettled: record => settled.push(record) }),
      cwd: '/tmp/project', onDiagnostic: record => diagnostics.push(record),
    });
    // A legacy application flag must not enable SDK-owned output or filtering.
    vi.stubEnv('CODEX_APP_SDK_TRACE_CONVERSATION_LOAD', '1');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const events: CodexSurfaceEvent[] = [];
      surface.onEvent((event) => events.push(event));
      await surface.connect();
      events.length = 0;
      expect(diagnostics.some(record => record.stage === 'snapshot.cloned')).toBe(true);
      diagnostics.length = 0; settled.length = 0;

      transport.fail(new Error('app-server exited'));
      expect(surface.getSnapshot()).toMatchObject({
        status: 'error',
        busy: false,
        approvals: [],
        error: 'app-server exited',
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'surface.statusChanged',
        origin: 'lifecycle',
        payload: { status: 'error', error: 'app-server exited' },
      }));

      await expect(surface.connect()).resolves.toMatchObject({ status: 'ready', error: null });
      expect(transport.start).toHaveBeenCalledTimes(2);
      expect(requestsFor(transport, 'account/read')).toHaveLength(2);
      expect(requestsFor(transport, 'thread/list')).toHaveLength(2);
      expect(requestsFor(transport, 'thread/resume')).toHaveLength(2);
      const stages = diagnostics.filter(record => record.layer === 'codex-sdk');
      expect(new Set(stages.map(record => record.stage)).size).toBeGreaterThan(1);
      for (const stage of stages) expect(stage).toMatchObject({
        threadId: 'thread-existing', stageMs: expect.any(Number), elapsedMs: expect.any(Number),
      });
      expect(settled).toContainEqual(expect.objectContaining({
        id: (lastRequest(transport, 'thread/resume') as import('@korus-dev/codex-sdk').RpcRequest).id,
        method: 'thread/resume', outcome: 'ok', startedAt: expect.any(Number), durationMs: expect.any(Number),
      }));
      for (const record of settled) {
        expect(record.startedAt).toBeGreaterThan(1_000_000_000_000);
        expect(record.durationMs).toBeGreaterThanOrEqual(0);
        expect(record).not.toHaveProperty('params');
      }

      await surface.sendMessage('Message after reconnect');
      expect(lastRequest(transport, 'turn/start')).toMatchObject({
        params: expect.objectContaining({ threadId: 'thread-existing' }),
      });
      expect(settled.some(record => record.method === 'turn/start')).toBe(true);
      expect(warning).not.toHaveBeenCalled();
    } finally { await surface.close(); warning.mockRestore(); vi.unstubAllEnvs(); }
  });

  it('publishes why pending UI work was resolved when the app-server disconnects', async () => {
    const { surface, transport } = createSurface();
    const events: CodexSurfaceEvent[] = [];
    surface.onEvent((event) => events.push(event));
    await surface.connect();

    transport.emitServerRequest('disconnect-approval', 'item/commandExecution/requestApproval', { kind: 'command', startedAtMs: 1,
        threadId: 'thread-existing', turnId: 'turn-disconnect', itemId: 'command-disconnect',
        command: 'npm test', cwd: '/tmp/project', reason: null, environmentId: null,
        commandActions: [], networkApprovalContext: null, additionalPermissions: null,
        availableDecisions: ['accept', 'decline'], proposedExecpolicyAmendment: null,
      });
    transport.emitServerRequest('disconnect-input', 'item/tool/requestUserInput', { isBlocking: false,
        threadId: 'thread-existing', turnId: 'turn-disconnect', itemId: 'input-disconnect',
        autoResolutionMs: null,
        questions: [{
          id: 'answer', header: 'Answer', question: 'Continue?', isOther: false, isSecret: false,
          options: null,
        }],
      });
    await vi.waitFor(() => expect(surface.getSnapshot()).toMatchObject({
      approvals: [expect.objectContaining({ id: 'disconnect-approval' })],
      clientRequests: [expect.objectContaining({ id: 'disconnect-input' })],
    }));
    events.length = 0;

    transport.fail(new Error('socket lost'));

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'approval.resolved',
        origin: 'notification',
        payload: expect.objectContaining({ reason: 'surface_disconnected' }),
      }),
      expect.objectContaining({
        type: 'clientRequest.resolved',
        origin: 'notification',
        payload: expect.objectContaining({ reason: 'surface_disconnected' }),
      }),
    ]));
  });

  it('clears authenticated state when a restarted app-server reports a signed-out account', async () => {
    let account: v2.Account | null = {
      type: 'chatgpt', workspaceName: null, email: 'before@example.test', planType: 'pro',
    };
    const transport = new MockCodexAppServer({
      'account/read': () => ({ workspaceRouting: null, account, requiresOpenaiAuth: true }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();
    expect(surface.getSnapshot().conversations).toHaveLength(1);

    transport.fail(new Error('restart'));
    account = null;
    await surface.connect();

    expect(surface.getSnapshot()).toMatchObject({
      status: 'ready',
      authentication: { account: null, requiresOpenaiAuth: true },
      conversations: [],
      activeConversationId: null,
      messages: [],
      models: [],
      modelCatalogStatus: 'notLoaded',
      plugins: [],
      pluginCatalogStatus: 'notLoaded',
    });
    expect(requestsFor(transport, 'thread/list')).toHaveLength(1);
  });

  it('bootstraps Codex and exposes conversation summaries without protocol details', async () => {
    const { surface, transport } = createSurface();
    const listener = vi.fn();
    surface.onStateChange(listener);

    const snapshot = await surface.connect();

    expect(snapshot).toMatchObject({
      status: 'ready',
      activeConversationId: 'thread-existing',
      conversations: [{
        id: 'thread-existing',
        title: 'Existing thread',
        preview: 'Existing thread',
        cwd: '/tmp/project',
      }],
      messages: expect.arrayContaining([expect.objectContaining({
        id: 'user-thread-existing-turn-history-user-history',
      })]),
      modelCatalogStatus: 'loaded',
      selectedModelId: 'gpt-5',
      approvalPreset: 'ask-for-approval',
    });
    expect(transport.sent.map((message) => 'method' in message ? message.method : null)).toStrictEqual([
      'initialize', 'initialized', 'experimentalFeature/list', 'account/read', 'model/list',
      'permissionProfile/list',
      'account/rateLimits/read', 'thread/list', 'configRequirements/read', 'thread/resume', 'thread/goal/get',
      'plugin/installed',
    ]);
    expect(lastRequest(transport, 'account/read')).toMatchObject({ params: { refreshToken: false } });
    expect(lastRequest(transport, 'thread/resume')).toMatchObject({
      params: {
        threadId: 'thread-existing',
        excludeTurns: true,
        initialTurnsPage: { limit: 5, itemsView: 'full', sortDirection: 'desc' },
      },
    });
    expect(listener).toHaveBeenCalled();
    await expect(surface.connect()).resolves.toMatchObject({ status: 'ready' });
    expect(transport.start).toHaveBeenCalledOnce();
  });

  it('enables supported SDK runtime features when the app-server advertises them as disabled', async () => {
    const transport = new MockCodexAppServer({
      'experimentalFeature/list': () => ({
        data: [
          {
            name: 'compaction_image_budget',
            stage: 'underDevelopment',
            displayName: null,
            description: null,
            announcement: null,
            enabled: false,
            defaultEnabled: false,
          },
          {
            name: 'default_mode_request_user_input',
            stage: 'underDevelopment',
            displayName: null,
            description: null,
            announcement: null,
            enabled: false,
            defaultEnabled: false,
          },
        ],
        nextCursor: null,
      }),
      'experimentalFeature/enablement/set': () => ({
        enablement: {
          compaction_image_budget: true,
          default_mode_request_user_input: true,
        },
      }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });

    await surface.connect();

    expect(lastRequest(transport, 'experimentalFeature/enablement/set')).toMatchObject({
      params: {
        enablement: {
          compaction_image_budget: true,
          default_mode_request_user_input: true,
        },
      },
    });
  });

  it('keeps older app-server releases usable when feature discovery is unavailable', async () => {
    const transport = new MockCodexAppServer({
      'experimentalFeature/list': () => Promise.reject(Object.assign(
        new Error('Method not found'),
        { code: -32601 },
      )),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });

    await expect(surface.connect()).resolves.toMatchObject({ status: 'ready' });
    expect(requestsFor(transport, 'experimentalFeature/enablement/set')).toHaveLength(0);
  });

  it('exposes the installed plugin catalog with canonical ids and renderer-safe presentation metadata', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null,
        data: [
          thread('thread-existing', false),
          { ...thread('thread-other', false), cwd: '/workspace/other' },
        ],
        nextCursor: null,
      }),
      'plugin/installed': () => ({
        marketplaces: [{
          name: 'installed',
          path: null,
          interface: null,
          plugins: [
            pluginSummary('gmail@openai-curated-remote', 'gmail', {
              displayName: ' Gmail ',
              shortDescription: ' Mail and calendar ',
              longDescription: ' Work with Gmail messages. ',
              brandColor: ' #ea4335 ',
              composerIconUrl: 'https://cdn.example.com/gmail-composer.png',
              logoUrl: 'https://cdn.example.com/gmail-logo.png',
              logoUrlDark: 'https://cdn.example.com/gmail-logo-dark.png',
            }),
            pluginSummary('drive@openai-curated-remote', 'drive', {
              displayName: 'Drive',
              logoUrl: 'https://cdn.example.com/drive-logo.png',
              logoUrlDark: 'https://cdn.example.com/drive-logo-dark.png',
            }),
          ],
        }],
        marketplaceLoadErrors: [],
      }),
    });
    const surface = new CodexSurface({
      client: new CodexAppServerClient(transport),
      cwd: '/tmp/project',
    });
    const events: CodexSurfaceEvent[] = [];
    surface.onEvent((event) => events.push(event));

    await surface.connect();
    await vi.waitFor(() => expect(surface.getSnapshot().pluginCatalogStatus).toBe('loaded'));

    expect(lastRequest(transport, 'plugin/installed')).toMatchObject({
      params: { cwds: ['/tmp/project', '/workspace/other'] },
    });
    expect(surface.getSnapshot().plugins).toStrictEqual([
      {
        id: 'gmail@openai-curated-remote',
        name: 'gmail',
        displayName: 'Gmail',
        shortDescription: 'Mail and calendar',
        longDescription: 'Work with Gmail messages.',
        brandColor: '#ea4335',
        iconUrl: 'https://cdn.example.com/gmail-composer.png',
        iconUrlDark: 'https://cdn.example.com/gmail-composer.png',
        enabled: true,
      },
      {
        id: 'drive@openai-curated-remote',
        name: 'drive',
        displayName: 'Drive',
        iconUrl: 'https://cdn.example.com/drive-logo.png',
        iconUrlDark: 'https://cdn.example.com/drive-logo-dark.png',
        enabled: true,
      },
    ]);
    expect(events.filter((event) => event.type === 'catalog.pluginsChanged')).toStrictEqual([
      expect.objectContaining({
        origin: 'action',
        payload: { plugins: [], status: 'loading' },
      }),
      expect.objectContaining({
        origin: 'action',
        payload: { plugins: surface.getSnapshot().plugins, status: 'loaded' },
      }),
    ]);
  });

  it('does not block ready state on a cold installed-plugin lookup', async () => {
    const pendingPlugins = deferred<v2.PluginInstalledResponse>();
    const transport = new MockCodexAppServer({
      'plugin/installed': () => pendingPlugins.promise,
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });

    await expect(surface.connect()).resolves.toMatchObject({
      status: 'ready',
      pluginCatalogStatus: 'loading',
      plugins: [],
    });
    expect(lastRequest(transport, 'plugin/installed')).toBeDefined();

    pendingPlugins.resolve({ marketplaces: [], marketplaceLoadErrors: [] });
    await vi.waitFor(() => expect(surface.getSnapshot().pluginCatalogStatus).toBe('loaded'));
  });

  it('connects signed out and becomes fully usable after managed ChatGPT login completes', async () => {
    let account: v2.Account | null = null;
    const transport = new MockCodexAppServer({
      'account/read': () => ({ workspaceRouting: null, account, requiresOpenaiAuth: true }),
      'account/login/start': () => ({
        type: 'chatgpt',
        loginId: 'login-1',
        authUrl: 'https://auth.example.test/login',
      }),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
      'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });

    await expect(surface.connect()).resolves.toMatchObject({
      status: 'ready',
      authentication: {
        status: 'loaded',
        account: null,
        requiresOpenaiAuth: true,
        error: null,
      },
      conversations: [],
      modelCatalogStatus: 'notLoaded',
    });
    expect(requestsFor(transport, 'thread/list')).toHaveLength(0);

    await expect(surface.startChatGptLogin()).resolves.toStrictEqual({
      loginId: 'login-1',
      authUrl: 'https://auth.example.test/login',
    });
    expect(lastRequest(transport, 'account/login/start')).toMatchObject({
      params: { type: 'chatgpt' },
    });
    expect(surface.getSnapshot().authentication.login).toMatchObject({
      status: 'pending',
      loginId: 'login-1',
    });

    account = { type: 'chatgpt', workspaceName: null, email: 'kid@example.test', planType: 'plus' };
    transport.emitNotification('account/login/completed', { onboardingEntrypoint: null, loginId: 'login-1', success: true, error: null });
    await vi.waitFor(() => expect(surface.getSnapshot()).toMatchObject({
      status: 'ready',
      authentication: {
        account: { type: 'chatgpt', email: 'kid@example.test', planType: 'plus' },
        requiresOpenaiAuth: true,
        login: { status: 'completed', loginId: 'login-1', error: null },
      },
      modelCatalogStatus: 'loaded',
      conversations: [{ id: 'thread-existing' }],
    }));

    await surface.createConversation();
    await surface.sendMessage('Hello after login');
    expect(lastRequest(transport, 'turn/start')).toMatchObject({
      params: expect.objectContaining({ threadId: 'thread-new' }),
    });
  });

  it('exposes state-neutral pairing, client management, and managed requirements methods', async () => {
    const status = {
      status: 'connected' as const,
      serverName: 'codex-desktop',
      installationId: 'installation-1',
      environmentId: 'environment-1',
    };
    const requirements = configRequirements({ allowRemoteControl: true });
    const transport = new MockCodexAppServer({
      'configRequirements/read': () => ({ supportsIndependentSpeedModes: null, requirements }),
      'remoteControl/status/read': () => status,
      'remoteControl/enable': () => ({ ...status, status: 'connecting' as const }),
      'remoteControl/disable': () => ({ ...status, status: 'disabled' as const, environmentId: null }),
      'remoteControl/pairing/start': () => ({
        pairingCode: 'pairing-code', manualPairingCode: '1234-5678',
        environmentId: 'environment-1', expiresAt: 123n,
      }),
      'remoteControl/pairing/status': () => ({ claimed: true }),
      'remoteControl/client/list': () => ({
        data: [{
          clientId: 'client-1', displayName: 'Nicolas phone', deviceType: 'phone', platform: 'ios',
          osVersion: '18.0', deviceModel: 'iPhone', appVersion: '1.0.0', lastSeenAt: 123n,
        }],
        nextCursor: null,
      }),
      'remoteControl/client/revoke': () => ({}),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport), cwd: '/tmp/project' });
    await surface.connect();
    await vi.waitFor(() => expect(surface.getSnapshot().pluginCatalogStatus).toBe('loaded'));
    const snapshotBeforeActions = surface.getSnapshot();

    await expect(surface.readRemoteControlStatus()).resolves.toStrictEqual(status);
    await expect(surface.enableRemoteControl({ ephemeral: true })).resolves.toMatchObject({ status: 'connecting' });
    await expect(surface.disableRemoteControl()).resolves.toMatchObject({ status: 'disabled', environmentId: null });
    await expect(surface.startRemoteControlPairing({ manualCode: true })).resolves.toMatchObject({
      pairingCode: 'pairing-code', manualPairingCode: '1234-5678', expiresAt: 123n,
    });
    await expect(surface.readRemoteControlPairingStatus({ pairingCode: 'pairing-code' }))
      .resolves.toStrictEqual({ claimed: true });
    await expect(surface.listRemoteControlClients({ environmentId: 'environment-1', limit: 10, order: 'desc' }))
      .resolves.toMatchObject({ data: [expect.objectContaining({ clientId: 'client-1' })], nextCursor: null });
    await expect(surface.revokeRemoteControlClient({ environmentId: 'environment-1', clientId: 'client-1' }))
      .resolves.toStrictEqual({});
    await expect(surface.readConfigRequirements()).resolves.toStrictEqual(requirements);

    expect(surface.getSnapshot()).toStrictEqual(snapshotBeforeActions);
    expect(lastRequest(transport, 'remoteControl/enable')).toMatchObject({ params: { ephemeral: true } });
    expect(lastRequest(transport, 'remoteControl/pairing/start')).toMatchObject({ params: { manualCode: true } });
    expect(lastRequest(transport, 'remoteControl/pairing/status')).toMatchObject({ params: { pairingCode: 'pairing-code' } });
    expect(lastRequest(transport, 'remoteControl/client/list')).toMatchObject({
      params: { environmentId: 'environment-1', limit: 10, order: 'desc' },
    });
    expect(lastRequest(transport, 'remoteControl/client/revoke')).toMatchObject({
      params: { environmentId: 'environment-1', clientId: 'client-1' },
    });
  });

});
