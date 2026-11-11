import { RpcRemoteError } from '@korus-dev/codex-sdk';
import type { CodexAppServerClient, v2 } from '@korus-dev/codex-sdk';
import type { CodexChatGptDeviceCodeLogin, CodexChatGptLogin, EventOrigin } from '../../core/codex-host';
import type { CodexAuthenticationState, CodexSnapshot } from '../../core/codex-conversation-types';
import { CodexHostApprovalsController } from './host-approvals-controller';
import { hostAuthenticationKey } from './host-authentication';
import { CodexHostAuthenticationController } from './host-authentication-controller';
import { CodexHostCatalogController } from './host-catalog-controller';
import { CodexHostClientRequestsController } from './host-client-requests-controller';
import { CodexHostConversationsController } from './host-conversations-controller';
import type {
  CodexConfigRequirements,
  CodexHostOptions,
  CodexRemoteControlClientPage,
  CodexRemoteControlPairing,
  CodexRemoteControlPairingStatus,
  CodexRemoteControlStatus,
} from './host-contracts';
import { CodexHostItemsController } from './host-items-controller';
import { CodexHostLifecycleController } from './host-lifecycle-controller';
import { errorMessage } from './host-prompts';
import { CodexHostRuntimeController } from './host-runtime-controller';

export interface CodexHostConnectionDependencies {
  clearConversationHandles(): void;
  clearPendingForThread(
    threadId: string,
    reason: string,
    eventReason: 'host_disconnected',
  ): void;
  closed(): boolean;
  emitAuthenticationChanged(authentication: CodexAuthenticationState, origin: EventOrigin): void;
  emitHostStatus(origin: EventOrigin): void;
  getSnapshot(): CodexSnapshot;
  getState(): CodexSnapshot;
  patch(patch: Partial<CodexSnapshot>): void;
}

const SDK_RUNTIME_FEATURES = new Set([
  'compaction_image_budget',
  'default_mode_request_user_input',
]);

