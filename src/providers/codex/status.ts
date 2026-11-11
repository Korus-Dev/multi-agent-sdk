import { createHash } from 'node:crypto';
import type { ProviderSafetyReview } from '../../contracts/safety-review';
import { providerSafetyBlockMessage } from '../../contracts/safety-review';
import type { AgentStatus } from '../../contracts/index';
import type { CodexConversationSnapshot } from '../../core/codex-conversation-types';

/**
 * What a person should see for the conversation. An error with a turn still running is a retry in progress, not a failure:
 * the turn is working until it ends, and only then does its error become the agent's state.
 */
export function statusFromSnapshot(snapshot: CodexConversationSnapshot): AgentStatus {
  const latestTurnId = snapshot.turnIds.at(-1);
  const latestTurn = latestTurnId ? snapshot.turns.find(turn => turn.id === latestTurnId) : snapshot.turns.at(-1);
  const blocked = providerSafetyBlockMessage(snapshot.error) ?? providerSafetyBlockMessage(latestTurn?.error);
  if (blocked) {
    const safetyReview = safetyReviewFromSnapshot(snapshot);
    return { type: 'error', message: blocked, ...(safetyReview ? { safetyReview } : {}) };
  }
  if (snapshot.threadStatus?.type === 'active') {
    if (snapshot.threadStatus.activeFlags.includes('waitingOnApproval')) {
      return { type: 'awaitingInput', reason: 'approval' };
    }
    if (snapshot.threadStatus.activeFlags.includes('waitingOnUserInput')) {
      return { type: 'awaitingInput', reason: 'input' };
    }
  }
  if (snapshot.clientRequests.some((request) => (
    request.kind !== 'ask_user' || request.payload.request.blocking !== false
  )) || snapshot.approvals.length > 0) {
    return { type: 'awaitingInput', reason: 'input' };
  }
  if (snapshot.busy) return { type: 'working' };
  if (snapshot.error) return { type: 'error', message: snapshot.error };
  return snapshot.goal?.status === 'active' ? { type: 'working' } : { type: 'idle' };
}

export function safetyReviewFromSnapshot(snapshot: CodexConversationSnapshot): ProviderSafetyReview | null {
  const latestTurnId = snapshot.turnIds.at(-1);
  const turn = latestTurnId ? snapshot.turns.find(turn => turn.id === latestTurnId) : snapshot.turns.at(-1);
  const findings = turn?.error?.misalignment;
  if (!turn || turn.status !== 'failed' || !findings || !providerSafetyBlockMessage(turn.error)) return null;
  const explanation = findings.detailedExplanation;
  const id = createHash('sha256').update(JSON.stringify([snapshot.activeConversationId, turn.id,
    findings.errorType, explanation, findings.steer?.message, findings.reviewTarget])).digest('hex');
  return { id, conversationId: snapshot.activeConversationId, turnId: turn.id, explanation,
    canContinue: Boolean(explanation?.trim() && findings.steer?.message.trim()) };
}
