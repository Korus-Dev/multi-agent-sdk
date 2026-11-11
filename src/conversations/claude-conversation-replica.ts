import type {
  ClaudeConversationEvent,
  ClaudeConversationSnapshot,
  ClaudeConversationTurn,
} from '../contracts';
import { applyClaudeConversationEvent } from './claude-conversation-reducer';
import { workPhaseView, type WorkPhaseRules } from './work-phases';

export type ClaudeConversationReplica = {
  apply(event: ClaudeConversationEvent): ClaudeConversationSnapshot;
  getSnapshot(): ClaudeConversationSnapshot;
};

export function createClaudeConversationReplica(
  initialSnapshot: ClaudeConversationSnapshot,
  rules: WorkPhaseRules = {},
): ClaudeConversationReplica {
  let snapshot = structuredClone(initialSnapshot);
  // Reads carry work phases Claude does not tag itself.
  const view = workPhaseView<ClaudeConversationSnapshot>(rules);

  return {
    apply(event) {
      if (event.agentId !== snapshot.agentId) {
        throw new Error(`Claude conversation event belongs to '${event.agentId}', expected '${snapshot.agentId}'.`);
      }
      const next = structuredClone(snapshot);
      if (event.type === 'clientRequest.resolved') {
        if (!next.answeredClientRequestIds.includes(event.payload.id)) {
          next.answeredClientRequestIds.push(event.payload.id);
        }
        snapshot = next;
        return view(snapshot);
      }

      applyClaudeConversationEvent(next, structuredClone(event));
      snapshot = applyTurnLifecycle(next, event);
      return view(snapshot);
    },
    getSnapshot() {
      return view(snapshot);
    },
  };
}

function applyTurnLifecycle(
  snapshot: ClaudeConversationSnapshot,
  event: ClaudeConversationEvent,
): ClaudeConversationSnapshot {
  if (event.type === 'turn.historyUpdated') {
    if (event.providerSessionId !== snapshot.sessionId) return snapshot;
    return { ...snapshot, turns: upsertTurn(snapshot.turns, event.payload.turn) };
  }
  if (event.type === 'turn.started') {
    return {
      ...snapshot,
      activeTurnId: event.turnId,
      turnIds: snapshot.turnIds.includes(event.turnId)
        ? snapshot.turnIds
        : [...snapshot.turnIds, event.turnId],
      turns: upsertTurn(snapshot.turns, {
        id: event.turnId,
        status: 'inProgress',
        error: null,
        willRetry: false,
        startedAt: event.occurredAt,
        completedAt: null,
        durationMs: null,
      }),
      busy: true,
      error: null,
    };
  }
  if (event.type === 'turn.completed') {
    return {
      ...snapshot,
      activeTurnId: snapshot.activeTurnId === event.turnId ? null : snapshot.activeTurnId,
      turns: completeTurn(snapshot.turns, event),
      busy: false,
    };
  }
  if (event.type === 'error' && event.payload.willRetry !== true) {
    return { ...snapshot, error: event.payload.message };
  }
  return snapshot;
}

function completeTurn(
  turns: ClaudeConversationTurn[],
  event: Extract<ClaudeConversationEvent, { type: 'turn.completed' }>,
): ClaudeConversationTurn[] {
  const existing = turns.find((candidate) => candidate.id === event.turnId);
  const startedAt = existing?.startedAt ?? null;
  const completedAt = event.occurredAt;
  return upsertTurn(turns, {
    id: event.turnId,
    status: event.payload.turn.status,
    error: null,
    willRetry: false,
    startedAt,
    completedAt,
    durationMs: startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null,
  });
}

function upsertTurn(
  turns: ClaudeConversationTurn[],
  turn: ClaudeConversationTurn,
): ClaudeConversationTurn[] {
  const index = turns.findIndex((candidate) => candidate.id === turn.id);
  if (index === -1) return [...turns, turn];
  const next = [...turns];
  next[index] = turn;
  return next;
}
