import { readTurnItems } from './codex-surface-conversations-controller';
import type { CodexOriginalHistoryImages } from './codex-original-history-images';
import type { CodexAppServerClient, v2 } from 'codex-sdk';
import type {
  CodexConversationSummary,
  CodexSurfaceSnapshot,
} from 'multi-agents-sdk/surface';
import { codexThreadToSurfaceMessages } from './codex-conversation-history';
import { CodexSurfaceCatalogController } from './codex-surface-catalog-controller';
import { CodexSurfaceExtensionsController } from './codex-surface-extensions-controller';
import { activeTurnId, ensureAssistantTurnMessage } from './codex-surface-message-state';
import { normalizeMcpServers } from './codex-surface-mcp';
import {
  approvalPresetStartParams,
  collaborationMode,
  requireCatalogModel,
  selectedModel,
  sessionSelection,
  validateReasoningEffort,
  validateServiceTier,
} from './codex-surface-settings';
import {
  surfaceThreadStatus,
  threadToSummary,
  upsertConversation,
} from './codex-surface-data';
import type {
  CodexConversationLoadOptions,
  ForkCodexConversationOptions,
} from './codex-surface-contracts';
import type { ThreadRuntimePatch, ThreadRuntimeState } from './codex-surface-runtime';
import { surfaceTurn } from './codex-surface-events';

const FORK_HISTORY_PAGE_SIZE = 5;

export type CodexSurfaceForkHost = {
  createRuntime(threadId: string, patch?: ThreadRuntimePatch): ThreadRuntimeState;
  emitConversationActivity(threadId: string): void;
  emitConversationPermissions(threadId: string): void;
  emitConversationSettings(threadId: string): void;
  emitConversationSkills(threadId: string): void;
  emitHistoryReplaced(threadId: string): void;
  hydrateOriginalImages?(threadId: string, path?: string | null): void;
  emitSummaryUpserted(summary: CodexConversationSummary): void;
  getState(): CodexSurfaceSnapshot;
  hydrateCompleteHistory(threadId: string): Promise<void>;
  patch(patch: Partial<CodexSurfaceSnapshot>): void;
  rememberHostOptions(threadId: string, options: CodexConversationLoadOptions): void;
  requireRuntime(threadId: string): ThreadRuntimeState;
  snapshotForRuntime(runtime: ThreadRuntimeState): CodexSurfaceSnapshot;
};

type CodexForkBoundary = {
  beforeTurnId?: string;
  lastTurnId?: string;
};

export class CodexSurfaceForkController {
  constructor(
    private readonly client: CodexAppServerClient,
    private readonly loadingStrategy: 'eager' | 'lazy' | undefined,
    private readonly catalog: CodexSurfaceCatalogController,
    private readonly extensions: CodexSurfaceExtensionsController,
    private readonly host: CodexSurfaceForkHost,
    private readonly originalImages?: CodexOriginalHistoryImages,
  ) {}

  async fork(
    sourceThreadId: string,
    options: ForkCodexConversationOptions = {},
    hostOptions: CodexConversationLoadOptions = {},
    boundary: CodexForkBoundary = {},
  ): Promise<string> {
    const sourceRuntime = this.host.requireRuntime(sourceThreadId);
    if (
      (sourceRuntime.busy || sourceRuntime.activeTurnId)
      && !boundary.beforeTurnId
      && (!boundary.lastTurnId || boundary.lastTurnId === sourceRuntime.activeTurnId)
    ) {
      throw new Error('Cannot fork a conversation while its current turn is still active');
    }

    const cwd = options.cwd ?? sourceRuntime.cwd ?? hostOptions.cwd;
    const catalogs = await this.catalog.loadConversationCatalogs(cwd ?? undefined);
    const state = this.host.getState();
    const requestedModel = options.model
      ? requireCatalogModel(state.models, options.model)
      : selectedModel(state.models, sourceRuntime.selectedModelId);
    validateReasoningEffort(requestedModel, options.reasoningEffort);
    validateServiceTier(requestedModel, options.serviceTier);

    const mcpServers = hostOptions.mcpServers === undefined
      ? this.extensions.defaultMcpServers
      : normalizeMcpServers(hostOptions.mcpServers);
    const extension = await this.extensions.conversationExtension({
      operation: 'start',
      conversationId: null,
      cwd: cwd ?? undefined,
      createOptions: options,
      extensionContext: hostOptions.extensionContext,
    }, options, mcpServers);
    const response = await this.client.request('thread/fork', {
      threadId: sourceThreadId,
      ...(boundary.beforeTurnId ? { beforeTurnId: boundary.beforeTurnId } : {}),
      ...(boundary.lastTurnId ? { lastTurnId: boundary.lastTurnId } : {}),
      excludeTurns: true,
      deferGoalContinuation: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model && requestedModel ? { model: requestedModel.model } : {}),
      ...(options.serviceTier === undefined ? {} : { serviceTier: options.serviceTier }),
      ...(extension.baseInstructions === undefined ? {} : { baseInstructions: extension.baseInstructions }),
      ...(extension.developerInstructions === undefined
        ? {}
        : { developerInstructions: extension.developerInstructions }),
      ...(extension.config === undefined ? {} : { config: extension.config as v2.ThreadForkParams['config'] }),
      ...forkApprovalSettings(options, catalogs.approvalPresets),
    });
    if (!response.thread.id || response.thread.id === sourceThreadId) {
      throw new Error(`Codex thread/fork returned an invalid new thread id '${response.thread.id}'`);
    }
    if (options.reasoningEffort) {
      await this.client.request('thread/settings/update', {
        threadId: response.thread.id,
        effort: options.reasoningEffort,
        ...(requestedModel ? {
          collaborationMode: collaborationMode(
            sourceRuntime.planMode,
            requestedModel.model,
            options.reasoningEffort,
          ),
        } : {}),
      });
    }

