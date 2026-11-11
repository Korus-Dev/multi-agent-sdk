import type { ServerNotification } from '@korus-dev/codex-sdk';
import type { EventOrigin, JsonValue } from '../../core/codex-host';
import type { CodexConversationSummary, CodexEvent, CodexSnapshot } from '../../core/codex-conversation-types';
import {
  commandOutputDeltaToToolPartUpdate,
  fileChangePatchToToolPartUpdate,
  lineDiffFromUnifiedDiff,
  mcpProgressToToolPartUpdate,
} from './codex-tool-part-adapter';
import { CodexHostApprovalsController } from './host-approvals-controller';
import { CodexHostAuthenticationController } from './host-authentication-controller';
import { CodexHostCatalogController } from './host-catalog-controller';
import { CodexHostClientRequestsController } from './host-client-requests-controller';
import { CodexHostConversationsController } from './host-conversations-controller';
import {
  conversationStatus,
  mergeHostRateLimits,
  contextUsageFromTokens,
  tokenUsage,
  hostThreadStatus,
  threadToSummary,
  upsertConversation,
} from './host-data';
import { errorMessage } from './host-prompts';
import { CodexHostItemsController } from './host-items-controller';
import { appendCompactionMarker, ensureAssistantTurnMessage } from './host-message-state';
import { realtimeAudioChunk } from './host-realtime';
import type { ThreadRuntimePatch, ThreadRuntimeState } from './host-runtime';
import { threadSettingsSelection } from './host-settings';
import {
  sameValue,
  conversationTurn,
  turnError,
  timestampToIso,
  upsertConversationTurn,
} from './host-events';

type HostEventInput = CodexEvent extends infer Event
  ? Event extends CodexEvent
    ? Omit<Event, 'seq' | 'occurredAt' | 'origin'>
    : never
  : never;

export interface CodexHostNotificationsDependencies {
  clearPendingForThread(
    threadId: string,
    reason: string,
    eventReason: 'conversation_closed' | 'conversation_removed' | 'host_disconnected',
  ): void;
  createRuntime(threadId: string, patch?: ThreadRuntimePatch): ThreadRuntimeState;
  emitConversationActivity(threadId: string, origin: EventOrigin): void;
  emitConversationPermissions(threadId: string, origin: EventOrigin): void;
  emitConversationSettings(threadId: string, origin: EventOrigin): void;
  emitConversationSkills(threadId: string, origin: EventOrigin): void;
  emitEvent(origin: EventOrigin, input: HostEventInput): void;
  emitSummaryUpserted(
    summary: CodexConversationSummary,
    reason: Extract<CodexEvent, { type: 'conversation.summaryUpserted' }>['payload']['reason'],
    origin: EventOrigin,
  ): void;
  getState(): CodexSnapshot;
  markRuntimeTurnActive(runtime: ThreadRuntimeState, turnId: string): void;
  patch(patch: Partial<CodexSnapshot>): void;
  patchConversationStatus(
    threadId: string,
    status: CodexConversationSummary['status'],
    origin?: EventOrigin,
  ): void;
  patchConversationTurnCount(threadId: string, turnCount: number): void;
  patchRuntime(threadId: string, patch: ThreadRuntimePatch): void;
  removeThread(threadId: string, reason: 'archived' | 'deleted'): void;
  requireRuntime(threadId: string): ThreadRuntimeState;
  runtime(threadId: string): ThreadRuntimeState | undefined;
  runtimes(): Iterable<ThreadRuntimeState>;
  sendNextQueuedPrompt(threadId: string): void;
  snapshotForRuntime(runtime: ThreadRuntimeState): CodexSnapshot;
  unknownNotification(notification: ServerNotification): void;
}

export class CodexHostNotificationsController {
  constructor(
    private readonly authentication: CodexHostAuthenticationController,
    private readonly approvals: CodexHostApprovalsController,
    private readonly catalog: CodexHostCatalogController,
    private readonly clientRequests: CodexHostClientRequestsController,
    private readonly conversations: CodexHostConversationsController,
    private readonly items: CodexHostItemsController,
    private readonly host: CodexHostNotificationsDependencies,
  ) {}

