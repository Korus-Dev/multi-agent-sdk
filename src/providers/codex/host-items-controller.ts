import type { v2 } from '@korus-dev/codex-sdk';
import type { EventOrigin, ConversationMessage, ConversationMessageTextPart, ConversationMessageToolPart, ConversationMessageToolPartUpdate } from '../../core/codex-host';
import type { CodexConversationSummary, CodexSnapshot } from '../../core/codex-conversation-types';
import {
  codexItemToMediaParts,
  codexItemToQuestionPart,
  codexItemToConversationMessage,
  codexItemToToolPart,
} from './codex-conversation-history';
import { rawResponseItemToEvent } from './codex-raw-response-item-adapter';
import type { HostEventInput } from './host-events';
import {
  conversationTurn,
  turnError,
  threadItemKey,
  timestampToIsoOrNull,
  upsertConversationTurn,
} from './host-events';
import {
  appendAssistantTextDelta,
  assistantMessageContainingText,
  appendCompactionMarker,
  ensureAssistantTurnMessage,
  extractProposedPlanDocument,
  finalizeTurnToolParts,
  formatPlanMarkdown,
  planProgressToolPart,
  removeAssistantText,
  conversationMediaPartsEqual,
  updateAssistantToolPart,
  upsertAssistantMediaPart,
  upsertAssistantQuestionPart,
  upsertAssistantReasoningSummaries,
  upsertAssistantText,
  upsertAssistantToolPart,
} from './host-message-state';
import type { ThreadRuntimePatch, ThreadRuntimeState } from './host-runtime';
import { hostSubagentToolCall } from './host-subagents';
import {
  codexToolPartFileActivities,
  shouldForwardCommandExecutionOutput,
} from './codex-tool-part-adapter';

export type CodexHostItemsDependencies = {
  assistantMessageForTurn(threadId: string, turnId: string): ConversationMessage | null;
  emitConversationActivity(threadId: string, origin: EventOrigin): void;
  emitEvent(origin: EventOrigin, input: HostEventInput): void;
  emitSummaryUpserted(
    summary: CodexConversationSummary,
    reason: 'started' | 'listed' | 'resumed' | 'created' | 'updated',
    origin: EventOrigin,
  ): void;
  getState(): CodexSnapshot;
  markRuntimeTurnActive(runtime: ThreadRuntimeState, turnId: string): void;
  messageContainingTool(threadId: string, turnId: string, itemId: string): ConversationMessage | null;
  patch(patch: Partial<CodexSnapshot>): void;
  patchRuntime(threadId: string, patch: ThreadRuntimePatch): void;
  requireRuntime(threadId: string): ThreadRuntimeState;
  sendNextQueuedPrompt(threadId: string): void;
};

export class CodexHostItemsController {
  private readonly commandOutputForwardItemIds = new Set<string>();
  private readonly fileActivityKeys = new Set<string>();
  // app-server emits exitedReviewMode first, followed by a final agentMessage
  // rendered from the same ReviewOutputEvent. Full history retains only the
  // review-mode item, so it is the canonical host representation.
  private readonly reviewOutputByTurn = new Map<string, string>();

  constructor(private readonly host: CodexHostItemsDependencies) {}

  reset(): void {
    this.commandOutputForwardItemIds.clear();
    this.fileActivityKeys.clear();
    this.reviewOutputByTurn.clear();
  }

  forget(threadId: string): void {
    const prefix = `${threadId}\u0000`;
    for (const key of this.commandOutputForwardItemIds) {
      if (key.startsWith(prefix)) this.commandOutputForwardItemIds.delete(key);
    }
    for (const key of this.fileActivityKeys) {
      if (key.startsWith(prefix)) this.fileActivityKeys.delete(key);
    }
    for (const key of this.reviewOutputByTurn.keys()) {
      if (key.startsWith(prefix)) this.reviewOutputByTurn.delete(key);
    }
  }

  isForwardingCommandOutput(threadId: string, itemId: string): boolean {
    return this.commandOutputForwardItemIds.has(threadItemKey(threadId, itemId));
  }

