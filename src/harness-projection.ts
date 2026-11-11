import { requestFromClientRequest } from './conversations/agent-request';
import type { ProviderEvent } from './contracts/events';
import type { ClientRequest } from './contracts';
import type { SessionState } from './consumer-types';

/** Turns one session's native conversation events into session state. */
export type HarnessProjection = (event: ProviderEvent) => Partial<SessionState> | undefined;

/** How a harness keeps its native conversation replica. */
export type ReplicaSpec<Replica> = {
  snapshotEvent: string;
  conversationEvent: string;
  /** Names the provider in the error raised when an event arrives before a snapshot. */
  label: string;
  create(snapshot: never): Replica;
  apply(replica: Replica, event: never): void;
  state(replica: Replica, event: ProviderEvent): Partial<SessionState> | undefined;
};

/** A revision-checked projection over one native replica. Transcript semantics stay with the provider. */
export function replicaProjection<Replica>(spec: ReplicaSpec<Replica>): HarnessProjection {
  let replica: Replica | undefined;
  let revision: number | undefined;
  return event => {
    const payload = event.payload as Record<string, unknown>;
    if (!('revision' in payload) || typeof payload.revision !== 'number') return;
    const nextRevision = payload.revision;
    if (revision !== undefined && nextRevision <= revision) return;
    const snapshotFrame = 'snapshot' in payload;
    if (!snapshotFrame && revision !== undefined && nextRevision !== revision + 1) throw new Error('Conversation event gap; reload the native conversation.');
    if (event.type === spec.snapshotEvent) replica = spec.create(payload.snapshot as never);
    else if (event.type === spec.conversationEvent) {
      if (!replica) throw new Error(`Load a ${spec.label} snapshot before applying events.`);
      spec.apply(replica, payload.event as never);
    } else return;
    revision = nextRevision;
    return replica ? spec.state(replica, event) : undefined;
  };
}

/** The transcript snapshot shape session-keyed harnesses share. */
export type TranscriptSnapshot = Pick<SessionState, 'messages' | 'busy' | 'activeTurnId' | 'turns' | 'error' | 'contextUsage'> & {
  sessionId?: string | null;
  answeredClientRequestIds?: SessionState['answeredClientRequestIds'];
  historyLoading?: SessionState['historyLoading'];
  historyState?: SessionState['historyState'];
  clientRequests?: readonly ClientRequest[];
  plan?: SessionState['plan'];
};

/** Session state from a transcript snapshot. */
export function transcriptState(s: TranscriptSnapshot): Partial<SessionState> {
  return { messages: s.messages, busy: s.busy, activeTurnId: s.activeTurnId, turns: s.turns, answeredClientRequestIds: s.answeredClientRequestIds, historyLoading: s.historyLoading, historyState: s.historyState,
    ...(s.clientRequests ? { requests: s.clientRequests.map(request => requestFromClientRequest(request, { conversationId: s.sessionId!, turnId: s.activeTurnId ?? undefined })) } : {}),
    error: s.error, contextUsage: s.contextUsage, ...('plan' in s ? { plan: s.plan } : {}) };
}