    const historyItemsView = hostOptions.historyItemsView ?? sourceRuntime.historyItemsView ?? 'full';
    const [initialPage, goal] = await Promise.all([
      this.client.request('thread/turns/list', {
        threadId: response.thread.id,
        cursor: null,
        limit: FORK_HISTORY_PAGE_SIZE,
        sortDirection: 'desc',
        itemsView: historyItemsView,
      }),
      this.client.request('thread/goal/get', { threadId: response.thread.id })
        .then((result) => result.goal)
        .catch(() => null),
    ]);
    const turns = await Promise.all([...initialPage.data].reverse().map(async turn =>
      turn.status === 'inProgress' && (turn.itemsView === 'summary' || turn.itemsView === 'notLoaded')
        ? { ...turn, items: await readTurnItems(this.client, response.thread.id, turn.id), itemsView: 'full' as const } : turn));
    const originalProjection = historyItemsView === 'full' ? await this.originalImages?.prepare(response.thread.id, response.thread.path) : undefined;
    const runningTurnId = activeTurnId(turns);
    const historyMessages = codexThreadToSurfaceMessages({ ...response.thread, turns });
    let messages = runningTurnId
      ? ensureAssistantTurnMessage(historyMessages, response.thread.id, runningTurnId)
      : historyMessages;
    if (originalProjection) messages = originalProjection(messages);
    const effectiveLoadingStrategy = hostOptions.loadingStrategy ?? this.loadingStrategy ?? 'lazy';
    const runtime = this.host.createRuntime(response.thread.id, {
      hydrated: true,
      historyMode: response.thread.historyMode ?? 'legacy',
      loadingStrategy: effectiveLoadingStrategy,
      historyItemsView,
      historyCursor: initialPage.nextCursor,
      historyHasOlder: initialPage.nextCursor !== null,
      historyLoadingOlder: false,
      fullHistoryHydrated: initialPage.nextCursor === null,
      cwd: response.cwd ?? response.thread.cwd ?? cwd ?? null,
      activeTurnId: runningTurnId,
      turns: turns.map((turn) => surfaceTurn(turn)),
      turnIds: turns.map((turn) => turn.id),
      messages,
      busy: Boolean(runningTurnId),
      goal: goal ? { ...goal } : null,
      threadStatus: surfaceThreadStatus(response.thread.status),
      ...catalogs,
      ...sessionSelection(response, state.models, this.host.snapshotForRuntime(sourceRuntime)),
    });
    if (options.reasoningEffort) runtime.selectedReasoningEffort = options.reasoningEffort;
    if (options.serviceTier !== undefined) runtime.selectedServiceTier = options.serviceTier;
    if (options.model && requestedModel) runtime.selectedModelId = requestedModel.id;

    this.host.rememberHostOptions(response.thread.id, {
      ...hostOptions,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
      loadingStrategy: effectiveLoadingStrategy,
      historyItemsView,
      mcpServers,
    });
    const summary = { ...threadToSummary(response.thread), turnCount: turns.length };
    this.host.patch({
      conversations: upsertConversation(this.host.getState().conversations, summary),
    });
    this.host.emitSummaryUpserted(summary);
    this.host.emitHistoryReplaced(response.thread.id);
    this.host.emitConversationActivity(response.thread.id);
    this.host.emitConversationSettings(response.thread.id);
    this.host.emitConversationSkills(response.thread.id);
    this.host.emitConversationPermissions(response.thread.id);
    if (historyItemsView === 'summary') this.host.hydrateOriginalImages?.(response.thread.id, response.thread.path);
    if (effectiveLoadingStrategy === 'eager' && initialPage.nextCursor !== null) {
      void this.host.hydrateCompleteHistory(response.thread.id).catch(() => undefined);
    }
    return response.thread.id;
  }

  async forkTurn(
    sourceThreadId: string,
    turnId: string,
    options: ForkCodexConversationOptions = {},
    hostOptions: CodexConversationLoadOptions = {},
  ): Promise<string> {
    const runtime = this.host.requireRuntime(sourceThreadId);
    if (!runtime.turnIds.includes(turnId)) {
      throw new Error(`Cannot fork at unknown Codex turn '${turnId}'`);
    }
    return this.fork(sourceThreadId, options, hostOptions, { lastTurnId: turnId });
  }
}

function forkApprovalSettings(
  options: ForkCodexConversationOptions,
  approvalPresets: readonly string[],
): Pick<v2.ThreadForkParams, 'approvalPolicy' | 'approvalsReviewer' | 'permissions' | 'sandbox'> {
  if (options.approvalPreset) {
    if (!approvalPresets.includes(options.approvalPreset)) {
      throw new Error(`Approval preset '${options.approvalPreset}' is not available`);
    }
    return approvalPresetStartParams(options.approvalPreset);
  }
  return {
    ...(options.approvalMode === undefined
      ? {}
      : { approvalPolicy: options.approvalMode === 'ask' ? 'on-request' as const : 'never' as const }),
    ...(options.permissionMode === undefined
      ? {}
      : { sandbox: options.permissionMode === 'full-access' ? 'danger-full-access' as const : options.permissionMode }),
  };
}