  applyAgentDelta(params: v2.AgentMessageDeltaNotification): void {
    const runtime = this.host.requireRuntime(params.threadId);
    this.host.markRuntimeTurnActive(runtime, params.turnId);
    const phase = assistantMessageContainingText(runtime.messages, params.turnId, params.itemId)?.parts
      .find((part): part is ConversationMessageTextPart => (
        part.type === 'text' && part.itemId === params.itemId
      ))?.phase;
    this.host.patchRuntime(params.threadId, {
      messages: appendAssistantTextDelta(
        runtime.messages, params.threadId, params.turnId, params.itemId, params.delta, phase,
      ),
    });
    const message = assistantMessageContainingText(runtime.messages, params.turnId, params.itemId)
      ?? this.host.assistantMessageForTurn(params.threadId, params.turnId);
    if (message) {
      this.host.emitEvent('notification', {
        type: 'message.delta', conversationId: params.threadId, turnId: params.turnId,
        payload: {
          messageId: message.id,
          itemId: params.itemId,
          delta: params.delta,
          ...(phase ? { phase } : {}),
        },
      });
    }
  }

  applyPlanDelta(params: v2.PlanDeltaNotification): void {
    const runtime = this.host.requireRuntime(params.threadId);
    this.host.markRuntimeTurnActive(runtime, params.turnId);
    const markdown = `${runtime.planMarkdownByTurn.get(params.turnId) ?? ''}${params.delta}`;
    runtime.planMarkdownByTurn.set(params.turnId, markdown);
    this.host.patchRuntime(params.threadId, {
      messages: upsertAssistantToolPart(
        runtime.messages, params.threadId, params.turnId,
        planProgressToolPart(params.turnId, markdown, 'running'),
      ),
    });
    this.host.emitEvent('notification', {
      type: 'plan.delta', conversationId: params.threadId, turnId: params.turnId,
      payload: { itemId: params.itemId, delta: params.delta, markdown },
    });
  }

  applyPlanUpdated(params: v2.TurnPlanUpdatedNotification): void {
    const runtime = this.host.requireRuntime(params.threadId);
    this.host.markRuntimeTurnActive(runtime, params.turnId);
    const markdown = formatPlanMarkdown(params.explanation, params.plan);
    const updatedAt = new Date().toISOString();
    runtime.planMarkdownByTurn.set(params.turnId, markdown);
    this.host.patchRuntime(params.threadId, {
      executionPlan: {
        turnId: params.turnId,
        explanation: params.explanation,
        steps: structuredClone(params.plan),
        markdown,
        updatedAt,
      },
      messages: upsertAssistantToolPart(
        runtime.messages, params.threadId, params.turnId,
        planProgressToolPart(params.turnId, markdown, 'completed'),
      ),
    });
    this.host.emitEvent('notification', {
      type: 'plan.updated', conversationId: params.threadId, turnId: params.turnId,
      payload: {
        explanation: params.explanation,
        steps: structuredClone(params.plan),
        markdown,
        status: 'completed',
      },
    });
  }

  applyRawResponseItem(params: v2.RawResponseItemCompletedNotification): void {
    const runtime = this.host.requireRuntime(params.threadId);
    this.host.markRuntimeTurnActive(runtime, params.turnId);
    const event = rawResponseItemToEvent(params.item);
    if (!event) return;
    if (event.type === 'item.updated') {
      this.applyToolUpdate(params.threadId, params.turnId, event.payload);
      return;
    }
    this.host.patchRuntime(params.threadId, {
      messages: upsertAssistantToolPart(
        runtime.messages, params.threadId, params.turnId, event.payload.toolPart,
      ),
    });
    const message = this.host.messageContainingTool(
      params.threadId, params.turnId, event.payload.toolPart.id,
    );
    if (message) {
      this.host.emitEvent('notification', {
        type: event.type === 'item.completed' ? 'tool.completed' : 'tool.started',
        conversationId: params.threadId,
        turnId: params.turnId,
        payload: { messageId: message.id, toolPart: structuredClone(event.payload.toolPart) },
      });
      this.emitFileActivities(
        params.threadId,
        params.turnId,
        message.id,
        event.payload.toolPart.id,
        event.payload.toolPart,
        runtime.cwd,
      );
    }
  }

