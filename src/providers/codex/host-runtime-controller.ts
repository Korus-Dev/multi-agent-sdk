import type {
  CodexConversationSummary,
  CodexHostEvent,
  HostEventOrigin,
  CodexHostSnapshot,
  ConversationMessage,
} from '../../core/codex-host';
import { upsertConversationTurn } from './host-events';
import { CodexHostApprovalsController } from './host-approvals-controller';
import { CodexHostClientRequestsController } from './host-client-requests-controller';
import {
  createThreadRuntime,
  runtimeProjection,
  type ThreadRuntimePatch,
  type ThreadRuntimeState,
} from './host-runtime';

type HostEventInput = CodexHostEvent extends infer Event
  ? Event extends CodexHostEvent
    ? Omit<Event, 'seq' | 'occurredAt' | 'origin'>
    : never
  : never;

export interface CodexHostRuntimeDependencies {
  emitEvent(origin: HostEventOrigin, input: HostEventInput): void;
  getState(): CodexHostSnapshot;
  notifyConversationListeners(threadId: string): void;
  patch(patch: Partial<CodexHostSnapshot>, conversationId?: string): void;
  schedulePluginRefresh(): void;
}

export class CodexHostRuntimeController {
  private readonly runtimes = new Map<string, ThreadRuntimeState>();
  private readonly semanticEventValues = new Map<string, string>();

  constructor(
    private readonly approvals: CodexHostApprovalsController,
    private readonly clientRequests: CodexHostClientRequestsController,
    private readonly host: CodexHostRuntimeDependencies,
  ) {}

  get(threadId: string): ThreadRuntimeState | undefined {
    return this.runtimes.get(threadId);
  }

  values(): IterableIterator<ThreadRuntimeState> {
    return this.runtimes.values();
  }

  clear(): void {
    this.runtimes.clear();
    this.semanticEventValues.clear();
  }

  forget(threadId: string): void {
    this.runtimes.delete(threadId);
    this.semanticEventValues.delete(`summary:${threadId}`);
    this.semanticEventValues.delete(`activity:${threadId}`);
    this.semanticEventValues.delete(`settings:${threadId}`);
  }

  create(threadId: string, patch: ThreadRuntimePatch = {}): ThreadRuntimeState {
    const existing = this.runtimes.get(threadId);
    if (existing) {
      Object.assign(existing, patch);
      return existing;
    }
    const runtime = createThreadRuntime(threadId, this.host.getState(), patch);
    this.runtimes.set(threadId, runtime);
    return runtime;
  }

  require(threadId: string): ThreadRuntimeState {
    return this.runtimes.get(threadId) ?? this.create(threadId);
  }

  projection(runtime: ThreadRuntimeState): ReturnType<typeof runtimeProjection> {
    return runtimeProjection(
      runtime,
      this.approvals.approvalsForThread(runtime.threadId),
      this.clientRequests.requestsForThread(runtime.threadId),
    );
  }

  snapshot(runtime: ThreadRuntimeState): CodexHostSnapshot {
    return { ...this.host.getState(), ...this.projection(runtime) };
  }

  activate(runtime: ThreadRuntimeState): void {
    this.host.patch({
      activeConversationId: runtime.threadId,
      ...this.projection(runtime),
    });
    this.host.emitEvent('action', {
      type: 'conversation.selected',
      payload: { conversationId: runtime.threadId },
    });
  }

  patch(threadId: string, patch: ThreadRuntimePatch): void {
    const runtime = this.require(threadId);
    const historyChanged = (['historyLoading', 'historyLoadingOlder', 'historyHasOlder', 'fullHistoryHydrated', 'loadingStrategy', 'historyItemsView'] as const)
      .some((key) => key in patch && patch[key] !== runtime[key]);
    Object.assign(runtime, patch);
    if (this.host.getState().activeConversationId === threadId) {
      this.host.patch(this.projection(runtime), threadId);
    } else {
      this.host.notifyConversationListeners(threadId);
    }
    if (historyChanged) {
      this.host.emitEvent('lifecycle', {
        type: 'conversation.historyStateChanged',
        conversationId: threadId,
        payload: {
          historyLoading: runtime.historyLoading,
          historyState: runtimeHistoryState(runtime),
          error: runtime.error,
        },
      });
    }
  }

