import type { ConversationFrame } from '../contracts/events';
import type { RateLimitDetails } from '../contracts/rate-limit';
import type { ActivityScope, ConversationActivity, HarnessError } from '../conversation-activity';

/** A plan the agent proposed; the harness publishes it as `plan.readyForReview`. */
type ProposedPlan = ActivityScope & { type: 'plan.proposed'; turnId: string; markdown: string; itemId?: string };
/** What one native conversation frame means, as each harness reads its own frames. */
export type FrameActivity = ConversationActivity | ProposedPlan;

/** A provider's own conversation frame: input to its harness, never handed to consumers. */
export const isConversationFrame = (event: { type: string }): event is ConversationFrame =>
  event.type.endsWith('.conversationEventReceived') || event.type.endsWith('.conversationSnapshotChanged');

/** The turn and conversation an activity belongs to, leaving out what is unknown. */
export const activityScope = (turnId: string | undefined, conversationId: string | undefined): ActivityScope =>
  ({ ...(turnId ? { turnId } : {}), ...(conversationId ? { conversationId } : {}) });

/** A neutral error from a message, a provider's own code and when its limit resets; null without a message. */
export function harnessError(message: string | null | undefined, code?: string | null, rateLimit?: RateLimitDetails | null): HarnessError | null {
  if (!message) return null;
  return { message, ...(code ? { code } : {}), ...(rateLimit && typeof rateLimit.resumeAt === 'number' ? { rateLimit } : {}) };
}

/** A provider's machine-readable error detail as a code, when it is one. */
export const errorCode = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

const toolStatus = (value: unknown): 'running' | 'completed' | 'failed' | undefined =>
  value === 'running' || value === 'completed' || value === 'failed' ? value : undefined;

/** A tool's progress; nothing for a status that is not running, completed or failed. */
export function toolActivity(scope: ActivityScope, part: { id?: unknown; status?: unknown; kind?: unknown }): ConversationActivity[] {
  const id = typeof part.id === 'string' && part.id ? part.id : undefined, status = toolStatus(part.status);
  const kind = typeof part.kind === 'string' && part.kind ? part.kind : undefined;
  return id && status ? [{ ...scope, type: 'tool.updated', tool: { id, status, ...(kind ? { kind } : {}) } }] : [];
}

/** The activity a whole message carries: its tools' progress, and output when an assistant message has content. */
type MessageLike = { role: string; parts: readonly { type: string; id?: unknown; status?: unknown; kind?: unknown; text?: unknown; summary?: unknown }[] };
export function messageActivity(scope: ActivityScope, message: MessageLike): ConversationActivity[] {
  const tools = message.parts.flatMap(part => part.type === 'tool' ? toolActivity(scope, part) : []);
  const output = message.role === 'assistant' && message.parts.some(part =>
    (part.type === 'text' && Boolean(part.text)) || (part.type === 'reasoning' && Boolean(part.summary)) || part.type === 'tool');
  return output ? [...tools, { ...scope, type: 'turn.output' }] : tools;
}

/** Activity for harnesses whose turns report whole messages as they change. */
export function transcriptActivity(
  frame: { type: string; turnId?: string; payload: unknown },
  conversationId: string | undefined,
): FrameActivity[] {
  const event = frame as { type: string; turnId?: string; payload?: { turn?: { id: string; status?: string }; message?: MessageLike; error?: string } };
  const turnId = event.turnId ?? event.payload?.turn?.id;
  const scope = activityScope(turnId, conversationId);
  if (event.type === 'turn.started') return turnId ? [{ ...scope, type: 'turn.started', turnId }] : [];
  if (event.type === 'turn.completed') {
    const status = event.payload?.turn?.status;
    if (!turnId || (status !== 'completed' && status !== 'interrupted' && status !== 'failed')) return [];
    return [{ ...scope, type: 'turn.completed', turnId, status, error: harnessError(event.payload?.error), willRetry: false }];
  }
  if (event.type === 'message.upsert' && Array.isArray(event.payload?.message?.parts)) return messageActivity(scope, event.payload.message);
  return [];
}
