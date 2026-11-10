import type { ClientRequest } from '../contracts/ui';
import type { ClientRequest as BackendClientRequest } from '../contracts/conversation';

export function providerPaneClientRequests(snapshot: { sessionId: string; activeTurnId: string | null; clientRequests: BackendClientRequest[] }): ClientRequest[] {
  return snapshot.clientRequests.map(request => request.kind === 'ask_user'
    ? { ...request, conversationId: snapshot.sessionId, turnId: snapshot.activeTurnId ?? '', itemId: request.payload.request.itemId,
      payload: { request: { ...request.payload.request, delivery: request.payload.request.delivery ?? 'tool', blocking: request.payload.request.blocking ?? true } } }
    : { ...request, conversationId: snapshot.sessionId, turnId: snapshot.activeTurnId, itemId: request.id });
}
