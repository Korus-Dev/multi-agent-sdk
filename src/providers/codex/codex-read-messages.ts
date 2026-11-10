import type { CodexAppServerClient, v2 } from '@korus-dev/codex-sdk';
import { codexTurnToSurfaceMessages } from './codex-conversation-history';
import { readTurnItems } from './codex-surface-conversations-controller';

/** Reads provider history without creating, resuming or selecting a runtime. */
export async function readCodexMessages(client: CodexAppServerClient, threadId: string) {
  if (!threadId) throw new Error('A conversation identity is required.');
  const metadata = await client.request('thread/read', { threadId, includeTurns: false });
  if (metadata.thread.id !== threadId) throw new Error('Conversation history identity mismatch.');
  const turns = new Map<string, v2.Turn>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: v2.ThreadTurnsListResponse = await client.request('thread/turns/list', {
      threadId, cursor, limit: 100, sortDirection: 'asc', itemsView: 'full',
    });
    for (const turn of page.data) {
      turns.set(turn.id, turn.itemsView === 'summary'
        ? { ...turn, items: await readTurnItems(client, threadId, turn.id), itemsView: 'full' }
        : turn);
    }
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Repeated conversation history cursor.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...turns.values()].flatMap(turn => codexTurnToSurfaceMessages(threadId, turn));
}
