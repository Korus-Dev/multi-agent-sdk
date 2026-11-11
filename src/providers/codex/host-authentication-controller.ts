import type { CodexAppServerClient, v2 } from '@korus-dev/codex-sdk';
import type { CodexChatGptDeviceCodeLogin, CodexChatGptLogin, EventOrigin } from '../../core/codex-host';
import type { CodexAuthenticationState, CodexSnapshot } from '../../core/codex-conversation-types';
import {
  normalizedLoginId,
  safeLoginUrl,
  hostAccount,
  hostAuthenticationIdentityKey,
} from './host-authentication';
import { errorMessage } from './host-prompts';

export type CodexHostAuthenticationDependencies = {
  bootstrapHostData(force?: boolean): Promise<void>;
  clearAuthenticatedHostData(): Promise<void>;
  getSnapshot(): CodexSnapshot;
  patchAuthentication(patch: Partial<CodexAuthenticationState>, origin: EventOrigin): void;
  reportError(error: unknown): void;
};

export class CodexHostAuthenticationController {
  private accountRefreshPromise: Promise<CodexSnapshot> | null = null;
  private accountRefreshRequested = false;
  private accountRefreshForceBootstrap = false;
  private accountRefreshOrigin: EventOrigin = 'action';
  private chatGptLoginPromise: Promise<CodexChatGptLogin> | null = null;
  private chatGptDeviceCodeLoginPromise: Promise<CodexChatGptDeviceCodeLogin> | null = null;
  private activeChatGptDeviceCodeLogin: CodexChatGptDeviceCodeLogin | null = null;
  private lastLoadedAuthenticationIdentityKey: string | null = null;

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly host: CodexHostAuthenticationDependencies,
  ) {}

  pendingRefresh(): Promise<CodexSnapshot> | null {
    return this.accountRefreshPromise;
  }

  async startChatGptLogin(): Promise<CodexChatGptLogin> {
    const current = this.host.getSnapshot().authentication.login;
    if (current.status === 'pending' && current.loginId && current.authUrl) {
      return { loginId: current.loginId, authUrl: current.authUrl };
    }
    if (this.chatGptLoginPromise) return this.chatGptLoginPromise;
    const start = (async () => {
      this.host.patchAuthentication({
        login: { status: 'starting', loginId: null, authUrl: null, error: null },
      }, 'action');
      try {
        const response = await this.client.request('account/login/start', { type: 'chatgpt' });
        if (response.type !== 'chatgpt') {
          throw new Error(`Codex account/login/start returned unexpected login type '${response.type}'`);
        }
        const loginId = normalizedLoginId(response.loginId);
        const authUrl = safeLoginUrl(response.authUrl);
        this.host.patchAuthentication({
          login: { status: 'pending', loginId, authUrl, error: null },
        }, 'action');
        return { loginId, authUrl };
      } catch (error) {
        this.host.patchAuthentication({
          login: { status: 'error', loginId: null, authUrl: null, error: errorMessage(error) },
        }, 'action');
        throw error;
      }
    })();
    this.chatGptLoginPromise = start;
    void start.finally(() => {
      this.chatGptLoginPromise = null;
    }).catch(() => undefined);
    return start;
  }

  async startChatGptDeviceCodeLogin(): Promise<CodexChatGptDeviceCodeLogin> {
    const current = this.host.getSnapshot().authentication.login;
    if (
      current.status === 'pending'
      && current.loginId === this.activeChatGptDeviceCodeLogin?.loginId
      && current.authUrl === this.activeChatGptDeviceCodeLogin.verificationUrl
    ) {
      return this.activeChatGptDeviceCodeLogin;
    }
    if (this.chatGptDeviceCodeLoginPromise) return this.chatGptDeviceCodeLoginPromise;
    const start = (async () => {
      this.activeChatGptDeviceCodeLogin = null;
      this.host.patchAuthentication({
        login: { status: 'starting', loginId: null, authUrl: null, error: null },
      }, 'action');
      try {
        const response = await this.client.request('account/login/start', { type: 'chatgptDeviceCode' });
        if (response.type !== 'chatgptDeviceCode') {
          throw new Error(`Codex account/login/start returned unexpected login type '${response.type}'`);
        }
        const loginId = normalizedLoginId(response.loginId);
        const verificationUrl = safeLoginUrl(response.verificationUrl);
        const userCode = response.userCode.trim();
        if (!userCode) throw new Error('Codex account/login/start returned an empty device user code');
        this.host.patchAuthentication({
          login: { status: 'pending', loginId, authUrl: verificationUrl, error: null },
        }, 'action');
        const login = { loginId, verificationUrl, userCode };
        this.activeChatGptDeviceCodeLogin = login;
        return login;
      } catch (error) {
        this.host.patchAuthentication({
          login: { status: 'error', loginId: null, authUrl: null, error: errorMessage(error) },
        }, 'action');
        throw error;
      }
    })();
    this.chatGptDeviceCodeLoginPromise = start;
    void start.finally(() => {
      this.chatGptDeviceCodeLoginPromise = null;
    }).catch(() => undefined);
    return start;
  }

  async cancelLogin(loginId: string): Promise<CodexSnapshot> {
    const normalized = normalizedLoginId(loginId);
    const response = await this.client.request('account/login/cancel', { loginId: normalized });
    this.host.patchAuthentication({
      login: {
        status: response.status === 'canceled' ? 'cancelled' : 'idle',
        loginId: null,
        authUrl: null,
        error: null,
      },
    }, 'action');
    this.activeChatGptDeviceCodeLogin = null;
    return this.host.getSnapshot();
  }

  async logout(): Promise<CodexSnapshot> {
    await this.client.request('account/logout', undefined);
    this.host.patchAuthentication({
      login: { status: 'idle', loginId: null, authUrl: null, error: null },
    }, 'action');
    this.activeChatGptDeviceCodeLogin = null;
    const authenticationChanged = await this.load('action');
    if (authenticationChanged || this.blocksBootstrap()) {
      await this.host.clearAuthenticatedHostData();
    }
    if (!this.blocksBootstrap()) await this.host.bootstrapHostData(true);
    return this.host.getSnapshot();
  }

  refresh(
    origin: EventOrigin,
    forceBootstrap = false,
  ): Promise<CodexSnapshot> {
    this.accountRefreshRequested = true;
    this.accountRefreshForceBootstrap ||= forceBootstrap;
    this.accountRefreshOrigin = origin;
    if (this.accountRefreshPromise) return this.accountRefreshPromise;
    const refresh = (async () => {
      while (this.accountRefreshRequested) {
        const refreshOrigin = this.accountRefreshOrigin;
        const refreshForceBootstrap = this.accountRefreshForceBootstrap;
        this.accountRefreshRequested = false;
        this.accountRefreshForceBootstrap = false;
        try {
          const authenticationChanged = await this.load(refreshOrigin);
          if (authenticationChanged || this.blocksBootstrap()) {
            await this.host.clearAuthenticatedHostData();
          }
          if (!this.blocksBootstrap()) {
            await this.host.bootstrapHostData(refreshForceBootstrap);
          }
        } catch (error) {
          if (!this.accountRefreshRequested) throw error;
          this.accountRefreshForceBootstrap ||= refreshForceBootstrap;
        }
      }
      return this.host.getSnapshot();
    })();
    this.accountRefreshPromise = refresh;
    void refresh.finally(() => {
      this.accountRefreshPromise = null;
    }).catch(() => undefined);
    return refresh;
  }

  async load(origin: EventOrigin): Promise<boolean> {
    const previousAuthenticationIdentityKey = this.lastLoadedAuthenticationIdentityKey;
    this.host.patchAuthentication({ status: 'loading', error: null }, origin);
    try {
      const response = await this.client.request('account/read', { refreshToken: false });
      const account = response.account ? hostAccount(response.account) : null;
      const authentication = {
        ...this.host.getSnapshot().authentication,
        account,
        requiresOpenaiAuth: response.requiresOpenaiAuth,
      };
      const authenticationIdentityKey = hostAuthenticationIdentityKey(authentication);
      this.host.patchAuthentication({
        status: 'loaded', account, requiresOpenaiAuth: response.requiresOpenaiAuth, error: null,
      }, origin);
      this.lastLoadedAuthenticationIdentityKey = authenticationIdentityKey;
      return previousAuthenticationIdentityKey !== null
        && previousAuthenticationIdentityKey !== authenticationIdentityKey;
    } catch (error) {
      this.host.patchAuthentication({ status: 'error', error: errorMessage(error) }, origin);
      throw error;
    }
  }

  blocksBootstrap(): boolean {
    const authentication = this.host.getSnapshot().authentication;
    return authentication.status === 'loaded'
      && authentication.account === null
      && authentication.requiresOpenaiAuth === true;
  }

  handleLoginCompleted(params: v2.AccountLoginCompletedNotification): void {
    const current = this.host.getSnapshot().authentication.login;
    const loginId = params.loginId ?? current.loginId;
    if (!params.success) {
      this.activeChatGptDeviceCodeLogin = null;
      this.host.patchAuthentication({
        login: {
          status: 'error', loginId, authUrl: current.authUrl,
          error: params.error ?? 'Codex sign-in failed',
        },
      }, 'notification');
      return;
    }
    this.activeChatGptDeviceCodeLogin = null;
    this.host.patchAuthentication({
      login: { status: 'completed', loginId, authUrl: current.authUrl, error: null },
    }, 'notification');
    void this.refresh('notification').catch((error) => this.host.reportError(error));
  }
}
