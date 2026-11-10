import { suppressViewedImagePreviews } from './codex-original-history-images';
import type { CodexOriginalHistoryImages } from './codex-original-history-images';
import type { CodexAppServerClient, v2 } from 'codex-sdk';
import type {
  CodexConversationSummary,
  CodexSurfaceSnapshot,
  ListCodexConversationsOptions,
  SurfaceMessage,
  CodexSurfaceHistoryReason,
} from '../../core/surface';
import {
  codexTurnToSurfaceMessages,
  preserveHistoricalMessagePresentation,
} from './codex-conversation-history';
import { normalizedConversationId, errorMessage } from './codex-surface-prompts';
import { reuseUnchangedItems, threadToSummary, upsertConversation } from './codex-surface-data';
import type { ThreadRuntimePatch, ThreadRuntimeState } from './codex-surface-runtime';
import { surfaceTurn } from './codex-surface-events';

const HISTORY_INITIAL_PAGE_SIZE = 50;
const HISTORY_PAGE_SIZE = 25;
const HISTORY_MESSAGE_BATCH_SIZE = 25;

type HistoryHydrationOptions = {
  initialPageLoaded?: boolean;
  cursor?: string | null;
  restart?: boolean;
  itemsView?: 'full' | 'summary';
};

export type CodexSurfaceConversationsHost = {
  emitHistoryReplaced(threadId: string, reason: CodexSurfaceHistoryReason, origin: 'action'): void;
  emitHistoryPrepended(threadId: string, messages: readonly SurfaceMessage[], origin: 'lifecycle'): void;
  emitSummaryUpserted(
    summary: CodexConversationSummary,
    reason: 'listed' | 'updated',
    origin: 'action',
  ): void;
  ensureConnected(): Promise<void>;
  getSnapshot(): CodexSurfaceSnapshot;
  getState(): CodexSurfaceSnapshot;
  patch(patch: Partial<CodexSurfaceSnapshot>): void;
  patchRuntime(threadId: string, patch: ThreadRuntimePatch): void;
  removeThread(threadId: string, reason: 'archived' | 'deleted', origin: 'action'): void;
  requireRuntime(threadId: string): ThreadRuntimeState;
  runtime(threadId: string): ThreadRuntimeState | undefined;
  schedulePluginRefresh(force: boolean): void;
};

