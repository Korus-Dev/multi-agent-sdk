import { describe, expect, it, vi } from 'vitest';
import type { CodexAppServerClient } from '@korus-dev/codex-sdk';
import type { EventOrigin } from '../../src/index';
import type { CodexAuthenticationState } from '../../src/internal';
import {
  initialAuthentication,
  normalizedLoginId,
  safeLoginUrl,
  hostAccount,
  hostAuthenticationIdentityKey,
  hostAuthenticationKey,
} from '../../src/providers/codex/host-authentication';
import {
  CodexHostAuthenticationController,
  type CodexHostAuthenticationDependencies,
} from '../../src/providers/codex/host-authentication-controller';
import { initialHostSnapshot } from '../../src/providers/codex/host-runtime';
import { deferred } from './helpers/host-fixture';

describe('Codex host authentication values', () => {
  it('normalizes each supported account type and identity', () => {
    expect(hostAccount({ type: 'chatgpt', email: 'person@example.test', planType: 'pro' }))
      .toStrictEqual({ type: 'chatgpt', email: 'person@example.test', planType: 'pro' });
    expect(hostAccount({ type: 'amazonBedrock', usesCodexManagedCredentials: true }))
      .toStrictEqual({ type: 'amazonBedrock', credentialSource: 'codexManaged' });
    expect(hostAccount({ type: 'amazonBedrock', usesCodexManagedCredentials: false }))
      .toStrictEqual({ type: 'amazonBedrock', credentialSource: 'awsManaged' });
    expect(hostAccount({ type: 'apiKey' })).toStrictEqual({ type: 'apiKey' });
    expect(hostAccount({ type: 'gcp' })).toStrictEqual({ type: 'gcp' });
    const workspace = hostAccount({ type: 'chatgpt', email: 'person@example.test', planType: 'team', workspaceName: 'Research' });
    expect(workspace).toStrictEqual({ type: 'chatgpt', email: 'person@example.test', planType: 'team', workspaceName: 'Research' });
    expect(hostAuthenticationIdentityKey(authentication({ account: workspace })))
      .not.toBe(hostAuthenticationIdentityKey(authentication({ account: { type: 'chatgpt', email: 'person@example.test', planType: 'team' } })));


    expect(hostAuthenticationIdentityKey(authentication({ account: null, requiresOpenaiAuth: true })))
      .toBe('{"type":null,"requiresOpenaiAuth":true}');
    expect(hostAuthenticationIdentityKey(authentication({
      account: { type: 'chatgpt', email: 'person@example.test', planType: 'pro' },
    }))).toBe('{"type":"chatgpt","email":"person@example.test"}');
    expect(hostAuthenticationIdentityKey(authentication({
      account: { type: 'amazonBedrock', credentialSource: 'awsManaged' },
    }))).toBe('{"type":"amazonBedrock","credentialSource":"awsManaged"}');
    expect(hostAuthenticationIdentityKey(authentication({ account: { type: 'apiKey' } })))
      .toBe('{"type":"apiKey"}');
  });

  it('keys bootstrap state separately from account identity', () => {
    const value = authentication({
      account: { type: 'chatgpt', email: 'person@example.test', planType: 'team' },
      requiresOpenaiAuth: false,
    });
    expect(hostAuthenticationKey(value)).toBe(JSON.stringify({
      account: value.account,
      requiresOpenaiAuth: false,
    }));
    expect(initialAuthentication()).toStrictEqual({
      status: 'notLoaded', account: null, requiresOpenaiAuth: null, error: null,
      login: { status: 'idle', loginId: null, authUrl: null, error: null },
    });
  });

  it('validates login ids and browser-safe authentication URLs', () => {
    expect(normalizedLoginId(' login-1 ')).toBe('login-1');
    expect(() => normalizedLoginId('  ')).toThrow('cannot be empty');
    expect(safeLoginUrl('https://example.test/login?q=1')).toBe('https://example.test/login?q=1');
    expect(safeLoginUrl('http://localhost:3000/callback')).toBe('http://localhost:3000/callback');
    expect(() => safeLoginUrl('not a url')).toThrow('invalid authentication URL');
    expect(() => safeLoginUrl('file:///tmp/login')).toThrow("unsupported authentication URL scheme 'file:'");
  });
});

