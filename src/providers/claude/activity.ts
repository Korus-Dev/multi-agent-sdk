import type { ProviderEvent } from '../../driver';
import { activityScope, harnessError, toolActivity, type FrameActivity } from '../../conversations/conversation-activity';

/** The neutral activity one Claude conversation frame carries; snapshots carry none, only state. */
export function claudeActivity(frame: ProviderEvent): FrameActivity[] {
  if (frame.type !== 'claude.conversationEventReceived') return [];
  const event = frame.payload.event;
  const scope = activityScope(event.turnId, event.providerSessionId ?? event.threadId);
  switch (event.type) {
    case 'turn.started': return [{ ...scope, type: 'turn.started', turnId: event.turnId }];
    case 'turn.completed': return [{ ...scope, type: 'turn.completed', turnId: event.turnId, status: event.payload.turn.status, error: null, willRetry: false }];
    case 'error': {
      const error = harnessError(event.payload.message, null, event.payload.rateLimit);
      return error ? [{ ...scope, type: 'session.error', error, willRetry: event.payload.willRetry === true }] : [];
    }
    case 'item.started': return [...toolActivity(scope, event.payload.toolPart), { ...scope, type: 'turn.output' }];
    case 'item.updated': return toolActivity(scope, { id: event.payload.itemId, status: event.payload.status });
    case 'message.delta': return [{ ...scope, type: 'turn.output' }];
    case 'turn.proposedPlanCompleted': return event.payload.markdown.trim()
      ? [{ ...scope, type: 'plan.proposed', turnId: event.turnId, markdown: event.payload.markdown, itemId: event.payload.itemId }] : [];
    default: return [];
  }
}