  applyItem(params: v2.ItemStartedNotification | v2.ItemCompletedNotification, completed: boolean): void {
    const runtime = this.host.requireRuntime(params.threadId);
    const turnStartPending = runtime.turnStartPending;
    if (!completed) this.host.markRuntimeTurnActive(runtime, params.turnId);
    const turn = {
      id: params.turnId,
      status: completed ? 'completed' : 'inProgress',
      startedAt: ('startedAtMs' in params ? params.startedAtMs : params.completedAtMs) / 1000,
    } as const;

    if (params.item.type === 'userMessage') {
      const message = codexItemToConversationMessage(params.threadId, turn, params.item);
      if (!message || runtime.messages.some((candidate) => candidate.id === message.id)) return;
      const isSteer = runtime.messages.some((candidate) => (
        candidate.role === 'assistant'
        && candidate.metadata?.turnId === params.turnId
        && candidate.parts.length > 0
      ));
      const pendingOptimisticIndex = !isSteer && turnStartPending
        ? runtime.messages.map((candidate) => (
          candidate.role === 'user'
          && candidate.kind !== 'steer'
          && !candidate.turnId
          && JSON.stringify(candidate.parts) === JSON.stringify(message.parts)
        )).lastIndexOf(true)
        : -1;
      if (pendingOptimisticIndex >= 0) {
        const pending = runtime.messages[pendingOptimisticIndex]!;
        const reconciled = {
          ...message,
          id: pending.id,
          createdAt: pending.createdAt ?? message.createdAt,
          metadata: { ...pending.metadata, ...message.metadata },
        };
        const messages = [...runtime.messages];
        messages.splice(pendingOptimisticIndex, 1, reconciled);
        this.host.patchRuntime(params.threadId, { messages });
        this.host.emitEvent('notification', {
          type: 'message.updated', conversationId: params.threadId, turnId: params.turnId,
          payload: { message: structuredClone(reconciled) },
        });
        return;
      }
      const duplicateInitialMessage = !isSteer && runtime.messages.some((candidate) => (
        candidate.role === 'user'
        && candidate.turnId === params.turnId
        && candidate.kind !== 'steer'
        && JSON.stringify(candidate.parts) === JSON.stringify(message.parts)
      ));
      if (duplicateInitialMessage) return;
      const appended = isSteer ? { ...message, kind: 'steer' as const } : message;
      const messages = [...runtime.messages, appended];
      this.host.patchRuntime(params.threadId, {
        messages: isSteer
          ? ensureAssistantTurnMessage(messages, params.threadId, params.turnId, { forceSegment: true })
          : messages,
      });
      this.host.emitEvent('notification', {
        type: 'message.appended', conversationId: params.threadId, turnId: params.turnId,
        payload: { message: structuredClone(appended) },
      });
      return;
    }

    if (params.item.type === 'reasoning') {
      const previousMessage = this.host.assistantMessageForTurn(params.threadId, params.turnId);
      const previousParts = previousMessage ? JSON.stringify(previousMessage.parts) : null;
      this.host.patchRuntime(params.threadId, {
        messages: upsertAssistantReasoningSummaries(
          runtime.messages,
          params.threadId,
          params.turnId,
          params.item.id,
          params.item.summary,
        ),
      });
      const message = this.host.assistantMessageForTurn(params.threadId, params.turnId);
      if (!message || JSON.stringify(message.parts) === previousParts) return;
      this.host.emitEvent('notification', {
        type: previousMessage ? 'message.updated' : 'message.appended',
        conversationId: params.threadId,
        turnId: params.turnId,
        payload: { message: structuredClone(message) },
      });
      return;
    }

    if (
      params.item.type === 'agentMessage'
      && completed
      && runtime.planMode
      && params.item.phase === 'final_answer'
    ) {
      const proposedPlan = extractProposedPlanDocument(params.item.text);
      if (proposedPlan) {
        const previousMessage = this.host.assistantMessageForTurn(params.threadId, params.turnId);
        let messages = removeAssistantText(
          runtime.messages, params.threadId, params.turnId, params.item.id,
        );
        if (proposedPlan.visibleText) {
          messages = upsertAssistantText(
            messages, params.threadId, params.turnId, params.item.id,
            proposedPlan.visibleText, params.item.phase,
          );
        }
        messages = upsertAssistantToolPart(
          messages, params.threadId, params.turnId,
          planProgressToolPart(params.turnId, proposedPlan.markdown, 'completed'),
        );
        runtime.planMarkdownByTurn.set(params.turnId, proposedPlan.markdown);
        this.host.patchRuntime(params.threadId, { messages });
        const message = this.host.assistantMessageForTurn(params.threadId, params.turnId);
        if (message) {
          this.host.emitEvent('notification', {
            type: previousMessage ? 'message.updated' : 'message.appended',
            conversationId: params.threadId,
            turnId: params.turnId,
            payload: { message: structuredClone(message) },
          });
        }
        this.host.emitEvent('notification', {
          type: 'plan.completed', conversationId: params.threadId, turnId: params.turnId,
          payload: { itemId: params.item.id, markdown: proposedPlan.markdown },
        });
        return;
      }
    }

    if (params.item.type === 'agentMessage' || params.item.type === 'exitedReviewMode') {
      const text = params.item.type === 'agentMessage' ? params.item.text : params.item.review;
      const phase = params.item.type === 'agentMessage' ? params.item.phase ?? undefined : undefined;
      if (!text && params.item.type !== 'agentMessage') return;
      const reviewTurnKey = threadItemKey(params.threadId, params.turnId);
      if (
        params.item.type === 'agentMessage'
        && this.reviewOutputByTurn.get(reviewTurnKey) === text
      ) return;
      if (params.item.type === 'exitedReviewMode') {
        this.reviewOutputByTurn.set(reviewTurnKey, text);
      }
      const previousMessageIds = new Set(runtime.messages.map((message) => message.id));
      const previousMessage = assistantMessageContainingText(runtime.messages, params.turnId, params.item.id)
        ?? this.host.assistantMessageForTurn(params.threadId, params.turnId);
      const previousParts = previousMessage ? JSON.stringify(previousMessage.parts) : null;
      const previousQuestionRequestIds = new Set(previousMessage?.parts.flatMap((part) => (
        part.type === 'question' ? [part.request.id] : []
      )) ?? []);
      const previousText = previousMessage?.parts
        .find((part): part is Extract<ConversationMessage['parts'][number], { type: 'text' }> => (
          part.type === 'text' && part.itemId === params.item.id
        ))?.text ?? '';
      const questionPart = params.item.type === 'agentMessage'
        ? codexItemToQuestionPart(params.threadId, params.turnId, params.item)
        : null;
      const visibleText = questionPart ? '' : text;
      let messages = questionPart
        ? removeAssistantText(runtime.messages, params.threadId, params.turnId, params.item.id)
        : upsertAssistantText(runtime.messages, params.threadId, params.turnId, params.item.id, text, phase);
      if (questionPart) {
        messages = upsertAssistantQuestionPart(
          messages, params.threadId, params.turnId, questionPart,
        );
      }
      this.host.patchRuntime(params.threadId, { messages });
      if (!visibleText && !questionPart && !phase) return;
      const message = (questionPart ? undefined : assistantMessageContainingText(runtime.messages, params.turnId, params.item.id))
        ?? this.host.assistantMessageForTurn(params.threadId, params.turnId);
      if (message && !previousMessageIds.has(message.id)) {
        this.host.emitEvent('notification', {
          type: 'message.appended', conversationId: params.threadId, turnId: params.turnId,
          payload: { message: structuredClone(message) },
        });
      } else if (message && JSON.stringify(message.parts) !== previousParts && (questionPart || visibleText === previousText)) {
        this.host.emitEvent('notification', {
          type: 'message.updated', conversationId: params.threadId, turnId: params.turnId,
          payload: { message: structuredClone(message) },
        });
      } else if (message && visibleText !== previousText) {
        if (visibleText.startsWith(previousText)) {
          const delta = visibleText.slice(previousText.length);
          if (delta) this.host.emitEvent('notification', {
            type: 'message.delta', conversationId: params.threadId, turnId: params.turnId,
            payload: {
              messageId: message.id,
              itemId: params.item.id,
              delta,
              ...(phase ? { phase } : {}),
            },
          });
        } else {
          this.host.emitEvent('notification', {
            type: 'message.updated', conversationId: params.threadId, turnId: params.turnId,
            payload: { message: structuredClone(message) },
          });
        }
      }
      if (questionPart && !previousQuestionRequestIds.has(questionPart.request.id)) {
        this.host.emitEvent('notification', {
          type: 'clientRequest.requested',
          conversationId: params.threadId,
          turnId: params.turnId,
          payload: { request: structuredClone(questionPart.request) },
        });
      }
      return;
    }

    if (params.item.type === 'plan') {
      if (!completed) return;
      const markdown = params.item.text.trim() || runtime.planMarkdownByTurn.get(params.turnId) || '';
      runtime.planMarkdownByTurn.set(params.turnId, markdown);
      this.host.patchRuntime(params.threadId, {
        messages: upsertAssistantToolPart(
          runtime.messages, params.threadId, params.turnId,
          planProgressToolPart(params.turnId, markdown, 'completed'),
        ),
      });
      this.host.emitEvent('notification', {
        type: 'plan.completed', conversationId: params.threadId, turnId: params.turnId,
        payload: { itemId: params.item.id, markdown },
      });
      return;
    }

    if (params.item.type === 'contextCompaction') {
      this.host.patchRuntime(params.threadId, {
        messages: appendCompactionMarker(runtime.messages, params.threadId, params.turnId, completed ? 'complete' : 'streaming'),
      });
      if (completed) {
        const message = this.host.requireRuntime(params.threadId).messages.find((candidate) => (
          candidate.kind === 'compaction' && candidate.metadata?.turnId === params.turnId
        ));
        if (message) this.host.emitEvent('notification', {
          type: 'context.compactionCompleted', conversationId: params.threadId, turnId: params.turnId,
          payload: { itemId: params.item.id, message: structuredClone(message) },
        });
      } else {
        this.host.emitEvent('notification', {
          type: 'context.compactionStarted', conversationId: params.threadId, turnId: params.turnId,
          payload: { itemId: params.item.id },
        });
      }
      return;
    }

    if (params.item.type === 'collabAgentToolCall') {
      this.host.emitEvent('notification', {
        type: 'subagent.toolCallChanged',
        conversationId: params.threadId,
        turnId: params.turnId,
        payload: {
          lifecycle: completed ? 'completed' : 'started',
          toolCall: hostSubagentToolCall(params.item),
        },
      });
      return;
    }

    if (params.item.type === 'subAgentActivity') {
      this.host.emitEvent('notification', {
        type: 'subagent.activity',
        conversationId: params.threadId,
        turnId: params.turnId,
        payload: {
          lifecycle: completed ? 'completed' : 'started',
          activity: {
            id: params.item.id,
            kind: params.item.kind,
            agentConversationId: params.item.agentThreadId,
            agentPath: params.item.agentPath,
          },
        },
      });
      return;
    }

    const includeCommandOutput = this.shouldForwardCommandOutput(params.threadId, completed, params.item);
    const toolPart = codexItemToToolPart(params.item, { includeCommandOutput, cwd: runtime.cwd });
    const mediaParts = codexItemToMediaParts(params.item);
    if (!toolPart && !mediaParts.length) return;
    const mediaChanged = mediaParts.some(mediaPart => !runtime.messages.some((message) => (
      message.parts.some((part) => part.type === 'media' && conversationMediaPartsEqual(part, mediaPart))
    )));
    let messages = toolPart
      ? upsertAssistantToolPart(runtime.messages, params.threadId, params.turnId, toolPart)
      : [...runtime.messages];
    for (const mediaPart of mediaParts) messages = upsertAssistantMediaPart(messages, params.threadId, params.turnId, mediaPart, params.item.id);
    this.host.patchRuntime(params.threadId, { messages });
    const message = toolPart
      ? this.host.messageContainingTool(params.threadId, params.turnId, toolPart.id)
      : this.host.assistantMessageForTurn(params.threadId, params.turnId);
    if (message && toolPart) this.host.emitEvent('notification', {
      type: completed ? 'tool.completed' : 'tool.started',
      conversationId: params.threadId,
      turnId: params.turnId,
      payload: { messageId: message.id, toolPart: structuredClone(toolPart) },
    });
    if (message && toolPart) {
      this.emitFileActivities(
        params.threadId,
        params.turnId,
        message.id,
        toolPart.id,
        toolPart,
        runtime.cwd,
      );
    }
    if (message && mediaChanged) this.host.emitEvent('notification', {
      type: 'message.updated', conversationId: params.threadId, turnId: params.turnId,
      payload: { message: structuredClone(message) },
    });
  }

