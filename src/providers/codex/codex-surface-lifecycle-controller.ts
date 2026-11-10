import { notifyListeners } from 'codex-sdk';
import { readTurnItems } from './codex-surface-conversations-controller';
import type { CodexOriginalHistoryImages } from './codex-original-history-images';
import type { CodexAppServerClient, v2 } from 'codex-sdk';
import type {
  CodexConversationHistory,
  CodexConversationSummary,
  CodexSurfaceEvent,
  CodexSurfaceEventOrigin,
  CodexSurfaceSnapshot,
  CreateCodexConversationOptions,
} from '../../core/surface';
import {
  codexTurnToSurfaceMessages,
  preserveHistoricalMessagePresentation,
} from './codex-conversation-history';
import type {
  CodexConversationHostOptions,
  CodexConversationLoadOptions,
  CodexSurfaceOptions,
} from './codex-surface-contracts';
import { CodexSurfaceCatalogController } from './codex-surface-catalog-controller';
import { CodexSurfaceConversationSettingsController } from './codex-surface-conversation-settings-controller';
import { CodexSurfaceConversationsController } from './codex-surface-conversations-controller';
import {
  surfaceThreadStatus,
  threadToSummary,
  upsertConversation,
} from './codex-surface-data';
import { errorMessage } from './codex-surface-prompts';
import { CodexSurfaceExtensionsController } from './codex-surface-extensions-controller';
import { activeTurnId, ensureAssistantTurnMessage } from './codex-surface-message-state';
import { surfaceTurn } from './codex-surface-events';
import { normalizeMcpServers } from './codex-surface-mcp';
import type { ThreadRuntimePatch, ThreadRuntimeState } from './codex-surface-runtime';
import {
  collaborationMode,
  defaultReasoningEffort,
  validateServiceTier,
  requireCatalogModel,
  selectedModel,
  sessionSelection,
  validateReasoningEffort,
} from './codex-surface-settings';

const CONVERSATION_HISTORY_PAGE_SIZE = 5;

type HistoryReason = Extract<
  CodexSurfaceEvent,
  { type: 'conversation.historyReplaced' }
>['payload']['reason'];

export interface CodexSurfaceLifecycleHost {
  activateRuntime(runtime: ThreadRuntimeState): void;
  createRuntime(threadId: string, patch?: ThreadRuntimePatch): ThreadRuntimeState;
  emitConversationActivity(threadId: string, origin: CodexSurfaceEventOrigin): void;
  emitConversationPermissions(threadId: string, origin: CodexSurfaceEventOrigin): void;
  emitConversationSettings(threadId: string, origin: CodexSurfaceEventOrigin): void;
  emitConversationSkills(threadId: string, origin: CodexSurfaceEventOrigin): void;
  emitHistoryReplaced(threadId: string, reason: HistoryReason, origin: CodexSurfaceEventOrigin): void;
  emitSelected(conversationId: string): void;
  emitSummaryUpserted(
    summary: CodexConversationSummary,
    reason: 'created' | 'resumed' | 'updated',
    origin: CodexSurfaceEventOrigin,
  ): void;
  ensureConnected(): Promise<void>;
  getSnapshot(): CodexSurfaceSnapshot;
  getState(): CodexSurfaceSnapshot;
  observeEmptyConversation(threadId: string): void;
  patch(patch: Partial<CodexSurfaceSnapshot>): void;
  patchRuntime(threadId: string, patch: ThreadRuntimePatch): void;
  requireRuntime(threadId: string): ThreadRuntimeState;
  runtime(threadId: string): ThreadRuntimeState | undefined;
  runtimeProjection(runtime: ThreadRuntimeState): Partial<CodexSurfaceSnapshot>;
  snapshotForRuntime(runtime: ThreadRuntimeState): CodexSurfaceSnapshot;
}

