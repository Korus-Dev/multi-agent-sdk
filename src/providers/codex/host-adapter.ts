import { validateMcpPolicy } from '../../mcp-policy';
import type { ProviderConversationRef, ConversationStorageState } from '../../contracts';
import type { StartCodexRealtimeOptions } from '../../core/codex-conversation-types';
import type { CodexRealtimeSession } from './host-contracts';
import { notifyListeners } from '@korus-dev/codex-sdk';
import type { HarnessDiagnostic } from '../../diagnostics';
import { CodexImageGeneration } from './image-generation';
import { promptContentDispatchText } from '../../core/prompt-content';
import type { HarnessPromptScope } from '../../driver';
export type CodexHostAdapterOptions<Context extends Agent = Agent> = {
  /** Structured measurements; no application environment flags or log formatting. */
  onDiagnostic?: (record: HarnessDiagnostic) => void;
  onListenerError?: (error: unknown) => void;
  /** Existing conversations keep provider settings; defaults still apply to creation. */
  inheritNativeSettings?: boolean;
  defaultModel?: { model: string; reasoningEffort?: string };
  extensionContext?: (context: Context, scope?: HarnessPromptScope) => unknown;
  conversationConfiguration?: (context: Context, scope?: HarnessPromptScope) => import('./host-contracts').CodexConversationLoadOptions;
  shouldSyncTitle?: (context: Context) => boolean;
  displayName?: (context: Context) => string;
  retainedSessions?: (context: Context) => readonly ProviderSessionData[];
  approvalPresetFromDefaults?: (defaults: import('../../contracts').ProviderDefaults | undefined) => ApprovalPreset;
  formatPrompt?: typeof defaultFormatPrompt;
  images?: import('./image-generation').CodexImageGenerationOptions;
};
function defaultFormatPrompt(prompt: string, content?: SendPromptOptions['content'], _native?: boolean): string { return content === undefined ? prompt : promptContentDispatchText(content, prompt); }
function scopedMcpServers(scope: HarnessPromptScope) { return (scope.mcpServers ?? []).map(server => ({ name: server.name, transport: { type: 'http' as const, url: server.url }, ...(server.enabledTools ? { enabledTools: [...server.enabledTools] } : {}), ...(server.approval === 'auto' ? { toolApprovalMode: 'auto' as const } : {}), ...(server.required === undefined ? {} : { required: server.required }) })); }
function nativeApprovalPreset(defaults: import('../../contracts').ProviderDefaults | undefined): ApprovalPreset | undefined {
  if (defaults?.kind !== 'codex') return undefined;
  // Missing caller policy inherits the native thread; it is not an approval override.
  if (defaults.approvalPreset === undefined && defaults.approvalPolicy === undefined && defaults.sandboxMode === undefined && defaults.approvalsReviewer === undefined) return undefined;
  if (defaults.approvalPreset) return defaults.approvalPreset;
  if (defaults.approvalPolicy === 'never' && defaults.sandboxMode === 'danger-full-access') return 'full-access';
  return defaults.approvalPolicy === 'on-request' && ['auto_review','guardian_subagent'].includes(defaults.approvalsReviewer ?? '') ? 'approve-for-me' : 'ask-for-approval';
}
import { providerSafetyBlockMessage, type ProviderSafetyReviewTarget } from '../../contracts/safety-review';

import { ConversationContentTransport } from './conversation-content-transport';


import { normalizePromptContent } from '../../core/prompt-content';
import type { ExecutionObservation } from '../../contracts/usage';
import { codexExecutionConsumption } from './execution-usage';
import { codexRequestCoverage } from './request-usage';
import { bankedResetsFromHost } from './banked-resets';
import { randomUUID } from 'node:crypto';
import { isBankedResetResult, isUseBankedResetInput, type BankedResetResult, type UseBankedResetInput } from '../../contracts/banked-resets';

import os from 'node:os';
import { approvalAgentRequest, approvalOutcome, requestFromClientRequest, agentResponseFromClientResponse, type AgentRequest } from '../../conversations/agent-request';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Agent,
  AgentStatus,
  ApprovalPreset,
  ProviderModelOption,
  ProviderPluginSummary,
  ProviderRuntimeStatus,
  ProviderSessionData,
  ProviderSkillSummary,
  ClientRequestResponse,
  ConversationListInput,
  ConversationResumeTarget,
  ConversationSummary,
  DevicePairingSession,
  DevicePairingStatus,
  Message,
  MessagePart,
  ToolPart,
  PairedDevice,
  SendPromptOptions,
  CodexAuthentication, SubagentActivityChange,
  SubagentIdentityChange,
  SubagentOperationChange,
  SubagentStatusChange
} from '../../contracts/index';
import type { ProviderScopedPromptInput, ProviderScopedPromptResult, ProviderEvent } from '../../driver';
import type { HarnessTextGenerationInput, HarnessTextGenerationResult } from '../../generation';
import { codexHarnessCapabilities } from '../../capabilities';




import type { CodexConversation, CodexHost } from './index';


import { safetyReviewFromSnapshot, statusFromSnapshot } from './status';
import type { CodexReviewTarget, Skill, TurnStatus, SendMessageOptions, UpdateConversationSettings, ConversationMessage, ConversationMessagePart, ConversationMessageToolPart } from '../../core/codex-host';
import type { CodexConversationEvent, CodexConversationSummary, CodexConversationSnapshot, CodexEvent, CodexRateLimits, CodexSnapshot, CodexThreadStatus } from '../../core/codex-conversation-types';
import {
  invokeCodexConversationBridgeOperation,
  subscribeCodexConversationReplicaBridge,
} from '../../core/codex-host-bridge';

type AdapterListener = (event: ProviderEvent) => void;
type ThreadProviderEvent<Event extends ProviderEvent = ProviderEvent> = Event extends ProviderEvent
  ? Omit<Event, 'agentId' | 'provider' | 'threadId' | 'conversationId'>
  : never;

const AGENT_HISTORY_CACHE_TTL_MS = 15 * 60 * 1_000;

function selectedCodexModel(snapshot: CodexConversationSnapshot): string | null {
  const selected = snapshot.models.find(
    (model) =>
      model.id === snapshot.selectedModelId ||
      model.model === snapshot.selectedModelId,
  ) ?? snapshot.models.find((model) => model.isDefault) ?? snapshot.models[0];
  return selected?.model ?? snapshot.selectedModelId;
}


type AgentConversation<Context extends Agent = Agent> = {
  agent: Context;
  handle: CodexConversation;
  images: ConversationContentTransport;
  suppressEvents: boolean;
  unsubscribe: () => void;
};

type SubagentOwner = {
  agentId: string;
  rootConversationId: string;
};

export class CodexHostAdapter<Context extends Agent = Agent> {
  private readonly imageGeneration: CodexImageGeneration;
  private readonly listeners = new Set<AdapterListener>();
  private readonly usageListeners = new Set<(observation:ExecutionObservation)=>void>();
  private readonly sessionsByAgentId = new Map<string, AgentConversation<Context>>();
  private readonly submissions = new Map<string, Promise<void>>();
  private readonly sessionInitializations = new Map<string, Promise<AgentConversation<Context>>>();
  private readonly historyHydratedAtByAgentId = new Map<string, number>();
  private readonly agentIdsByThreadId = new Map<string, string>();
  private readonly approvalOwners = new Map<string, AgentConversation<Context>>();
  private readonly clientRequestOwners = new Map<string, AgentConversation<Context>>();
  private readonly subagentOwners = new Map<string, SubagentOwner>();
  private readonly conversationSummaries = new Map<string, CodexConversationSummary>();
  private readonly lastSubagentIdentityByConversationId = new Map<string, string>();
  private readonly subagentIdentityLoads = new Map<string, Promise<void>>();
  private readonly liveSubagentConversationIds = new Set<string>();
  private readonly conversationRevisionsByAgentId = new Map<string, number>();
  private readonly unsubscribeHost: () => void;
  private closed = false;
  private accountRevision = 0;
  private accountIdentity = '';
  private readonly resetReadCancellations = new Set<() => void>();
  private resetCreditTokens = new Map<string, { token: string; idempotencyKey?: string; uncertain?: boolean }>();

  constructor(
    private readonly host: CodexHost,
    private readonly closeHost: () => Promise<void> = () => host.close(),
    private readonly options: CodexHostAdapterOptions<Context> = {},
  ) {
    this.imageGeneration = new CodexImageGeneration(host, options.images);
    this.accountIdentity = JSON.stringify(host.getSnapshot().authentication.account);
    this.unsubscribeHost = host.onEvent((event) => this.handleHostEvent(event));
  }

  private extensionContext(context: Context, scope?: import('../../driver').HarnessPromptScope): unknown { return this.options.extensionContext?.(context, scope) ?? context; }
  private conversationConfiguration(context: Context, scope?: HarnessPromptScope) { return this.options.conversationConfiguration?.(context, scope) ?? { ...agentCwd(context), extensionContext: this.extensionContext(context, scope), mcpServers: scope ? scopedMcpServers(scope) : undefined }; }
  private syncTitle(context: Context): boolean { return this.options.shouldSyncTitle?.(context) ?? Boolean(context.name?.trim()); }
  private displayName(context: Context): string { return this.options.displayName?.(context) ?? context.name?.trim() ?? context.id; }
  private approvalPreset(defaults: import('../../contracts').ProviderDefaults | undefined): ApprovalPreset | undefined { return this.options.approvalPresetFromDefaults?.(defaults) ?? nativeApprovalPreset(defaults); }
  async start(): Promise<void> {
    await this.host.connect();
  }

  /** The signed-in account's current rate limits, or null when the runtime cannot report them. */
  async getAccountRateLimits(): Promise<import('../../contracts').AccountRateLimits | null> {
    const host = this.host as CodexHost & { readRateLimits?: (options: { excludeResetCreditDetails: boolean }) => Promise<CodexRateLimits> };
    if (!host.readRateLimits) return null;
    return (await host.readRateLimits({ excludeResetCreditDetails: true })).rateLimits as unknown as import('../../contracts').AccountRateLimits;
  }

