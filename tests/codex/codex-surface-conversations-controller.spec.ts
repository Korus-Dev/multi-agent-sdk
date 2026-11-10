import { describe, expect, it, vi } from 'vitest';
import type { CodexSurfaceSnapshot, SurfaceMessage } from '@korus-dev/multi-agent-sdk/surface';
import type { CodexAppServerClient, v2 } from '@korus-dev/codex-sdk/protocol';
import { initialAuthentication } from '../../src/providers/codex/codex-surface-authentication';
import { CodexSurfaceConversationsController } from '../../src/providers/codex/codex-surface-conversations-controller';
import { createThreadRuntime, initialSurfaceSnapshot } from '../../src/providers/codex/codex-surface-runtime';
import { thread, turn } from './helpers/codex-surface-fixture';

describe('CodexSurfaceConversationsController', () => {
  it('loads conversations, patches state, schedules plugins, and emits listed summaries', async () => {
    const first = threadWith('first', { updatedAt: 10 });
    const second = threadWith('second', { updatedAt: 20 });
    const setup = createController({ conversationLimit: 12 });
    setup.respond('thread/list', { data: [first, second], nextCursor: null });

    await expect(setup.controller.load()).resolves.toBe(setup.state);

    expect(setup.request).toHaveBeenCalledExactlyOnceWith('thread/list', {
      archived: false, cursor: null, limit: 12, sortDirection: 'desc', sortKey: 'updated_at',
    });
    expect(setup.state.conversations.map((item) => item.id)).toStrictEqual(['first', 'second']);
    expect(setup.host.schedulePluginRefresh).toHaveBeenCalledExactlyOnceWith(true);
    expect(setup.host.emitSummaryUpserted).toHaveBeenNthCalledWith(
      1, expect.objectContaining({ id: 'first' }), 'listed', 'action',
    );
    expect(setup.host.emitSummaryUpserted).toHaveBeenNthCalledWith(
      2, expect.objectContaining({ id: 'second' }), 'listed', 'action',
    );
  });

  it('refreshes only after connecting and list returns a detached result', async () => {
    const setup = createController();
    setup.respond('thread/list', { data: [threadWith('first')], nextCursor: null });

    const listed = await setup.controller.list();
    listed[0]!.title = 'mutated';

    expect(setup.host.ensureConnected).toHaveBeenCalledOnce();
    expect(listed[0]?.id).toBe('first');
    expect(paramsFor(setup.request, 'thread/list')).toStrictEqual({
      archived: false, cursor: null, limit: 100, sortDirection: 'desc', sortKey: 'updated_at',
    });

    setup.request.mockClear();
    setup.host.ensureConnected.mockClear();
    setup.respond('thread/list', { data: [], nextCursor: null });
    await expect(setup.controller.refresh()).resolves.toBe(setup.state);
    expect(setup.host.ensureConnected).toHaveBeenCalledOnce();
    expect(setup.request).toHaveBeenCalledOnce();
  });

  it('normalizes list options and paginates to the requested total', async () => {
    const setup = createController();
    setup.respond('thread/list', {
      data: Array.from({ length: 100 }, (_, index) => threadWith(`thread-${index}`)),
      nextCursor: 'page-2',
    });
    setup.respond('thread/list', { data: [threadWith('thread-100')], nextCursor: 'unused' });

    const result = await setup.controller.list({
      archived: true,
      cwd: ['/one', '/two'],
      searchTerm: 'needle',
      limit: 101.9,
    });

    expect(result).toHaveLength(101);
    expect(setup.request).toHaveBeenNthCalledWith(1, 'thread/list', {
      archived: true, cursor: null, limit: 100, sortDirection: 'desc', sortKey: 'updated_at',
      cwd: ['/one', '/two'], searchTerm: 'needle',
    });
    expect(setup.request).toHaveBeenNthCalledWith(2, 'thread/list', {
      archived: true, cursor: 'page-2', limit: 1, sortDirection: 'desc', sortKey: 'updated_at',
      cwd: ['/one', '/two'], searchTerm: 'needle',
    });
    expect(setup.request).toHaveBeenCalledTimes(2);
  });

  it('preserves a string cwd and performs no request for a nonpositive limit', async () => {
    const setup = createController();
    setup.respond('thread/list', { data: [], nextCursor: null });
    await setup.controller.list({ cwd: '/workspace', limit: 1 });
    expect(paramsFor(setup.request, 'thread/list')).toMatchObject({ cwd: '/workspace', limit: 1 });

    setup.request.mockClear();
    await expect(setup.controller.list({ limit: -1 })).resolves.toStrictEqual([]);
    expect(setup.request).not.toHaveBeenCalled();
  });

  it('reads a summary with the known hydrated turn count and rejects mismatched identities', async () => {
    const setup = createController({ hydrated: true, turnIds: ['one', 'two'] });
    setup.respond('thread/read', { thread: threadWith('thread-1', { turns: [] }) });

    await expect(setup.controller.readSummary(' thread-1 ')).resolves.toMatchObject({
      id: 'thread-1', turnCount: 2,
    });
    expect(setup.request).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-1', includeTurns: false,
    });

    const mismatch = createController();
    mismatch.respond('thread/read', { thread: threadWith('other') });
    await expect(mismatch.controller.readSummary('thread-1'))
      .rejects.toThrow("returned 'other' for requested thread 'thread-1'");
  });

  it('preserves an existing summary turn count when the runtime is not hydrated', async () => {
    const setup = createController();
    setup.state.conversations = [{ ...summary('thread-1'), turnCount: 7 }];
    setup.respond('thread/read', { thread: threadWith('thread-1', { turns: [] }) });
    const result = await setup.controller.readSummary('thread-1');
    expect(result.turnCount).toBe(7);
  });

  it('archives and deletes only after their RPC succeeds', async () => {
    const archived = createController();
    archived.respond('thread/archive', {});
    await expect(archived.controller.archive(' thread-1 ')).resolves.toBe(archived.state);
    expect(archived.request).toHaveBeenCalledWith('thread/archive', { threadId: 'thread-1' });
    expect(archived.host.removeThread).toHaveBeenCalledExactlyOnceWith('thread-1', 'archived', 'action');

    const deleted = createController();
    deleted.respond('thread/delete', {});
    await expect(deleted.controller.delete('thread-1')).resolves.toBe(deleted.state);
    expect(deleted.request).toHaveBeenCalledWith('thread/delete', { threadId: 'thread-1' });
    expect(deleted.host.removeThread).toHaveBeenCalledExactlyOnceWith('thread-1', 'deleted', 'action');

    const failed = createController();
    failed.reject('thread/delete', new Error('delete failed'));
    await expect(failed.controller.delete('thread-1')).rejects.toThrow('delete failed');
    expect(failed.host.removeThread).not.toHaveBeenCalled();
  });

  it('unarchives the requested thread and publishes its summary', async () => {
    const setup = createController();
    setup.respond('thread/unarchive', { thread: threadWith('thread-1') });

    await expect(setup.controller.unarchive('thread-1')).resolves.toBe(setup.state);

    expect(setup.request).toHaveBeenCalledWith('thread/unarchive', { threadId: 'thread-1' });
    expect(setup.state.conversations).toEqual([
      expect.objectContaining({ id: 'thread-1', title: 'thread-1' }),
    ]);
    expect(setup.host.emitSummaryUpserted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'thread-1' }), 'updated', 'action',
    );

    const mismatch = createController();
    mismatch.respond('thread/unarchive', { thread: threadWith('other') });
    await expect(mismatch.controller.unarchive('thread-1'))
      .rejects.toThrow("returned 'other' for requested thread 'thread-1'");
    expect(mismatch.host.patch).not.toHaveBeenCalled();
  });

  it('returns an empty older-history page when history is already complete or has no cursor', async () => {
    const complete = createController({ fullHistoryHydrated: true, historyCursor: 'ignored' });
    await expect(complete.controller.loadOlderHistory('thread-1')).resolves.toStrictEqual({
      conversationId: 'thread-1', messages: [], hasOlder: false,
    });
    expect(complete.request).not.toHaveBeenCalled();
    expect(complete.host.patchRuntime).not.toHaveBeenCalled();

    const noCursor = createController({ historyCursor: null });
    await expect(noCursor.controller.loadOlderHistory('thread-1')).resolves.toStrictEqual({
      conversationId: 'thread-1', messages: [], hasOlder: false,
    });
    expect(noCursor.request).not.toHaveBeenCalled();
    expect(noCursor.host.patchRuntime).not.toHaveBeenCalled();
  });

  it('loads, reverses, merges, emits, and finalizes one older history page', async () => {
    const setup = createController({ historyCursor: 'cursor-1', turnIds: ['current'] });
    setup.state.conversations = [{ ...summary('thread-1'), turnCount: 1 }];
    setup.respond('thread/turns/list', {
      data: [turnWithUser('older-2', 'Second'), turnWithUser('older-1', 'First')],
      nextCursor: null,
    });

    await expect(setup.controller.loadOlderHistory('thread-1')).resolves.toMatchObject({
      conversationId: 'thread-1', hasOlder: false,
      messages: [
        expect.objectContaining({ turnId: 'older-1' }),
        expect.objectContaining({ turnId: 'older-2' }),
      ],
    });

    expect(setup.request).toHaveBeenCalledExactlyOnceWith('thread/turns/list', {
      threadId: 'thread-1', cursor: 'cursor-1', limit: 25, sortDirection: 'desc', itemsView: 'full',
    });
    expect(setup.runtime).toMatchObject({
      historyCursor: null, historyHasOlder: false, fullHistoryHydrated: true,
      historyLoadingOlder: false, turnIds: ['older-1', 'older-2', 'current'],
    });
    expect(setup.host.emitHistoryPrepended).toHaveBeenCalledExactlyOnceWith(
      'thread-1', [
        expect.objectContaining({ turnId: 'older-1' }),
        expect.objectContaining({ turnId: 'older-2' }),
      ], 'lifecycle',
    );
    expect(setup.state.conversations[0]?.turnCount).toBe(3);
    expect(setup.host.emitSummaryUpserted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'thread-1', turnCount: 3 }), 'updated', 'action',
    );
  });

  it('keeps a next page demand-paged after returning new messages', async () => {
    const setup = createController({ historyCursor: 'cursor-1' });
    setup.respond('thread/turns/list', {
      data: [turnWithUser('older', 'Older')], nextCursor: 'cursor-2',
    });

    const result = await setup.controller.loadOlderHistory('thread-1');

    expect(result.hasOlder).toBe(true);
    expect(setup.runtime).toMatchObject({
      historyCursor: 'cursor-2', historyHasOlder: true, fullHistoryHydrated: false,
      historyLoadingOlder: false,
    });
  });

  it('publishes loading state before an older-history request settles', async () => {
    let resolve!: (value: unknown) => void;
    const deferred = new Promise((done) => { resolve = done; });
    const setup = createController({ historyCursor: 'cursor' });
    setup.respond('thread/turns/list', deferred);

    const load = setup.controller.loadOlderHistory('thread-1');
    await vi.waitFor(() => expect(setup.request).toHaveBeenCalledOnce());

    expect(setup.host.patchRuntime).toHaveBeenNthCalledWith(1, 'thread-1', {
      historyLoadingOlder: true, error: null,
    });
    expect(setup.runtime.historyLoadingOlder).toBe(true);
    resolve({ data: [], nextCursor: null });
    await load;
    expect(setup.runtime.historyLoadingOlder).toBe(false);
  });

  it('skips duplicate-only pages until it finds new messages', async () => {
    const existing = userSurfaceMessage('existing', 'known', 'Existing');
    const setup = createController({
      historyCursor: 'cursor-1', turnIds: ['known'], messages: [existing],
    });
    setup.respond('thread/turns/list', { data: [turnWithUser('known', 'Existing')], nextCursor: 'cursor-2' });
    setup.respond('thread/turns/list', { data: [turnWithUser('older', 'Older')], nextCursor: null });

    const result = await setup.controller.loadOlderHistory('thread-1');

    expect(result.messages).toEqual([expect.objectContaining({ turnId: 'older' })]);
    expect(setup.request).toHaveBeenCalledTimes(2);
    expect(setup.host.emitHistoryPrepended).toHaveBeenCalledTimes(1);
  });

  it('rejects a repeated history cursor and restores loading state with an error', async () => {
    const setup = createController({ historyCursor: 'repeat' });
    setup.respond('thread/turns/list', { data: [], nextCursor: 'repeat' });

    await expect(setup.controller.loadOlderHistory('thread-1'))
      .rejects.toThrow("repeated a thread history cursor for 'thread-1'");

    expect(setup.runtime.historyLoadingOlder).toBe(false);
    expect(setup.runtime.error).toContain('repeated a thread history cursor');
  });

  it('shares an active older-history load and allows a new load after forget', async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveReplacement!: (value: unknown) => void;
    const deferred = new Promise((done) => { resolveFirst = done; });
    const replacementDeferred = new Promise((done) => { resolveReplacement = done; });
    const setup = createController({ historyCursor: 'cursor' });
    setup.respond('thread/turns/list', deferred);

    const first = setup.controller.loadOlderHistory('thread-1');
    const second = setup.controller.loadOlderHistory('thread-1');
    expect(second).toBe(first);
    expect(setup.request).toHaveBeenCalledOnce();

    setup.controller.forget('thread-1');
    setup.respond('thread/turns/list', replacementDeferred);
    const replacement = setup.controller.loadOlderHistory('thread-1');
    expect(replacement).not.toBe(first);
    expect(setup.request).toHaveBeenCalledTimes(2);

    resolveFirst({ data: [], nextCursor: null });
    await first;
    const stillReplacement = setup.controller.loadOlderHistory('thread-1');
    expect(stillReplacement).toBe(replacement);
    resolveReplacement({ data: [turnWithUser('new', 'New')], nextCursor: null });
    await replacement;
  });

  it('reset clears both active history operation caches', async () => {
    let resolveLoad!: (value: unknown) => void;
    const deferredLoad = new Promise((done) => { resolveLoad = done; });
    const setup = createController({ historyCursor: 'cursor' });
    setup.respond('thread/turns/list', deferredLoad);
    const load = setup.controller.loadOlderHistory('thread-1');

    setup.controller.reset();
    setup.respond('thread/turns/list', { data: [], nextCursor: null });
    const replacement = setup.controller.loadOlderHistory('thread-1');
    expect(replacement).not.toBe(load);
    resolveLoad({ data: [], nextCursor: null });
    await Promise.all([load, replacement]);

    setup.runtime.historyCursor = 'hydrate';
    setup.runtime.fullHistoryHydrated = false;
    let resolveHydration!: (value: unknown) => void;
    const deferredHydration = new Promise((done) => { resolveHydration = done; });
    setup.respond('thread/turns/list', deferredHydration);
    const hydration = setup.controller.hydrateCompleteHistory('thread-1');
    setup.controller.reset();
    setup.respond('thread/turns/list', { data: [], nextCursor: null });
    const replacementHydration = setup.controller.hydrateCompleteHistory('thread-1');
    expect(replacementHydration).not.toBe(hydration);
    resolveHydration({ data: [], nextCursor: null });
    await Promise.all([hydration, replacementHydration]);
  });

  it('marks an initial terminal page fully hydrated without requesting history', async () => {
    const setup = createController({ historyCursor: 'old' });
    await setup.controller.hydrateCompleteHistory('thread-1', {
      initialPageLoaded: true, cursor: null,
    });
    expect(setup.runtime).toMatchObject({
      historyCursor: null, historyHasOlder: false, fullHistoryHydrated: true,
    });
    expect(setup.host.patchRuntime).toHaveBeenCalledExactlyOnceWith('thread-1', {
      historyCursor: null, historyHasOlder: false, fullHistoryHydrated: true,
    });
    expect(setup.request).not.toHaveBeenCalled();
  });

  it('does not rehydrate complete history unless restart is requested', async () => {
    const setup = createController({ fullHistoryHydrated: true, historyCursor: null });
    await setup.controller.hydrateCompleteHistory('thread-1');
    expect(setup.request).not.toHaveBeenCalled();
    expect(setup.host.patchRuntime).not.toHaveBeenCalled();

    setup.respond('thread/turns/list', { data: [turnWithUser('restart', 'Restart')], nextCursor: null });
    await setup.controller.hydrateCompleteHistory('thread-1', { restart: true });
    expect(setup.request).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'thread-1', cursor: null, limit: 50, sortDirection: 'desc', itemsView: 'full',
    });
    expect(setup.runtime.fullHistoryHydrated).toBe(true);
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('thread-1', {
      historyCursor: null, historyHasOlder: false, fullHistoryHydrated: true,
    });
    expect(setup.host.patchRuntime).toHaveBeenLastCalledWith('thread-1', {
      fullHistoryHydrated: true, historyHasOlder: false,
    });
  });

  it('restarts with a reversed initial page and records its next-page state before continuing', async () => {
    const setup = createController({ historyCursor: null, messages: [], turnIds: [] });
    setup.respond('thread/turns/list', {
      data: [turnWithUser('second', 'Second'), turnWithUser('first', 'First')],
      nextCursor: 'next',
    });
    setup.respond('thread/turns/list', { data: [], nextCursor: null });

    await setup.controller.hydrateCompleteHistory('thread-1', { restart: true });

    expect(setup.runtime.turnIds).toStrictEqual(['first', 'second']);
    expect(setup.runtime.messages.map((message) => message.turnId)).toStrictEqual(['first', 'second']);
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('thread-1', {
      historyCursor: 'next', historyHasOlder: true, fullHistoryHydrated: false,
    });
    expect(setup.request).toHaveBeenCalledTimes(2);
  });

  it('shares an active full-history hydration and forget allows a replacement without an old cleanup race', async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveReplacement!: (value: unknown) => void;
    const firstResponse = new Promise((done) => { resolveFirst = done; });
    const replacementResponse = new Promise((done) => { resolveReplacement = done; });
    const setup = createController({ historyCursor: 'cursor' });
    setup.respond('thread/turns/list', firstResponse);

    const first = setup.controller.hydrateCompleteHistory('thread-1');
    expect(setup.controller.hydrateCompleteHistory('thread-1')).toBe(first);
    setup.controller.forget('thread-1');
    setup.respond('thread/turns/list', replacementResponse);
    const replacement = setup.controller.hydrateCompleteHistory('thread-1');
    expect(replacement).not.toBe(first);

    resolveFirst({ data: [], nextCursor: null });
    await first;
    setup.runtime.fullHistoryHydrated = false;
    setup.runtime.historyCursor = 'replacement';
    expect(setup.controller.hydrateCompleteHistory('thread-1')).toBe(replacement);
    resolveReplacement({ data: [], nextCursor: null });
    await replacement;
  });

  it('hydrates from an explicit cursor and marks the surviving runtime complete', async () => {
    const setup = createController({ historyCursor: null });
    setup.respond('thread/turns/list', { data: [turnWithUser('old', 'Old')], nextCursor: null });

    await setup.controller.hydrateCompleteHistory('thread-1', { cursor: 'cursor-1' });

    expect(paramsFor(setup.request, 'thread/turns/list')).toMatchObject({ cursor: 'cursor-1', limit: 25 });
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('thread-1', {
      historyCursor: 'cursor-1', historyHasOlder: true,
    });
    expect(setup.runtime).toMatchObject({
      fullHistoryHydrated: true, historyHasOlder: false, historyCursor: null,
    });
  });

  it('records an explicit null hydration cursor as having no older history', async () => {
    const setup = createController({ historyCursor: 'old' });

    await setup.controller.hydrateCompleteHistory('thread-1', { cursor: null });

    expect(setup.host.patchRuntime).toHaveBeenNthCalledWith(1, 'thread-1', {
      historyCursor: null, historyHasOlder: false,
    });
    expect(setup.request).not.toHaveBeenCalled();
  });

  it('records hydration failure only while the runtime still exists', async () => {
    const setup = createController({ historyCursor: 'cursor' });
    setup.reject('thread/turns/list', 'offline');
    await expect(setup.controller.hydrateCompleteHistory('thread-1')).rejects.toBe('offline');
    expect(setup.runtime.error).toBe('Could not load complete conversation history: offline');

    const removed = createController({ historyCursor: 'cursor' });
    removed.reject('thread/turns/list', new Error('gone'));
    removed.host.runtime.mockReturnValue(undefined);
    await expect(removed.controller.hydrateCompleteHistory('thread-1')).rejects.toThrow('gone');
    expect(removed.host.patchRuntime).not.toHaveBeenCalledWith('thread-1', expect.objectContaining({ error: expect.anything() }));
  });

  it('refreshes complete history from the first page and waits out an existing hydration failure', async () => {
    const setup = createController({ historyCursor: 'cursor' });
    setup.reject('thread/turns/list', new Error('first failure'));
    const first = setup.controller.hydrateCompleteHistory('thread-1');
    await expect(first).rejects.toThrow('first failure');

    setup.respond('thread/turns/list', { data: [turnWithUser('fresh', 'Fresh')], nextCursor: null });
    await setup.controller.refreshCompleteHistory('thread-1');

    expect(setup.runtime).toMatchObject({
      fullHistoryHydrated: true, historyCursor: null, historyHasOlder: false,
    });
    expect(setup.request).toHaveBeenLastCalledWith('thread/turns/list', {
      threadId: 'thread-1', cursor: null, limit: 50, sortDirection: 'desc', itemsView: 'full',
    });
  });

  it('waits for active hydration before starting a refresh restart', async () => {
    let resolve!: (value: unknown) => void;
    const deferred = new Promise((done) => { resolve = done; });
    const setup = createController({ historyCursor: 'cursor' });
    setup.respond('thread/turns/list', deferred);
    const hydration = setup.controller.hydrateCompleteHistory('thread-1');
    const refresh = setup.controller.refreshCompleteHistory('thread-1');
    await Promise.resolve();
    expect(setup.request).toHaveBeenCalledTimes(1);

    setup.respond('thread/turns/list', { data: [], nextCursor: null });
    resolve({ data: [], nextCursor: null });
    await Promise.all([hydration, refresh]);

    expect(setup.request).toHaveBeenCalledTimes(2);
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('thread-1', {
      fullHistoryHydrated: false, historyCursor: null, historyHasOlder: true,
    });
  });

  it('waits for active history emission and swallows its rejection', async () => {
    let reject!: (error: Error) => void;
    const deferred = new Promise((_resolve, fail) => { reject = fail; });
    const setup = createController({ historyCursor: 'cursor' });
    setup.respond('thread/turns/list', deferred);
    const load = setup.controller.loadOlderHistory('thread-1');
    const waited = setup.controller.waitForHistoryEmission('thread-1');
    reject(new Error('failed'));
    await expect(waited).resolves.toBeUndefined();
    await expect(load).rejects.toThrow('failed');
    await expect(setup.controller.waitForHistoryEmission('other')).resolves.toBeUndefined();
  });

  it('preserves an active turn while replacing stale history for the same turn', async () => {
    const active = assistantSurfaceMessage('active-message', 'active', 'Streaming');
    const setup = createController({
      activeTurnId: 'active', historyCursor: 'cursor', turnIds: ['active'], messages: [active],
    });
    setup.respond('thread/turns/list', {
      data: [turnWithUser('active', 'Stale', 'completed'), turnWithUser('old', 'Old')],
      nextCursor: null,
    });

    await setup.controller.loadOlderHistory('thread-1');

    expect(setup.runtime.turnIds).toStrictEqual(['old', 'active']);
    expect(setup.runtime.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'active-message', parts: [{ type: 'text', text: 'Streaming' }] }),
      expect.objectContaining({ turnId: 'old' }),
    ]));
  });

  it('replaces a known completed turn instead of protecting it as active', async () => {
    const stale = userSurfaceMessage('stale', 'known', 'Stale');
    const setup = createController({
      historyCursor: 'cursor', turnIds: ['known'], messages: [stale],
    });
    setup.respond('thread/turns/list', {
      data: [turnWithUser('known', 'Fresh', 'completed')], nextCursor: null,
    });

    await setup.controller.loadOlderHistory('thread-1');

    expect(setup.runtime.turnIds).toStrictEqual(['known']);
    expect(setup.runtime.messages).toEqual([
      expect.objectContaining({
        id: 'user-thread-1-known-user-known',
        parts: [{ type: 'text', text: 'Fresh' }],
      }),
    ]);
  });

  it('preserves a known in-progress turn and messages without turn IDs', async () => {
    const running = assistantSurfaceMessage('running-message', 'running', 'Streaming');
    const global = { ...assistantSurfaceMessage('global', 'ignored', 'Global'), turnId: undefined };
    const setup = createController({
      historyCursor: 'cursor', turnIds: ['running'], messages: [global, running],
    });
    setup.respond('thread/turns/list', {
      data: [turnWithUser('running', 'Stale', 'inProgress')], nextCursor: null,
    });

    await setup.controller.loadOlderHistory('thread-1');

    expect(setup.runtime.turnIds).toStrictEqual(['running']);
    expect(setup.runtime.messages).toStrictEqual([global, running]);
  });

  it('does not update another conversation summary while merging history', async () => {
    const setup = createController({ historyCursor: 'cursor' });
    setup.state.conversations = [summary('other'), summary('thread-1')];
    setup.respond('thread/turns/list', { data: [turnWithUser('old', 'Old')], nextCursor: null });

    await setup.controller.loadOlderHistory('thread-1');

    expect(setup.state.conversations).toStrictEqual([
      summary('other'),
      { ...summary('thread-1'), turnCount: 1 },
    ]);
    expect(setup.host.emitSummaryUpserted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'thread-1' }), 'updated', 'action',
    );
  });

  it('does not emit a summary when history belongs to an unlisted runtime', async () => {
    const setup = createController({ historyCursor: 'cursor' });
    setup.state.conversations = [];
    setup.respond('thread/turns/list', { data: [turnWithUser('old', 'Old')], nextCursor: null });

    await setup.controller.loadOlderHistory('thread-1');

    expect(setup.state.conversations).toStrictEqual([]);
    expect(setup.host.emitSummaryUpserted).not.toHaveBeenCalled();
  });

  it('does not finalize hydration if its runtime disappears after paging', async () => {
    const setup = createController({ historyCursor: null });
    setup.host.runtime
      .mockReturnValueOnce(setup.runtime)
      .mockReturnValueOnce(undefined);

    await expect(setup.controller.hydrateCompleteHistory('thread-1'))
      .resolves.toBeUndefined();

    expect(setup.host.patchRuntime).not.toHaveBeenCalled();
  });

  it('does not mask a paging failure with cleanup after the runtime disappears', async () => {
    const setup = createController({ historyCursor: 'cursor' });
    setup.host.runtime.mockReturnValue(undefined);
    setup.reject('thread/turns/list', new Error('request failed'));
    let patches = 0;
    setup.host.patchRuntime.mockImplementation(() => {
      patches += 1;
      if (patches > 1) throw new Error('missing runtime');
    });

    await expect(setup.controller.loadOlderHistory('thread-1')).rejects.toThrow('request failed');

    expect(setup.host.patchRuntime).toHaveBeenCalledTimes(1);
  });

  it('emits long history in chronological batches of at most 25 messages', async () => {
    const setup = createController({ historyCursor: 'cursor' });
    setup.respond('thread/turns/list', {
      data: Array.from({ length: 26 }, (_, index) => turnWithUser(`turn-${25 - index}`, `Text ${25 - index}`)),
      nextCursor: null,
    });

    await setup.controller.loadOlderHistory('thread-1');

    expect(setup.host.emitHistoryPrepended).toHaveBeenCalledTimes(2);
    expect(setup.host.emitHistoryPrepended.mock.calls[0]?.[1]).toHaveLength(25);
    expect(setup.host.emitHistoryPrepended.mock.calls[1]?.[1]).toHaveLength(1);
    expect((setup.host.emitHistoryPrepended.mock.calls[0]?.[1] as SurfaceMessage[])[0]?.turnId).toBe('turn-1');
    expect((setup.host.emitHistoryPrepended.mock.calls[1]?.[1] as SurfaceMessage[])[0]?.turnId).toBe('turn-0');
  });
});