  shouldForwardCommandOutput(threadId: string, completed: boolean, item: v2.ThreadItem): boolean {
    const itemId = 'id' in item && typeof item.id === 'string' ? item.id : null;
    if (!itemId) return false;
    const key = threadItemKey(threadId, itemId);
    if (!completed) {
      const shouldForward = shouldForwardCommandExecutionOutput(item);
      if (shouldForward) this.commandOutputForwardItemIds.add(key);
      else this.commandOutputForwardItemIds.delete(key);
      return shouldForward;
    }
    const shouldForward = this.commandOutputForwardItemIds.has(key)
      || shouldForwardCommandExecutionOutput(item);
    this.commandOutputForwardItemIds.delete(key);
    return shouldForward;
  }

  applyToolUpdate(threadId: string, turnId: string, update: ConversationMessageToolPartUpdate): void {
    const runtime = this.host.requireRuntime(threadId);
    this.host.markRuntimeTurnActive(runtime, turnId);
    const effectiveUpdate = runtime.cwd && hasFileChangeData(update)
      ? { ...update, metadata: { ...update.metadata, cwd: runtime.cwd } }
      : update;
    this.host.patchRuntime(threadId, {
      messages: updateAssistantToolPart(runtime.messages, threadId, turnId, effectiveUpdate),
    });
    const message = this.host.messageContainingTool(threadId, turnId, update.itemId);
    if (message) this.host.emitEvent('notification', {
      type: 'tool.updated', conversationId: threadId, turnId,
      payload: { messageId: message.id, update: structuredClone(effectiveUpdate) },
    });
    const toolPart = message?.parts.find((part): part is ConversationMessageToolPart => (
      part.type === 'tool' && part.id === update.itemId
    ));
    if (message && toolPart) {
      this.emitFileActivities(threadId, turnId, message.id, toolPart.id, toolPart, runtime.cwd);
    }
  }

