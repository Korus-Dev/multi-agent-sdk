import { approvalAgentRequest, requestFromClientRequest } from './conversations/agent-request';
import type { HarnessEvent as NativeEvent } from './contracts/events';
import type { SessionState, Turn } from './consumer-types';
import { createCodexConversationReplica } from './core/conversation-replica';
import { createClaudeConversationReplica } from './conversations/claude-conversation-replica';
import { createCursorConversationReplica } from './conversations/cursor-conversation-replica';
import { createAntigravityConversationReplica } from './conversations/antigravity-conversation-replica';
import { surfaceMessages } from './providers/codex/host';

/** Only dispatches to native replicas. Transcript semantics stay provider-owned. */
export function createConsumerProjection() {
  let codex: ReturnType<typeof createCodexConversationReplica> | undefined;
  let claude: ReturnType<typeof createClaudeConversationReplica> | undefined;
  let cursor: ReturnType<typeof createCursorConversationReplica> | undefined;
  let antigravity: ReturnType<typeof createAntigravityConversationReplica> | undefined;
  let revision: number | undefined;
  return (event: NativeEvent): Partial<SessionState> | undefined => {
    if (!('revision' in event.payload) || typeof event.payload.revision !== 'number') return;
    const nextRevision = event.payload.revision;
    if (revision !== undefined && nextRevision <= revision) return;
    const snapshotFrame = 'snapshot' in event.payload;
    if (!snapshotFrame && revision !== undefined && nextRevision !== revision + 1) throw new Error('Conversation event gap; reload the native conversation.');
    switch (event.type) {
      case 'codex.conversationSnapshotChanged': codex = createCodexConversationReplica(event.payload.snapshot); break;
      case 'claude.conversationSnapshotChanged': claude = createClaudeConversationReplica(event.payload.snapshot); break;
      case 'cursor.conversationSnapshotChanged': cursor = createCursorConversationReplica(event.payload.snapshot); break;
      case 'antigravity.conversationSnapshotChanged': antigravity = createAntigravityConversationReplica(event.payload.snapshot); break;
      case 'codex.conversationEventReceived': if (!codex) throw new Error('Load a Codex snapshot before applying events.'); codex.apply(event.payload.event); break;
      case 'claude.conversationEventReceived': if (!claude) throw new Error('Load a Claude snapshot before applying events.'); claude.apply(event.payload.event); break;
      case 'cursor.conversationEventReceived': if (!cursor) throw new Error('Load a Cursor snapshot before applying events.'); cursor.apply(event.payload.event); break;
      case 'antigravity.conversationEventReceived': if (!antigravity) throw new Error('Load an Antigravity snapshot before applying events.'); antigravity.apply(event.payload.event); break;
      default: return;
    }
    revision = nextRevision;
    if (event.backend === 'codex' && codex) {
      const s = codex.getSnapshot();
      return { messages: surfaceMessages(s.messages, event.agentId!), busy: s.busy, activeTurnId: s.activeTurnId, turns: s.turns satisfies Turn[], answeredClientRequestIds: s.answeredClientRequestIds, historyLoading: s.historyLoading, historyState: s.historyState,
        requests: [...s.approvals.map(approvalAgentRequest), ...s.clientRequests.map(request => requestFromClientRequest(request, { conversationId: s.activeConversationId, turnId: request.turnId ?? undefined }))],
        error: s.error, contextUsage: s.contextUsage, goal: s.goal,
        plan: s.executionPlan ? { threadId: s.activeConversationId, turnId: s.executionPlan.turnId, kind: 'execution',
          status: s.turns.find(t => t.id === s.executionPlan!.turnId)?.status ?? 'inProgress',
          explanation: s.executionPlan.explanation ?? '', steps: [...s.executionPlan.steps], markdown: s.executionPlan.markdown, updatedAt: s.executionPlan.updatedAt } : null };
    }
    const s = event.backend === 'claude' ? claude?.getSnapshot() : event.backend === 'cursor' ? cursor?.getSnapshot() : antigravity?.getSnapshot();
    if (!s) return;
    return { messages: s.messages, busy: s.busy, activeTurnId: s.activeTurnId, turns: s.turns satisfies Turn[], answeredClientRequestIds: s.answeredClientRequestIds, historyLoading: s.historyLoading, historyState: s.historyState, ...('clientRequests' in s ? { requests: s.clientRequests.map(request => requestFromClientRequest(request, { conversationId: s.sessionId!, turnId: s.activeTurnId ?? undefined })) } : {}), error: s.error, contextUsage: s.contextUsage, ...('plan' in s ? { plan: s.plan } : {}) };
  };
}
