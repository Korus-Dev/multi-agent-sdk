import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk';
import { CodexSurface } from '../../src/providers/codex';
import type { CodexSurfaceEvent } from '../../src/index';
import { MockCodexAppServer, deferred, lastRequest, requestsFor, resumeResponse, testModel, thread, turn } from './helpers/codex-surface-fixture';

describe('CodexSurface', () => {
  it('reports a failed post-login account refresh on the surface', async () => {
    let accountReadCount = 0;
    const transport = new MockCodexAppServer({
      'account/read': () => {
        accountReadCount += 1;
        if (accountReadCount === 1) return { workspaceRouting: null, account: null, requiresOpenaiAuth: true };
        throw new Error('post-login account refresh failed');
      },
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();

    transport.emitNotification('account/login/completed', { onboardingEntrypoint: null, loginId: 'login-error', success: true, error: null });

    await vi.waitFor(() => expect(surface.getSnapshot()).toMatchObject({
      error: 'post-login account refresh failed',
      authentication: {
        status: 'error',
        error: 'post-login account refresh failed',
        login: { status: 'completed', loginId: 'login-error' },
      },
    }));
    await surface.close();
  });

  it('gates immediate post-login sends until auth-dependent catalogs finish loading', async () => {
    let account: v2.Account | null = null;
    const models = deferred<v2.ModelListResponse>();
    const transport = new MockCodexAppServer({
      'account/read': () => ({ workspaceRouting: null, account, requiresOpenaiAuth: true }),
      'model/list': () => models.promise,
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [], nextCursor: null }),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
      'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
    });
    const surface = new CodexSurface({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(transport),
      conversationDefaults: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    });
    await surface.connect();

    account = { type: 'chatgpt', workspaceName: null, email: 'kid@example.test', planType: 'plus' };
    transport.emitNotification('account/login/completed', { onboardingEntrypoint: null, loginId: 'login-immediate', success: true, error: null });
    await vi.waitFor(() => expect(surface.getSnapshot().authentication.account).toMatchObject({
      type: 'chatgpt',
      email: 'kid@example.test',
    }));

    const send = surface.sendMessage('Hello immediately');
    expect(lastRequest(transport, 'thread/start')).toBeUndefined();
    models.resolve({
      data: [testModel('gpt-5.6-terra', 'gpt-5.6-terra', true)],
      nextCursor: null,
    });
    await send;

    expect(lastRequest(transport, 'thread/start')).toMatchObject({
      params: { model: 'gpt-5.6-terra' },
    });
    expect(lastRequest(transport, 'turn/start')).toMatchObject({
      params: expect.objectContaining({
        threadId: 'thread-new',
        model: 'gpt-5.6-terra',
        effort: 'medium',
      }),
    });
  });

  it.each([false, true])('invalidates conversation state on account or workspace switches (workspace: %s)', async (workspace) => {
    let account: Extract<v2.Account, { type: 'chatgpt' }> = {
      type: 'chatgpt', workspaceName: workspace ? 'First' : null, email: 'account-a@example.test', planType: 'pro',
    };
    const transport = new MockCodexAppServer({
      'account/read': () => ({ workspaceRouting: null, account, requiresOpenaiAuth: true }),
      'thread/list': () => ({ readStates: null, backwardsCursor: null,
        data: account.email?.startsWith('account-a') && account.workspaceName !== 'Second' ? [thread('thread-existing', false)] : [],
        nextCursor: null,
      }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    const events: CodexSurfaceEvent[] = [];
    surface.onEvent((event) => events.push(event));
    await surface.connect();
    const accountAHandle = surface.conversation('thread-existing');
    expect(surface.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-existing',
      messages: expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
    });

    const expectedAccount = { type: 'chatgpt' as const, email: workspace ? 'account-a@example.test' : 'account-b@example.test', planType: 'plus', ...(workspace ? { workspaceName: 'Second' } : {}) };
    account = { ...expectedAccount, planType: 'plus', workspaceName: workspace ? 'Second' : null };
    events.length = 0;
    transport.emitNotification('account/updated', { authMode: 'chatgpt', planType: 'plus' });

    await vi.waitFor(() => expect(surface.getSnapshot()).toMatchObject({
      authentication: {
        account: expectedAccount,
      },
      conversations: [],
      activeConversationId: null,
      messages: [],
    }));
    expect(requestsFor(transport, 'thread/list')).toHaveLength(2);
    expect(surface.conversation('thread-existing')).not.toBe(accountAHandle);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'authentication.changed',
      origin: 'notification',
      payload: {
        authentication: expect.objectContaining({
          account: expectedAccount,
        }),
      },
    }));
  });

  it('retains account identity across account/read errors so a later account switch still invalidates state', async () => {
    let account: Extract<v2.Account, { type: 'chatgpt' }> = {
      type: 'chatgpt', workspaceName: null, email: 'account-a@example.test', planType: 'pro',
    };
    let failAccountRead = false;
    const transport = new MockCodexAppServer({
      'account/read': () => {
        if (failAccountRead) throw new Error('account temporarily unavailable');
        return { workspaceRouting: null, account, requiresOpenaiAuth: true };
      },
      'thread/list': () => ({ readStates: null, backwardsCursor: null,
        data: account.email?.startsWith('account-a') ? [thread('thread-existing', false)] : [],
        nextCursor: null,
      }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();
    expect(surface.getSnapshot().activeConversationId).toBe('thread-existing');

    failAccountRead = true;
    transport.emitNotification('account/updated', { authMode: 'chatgpt', planType: 'pro' });
    await vi.waitFor(() => expect(surface.getSnapshot().authentication).toMatchObject({
      status: 'error',
      account: { email: 'account-a@example.test' },
      error: 'account temporarily unavailable',
    }));

    failAccountRead = false;
    account = { type: 'chatgpt', workspaceName: null, email: 'account-b@example.test', planType: 'plus' };
    await surface.refreshAccount();
    expect(surface.getSnapshot()).toMatchObject({
      authentication: { account: { email: 'account-b@example.test' } },
      conversations: [],
      activeConversationId: null,
      messages: [],
    });
  });

  it('does not invalidate conversation state for metadata changes on the same account', async () => {
    let account: v2.Account = { type: 'chatgpt', workspaceName: null, email: 'same@example.test', planType: 'plus' };
    const transport = new MockCodexAppServer({
      'account/read': () => ({ workspaceRouting: null, account, requiresOpenaiAuth: true }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();
    const messages = surface.getSnapshot().messages;
    const resumeCount = requestsFor(transport, 'thread/resume').length;

    account = { type: 'chatgpt', workspaceName: null, email: 'same@example.test', planType: 'pro' };
    transport.emitNotification('account/updated', { authMode: 'chatgpt', planType: 'pro' });
    await vi.waitFor(() => expect(surface.getSnapshot().authentication.account).toMatchObject({ planType: 'pro' }));

    expect(surface.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-existing',
      messages,
    });
    expect(requestsFor(transport, 'thread/resume')).toHaveLength(resumeCount);
  });

  it('deduplicates concurrent managed ChatGPT login starts', async () => {
    const login = deferred<v2.LoginAccountResponse>();
    const transport = new MockCodexAppServer({
      'account/read': () => ({ workspaceRouting: null, account: null, requiresOpenaiAuth: true }),
      'account/login/start': () => login.promise,
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();

    const first = surface.startChatGptLogin();
    const second = surface.startChatGptLogin();
    await vi.waitFor(() => expect(requestsFor(transport, 'account/login/start')).toHaveLength(1));
    login.resolve({
      type: 'chatgpt',
      loginId: 'login-shared',
      authUrl: 'https://auth.example.test/login',
    });

    await expect(Promise.all([first, second])).resolves.toStrictEqual([
      { loginId: 'login-shared', authUrl: 'https://auth.example.test/login' },
      { loginId: 'login-shared', authUrl: 'https://auth.example.test/login' },
    ]);
    expect(requestsFor(transport, 'account/login/start')).toHaveLength(1);
  });

  it('starts a managed ChatGPT device-code login on a headless surface', async () => {
    let account: v2.Account | null = null;
    const transport = new MockCodexAppServer({
      'account/read': () => ({ workspaceRouting: null, account, requiresOpenaiAuth: true }),
      'account/login/start': () => ({
        type: 'chatgptDeviceCode',
        loginId: ' device-login ',
        verificationUrl: 'https://auth.example.test/device',
        userCode: 'ABCD-EFGH',
      }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    const events: CodexSurfaceEvent[] = [];
    const unsubscribe = surface.onEvent((event) => events.push(event));
    await surface.connect();

    await expect(surface.startChatGptDeviceCodeLogin()).resolves.toStrictEqual({
      loginId: 'device-login',
      verificationUrl: 'https://auth.example.test/device',
      userCode: 'ABCD-EFGH',
    });
    expect(lastRequest(transport, 'account/login/start')).toMatchObject({
      params: { type: 'chatgptDeviceCode' },
    });
    expect(surface.getSnapshot().authentication.login).toStrictEqual({
      status: 'pending',
      loginId: 'device-login',
      authUrl: 'https://auth.example.test/device',
      error: null,
    });
    account = { type: 'chatgpt', workspaceName: null, email: 'headless@example.test', planType: 'pro' };
    transport.emitNotification('account/login/completed', { onboardingEntrypoint: null, loginId: 'device-login', success: true, error: null });
    await vi.waitFor(() => expect(surface.getSnapshot().authentication).toMatchObject({
      account: { type: 'chatgpt', email: 'headless@example.test', planType: 'pro' },
      login: { status: 'completed', loginId: 'device-login', error: null },
    }));
    expect(events.filter((event) => event.type === 'authentication.changed').map((event) => (
      event.payload.authentication.login.status
    ))).toEqual(expect.arrayContaining(['starting', 'pending', 'completed']));
    unsubscribe();
    await surface.close();
  });

  it('reuses a pending device code until that login is cancelled', async () => {
    let attempt = 0;
    const firstAttempt = deferred<v2.LoginAccountResponse>();
    const transport = new MockCodexAppServer({
      'account/read': () => ({ workspaceRouting: null, account: null, requiresOpenaiAuth: true }),
      'account/login/start': () => {
        attempt += 1;
        if (attempt === 1) return firstAttempt.promise;
        return {
          type: 'chatgptDeviceCode',
          loginId: `device-login-${attempt}`,
          verificationUrl: `https://auth.example.test/device/${attempt}`,
          userCode: `CODE-${attempt}`,
        };
      },
      'account/login/cancel': () => ({ status: 'canceled' }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();

    const firstPromise = surface.startChatGptDeviceCodeLogin();
    const concurrentPromise = surface.startChatGptDeviceCodeLogin();
    await vi.waitFor(() => expect(requestsFor(transport, 'account/login/start')).toHaveLength(1));
    firstAttempt.resolve({
      type: 'chatgptDeviceCode',
      loginId: 'device-login-1',
      verificationUrl: 'https://auth.example.test/device/1',
      userCode: 'CODE-1',
    });
    const [first, concurrent] = await Promise.all([firstPromise, concurrentPromise]);
    expect(concurrent).toStrictEqual(first);
    await expect(surface.startChatGptDeviceCodeLogin()).resolves.toStrictEqual(first);
    expect(requestsFor(transport, 'account/login/start')).toHaveLength(1);

    await surface.cancelLogin(first.loginId);
    await expect(surface.startChatGptDeviceCodeLogin()).resolves.toMatchObject({
      loginId: 'device-login-2',
      userCode: 'CODE-2',
    });
    expect(requestsFor(transport, 'account/login/start')).toHaveLength(2);
    await surface.close();
  });

  it('rejects every invalid device-code login response through one contract', async () => {
    const cases: Array<[v2.LoginAccountResponse, string]> = [
      [
        { type: 'chatgpt', loginId: 'browser-login', authUrl: 'https://auth.example.test/login' },
        "unexpected login type 'chatgpt'",
      ],
      [
        {
          type: 'chatgptDeviceCode', loginId: 'device-login',
          verificationUrl: 'file:///tmp/device', userCode: 'CODE-1',
        },
        "unsupported authentication URL scheme 'file:'",
      ],
      [
        {
          type: 'chatgptDeviceCode', loginId: 'device-login',
          verificationUrl: 'https://auth.example.test/device', userCode: '   ',
        },
        'empty device user code',
      ],
    ];

    for (const [response, message] of cases) {
      const transport = new MockCodexAppServer({
        'account/read': () => ({ workspaceRouting: null, account: null, requiresOpenaiAuth: true }),
        'account/login/start': () => response,
      });
      const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
      await surface.connect();

      await expect(surface.startChatGptDeviceCodeLogin()).rejects.toThrow(message);
      expect(surface.getSnapshot().authentication.login).toMatchObject({
        status: 'error', loginId: null, authUrl: null,
      });
      await surface.close();
    }
  });

  it('runs a trailing authoritative account refresh when login completes during an older refresh', async () => {
    const staleRefresh = deferred<v2.GetAccountResponse>();
    let accountReadCount = 0;
    const transport = new MockCodexAppServer({
      'account/read': () => {
        accountReadCount += 1;
        if (accountReadCount === 1) return { workspaceRouting: null, account: null, requiresOpenaiAuth: true };
        if (accountReadCount === 2) return staleRefresh.promise;
        return { workspaceRouting: null,
          account: { type: 'chatgpt', workspaceName: null, email: 'fresh@example.test', planType: 'plus' },
          requiresOpenaiAuth: true,
        };
      },
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();

    transport.emitNotification('account/updated', { authMode: 'chatgpt', planType: null });
    await vi.waitFor(() => expect(requestsFor(transport, 'account/read')).toHaveLength(2));
    transport.emitNotification('account/login/completed', { onboardingEntrypoint: null, loginId: 'login-trailing', success: true, error: null });
    staleRefresh.resolve({ workspaceRouting: null, account: null, requiresOpenaiAuth: true });

    await vi.waitFor(() => expect(surface.getSnapshot()).toMatchObject({
      authentication: {
        account: { type: 'chatgpt', email: 'fresh@example.test', planType: 'plus' },
        login: { status: 'completed', loginId: 'login-trailing' },
      },
      modelCatalogStatus: 'loaded',
    }));
    expect(requestsFor(transport, 'account/read')).toHaveLength(3);
  });

  it('still runs the trailing account refresh when the superseded refresh rejects', async () => {
    const staleRefresh = deferred<v2.GetAccountResponse>();
    let accountReadCount = 0;
    const transport = new MockCodexAppServer({
      'account/read': () => {
        accountReadCount += 1;
        if (accountReadCount === 1) return { workspaceRouting: null, account: null, requiresOpenaiAuth: true };
        if (accountReadCount === 2) return staleRefresh.promise;
        return { workspaceRouting: null,
          account: { type: 'chatgpt', workspaceName: null, email: 'recovered@example.test', planType: 'plus' },
          requiresOpenaiAuth: true,
        };
      },
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();

    transport.emitNotification('account/updated', { authMode: 'chatgpt', planType: null });
    await vi.waitFor(() => expect(requestsFor(transport, 'account/read')).toHaveLength(2));
    transport.emitNotification('account/login/completed', { onboardingEntrypoint: null, loginId: 'login-after-error', success: true, error: null });
    staleRefresh.reject(new Error('superseded account read failed'));

    await vi.waitFor(() => expect(surface.getSnapshot()).toMatchObject({
      authentication: {
        status: 'loaded',
        account: { type: 'chatgpt', email: 'recovered@example.test' },
        login: { status: 'completed', loginId: 'login-after-error' },
      },
      modelCatalogStatus: 'loaded',
    }));
    expect(requestsFor(transport, 'account/read')).toHaveLength(3);
  });

  it('refreshes the full authoritative account projection on account updates', async () => {
    let account: v2.Account = {
      type: 'chatgpt', workspaceName: null, email: 'before@example.test', planType: 'pro',
    };
    const transport = new MockCodexAppServer({
      'account/read': () => ({ workspaceRouting: null, account, requiresOpenaiAuth: true }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();

    account = { type: 'apiKey' };
    transport.emitNotification('account/updated', { authMode: 'apikey', planType: null });
    await vi.waitFor(() => expect(surface.getSnapshot().authentication.account).toStrictEqual({ type: 'apiKey' }));
    expect(requestsFor(transport, 'account/read')).toHaveLength(2);
    expect(transport.sent.some((message) => 'method' in message && message.method === 'getAuthStatus')).toBe(false);
  });

  it('validates managed login responses and exposes cancellation and logout state', async () => {
    let signedOut = false;
    const transport = new MockCodexAppServer({
      'account/read': () => signedOut
        ? { workspaceRouting: null, account: null, requiresOpenaiAuth: true }
        : { workspaceRouting: null, account: { type: 'apiKey' }, requiresOpenaiAuth: true },
      'account/login/start': () => ({ type: 'chatgpt', loginId: 'login-2', authUrl: 'file:///tmp/nope' }),
      'account/login/cancel': () => ({ status: 'canceled' }),
      'account/logout': () => {
        signedOut = true;
        return {};
      },
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();

    await expect(surface.startChatGptLogin()).rejects.toThrow('unsupported authentication URL scheme');
    expect(surface.getSnapshot().authentication.login.status).toBe('error');
    await surface.cancelLogin('login-2');
    expect(lastRequest(transport, 'account/login/cancel')).toMatchObject({ params: { loginId: 'login-2' } });
    expect(surface.getSnapshot().authentication.login.status).toBe('cancelled');

    await surface.logout();
    expect(lastRequest(transport, 'account/logout')).toBeDefined();
    expect(surface.getSnapshot()).toMatchObject({
      authentication: { account: null, requiresOpenaiAuth: true },
      conversations: [],
      models: [],
    });
  });

  it('cancels the active login by default and rejects cancellation without one', async () => {
    const transport = new MockCodexAppServer({
      'account/login/start': () => ({
        type: 'chatgpt', loginId: 'login-default', authUrl: 'https://example.test/login',
      }),
      'account/login/cancel': () => ({ status: 'canceled' }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();

    await surface.startChatGptLogin();
    await surface.cancelLogin();

    expect(lastRequest(transport, 'account/login/cancel')).toMatchObject({
      params: { loginId: 'login-default' },
    });
    await surface.close();

    const withoutLogin = new CodexSurface({
      client: new CodexAppServerClient(new MockCodexAppServer()),
    });
    await withoutLogin.connect();
    await expect(withoutLogin.cancelLogin()).rejects.toThrow('Codex login id cannot be empty');
    await withoutLogin.close();
  });

});
