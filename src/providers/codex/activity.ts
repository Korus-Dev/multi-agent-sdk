import type { ProviderEvent } from '../../driver';
import type { TurnError } from '../../contracts/turn';
import { activityScope, errorCode, harnessError, messageActivity, toolActivity, type FrameActivity } from '../../conversations/conversation-activity';

/** Codex reports a machine-readable error detail beside the message. */
const turnError = (error: TurnError | null | undefined) => harnessError(error?.message, errorCode(error?.codexErrorInfo));

/** The neutral activity one Codex conversation frame carries; snapshots carry none, only state. */
export function codexActivity(frame: ProviderEvent): FrameActivity[] {
  if (frame.type !== 'codex.conversationEventReceived') return [];
  const event = frame.payload.event;
  const turnId = 'turnId' in event ? event.turnId : undefined;
  const scope = activityScope(turnId, event.conversationId ?? frame.threadId);
  switch (event.type) {
    case 'turn.started': return [{ ...scope, type: 'turn.started', turnId: event.turnId }];
    case 'turn.completed': return [{ ...scope, type: 'turn.completed', turnId: event.turnId, status: event.payload.status,
      error: turnError(event.payload.error), willRetry: event.payload.willRetry === true }];
    case 'turn.error': {
      const error = turnError(event.payload.error);
      return error ? [{ ...scope, type: 'session.error', error, willRetry: event.payload.willRetry === true }] : [];
    }
    case 'tool.started': return [...toolActivity(scope, event.payload.toolPart), { ...scope, type: 'turn.output' }];
    case 'tool.completed': return toolActivity(scope, event.payload.toolPart);
    case 'tool.updated': return toolActivity(scope, { id: event.payload.update.itemId, status: event.payload.update.status });
    case 'message.appended': return messageActivity(scope, event.payload.message);
    case 'message.delta': case 'plan.delta': return [{ ...scope, type: 'turn.output' }];
    case 'plan.completed': return event.payload.markdown.trim()
      ? [{ ...scope, type: 'plan.proposed', turnId: event.turnId, markdown: event.payload.markdown, itemId: event.payload.itemId }] : [];
    case 'conversation.diffUpdated': return [{ ...scope, type: 'diff.updated' }];
    case 'file.activity': return [{ ...scope, type: 'file.activity', action: event.payload.action, status: event.payload.status, path: event.payload.path }];
    default: return [];
  }
}