  private emitFileActivities(
    threadId: string,
    turnId: string,
    messageId: string,
    itemId: string,
    toolPart: ConversationMessageToolPart,
    cwd: string | null,
  ): void {
    for (const activity of codexToolPartFileActivities(toolPart, cwd)) {
      const key = `${threadId}\u0000${itemId}\u0000${activity.action}\u0000${activity.path}\u0000${activity.status}`;
      if (this.fileActivityKeys.has(key)) continue;
      this.fileActivityKeys.add(key);
      this.host.emitEvent('notification', {
        type: 'file.activity',
        conversationId: threadId,
        turnId,
        payload: {
          messageId,
          itemId,
          path: activity.path,
          action: activity.action,
          status: activity.status,
        },
      });
    }
  }

  applyTurnCompleted(params: v2.TurnCompletedNotification): void {
    const runtime = this.host.requireRuntime(params.threadId);
    if (!runtime.turnIds.includes(params.turn.id)) runtime.turnIds.push(params.turn.id);
    const turnStartPending = runtime.activeTurnId !== params.turn.id && runtime.turnStartPending;
    if (runtime.activeTurnId === params.turn.id) runtime.activeTurnId = null;
    const busy = turnStartPending || runtime.activeTurnId !== null;
    const status: ConversationMessage['status'] = params.turn.status === 'failed' ? 'error' : 'complete';
    const messages = finalizeTurnToolParts(runtime.messages, params.turn.id, params.turn.status)
      .map((message) => message.metadata?.turnId === params.turn.id ? { ...message, status } : message)
      .filter((message) => !(
        message.role === 'assistant' && message.metadata?.turnId === params.turn.id
        && message.kind === undefined && message.parts.length === 0
      ));
    this.host.patchRuntime(params.threadId, {
      busy,
      ...(!busy ? { threadStatus: { type: 'idle' as const }, error: params.turn.error?.message ?? null } : {}),
      turnStartPending,
      messages,
      turns: upsertConversationTurn(runtime.turns, conversationTurn(params.turn)),
    });
    this.host.patch({
      conversations: this.host.getState().conversations.map((conversation) => conversation.id === params.threadId
        ? {
          ...conversation,
          status: busy ? 'active' : params.turn.status === 'failed' ? 'error' : 'idle',
          turnCount: runtime.turnIds.length,
          updatedAt: new Date().toISOString(),
        }
        : conversation),
    });
    const summary = this.host.getState().conversations.find((conversation) => conversation.id === params.threadId);
    if (summary) this.host.emitSummaryUpserted(summary, 'updated', 'notification');
    this.host.emitEvent('notification', {
      type: 'turn.completed', conversationId: params.threadId, turnId: params.turn.id,
      payload: {
        status: params.turn.status,
        error: turnError(params.turn.error),
        willRetry: false,
        startedAt: timestampToIsoOrNull(params.turn.startedAt),
        completedAt: timestampToIsoOrNull(params.turn.completedAt),
        durationMs: params.turn.durationMs ?? null,
      },
    });
    this.host.emitConversationActivity(params.threadId, 'notification');
    runtime.planMarkdownByTurn.delete(params.turn.id);
    this.host.sendNextQueuedPrompt(params.threadId);
  }
}

function hasFileChangeData(update: ConversationMessageToolPartUpdate): boolean {
  if (update.fallbackToolPart?.kind === 'fileChange') return true;
  const input = update.input;
  const metadata = update.metadata;
  return (isRecord(input) && Array.isArray(input.changes))
    || (isRecord(metadata) && Array.isArray(metadata.changes));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
