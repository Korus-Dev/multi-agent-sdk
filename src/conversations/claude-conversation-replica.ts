import type {
  ClaudeConversationEvent,
  ClaudeConversationSnapshot,
  ClaudeConversationTurn,
} from '../contracts';
import { applyClaudeConversationEvent } from './claude-conversation-reducer';

export type ClaudeConversationReplica = {
  apply(event: ClaudeConversationEvent): ClaudeConversationSnapshot;
  getSnapshot(): ClaudeConversationSnapshot;
};

export function createClaudeConversationReplica(
  initialSnapshot: ClaudeConversationSnapshot,
): ClaudeConversationReplica {
  let snapshot = structuredClone(initialSnapshot);

  return {
    apply(event) {
      if (event.agentId !== snapshot.agentId) {
        throw new Error(`Claude conversation event belongs to '${event.agentId}', expected '${snapshot.agentId}'.`);
      }
      // A page of older history only adds messages and turns before the ones held, and never changes one of them, so
      // the messages already held are shared with the snapshot before it. Every other event may change a message in place.
      const next = event.type === 'history.prepended' || event.type === 'turn.historyUpdated' ? withSharedMessages(snapshot) : structuredClone(snapshot);
      if (event.type === 'clientRequest.resolved') {
        if (!next.answeredClientRequestIds.includes(event.payload.id)) {
          next.answeredClientRequestIds.push(event.payload.id);
        }
        // An approval that had no tool call to attach to shows as its own part; answering it ends that part.
        for (const message of next.messages) for (const part of message.parts) {
          if (part.type === 'tool' && part.id === `approval-${event.payload.id}` && part.status === 'running') part.status = 'completed';
        }
        snapshot = next;
        return snapshot;
      }

      applyClaudeConversationEvent(next, structuredClone(event));
      snapshot = applyTurnLifecycle(next, event);
      return snapshot;
    },
    getSnapshot() {
      return snapshot;
    },
  };
}

/** A new snapshot that shares the messages of `snapshot`; the lists the history events change are copied. */
function withSharedMessages(snapshot: ClaudeConversationSnapshot): ClaudeConversationSnapshot {
  return { ...snapshot, turnIds: [...snapshot.turnIds], turns: [...snapshot.turns], historyState: { ...snapshot.historyState } };
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