  emitHostStatus(origin: HostEventOrigin): void {
    const state = this.host.getState();
    this.host.emitEvent(origin, {
      type: 'host.statusChanged',
      payload: { status: state.status, error: state.error },
    });
  }

  emitSummaryUpserted(
    summary: CodexConversationSummary,
    reason: Extract<CodexHostEvent, { type: 'conversation.summaryUpserted' }>['payload']['reason'],
    origin: HostEventOrigin,
  ): void {
    this.host.schedulePluginRefresh();
    const fingerprint = JSON.stringify({
      id: summary.id,
      title: summary.title,
      preview: summary.preview,
      cwd: summary.cwd,
      status: summary.status,
      turnCount: summary.turnCount,
      createdAt: summary.createdAt,
    });
    if (this.semanticEventValues.get(`summary:${summary.id}`) === fingerprint) return;
    this.semanticEventValues.set(`summary:${summary.id}`, fingerprint);
    this.host.emitEvent(origin, {
      type: 'conversation.summaryUpserted',
      conversationId: summary.id,
      payload: { summary: structuredClone(summary), reason },
    });
  }

  emitConversationActivity(threadId: string, origin: HostEventOrigin): void {
    const runtime = this.require(threadId);
    const payload = {
      threadStatus: structuredClone(runtime.threadStatus),
      busy: runtime.busy,
      error: runtime.error,
    };
    const fingerprint = JSON.stringify(payload);
    if (this.semanticEventValues.get(`activity:${threadId}`) === fingerprint) return;
    this.semanticEventValues.set(`activity:${threadId}`, fingerprint);
    this.host.emitEvent(origin, {
      type: 'conversation.activityChanged',
      conversationId: threadId,
      payload,
    });
  }

  emitConversationSettings(threadId: string, origin: HostEventOrigin): void {
    const runtime = this.require(threadId);
    const payload = {
      approvalPreset: runtime.approvalPreset,
      selectedModelId: runtime.selectedModelId,
      selectedReasoningEffort: runtime.selectedReasoningEffort,
      selectedServiceTier: runtime.selectedServiceTier,
      planMode: runtime.planMode,
    };
    const fingerprint = JSON.stringify(payload);
    if (this.semanticEventValues.get(`settings:${threadId}`) === fingerprint) return;
    this.semanticEventValues.set(`settings:${threadId}`, fingerprint);
    this.host.emitEvent(origin, {
      type: 'conversation.settingsChanged',
      conversationId: threadId,
      payload,
    });
  }

  emitConversationSkills(threadId: string, origin: HostEventOrigin): void {
    const runtime = this.require(threadId);
    this.host.emitEvent(origin, {
      type: 'conversation.skillsChanged',
      conversationId: threadId,
      payload: {
        cwd: runtime.cwd,
        skills: structuredClone(runtime.skills),
        status: runtime.skillCatalogStatus,
      },
    });
  }

  emitConversationPermissions(threadId: string, origin: HostEventOrigin): void {
    const runtime = this.require(threadId);
    this.host.emitEvent(origin, {
      type: 'conversation.permissionsChanged',
      conversationId: threadId,
      payload: {
        cwd: runtime.cwd,
        permissionProfiles: structuredClone(runtime.permissionProfiles),
        approvalPresets: [...runtime.approvalPresets],
      },
    });
  }

  emitHistoryReplaced(
    threadId: string,
    reason: Extract<CodexHostEvent, { type: 'conversation.historyReplaced' }>['payload']['reason'],
    origin: HostEventOrigin,
  ): void {
    const runtime = this.require(threadId);
    this.host.emitEvent(origin, {
      type: 'conversation.historyReplaced',
      conversationId: threadId,
      payload: {
        reason,
        messages: structuredClone(runtime.messages),
        threadStatus: structuredClone(runtime.threadStatus),
        state: historyReplacementState(runtime),
      },
    });
  }

  emitHistoryPrepended(
    threadId: string,
    messages: readonly ConversationMessage[],
    origin: HostEventOrigin,
  ): void {
    if (messages.length === 0) return;
    const currentMessages = new Map(
      this.require(threadId).messages.map((message) => [message.id, message]),
    );
    this.host.emitEvent(origin, {
      type: 'conversation.historyPrepended',
      conversationId: threadId,
      payload: {
        messages: structuredClone(messages.map((message) => currentMessages.get(message.id) ?? message)),
        state: historyPrependState(this.require(threadId)),
      },
    });
  }