export class CodexSurfaceLifecycleController {
  private readonly hydrationPromises = new Map<string, Promise<void>>();
  private readonly hostOptionsByThread = new Map<string, CodexConversationLoadOptions>();

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly options: Pick<CodexSurfaceOptions, 'conversationDefaults' | 'cwd' | 'loadingStrategy' | 'historyItemsView' | 'onDiagnostic' | 'onListenerError'>,
    private readonly catalog: CodexSurfaceCatalogController,
    private readonly extensions: CodexSurfaceExtensionsController,
    private readonly settings: CodexSurfaceConversationSettingsController,
    private readonly conversations: CodexSurfaceConversationsController,
    private readonly host: CodexSurfaceLifecycleHost,
    private readonly originalImages?: CodexOriginalHistoryImages,
  ) {}

  hostOptions(threadId: string): CodexConversationLoadOptions | undefined {
    return this.hostOptionsByThread.get(threadId);
  }

  rememberHostOptions(threadId: string, options: CodexConversationLoadOptions): void {
    this.hostOptionsByThread.set(threadId, options);
  }

  forget(threadId: string): void {
    this.hostOptionsByThread.delete(threadId);
    this.hydrationPromises.delete(threadId);
  }

  clear(): void {
    this.hostOptionsByThread.clear();
    this.hydrationPromises.clear();
  }

  resetHydrations(): void {
    this.hydrationPromises.clear();
  }

  async create(
    options: CreateCodexConversationOptions = {},
    hostOptions: CodexConversationHostOptions = {},
  ): Promise<CodexSurfaceSnapshot> {
    await this.host.ensureConnected();
    options = { ...this.options.conversationDefaults, ...options };
    const cwd = options.cwd ?? this.options.cwd;
    const catalogs = await this.catalog.loadConversationCatalogs(cwd);
    if (options.approvalPreset && !catalogs.approvalPresets.includes(options.approvalPreset)) {
      throw new Error(`Approval preset '${options.approvalPreset}' is not available`);
    }
    const state = this.host.getState();
    const inheritedApprovalPreset = options.approvalPreset
      ?? (options.approvalMode === undefined
        && options.permissionMode === undefined
        && state.approvalPreset
        && catalogs.approvalPresets.includes(state.approvalPreset)
        ? state.approvalPreset
        : undefined);
    const settings = this.settings.threadStartSettings({
      ...options,
      ...(inheritedApprovalPreset ? { approvalPreset: inheritedApprovalPreset } : {}),
    }, catalogs.approvalPresets);
    const currentModel = selectedModel(state.models, state.selectedModelId);
    const requestedModel = options.model ? requireCatalogModel(state.models, options.model) : currentModel;
    const model = requestedModel?.model;
    const requestedReasoningEffort = options.reasoningEffort
      ?? (requestedModel?.id === currentModel?.id
        ? state.selectedReasoningEffort
        : requestedModel ? defaultReasoningEffort(requestedModel) : null)
      ?? undefined;
    const requestedServiceTier = options.serviceTier !== undefined
      ? options.serviceTier
      : requestedModel?.id === currentModel?.id
        ? (state.selectedServiceTier ?? null)
        : requestedModel?.defaultServiceTier ?? null;
    validateReasoningEffort(requestedModel, requestedReasoningEffort);
    validateServiceTier(requestedModel, requestedServiceTier);
    const mcpServers = hostOptions.mcpServers === undefined
      ? this.extensions.defaultMcpServers
      : normalizeMcpServers(hostOptions.mcpServers);
    const extension = await this.extensions.conversationExtension({
      operation: 'start',
      conversationId: null,
      cwd,
      createOptions: options,
      extensionContext: hostOptions.extensionContext,
    }, options, mcpServers);
    const response = await this.client.request('thread/start', {
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(extension.baseInstructions === undefined ? {} : { baseInstructions: extension.baseInstructions }),
      ...(extension.developerInstructions === undefined
        ? {}
        : { developerInstructions: extension.developerInstructions }),
      ...(extension.config === undefined ? {} : { config: extension.config as v2.ThreadStartParams['config'] }),
      ...(this.extensions.hasDynamicTools() ? { dynamicTools: this.extensions.dynamicToolSpecs() } : {}),
      ...settings,
      ...(requestedServiceTier === undefined ? {} : { serviceTier: requestedServiceTier }),
      ...(options.threadSource === undefined ? {} : { threadSource: options.threadSource }),
      serviceName: 'codex_app_sdk',
    });
    this.host.observeEmptyConversation(response.thread.id);
    const selection = sessionSelection(response, state.models, state);
    if (requestedReasoningEffort) {
      await this.client.request('thread/settings/update', {
        threadId: response.thread.id,
        effort: requestedReasoningEffort,
        ...(requestedModel ? {
          collaborationMode: collaborationMode(state.planMode, requestedModel.model, requestedReasoningEffort),
        } : {}),
      });
      selection.selectedReasoningEffort = requestedReasoningEffort;
    }
    if (requestedServiceTier !== undefined) selection.selectedServiceTier = requestedServiceTier;
    if (requestedModel) selection.selectedModelId = requestedModel.id;
    if (inheritedApprovalPreset) selection.approvalPreset = inheritedApprovalPreset;
    const runtime = this.host.createRuntime(response.thread.id, {
      hydrated: true,
      ...(this.options.historyItemsView ? { historyItemsView: this.options.historyItemsView } : {}),
      historyMode: response.thread.historyMode ?? 'legacy',
      cwd: response.cwd ?? response.thread.cwd,
      activeTurnId: null,
      turnIds: [],
      messages: [],
      answeredClientRequestIds: [],
      threadStatus: surfaceThreadStatus(response.thread.status),
      ...catalogs,
      ...selection,
    });
    this.hostOptionsByThread.set(response.thread.id, {
      ...(cwd ? { cwd } : {}),
      ...hostOptions,
      mcpServers,
    });
    const summary = threadToSummary(response.thread);
    this.host.patch({
      activeConversationId: response.thread.id,
      conversations: upsertConversation(state.conversations, summary),
      ...this.host.runtimeProjection(runtime),
    });
    this.host.emitSummaryUpserted(summary, 'created', 'action');
    this.host.emitSelected(response.thread.id);
    this.emitConversationState(response.thread.id);
    return this.host.getSnapshot();
  }

  async select(conversationId: string): Promise<CodexSurfaceSnapshot> {
    await this.host.ensureConnected();
    const runtime = this.host.runtime(conversationId);
    if (runtime?.hydrated && (runtime.busy || runtime.activeTurnId !== null)) {
      this.host.activateRuntime(runtime);
      return this.host.getSnapshot();
    }
    return this.resume(conversationId);
  }

  resumeDuringBootstrap(conversationId: string): Promise<CodexSurfaceSnapshot> {
    return this.resume(conversationId);
  }

  async ensureReady(
    threadId: string,
    loadOptions: CodexConversationLoadOptions = {},
  ): Promise<ThreadRuntimeState> {
    await this.host.ensureConnected();
    const runtime = this.host.runtime(threadId);
    if (runtime?.hydrated && Object.keys(loadOptions).every(key => key === 'historyItemsView' || key === 'loadingStrategy')) {
      this.hostOptionsByThread.set(threadId, { ...this.hostOptionsByThread.get(threadId), ...loadOptions });
      this.host.patchRuntime(threadId, {
        ...(loadOptions.historyItemsView ? { historyItemsView: loadOptions.historyItemsView } : {}),
        ...(loadOptions.loadingStrategy ? { loadingStrategy: loadOptions.loadingStrategy } : {}),
      });
      if (loadOptions.historyItemsView === 'full') await this.conversations.loadLoadedTurnHistory(threadId);
      if (loadOptions.loadingStrategy === 'eager' && runtime.historyHasOlder) {
        void this.conversations.hydrateCompleteHistory(threadId).catch(() => undefined);
      }
      return runtime;
    }
    let hydration = this.hydrationPromises.get(threadId);
    if (!hydration) {
      hydration = this.resume(threadId, false, loadOptions, 'load').then(() => undefined);
      this.hydrationPromises.set(threadId, hydration);
      void hydration.finally(() => {
        if (this.hydrationPromises.get(threadId) === hydration) this.hydrationPromises.delete(threadId);
      }).catch(() => undefined);
    }
    await hydration;
    return this.host.requireRuntime(threadId);
  }

  async readHistory(conversationId: string): Promise<CodexConversationHistory> {
    await this.host.ensureConnected();
    if (!conversationId) throw new Error('There is no active conversation');
    const existing = await this.ensureReady(conversationId);
    if (existing.busy) { await this.conversations.loadLoadedTurnHistory(conversationId); return this.historySnapshot(conversationId, existing); }
    const loadingRuntime = this.host.createRuntime(conversationId, { historyLoading: true, error: null });
    if (this.host.getState().activeConversationId === conversationId) this.host.activateRuntime(loadingRuntime);
    try {
      const [response] = await Promise.all([
        this.client.request('thread/read', { threadId: conversationId, includeTurns: false }),
        this.conversations.refreshCompleteHistory(conversationId),
      ]);
      if (response.thread.id !== conversationId) {
        throw new Error(`Codex thread/read returned '${response.thread.id}' for requested thread '${conversationId}'`);
      }
      const hydratedRuntime = this.host.requireRuntime(conversationId);
      const runtime = this.host.createRuntime(conversationId, {
        hydrated: true,
        historyMode: response.thread.historyMode ?? 'legacy',
        historyLoading: false,
        activeTurnId: hydratedRuntime.activeTurnId,
        turns: hydratedRuntime.turns,
        turnIds: hydratedRuntime.turnIds,
        messages: hydratedRuntime.messages,
        loadingStrategy: hydratedRuntime.loadingStrategy,
        historyCursor: null,
        historyHasOlder: false,
        historyLoadingOlder: false,
        fullHistoryHydrated: true,
        busy: Boolean(hydratedRuntime.activeTurnId),
        threadStatus: surfaceThreadStatus(response.thread.status),
      });
      const summary = { ...threadToSummary(response.thread), turnCount: runtime.turnIds.length };
      const state = this.host.getState();
      this.host.patch({
        conversations: upsertConversation(state.conversations, summary),
        ...(state.activeConversationId === conversationId ? this.host.runtimeProjection(runtime) : {}),
      });
      this.host.emitSummaryUpserted(summary, 'updated', 'action');
      this.host.emitHistoryReplaced(conversationId, 'resync', 'action');
      this.host.emitConversationActivity(conversationId, 'action');
      return this.historySnapshot(conversationId, runtime);
    } catch (error) {
      this.host.patchRuntime(conversationId, { historyLoading: false, error: errorMessage(error) });
      throw error;
    }
  }

  private async resume(
    conversationId: string,
    activate = true,
    loadOptions: CodexConversationLoadOptions = {},
    historyReason: 'load' | 'resume' = 'resume',
  ): Promise<CodexSurfaceSnapshot> {
    const requestedHostOptions = { ...this.hostOptionsByThread.get(conversationId), ...loadOptions };
    const timingStarted = performance.now();
    let timingPrevious = timingStarted;
    const markTiming = (stage: string) => {
      const now = performance.now();
      notifyListeners(this.options.onDiagnostic ? [this.options.onDiagnostic] : [], { layer: 'codex-sdk', stage,
        threadId: conversationId, at: performance.timeOrigin + now, stageMs: now - timingPrevious, elapsedMs: now - timingStarted }, this.options.onListenerError);
      timingPrevious = now;
    };
    markTiming('resume.begin');
    const hostOptions = {
      ...requestedHostOptions,
      mcpServers: requestedHostOptions.mcpServers === undefined
        ? this.extensions.defaultMcpServers
        : normalizeMcpServers(requestedHostOptions.mcpServers),
    };
    this.hostOptionsByThread.set(conversationId, hostOptions);
    const extension = await this.extensions.conversationExtension({
      operation: 'resume',
      conversationId,
      cwd: hostOptions.cwd,
      extensionContext: hostOptions.extensionContext,
    }, {}, hostOptions.mcpServers);
    markTiming('extensions.ready');
    const historyItemsView = hostOptions.historyItemsView ?? this.options.historyItemsView ?? 'full';
    const loadingRuntime = this.host.createRuntime(conversationId, { historyLoading: true, error: null });
    const initialTurns = new Map(loadingRuntime.turns.map((turn) => [turn.id, turn]));
    const initialMessages = new Map(loadingRuntime.messages.map((message) => [message.id, message]));
    const initialStatus = loadingRuntime.threadStatus;
    if (activate) this.host.activateRuntime(loadingRuntime);
    try {
      const [response, goal] = await Promise.all([
        this.client.request('thread/resume', {
          threadId: conversationId,
          excludeTurns: true,
          initialTurnsPage: {
          limit: CONVERSATION_HISTORY_PAGE_SIZE,
          sortDirection: 'desc',
          itemsView: historyItemsView,
          },
          ...(hostOptions.cwd ? { cwd: hostOptions.cwd } : {}),
          ...(extension.baseInstructions === undefined ? {} : { baseInstructions: extension.baseInstructions }),
          ...(extension.developerInstructions === undefined
            ? {}
            : { developerInstructions: extension.developerInstructions }),
          ...(extension.config === undefined ? {} : { config: extension.config as v2.ThreadResumeParams['config'] }),
        }),
        this.client.request('thread/goal/get', { threadId: conversationId })
          .then((result) => result.goal)
          .catch(() => null),
      ]);
      markTiming('resume-and-goal.ready');
      if (response.thread.id !== conversationId) {
        throw new Error(`Codex thread/resume returned '${response.thread.id}' for requested thread '${conversationId}'`);
      }
      const initialPage = response.initialTurnsPage ?? await this.client.request('thread/turns/list', {
        threadId: response.thread.id,
        cursor: null,
        limit: CONVERSATION_HISTORY_PAGE_SIZE,
        sortDirection: 'desc',
        itemsView: historyItemsView,
      });
      const turns = await Promise.all([...initialPage.data].reverse().map(async turn =>
        turn.status === 'inProgress' && (turn.itemsView === 'summary' || turn.itemsView === 'notLoaded')
          ? { ...turn, items: await readTurnItems(this.client, response.thread.id, turn.id), itemsView: 'full' as const } : turn));
      markTiming('initial-page-and-active-items.ready');
      const cwd = response.cwd ?? response.thread.cwd ?? hostOptions.cwd;
      const catalogs = await this.catalog.loadConversationCatalogs(cwd);
      markTiming('permission-catalog.ready');
      const originalProjection = historyItemsView === 'full' ? await this.originalImages?.prepare(response.thread.id, response.thread.path) : undefined;
      markTiming('original-images.ready');
      const changedTurns = loadingRuntime.turns.filter((turn) => initialTurns.get(turn.id) !== turn);
      const threadStatus = loadingRuntime.threadStatus !== initialStatus && loadingRuntime.threadStatus
        ? loadingRuntime.threadStatus
        : surfaceThreadStatus(response.thread.status);
      const restoredTurns = turns.map((turn) => threadStatus.type === 'idle' && turn.status === 'inProgress'
        ? { ...turn, status: 'interrupted' as const }
        : turn);
      const previouslyFull = new Set(loadingRuntime.turns.filter(turn => turn.itemsView !== 'summary').map(turn => turn.id));
      const projectedTurns = new Map(restoredTurns.map((turn) => [turn.id, turn.itemsView === 'summary' && previouslyFull.has(turn.id)
        ? { ...loadingRuntime.turns.find(value => value.id === turn.id)!, ...surfaceTurn(turn), itemsView: 'full' as const } : surfaceTurn(turn)]));
      for (const turn of changedTurns) projectedTurns.set(turn.id, turn);
      const runningTurnId = changedTurns.length > 0
        ? loadingRuntime.activeTurnId
        : threadStatus.type === 'active' ? activeTurnId(turns) : null;
      const historyMessages = preserveHistoricalMessagePresentation(
        loadingRuntime.messages,
        restoredTurns.flatMap(turn => turn.itemsView === 'summary' && previouslyFull.has(turn.id)
          ? loadingRuntime.messages.filter(message => message.turnId === turn.id) : codexTurnToSurfaceMessages(response.thread.id, turn)),
      );
      // Notifications received while hydration awaited RPC/catalog data are newer
      // than that response. Never replace them with the stale transcript page.
      const mergedMessages = new Map(historyMessages.map((message) => [message.id, message]));
      for (const message of loadingRuntime.messages) {
        if (initialMessages.get(message.id) !== message) mergedMessages.set(message.id, message);
      }
      let messages = runningTurnId
        ? ensureAssistantTurnMessage([...mergedMessages.values()], response.thread.id, runningTurnId)
        : [...mergedMessages.values()];
      if (originalProjection) messages = originalProjection(messages);
      markTiming('messages.projected');
      const runtime = this.host.createRuntime(response.thread.id, {
        hydrated: true,
        historyMode: response.thread.historyMode ?? 'legacy',
        loadingStrategy: hostOptions.loadingStrategy ?? this.options.loadingStrategy ?? 'lazy',
        historyItemsView,
        historyCursor: initialPage.nextCursor,
        historyHasOlder: initialPage.nextCursor !== null,
        historyLoadingOlder: false,
        fullHistoryHydrated: initialPage.nextCursor === null,
        cwd: cwd ?? null,
        historyLoading: false,
        activeTurnId: runningTurnId,
        turns: [...projectedTurns.values()],
        turnIds: [...projectedTurns.keys()],
        messages,
        busy: changedTurns.length > 0 ? loadingRuntime.busy : Boolean(runningTurnId) || threadStatus.type === 'active',
        goal: goal ? { ...goal } : null,
        threadStatus,
        ...catalogs,
        ...sessionSelection(response, this.host.getState().models, this.host.snapshotForRuntime(loadingRuntime)),
      });
      const summary = { ...threadToSummary(response.thread), turnCount: turns.length };
      markTiming('runtime.created');
      const state = this.host.getState();
      this.host.patch({
        conversations: upsertConversation(state.conversations, summary),
        ...(state.activeConversationId === response.thread.id ? this.host.runtimeProjection(runtime) : {}),
      });
      this.host.emitSummaryUpserted(summary, 'resumed', 'action');
      this.host.emitHistoryReplaced(response.thread.id, historyReason, 'action');
      this.emitConversationState(response.thread.id);
      markTiming('events.published');
      if (historyItemsView === 'summary') this.conversations.hydrateOriginalImages(response.thread.id, response.thread.path);
      if (runtime.loadingStrategy === 'eager' && initialPage.nextCursor !== null) {
        void this.conversations.hydrateCompleteHistory(response.thread.id, {
          cursor: initialPage.nextCursor,
          initialPageLoaded: true,
        }).catch(() => undefined);
      }
      const result = this.host.getSnapshot();
      markTiming('snapshot.cloned');
      return result;
    } catch (error) {
      markTiming('resume.failed');
      this.host.patchRuntime(conversationId, { historyLoading: false, error: errorMessage(error) });
      throw error;
    }
  }

  private emitConversationState(threadId: string): void {
    this.host.emitConversationActivity(threadId, 'action');
    this.host.emitConversationSettings(threadId, 'action');
    this.host.emitConversationSkills(threadId, 'action');
    this.host.emitConversationPermissions(threadId, 'action');
  }

  private historySnapshot(
    conversationId: string,
    runtime: Pick<ThreadRuntimeState, 'messages' | 'threadStatus'>,
  ): CodexConversationHistory {
    return {
      conversationId,
      messages: structuredClone(runtime.messages),
      threadStatus: structuredClone(runtime.threadStatus),
    };
  }
}