  handle(notification: ServerNotification): void {
    switch (notification.method) {
      case 'thread/started': {
        this.host.createRuntime(notification.params.thread.id, {
          historyMode: notification.params.thread.historyMode ?? 'legacy',
          threadStatus: hostThreadStatus(notification.params.thread.status),
        });
        const summary = threadToSummary(notification.params.thread);
        this.host.patch({
          conversations: upsertConversation(this.host.getState().conversations, summary),
        });
        this.host.emitSummaryUpserted(summary, 'started', 'notification');
        this.host.emitConversationActivity(notification.params.thread.id, 'notification');
        return;
      }
      case 'thread/status/changed': {
        const { threadId, status } = notification.params;
        const runtime = this.host.requireRuntime(threadId);
        const systemError = status.type === 'systemError';
        // Idle establishes readiness, not the outcome of the previous turn.
        // Keep its last-known record until an authoritative terminal arrives.
        if (systemError || (status.type === 'idle' && !runtime.turnStartPending)) runtime.activeTurnId = null;
        this.host.patchRuntime(threadId, {
          threadStatus: hostThreadStatus(status),
          busy: systemError
            ? false
            : runtime.turnStartPending || status.type === 'active' || runtime.activeTurnId !== null,
          ...(systemError
            ? { turnStartPending: false, error: 'Codex app-server reported a system error' }
            : {}),
        });
        const state = this.host.getState();
        this.host.patch({
          conversations: state.conversations.map((conversation) => conversation.id === threadId
            ? { ...conversation, status: conversationStatus(status) }
            : conversation),
        });
        const summary = this.host.getState().conversations.find((conversation) => conversation.id === threadId);
        if (summary) this.host.emitSummaryUpserted(summary, 'updated', 'notification');
        this.host.emitConversationActivity(threadId, 'notification');
        if (status.type === 'idle') this.host.sendNextQueuedPrompt(threadId);
        return;
      }
      case 'thread/archived':
      case 'thread/deleted':
        this.host.removeThread(
          notification.params.threadId,
          notification.method === 'thread/archived' ? 'archived' : 'deleted',
        );
        return;
      case 'thread/unarchived':
        void this.conversations.load().catch((error) => {
          this.host.patch({ error: errorMessage(error) });
        });
        return;
      case 'thread/closed': {
        const runtime = this.host.runtime(notification.params.threadId);
        if (runtime) {
          runtime.activeTurnId = null;
          this.host.patchRuntime(notification.params.threadId, {
            busy: false,
            turnStartPending: false,
            threadStatus: { type: 'idle' },
          });
        }
        this.host.clearPendingForThread(notification.params.threadId, 'Codex thread closed', 'conversation_closed');
        this.host.patchConversationStatus(notification.params.threadId, 'idle');
        this.host.emitConversationActivity(notification.params.threadId, 'notification');
        return;
      }
      case 'skills/changed':
        this.catalog.invalidateSkills();
        return;
      case 'thread/name/updated': {
        const state = this.host.getState();
        const previous = state.conversations.find((conversation) => conversation.id === notification.params.threadId);
        const title = notification.params.threadName?.trim() || previous?.preview || 'Untitled conversation';
        if (previous?.title === title) return;
        this.host.patch({
          conversations: state.conversations.map((conversation) => conversation.id === notification.params.threadId
            ? { ...conversation, title }
            : conversation),
        });
        const summary = this.host.getState().conversations.find(
          (conversation) => conversation.id === notification.params.threadId,
        );
        if (summary) this.host.emitSummaryUpserted(summary, 'updated', 'notification');
        return;
      }
      case 'thread/settings/updated': {
        const runtime = this.host.requireRuntime(notification.params.threadId);
        const state = this.host.getState();
        const next = threadSettingsSelection(
          notification.params.threadSettings,
          state.models,
          this.host.snapshotForRuntime(runtime),
        );
        const changed = runtime.approvalPreset !== next.approvalPreset
          || runtime.selectedModelId !== next.selectedModelId
          || runtime.selectedReasoningEffort !== next.selectedReasoningEffort
          || runtime.selectedServiceTier !== next.selectedServiceTier
          || runtime.planMode !== next.planMode;
        this.host.patchRuntime(notification.params.threadId, next);
        if (changed) this.host.emitConversationSettings(notification.params.threadId, 'notification');
        return;
      }
      case 'thread/goal/updated': {
        const runtime = this.host.requireRuntime(notification.params.threadId);
        if (sameValue(runtime.goal, notification.params.goal)) return;
        this.host.patchRuntime(notification.params.threadId, { goal: { ...notification.params.goal } });
        this.host.emitEvent('notification', {
          type: 'conversation.goalChanged',
          conversationId: notification.params.threadId,
          ...(notification.params.turnId ? { turnId: notification.params.turnId } : {}),
          payload: { goal: structuredClone(notification.params.goal) },
        });
        return;
      }
      case 'thread/goal/cleared':
        if (this.host.requireRuntime(notification.params.threadId).goal === null) return;
        this.host.patchRuntime(notification.params.threadId, { goal: null });
        this.host.emitEvent('notification', {
          type: 'conversation.goalChanged',
          conversationId: notification.params.threadId,
          payload: { goal: null },
        });
        return;
      case 'thread/tokenUsage/updated': {
        const contextUsage = contextUsageFromTokens(notification.params.tokenUsage);
        this.host.patchRuntime(notification.params.threadId, { contextUsage });
        this.host.emitEvent('notification', {
          type: 'conversation.contextUsageChanged',
          conversationId: notification.params.threadId,
          turnId: notification.params.turnId,
          payload: { contextUsage: structuredClone(contextUsage) },
        });
        this.host.emitEvent('notification', {
          type: 'conversation.executionUsageChanged',
          conversationId: notification.params.threadId,
          turnId: notification.params.turnId,
          payload: { usage: {
            last: tokenUsage(notification.params.tokenUsage.last),
            total: tokenUsage(notification.params.tokenUsage.total),
            execution: null, model: null, observedStart: false,
          } },
        });
        return;
      }
      case 'model/rerouted':
        this.host.emitEvent('notification', {
          type: 'turn.modelRerouted', conversationId: notification.params.threadId,
          turnId: notification.params.turnId,
          payload: { fromModel: notification.params.fromModel, toModel: notification.params.toModel, reason: notification.params.reason },
        });
        return;
      case 'turn/started': {
        const runtime = this.host.requireRuntime(notification.params.threadId);
        const alreadyActive = runtime.activeTurnId === notification.params.turn.id;
        this.host.markRuntimeTurnActive(runtime, notification.params.turn.id);
        this.host.patchConversationTurnCount(notification.params.threadId, runtime.turnIds.length);
        this.host.patchRuntime(notification.params.threadId, {
          busy: true,
          turnStartPending: false,
          error: null,
          turnGitDiff: null,
          turns: upsertConversationTurn(runtime.turns, conversationTurn(notification.params.turn)),
          messages: ensureAssistantTurnMessage(
            runtime.messages,
            notification.params.threadId,
            notification.params.turn.id,
            { createdAt: timestampToIso(notification.params.turn.startedAt) },
          ),
        });
        this.host.patchConversationStatus(notification.params.threadId, 'active');
        if (!alreadyActive) {
          this.host.emitEvent('notification', {
            type: 'turn.started',
            conversationId: notification.params.threadId,
            turnId: notification.params.turn.id,
            payload: { startedAt: timestampToIso(notification.params.turn.startedAt) },
          });
        }
        this.host.emitConversationActivity(notification.params.threadId, 'notification');
        return;
      }
      case 'item/agentMessage/delta':
        this.items.applyAgentDelta(notification.params);
        return;
      case 'item/plan/delta':
        this.items.applyPlanDelta(notification.params);
        return;
      case 'item/started':
      case 'item/completed':
        this.items.applyItem(notification.params, notification.method === 'item/completed');
        return;
      case 'item/commandExecution/outputDelta':
        if (!this.items.isForwardingCommandOutput(notification.params.threadId, notification.params.itemId)) return;
        this.items.applyToolUpdate(
          notification.params.threadId,
          notification.params.turnId,
          commandOutputDeltaToToolPartUpdate(notification.params.itemId, notification.params.delta),
        );
        return;
      case 'item/fileChange/patchUpdated':
        this.items.applyToolUpdate(
          notification.params.threadId,
          notification.params.turnId,
          fileChangePatchToToolPartUpdate(notification.params.itemId, notification.params.changes),
        );
        return;
      case 'item/mcpToolCall/progress':
        this.items.applyToolUpdate(
          notification.params.threadId,
          notification.params.turnId,
          mcpProgressToToolPartUpdate(notification.params.itemId, notification.params.message),
        );
        return;
      case 'rawResponseItem/completed':
        this.items.applyRawResponseItem(notification.params);
        return;
      case 'turn/plan/updated':
        this.items.applyPlanUpdated(notification.params);
        return;
      case 'serverRequest/resolved': {
        const requestId = String(notification.params.requestId);
        this.clientRequests.handleServerResolved(requestId, notification.params.threadId);
        this.approvals.handleServerResolved(requestId);
        this.host.emitConversationActivity(notification.params.threadId, 'notification');
        return;
      }
      case 'turn/diff/updated': {
        const counts = lineDiffFromUnifiedDiff(notification.params.diff);
        this.host.patchRuntime(notification.params.threadId, {
          turnGitDiff: {
            turnId: notification.params.turnId,
            addedLines: counts.addedLines,
            removedLines: counts.removedLines,
            diff: notification.params.diff,
            updatedAt: new Date().toISOString(),
          },
        });
        this.host.emitEvent('notification', {
          type: 'conversation.diffUpdated',
          conversationId: notification.params.threadId,
          payload: { diff: structuredClone(this.host.requireRuntime(notification.params.threadId).turnGitDiff) },
        });
        return;
      }
      case 'thread/compacted': {
        const runtime = this.host.requireRuntime(notification.params.threadId);
        this.host.patchRuntime(notification.params.threadId, {
          messages: appendCompactionMarker(
            runtime.messages,
            notification.params.threadId,
            notification.params.turnId,
            'complete',
          ),
        });
        const message = this.host.requireRuntime(notification.params.threadId).messages.find((candidate) => (
          candidate.kind === 'compaction' && candidate.metadata?.turnId === notification.params.turnId
        ))!;
        this.host.emitEvent('notification', {
          type: 'context.compactionCompleted',
          conversationId: notification.params.threadId,
          turnId: notification.params.turnId,
          payload: { itemId: null, message: structuredClone(message) },
        });
        return;
      }
      case 'turn/completed':
        this.items.applyTurnCompleted(notification.params);
        return;
      case 'error': {
        const runtime = this.host.requireRuntime(notification.params.threadId);
        const terminalCurrentTurn = !notification.params.willRetry
          && runtime.activeTurnId === notification.params.turnId;
        if (terminalCurrentTurn) runtime.activeTurnId = null;
        this.host.patchRuntime(notification.params.threadId, {
          error: notification.params.error.message,
          turns: upsertConversationTurn(runtime.turns, {
            ...(runtime.turns.find((turn) => turn.id === notification.params.turnId) ?? {
              id: notification.params.turnId,
              status: 'inProgress' as const,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            }),
            status: notification.params.willRetry ? 'inProgress' : 'failed',
            error: turnError(notification.params.error),
            willRetry: notification.params.willRetry,
          }),
          ...(terminalCurrentTurn ? { busy: false, turnStartPending: false } : {}),
        });
        if (terminalCurrentTurn) this.host.patchConversationStatus(notification.params.threadId, 'error');
        this.host.emitEvent('notification', {
          type: 'turn.error',
          conversationId: notification.params.threadId,
          turnId: notification.params.turnId,
          payload: {
            error: turnError(notification.params.error)!,
            willRetry: notification.params.willRetry,
          },
        });
        this.host.emitConversationActivity(notification.params.threadId, 'notification');
        return;
      }
      case 'account/rateLimits/updated': {
        const state = this.host.getState();
        this.host.patch({ rateLimits: mergeHostRateLimits(state.rateLimits, notification.params.rateLimits) });
        this.host.emitEvent('notification', {
          type: 'rateLimits.changed',
          payload: { rateLimits: structuredClone(this.host.getState().rateLimits) },
        });
        return;
      }
      case 'account/updated':
        void this.authentication.refresh('notification').catch((error) => this.host.patch({ error: errorMessage(error) }));
        return;
      case 'account/login/completed':
        this.authentication.handleLoginCompleted(notification.params);
        return;
      case 'thread/realtime/started':
        this.host.emitEvent('notification', {
          type: 'realtime.started',
          conversationId: notification.params.threadId,
          payload: {
            realtimeSessionId: notification.params.realtimeSessionId,
            version: notification.params.version,
          },
        });
        return;
      case 'thread/realtime/itemAdded':
        this.host.emitEvent('notification', {
          type: 'realtime.itemAdded',
          conversationId: notification.params.threadId,
          payload: { item: structuredClone(notification.params.item) as JsonValue },
        });
        return;
      case 'thread/realtime/item/started':
      case 'thread/realtime/item/completed':
        this.host.emitEvent('notification', {
          type: notification.method === 'thread/realtime/item/started'
            ? 'realtime.itemStarted' : 'realtime.itemCompleted',
          conversationId: notification.params.threadId,
          payload: { item: structuredClone(notification.params.item) as JsonValue },
        });
        return;
      case 'thread/realtime/item/transcript/delta':
        this.host.emitEvent('notification', {
          type: 'realtime.itemTranscriptDelta',
          conversationId: notification.params.threadId,
          payload: { itemId: notification.params.itemId, delta: notification.params.delta },
        });
        return;
      case 'thread/realtime/transcript/delta':
        this.host.emitEvent('notification', {
          type: 'realtime.transcriptDelta',
          conversationId: notification.params.threadId,
          payload: { role: notification.params.role, delta: notification.params.delta },
        });
        return;
      case 'thread/realtime/transcript/done':
        this.host.emitEvent('notification', {
          type: 'realtime.transcriptCompleted',
          conversationId: notification.params.threadId,
          payload: { role: notification.params.role, text: notification.params.text },
        });
        return;
      case 'thread/realtime/outputAudio/delta':
        this.host.emitEvent('notification', {
          type: 'realtime.audioDelta',
          conversationId: notification.params.threadId,
          payload: { audio: realtimeAudioChunk(notification.params.audio) },
        });
        return;
      case 'thread/realtime/sdp':
        this.host.emitEvent('notification', {
          type: 'realtime.sdp',
          conversationId: notification.params.threadId,
          payload: { sdp: notification.params.sdp },
        });
        return;
      case 'thread/realtime/error':
        this.host.emitEvent('notification', {
          type: 'realtime.error',
          conversationId: notification.params.threadId,
          payload: { message: notification.params.message },
        });
        return;
      case 'thread/realtime/closed':
        this.host.emitEvent('notification', {
          type: 'realtime.closed',
          conversationId: notification.params.threadId,
          payload: { reason: notification.params.reason },
        });
        return;
      case 'hook/started':
      case 'hook/completed':
      case 'item/autoApprovalReview/started':
      case 'item/autoApprovalReview/completed':
      case 'command/exec/outputDelta':
      case 'process/outputDelta':
      case 'process/exited':
      case 'item/commandExecution/terminalInteraction':
      case 'item/fileChange/outputDelta':
      case 'mcpServer/oauthLogin/completed':
      case 'mcpServer/startupStatus/updated':
      case 'app/list/updated':
      case 'externalAgentConfig/import/progress':
      case 'externalAgentConfig/import/completed':
      case 'fs/changed':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded':
      case 'item/reasoning/textDelta':
      case 'model/verification':
      case 'turn/moderationMetadata':
      case 'model/safetyBuffering/updated':
      case 'warning':
      case 'guardianWarning':
      case 'deprecationNotice':
      case 'configWarning':
      case 'fuzzyFileSearch/sessionUpdated':
      case 'fuzzyFileSearch/sessionCompleted':
      case 'windows/worldWritableWarning':
      case 'windowsSandbox/setupCompleted':
        return;
      case 'remoteControl/status/changed':
        this.host.emitEvent('notification', {
          type: 'remoteControl.statusChanged',
          payload: {
            status: {
              status: notification.params.status,
              serverName: notification.params.serverName,
              installationId: notification.params.installationId,
              environmentId: notification.params.environmentId,
            },
          },
        });
        return;
      default:
        return this.host.unknownNotification(notification);
    }
  }
}