  messageContainingTool(threadId: string, turnId: string, itemId: string): ConversationMessage | null {
    return this.require(threadId).messages.find((message) => (
      message.metadata?.turnId === turnId
      && message.parts.some((part) => part.type === 'tool' && part.id === itemId)
    )) ?? null;
  }

  assistantMessageForTurn(threadId: string, turnId: string): ConversationMessage | null {
    return [...this.require(threadId).messages].reverse().find((message) => (
      message.role === 'assistant'
      && message.kind === undefined
      && message.metadata?.turnId === turnId
    )) ?? null;
  }

  markTurnActive(runtime: ThreadRuntimeState, turnId: string): void {
    const expired = runtime.turnIds.includes(turnId) ? [] : this.projection(runtime).clientRequests.filter(request => (
      request.kind === 'ask_user' && request.payload.request.delivery === 'async'
      && request.turnId && request.turnId !== turnId
    ));
    runtime.activeTurnId = turnId;
    runtime.busy = true;
    runtime.turnStartPending = false;
    if (!runtime.turnIds.includes(turnId)) runtime.turnIds.push(turnId);
    runtime.turns = upsertConversationTurn(runtime.turns, {
      id: turnId,
      status: 'inProgress',
      error: null,
      willRetry: false,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    });
    if (expired.length > 0) {
      this.patch(runtime.threadId, {
        answeredClientRequestIds: [...new Set([...runtime.answeredClientRequestIds, ...expired.map(request => request.id)])],
      });
      for (const request of expired) this.host.emitEvent('notification', {
        type: 'clientRequest.resolved', conversationId: runtime.threadId, turnId: request.turnId ?? undefined,
        payload: { request: structuredClone(request), response: null, reason: 'server' },
      });
    }
  }

  patchConversationStatus(
    threadId: string,
    status: CodexConversationSummary['status'],
    origin: HostEventOrigin = 'notification',
  ): void {
    const state = this.host.getState();
    this.host.patch({
      conversations: state.conversations.map((conversation) => conversation.id === threadId
        ? { ...conversation, status, updatedAt: new Date().toISOString() }
        : conversation),
    });
    const summary = this.host.getState().conversations.find((conversation) => conversation.id === threadId);
    if (summary) this.emitSummaryUpserted(summary, 'updated', origin);
  }

  patchConversationTurnCount(
    threadId: string,
    turnCount: number,
    origin: HostEventOrigin = 'notification',
  ): void {
    const state = this.host.getState();
    this.host.patch({
      conversations: state.conversations.map((conversation) => conversation.id === threadId
        ? { ...conversation, turnCount, updatedAt: new Date().toISOString() }
        : conversation),
    });
    const summary = this.host.getState().conversations.find((conversation) => conversation.id === threadId);
    if (summary) this.emitSummaryUpserted(summary, 'updated', origin);
  }
}

function historyReplacementState(runtime: ThreadRuntimeState) {
  return structuredClone({
    activeTurnId: runtime.activeTurnId,
    answeredClientRequestIds: runtime.answeredClientRequestIds,
    busy: runtime.busy,
    contextUsage: runtime.contextUsage,
    error: runtime.error,
    executionPlan: runtime.executionPlan,
    historyLoading: runtime.historyLoading,
    historyState: runtimeHistoryState(runtime),
    turnGitDiff: runtime.turnGitDiff,
    turnIds: runtime.turnIds,
    turns: runtime.turns,
  });
}

function historyPrependState(runtime: ThreadRuntimeState) {
  return structuredClone({
    historyLoading: runtime.historyLoading,
    historyState: runtimeHistoryState(runtime),
    turnIds: runtime.turnIds,
    turns: runtime.turns,
  });
}

function runtimeHistoryState(runtime: ThreadRuntimeState) {
  return {
    loadingStrategy: runtime.loadingStrategy,
    ...(runtime.historyItemsView === 'summary' ? { itemsView: 'summary' as const } : {}),
    hasOlder: runtime.historyHasOlder,
    loadingOlder: runtime.historyLoadingOlder,
    fullyLoaded: runtime.fullHistoryHydrated,
  };
}