export class CodexSurfaceConversationsController {
  private readonly turnLoads = new Map<string, Map<string, Promise<void>>>();
  private readonly imageHydrations = new Map<string, Promise<void>>();
  private readonly historyHydrations = new Map<string, Promise<void>>();
  private readonly historyLoads = new Map<string, Promise<{
    conversationId: string;
    messages: SurfaceMessage[];
    hasOlder: boolean;
  }>>();

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly conversationLimit: number | undefined,
    private readonly host: CodexSurfaceConversationsHost,
    private readonly originalImages?: CodexOriginalHistoryImages,
  ) {}

  reset(): void {
    this.turnLoads.clear(); this.imageHydrations.clear();
    this.historyHydrations.clear();
    this.historyLoads.clear();
  }

  forget(threadId: string): void {
    this.turnLoads.delete(threadId); this.imageHydrations.delete(threadId);
    this.historyHydrations.delete(threadId);
    this.historyLoads.delete(threadId);
  }

  async loadTurnHistory(threadId: string, turnId: string): Promise<void> {
    const runtime = this.host.requireRuntime(threadId);
    const prior = runtime.turns.find(turn => turn.id === turnId);
    if (!prior) throw new Error('Turn is not loaded in this conversation.');
    if (prior.itemsView !== 'summary') return;
    let loads = this.turnLoads.get(threadId);
    if (!loads) { loads = new Map(); this.turnLoads.set(threadId, loads); }
    const existing = loads.get(turnId); if (existing) return existing;
    const setDetails = (patch: Partial<typeof prior>) => {
      this.host.patchRuntime(threadId, { turns: runtime.turns.map(turn => turn.id === turnId ? { ...turn, ...patch } : turn) });
      this.host.emitHistoryReplaced(threadId, 'details', 'action');
    };
    const loading = (async () => {
      await Promise.resolve();
      try {
        if (this.host.runtime(threadId) !== runtime) throw new Error('Conversation changed while loading turn details.');
        setDetails({ detailsLoading: true, detailsError: null });
        const items = await readTurnItems(this.client, threadId, turnId);
        if (this.host.runtime(threadId) !== runtime) throw new Error('Conversation changed while loading turn details.');
        const current = runtime.turns.find(turn => turn.id === turnId);
        if (!current) throw new Error('Turn is no longer available.');
        // An already-streaming turn is authoritative; never replace its live work.
        if (runtime.activeTurnId !== turnId && current.status !== 'inProgress') {
          const native: v2.Turn = { id: turnId, rootTurnId: null, itemsView: 'full', items, status: current.status, error: null,
            startedAt: current.startedAt ? Date.parse(current.startedAt) / 1000 : null,
            completedAt: current.completedAt ? Date.parse(current.completedAt) / 1000 : null, durationMs: current.durationMs };
          let messages = preserveHistoricalMessagePresentation(runtime.messages, codexTurnToSurfaceMessages(threadId, native));
          if (this.originalImages) messages = suppressViewedImagePreviews(messages);
          const at = runtime.messages.findIndex(message => message.turnId === turnId);
          const merged = runtime.messages.filter(message => message.turnId !== turnId);
          merged.splice(at < 0 ? merged.length : at, 0, ...messages);
          this.host.patchRuntime(threadId, { messages: merged });
        }
        setDetails({ itemsView: 'full', detailsLoading: false, detailsError: null });
        this.hydrateOriginalImages(threadId);
      } catch (error) {
        if (this.host.runtime(threadId) === runtime) setDetails({ detailsLoading: false, detailsError: errorMessage(error) });
        throw error;
      } finally { if (this.turnLoads.get(threadId) === loads) loads.delete(turnId); }
    })();
    loads.set(turnId, loading); return loading;
  }

  async loadLoadedTurnHistory(threadId: string): Promise<void> {
    const paging = this.historyLoads.get(threadId);
    if (paging) await paging;
    for (const turn of [...this.host.requireRuntime(threadId).turns]) {
      if (turn.itemsView === 'summary') await this.loadTurnHistory(threadId, turn.id);
    }
  }

  hydrateOriginalImages(threadId: string, path?: string | null): void {
    if (!this.originalImages) return;
    this.originalImages.rememberPath(threadId, path);
    if (this.imageHydrations.has(threadId)) return;
    const runtime = this.host.runtime(threadId);
    if (!runtime || !runtime.turns.some(turn => turn.itemsView !== 'summary')) return;
    const work = (async () => {
      const project = await this.originalImages!.prepare(threadId, path);
      if (this.host.runtime(threadId) !== runtime) return;
      const summaryIds = new Set(runtime.turns.filter(turn => turn.itemsView === 'summary').map(turn => turn.id));
      this.host.patchRuntime(threadId, { messages: project(runtime.messages).map((message, index) => summaryIds.has(message.turnId ?? '') ? runtime.messages[index]! : message) });
      this.host.emitHistoryReplaced(threadId, 'images', 'action');
    })();
    this.imageHydrations.set(threadId, work);
    void work.finally(() => { if (this.imageHydrations.get(threadId) === work) this.imageHydrations.delete(threadId); }).catch(() => undefined);
  }

  async refresh(): Promise<CodexSurfaceSnapshot> {
    await this.host.ensureConnected();
    return this.load();
  }

  async load(): Promise<CodexSurfaceSnapshot> {
    const conversations = reuseUnchangedItems(
      this.host.getState().conversations,
      await this.requestConversations({ limit: this.conversationLimit }),
    );
    this.host.patch({ conversations });
    this.host.schedulePluginRefresh(true);
    for (const summary of conversations) this.host.emitSummaryUpserted(summary, 'listed', 'action');
    return this.host.getSnapshot();
  }

  async list(options: ListCodexConversationsOptions = {}): Promise<CodexConversationSummary[]> {
    await this.host.ensureConnected();
    return structuredClone(await this.requestConversations(options));
  }

  async readSummary(conversationId: string): Promise<CodexConversationSummary> {
    const threadId = normalizedConversationId(conversationId);
    await this.host.ensureConnected();
    const response: v2.ThreadReadResponse = await this.client.request('thread/read', {
      threadId,
      includeTurns: false,
    });
    if (response.thread.id !== threadId) {
      throw new Error(`Codex thread/read returned '${response.thread.id}' for requested thread '${threadId}'`);
    }
    const summary = this.summaryWithKnownTurnCount(response.thread);
    return structuredClone(summary);
  }

  async archive(conversationId: string): Promise<CodexSurfaceSnapshot> {
    const threadId = normalizedConversationId(conversationId);
    await this.host.ensureConnected();
    await this.client.request('thread/archive', { threadId });
    this.host.removeThread(threadId, 'archived', 'action');
    return this.host.getSnapshot();
  }

  async delete(conversationId: string): Promise<CodexSurfaceSnapshot> {
    const threadId = normalizedConversationId(conversationId);
    await this.host.ensureConnected();
    await this.client.request('thread/delete', { threadId });
    this.host.removeThread(threadId, 'deleted', 'action');
    return this.host.getSnapshot();
  }

  async unarchive(conversationId: string): Promise<CodexSurfaceSnapshot> {
    const threadId = normalizedConversationId(conversationId);
    await this.host.ensureConnected();
    const response = await this.client.request('thread/unarchive', { threadId });
    if (response.thread.id !== threadId) {
      throw new Error(`Codex thread/unarchive returned '${response.thread.id}' for requested thread '${threadId}'`);
    }
    const summary = this.summaryWithKnownTurnCount(response.thread);
    this.host.patch({
      conversations: upsertConversation(this.host.getState().conversations, summary),
    });
    this.host.emitSummaryUpserted(summary, 'updated', 'action');
    return this.host.getSnapshot();
  }

  hydrateCompleteHistory(threadId: string, options: HistoryHydrationOptions = {}): Promise<void> {
    const runtime = this.host.requireRuntime(threadId);
    if (runtime.fullHistoryHydrated && !options.restart) return Promise.resolve();
    if (options.initialPageLoaded && options.cursor === null) {
      this.host.patchRuntime(threadId, {
        historyCursor: null,
        historyHasOlder: false,
        fullHistoryHydrated: true,
      });
      return Promise.resolve();
    }
    const existing = this.historyHydrations.get(threadId);
    if (existing) return existing;
    const hydration = (async () => {
      try {
        if (options.restart) {
          const response: v2.ThreadTurnsListResponse = await this.client.request('thread/turns/list', {
            threadId,
            cursor: null,
            limit: HISTORY_INITIAL_PAGE_SIZE,
            sortDirection: 'desc',
            itemsView: 'full',
          });
          await this.mergeHistoryPage(threadId, [...response.data].reverse(), new Set());
          this.host.patchRuntime(threadId, {
            historyCursor: response.nextCursor,
            historyHasOlder: response.nextCursor !== null,
            fullHistoryHydrated: response.nextCursor === null,
          });
        }
        if (options.cursor !== undefined) {
          this.host.patchRuntime(threadId, {
            historyCursor: options.cursor,
            historyHasOlder: options.cursor !== null,
          });
        }
        while (this.host.runtime(threadId)?.historyCursor !== null) {
          await this.loadOlderHistory(threadId, options.itemsView);
        }
        if (!this.host.runtime(threadId)) return;
        this.host.patchRuntime(threadId, {
          fullHistoryHydrated: true,
          historyHasOlder: false,
        });
      } catch (error) {
        if (this.host.runtime(threadId)) {
          this.host.patchRuntime(threadId, {
            error: `Could not load complete conversation history: ${errorMessage(error)}`,
          });
        }
        throw error;
      }
    })();
    this.historyHydrations.set(threadId, hydration);
    void hydration.finally(() => {
      if (this.historyHydrations.get(threadId) === hydration) this.historyHydrations.delete(threadId);
    }).catch(() => undefined);
    return hydration;
  }

  loadOlderHistory(threadId: string, itemsView?: 'full' | 'summary'): Promise<{
    conversationId: string;
    messages: SurfaceMessage[];
    hasOlder: boolean;
  }> {
    const runtime = this.host.requireRuntime(threadId);
    const existing = this.historyLoads.get(threadId);
    if (existing) return existing;
    if (runtime.fullHistoryHydrated || runtime.historyCursor === null) {
      return Promise.resolve({ conversationId: threadId, messages: [], hasOlder: false });
    }
    const load = (async () => {
      this.host.patchRuntime(threadId, { historyLoadingOlder: true, error: null });
      try {
        let cursor = this.host.requireRuntime(threadId).historyCursor;
        let messages: SurfaceMessage[] = [];
        const requestedCursors = new Set<string>();
        while (cursor !== null && messages.length === 0) {
          if (requestedCursors.has(cursor)) {
            throw new Error(`Codex app-server repeated a thread history cursor for '${threadId}'`);
          }
          requestedCursors.add(cursor);
          const materializedTurnIds = new Set(this.host.requireRuntime(threadId).turnIds);
          const requestedView = itemsView ?? this.host.requireRuntime(threadId).historyItemsView;
          let response: v2.ThreadTurnsListResponse = await this.client.request('thread/turns/list', {
            threadId, cursor, limit: HISTORY_PAGE_SIZE, sortDirection: 'desc', itemsView: requestedView,
          });
          if (requestedView === 'summary' && (itemsView ?? this.host.requireRuntime(threadId).historyItemsView) === 'full') {
            response = await this.client.request('thread/turns/list', { threadId, cursor, limit: HISTORY_PAGE_SIZE, sortDirection: 'desc', itemsView: 'full' });
          }
          const turns = [...response.data].reverse();
          const newTurnIds = new Set(turns
            .map((turn) => turn.id)
            .filter((turnId) => !materializedTurnIds.has(turnId)));
          messages = await this.mergeHistoryPage(threadId, turns, newTurnIds);
          cursor = response.nextCursor;
          this.host.patchRuntime(threadId, {
            historyCursor: cursor,
            historyHasOlder: cursor !== null,
            fullHistoryHydrated: cursor === null,
          });
          await this.emitHistoryChunks(threadId, messages);
        }
        return {
          conversationId: threadId,
          messages,
          hasOlder: this.host.requireRuntime(threadId).historyHasOlder,
        };
      } catch (error) {
        if (this.host.runtime(threadId)) this.host.patchRuntime(threadId, { error: errorMessage(error) });
        throw error;
      } finally {
        if (this.host.runtime(threadId)) this.host.patchRuntime(threadId, { historyLoadingOlder: false });
      }
    })();
    this.historyLoads.set(threadId, load);
    void load.finally(() => {
      if (this.historyLoads.get(threadId) === load) this.historyLoads.delete(threadId);
    }).catch(() => undefined);
    return load;
  }

  async waitForHistoryEmission(threadId: string): Promise<void> {
    const load = this.historyLoads.get(threadId);
    if (!load) return;
    await load.then(() => undefined, () => undefined);
  }

  private async emitHistoryChunks(threadId: string, messages: readonly SurfaceMessage[]): Promise<void> {
    for (let index = messages.length; index > 0;) {
      const start = Math.max(0, index - HISTORY_MESSAGE_BATCH_SIZE);
      this.host.emitHistoryPrepended(threadId, messages.slice(start, index), 'lifecycle');
      await yieldToClient();
      index = start;
    }
  }

  async refreshCompleteHistory(threadId: string): Promise<void> {
    const existing = this.historyHydrations.get(threadId);
    if (existing) await existing.catch(() => undefined);
    this.host.patchRuntime(threadId, {
      fullHistoryHydrated: false,
      historyCursor: null,
      historyHasOlder: true,
    });
    await this.hydrateCompleteHistory(threadId, { restart: true, itemsView: 'full' });
  }

  private async requestConversations(
    options: ListCodexConversationsOptions = {},
  ): Promise<CodexConversationSummary[]> {
    const conversations: CodexConversationSummary[] = [];
    // Paging is sorted by update time, so a thread updated mid-listing can
    // appear on two pages; keep its first, most recent position.
    const seenIds = new Set<string>();
    const totalLimit = options.limit === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.limit));
    let cursor: string | null | undefined = null;
    do {
      const limit = Math.min(100, totalLimit - conversations.length);
      if (limit <= 0) break;
      const response: v2.ThreadListResponse = await this.client.request('thread/list', {
        archived: options.archived ?? false,
        cursor,
        limit,
        sortDirection: 'desc',
        sortKey: 'updated_at',
        ...(options.cwd === undefined
          ? {}
          : { cwd: typeof options.cwd === 'string' ? options.cwd : [...options.cwd] }),
        ...(options.searchTerm === undefined ? {} : { searchTerm: options.searchTerm }),
      });
      for (const thread of response.data) {
        if (seenIds.has(thread.id)) continue;
        seenIds.add(thread.id);
        conversations.push(this.summaryWithKnownTurnCount(thread));
      }
      cursor = response.nextCursor;
    } while (cursor);
    return conversations;
  }

  private async mergeHistoryPage(
    threadId: string,
    turns: readonly v2.Turn[],
    newTurnIds: ReadonlySet<string>,
  ): Promise<SurfaceMessage[]> {
    const originalProjection = this.host.runtime(threadId)?.historyItemsView !== 'summary' ? await this.originalImages?.prepare(threadId) : undefined;
    const current = this.host.runtime(threadId);
    if (!current) return [];
    const protectedTurnIds = new Set<string>();
    if (current.activeTurnId) protectedTurnIds.add(current.activeTurnId);
    for (const turn of turns) {
      if ((turn.status === 'inProgress' || (turn.itemsView === 'summary' && current.turns.find(value => value.id === turn.id)?.itemsView !== 'summary')) && current.turnIds.includes(turn.id)) protectedTurnIds.add(turn.id);
    }
    const replaceableTurnIds = new Set(turns
      .filter((turn) => !protectedTurnIds.has(turn.id))
      .map((turn) => turn.id));
    const historicalTurns = turns.filter((turn) => replaceableTurnIds.has(turn.id));
    const preservedTurnIds = current.turnIds.filter((turnId) => !replaceableTurnIds.has(turnId));
    const preservedTurns = current.turns.filter((turn) => !replaceableTurnIds.has(turn.id));
    const preservedMessages = current.messages.filter((message) => (
      message.turnId === undefined || !replaceableTurnIds.has(message.turnId)
    ));
    let historyMessages = preserveHistoricalMessagePresentation(
      current.messages,
      historicalTurns.flatMap((turn) => codexTurnToSurfaceMessages(threadId, turn)),
    );
    if (originalProjection) historyMessages = originalProjection(historyMessages);
    else if (this.originalImages) historyMessages = suppressViewedImagePreviews(historyMessages);
    this.host.patchRuntime(threadId, {
      turnIds: [...historicalTurns.map((turn) => turn.id), ...preservedTurnIds],
      turns: [...historicalTurns.map((turn) => surfaceTurn(turn)), ...preservedTurns],
      messages: [...historyMessages, ...preservedMessages],
    });
    if (current.historyItemsView === 'summary') this.hydrateOriginalImages(threadId);
    const turnCount = this.host.requireRuntime(threadId).turnIds.length;
    const state = this.host.getState();
    this.host.patch({
      conversations: state.conversations.map((conversation) => conversation.id === threadId
        ? { ...conversation, turnCount }
        : conversation),
    });
    const summary = this.host.getState().conversations.find((conversation) => conversation.id === threadId);
    if (summary) this.host.emitSummaryUpserted(summary, 'updated', 'action');
    return historyMessages.filter((message) => message.turnId !== undefined && newTurnIds.has(message.turnId));
  }

  private summaryWithKnownTurnCount(thread: v2.Thread): CodexConversationSummary {
    const summary = threadToSummary(thread);
    const runtime = this.host.runtime(thread.id);
    if (runtime?.hydrated) return { ...summary, turnCount: runtime.turnIds.length };
    const existing = this.host.getState().conversations.find((conversation) => conversation.id === thread.id);
    return existing ? { ...summary, turnCount: existing.turnCount } : summary;
  }
}

function yieldToClient(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Full-detail reads for one turn, independent of turn pagination. */
export async function readTurnItems(client: CodexAppServerClient, threadId: string, turnId: string): Promise<v2.ThreadItem[]> {
  const items = new Map<string, v2.ThreadItem>(); const cursors = new Set<string>(); let cursor: string | null = null;
  do {
    const page: v2.ThreadItemsListResponse = await client.request('thread/items/list', { threadId, turnId, cursor, limit: 100, sortDirection: 'asc' });
    if (page.data.some(entry => entry.turnId !== turnId)) throw new Error('Turn details belong to another turn.');
    for (const entry of page.data) items.set(entry.item.id, entry.item); cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Repeated turn detail cursor.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...items.values()];
}