export class CodexHostConnectionController {
  private connectPromise: Promise<CodexSnapshot> | null = null;
  private hostBootstrapPromise: Promise<void> | null = null;
  private bootstrappedAuthenticationKey: string | null = null;

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly options: Pick<CodexHostOptions, 'autoSelectFirstConversation' | 'clientInfo' | 'requiredHumanApproval'>,
    private readonly authentication: CodexHostAuthenticationController,
    private readonly approvals: CodexHostApprovalsController,
    private readonly catalog: CodexHostCatalogController,
    private readonly clientRequests: CodexHostClientRequestsController,
    private readonly conversations: CodexHostConversationsController,
    private readonly items: CodexHostItemsController,
    private readonly lifecycle: CodexHostLifecycleController,
    private readonly runtimeState: CodexHostRuntimeController,
    private readonly host: CodexHostConnectionDependencies,
  ) {}

  connect(): Promise<CodexSnapshot> {
    if (this.host.getState().status === 'ready') return Promise.resolve(this.host.getSnapshot());
    if (this.connectPromise) return this.connectPromise;
    if (this.host.closed()) return Promise.reject(new Error('Codex host is closed'));

    this.host.patch({ status: 'connecting', error: null });
    this.host.emitHostStatus('lifecycle');
    this.connectPromise = (async () => {
      try {
        this.bootstrappedAuthenticationKey = null;
        this.catalog.reset(true);
        this.resetAppServerSessionState();
        await this.client.start();
        const clientInfo = this.options.clientInfo ?? {
          name: 'codex_app_sdk',
          title: 'Codex Host',
          version: '0.1.0',
        };
        await this.client.initialize({
          clientInfo: {
            name: clientInfo.name,
            title: clientInfo.title ?? null,
            version: clientInfo.version,
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            ...(this.options.requiredHumanApproval ? { requiredHumanApproval: true } : {}),
          },
        });
        await this.enableSupportedRuntimeFeatures();
        const authenticationChanged = await this.authentication.load('lifecycle');
        if (authenticationChanged || this.authentication.blocksBootstrap()) {
          await this.clearAuthenticatedHostData();
        }
        if (!this.authentication.blocksBootstrap()) await this.bootstrapHostData();
        this.host.patch({ status: 'ready', error: null });
        this.host.emitHostStatus('lifecycle');
        if (!this.authentication.blocksBootstrap()) this.catalog.schedulePluginRefresh();
        return this.host.getSnapshot();
      } catch (error) {
        this.host.patch({ status: 'error', error: errorMessage(error) });
        this.host.emitHostStatus('lifecycle');
        throw error;
      } finally {
        this.connectPromise = null;
      }
    })();
    return this.connectPromise;
  }

  private async enableSupportedRuntimeFeatures(): Promise<void> {
    try {
      let cursor: string | null = null;
      const enablement: Record<string, boolean> = {};
      do {
        const response: v2.ExperimentalFeatureListResponse = await this.client.request('experimentalFeature/list', {
          cursor,
          limit: 100,
          threadId: null,
        });
        for (const feature of response.data) {
          if (SDK_RUNTIME_FEATURES.has(feature.name) && !feature.enabled) {
            enablement[feature.name] = true;
          }
        }
        cursor = response.nextCursor;
      } while (cursor);
      if (Object.keys(enablement).length > 0) {
        await this.client.request('experimentalFeature/enablement/set', { enablement });
      }
    } catch (error) {
      // Older app-server releases do not expose feature discovery. They remain
      // usable, but cannot opt into SDK-supported runtime features.
      if (error instanceof RpcRemoteError && error.code === -32601) return;
      throw error;
    }
  }

  async ensureConnected(): Promise<void> {
    await this.connect();
    while (true) {
      const pending = this.authentication.pendingRefresh() ?? this.hostBootstrapPromise;
      if (!pending) return;
      await pending;
    }
  }

  bootstrapHostData(force = false): Promise<void> {
    const authenticationKey = hostAuthenticationKey(this.host.getState().authentication);
    if (!force && this.bootstrappedAuthenticationKey === authenticationKey) return Promise.resolve();
    if (this.hostBootstrapPromise) {
      const pending = this.hostBootstrapPromise;
      return pending.then(() => this.bootstrapHostData(force));
    }
    const bootstrap = (async () => {
      await Promise.all([
        this.catalog.loadModels(),
        this.catalog.loadPermissionProfiles(),
        this.catalog.loadRateLimits(),
        this.conversations.load(),
      ]);
      const state = this.host.getState();
      const activeConversation = state.activeConversationId
        ? state.conversations.find((conversation) => conversation.id === state.activeConversationId)
        : undefined;
      const conversationToResume = activeConversation
        ?? (this.options.autoSelectFirstConversation === false ? undefined : state.conversations[0]);
      if (conversationToResume && !this.runtimeState.get(conversationToResume.id)?.hydrated) {
        await this.lifecycle.resumeDuringBootstrap(conversationToResume.id);
      }
      this.bootstrappedAuthenticationKey = authenticationKey;
      this.catalog.schedulePluginRefresh(force);
    })();
    this.hostBootstrapPromise = bootstrap;
    void bootstrap.finally(() => {
      this.hostBootstrapPromise = null;
    }).catch(() => undefined);
    return bootstrap;
  }

  async refreshAccount(): Promise<CodexSnapshot> {
    await this.ensureConnected();
    return this.authentication.refresh('action', true);
  }

  async startChatGptLogin(): Promise<CodexChatGptLogin> {
    await this.ensureConnected();
    return this.authentication.startChatGptLogin();
  }

  async startChatGptDeviceCodeLogin(): Promise<CodexChatGptDeviceCodeLogin> {
    await this.ensureConnected();
    return this.authentication.startChatGptDeviceCodeLogin();
  }

  async cancelLogin(loginId: string): Promise<CodexSnapshot> {
    await this.ensureConnected();
    return this.authentication.cancelLogin(loginId);
  }

  async logout(): Promise<CodexSnapshot> {
    await this.ensureConnected();
    return this.authentication.logout();
  }

  async readRemoteControlStatus(): Promise<CodexRemoteControlStatus> {
    await this.ensureConnected();
    return this.client.request('remoteControl/status/read', undefined);
  }

  async enableRemoteControl(options: v2.RemoteControlEnableParams = {}): Promise<CodexRemoteControlStatus> {
    await this.ensureConnected();
    return this.client.request('remoteControl/enable', options);
  }

  async disableRemoteControl(options: v2.RemoteControlDisableParams = {}): Promise<CodexRemoteControlStatus> {
    await this.ensureConnected();
    return this.client.request('remoteControl/disable', options);
  }

  async startRemoteControlPairing(
    options: v2.RemoteControlPairingStartParams = {},
  ): Promise<CodexRemoteControlPairing> {
    await this.ensureConnected();
    return this.client.request('remoteControl/pairing/start', options);
  }

  async readRemoteControlPairingStatus(
    options: v2.RemoteControlPairingStatusParams = {},
  ): Promise<CodexRemoteControlPairingStatus> {
    await this.ensureConnected();
    return this.client.request('remoteControl/pairing/status', options);
  }

  async listRemoteControlClients(
    options: v2.RemoteControlClientsListParams,
  ): Promise<CodexRemoteControlClientPage> {
    await this.ensureConnected();
    return this.client.request('remoteControl/client/list', options);
  }

  async revokeRemoteControlClient(
    options: v2.RemoteControlClientsRevokeParams,
  ): Promise<v2.RemoteControlClientsRevokeResponse> {
    await this.ensureConnected();
    return this.client.request('remoteControl/client/revoke', options);
  }

  async readConfigRequirements(): Promise<CodexConfigRequirements | null> {
    await this.ensureConnected();
    return (await this.client.request('configRequirements/read', undefined)).requirements;
  }

  patchAuthentication(
    patch: Partial<CodexAuthenticationState>,
    origin: EventOrigin,
  ): void {
    const authentication = { ...this.host.getState().authentication, ...patch };
    this.host.patch({ authentication });
    this.host.emitAuthenticationChanged(authentication, origin);
  }

  handleDisconnect(error: Error): void {
    if (this.host.closed()) return;
    this.catalog.reset(false);
    for (const runtime of this.runtimeState.values()) {
      this.host.clearPendingForThread(runtime.threadId, error.message, 'host_disconnected');
      runtime.activeTurnId = null;
      runtime.busy = false;
      runtime.turnStartPending = false;
      runtime.historyLoading = false;
      runtime.error = error.message;
    }
    this.approvals.denyAll();
    this.clientRequests.clear();
    this.host.patch({
      status: 'error',
      activeTurnId: null,
      busy: false,
      approvals: [],
      clientRequests: [],
      historyLoading: false,
      error: error.message,
    });
    this.host.emitHostStatus('lifecycle');
  }

  private resetAppServerSessionState(): void {
    this.runtimeState.clear();
    this.lifecycle.resetHydrations();
    this.conversations.reset();
    this.items.reset();
  }

  async clearAuthenticatedHostData(): Promise<void> {
    const pendingBootstrap = this.hostBootstrapPromise;
    if (pendingBootstrap) await pendingBootstrap.catch(() => undefined);
    this.approvals.denyAll();
    this.clientRequests.rejectAll('Codex account signed out');
    this.runtimeState.clear();
    this.lifecycle.clear();
    this.conversations.reset();
    this.host.clearConversationHandles();
    this.items.reset();
    this.bootstrappedAuthenticationKey = null;
    this.catalog.reset(true);
    this.host.patch({
      conversations: [],
      activeConversationId: null,
      activeTurnId: null,
      turns: [],
      messages: [],
      clientRequests: [],
      answeredClientRequestIds: [],
      approvals: [],
      models: [],
      modelCatalogStatus: 'notLoaded',
      skills: [],
      skillCatalogStatus: 'notLoaded',
      plugins: [],
      pluginCatalogStatus: 'notLoaded',
      permissionProfiles: [],
      approvalPresets: [],
      approvalPreset: null,
      selectedModelId: null,
      selectedReasoningEffort: null,
      selectedServiceTier: null,
      planMode: false,
      contextUsage: null,
      goal: null,
      turnGitDiff: null,
      threadStatus: null,
      rateLimits: null,
      queuedPrompts: [],
      busy: false,
      historyLoading: false,
      error: null,
    });
  }
}
