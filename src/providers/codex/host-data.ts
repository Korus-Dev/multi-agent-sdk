import { basename, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { fileAttachmentInput } from './codex-file-attachment';
import type { v2 } from '@korus-dev/codex-sdk';
import type { Attachment, AgentContextUsage, SendMessageOptions, ConversationMessage, ConversationMessageAttachmentPart } from '../../core/codex-host';
import type { CodexConversationSummary, CodexRateLimitSnapshot, CodexRateLimits, CodexSnapshot, CodexThreadStatus } from '../../core/codex-conversation-types';
import {
  requireCatalogModel,
  selectedModel,
  validateReasoningEffort,
  validateServiceTier,
} from './host-settings';

export function threadToSummary(thread: v2.Thread): CodexConversationSummary {
  const preview = thread.preview.trim();
  const firstPreviewLine = preview.split('\n')[0]!;
  return {
    id: thread.id,
    ...(thread.sessionId ? { sessionId: thread.sessionId } : {}),
    ...(thread.parentThreadId ? { parentConversationId: thread.parentThreadId } : {}),
    ...(thread.agentNickname ? { agentNickname: thread.agentNickname } : {}),
    ...(thread.agentRole ? { agentRole: thread.agentRole } : {}),
    title: thread.name?.trim() || firstPreviewLine.trim() || 'Untitled conversation',
    preview,
    cwd: thread.cwd,
    status: thread.status.type === 'active' ? 'active' : thread.status.type === 'systemError' ? 'error' : 'idle',
    turnCount: thread.turns.length,
    createdAt: new Date(thread.createdAt * 1000).toISOString(),
    updatedAt: new Date((thread.recencyAt ?? thread.updatedAt) * 1000).toISOString(),
  };
}

/**
 * Reuses previous items that a refresh left unchanged, and the previous list
 * itself when nothing changed, so state patches carry only real changes.
 */
export function reuseUnchangedItems<Item extends { id: string }>(previous: Item[], next: Item[]): Item[] {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const merged = next.map((item) => {
    const existing = previousById.get(item.id);
    return existing && isDeepStrictEqual(existing, item) ? existing : item;
  });
  return merged.length === previous.length && merged.every((item, index) => item === previous[index])
    ? previous
    : merged;
}

export function upsertConversation(
  conversations: CodexConversationSummary[],
  next: CodexConversationSummary,
): CodexConversationSummary[] {
  return [next, ...conversations.filter((conversation) => conversation.id !== next.id)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function validatedSendOptions(
  state: CodexSnapshot,
  options: SendMessageOptions,
): SendMessageOptions {
  const model = options.model
    ? requireCatalogModel(state.models, options.model)
    : selectedModel(state.models, state.selectedModelId);
  validateReasoningEffort(model, options.reasoningEffort);
  validateServiceTier(model, options.serviceTier);
  return {
    ...options,
    ...(options.attachments ? { attachments: validateAttachments(options.attachments) } : {}),
    ...(options.model && model ? { model: model.model } : {}),
  };
}

export function validateAttachments(attachments: readonly Attachment[]): Attachment[] {
  return attachments.map((attachment) => {
    const path = attachment.path.trim();
    if (!path) throw new Error('Attachment paths cannot be empty');
    if (!isAbsolute(path)) throw new Error(`Attachment path must be absolute: '${path}'`);
    if (attachment.type === 'image') return { ...attachment, path };
    const name = attachment.name?.trim();
    return { ...attachment, path, ...(name ? { name } : {}) };
  });
}

export function attachmentInput(attachment: Attachment): v2.UserInput {
  if (attachment.type === 'image') {
    return {
      type: 'localImage',
      path: attachment.path,
      ...(attachment.detail === undefined ? {} : { detail: attachment.detail }),
    };
  }
  return fileAttachmentInput(attachment.name ?? basename(attachment.path), attachment.path);
}

export function conversationAttachmentPart(attachment: Attachment): ConversationMessageAttachmentPart {
  const name = attachment.name?.trim() || basename(attachment.path);
  if (attachment.type === 'image') {
    return {
      type: 'attachment',
      attachment: {
        kind: 'image',
        name,
        path: attachment.path,
        url: attachment.previewUrl ?? pathToFileURL(attachment.path).href,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      },
    };
  }
  return {
    type: 'attachment',
    attachment: {
      kind: 'file',
      name,
      path: attachment.path,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    },
  };
}

export function messageTurnIdOrNull(message: ConversationMessage): string | null {
  const metadataTurnId = message.metadata?.turnId;
  return message.turnId ?? (typeof metadataTurnId === 'string' ? metadataTurnId : null);
}

export function messageTurnId(message: ConversationMessage): string {
  const turnId = messageTurnIdOrNull(message);
  if (!turnId) throw new Error('This message is not associated with a Codex turn');
  return turnId;
}

export function conversationMessageText(message: ConversationMessage): string {
  return message.parts
    .filter((part): part is Extract<ConversationMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function conversationMessageAttachments(message: ConversationMessage): Attachment[] {
  return message.parts.flatMap((part): Attachment[] => {
    if (part.type !== 'attachment') return [];
    const attachment = part.attachment;
    const attachmentPath = attachment.path;
    if (!attachmentPath) return [];
    if (attachment.kind === 'image') {
      return [{
        type: 'image',
        path: attachmentPath,
        name: attachment.name,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.url?.startsWith('data:image/') ? { previewUrl: attachment.url } : {}),
      }];
    }
    return [{
      type: 'file',
      path: attachmentPath,
      name: attachment.name,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    }];
  });
}

export function tokenUsage(usage: v2.TokenUsageBreakdown): import('../../core/codex-host').TokenUsage {
  return {
    totalTokens: usage.totalTokens, inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens ?? null,
    outputTokens: usage.outputTokens, reasoningOutputTokens: usage.reasoningOutputTokens,
  };
}

export function contextUsageFromTokens(tokenUsage: v2.ThreadTokenUsage): AgentContextUsage {
  const modelContextWindow = tokenUsage.modelContextWindow;
  const contextTokens = tokenUsage.last.totalTokens;
  const usedPercent = typeof modelContextWindow === 'number' && modelContextWindow > 0
    ? Math.min(100, Math.max(0, (contextTokens / modelContextWindow) * 100))
    : null;
  return {
    totalTokens: tokenUsage.total.totalTokens,
    inputTokens: tokenUsage.total.inputTokens,
    cachedInputTokens: tokenUsage.total.cachedInputTokens,
    outputTokens: tokenUsage.total.outputTokens,
    reasoningOutputTokens: tokenUsage.total.reasoningOutputTokens,
    lastTotalTokens: tokenUsage.last.totalTokens,
    modelContextWindow,
    usedPercent,
  };
}

export function hostThreadStatus(status: v2.ThreadStatus): CodexThreadStatus {
  return status.type === 'active'
    ? { type: 'active', activeFlags: [...status.activeFlags] }
    : { type: status.type };
}

export function conversationStatus(status: v2.ThreadStatus): CodexConversationSummary['status'] {
  if (status.type === 'active') return 'active';
  if (status.type === 'systemError') return 'error';
  return 'idle';
}

export function hostRateLimits(response: v2.GetAccountRateLimitsResponse): CodexRateLimits {
  const byLimitId = response.rateLimitsByLimitId
    ? Object.fromEntries(Object.entries(response.rateLimitsByLimitId)
      .filter((entry): entry is [string, v2.RateLimitSnapshot] => Boolean(entry[1]))
      .map(([limitId, snapshot]) => [limitId, hostRateLimitSnapshot(snapshot)]))
    : null;
  return {
    rateLimits: hostRateLimitSnapshot(response.rateLimits),
    rateLimitsByLimitId: byLimitId,
    rateLimitResetCredits: response.rateLimitResetCredits ? {
      availableCount: nonnegativeDecimal(response.rateLimitResetCredits.availableCount),
      credits: response.rateLimitResetCredits.credits?.map((credit) => ({ ...credit })) ?? null,
    } : null,
  };
}

/** JSON may decode protocol bigint fields as numbers. Never publish rounded counts. */
export function nonnegativeDecimal(value: unknown): string {
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  throw new Error('Invalid account count: expected an exact nonnegative integer');
}

export function hostAccountUsage(response: v2.GetAccountTokenUsageResponse): import('../../core/codex-host').CodexAccountUsage {
  const decimal = (value: bigint | null) => value === null ? null : nonnegativeDecimal(value);
  return {
    summary: {
      lifetimeTokens: decimal(response.summary.lifetimeTokens),
      peakDailyTokens: decimal(response.summary.peakDailyTokens),
      longestRunningTurnSec: decimal(response.summary.longestRunningTurnSec),
      currentStreakDays: decimal(response.summary.currentStreakDays),
      longestStreakDays: decimal(response.summary.longestStreakDays),
    },
    dailyUsageBuckets: response.dailyUsageBuckets?.map(bucket => ({
      startDate: bucket.startDate, tokens: nonnegativeDecimal(bucket.tokens),
    })) ?? null,
  };
}

export function hostRateLimitSnapshot(snapshot: v2.RateLimitSnapshot): CodexRateLimitSnapshot {
  return {
    limitId: snapshot.limitId,
    limitName: snapshot.limitName,
    primary: snapshot.primary ? { ...snapshot.primary } : null,
    secondary: snapshot.secondary ? { ...snapshot.secondary } : null,
    credits: snapshot.credits ? { ...snapshot.credits } : null,
    individualLimit: snapshot.individualLimit ? { ...snapshot.individualLimit } : null,
    planType: snapshot.planType,
    rateLimitReachedType: snapshot.rateLimitReachedType,
  };
}

export function mergeHostRateLimits(
  current: CodexRateLimits | null,
  update: v2.RateLimitSnapshot,
): CodexRateLimits {
  const next = hostRateLimitSnapshot(update);
  if (!current) {
    return {
      rateLimits: next,
      rateLimitsByLimitId: next.limitId ? { [next.limitId]: next } : null,
      rateLimitResetCredits: null,
    };
  }
  const merged = mergeRateLimitSnapshot(current.rateLimits, next);
  const rateLimitsByLimitId = current.rateLimitsByLimitId ? { ...current.rateLimitsByLimitId } : {};
  if (merged.limitId) {
    rateLimitsByLimitId[merged.limitId] = mergeRateLimitSnapshot(
      rateLimitsByLimitId[merged.limitId] ?? merged,
      next,
    );
  }
  return {
    ...current,
    rateLimits: merged,
    rateLimitsByLimitId: Object.keys(rateLimitsByLimitId).length > 0 ? rateLimitsByLimitId : null,
  };
}

export function mergeRateLimitSnapshot(
  current: CodexRateLimitSnapshot,
  update: CodexRateLimitSnapshot,
): CodexRateLimitSnapshot {
  return {
    limitId: update.limitId ?? current.limitId,
    limitName: update.limitName ?? current.limitName,
    primary: update.primary ? { ...(current.primary ?? {}), ...update.primary } : current.primary,
    secondary: update.secondary ? { ...(current.secondary ?? {}), ...update.secondary } : current.secondary,
    credits: update.credits ? { ...(current.credits ?? {}), ...update.credits } : current.credits,
    individualLimit: update.individualLimit
      ? { ...(current.individualLimit ?? {}), ...update.individualLimit }
      : current.individualLimit,
    planType: update.planType ?? current.planType,
    rateLimitReachedType: update.rateLimitReachedType ?? current.rateLimitReachedType,
  };
}