describe('CodexHostAuthenticationController', () => {
  it('starts a new login instead of reusing any incomplete current login', async () => {
    for (const login of [
      { status: 'pending', loginId: null, authUrl: 'https://old.test' },
      { status: 'pending', loginId: 'old', authUrl: null },
      { status: 'idle', loginId: 'old', authUrl: 'https://old.test' },
    ] as const) {
      const request = vi.fn(async () => ({
        type: 'chatgpt', loginId: 'new', authUrl: 'https://new.test/login',
      }));
      const setup = setupController(request);
      setup.state.authentication.login = { ...login, error: null };
      await expect(setup.controller.startChatGptLogin()).resolves.toStrictEqual({
        loginId: 'new', authUrl: 'https://new.test/login',
      });
      expect(request).toHaveBeenCalledExactlyOnceWith('account/login/start', { type: 'chatgpt' });
    }
  });

  it('shares an in-flight login and clears it before a later independent attempt', async () => {
    const first = deferred<{ type: 'chatgpt'; loginId: string; authUrl: string }>();
    const request = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ type: 'chatgpt', loginId: 'second', authUrl: 'https://second.test' });
    const setup = setupController(request);

    const one = setup.controller.startChatGptLogin();
    const two = setup.controller.startChatGptLogin();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(setup.host.patchAuthentication).toHaveBeenCalledWith({
      login: { status: 'starting', loginId: null, authUrl: null, error: null },
    }, 'action');
    first.resolve({ type: 'chatgpt', loginId: 'first', authUrl: 'https://first.test' });
    await expect(Promise.all([one, two])).resolves.toStrictEqual([
      { loginId: 'first', authUrl: 'https://first.test/' },
      { loginId: 'first', authUrl: 'https://first.test/' },
    ]);
    expect(setup.state.authentication.login).toStrictEqual({
      status: 'pending', loginId: 'first', authUrl: 'https://first.test/', error: null,
    });
    expect(setup.host.patchAuthentication).toHaveBeenLastCalledWith({
      login: {
        status: 'pending', loginId: 'first', authUrl: 'https://first.test/', error: null,
      },
    }, 'action');
    expect(request).toHaveBeenCalledOnce();

    setup.state.authentication.login = {
      status: 'idle', loginId: null, authUrl: null, error: null,
    };
    await expect(setup.controller.startChatGptLogin()).resolves.toStrictEqual({
      loginId: 'second', authUrl: 'https://second.test/',
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('starts, reuses, and cancels a ChatGPT login', async () => {
    const request = vi.fn(async (method: string) => method === 'account/login/start'
      ? { type: 'chatgpt', loginId: ' login-1 ', authUrl: 'https://example.test/login' }
      : { status: 'canceled' });
    const { controller, state, host } = setupController(request);

    await expect(controller.startChatGptLogin()).resolves.toStrictEqual({
      loginId: 'login-1', authUrl: 'https://example.test/login',
    });
    expect(state.authentication.login.status).toBe('pending');
    await expect(controller.startChatGptLogin()).resolves.toStrictEqual({
      loginId: 'login-1', authUrl: 'https://example.test/login',
    });
    expect(request).toHaveBeenCalledTimes(1);

    await controller.cancelLogin(' login-1 ');
    expect(request).toHaveBeenLastCalledWith('account/login/cancel', { loginId: 'login-1' });
    expect(state.authentication.login.status).toBe('cancelled');
    expect(host.patchAuthentication).toHaveBeenLastCalledWith(expect.objectContaining({
      login: expect.objectContaining({ status: 'cancelled' }),
    }), 'action');
  });

  it('normalizes every cancel result and rejects an empty id before the RPC', async () => {
    const setup = setupController(vi.fn(async () => ({ status: 'notFound' })));
    setup.state.authentication.login = {
      status: 'pending', loginId: 'login', authUrl: 'https://login.test', error: 'old',
    };

    await expect(setup.controller.cancelLogin('login')).resolves.toBe(setup.state);
    expect(setup.state.authentication.login).toStrictEqual({
      status: 'idle', loginId: null, authUrl: null, error: null,
    });
    expect(setup.host.patchAuthentication).toHaveBeenLastCalledWith({
      login: { status: 'idle', loginId: null, authUrl: null, error: null },
    }, 'action');

    setup.host.patchAuthentication.mockClear();
    await expect(setup.controller.cancelLogin('   ')).rejects.toThrow('cannot be empty');
    expect(setup.host.patchAuthentication).not.toHaveBeenCalled();
  });

  it('surfaces invalid and rejected login attempts', async () => {
    const wrongType = setupController(vi.fn(async () => ({ type: 'apiKey' })));
    await expect(wrongType.controller.startChatGptLogin()).rejects.toThrow("unexpected login type 'apiKey'");
    expect(wrongType.state.authentication.login).toStrictEqual({
      status: 'error', loginId: null, authUrl: null,
      error: "Codex account/login/start returned unexpected login type 'apiKey'",
    });
    expect(wrongType.host.patchAuthentication).toHaveBeenLastCalledWith({
      login: {
        status: 'error', loginId: null, authUrl: null,
        error: "Codex account/login/start returned unexpected login type 'apiKey'",
      },
    }, 'action');

    const rejected = setupController(vi.fn(async () => { throw new Error('offline'); }));
    await expect(rejected.controller.startChatGptLogin()).rejects.toThrow('offline');
    expect(rejected.state.authentication.login).toMatchObject({ status: 'error', error: 'offline' });

    rejected.state.authentication.login = {
      status: 'idle', loginId: null, authUrl: null, error: null,
    };
    await expect(rejected.controller.startChatGptLogin()).rejects.toThrow('offline');
    expect(rejected.request).toHaveBeenCalledTimes(2);
  });

  it('logs out with exact protocol and bootstraps an allowed account', async () => {
    const request = vi.fn(async (method: string) => method === 'account/logout'
      ? {}
      : { account: { type: 'apiKey' }, requiresOpenaiAuth: false });
    const setup = setupController(request);
    setup.state.authentication.login = {
      status: 'completed', loginId: 'login', authUrl: 'https://login.test', error: 'old',
    };

    await expect(setup.controller.logout()).resolves.toBe(setup.state);

    expect(request).toHaveBeenNthCalledWith(1, 'account/logout', undefined);
    expect(request).toHaveBeenNthCalledWith(2, 'account/read', { refreshToken: false });
    expect(setup.host.patchAuthentication).toHaveBeenCalledWith({
      login: { status: 'idle', loginId: null, authUrl: null, error: null },
    }, 'action');
    expect(setup.host.patchAuthentication.mock.calls.slice(1)).toStrictEqual([
      [{ status: 'loading', error: null }, 'action'],
      [{
        status: 'loaded', account: { type: 'apiKey' }, requiresOpenaiAuth: false, error: null,
      }, 'action'],
    ]);
    expect(setup.host.clearAuthenticatedHostData).not.toHaveBeenCalled();
    expect(setup.host.bootstrapHostData).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('clears data and skips bootstrap when logout leaves authentication blocked', async () => {
    const setup = setupController(vi.fn(async (method: string) => method === 'account/logout'
      ? {}
      : { account: null, requiresOpenaiAuth: true }));

    await setup.controller.logout();

    expect(setup.host.clearAuthenticatedHostData).toHaveBeenCalledOnce();
    expect(setup.host.bootstrapHostData).not.toHaveBeenCalled();
  });

  it('clears data and reboots when logout changes account identity', async () => {
    let email = 'first@example.test';
    const request = vi.fn(async (method: string) => method === 'account/logout'
      ? {}
      : { account: { type: 'chatgpt', email, planType: 'pro' }, requiresOpenaiAuth: false });
    const setup = setupController(request);
    await setup.controller.load('lifecycle');
    email = 'second@example.test';
    setup.host.patchAuthentication.mockClear();

    await setup.controller.logout();

    expect(setup.host.clearAuthenticatedHostData).toHaveBeenCalledOnce();
    expect(setup.host.bootstrapHostData).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('loads authentication, detects identity changes, and records read failures', async () => {
    let email = 'first@example.test';
    const request = vi.fn(async () => ({
      account: { type: 'chatgpt', email, planType: 'pro' }, requiresOpenaiAuth: false,
    }));
    const setup = setupController(request);
    await expect(setup.controller.load('lifecycle')).resolves.toBe(false);
    await expect(setup.controller.load('notification')).resolves.toBe(false);
    email = 'second@example.test';
    await expect(setup.controller.load('notification')).resolves.toBe(true);
    expect(setup.state.authentication.account).toMatchObject({ email: 'second@example.test' });

    request.mockRejectedValueOnce(new Error('read failed'));
    await expect(setup.controller.load('action')).rejects.toThrow('read failed');
    expect(setup.state.authentication).toMatchObject({ status: 'error', error: 'read failed' });
  });

  it('loads an absent account with exact transitions, request, and origin', async () => {
    const setup = setupController(vi.fn(async () => ({ account: null, requiresOpenaiAuth: true })));

    await expect(setup.controller.load('notification')).resolves.toBe(false);

    expect(setup.request).toHaveBeenCalledExactlyOnceWith('account/read', { refreshToken: false });
    expect(setup.host.patchAuthentication.mock.calls).toStrictEqual([
      [{ status: 'loading', error: null }, 'notification'],
      [{ status: 'loaded', account: null, requiresOpenaiAuth: true, error: null }, 'notification'],
    ]);
  });

  it('refreshes bootstrap state and honors the blocked-authentication boundary', async () => {
    const allowed = setupController(vi.fn(async () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })));
    await allowed.controller.refresh('action', true);
    expect(allowed.host.bootstrapHostData).toHaveBeenCalledWith(true);
    expect(allowed.host.clearAuthenticatedHostData).not.toHaveBeenCalled();
    expect(allowed.controller.pendingRefresh()).toBeNull();

    const blocked = setupController(vi.fn(async () => ({ account: null, requiresOpenaiAuth: true })));
    await blocked.controller.refresh('lifecycle');
    expect(blocked.controller.blocksBootstrap()).toBe(true);
    expect(blocked.host.clearAuthenticatedHostData).toHaveBeenCalledOnce();
    expect(blocked.host.bootstrapHostData).not.toHaveBeenCalled();
  });

  it('coalesces refreshes while preserving the latest origin and force request', async () => {
    const first = deferred<{ account: { type: 'apiKey' }; requiresOpenaiAuth: boolean }>();
    const request = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ account: { type: 'apiKey' }, requiresOpenaiAuth: false });
    const setup = setupController(request);

    const action = setup.controller.refresh('action');
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(setup.controller.pendingRefresh()).toBe(action);
    const notification = setup.controller.refresh('notification', true);
    expect(notification).toBe(action);
    first.resolve({ account: { type: 'apiKey' }, requiresOpenaiAuth: false });
    await action;

    expect(request).toHaveBeenCalledTimes(2);
    expect(setup.host.bootstrapHostData.mock.calls).toStrictEqual([[false], [true]]);
    expect(setup.host.patchAuthentication.mock.calls).toStrictEqual([
      [{ status: 'loading', error: null }, 'action'],
      [{ status: 'loaded', account: { type: 'apiKey' }, requiresOpenaiAuth: false, error: null }, 'action'],
      [{ status: 'loading', error: null }, 'notification'],
      [{ status: 'loaded', account: { type: 'apiKey' }, requiresOpenaiAuth: false, error: null }, 'notification'],
    ]);
    expect(setup.controller.pendingRefresh()).toBeNull();
  });

  it('retries a failed refresh when another refresh is queued and preserves force', async () => {
    const first = deferred<never>();
    const request = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ account: { type: 'apiKey' }, requiresOpenaiAuth: false });
    const setup = setupController(request);

    const refresh = setup.controller.refresh('action', true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(setup.controller.refresh('notification')).toBe(refresh);
    first.reject(new Error('superseded failure'));

    await expect(refresh).resolves.toBe(setup.state);
    expect(request).toHaveBeenCalledTimes(2);
    expect(setup.host.bootstrapHostData).toHaveBeenCalledExactlyOnceWith(true);
    expect(setup.state.authentication).toMatchObject({ status: 'loaded', account: { type: 'apiKey' } });
  });

  it('resets force-bootstrap between successful queued refreshes', async () => {
    const first = deferred<{ account: { type: 'apiKey' }; requiresOpenaiAuth: boolean }>();
    const request = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ account: { type: 'apiKey' }, requiresOpenaiAuth: false });
    const setup = setupController(request);

    const refresh = setup.controller.refresh('action', true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    setup.controller.refresh('notification', false);
    first.resolve({ account: { type: 'apiKey' }, requiresOpenaiAuth: false });
    await refresh;

    expect(setup.host.bootstrapHostData.mock.calls).toStrictEqual([[true], [false]]);
  });

  it('rejects an unqueued refresh failure and clears pending state', async () => {
    const setup = setupController(vi.fn(async () => { throw new Error('read failed'); }));
    await expect(setup.controller.refresh('action', true)).rejects.toThrow('read failed');
    expect(setup.host.bootstrapHostData).not.toHaveBeenCalled();
    expect(setup.controller.pendingRefresh()).toBeNull();
  });

  it('blocks bootstrap only for the exact loaded, absent, required-auth state', () => {
    const setup = setupController(vi.fn());
    const cases = [
      { status: 'notLoaded', account: null, requiresOpenaiAuth: true, expected: false },
      { status: 'loaded', account: { type: 'apiKey' }, requiresOpenaiAuth: true, expected: false },
      { status: 'loaded', account: null, requiresOpenaiAuth: false, expected: false },
      { status: 'loaded', account: null, requiresOpenaiAuth: true, expected: true },
    ] as const;
    for (const entry of cases) {
      setup.state.authentication = authentication({
        status: entry.status, account: entry.account, requiresOpenaiAuth: entry.requiresOpenaiAuth,
      });
      expect(setup.controller.blocksBootstrap()).toBe(entry.expected);
    }
  });

  it('handles login completion notifications and refresh errors', async () => {
    const failed = setupController(vi.fn(async () => ({ account: null, requiresOpenaiAuth: true })));
    failed.state.authentication.login = {
      status: 'pending', loginId: 'login-current', authUrl: 'https://example.test/login', error: null,
    };
    failed.controller.handleLoginCompleted({
      loginId: null, success: false, error: null, onboardingEntrypoint: null,
    });
    expect(failed.state.authentication.login).toMatchObject({
      status: 'error', loginId: 'login-current', error: 'Codex sign-in failed',
    });

    const successful = setupController(vi.fn(async () => { throw new Error('refresh failed'); }));
    successful.controller.handleLoginCompleted({
      loginId: 'login-2', success: true, error: null, onboardingEntrypoint: null,
    });
    expect(successful.state.authentication.login.status).toBe('completed');
    await vi.waitFor(() => expect(successful.host.reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'refresh failed',
    })));
  });

  it('preserves explicit failure details and current URL in a login notification', () => {
    const setup = setupController(vi.fn());
    setup.state.authentication.login = {
      status: 'pending', loginId: 'current', authUrl: 'https://login.test', error: null,
    };

    setup.controller.handleLoginCompleted({
      loginId: 'reported', success: false, error: 'Denied', onboardingEntrypoint: null,
    });

    expect(setup.host.patchAuthentication).toHaveBeenCalledExactlyOnceWith({
      login: {
        status: 'error', loginId: 'reported', authUrl: 'https://login.test', error: 'Denied',
      },
    }, 'notification');
    expect(setup.request).not.toHaveBeenCalled();
  });

  it('projects successful login completion and refreshes with notification origin', async () => {
    const setup = setupController(vi.fn(async () => ({
      account: { type: 'apiKey' }, requiresOpenaiAuth: false,
    })));
    setup.state.authentication.login = {
      status: 'pending', loginId: 'current', authUrl: 'https://login.test', error: 'old',
    };

    setup.controller.handleLoginCompleted({
      loginId: null, success: true, error: null, onboardingEntrypoint: null,
    });

    expect(setup.host.patchAuthentication).toHaveBeenNthCalledWith(1, {
      login: { status: 'completed', loginId: 'current', authUrl: 'https://login.test', error: null },
    }, 'notification');
    await vi.waitFor(() => expect(setup.host.bootstrapHostData).toHaveBeenCalledWith(false));
    expect(setup.host.patchAuthentication.mock.calls.slice(1)).toStrictEqual([
      [{ status: 'loading', error: null }, 'notification'],
      [{
        status: 'loaded', account: { type: 'apiKey' }, requiresOpenaiAuth: false, error: null,
      }, 'notification'],
    ]);
  });
});

function authentication(overrides: Partial<CodexAuthenticationState> = {}): CodexAuthenticationState {
  return { ...initialAuthentication(), ...overrides };
}

function setupController(request: ReturnType<typeof vi.fn>) {
  const state = initialHostSnapshot(initialAuthentication());
  const host = {
    bootstrapHostData: vi.fn(async () => undefined),
    clearAuthenticatedHostData: vi.fn(async () => undefined),
    getSnapshot: () => state,
    patchAuthentication: vi.fn((patch: Partial<CodexAuthenticationState>, _origin: EventOrigin) => {
      state.authentication = { ...state.authentication, ...patch };
    }),
    reportError: vi.fn(),
  } satisfies CodexHostAuthenticationDependencies;
  const client = { request } as unknown as CodexAppServerClient;
  return { controller: new CodexHostAuthenticationController(client, host), host, request, state };
}