  async getBankedResets(): Promise<import('../../contracts/banked-resets').BankedResets> {
    // Feature-detect the narrow public seam for older published SDKs.
    const host = this.host as CodexHost & {
      readRateLimits?: (options: { excludeResetCreditDetails: boolean }) => Promise<CodexRateLimits>;
      consumeRateLimitResetCredit?: (options: { idempotencyKey: string; creditId?: string }) => Promise<BankedResetResult>;
    };
    if (!host.readRateLimits) return { status: 'unsupported' };
    const account = host.getSnapshot().authentication.account;
    if (account?.type !== 'chatgpt') return { status: account ? 'unsupported' : 'signedOut' };
    const identity = JSON.stringify(account);
    if (identity !== this.accountIdentity) { this.accountIdentity = identity; ++this.accountRevision; this.resetCreditTokens.clear(); }
    const expected = this.accountRevision;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      const limits = await Promise.race([
        host.readRateLimits({ excludeResetCreditDetails: false }),
        new Promise<never>((_resolve, reject) => {
          cancel = () => reject(new Error('Banked reset account changed'));
          this.resetReadCancellations.add(cancel);
          timer = setTimeout(() => reject(new Error('Banked reset read timed out')), 15_000);
        }),
      ]);
      if (this.closed || expected !== this.accountRevision || JSON.stringify(host.getSnapshot().authentication.account) !== JSON.stringify(account)) {
        throw new Error('Banked reset account changed');
      }
      const nextTokens = new Map<string, { token: string; idempotencyKey?: string; uncertain?: boolean }>();
      const result = bankedResetsFromHost(limits, typeof host.consumeRateLimitResetCredit === 'function' ? id => {
        const entry = this.resetCreditTokens.get(id) ?? { token: randomUUID() };
        nextTokens.set(id, entry);
        return entry.token;
      } : undefined);
      for (const [id, entry] of this.resetCreditTokens) {
        if (entry.uncertain && !nextTokens.has(id)) nextTokens.set(id, entry);
      }
      this.resetCreditTokens = nextTokens;
      return result;
    } finally { clearTimeout(timer); if (cancel) this.resetReadCancellations.delete(cancel); }
  }

  async useBankedReset(input: UseBankedResetInput): Promise<BankedResetResult> {
    if (!isUseBankedResetInput(input)) throw new Error('Reset confirmation is required');
    const host = this.host as CodexHost & {
      consumeRateLimitResetCredit?: (options: { idempotencyKey: string; creditId?: string }) => Promise<BankedResetResult>;
    };
    if (!host.consumeRateLimitResetCredit) throw new Error('Reset redemption is unsupported');
    const account = host.getSnapshot().authentication.account;
    if (this.closed || account?.type !== 'chatgpt' || JSON.stringify(account) !== this.accountIdentity) {
      this.resetCreditTokens.clear();
      throw new Error('Banked reset account changed');
    }
    const selected = [...this.resetCreditTokens].find(([, entry]) => entry.token === input.redemptionToken);
    if (!selected) throw new Error('Banked reset selection expired. Refresh and try again.');
    const [creditId, entry] = selected;
    // Retain the logical attempt after an uncertain response, including UI reloads.
    entry.idempotencyKey ??= input.idempotencyKey;
    entry.uncertain = true;
    const expected = this.accountRevision;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      const result = await Promise.race([
        host.consumeRateLimitResetCredit({ creditId, idempotencyKey: entry.idempotencyKey }),
        new Promise<never>((_resolve, reject) => {
          cancel = () => reject(new Error('Banked reset account changed'));
          this.resetReadCancellations.add(cancel);
          timer = setTimeout(() => reject(new Error('Banked reset outcome is uncertain')), 15_000);
        }),
      ]);
      if (this.closed || expected !== this.accountRevision || JSON.stringify(host.getSnapshot().authentication.account) !== JSON.stringify(account)) {
        throw new Error('Banked reset account changed');
      }
      if (!isBankedResetResult(result)) throw new Error('Invalid banked reset outcome');
      entry.uncertain = false;
      if (result.outcome === 'nothingToReset' || result.outcome === 'noCredit') delete entry.idempotencyKey;
      return result;
    } finally { clearTimeout(timer); if (cancel) this.resetReadCancellations.delete(cancel); }
  }

  async getAuthentication(): Promise<CodexAuthentication> {
    return authenticationFromHost((await this.host.refreshAccount()).authentication);
  }

  async startChatGptLogin() {
    return this.host.startChatGptLogin();
  }

  async startChatGptDeviceCodeLogin() {
    return this.host.startChatGptDeviceCodeLogin();
  }

  async cancelChatGptLogin(loginId?: string): Promise<CodexAuthentication> {
    return authenticationFromHost((await this.host.cancelLogin(loginId)).authentication);
  }

  async logout(): Promise<CodexAuthentication> {
    return authenticationFromHost((await this.host.logout()).authentication);
  }

  async setConversationStorage(ref: ProviderConversationRef, state: ConversationStorageState): Promise<void> {
    if (ref.provider !== 'codex') throw new Error('Not a Codex conversation reference.');
    await this.host.connect();
    await (state === 'archived' ? this.host.archiveConversation(ref.threadId) : this.host.unarchiveConversation(ref.threadId));
  }

  async startRealtime(agent: Context, options: StartCodexRealtimeOptions): Promise<CodexRealtimeSession> {
    const session = await this.ensureSession(agent);
    return session.handle.startRealtime(options);
  }

  async getRemoteControlStatus(): Promise<DevicePairingStatus> {
    const status = await this.host.readRemoteControlStatus();
    const requirements = await this.host.readConfigRequirements();
    return {
      ...status,
      allowRemoteControl: requirements?.allowRemoteControl ?? null,
    };
  }

  async enableRemoteControl(): Promise<DevicePairingStatus> {
    const status = await this.host.enableRemoteControl();
    const requirements = await this.host.readConfigRequirements();
    return {
      ...status,
      allowRemoteControl: requirements?.allowRemoteControl ?? null,
    };
  }

  async disableRemoteControl(): Promise<DevicePairingStatus> {
    const status = await this.host.disableRemoteControl();
    const requirements = await this.host.readConfigRequirements();
    return {
      ...status,
      allowRemoteControl: requirements?.allowRemoteControl ?? null,
    };
  }

  async startDevicePairing(): Promise<DevicePairingSession> {
    const pairing = await this.host.startRemoteControlPairing({ manualCode: true });
    return {
      pairingCode: pairing.pairingCode,
      manualPairingCode: pairing.manualPairingCode,
      environmentId: pairing.environmentId,
      expiresAt: epochTimestampToIso(pairing.expiresAt),
    };
  }

  async checkDevicePairing(session: DevicePairingSession): Promise<boolean> {
    const result = await this.host.readRemoteControlPairingStatus(
      session.pairingCode
        ? { pairingCode: session.pairingCode }
        : { manualPairingCode: session.manualPairingCode ?? null },
    );
    return result.claimed;
  }

  async listPairedDevices(environmentId: string): Promise<PairedDevice[]> {
    const clients = await this.host.listRemoteControlClients({ environmentId, limit: 100 });
    return clients.data.map((client) => ({
      clientId: client.clientId,
      displayName: client.displayName,
      deviceType: client.deviceType,
      platform: client.platform,
      osVersion: client.osVersion,
      deviceModel: client.deviceModel,
      appVersion: client.appVersion,
      lastSeenAt: client.lastSeenAt === null ? null : epochTimestampToIso(client.lastSeenAt),
    }));
  }

  async revokePairedDevice(environmentId: string, clientId: string): Promise<void> {
    await this.host.revokeRemoteControlClient({ environmentId, clientId });
  }

  getRuntimeStatus(): ProviderRuntimeStatus {
    return runtimeStatus(this.host.getSnapshot());
  }

  getCapabilities(agent?: Context) {
    const session = agent ? this.sessionsByAgentId.get(agent.id) : undefined;
    const presets = session?.handle.getSnapshot().approvalPresets
      ?? this.host.getSnapshot().approvalPresets;
    return {
      ...codexHarnessCapabilities,
      approvalPresets: presets.length > 0 ? [...presets] : codexHarnessCapabilities.approvalPresets,
    };
  }

  async listModels(): Promise<ProviderModelOption[]> {
    const models = await this.host.listModels({ includeHidden: false, forceReload: true });
    const preferred = models.find(model => model.model === this.options.defaultModel?.model);
    return models.map((model) => ({
      ...model,
      ...(preferred ? { isDefault: model === preferred } : {}),
      ...(model === preferred && model.supportedReasoningEfforts?.some(effort => effort.reasoningEffort === this.options.defaultModel?.reasoningEffort)
        ? { defaultReasoningEffort: this.options.defaultModel?.reasoningEffort } : {}),
      supportedReasoningEfforts: model.supportedReasoningEfforts?.map((effort) => ({ ...effort })),
      serviceTiers: model.serviceTiers?.map((tier) => ({ ...tier })),
    }));
  }

  async listSkills(agent: Context, forceReload = false): Promise<ProviderSkillSummary[]> {
    const skills = await this.host.listSkills({ ...agentCwd(agent), forceReload });
    return skills.map(providerSkillSummary);
  }

  async listPlugins(): Promise<ProviderPluginSummary[]> {
    await this.start();
    const snapshot = this.host.getSnapshot();
    if (snapshot.pluginCatalogStatus === 'loaded' || snapshot.pluginCatalogStatus === 'error') {
      return snapshot.plugins.map((plugin) => ({ ...plugin }));
    }

    return new Promise((resolve) => {
      const unsubscribe = this.host.onEvent((event) => {
        if (event.type !== 'catalog.pluginsChanged' || event.payload.status === 'loading') return;
        unsubscribe();
        resolve(event.payload.plugins.map((plugin) => ({ ...plugin })));
      });
      const current = this.host.getSnapshot();
      if (current.pluginCatalogStatus === 'loaded' || current.pluginCatalogStatus === 'error') {
        unsubscribe();
        resolve(current.plugins.map((plugin) => ({ ...plugin })));
      }
    });
  }

  async generateText(_agent: Context, input: HarnessTextGenerationInput): Promise<HarnessTextGenerationResult> {
    input.signal?.throwIfAborted();
    const servers = input.mcpServers ?? [];
    validateMcpPolicy(servers, 'codex', codexHarnessCapabilities);
    const selection = input.selectModel ? input.selectModel(await this.listModels()) : input.selection ?? {};
    input.signal?.throwIfAborted();
    return this.host.generateText(input.prompt, {
      ...(input.timeoutMs === null ? { timeoutMs: null } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      cwd: expandHome(input.cwd),
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      serviceTier: null,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(servers.length ? {mcpServers: servers.map(server => ({name: server.name, transport: {type: 'http' as const, url: server.url}, enabledTools: [...server.enabledTools], ...(server.approval === 'auto' ? { toolApprovalMode: 'auto' as const } : {}), ...(server.required === undefined ? {} : { required: server.required })}))} : {}),
      ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    });
  }

  generateImage(input: import('../../generation').HarnessImageGenerationInput, signal?: AbortSignal) {
    return this.imageGeneration.generate(input, signal);
  }

  async cancelScopedPrompt(agent: Context): Promise<void> {
    const session = this.sessionsByAgentId.get(agent.id);
    try {
      if (session?.handle.getSnapshot().activeTurnId) await session.handle.interrupt();
    } finally { this.releaseConversation(agent.id); }
  }

  async executeScopedPrompt(agent: Context, input: ProviderScopedPromptInput): Promise<ProviderScopedPromptResult> {
    input.signal?.throwIfAborted();
    validateMcpPolicy(input.scope.mcpServers ?? [], 'codex', codexHarnessCapabilities);
    await this.start();
    input.signal?.throwIfAborted();
    if (input.session && input.session.kind !== 'codex') {
      throw new Error('Codex cannot continue a non-Codex scoped conversation.');
    }
    const requestedAgent = { ...agent, folder: input.cwd, providerSession: input.session };
    const scopedExtensionContext = this.extensionContext(requestedAgent, input.scope);
    const session = await this.ensureSession(requestedAgent, scopedExtensionContext);
    input.signal?.throwIfAborted();
    const current = session.handle.getSnapshot();
    if (current.busy || current.activeTurnId || current.queuedPrompts.length || current.approvals.length || current.clientRequests.length) throw new Error('Codex already has active work for this context.');
    session.agent = agent;
    const conversationId = session.handle.id;
    const conversation = session.handle;
    let targetTurnId: string | null = null;
    const completedBeforeTarget = new Map<string, TurnStatus>();
    let resolveCompletion: ((status: TurnStatus) => void) | null = null;
    const completion = new Promise<TurnStatus>((resolve) => { resolveCompletion = resolve; });
    const unsubscribe = conversation.onEvent((event) => {
      if (event.type !== 'turn.completed') return;
      if (event.turnId === targetTurnId) resolveCompletion?.(event.payload.status);
      else completedBeforeTarget.set(event.turnId, event.payload.status);
    });
    try {
      await conversation.load(this.conversationConfiguration(requestedAgent, input.scope));
      input.signal?.throwIfAborted();
      const beforeTurnIds = conversation.getSnapshot().turnIds;
      const promptOptions = { ...scopedPromptOptions(agent), ...hostPromptOptions(input.options) };
      const started = Object.keys(promptOptions).length > 0
        ? await conversation.sendMessage(input.prompt, promptOptions)
        : await conversation.sendMessage(input.prompt);
      input.signal?.throwIfAborted();
      targetTurnId = resultTurnId(started, beforeTurnIds) ?? null;
      if (!targetTurnId) throw new Error('Codex did not start the scoped turn.');
      const immediate = completedBeforeTarget.get(targetTurnId)
        ?? started.turns.find((turn) => turn.id === targetTurnId && turn.status !== 'inProgress')?.status;
      const status = immediate ?? await completion;
      input.signal?.throwIfAborted();
      const snapshot = conversation.getSnapshot();
      const completedFinalAnswer = sessionFinalAnswerText(snapshot.messages, targetTurnId);
      if (status !== 'completed' && !(status === 'interrupted' && completedFinalAnswer)) {
        throw new Error(`Scoped execution was ${status}.`);
      }
      return {
        text: assistantTurnText(snapshot.messages, targetTurnId),
        session: { kind: 'codex', threadId: conversationId },
      };
    } finally {
      unsubscribe();
      if (!input.signal?.aborted) await conversation.load(this.conversationConfiguration(agent));
    }
  }

  async disposeScopedSession(scopedSession: ProviderSessionData): Promise<void> {
    if (scopedSession.kind !== 'codex') throw new Error('Codex cannot dispose a non-Codex scoped conversation.');
    await this.host.archiveConversation(scopedSession.threadId);
    this.host.forgetConversation(scopedSession.threadId);
  }

  async sendPrompt(agent: Context, prompt: string, options: SendPromptOptions = {}) {
    const session = await this.ensureSession(agent);
    return this.serializeSubmission(session, async () => {
      // The caller's mode selection persists through follow-ups and hydration. The
      // SDK send option alone is a per-turn override and does not publish it.
      if (typeof options.planMode === 'boolean' && options.planMode !== session.handle.getSnapshot().planMode) {
        await session.handle.updateSettings({ planMode: options.planMode });
      }
      const beforeTurnIds = session.handle.getSnapshot().turnIds;
      const snapshot = await session.handle.sendMessage((this.options.formatPrompt ?? defaultFormatPrompt)(prompt, options.content, true), hostPromptOptions(options));
      const turnId = resultTurnId(snapshot, beforeTurnIds);
      const messages = snapshot.messages.filter(message => message.role === 'user' && message.turnId === turnId && message.kind !== 'steer');
      return { threadId: session.handle.id, turnId, ...(messages.length === 1 ? { messageId: messages[0]!.id } : {}) };
    });
  }



  async setConversationTitle(agent: Context, title: string): Promise<void> {
    const session = await this.ensureSession(agent);
    await this.renameSessionIfNeeded(session, title);
  }

  async setThreadGoal(agent: Context, objective: string) {
    const session = await this.ensureSession(agent);
    const snapshot = await invokeCodexConversationBridgeOperation(
      this.host, session.handle.id, 'setGoal', [objective],
    );
    if (!snapshot.goal) throw new Error('Codex did not return the updated goal.');
    return { threadId: session.handle.id, goal: snapshot.goal };
  }

  async clearThreadGoal(agent: Context) {
    const session = await this.ensureSession(agent);
    await invokeCodexConversationBridgeOperation(
      this.host, session.handle.id, 'clearGoal', [],
    );
    return { threadId: session.handle.id, cleared: true };
  }

  async setApprovalPreset(agent: Context, preset: ApprovalPreset) {
    const session = await this.ensureSession(agent);
    const effective = effectiveApprovalPreset(preset, session.handle.getSnapshot().approvalPresets);
    if (!effective) throw new Error('No approval preset satisfies the Codex app-server requirements.');
    await invokeCodexConversationBridgeOperation(
      this.host, session.handle.id, 'updateConversationSettings', [{ approvalPreset: effective }],
    );
    return { threadId: session.handle.id, approvalPreset: effective };
  }

  async reviewThread(agent: Context, target: CodexReviewTarget) {
    const session = await this.ensureSession(agent);
    const beforeTurnIds = session.handle.getSnapshot().turnIds;
    const snapshot = await invokeCodexConversationBridgeOperation(
      this.host, session.handle.id, 'startReview', [{ target }],
    );
    return { threadId: session.handle.id, turnId: resultTurnId(snapshot, beforeTurnIds) };
  }

  async steerPrompt(agent: Context, prompt: string, options?: SendPromptOptions) {
    const session = await this.ensureSession(agent);
    return this.serializeSubmission(session, async () => {
      const before = session.handle.getSnapshot();
      const knownMessages = new Set(before.messages.map(message => message.id));
      const snapshot = await session.handle.steerMessage((this.options.formatPrompt ?? defaultFormatPrompt)(prompt, options?.content, true), hostPromptOptions(options));
      const turnId = resultTurnId(snapshot, before.turnIds);
      const messages = snapshot.messages.filter(message => message.role === 'user' && message.turnId === turnId && !knownMessages.has(message.id));
      return { threadId: session.handle.id, turnId, ...(messages.length === 1 ? { messageId: messages[0]!.id } : {}) };
    });
  }

  /** Keep owner and guest receipt capture isolated; the SDK owns message identity. */
  private async serializeSubmission<T>(session: AgentConversation<Context>, submit: () => Promise<T>): Promise<T> {
    const id = session.handle.id;
    const operation = (this.submissions.get(id) ?? Promise.resolve()).then(() => {
      if (this.closed || this.sessionsByAgentId.get(session.agent.id) !== session) throw new Error('Conversation is no longer active.');
      return submit();
    });
    const settled = operation.then(() => {}, () => {});
    this.submissions.set(id, settled);
    try { return await operation; }
    finally { if (this.submissions.get(id) === settled) this.submissions.delete(id); }
  }

  async interruptTurn(agent: Context, expectedTurnId?: string) {
    const session = await this.ensureSession(agent);
    const turnId = session.handle.getSnapshot().activeTurnId;
    if (!turnId) throw new Error('No active Codex turn to interrupt.');
    if (expectedTurnId && turnId !== expectedTurnId) throw new Error('The requested Codex task turn is no longer active.');
    await invokeCodexConversationBridgeOperation(
      this.host, session.handle.id, 'interrupt', [],
    );
    return { threadId: session.handle.id, turnId };
  }

  releaseConversation(agentId: string): void {
    this.sessionInitializations.delete(agentId);
    const session = this.sessionsByAgentId.get(agentId);
    if (!session) return;
    session.unsubscribe();
    this.sessionsByAgentId.delete(agentId);
    this.historyHydratedAtByAgentId.delete(agentId);
    if (this.agentIdsByThreadId.get(session.handle.id) === agentId) {
      this.agentIdsByThreadId.delete(session.handle.id);
    }
    for (const [conversationId, owner] of this.subagentOwners) {
      if (owner.agentId !== agentId) continue;
      this.subagentOwners.delete(conversationId);
      this.lastSubagentIdentityByConversationId.delete(conversationId);
      this.subagentIdentityLoads.delete(conversationId);
      this.liveSubagentConversationIds.delete(conversationId);
    }
    this.removePendingOwners(session);
    this.host.forgetConversation(session.handle.id);
  }

  async deleteTurn(agent: Context, turnId: string) {
    const session = await this.ensureSession(agent);
    const snapshot = await invokeCodexConversationBridgeOperation(
      this.host, session.handle.id, 'deleteTurn', [turnId],
    );
    return {
      threadId: session.handle.id,
      activeTurnId: snapshot.activeTurnId,
    };
  }

  async editTurn(agent: Context, turnId: string, content: string, options?: Pick<SendPromptOptions, 'content'>) {
    const session = await this.ensureSession(agent);
    const snapshot = await invokeCodexConversationBridgeOperation(
      this.host, session.handle.id, 'editTurn', options ? [turnId, (this.options.formatPrompt ?? defaultFormatPrompt)(content, options.content, true), hostPromptOptions(options)] : [turnId, content],
    );
    return {
      threadId: session.handle.id,
      activeTurnId: snapshot.activeTurnId,
    };
  }

  async retryTurn(agent: Context, turnId: string) {
    const session = await this.ensureSession(agent);
    const snapshot = await invokeCodexConversationBridgeOperation(
      this.host, session.handle.id, 'retryTurn', [turnId],
    );
    return {
      threadId: session.handle.id,
      activeTurnId: snapshot.activeTurnId,
    };
  }

  async continueInterruptedTurn(agent: Context, safetyReview?: ProviderSafetyReviewTarget) {
    const session = await this.ensureSession(agent);
    if (safetyReview) return this.serializeSubmission(session, async () => {
      const current = session.handle.getSnapshot();
      const review = safetyReviewFromSnapshot(current);
      if (current.busy || !review?.canContinue || review.id !== safetyReview.id
        || session.handle.id !== safetyReview.conversationId || review.turnId !== safetyReview.turnId) {
        throw new Error('Provider safety continuation is unavailable or these findings have changed. Review the latest provider error.');
      }
      if (!session.handle.continueAfterSafetyReview) throw new Error('This SDK does not support provider safety review continuation.');
      const after = await session.handle.continueAfterSafetyReview({ turnId: review.turnId, findings: current.turns.find(turn => turn.id === review.turnId)!.error!.misalignment! });
      if (this.sessionsByAgentId.get(agent.id) !== session || codexThreadId(agent) !== safetyReview.conversationId) throw new Error('Conversation changed during safety review.');
      this.emitStatus(session, statusFromSnapshot(after));
      if (after.error || after.turns.at(-1)?.status === 'failed') throw new Error(after.error ?? after.turns.at(-1)?.error?.message ?? 'Continuation failed. Review the latest provider error.');
      return { threadId: session.handle.id, activeTurnId: after.activeTurnId };
    });
    if (providerSafetyBlockMessage(session.handle.getSnapshot().turns.at(-1)?.error)
      || providerSafetyBlockMessage(session.handle.getSnapshot().error)) throw new Error('Review the provider safety findings before continuing.');
    const snapshot = await invokeCodexConversationBridgeOperation(
      this.host, session.handle.id, 'continueInterruptedTurn', [],
    );
    return {
      threadId: session.handle.id,
      activeTurnId: snapshot.activeTurnId,
    };
  }

  async readConversationMessages(threadId: string, agentId: string, options: { view?: 'full' | 'last' } = {}): Promise<Message[]> {
    await this.start();
    const owner = this.subagentOwners.get(threadId);
    if (owner?.agentId === agentId && this.liveSubagentConversationIds.has(threadId)) {
      return historicalConversationMessages(this.host.conversation(threadId).getSnapshot().messages, agentId);
    }
    const history = options.view === 'last' ? await this.host.conversation(threadId).readHistory() : undefined;
    const messages = historicalConversationMessages(history?.messages ?? await this.host.readConversationMessages(threadId), agentId);
    const session = this.sessionsByAgentId.get(agentId);
    if (history && session && session.handle.id !== threadId) {
      const status = subagentStatusFromHistory(history.threadStatus, messages);
      if (status) {
        this.subagentOwners.set(threadId, {
          agentId,
          rootConversationId: session.handle.id,
        });
        this.emitSubagentStatus(
          session,
          threadId,
          status,
          messages.at(-1)?.createdAt ?? new Date().toISOString(),
        );
      }
    }
    return options.view === 'last' && session && session.handle.id !== threadId ? messages.slice(-1) : messages;
  }

  async readConversationSummary(agent: Context, threadId: string): Promise<ConversationSummary> {
    const session = await this.ensureSession(agent);
    this.subagentOwners.set(threadId, {
      agentId: agent.id,
      rootConversationId: session.handle.id,
    });
    const summary = await this.host.readConversationSummary(threadId);
    this.conversationSummaries.set(summary.id, summary);
    this.emitSubagentIdentity(session, summary);
    return conversationSummary(summary);
  }

  async loadTurnHistory(agent: Context, turnId: string): Promise<void> {
    const session = await this.ensureSession(agent);
    await session.handle.loadTurnHistory(turnId);
  }

  async loadOlderHistory(agent: Context): Promise<{ hasOlder: boolean }> {
    const session = await this.ensureSession(agent);
    const loadOlderHistory = (session.handle as CodexConversation & {
      loadOlderHistory?: () => Promise<{ hasOlder: boolean }>;
    }).loadOlderHistory;
    if (!loadOlderHistory) throw new Error('The Codex SDK does not support demand-paged conversation history.');
    const page = await loadOlderHistory();
    return { hasOlder: page.hasOlder };
  }

  async listConversations(_agent: Context, input: ConversationListInput = {}): Promise<ConversationSummary[]> {
    await this.start();
    const limit = input.limit ?? 100;
    const options = {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      limit,
      ...(input.searchTerm?.trim() ? { searchTerm: input.searchTerm.trim() } : {}),
    };
    const storageState = input.archived === true ? 'archived' as const : 'active' as const;
    const entries = await this.host.listConversations({ ...options, ...(input.archived === undefined ? {} : { archived: input.archived }) });
    const conversations = entries.map(conversation => ({ conversation, storageState }))
      .sort((left, right) => right.conversation.updatedAt.localeCompare(left.conversation.updatedAt));
    for (const { conversation } of conversations) {
      this.conversationSummaries.set(conversation.id, conversation);
      const owner = this.subagentOwners.get(conversation.id);
      const session = owner ? this.sessionsByAgentId.get(owner.agentId) : undefined;
      if (session && session.handle.id === owner?.rootConversationId) {
        this.emitSubagentIdentity(session, conversation);
      }
    }
    return conversations.slice(0, limit).map(({ conversation, storageState }) => conversationSummary(conversation, storageState));
  }

  async resumeConversation(agent: Context, target: ConversationResumeTarget) {
    if (target.ref.provider !== 'codex') throw new Error('Codex cannot resume a non-Codex conversation.');
    const threadId = target.ref.threadId;
    const previousThreadId = codexThreadId(agent);
    const targetWasArchived = target.storageState === 'archived';
    if (targetWasArchived) await this.host.unarchiveConversation(threadId);
    try {
      await this.bindAndLoad(agent, threadId);
    } catch (error) {
      if (previousThreadId && previousThreadId !== threadId) {
        await this.bindAndLoad(agent, previousThreadId).catch(() => undefined);
      }
      if (targetWasArchived) {
        await this.host.archiveConversation(threadId).catch(() => undefined);
      }
      throw error;
    }
    return {
      threadId,
    };
  }

  async archiveAgentConversation(agent: Context): Promise<void> {
    const threadId = codexThreadId(agent);
    if (!threadId) return;
    await this.host.archiveConversation(threadId);
  }

  async deleteAgentConversation(agent: Context): Promise<void> {
    const threadId = codexThreadId(agent);
    if (!threadId) return;
    await this.host.deleteConversation(threadId);
  }

  async reconcileConversations(agents: Context[]): Promise<void> {
    const retainedThreadIds = new Set(agents.flatMap((agent) => {
      const threadId = codexThreadId(agent);
      return [threadId, ...(this.options.retainedSessions?.(agent) ?? []).flatMap(session => session.kind === 'codex' ? [session.threadId] : [])].filter((id): id is string => Boolean(id));
    }));
    const [active, archived] = await Promise.all([
      this.host.listConversations(),
      this.host.listConversations({ archived: true }),
    ]);
    for (const conversation of archived) {
      if (retainedThreadIds.has(conversation.id)) {
        await this.host.unarchiveConversation(conversation.id);
      }
    }
    for (const conversation of active) {
      if (conversation.parentConversationId || retainedThreadIds.has(conversation.id)) continue;
      await this.host.archiveConversation(conversation.id);
    }
  }

  async forkConversation(agent: Context, targetAgent: Context, turnId?: string) {
    const source = await this.ensureSession(agent);
    let forkedFromTurnId = turnId;
    if (turnId === undefined) {
      const snapshot = source.handle.getSnapshot();
      if (snapshot.busy || snapshot.activeTurnId) {
        // A running turn can hold an unfinished tool call. Fork only a completed native boundary; never interrupt or replay the source.
        const boundary = [...snapshot.turns].reverse().find(turn => turn.status === 'completed' && turn.id !== snapshot.activeTurnId);
        if (!boundary) return null;
        forkedFromTurnId = boundary.id;
      }
    }
    const defaults = targetAgent.providerDefaults?.kind === 'codex' ? targetAgent.providerDefaults : undefined;
    const preset = effectiveApprovalPreset(this.approvalPreset(defaults), this.host.getSnapshot().approvalPresets);
    const options = {
      ...agentCwd(targetAgent),
      ...(preset ? { approvalPreset: preset } : {}),
      ...(defaults?.model ? { model: defaults.model } : {}),
      ...(defaults?.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
      ...(defaults?.serviceTier !== undefined ? { serviceTier: defaults.serviceTier } : {}),
    };
    const result = await (forkedFromTurnId === undefined ? source.handle.fork(
      options,
      { extensionContext: this.extensionContext(targetAgent) },
    ) : source.handle.forkTurn(
      forkedFromTurnId,
      options,
      { extensionContext: this.extensionContext(targetAgent) },
    ));
    this.bindRuntime(targetAgent, result.conversationId, false);
    return {
      threadId: result.conversationId,
      activeTurnId: result.snapshot.activeTurnId,
      ...(forkedFromTurnId === undefined ? {} : { forkedFromTurnId }),
    };
  }

  async loadConversation(agent: Context): Promise<string | null> {
    const threadId = codexThreadId(agent);
    if (!threadId) return null;
    const started = performance.now();
    const mark = (stage: string) => {
      this.diagnostic({ layer: 'harness-adapter', stage,
        agentId: agent.id, threadId, at: performance.timeOrigin + performance.now(), elapsedMs: performance.now() - started });
    };
    mark('load.begin');
    const pending = this.sessionInitializations.get(agent.id);
    if (pending) {
      const session = await pending;
      if (session.handle.id === threadId && this.sessionsByAgentId.get(agent.id) === session) {
        this.publishInitial(session, session.handle.getSnapshot());
        mark('load.shared-initialization');
        return threadId;
      }
    }
    const existing = this.sessionsByAgentId.get(agent.id);
    if (existing?.handle.id === threadId) {
      existing.agent = agent;
      const currentSnapshot = existing.handle.getSnapshot();
      if (currentSnapshot.activeTurnId !== null) {
        // This adapter already owns the live session and receives its events in
        // the background. Keep that richer in-memory transcript authoritative
        // instead of replacing it with load's five-turn bootstrap page.
        this.publishConversationSnapshot(existing, currentSnapshot);
        mark('load.live-cache');
        return threadId;
      }
      const hydratedAt = this.historyHydratedAtByAgentId.get(agent.id) ?? 0;
      if (Date.now() - hydratedAt < AGENT_HISTORY_CACHE_TTL_MS) {
        this.publishConversationSnapshot(existing, currentSnapshot);
        mark('load.ttl-cache');
        return threadId;
      }

      const wasSuppressingEvents = existing.suppressEvents;
      existing.suppressEvents = true;
      try {
        const requestedDefaults = agent.providerDefaults?.kind === 'codex' ? { ...agent.providerDefaults } : undefined;
        await existing.handle.load({ ...agentCwd(agent), extensionContext: this.extensionContext(agent) });
        mark('load.sdk-ready');
        this.historyHydratedAtByAgentId.set(agent.id, Date.now());
        const snapshot = await this.restoreConversationSettings(existing, existing.handle.getSnapshot(), requestedDefaults);
        mark('load.settings-restored');
        // Publish load's full initial page now. Older messages remain behind
        // the SDK's demand-paging cursor until the conversation requests them.
        this.publishInitial(existing, snapshot);
        mark('load.published');
        existing.suppressEvents = wasSuppressingEvents;
      } finally {
        existing.suppressEvents = wasSuppressingEvents;
      }
      return threadId;
    }
    await this.bindAndLoad(agent, threadId);
    mark('load.cold-ready');
    this.historyHydratedAtByAgentId.set(agent.id, Date.now());
    return threadId;
  }

  async respondToClientRequest(response: ClientRequestResponse): Promise<void> {
    const { agentId, ...nativeResponse } = response;
    const owners = [...this.approvalOwners, ...this.clientRequestOwners]
      .filter(([key, owner]) => key === JSON.stringify([owner.agent.id, response.id]) && (!agentId || owner.agent.id === agentId));
    if (!agentId && new Set(owners.map(([, owner]) => owner.agent.id)).size > 1) throw new Error('Agent identity is required for this request.');
    const key = agentId ? JSON.stringify([agentId, response.id]) : owners[0]?.[0];
    const approvalOwner = key ? this.approvalOwners.get(key) : undefined;
    if (approvalOwner) {
      const allow = response.payload?.decision !== 'deny' && response.payload?.cancelled !== true;
      const scope = response.payload?.decision === 'allow_conversation' || response.payload?.decision === 'always_allow'
        ? 'session'
        : 'once';
      await invokeCodexConversationBridgeOperation(
        this.host, approvalOwner.handle.id, 'resolveApproval', [response.id, allow ? 'approve' : 'deny', scope],
      );
      return;
    }
    const requestOwner = key ? this.clientRequestOwners.get(key) : undefined;
    // A message-derived async question can remain pending in the SDK snapshot
    // even if its clientRequest.requested event was missed during transport.
    const projectedOwner = agentId ? this.sessionsByAgentId.get(agentId) : undefined;
    const pendingQuestionOwner = projectedOwner?.handle.getSnapshot().clientRequests.some(
      (request) => request.id === response.id,
    ) ? projectedOwner : undefined;
    const owner = requestOwner ?? pendingQuestionOwner;
    if (owner) {
      try {
        const respond = () => invokeCodexConversationBridgeOperation(
          this.host, owner.handle.id, 'respondToClientRequest', [nativeResponse],
        );
        const request = owner.handle.getSnapshot().clientRequests.find(request => request.id === response.id);
        // Async answers submit a new user message. Blocking replies and approvals
        // must remain free to unblock provider work during submission.
        if (request?.kind === 'ask_user' && request.payload.request.delivery === 'async') await this.serializeSubmission(owner, respond);
        else await respond();
      } finally {
        this.publishConversationSnapshot(owner, owner.handle.getSnapshot());
      }
      return;
    }
    if (agentId) throw new Error(`Context request '${response.id}' is no longer pending for '${agentId}'.`);
    await this.host.respondToClientRequest(nativeResponse);
  }

  private emitUsage(observation:ExecutionObservation):void { for(const listener of this.usageListeners) { try { listener(observation); } catch { /* Observation must not change provider execution. */ } } }
  onUsage(listener:(observation:ExecutionObservation)=>void):()=>void { this.usageListeners.add(listener); return ()=>this.usageListeners.delete(listener); }

  onEvent(listener: AdapterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.imageGeneration.close();
    this.resetCreditTokens.clear();
    for (const cancel of this.resetReadCancellations) cancel();
    this.resetReadCancellations.clear();
    this.unsubscribeHost();
    for (const session of this.sessionsByAgentId.values()) session.unsubscribe();
    this.sessionsByAgentId.clear();
    this.sessionInitializations.clear();
    this.historyHydratedAtByAgentId.clear();
    this.agentIdsByThreadId.clear();
    this.approvalOwners.clear();
    this.clientRequestOwners.clear();
    this.subagentOwners.clear();
    this.conversationSummaries.clear();
    this.lastSubagentIdentityByConversationId.clear();
    this.subagentIdentityLoads.clear();
    this.liveSubagentConversationIds.clear();
    await this.closeHost();
  }

  private async ensureSession(
    agent: Context,
    extensionContext: unknown = this.extensionContext(agent),
  ): Promise<AgentConversation<Context>> {
    const requestedThreadId = codexThreadId(agent);
    const pending = this.sessionInitializations.get(agent.id);
    if (pending) {
      const session = await pending;
      if (!requestedThreadId || session.handle.id === requestedThreadId) {
        session.agent = agent;
        return session;
      }
      return this.ensureSession(agent, extensionContext);
    }
    const existing = this.sessionsByAgentId.get(agent.id);
    if (existing && (!requestedThreadId || existing.handle.id === requestedThreadId)) {
      existing.agent = agent;
      return existing;
    }
    if (existing) this.releaseConversation(agent.id);
    if (requestedThreadId) return this.bindAndLoad(agent, requestedThreadId);

    let initialization!: Promise<AgentConversation<Context>>;
    initialization = this.createAgentConversation(agent, extensionContext, () => (
      !this.closed && this.sessionInitializations.get(agent.id) === initialization
    ));
    this.sessionInitializations.set(agent.id, initialization);
    try {
      return await initialization;
    } finally {
      if (this.sessionInitializations.get(agent.id) === initialization) {
        this.sessionInitializations.delete(agent.id);
      }
    }
  }

  private async createAgentConversation(
    agent: Context,
    extensionContext: unknown,
    isCurrent: () => boolean,
  ): Promise<AgentConversation<Context>> {
    await this.start();
    if (!isCurrent()) throw new Error('Codex conversation initialization was cancelled.');
    const defaults = agent.providerDefaults?.kind === 'codex'
      ? { ...agent.providerDefaults }
      : undefined;
    const requestedPreset = this.approvalPreset(defaults);
    const effectivePreset = effectiveApprovalPreset(requestedPreset, this.host.getSnapshot().approvalPresets);
    const snapshot = await this.host.createConversation({
      ...agentCwd(agent),
      threadSource: 'user',
      ...(effectivePreset ? { approvalPreset: effectivePreset } : {}),
      ...(defaults?.model ? { model: defaults.model } : {}),
      ...(defaults?.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
      ...(defaults?.serviceTier !== undefined ? { serviceTier: defaults.serviceTier } : {}),
    }, { extensionContext });
    const threadId = snapshot.activeConversationId;
    if (!threadId) throw new Error('Codex did not create a conversation.');
    if (!isCurrent()) {
      if (!this.closed) this.host.forgetConversation(threadId);
      throw new Error('Codex conversation initialization was cancelled.');
    }
    const session = this.bindRuntime(agent, threadId, true, false);
    try {
      if (this.syncTitle(agent)) {
        await this.renameSessionIfNeeded(session, this.displayName(agent));
      }
    } catch {
      // Naming is best effort and must not prevent the first prompt. The host
      // retries through its normal post-session title synchronization.
    }
    if (this.closed || this.sessionsByAgentId.get(agent.id) !== session) {
      throw new Error('Codex conversation initialization was cancelled.');
    }
    return session;
  }


  private async renameSessionIfNeeded(session: AgentConversation<Context>, title: string): Promise<void> {
    const name = title.trim();
    const summary = session.handle.getSnapshot().conversations.find(
      (conversation) => conversation.id === session.handle.id,
    );
    if (summary?.title === name) return;
    await invokeCodexConversationBridgeOperation(
      this.host, session.handle.id, 'renameConversation', [name],
    );
  }

  async readConversationContent(agent: Context, input: import('../../contracts/conversation').ConversationContentInput): Promise<import('../../contracts/conversation').ConversationContentChunk> {
    const session = this.sessionsByAgentId.get(agent.id);
    if (!session || agent.providerSession?.kind !== 'codex' || agent.providerSession.threadId !== input.sessionId || session.handle.id !== input.sessionId) throw new Error('Conversation image is no longer available.');
    const chunk = await session.handle.readContent(input.contentId, input.offset);
    if (this.closed || this.sessionsByAgentId.get(agent.id) !== session || agent.providerSession?.kind !== 'codex' || agent.providerSession.threadId !== input.sessionId) throw new Error('Conversation image is no longer available.');
    return chunk;
  }

  private async bindAndLoad(
    agent: Context,
    threadId: string,
  ): Promise<AgentConversation<Context>> {
    const pending = this.sessionInitializations.get(agent.id);
    if (pending) {
      const session = await pending;
      if (session.handle.id === threadId) return session;
      return this.bindAndLoad(agent, threadId);
    }
    let initialization!: Promise<AgentConversation<Context>>;
    initialization = this.loadBoundConversation(agent, threadId, () => !this.closed && this.sessionInitializations.get(agent.id) === initialization);
    this.sessionInitializations.set(agent.id, initialization);
    try { return await initialization; }
    finally {
      if (this.sessionInitializations.get(agent.id) === initialization) this.sessionInitializations.delete(agent.id);
    }
  }

  private async loadBoundConversation(agent: Context, threadId: string, isCurrent: () => boolean): Promise<AgentConversation<Context>> {
    const started = performance.now();
    let previous = started;
    const mark = (stage: string) => {
      const now = performance.now();
      this.diagnostic({ layer: 'harness-adapter', stage,
        agentId: agent.id, threadId, at: performance.timeOrigin + now, stageMs: now - previous, elapsedMs: now - started });
      previous = now;
    };
    const existing = this.sessionsByAgentId.get(agent.id);
    if (existing && existing.handle.id === threadId) {
      existing.agent = agent;
      const snapshot = existing.handle.getSnapshot();
      this.publishInitial(existing, snapshot);
      return existing;
    }

    await this.start();
    mark('bind.driver-connected');
    if (!isCurrent()) throw new Error('Conversation load was cancelled.');
    const requestedDefaults = agent.providerDefaults?.kind === 'codex'
      ? { ...agent.providerDefaults }
      : undefined;
    const session = this.bindRuntime(agent, threadId, false, true);
    mark('bind.runtime-bound');
    try {
      let snapshot = await session.handle.load({ ...agentCwd(agent), extensionContext: this.extensionContext(agent) });
      mark('bind.sdk-ready');
      if (!isCurrent() || this.sessionsByAgentId.get(agent.id) !== session) throw new Error('Conversation load was cancelled.');
      const interruptedTurnId = snapshot.activeTurnId;
      const resumedActiveGoal = snapshot.goal?.status === 'active';
      if (interruptedTurnId && !resumedActiveGoal) {
        // A newly created App backend has no ownership of an old in-progress
        // turn unless app-server is continuing a persistent goal. Leaving a
        // genuinely orphaned turn active permanently disables the composer
        // after an app restart, so ask app-server to end only that case before
        // exposing the hydrated conversation.
        snapshot = await session.handle.interrupt();
      }
      snapshot = session.handle.getSnapshot();
      this.publishQuickChatConversationTitle(session, snapshot.conversations.find(
        (conversation) => conversation.id === threadId,
      ));
      snapshot = await this.restoreConversationSettings(session, snapshot, requestedDefaults);
      mark('bind.settings-restored');
      if (!isCurrent() || this.sessionsByAgentId.get(agent.id) !== session) throw new Error('Conversation load was cancelled.');
      this.publishInitial(session, snapshot);
      mark('bind.published');
      session.suppressEvents = false;
      return session;
    } catch (error) {
      mark('bind.failed');
      if (this.sessionsByAgentId.get(agent.id) === session) this.releaseConversation(agent.id);
      throw error;
    }
  }

  private async restoreConversationSettings(
    session: AgentConversation<Context>,
    snapshot: CodexConversationSnapshot,
    requestedDefaults: Context['providerDefaults'],
  ): Promise<CodexConversationSnapshot> {
    if (this.options.inheritNativeSettings) return snapshot;
    const settings: UpdateConversationSettings = {};
    if (requestedDefaults?.userSelectedModel && requestedDefaults.model) {
      const modelId = snapshot.models.find(model => model.model === requestedDefaults.model || model.id === requestedDefaults.model)?.id ?? requestedDefaults.model;
      if (snapshot.selectedModelId !== modelId || (requestedDefaults.reasoningEffort && snapshot.selectedReasoningEffort !== requestedDefaults.reasoningEffort)) {
        settings.modelId = modelId;
        if (requestedDefaults.reasoningEffort) settings.reasoningEffort = requestedDefaults.reasoningEffort;
      }
    }
    const requestedPreset = this.approvalPreset(requestedDefaults);
    const effectivePreset = effectiveApprovalPreset(requestedPreset, snapshot.approvalPresets);
    if (effectivePreset && snapshot.approvalPreset !== effectivePreset) settings.approvalPreset = effectivePreset;
    if (requestedDefaults?.kind === 'codex' && requestedDefaults.serviceTier !== undefined && (snapshot.selectedServiceTier !== requestedDefaults.serviceTier || settings.modelId)) {
      settings.serviceTier = requestedDefaults.serviceTier;
    }
    return Object.keys(settings).length ? invokeCodexConversationBridgeOperation(
      this.host, session.handle.id, 'updateConversationSettings', [settings],
    ) : snapshot;
  }

  private bindRuntime(
    agent: Context,
    threadId: string,
    publishInitial: boolean,
    suppressEvents = false,
  ): AgentConversation<Context> {
    const otherAgentId = this.agentIdsByThreadId.get(threadId);
    if (otherAgentId && otherAgentId !== agent.id) this.releaseConversation(otherAgentId);
    const initialization = this.sessionInitializations.get(agent.id);
    this.releaseConversation(agent.id);
    if (initialization) this.sessionInitializations.set(agent.id, initialization);
    const handle = this.host.conversation(threadId);
    const session: AgentConversation<Context> = {
      agent,
      handle,
      images: new ConversationContentTransport(threadId),
      suppressEvents,
      unsubscribe: () => undefined,
    };
    this.sessionsByAgentId.set(agent.id, session);
    this.agentIdsByThreadId.set(threadId, agent.id);
    try {
      session.unsubscribe = subscribeCodexConversationReplicaBridge(this.host, threadId, (notification) => {
        if (notification.type === 'snapshot') {
          if (!session.suppressEvents) this.publishConversationSnapshot(session, notification.snapshot);
          return;
        }
        this.handleConversationEvent(session, notification.event);
      });
    } catch (error) {
      this.releaseConversation(agent.id);
      throw error;
    }
    if (publishInitial) {
      this.publishInitial(session, handle.getSnapshot(), {
        publishProviderSnapshot: false,
        publishStatus: false,
      });
    }
    return session;
  }

  private publishInitial(
    session: AgentConversation<Context>,
    snapshot: CodexConversationSnapshot,
    options: { publishProviderSnapshot?: boolean; publishStatus?: boolean } = {},
  ): void {
    this.emitThread(session, { type: 'agent.conversationAttached', payload: { cwd: conversationCwd(snapshot) } });
    this.emitSettings(
      session,
      snapshot.approvalPreset,
      snapshot.selectedModelId,
      snapshot.selectedReasoningEffort,
      snapshot.selectedServiceTier,
      snapshot.planMode,
    );
    if (snapshot.goal) this.emitThread(session, { type: 'conversation.goalUpdated', payload: { goal: snapshot.goal } });
    if (snapshot.contextUsage) {
      this.emitThread(session, { type: 'conversation.contextUsageUpdated', payload: { contextUsage: snapshot.contextUsage } });
    }
    if (snapshot.turnGitDiff) this.emitDiff(session, snapshot.turnGitDiff);
    if (options.publishStatus !== false) this.emitStatus(session, statusFromSnapshot(snapshot));
    if (options.publishProviderSnapshot !== false) this.publishConversationSnapshot(session, snapshot);
    else this.reconcilePending(session, snapshot);
  }

  private diagnostic(record: HarnessDiagnostic): void {
    notifyListeners(this.options.onDiagnostic ? [this.options.onDiagnostic] : [], record, this.options.onListenerError);
  }

  private publishConversationSnapshot(
    session: AgentConversation<Context>,
    snapshot: CodexConversationSnapshot,
  ): void {
    if (this.sessionsByAgentId.get(session.agent.id) !== session) return;
    const started = performance.now();
    this.reconcilePending(session, snapshot);
    const revision = (this.conversationRevisionsByAgentId.get(session.agent.id) ?? 0) + 1;
    this.conversationRevisionsByAgentId.set(session.agent.id, revision);
    const projected = conversationSnapshotForTransport(session.images.project(snapshot));
    const projectedAt = performance.now();
    this.emitThread(session, {
      type: 'codex.conversationSnapshotChanged',
      payload: {
        revision,
        snapshot: projected,
      },
    });
    this.diagnostic({ layer: 'harness-adapter', stage: 'frame.projected-and-emitted',
      agentId: session.agent.id, threadId: session.handle.id, revision, messages: snapshot.messages.length,
      startAt: performance.timeOrigin + started, at: performance.timeOrigin + performance.now(), projectMs: projectedAt - started, emitMs: performance.now() - projectedAt });
  }

  private reconcilePending(
    session: AgentConversation<Context>,
    snapshot: CodexConversationSnapshot,
  ): void {
    const pendingIds = new Set(snapshot.clientRequests.map(request => request.id));
    for (const [key, owner] of this.clientRequestOwners) {
      if (owner !== session) continue;
      const [, id] = JSON.parse(key) as [string, string];
      if (pendingIds.has(id)) continue;
      this.clientRequestOwners.delete(key);
      this.emitThread(session, { type: 'agentRequest.resolved', payload: {
        id, outcome: { kind: 'cancelled', reason: 'provider_snapshot' },
      } });
    }
    for (const request of snapshot.clientRequests) {
      const key = JSON.stringify([session.agent.id, request.id]);
      if (this.clientRequestOwners.get(key) === session) continue;
      this.clientRequestOwners.set(key, session);
      this.emitThread(session, { type: 'agentRequest.created', payload: { request: requestFromClientRequest(request, { conversationId: session.handle.id }) } });
    }
    for (const approval of snapshot.approvals) {
      const key = JSON.stringify([session.agent.id, approval.id]);
      if (this.approvalOwners.get(key) === session) continue;
      this.approvalOwners.set(key, session);
      this.emitThread(session, { type: 'agentRequest.created', payload: { request: approvalAgentRequest(approval) } });
    }
  }

  private handleHostEvent(event: CodexEvent): void {
    if (event.type === 'authentication.changed') {
      const identity = JSON.stringify(event.payload.authentication.account);
      if (identity !== this.accountIdentity || event.origin === 'notification') {
        this.accountIdentity = identity; ++this.accountRevision;
        this.resetCreditTokens.clear();
        for (const cancel of this.resetReadCancellations) cancel();
        const state = authenticationFromHost(event.payload.authentication);
        this.emit({ provider: 'codex', type: 'provider.authenticationChanged', payload: { kind: 'codex', connected: Boolean(state.account || !state.requiresOpenaiAuth), state }, occurredAt: event.occurredAt });
      }
    }

    if (event.type === 'conversation.summaryUpserted') {
      this.conversationSummaries.set(event.conversationId, event.payload.summary);
      const rootAgentId = this.agentIdsByThreadId.get(event.conversationId);
      const rootSession = rootAgentId ? this.sessionsByAgentId.get(rootAgentId) : undefined;
      if (rootSession?.handle.id === event.conversationId) {
        this.publishQuickChatConversationTitle(rootSession, event.payload.summary);
      }
      const owner = this.subagentOwners.get(event.conversationId);
      const session = owner ? this.sessionsByAgentId.get(owner.agentId) : undefined;
      if (session && session.handle.id === owner?.rootConversationId) {
        this.emitSubagentIdentity(session, event.payload.summary);
      }
      return;
    }
    if (event.type === 'conversation.summaryRemoved') {
      this.conversationSummaries.delete(event.conversationId);
      this.lastSubagentIdentityByConversationId.delete(event.conversationId);
      return;
    }
    if ('conversationId' in event) {
      const owner = this.subagentOwners.get(event.conversationId);
      if (!owner) return;
      const session = this.sessionsByAgentId.get(owner.agentId);
      if (!session || session.handle.id !== owner.rootConversationId) return;
      if (
        event.origin === 'notification' &&
        event.type !== 'conversation.historyReplaced' &&
        event.type !== 'conversation.historyPrepended'
      ) {
        this.liveSubagentConversationIds.add(event.conversationId);
      }
      this.refreshSubagentIdentity(session, event.conversationId);
      if (event.type === 'subagent.toolCallChanged') {
        this.emitSubagentToolCall(session, event);
      } else if (event.type === 'subagent.activity') {
        this.emitSubagentActivity(session, event);
      } else if (event.type === 'turn.started') {
        this.emitSubagentStatus(session, event.conversationId, 'running', event.occurredAt);
      } else if (event.type === 'turn.completed') {
        this.emitSubagentStatus(
          session,
          event.conversationId,
          subagentStatusFromTurn(event.payload.status),
          event.occurredAt,
          event.payload.error?.message ?? undefined,
        );
      } else if (event.type === 'turn.error' && !event.payload.willRetry) {
        this.emitSubagentStatus(
          session,
          event.conversationId,
          'errored',
          event.occurredAt,
          event.payload.error.message,
        );
      }
      return;
    }
    if (event.type === 'host.statusChanged') {
      this.emit({ provider: 'codex', type: 'provider.statusChanged', payload: runtimeStatus(this.host.getSnapshot()), occurredAt: event.occurredAt });
      return;
    }
    if (event.type === 'rateLimits.changed' && event.payload.rateLimits) {
      this.emit({
        provider: 'codex',
        type: 'account.rateLimitsUpdated',
        payload: { rateLimits: event.payload.rateLimits.rateLimits },
        occurredAt: event.occurredAt,
      });
      return;
    }
    if (event.type === 'catalog.skillsChanged' && event.payload.status === 'loaded') {
      this.emit({
        provider: 'codex',
        type: 'skills.changed',
        payload: skillsChangedPayload(event.payload.cwd, event.payload.skills, event.payload.status),
        occurredAt: event.occurredAt,
      });
      return;
    }
    if (event.type === 'remoteControl.statusChanged') {
      this.emit({
        provider: 'codex',
        type: 'remoteControl.statusChanged',
        payload: event.payload.status,
        occurredAt: event.occurredAt,
      });
    }
  }

  private handleConversationEvent(session: AgentConversation<Context>, event: CodexConversationEvent): void {
    if (session.suppressEvents) return;
    if (isClientConversationEvent(event)) this.publishConversationEvent(session, event);
    this.historyHydratedAtByAgentId.set(session.agent.id, Date.now());
    const consumption=codexExecutionConsumption(event);
    const requestCoverage = codexRequestCoverage(event);
    if (event.type === 'conversation.executionUsageChanged' && (consumption || requestCoverage)) {
      const turnId=(event as unknown as {turnId?:string}).turnId;
      if (typeof turnId === 'string') {
        this.emitUsage({
          agentId: session.agent.id,
          sessionId: session.handle.id,
          turnId,
          provider: 'codex',
          phase: 'usage',
          at: Date.parse(event.occurredAt),
          model: null,
          ...consumption,
          ...requestCoverage,
        });
      }
    }
    if (event.type === 'turn.modelRerouted') {
      this.emitUsage({
        agentId: session.agent.id,
        sessionId: session.handle.id,
        turnId: event.turnId,
        provider: 'codex',
        phase: 'usage',
        at: Date.parse(event.occurredAt),
        model: event.payload.toModel,
      });
    }
    if (event.type === 'turn.error' && !event.payload.willRetry) {
      this.emitUsage({agentId:session.agent.id,sessionId:session.handle.id,turnId:event.turnId,provider:'codex',phase:'failed',at:Date.parse(event.occurredAt),model:null});
    }
    if (event.type === 'turn.started' || event.type === 'turn.completed') {
      const settings = event.type === 'turn.started' ? session.handle.getSnapshot() : null;
      const phase =
        event.type === 'turn.started'
          ? 'started'
          : event.payload.status === 'inProgress'
            ? 'started'
            : event.payload.status;
      const observation: ExecutionObservation = {
        agentId: session.agent.id,
        sessionId: session.handle.id,
        turnId: event.turnId,
        provider: 'codex',
        phase,
        at: Date.parse(event.occurredAt),
        model:
          consumption?.model ??
          (settings ? selectedCodexModel(settings) : null),
        ...(settings
          ? {
              reasoningEffort: settings.selectedReasoningEffort,
              serviceTier:
                settings.selectedServiceTier === null
                  ? 'normal'
                  : settings.selectedServiceTier ?? null,
            }
          : {}),
        ...(event.type === 'turn.started'
          ? { requestCoverage: 'partial' as const, requestCoverageReason: 'missing-sdk-request-evidence' as const }
          : requestCoverage),
        ...(consumption ? { tokens: consumption.tokens } : {}),
        ...(event.type === 'turn.completed' && event.payload.durationMs !== null
          ? { durationMs: event.payload.durationMs }
          : {}),
      };
      this.emitUsage(observation);
    }
    const metadata = { occurredAt: event.occurredAt };
    switch (event.type) {
      case 'conversation.summaryUpserted':
      case 'conversation.summaryRemoved':
        return;
      case 'conversation.activityChanged':
        this.emitStatus(session, statusFromSnapshot(session.handle.getSnapshot()), event.occurredAt);
        return;
      case 'conversation.settingsChanged':
        this.emitSettings(
          session,
          event.payload.approvalPreset,
          event.payload.selectedModelId,
          event.payload.selectedReasoningEffort,
          event.payload.selectedServiceTier,
          event.payload.planMode,
          event.occurredAt,
        );
        return;
      case 'conversation.goalChanged':
        if (event.origin === 'action') return;
        this.emitThread(session, event.payload.goal
          ? { type: 'conversation.goalUpdated', turnId: event.turnId, payload: { goal: event.payload.goal }, ...metadata }
          : { type: 'conversation.goalCleared', turnId: event.turnId, payload: {}, ...metadata });
        return;
      case 'conversation.contextUsageChanged':
        if (event.payload.contextUsage) {
          this.emitThread(session, {
            type: 'conversation.contextUsageUpdated', turnId: event.turnId,
            payload: { contextUsage: event.payload.contextUsage }, ...metadata,
          });
        }
        return;
      case 'conversation.skillsChanged':
        if (event.payload.status === 'loaded') {
          this.emitThread(session, {
            type: 'skills.changed',
            payload: skillsChangedPayload(event.payload.cwd, event.payload.skills, event.payload.status),
            ...metadata,
          });
        }
        return;
      case 'conversation.permissionsChanged':
        return;
      case 'conversation.diffUpdated':
        if (event.payload.diff) this.emitDiff(session, event.payload.diff, event.occurredAt);
        return;
      case 'subagent.toolCallChanged': {
        this.emitSubagentToolCall(session, event);
        return;
      }
      case 'subagent.activity': {
        this.emitSubagentActivity(session, event);
        return;
      }
      case 'turn.error':
        if (providerSafetyBlockMessage(event.payload.error)) this.emitStatus(session, statusFromSnapshot(session.handle.getSnapshot()), event.occurredAt);
        return;
      case 'turn.completed':
        if (providerSafetyBlockMessage(event.payload.error)) this.emitStatus(session, statusFromSnapshot(session.handle.getSnapshot()), event.occurredAt);
        void this.refreshQuickChatConversationTitle(session);
        return;
      case 'file.activity':
        this.emitThread(session, {
          type: 'workspace.fileActivityDetected', turnId: event.turnId,
          payload: { ...event.payload },
          ...metadata,
        });
        return;
      case 'approval.requested':
        this.approvalOwners.set(JSON.stringify([session.agent.id, event.payload.approval.id]), session);
        this.emitThread(session, { type: 'agentRequest.created', turnId: event.turnId, payload: { request: approvalAgentRequest(event.payload.approval) }, ...metadata });
        return;
      case 'approval.resolved':
        this.approvalOwners.delete(JSON.stringify([session.agent.id, event.payload.approval.id]));
        this.emitThread(session, { type: 'agentRequest.resolved', turnId: event.turnId, payload: {
          id: event.payload.approval.id,
          outcome: approvalOutcome(event.payload.decision, event.payload.scope, event.payload.reason),
        }, ...metadata });
        this.emitStatus(session, statusFromSnapshot(session.handle.getSnapshot()), event.occurredAt);
        return;
      case 'clientRequest.requested':
        this.clientRequestOwners.set(JSON.stringify([session.agent.id, event.payload.request.id]), session);
        this.emitThread(session, { type: 'agentRequest.created', turnId: event.turnId, payload: { request: requestFromClientRequest(event.payload.request, { conversationId: session.handle.id, turnId: event.turnId }) }, ...metadata });
        return;
      case 'clientRequest.resolved':
        this.clientRequestOwners.delete(JSON.stringify([session.agent.id, event.payload.request.id]));
        this.emitThread(session, { type: 'agentRequest.resolved', turnId: event.turnId, payload: {
          id: event.payload.request.id,
          outcome: event.payload.response ? agentResponseFromClientResponse(event.payload.response).outcome : approvalOutcome(null, null, event.payload.reason),
        }, ...metadata });
        this.emitStatus(session, statusFromSnapshot(session.handle.getSnapshot()), event.occurredAt);
        return;
      default:
        return;
    }
  }

  private publishConversationEvent(
    session: AgentConversation<Context>,
    event: CodexConversationEvent,
  ): void {
    if (this.sessionsByAgentId.get(session.agent.id) !== session) return;
    const revision = (this.conversationRevisionsByAgentId.get(session.agent.id) ?? 0) + 1;
    this.conversationRevisionsByAgentId.set(session.agent.id, revision);
    this.emitThread(session, {
      type: 'codex.conversationEventReceived',
      payload: {
        revision,
        event: structuredClone(session.images.project(event)),
      },
    });
  }

  private emitSettings(
    session: AgentConversation<Context>,
    preset: ApprovalPreset | null,
    selectedModelId: string | null,
    selectedReasoningEffort: string | null,
    selectedServiceTier: string | null | undefined,
    planMode: boolean,
    occurredAt?: string,
  ): void {
    if (preset || selectedModelId || selectedReasoningEffort || selectedServiceTier !== undefined) {
      this.emitThread(session, {
        type: 'conversation.settingsUpdated',
        payload: {
          settings: {
            ...(preset ? { approvalPreset: preset } : {}),
            ...(selectedModelId ? { model: selectedModelId } : {}),
            ...(selectedReasoningEffort ? { reasoningEffort: selectedReasoningEffort } : {}),
            ...(selectedServiceTier === undefined ? {} : { serviceTier: selectedServiceTier }),
          },
        },
        ...(occurredAt ? { occurredAt } : {}),
      });
    }
    this.emitThread(session, {
      type: 'conversation.modeUpdated',
      payload: { mode: planMode ? 'plan' : 'default' },
      ...(occurredAt ? { occurredAt } : {}),
    });
  }

  private emitDiff(
    session: AgentConversation<Context>,
    diff: NonNullable<CodexConversationSnapshot['turnGitDiff']>,
    occurredAt?: string,
  ): void {
    this.emitThread(session, {
      type: 'conversation.turnDiffUpdated', turnId: diff.turnId,
      payload: { addedLines: diff.addedLines, removedLines: diff.removedLines, diff: diff.diff },
      ...(occurredAt ? { occurredAt } : {}),
    });
  }

  private emitStatus(session: AgentConversation<Context>, status: AgentStatus, occurredAt?: string): void {
    this.emitThread(session, {
      type: 'agent.statusChanged', payload: status,
      ...(occurredAt ? { occurredAt } : {}),
    });
  }

  private emitSubagentToolCall(
    session: AgentConversation<Context>,
    event: Extract<CodexConversationEvent, { type: 'subagent.toolCallChanged' }>,
  ): void {
    const toolCall = event.payload.toolCall;
    const owner = { agentId: session.agent.id, rootConversationId: session.handle.id };
    for (const conversationId of toolCall.receiverConversationIds) {
      this.subagentOwners.set(conversationId, owner);
    }
    const operation: SubagentOperationChange['operation'] = {
      id: toolCall.id,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      lifecycle: event.payload.lifecycle,
      kind: toolCall.tool,
      status: toolCall.status,
      senderConversationId: toolCall.senderConversationId,
      receiverConversationIds: [...toolCall.receiverConversationIds],
      ...(toolCall.prompt ? { prompt: toolCall.prompt } : {}),
      ...(toolCall.model ? { model: toolCall.model } : {}),
      ...(toolCall.reasoningEffort ? { reasoningEffort: toolCall.reasoningEffort } : {}),
      occurredAt: event.occurredAt,
    };
    const agentStates: SubagentOperationChange['agentStates'] = {};
    for (const [conversationId, state] of Object.entries(toolCall.agentStates)) {
      this.subagentOwners.set(conversationId, owner);
      agentStates[conversationId] = {
        status: state.status,
        ...(state.message ? { message: state.message } : {}),
      };
    }
    this.emitThread(session, {
      type: 'subagent.operationChanged',
      turnId: event.turnId,
      payload: {
        rootConversationId: session.handle.id,
        operation,
        agentStates,
      } satisfies SubagentOperationChange,
      occurredAt: event.occurredAt,
    });
    for (const conversationId of new Set([
      ...toolCall.receiverConversationIds,
      ...Object.keys(toolCall.agentStates),
    ])) {
      const summary = this.conversationSummaries.get(conversationId);
      if (summary) this.emitSubagentIdentity(session, summary);
      this.refreshSubagentIdentity(session, conversationId);
    }
  }

  private emitSubagentActivity(
    session: AgentConversation<Context>,
    event: Extract<CodexConversationEvent, { type: 'subagent.activity' }>,
  ): void {
    const activity: SubagentActivityChange['activity'] = {
      id: event.payload.activity.id,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      lifecycle: event.payload.lifecycle,
      kind: event.payload.activity.kind,
      conversationId: event.payload.activity.agentConversationId,
      agentPath: event.payload.activity.agentPath,
      occurredAt: event.occurredAt,
    };
    if (activity.conversationId === session.handle.id) return;
    this.subagentOwners.set(activity.conversationId, {
      agentId: session.agent.id,
      rootConversationId: session.handle.id,
    });
    this.emitThread(session, {
      type: 'subagent.activityChanged',
      turnId: event.turnId,
      payload: {
        rootConversationId: session.handle.id,
        parentConversationId: event.conversationId,
        activity,
      } satisfies SubagentActivityChange,
      occurredAt: event.occurredAt,
    });
    const summary = this.conversationSummaries.get(activity.conversationId);
    if (summary) this.emitSubagentIdentity(session, summary);
    this.refreshSubagentIdentity(session, activity.conversationId);
  }

  private refreshSubagentIdentity(session: AgentConversation<Context>, conversationId: string): void {
    if (this.lastSubagentIdentityByConversationId.has(conversationId)) return;
    if (this.subagentIdentityLoads.has(conversationId)) return;
    const load = this.host.readConversationSummary(conversationId).then((summary) => {
      const owner = this.subagentOwners.get(conversationId);
      if (owner?.agentId !== session.agent.id || owner.rootConversationId !== session.handle.id) return;
      this.conversationSummaries.set(summary.id, summary);
      this.emitSubagentIdentity(session, summary);
    }).catch(() => undefined).finally(() => {
      if (this.subagentIdentityLoads.get(conversationId) === load) {
        this.subagentIdentityLoads.delete(conversationId);
      }
    });
    this.subagentIdentityLoads.set(conversationId, load);
  }

  private emitSubagentIdentity(session: AgentConversation<Context>, summary: CodexConversationSummary): void {
    if (summary.id === session.handle.id) return;
    if (!summary.agentNickname && !summary.agentRole) return;
    const identityKey = `${summary.agentNickname ?? ''}\u0000${summary.agentRole ?? ''}`;
    if (this.lastSubagentIdentityByConversationId.get(summary.id) === identityKey) return;
    this.lastSubagentIdentityByConversationId.set(summary.id, identityKey);
    this.emitThread(session, {
      type: 'subagent.identityChanged',
      payload: {
        rootConversationId: session.handle.id,
        conversationId: summary.id,
        ...(summary.agentNickname ? { agentNickname: summary.agentNickname } : {}),
        ...(summary.agentRole ? { agentRole: summary.agentRole } : {}),
      } satisfies SubagentIdentityChange,
      occurredAt: summary.updatedAt,
    });
  }

  private publishQuickChatConversationTitle(
    session: AgentConversation<Context>,
    summary: CodexConversationSummary | undefined,
  ): void {
    if (!summary || this.syncTitle(session.agent)) return;
    const conversationTitle = summary.title.trim();
    if (
      !conversationTitle ||
      conversationTitle === summary.id ||
      conversationTitle === session.agent.conversationTitle
    ) return;

    session.agent.conversationTitle = conversationTitle;
    this.emit({
      provider: 'codex',
      agentId: session.agent.id,
      threadId: session.handle.id,
      type: 'agent.updated',
      payload: {
        id: session.agent.id,
        conversationTitle,
      },
      occurredAt: summary.updatedAt,
    });
  }

  private async refreshQuickChatConversationTitle(session: AgentConversation<Context>): Promise<void> {
    if (this.syncTitle(session.agent)) return;
    const summary = await this.host.readConversationSummary(session.handle.id).catch(() => undefined);
    if (!summary) return;
    this.conversationSummaries.set(summary.id, summary);
    this.publishQuickChatConversationTitle(session, summary);
  }

  private emitSubagentStatus(
    session: AgentConversation<Context>,
    conversationId: string,
    status: SubagentStatusChange['status'],
    occurredAt: string,
    statusMessage?: string,
  ): void {
    this.emitThread(session, {
      type: 'subagent.statusChanged',
      payload: {
        rootConversationId: session.handle.id,
        conversationId,
        status,
        ...(statusMessage ? { statusMessage } : {}),
      } satisfies SubagentStatusChange,
      occurredAt,
    });
  }

  private emitThread(
    session: AgentConversation<Context>,
    event: ThreadProviderEvent,
  ): void {
    this.emit({
      ...event,
      agentId: session.agent.id,
      provider: 'codex',
      threadId: session.handle.id,
      conversationId: session.handle.id,
    } as ProviderEvent);
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private removePendingOwners(session: AgentConversation<Context>): void {
    for (const [id, owner] of this.approvalOwners) {
      if (owner === session) this.approvalOwners.delete(id);
    }
    for (const [id, owner] of this.clientRequestOwners) {
      if (owner === session) this.clientRequestOwners.delete(id);
    }
  }
}

function epochTimestampToIso(value: bigint): string {
  const numericValue = Number(value);
  const milliseconds = Math.abs(numericValue) < 100_000_000_000 ? numericValue * 1_000 : numericValue;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) throw new Error('Codex returned an invalid remote-control timestamp.');
  return date.toISOString();
}

function conversationSummary(
  conversation: CodexConversationSummary,
  storageState: ConversationSummary['storageState'] = 'active',
): ConversationSummary {
  return {
    id: conversation.id,
    ...(conversation.sessionId ? { sessionId: conversation.sessionId } : {}),
    ...(conversation.parentConversationId ? { parentConversationId: conversation.parentConversationId } : {}),
    ...(conversation.agentNickname ? { agentNickname: conversation.agentNickname } : {}),
    ...(conversation.agentRole ? { agentRole: conversation.agentRole } : {}),
    title: conversation.title,
    preview: conversation.preview,
    status: conversation.status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.turnCount,
    storageState,
    ref: { provider: 'codex', threadId: conversation.id },
  };
}


function sessionFinalAnswerText(messages: readonly ConversationMessage[], turnId: string): string {
  return messages.filter((message) => (
    message.role === 'assistant' && message.turnId === turnId && message.status === 'complete'
  )).flatMap((message) => message.parts.flatMap((part) => (
    part.type === 'text' && part.phase === 'final_answer' ? [part.text] : []
  ))).join('\n').trim();
}



function subagentStatusFromTurn(
  status: Extract<CodexConversationEvent, { type: 'turn.completed' }>['payload']['status'],
): SubagentStatusChange['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'interrupted') return 'interrupted';
  if (status === 'failed') return 'errored';
  return 'running';
}

function subagentStatusFromHistory(
  threadStatus: CodexThreadStatus | null,
  messages: readonly Message[],
): SubagentStatusChange['status'] | null {
  if (threadStatus?.type === 'active') return 'running';
  if (threadStatus?.type === 'systemError') return 'errored';
  if (threadStatus?.type !== 'idle') return null;
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  if (assistantMessages.some((message) => message.status === 'error')) return 'errored';
  return assistantMessages.some((message) => message.status === 'complete') ? 'completed' : null;
}

function authenticationFromHost(
  authentication: CodexSnapshot['authentication'],
): CodexAuthentication {
  return {
    // Older clients cannot decode new account variants; retain connection state without exposing an unknown shape.
    account: authentication.account && authentication.account.type !== 'gcp' ? { ...authentication.account } : null,
    requiresOpenaiAuth: authentication.requiresOpenaiAuth === true,
    login: {
      status: authentication.login.status,
      error: authentication.login.error,
    },
  };
}

function resultTurnId(
  snapshot: CodexConversationSnapshot,
  beforeTurnIds: readonly string[],
): string | undefined {
  if (snapshot.activeTurnId) return snapshot.activeTurnId;
  const known = new Set(beforeTurnIds);
  return [...snapshot.turnIds].reverse().find((turnId) => !known.has(turnId))
    ?? snapshot.turnIds.at(-1);
}

function hostPromptOptions(options: SendPromptOptions = {}): SendMessageOptions {
  const providerOptions = options.providerOptions?.kind === 'codex' ? options.providerOptions : undefined;
  return {
    ...(options.content === undefined ? {} : { content: options.content }),
    ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    ...(options.selection?.model ? { model: options.selection?.model } : {}),
    ...(typeof options.planMode === 'boolean' ? { planMode: options.planMode } : {}),
    ...(options.selection?.reasoningEffort ? { reasoningEffort: options.selection.reasoningEffort } : {}),
    ...(options.selection?.serviceTier !== undefined ? { serviceTier: options.selection.serviceTier } : {}),
    ...((options.skills?.length ?? 0) > 0 || (providerOptions?.skills?.length ?? 0) > 0
      ? { skills: options.skills?.length ? options.skills : providerOptions?.skills }
      : {}),
  };
}

function scopedPromptOptions(agent: Agent): SendMessageOptions | undefined {
  const defaults = agent.providerDefaults?.kind === 'codex' ? agent.providerDefaults : undefined;
  if (!defaults?.model && !defaults?.reasoningEffort) return undefined;
  return {
    ...(defaults.model ? { model: defaults.model } : {}),
    ...(defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
  };
}

/** Codex sometimes records a message's turn only in its metadata; the neutral model carries it on the message. */
function turnIdOf(message: ConversationMessage): string | undefined {
  return message.turnId ?? (typeof message.metadata?.turnId === 'string' ? message.metadata.turnId : undefined);
}

export function conversationMessages(
  messages: readonly ConversationMessage[],
  agentId: string,
  completeStreaming = false,
  omitToolPayloads = false,
): Message[] {
  return messages.map((message) => ({
    id: message.id,
    agentId,
    ...(message.kind ? { kind: message.kind } : {}),
    role: message.role,
    status: completeStreaming && message.status === 'streaming' ? 'complete' : message.status,
    ...(turnIdOf(message) ? { turnId: turnIdOf(message) } : {}),
    ...(message.metadata?.promptContent === undefined && message.metadata?.asyncQuestionAnswers === undefined ? {} : { metadata: {
      ...(message.metadata.promptContent === undefined ? {} : { promptContent: normalizePromptContent(message.metadata.promptContent as never) }),
      ...(message.metadata.asyncQuestionAnswers === undefined ? {} : { asyncQuestionAnswers: structuredClone(message.metadata.asyncQuestionAnswers as Record<string, { answers: string[] }>) }),
    } }),
    parts: messageParts(message.parts, omitToolPayloads),
    createdAt: message.createdAt ?? new Date(0).toISOString(),
  }));
}

function historicalConversationMessages(
  messages: readonly ConversationMessage[],
  agentId: string,
  completeStreaming = false,
): Message[] {
  return conversationMessages(messages, agentId, completeStreaming, true);
}

const MAX_TOOL_LABEL_BYTES = 4 * 1024;
const MAX_TOOL_METADATA_BYTES = 32 * 1024;
const MAX_TOOL_STATUS_BYTES = 64 * 1024;

function messageParts(parts: readonly ConversationMessagePart[], omitToolPayloads = false): MessagePart[] {
  const generatedImagePaths = new Map<string, string>();
  for (const part of parts) {
    if (part.type !== 'tool') continue;
    const savedPath = part.metadata?.savedPath;
    if (typeof savedPath === 'string' && path.isAbsolute(savedPath)) {
      generatedImagePaths.set(part.id, savedPath);
    }
  }

  return parts.map((part) => {
    const rendered = messagePart(part, omitToolPayloads);
    if (
      rendered.type === 'media' &&
      rendered.itemId &&
      rendered.media.url.startsWith('data:image/')
    ) {
      const savedPath = generatedImagePaths.get(rendered.itemId);
      if (savedPath) {
        return {
          ...rendered,
          media: { ...rendered.media, url: pathToFileURL(savedPath).href },
        };
      }
    }
    return rendered;
  });
}

function messagePart(part: ConversationMessagePart, omitToolPayloads = false): MessagePart {
  if (part.type === 'tool') return toolPartProjection(part, omitToolPayloads);
  if (part.type === 'attachment') return { type: 'attachment', attachment: { ...part.attachment } };
  if (part.type === 'question') {
    const request = requestFromClientRequest(part.request, { conversationId: part.request.conversationId ?? '' }) as Extract<AgentRequest, { kind: 'question' }>;
    return { type: 'question', ...(part.historical ? { historical: true } : {}), request };
  }
  return { ...part };
}

function skillsChangedPayload(
  cwd: string | null,
  skills: readonly Skill[],
  status: 'loaded',
): { cwd: string | null; skills: ProviderSkillSummary[]; status: 'loaded' } {
  return {
    cwd,
    skills: skills.map(providerSkillSummary),
    status,
  };
}

function providerSkillSummary(skill: Skill): ProviderSkillSummary {
  const { brandColor, defaultPrompt, ...summary } = skill;
  return {
    id: skill.path,
    ...summary,
    ...(typeof brandColor === 'string' && brandColor.trim() ? { brandColor } : {}),
    ...(typeof defaultPrompt === 'string' ? { defaultPrompt } : {}),
  };
}

function toolPartProjection(part: ConversationMessageToolPart, omitPayloads = false): ToolPart {
  const metadata = omitPayloads ? undefined : boundedToolMetadata(part.metadata);
  const input = omitPayloads ? undefined : toolInputProjection(part.input);
  const output = omitPayloads ? undefined : toolOutputProjection(part.output);
  return {
    type: 'tool',
    id: part.id,
    kind: part.kind ?? 'generic',
    title: boundedToolLabel(part.title),
    status: part.status,
    ...(part.statusText ? { statusText: boundedToolStatus(part.statusText, part.status) } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function boundedToolLabel(value: string): string {
  const bytes = Buffer.byteLength(value);
  return bytes <= MAX_TOOL_LABEL_BYTES
    ? value
    : `${value.slice(0, MAX_TOOL_LABEL_BYTES)}…`;
}

function boundedToolStatus(value: string, fallback: ConversationMessageToolPart['status']): string {
  return Buffer.byteLength(value) <= MAX_TOOL_STATUS_BYTES ? value : fallback;
}

const toolInputPresentationKeys = new Set([
  'app', 'appName', 'branchName', 'bundleIdentifier', 'changes', 'command', 'commandActions',
  'cwd', 'destinationPath', 'direction', 'displayId', 'element_index', 'key', 'kind', 'name', 'path', 'phase', 'pid',
  'query', 'repoPath', 'rootElementIndex', 'scope', 'title', 'to', 'type', 'url', 'x', 'y',
]);

const toolOutputPresentationKeys = new Set([
  'agentName', 'answers', 'app', 'apps', 'externalUrl', 'kind', 'localizedName', 'name', 'path', 'phase', 'prompt',
  'outcome', 'queued', 'recipientName', 'result', 'structuredContent', 'success', 'url',
]);

function toolInputProjection(value: unknown): unknown {
  return boundedStructuredValue(toolPresentationProjection(value, toolInputPresentationKeys));
}

function toolOutputProjection(value: unknown): unknown {
  return boundedStructuredValue(toolPresentationProjection(value, toolOutputPresentationKeys));
}

function toolPresentationProjection(value: unknown, keys: ReadonlySet<string>, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    return Buffer.byteLength(value) <= MAX_TOOL_LABEL_BYTES ? value : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) return undefined;
    const projected = value
      .map((entry) => toolPresentationProjection(entry, keys, depth + 1))
      .filter((entry) => entry !== undefined);
    return projected.length > 0 ? projected : undefined;
  }
  if (typeof value !== 'object') return undefined;

  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!keys.has(key)) continue;
    if (key === 'answers') {
      const answers = boundedStructuredValue(entry);
      if (answers !== undefined) projected[key] = answers;
      continue;
    }
    const child = toolPresentationProjection(entry, keys, depth + 1);
    if (child !== undefined) projected[key] = child;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function boundedStructuredValue(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized) > MAX_TOOL_METADATA_BYTES) return undefined;
    return JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }
}

function boundedToolMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(metadata)) <= MAX_TOOL_METADATA_BYTES) return { ...metadata };
  } catch {
    // Retain only small scalar identity fields below.
  }

  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      (typeof value === 'string' && Buffer.byteLength(value) <= 4 * 1024)
    ) {
      bounded[key] = value;
    }
  }
  return Object.keys(bounded).length > 0 ? bounded : undefined;
}

