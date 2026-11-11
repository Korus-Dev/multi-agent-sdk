import type { ConversationFrame, ProviderEvent } from '../contracts/events';
import type { RateLimitDetails } from '../contracts/rate-limit';
import type { TurnStatus } from '../contracts/turn';
import type { ActivityScope, ConversationActivity, HarnessError } from '../conversation-activity';

/** A plan the agent proposed; the harness publishes it as `plan.readyForReview`. */
type ProposedPlan = ActivityScope & { type: 'plan.proposed'; turnId: string; markdown: string; itemId?: string };

/** A provider's own conversation frame: input to its harness, never handed to consumers. */
export const isConversationFrame = (event: { type: string }): event is ConversationFrame =>
  event.type.endsWith('.conversationEventReceived') || event.type.endsWith('.conversationSnapshotChanged');

const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const toolStatus = (value: unknown): 'running' | 'completed' | 'failed' | undefined =>
  value === 'running' || value === 'completed' || value === 'failed' ? value : undefined;

function harnessError(value: unknown, rateLimit?: unknown): HarnessError | null {
  const error = record(value);
  const message = typeof value === 'string' ? value : text(error.message);
  if (!message) return null;
  const code = text(error.code) ?? text(error.codexErrorInfo);
  const limit = record(rateLimit ?? error.rateLimit);
  return { message, ...(code ? { code } : {}), ...(typeof limit.resumeAt === 'number' ? { rateLimit: limit as RateLimitDetails } : {}) };
}

/** The neutral activity one native conversation frame carries; snapshots carry none, only state. */
export function conversationActivity(frame: ProviderEvent): (ConversationActivity | ProposedPlan)[] {
  if (!frame.type.endsWith('.conversationEventReceived')) return [];
  const inner = record(record(frame.payload).event);
  const type = text(inner.type);
  if (!type) return [];
  const payload = record(inner.payload);
  const conversationId = text(inner.conversationId) ?? text(inner.providerSessionId) ?? text(inner.sessionId) ?? frame.conversationId ?? frame.threadId ?? frame.providerSessionId;
  const turnId = text(inner.turnId) ?? text(record(payload.turn).id);
  const scope = { ...(turnId ? { turnId } : {}), ...(conversationId ? { conversationId } : {}) };
  const turn = record(payload.turn);
  switch (type) {
    case 'turn.started': return turnId ? [{ ...scope, type, turnId }] : [];
    case 'turn.completed': {
      const status = (text(payload.status) ?? text(turn.status)) as TurnStatus | undefined;
      if (!turnId || !status) return [];
      return [{ ...scope, type, turnId, status, error: harnessError(payload.error ?? turn.error), willRetry: payload.willRetry === true }];
    }
    case 'error': case 'turn.error': {
      const error = harnessError(payload.message ? { ...record(payload.error), message: payload.message } : payload.error, payload.rateLimit);
      return error ? [{ ...scope, type: 'session.error', error, willRetry: payload.willRetry === true }] : [];
    }
    case 'tool.started': case 'tool.completed': case 'item.started': case 'item.updated': case 'tool.updated': {
      const part = type === 'item.updated' ? { id: payload.itemId, status: payload.status }
        : type === 'tool.updated' ? { id: record(payload.update).itemId, status: record(payload.update).status } : record(payload.toolPart);
      const id = text(part.id), status = toolStatus(part.status);
      const tool = id && status ? [{ ...scope, type: 'tool.updated' as const, tool: { id, status, ...(text((part as Record<string, unknown>).kind) ? { kind: text((part as Record<string, unknown>).kind) } : {}) } }] : [];
      return type === 'tool.started' || type === 'item.started' ? [...tool, { ...scope, type: 'turn.output' }] : tool;
    }
    case 'message.upsert': case 'message.appended': {
      const message = record(payload.message);
      const parts = Array.isArray(message.parts) ? message.parts.map(record) : [];
      const tools = parts.flatMap(part => {
        const id = text(part.id), status = toolStatus(part.status);
        return part.type === 'tool' && id && status ? [{ ...scope, type: 'tool.updated' as const, tool: { id, status, ...(text(part.kind) ? { kind: text(part.kind) } : {}) } }] : [];
      });
      const output = message.role === 'assistant' && parts.some(part =>
        (part.type === 'text' && text(part.text)) || (part.type === 'reasoning' && text(part.summary)) || part.type === 'tool');
      return output ? [...tools, { ...scope, type: 'turn.output' }] : tools;
    }
    case 'message.delta': case 'plan.delta': return [{ ...scope, type: 'turn.output' }];
    case 'conversation.diffUpdated': case 'conversation.turnDiffUpdated': return [{ ...scope, type: 'diff.updated' }];
    case 'file.activity': {
      const action = text(payload.action), status = text(payload.status);
      return action && status ? [{ ...scope, type, action, status, ...(text(payload.path) ? { path: text(payload.path) } : {}) }] : [];
    }
    case 'turn.proposedPlanCompleted': case 'plan.completed': {
      const markdown = text(payload.markdown);
      return turnId && markdown?.trim() ? [{ ...scope, type: 'plan.proposed', turnId, markdown, ...(text(payload.itemId) ? { itemId: text(payload.itemId) } : {}) }] : [];
    }
    default: return [];
  }
}