type SetupOptions = {
  activeTurnId?: string | null;
  conversationLimit?: number;
  fullHistoryHydrated?: boolean;
  historyCursor?: string | null;
  hydrated?: boolean;
  messages?: SurfaceMessage[];
  turnIds?: string[];
};

function createController(options: SetupOptions = {}) {
  const state = initialSurfaceSnapshot(initialAuthentication());
  state.activeConversationId = 'thread-1';
  state.conversations = [summary('thread-1')];
  const runtime = createThreadRuntime('thread-1', state, {
    activeTurnId: options.activeTurnId ?? null,
    fullHistoryHydrated: options.fullHistoryHydrated ?? false,
    historyCursor: options.historyCursor === undefined ? null : options.historyCursor,
    historyHasOlder: options.historyCursor !== null && options.historyCursor !== undefined,
    hydrated: options.hydrated ?? false,
    messages: options.messages ?? [],
    turnIds: options.turnIds ?? [],
  });
  const runtimes = new Map([['thread-1', runtime]]);
  const responseQueues = new Map<string, unknown[]>();
  const rejectionQueues = new Map<string, unknown[]>();
  const request = vi.fn(async (method: string): Promise<unknown> => {
    const rejections = rejectionQueues.get(method);
    if (rejections?.length) throw rejections.shift();
    const responses = responseQueues.get(method);
    if (responses?.length) return await responses.shift();
    if (method === 'thread/list') return { data: [], nextCursor: null };
    return {};
  });
  const host = {
    emitHistoryReplaced: vi.fn(),
    emitHistoryPrepended: vi.fn(),
    emitSummaryUpserted: vi.fn(),
    ensureConnected: vi.fn(async () => undefined),
    getSnapshot: vi.fn(() => state),
    getState: vi.fn(() => state),
    patch: vi.fn((patch: Partial<CodexSurfaceSnapshot>) => Object.assign(state, patch)),
    patchRuntime: vi.fn((threadId: string, patch: object) => {
      const target = runtimes.get(threadId);
      if (target) Object.assign(target, patch);
    }),
    removeThread: vi.fn(),
    requireRuntime: vi.fn((threadId: string) => {
      const target = runtimes.get(threadId);
      if (!target) throw new Error(`missing ${threadId}`);
      return target;
    }),
    runtime: vi.fn((threadId: string) => runtimes.get(threadId)),
    schedulePluginRefresh: vi.fn(),
  };
  const controller = new CodexSurfaceConversationsController(
    { request } as unknown as CodexAppServerClient,
    options.conversationLimit,
    host,
  );
  return {
    controller,
    host,
    request,
    runtime,
    state,
    respond(method: string, response: unknown) {
      responseQueues.set(method, [...(responseQueues.get(method) ?? []), response]);
    },
    reject(method: string, error: unknown) {
      rejectionQueues.set(method, [...(rejectionQueues.get(method) ?? []), error]);
    },
  };
}

function summary(id: string) {
  return {
    id, title: id, preview: '', cwd: '/workspace', status: 'idle' as const, turnCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function threadWith(id: string, overrides: Record<string, unknown> = {}) {
  return { ...thread(id, false), preview: id, ...overrides };
}

function turnWithUser(id: string, text: string, status: v2.TurnStatus = 'completed') {
  return turn(id, status, [{
    type: 'userMessage', id: `user-${id}`, clientId: null,
    content: [{ type: 'text', text, text_elements: [] }],
  }]);
}

function userSurfaceMessage(id: string, turnId: string, text: string): SurfaceMessage {
  return {
    id, role: 'user', status: 'complete', turnId, parts: [{ type: 'text', text }],
    metadata: { conversationId: 'thread-1', turnId },
  };
}

function assistantSurfaceMessage(id: string, turnId: string, text: string): SurfaceMessage {
  return {
    id, role: 'assistant', status: 'streaming', turnId, parts: [{ type: 'text', text }],
    metadata: { conversationId: 'thread-1', turnId },
  };
}

function paramsFor(request: ReturnType<typeof vi.fn>, method: string): unknown {
  return request.mock.calls.find(([candidate]) => candidate === method)?.[1];
}