function runtimeStatus(snapshot: CodexSnapshot): ProviderRuntimeStatus {
  if (snapshot.status === 'connecting') return { provider: 'codex', status: 'starting' };
  if (snapshot.status === 'ready') return { provider: 'codex', status: 'running' };
  if (snapshot.status === 'error') return { provider: 'codex', status: 'error', ...(snapshot.error ? { detail: snapshot.error } : {}) };
  return { provider: 'codex', status: 'notConfigured' };
}

function effectiveApprovalPreset(
  requested: ApprovalPreset | undefined,
  available: readonly ApprovalPreset[],
): ApprovalPreset | null {
  if (requested === undefined) return null;
  if (available.includes(requested)) return requested;
  return (['approve-for-me', 'ask-for-approval', 'full-access'] as const)
    .find((preset) => available.includes(preset)) ?? null;
}

function codexThreadId(agent: Agent): string | null {
  return agent.providerSession?.kind === 'codex' ? agent.providerSession.threadId : null;
}

function agentCwd(agent: Pick<Agent, 'folder'>): { cwd?: string } {
  const folder = agent.folder?.trim();
  return folder ? { cwd: expandHome(folder) } : {};
}

function expandHome(folder: string): string {
  const trimmed = folder.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function conversationCwd(snapshot: CodexConversationSnapshot): string | undefined {
  return snapshot.conversations.find((conversation) => conversation.id === snapshot.activeConversationId)?.cwd;
}

function conversationSnapshotForTransport(
  snapshot: CodexConversationSnapshot,
): CodexConversationSnapshot {
  return structuredClone({
    ...snapshot,
    conversations: [],
    models: [],
    skills: [],
    plugins: [],
    permissionProfiles: [],
    approvalPresets: [],
  });
}

function isClientConversationEvent(event: CodexConversationEvent): boolean {
  switch (event.type) {
    case 'conversation.summaryUpserted':
    case 'conversation.summaryRemoved':
    case 'conversation.skillsChanged':
    case 'conversation.permissionsChanged':
    case 'file.activity':
    case 'subagent.toolCallChanged':
    case 'subagent.activity':
    case 'realtime.started':
    case 'realtime.itemAdded':
    case 'realtime.transcriptDelta':
    case 'realtime.transcriptCompleted':
    case 'realtime.audioDelta':
    case 'realtime.sdp':
    case 'realtime.error':
    case 'realtime.closed':
      return false;
    default:
      return true;
  }
}

function assistantTurnText(messages: readonly ConversationMessage[], turnId: string): string {
  const assistantMessages = messages.filter((message) => (
    message.role === 'assistant' && message.turnId === turnId
  ));
  const finalText = sessionFinalAnswerText(messages, turnId);
  if (finalText) return finalText;
  return assistantMessages.flatMap((message) => message.parts.flatMap((part) => (
    part.type === 'text' ? [part.text] : []
  ))).join('\n').trim();
}
