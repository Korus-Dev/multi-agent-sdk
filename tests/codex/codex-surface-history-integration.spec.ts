import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk/protocol';
import { CodexSurface } from '../../src/providers/codex';
import { createCodexConversationReplica } from '@korus-dev/multi-agent-sdk/core';
import type { CodexSurfaceEvent, SurfaceMessage } from '@korus-dev/multi-agent-sdk/surface';
import { MockCodexAppServer, createSurface, deferred, lastRequest, resumeResponse, thread, turn } from './helpers/codex-surface-fixture';

function historyTurn(id: string, index: number): v2.Turn {
  return turn(id, 'completed', [
    { type: 'userMessage', id: `${id}-user-1`, clientId: null, content: [{ type: 'text', text: `Older ${index} request`, text_elements: [] }] },
    { type: 'agentMessage', id: `${id}-agent-1`, text: `Older ${index} first reply`, phase: null, memoryCitation: null, delivery: null, questions: null },
    { type: 'userMessage', id: `${id}-user-2`, clientId: null, content: [{ type: 'text', text: `Older ${index} follow-up`, text_elements: [] }] },
    { type: 'agentMessage', id: `${id}-agent-2`, text: `Older ${index} second reply`, phase: null, memoryCitation: null, delivery: null, questions: null },
    { type: 'userMessage', id: `${id}-user-3`, clientId: null, content: [{ type: 'text', text: `Older ${index} last request`, text_elements: [] }] },
    { type: 'agentMessage', id: `${id}-agent-3`, text: `Older ${index} last reply`, phase: null, memoryCitation: null, delivery: null, questions: null },
  ]);
}

describe('CodexSurface', () => {
  it('loads summaries, hydrates one turn on demand, and upgrades a shared window without resetting live work', async () => {
    const full = ['first', 'second', 'older'].map((id, i) => historyTurn(id, i));
    const summary = full.map(value => ({ ...value, itemsView: 'summary' as const, items: [value.items[0]!, value.items.at(-1)!] }));
    const pending = deferred<v2.ThreadItemsListResponse>(); const olderPage = deferred<v2.ThreadTurnsListResponse>(); let firstRequest = true;
    const transport = new MockCodexAppServer({
      'thread/resume': () => ({ ...resumeResponse({ ...thread('thread-existing', false), turns: summary.slice(0, 2) }), initialTurnsPage: { data: summary.slice(0, 2).reverse(), nextCursor: 'older', backwardsCursor: null } }),
      'thread/items/list': params => {
        if (firstRequest) { firstRequest = false; return pending.promise; }
        const value = full.find(value => value.id === params.turnId)!;
        const items = params.cursor ? value.items.slice(3) : value.items.slice(0, 3);
        return { data: items.map(item => ({ turnId: value.id, item, startedAtMs: null, completedAtMs: null })), nextCursor: params.cursor ? null : 'more', backwardsCursor: null };
      },
      'thread/turns/list': params => params.itemsView === 'summary' ? olderPage.promise : ({ data: [full[2]!], nextCursor: null, backwardsCursor: null }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport), historyItemsView: 'summary' });
    try {
      await surface.connect(); const handle = surface.conversation('thread-existing');
      const replica = createCodexConversationReplica(handle.getSnapshot());
      surface.onConversationEvent(handle.id, event => replica.apply(event));
      expect(lastRequest(transport, 'thread/resume')).toMatchObject({ params: { initialTurnsPage: { itemsView: 'summary' } } });
      expect(handle.getSnapshot().turns).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'first', itemsView: 'summary' })]));
      expect(transport.sent.filter(m => 'method' in m && m.method === 'thread/items/list')).toHaveLength(0);
      const loading = handle.loadTurnHistory('first');
      await vi.waitFor(() => expect(replica.getSnapshot().turns.find(t => t.id === 'first')?.detailsLoading).toBe(true));
      pending.reject(new Error('Read disconnected'));
      await expect(loading).rejects.toThrow('Read disconnected');
      expect(replica.getSnapshot().turns.find(t => t.id === 'first')).toMatchObject({ itemsView: 'summary', detailsLoading: false, detailsError: 'Read disconnected' });
      const usage = (turnId: string, total: number) => transport.emitNotification('thread/tokenUsage/updated', { threadId: handle.id, turnId,
        tokenUsage: { total: { totalTokens: total, inputTokens: total, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
          last: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }, modelContextWindow: 2000 } });
      usage('second', 100);
      transport.emitNotification('turn/started', { threadId: handle.id, turn: turn('live', 'inProgress', []) });
      usage('live', 150);
      await Promise.all([handle.loadTurnHistory('first'), handle.loadTurnHistory('first')]);
      expect(handle.getSnapshot().turns.find(t => t.id === 'first')).toMatchObject({ itemsView: 'full', detailsLoading: false, detailsError: null });
      const reads = () => transport.sent.filter(m => 'method' in m && m.method === 'thread/items/list');
      usage('live', 200);
      expect(handle.getSnapshot().turns.find(t => t.id === 'live')?.executionUsage?.execution?.totalTokens).toBe(100);
      expect(reads()).toHaveLength(3); // One failed read, then two shared detail pages.
      await handle.loadTurnHistory('first'); expect(reads()).toHaveLength(3);
      expect(handle.getSnapshot().messages.filter(m => m.turnId === 'first' && m.role === 'user')).toHaveLength(3);
      const paging = handle.loadOlderHistory();
      await vi.waitFor(() => expect(lastRequest(transport, 'thread/turns/list')).toMatchObject({ params: { itemsView: 'summary' } }));
      const upgrading = handle.load({ historyItemsView: 'full' });
      await vi.waitFor(() => expect(handle.getSnapshot().historyState?.itemsView).not.toBe('summary'));
      olderPage.resolve({ data: [summary[2]!], nextCursor: null, backwardsCursor: null });
      await Promise.all([paging, upgrading]);
      expect(handle.getSnapshot()).toMatchObject({ busy: true, activeTurnId: 'live', historyState: { hasOlder: false } });
      expect(handle.getSnapshot().turns.find(t => t.id === 'second')?.itemsView).toBe('full');
      expect(transport.sent.filter(m => 'method' in m && m.method === 'thread/resume')).toHaveLength(1);
      await handle.loadOlderHistory();
      expect(lastRequest(transport, 'thread/turns/list')).toMatchObject({ params: { cursor: 'older', itemsView: 'full' } });
      await handle.load({ historyItemsView: 'summary' });
      expect(handle.getSnapshot().turns.find(t => t.id === 'first')?.itemsView).toBe('full');
      expect(replica.getSnapshot().messages).toEqual(handle.getSnapshot().messages);
    } finally { await surface.close(); }
  });

  it('materializes a resumed active turn while keeping exports full and future UI pages in summary mode', async () => {
    const full = [historyTurn('past', 0), { ...historyTurn('running', 1), status: 'inProgress' as const }];
    const summaries = full.map(value => ({ ...value, itemsView: 'summary' as const, items: [value.items[0]!, value.items.at(-1)!] }));
    const transport = new MockCodexAppServer({
      'thread/resume': () => resumeResponse({ ...thread('thread-existing', false), status: { type: 'active', activeFlags: [] }, turns: summaries }),
      'thread/read': () => ({ thread: thread('thread-existing', false), readState: null }),
      'thread/items/list': params => ({ data: full.find(value => value.id === params.turnId)!.items.map(item => ({ turnId: params.turnId!, item, startedAtMs: null, completedAtMs: null })), nextCursor: null, backwardsCursor: null }),
      'thread/turns/list': () => ({ data: [...full].reverse().map(value => ({ ...value, status: 'completed' as const })), nextCursor: null, backwardsCursor: null }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport), historyItemsView: 'summary' });
    try {
      await surface.connect(); const handle = surface.conversation('thread-existing');
      expect(handle.getSnapshot()).toMatchObject({ activeTurnId: 'running', busy: true });
      expect(handle.getSnapshot().turns.find(value => value.id === 'running')?.itemsView).not.toBe('summary');
      expect(handle.getSnapshot().messages.filter(value => value.turnId === 'running' && value.role === 'user')).toHaveLength(3);
      expect(handle.getSnapshot().messages.filter(value => value.turnId === 'past' && value.role === 'user')).toHaveLength(1);
      transport.emitNotification('item/agentMessage/delta', { threadId: handle.id, turnId: 'running', itemId: 'streaming', delta: 'Still working' });
      expect(JSON.stringify(handle.getSnapshot().messages)).toContain('Still working');
      transport.emitNotification('turn/completed', { threadId: handle.id, turn: { ...full[1]!, status: 'completed' } });
      const exported = await handle.readHistory();
      expect(lastRequest(transport, 'thread/turns/list')).toMatchObject({ params: { itemsView: 'full' } });
      expect(exported.messages.filter(value => value.turnId === 'past' && value.role === 'user')).toHaveLength(3);
      expect(handle.getSnapshot().historyState?.itemsView).toBe('summary');
      await handle.load({ cwd: '/fresh' });
      expect(handle.getSnapshot().messages.filter(value => value.turnId === 'past' && value.role === 'user')).toHaveLength(3);
      expect(handle.getSnapshot().turns.find(value => value.id === 'past')?.itemsView).toBe('full');
    } finally { await surface.close(); }
  });

  it.each([false, true])('keeps streamed items whole across steering and reload (subsequent item: %s)', async (subsequentItem) => {
    const history = thread('thread-existing', true);
    const transport = new MockCodexAppServer({
      'thread/resume': () => resumeResponse(history),
      'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
      'turn/steer': () => ({ turnId: 'turn-live' }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport), cwd: '/tmp/project' });
    await surface.connect();
    const selected = await surface.selectConversation('thread-existing');
    const replica = createCodexConversationReplica(surface.conversation('thread-existing').getSnapshot());
    surface.onEvent((event) => {
      if ('conversationId' in event && event.conversationId === 'thread-existing') replica.apply(event);
    });
    expect(selected.messages.map((message) => message.parts[0])).toMatchObject([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'Hi there' },
    ]);

    await surface.sendMessage('  Build the UI  ');
    expect(surface.getSnapshot().messages.at(-1)).toMatchObject({
      id: 'assistant-turn-live',
      role: 'assistant',
      status: 'streaming',
      parts: [],
    });
    const turnRequest = lastRequest(transport, 'turn/start');
    expect(turnRequest).toMatchObject({
      method: 'turn/start',
      params: { threadId: 'thread-existing', input: [{ type: 'text', text: 'Build the UI' }] },
    });
    transport.emitNotification('item/agentMessage/delta', { threadId: 'thread-existing', turnId: 'turn-live', itemId: 'agent-live', delta: 'Working **on' });
    await surface.steerMessage('Focus on the renderer');
    expect(lastRequest(transport, 'turn/steer')).toMatchObject({
      params: {
        threadId: 'thread-existing', expectedTurnId: 'turn-live',
        input: [{ type: 'text', text: 'Focus on the renderer' }],
      },
    });

    transport.emitNotification('item/agentMessage/delta', { threadId: 'thread-existing', turnId: 'turn-live', itemId: 'agent-live', delta: ' the renderer**.\n\n```ts\nconst' });
    const liveText = (messages: readonly SurfaceMessage[]) => messages.filter(message => message.turnId === 'turn-live')
      .flatMap(message => message.parts).filter(part => part.type === 'text' && part.itemId === 'agent-live');
    expect(liveText(surface.getSnapshot().messages)).toEqual([
      { type: 'text', text: 'Working **on the renderer**.\n\n```ts\nconst', itemId: 'agent-live' },
    ]);
    expect(liveText(replica.getSnapshot().messages)).toEqual(liveText(surface.getSnapshot().messages));
    await surface.steerMessage('And preserve paragraphs');
    transport.emitNotification('item/agentMessage/delta', { threadId: 'thread-existing', turnId: 'turn-live', itemId: 'agent-live', delta: ' value = 1;\n```' });
    transport.emitNotification('item/completed', {
      threadId: 'thread-existing', turnId: 'turn-live', completedAtMs: 1_000,
      item: { type: 'agentMessage', id: 'agent-live', text: 'Working **on the renderer**.\n\n```ts\nconst value = 1;\n```\n\nDone.', phase: null, memoryCitation: null, delivery: null, questions: null },
    });
    expect(liveText(replica.getSnapshot().messages)).toEqual([
      { type: 'text', text: 'Working **on the renderer**.\n\n```ts\nconst value = 1;\n```\n\nDone.', itemId: 'agent-live' },
    ]);
    if (subsequentItem) {
      transport.emitNotification('item/agentMessage/delta', { threadId: 'thread-existing', turnId: 'turn-live', itemId: 'agent-next', delta: 'Following the new direction.' });
      const liveMessages = surface.getSnapshot().messages.filter(message => message.turnId === 'turn-live');
      expect(liveMessages.findIndex(message => message.parts.some(part => part.type === 'text' && part.itemId === 'agent-next')))
        .toBeGreaterThan(liveMessages.map(message => message.kind === 'steer').lastIndexOf(true));
    }
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-live', 'completed', []) });

    const snapshot = surface.getSnapshot();
    const conversationSnapshot = surface.conversation('thread-existing').getSnapshot();
    expect(snapshot).toMatchObject({ busy: false, error: null });
    expect(snapshot.messages.some(message => message.role === 'assistant' && message.parts.length === 0)).toBe(false);
    expect(snapshot.messages.find((message) => (
      message.role === 'assistant'
      && message.parts.some((part) => part.type === 'text' && part.itemId === 'agent-live')
    ))).toMatchObject({
      role: 'assistant',
      status: 'complete',
      parts: [{ type: 'text', text: 'Working **on the renderer**.\n\n```ts\nconst value = 1;\n```\n\nDone.', itemId: 'agent-live' }],
    });
    expect(replica.getSnapshot()).toMatchObject({
      activeTurnId: conversationSnapshot.activeTurnId,
      busy: conversationSnapshot.busy,
      error: conversationSnapshot.error,
      turnIds: conversationSnapshot.turnIds,
      turns: conversationSnapshot.turns,
    });
    expect(messagesWithoutCreatedAt(replica.getSnapshot().messages))
      .toStrictEqual(messagesWithoutCreatedAt(conversationSnapshot.messages));

    const turnMessages = conversationSnapshot.messages.filter(message => message.turnId === 'turn-live');
    const users = turnMessages.filter(message => message.role === 'user');
    const userItem = (id: string, index: number, text: string): v2.ThreadItem => ({
      type: 'userMessage', id, clientId: users[index]!.id,
      content: [{ type: 'text', text, text_elements: [] }],
    });
    history.turns.push(turn('turn-live', 'completed', [
      userItem('initial', 0, 'Build the UI'),
      { type: 'agentMessage', id: 'agent-live', text: 'Working **on the renderer**.\n\n```ts\nconst value = 1;\n```\n\nDone.', phase: null, memoryCitation: null, delivery: null, questions: null },
      userItem('steer-one', 1, 'Focus on the renderer'),
      userItem('steer-two', 2, 'And preserve paragraphs'),
      ...(subsequentItem ? [{ type: 'agentMessage' as const, id: 'agent-next', text: 'Following the new direction.', phase: null, memoryCitation: null, delivery: null, questions: null }] : []),
    ]));
    await surface.conversation('thread-existing').load();
    expect(liveText(surface.getSnapshot().messages)).toEqual(liveText(conversationSnapshot.messages));
    expect(liveText(replica.getSnapshot().messages)).toEqual(liveText(conversationSnapshot.messages));
    expect(surface.getSnapshot().messages.filter(message => message.turnId === 'turn-live' && message.kind === 'steer')).toHaveLength(2);
    await surface.close();
  });

  it.each(['eager', 'switch'] as const)('renders a bounded page before background hydration (%s)', async (strategy) => {
    const firstTurn = turn('turn-first', 'completed', [
      { type: 'userMessage', id: 'user-first', clientId: null, content: [{ type: 'text', text: 'First', text_elements: [] }] },
      {
        type: 'commandExecution', id: 'command-first', pluginId: null, scriptPath: null,
        command: 'npm test', cwd: '/tmp/project', processId: null,
        source: 'unifiedExecInteraction', status: 'completed', commandActions: [], aggregatedOutput: 'passed', exitCode: 0,
        durationMs: 20,
      },
      { type: 'agentMessage', id: 'agent-first', text: 'First reply', phase: null, memoryCitation: null, delivery: null, questions: null },
    ]);
    const secondTurn = turn('turn-second', 'completed', [
      { type: 'userMessage', id: 'user-second', clientId: null, content: [{ type: 'text', text: 'Second', text_elements: [] }] },
      {
        type: 'commandExecution', id: 'command-second', pluginId: null, scriptPath: null,
        command: 'npm run build', cwd: '/tmp/project', processId: null,
        source: 'unifiedExecInteraction', status: 'completed', commandActions: [], aggregatedOutput: 'passed', exitCode: 0,
        durationMs: 20,
      },
      { type: 'agentMessage', id: 'agent-second', text: 'Second reply', phase: null, memoryCitation: null, delivery: null, questions: null },
    ]);
    const remainingFullPage = deferred<v2.ThreadTurnsListResponse>();
    const transport = new MockCodexAppServer({
      'thread/resume': (params) => ({
        ...resumeResponse(thread(String((params as { threadId: string }).threadId), false)),
        initialTurnsPage: { data: [secondTurn], nextCursor: 'remaining-page-2', backwardsCursor: null },
      }),
      'thread/turns/list': (params) => {
        const cursor = (params as { cursor: string | null }).cursor;
        expect(params).toMatchObject({
          threadId: 'thread-existing', limit: 25, sortDirection: 'desc', itemsView: 'full',
        });
        return cursor === 'remaining-page-2'
          ? remainingFullPage.promise
          : { data: [firstTurn], nextCursor: null, backwardsCursor: null };
      },
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport), loadingStrategy: strategy === 'switch' ? 'lazy' : 'eager' });
    const historyEvents: CodexSurfaceEvent[] = [];
    const historyPrependedEvents: CodexSurfaceEvent[] = [];
    surface.onEvent((event) => {
      if (event.type === 'conversation.historyReplaced') historyEvents.push(event);
      if (event.type === 'conversation.historyPrepended') historyPrependedEvents.push(event);
    });

    const snapshot = await surface.connect();

    expect(snapshot.messages.flatMap((message) => message.parts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'Second' }),
      expect.objectContaining({ type: 'tool', id: 'command-second', kind: 'command' }),
      expect.objectContaining({ type: 'text', text: 'Second reply' }),
    ]));
    if (strategy === 'switch') await surface.conversation('thread-existing').load({ loadingStrategy: 'eager' });
    remainingFullPage.resolve({ data: [firstTurn], nextCursor: null, backwardsCursor: null });
    await vi.waitFor(() => expect(surface.getSnapshot().messages.flatMap((message) => message.parts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'First' }),
      expect.objectContaining({ type: 'tool', id: 'command-first', kind: 'command' }),
      expect.objectContaining({ type: 'text', text: 'Second' }),
      expect.objectContaining({ type: 'tool', id: 'command-second', kind: 'command' }),
      expect.objectContaining({ type: 'text', text: 'Second reply' }),
    ])));
    expect(surface.getSnapshot().conversations[0]).toMatchObject({ id: 'thread-existing', turnCount: 2 });
    expect(transport.sent.filter((message) => (
      'method' in message && message.method === 'thread/turns/list'
    ))).toHaveLength(1);
    expect(historyEvents).toHaveLength(1);
    expect(historyEvents[0]).toMatchObject({
      type: 'conversation.historyReplaced',
      origin: 'action',
      payload: { reason: 'resume' },
    });
    expect(historyPrependedEvents).toHaveLength(1);
    expect(historyPrependedEvents[0]).toMatchObject({
      type: 'conversation.historyPrepended',
      origin: 'lifecycle',
      payload: {
        messages: [
          expect.objectContaining({ id: 'user-thread-existing-turn-first-user-first' }),
          expect.objectContaining({ id: 'assistant-turn-first' }),
        ],
      },
    });
  });

  it('emits chronological non-cumulative batches during background hydration', async () => {
    const initialTurn = turn('turn-initial', 'completed', [
      { type: 'userMessage', id: 'user-initial', clientId: null, content: [{ type: 'text', text: 'Initial', text_elements: [] }] },
      { type: 'agentMessage', id: 'agent-initial', text: 'Initial reply', phase: null, memoryCitation: null, delivery: null, questions: null },
    ]);
    const olderTurns = Array.from({ length: 5 }, (_, index) => historyTurn(`turn-older-${index}`, index));
    const remainingPage = deferred<v2.ThreadTurnsListResponse>();
    const transport = new MockCodexAppServer({
      'thread/resume': () => ({
        ...resumeResponse(thread('thread-existing', false)),
        initialTurnsPage: { data: [initialTurn], nextCursor: 'older-page', backwardsCursor: null },
      }),
      'thread/turns/list': (params) => {
        expect(params).toMatchObject({ threadId: 'thread-existing', cursor: 'older-page', limit: 25 });
        return remainingPage.promise;
      },
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport), loadingStrategy: 'eager' });
    const prepended: Extract<CodexSurfaceEvent, { type: 'conversation.historyPrepended' }>[] = [];
    const replaced: Extract<CodexSurfaceEvent, { type: 'conversation.historyReplaced' }>[] = [];
    surface.onEvent((event) => {
      if (event.type === 'conversation.historyPrepended') prepended.push(event);
      if (event.type === 'conversation.historyReplaced') replaced.push(event);
    });

    const initialSnapshot = await surface.connect();
    expect(initialSnapshot.messages).toHaveLength(2);
    expect(prepended).toHaveLength(0);

    remainingPage.resolve({
      data: [...olderTurns].reverse(),
      nextCursor: null,
      backwardsCursor: null,
    });
    await vi.waitFor(() => expect(prepended).toHaveLength(2));

    expect(prepended.map((event) => event.payload.messages.length)).toEqual([25, 5]);
    expect(prepended.every((event) => {
      const turnIndexes = event.payload.messages.map((message) => {
        const turnId = message.metadata?.turnId;
        return Number(typeof turnId === 'string' ? turnId.split('-').at(-1) : NaN);
      });
      return turnIndexes.every((index, offset, values) => offset === 0 || index >= values[offset - 1]!);
    })).toBe(true);
    const consumerMessages = prepended.reduce<SurfaceMessage[]>(
      (messages, event) => [...event.payload.messages, ...messages],
      [],
    );
    expect(consumerMessages.map((message) => message.metadata?.turnId)).toEqual(
      olderTurns.flatMap((olderTurn) => Array.from({ length: 6 }, () => olderTurn.id)),
    );
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.origin).toBe('action');
    expect(surface.getSnapshot().messages).toHaveLength(32);
  });

  it('keeps older history demand-paged by default', async () => {
    const initialTurn = turn('turn-initial', 'completed', [
      { type: 'userMessage', id: 'user-initial', clientId: null, content: [{ type: 'text', text: 'Initial', text_elements: [] }] },
      { type: 'agentMessage', id: 'agent-initial', text: 'Initial reply', phase: null, memoryCitation: null, delivery: null, questions: null },
    ]);
    const olderTurn = historyTurn('turn-older', 1);
    const oldestTurn = historyTurn('turn-oldest', 0);
    const transport = new MockCodexAppServer({
      'thread/resume': () => ({
        ...resumeResponse(thread('thread-existing', false)),
        initialTurnsPage: { data: [initialTurn], nextCursor: 'older-page', backwardsCursor: null },
      }),
      'thread/read': () => ({ readState: null, thread: thread('thread-existing', false) }),
      'thread/turns/list': (params) => {
        expect(params).toMatchObject({
          threadId: 'thread-existing',
          limit: (params as { cursor: string | null }).cursor === null ? 50 : 25,
        });
        const cursor = (params as { cursor: string | null }).cursor;
        return cursor === null
          ? { data: [initialTurn], nextCursor: 'older-page', backwardsCursor: null }
          : cursor === 'older-page'
            ? { data: [olderTurn], nextCursor: 'oldest-page', backwardsCursor: null }
            : { data: [oldestTurn], nextCursor: null, backwardsCursor: null };
      },
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });

    const initial = await surface.connect();
    const replica = createCodexConversationReplica(surface.conversation('thread-existing').getSnapshot());
    surface.onEvent((event) => {
      if ('conversationId' in event && event.conversationId === 'thread-existing') replica.apply(event);
    });
    expect(initial.historyState).toMatchObject({ loadingStrategy: 'lazy', hasOlder: true, fullyLoaded: false });
    expect(transport.sent.filter((message) => 'method' in message && message.method === 'thread/turns/list')).toHaveLength(0);

    const page = await surface.loadOlderConversationHistory('thread-existing');
    expect(page).toMatchObject({ conversationId: 'thread-existing', hasOlder: true });
    expect(page.messages).toHaveLength(6);
    expect(replica.getSnapshot().historyState).toMatchObject({ hasOlder: true, loadingOlder: false });

    await surface.loadOlderConversationHistory('thread-existing');
    expect(surface.getSnapshot().historyState).toMatchObject({ hasOlder: false, fullyLoaded: true });
    expect(replica.getSnapshot()).toMatchObject({
      turnIds: ['turn-oldest', 'turn-older', 'turn-initial'],
      historyState: { hasOlder: false, fullyLoaded: true, loadingOlder: false },
    });
    expect(messagesWithoutCreatedAt(replica.getSnapshot().messages)).toStrictEqual(
      messagesWithoutCreatedAt(surface.conversation('thread-existing').getSnapshot().messages),
    );

    const history = await surface.readConversationHistory('thread-existing');
    expect(history.messages).toHaveLength(14);
    expect(surface.getSnapshot().historyState).toMatchObject({ hasOlder: false, fullyLoaded: true });
    expect(transport.sent.filter((message) => 'method' in message && message.method === 'thread/turns/list')
      .map((message) => ('params' in message ? (message.params as { cursor: string | null }).cursor : undefined)))
      .toEqual(['older-page', 'oldest-page', null, 'older-page', 'oldest-page']);
  });

  it('keeps event-only history consumers retryable after a failed page and settles an empty final page', async () => {
    const failedPage = deferred<v2.ThreadTurnsListResponse>();
    let attempts = 0;
    const transport = new MockCodexAppServer({
      'thread/resume': () => ({
        ...resumeResponse(thread('thread-existing', false)),
        initialTurnsPage: { data: [historyTurn('turn-initial', 1)], nextCursor: 'older-page', backwardsCursor: null },
      }),
      'thread/turns/list': () => ++attempts === 1
        ? failedPage.promise
        : { data: [], nextCursor: null, backwardsCursor: null },
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    try {
      await surface.connect();
      const conversation = surface.conversation('thread-existing');
      const replica = createCodexConversationReplica(conversation.getSnapshot());
      conversation.onEvent((event) => replica.apply(event));
      const messages = replica.getSnapshot().messages;
      const load = conversation.loadOlderHistory();
      const rejection = expect(load).rejects.toThrow('History unavailable');
      const loadingOlder = replica.getSnapshot().historyState?.loadingOlder;
      failedPage.reject(new Error('History unavailable'));
      await rejection;
      expect(loadingOlder).toBe(true);
      expect(replica.getSnapshot()).toMatchObject({
        historyState: { hasOlder: true, loadingOlder: false },
        error: expect.stringContaining('History unavailable'),
      });
      await conversation.loadOlderHistory();
      expect(replica.getSnapshot()).toMatchObject({
        historyState: { hasOlder: false, loadingOlder: false, fullyLoaded: true },
        error: null,
      });
      expect(replica.getSnapshot().messages).toBe(messages);
    } finally {
      await surface.close();
    }
  });

  it('does not resurrect a completed turn from a stale background history page', async () => {
    const staleFullPage = deferred<v2.ThreadTurnsListResponse>();
    const runningTurn = turn('turn-running', 'inProgress', []);
    const transport = new MockCodexAppServer({
      'thread/resume': () => {
        const running = thread('thread-existing', false);
        running.status = { type: 'active', activeFlags: [] };
        running.turns = [runningTurn];
        return {
          ...resumeResponse(running),
          initialTurnsPage: { data: [runningTurn], nextCursor: 'stale-page-2', backwardsCursor: null },
        };
      },
      'thread/turns/list': (params) => {
        expect(params).toMatchObject({ cursor: 'stale-page-2', itemsView: 'full' });
        return staleFullPage.promise;
      },
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();
    expect(surface.getSnapshot().busy).toBe(true);

    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-running', 'completed', []) });
    expect(surface.getSnapshot().busy).toBe(false);
    staleFullPage.resolve({ data: [runningTurn], nextCursor: null, backwardsCursor: null });
    await vi.waitFor(() => expect(surface.conversation('thread-existing').getSnapshot().activeTurnId).toBeNull());

    expect(surface.getSnapshot().busy).toBe(false);
    expect(surface.conversation('thread-existing').getSnapshot().activeTurnId).toBeNull();
    expect(surface.getSnapshot().messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: 'turn-running', status: 'streaming' }),
    ]));
  });

  it('keeps an active resumed thread busy when its initial history page has no running turn', async () => {
    const transport = new MockCodexAppServer({
      'thread/resume': () => {
        const running = thread('thread-existing', false);
        running.status = { type: 'active', activeFlags: [] };
        return {
          ...resumeResponse(running),
          initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
        };
      },
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });

    const snapshot = await surface.connect();

    expect(snapshot).toMatchObject({
      busy: true,
      threadStatus: { type: 'active', activeFlags: [] },
    });
    expect(surface.conversation('thread-existing').getSnapshot().activeTurnId).toBeNull();
  });

  it('emits ordered semantic events after matching state mutations for conversation handles', async () => {
    const { surface, transport } = createSurface('thread/settings/update', 'turn/start');
    await surface.connect();
    const events: CodexSurfaceEvent[] = [];
    const handleEvents: CodexSurfaceEvent[] = [];
    const unsubscribeSurface = surface.onEvent((event) => {
      events.push(event);
      if (event.type === 'message.delta') {
        const message = surface.conversation(event.conversationId).getSnapshot().messages
          .find((candidate) => candidate.id === event.payload.messageId);
        expect(message?.parts).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'text', itemId: event.payload.itemId }),
        ]));
      }
      if (event.type === 'tool.updated') {
        const part = surface.conversation(event.conversationId).getSnapshot().messages
          .flatMap((message) => message.parts)
          .find((candidate) => candidate.type === 'tool' && candidate.id === event.payload.update.itemId);
        expect(part).toMatchObject({ body: expect.stringContaining(event.payload.update.bodyAppend ?? '') });
      }
    });
    const conversation = surface.conversation('thread-existing');
    const unsubscribeConversation = conversation.onEvent((event) => handleEvents.push(event));

    transport.emitNotification('turn/started', { threadId: 'thread-other', turn: turn('turn-other', 'inProgress', []) });
    expect(handleEvents).toStrictEqual([]);

    await conversation.updateSettings({ planMode: true });
    expect(handleEvents).toContainEqual(expect.objectContaining({
      type: 'conversation.settingsChanged',
      conversationId: 'thread-existing',
      origin: 'action',
      payload: expect.objectContaining({ planMode: true }),
    }));

    await conversation.sendMessage('Inspect these', {
      attachments: [
        {
          type: 'image', path: '/tmp/screenshot.png', name: 'shot.png', mimeType: 'image/png',
          previewUrl: 'data:image/png;base64,cG5n',
        },
        { type: 'file', path: '/tmp/notes.md', name: 'Notes', mimeType: 'text/markdown' },
      ],
    });
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-live', 'inProgress', []) });
    transport.emitNotification('item/agentMessage/delta', { threadId: 'thread-existing', turnId: 'turn-live', itemId: 'agent-live', delta: 'Working' });
    transport.emitNotification('item/plan/delta', { threadId: 'thread-existing', turnId: 'turn-live', itemId: 'plan-live', delta: '# Draft' });
    transport.emitNotification('turn/plan/updated', {
        threadId: 'thread-existing', turnId: 'turn-live', explanation: 'Implementation',
        plan: [{ step: 'Wire events', status: 'inProgress' }],
      });
    transport.emitNotification('item/started', {
        threadId: 'thread-existing', turnId: 'turn-live', startedAtMs: 1,
        item: { mcpAppUi: null, readOnlyHint: null,
          type: 'mcpToolCall', id: 'mcp-live', server: 'tools', tool: 'run', status: 'inProgress',
          arguments: {}, appContext: null, pluginId: null, result: null, error: null, durationMs: null,
        },
      });
    transport.emitNotification('item/mcpToolCall/progress', { threadId: 'thread-existing', turnId: 'turn-live', itemId: 'mcp-live', message: 'halfway' });
    transport.emitServerRequest('ask-event', 'item/tool/requestUserInput', { isBlocking: false,
        threadId: 'thread-existing', turnId: 'turn-live', itemId: 'ask-live', autoResolutionMs: null,
        questions: [{
          id: 'target', header: 'Target', question: 'Which target?', isOther: false, isSecret: false,
          options: null,
        }],
      });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'clientRequest.requested')).toBe(true));
    await conversation.respondToClientRequest({
      id: 'ask-event', payload: { answers: { target: { answers: ['SDK'] } } },
    });
    transport.emitServerRequest('approval-event', 'item/commandExecution/requestApproval', { kind: 'command', startedAtMs: 1,
        threadId: 'thread-existing', turnId: 'turn-live', itemId: 'command-live', command: 'npm test',
        cwd: '/tmp/project', reason: null, environmentId: null, commandActions: [],
        networkApprovalContext: null, additionalPermissions: null,
        availableDecisions: ['accept', 'decline'], proposedExecpolicyAmendment: null,
      });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'approval.requested')).toBe(true));
    await conversation.resolveApproval('approval-event', 'approve');
    transport.emitNotification('skills/changed', {});
    await vi.waitFor(() => expect(handleEvents.some((event) => event.type === 'conversation.skillsChanged')).toBe(true));
    expect(handleEvents).toContainEqual(expect.objectContaining({
      type: 'conversation.skillsChanged',
      conversationId: 'thread-existing',
      origin: 'notification',
    }));

    const appended = events.find((event) => (
      event.type === 'message.appended' && event.origin === 'action'
    ));
    expect(appended?.type === 'message.appended' ? appended.payload.message.parts : []).toStrictEqual([
      { type: 'text', text: 'Inspect these' },
      {
        type: 'attachment',
        attachment: {
          kind: 'image', name: 'shot.png', path: '/tmp/screenshot.png',
          url: 'data:image/png;base64,cG5n', mimeType: 'image/png',
        },
      },
      {
        type: 'attachment',
        attachment: { kind: 'file', name: 'Notes', path: '/tmp/notes.md', mimeType: 'text/markdown' },
      },
    ]);
    expect(events.filter((event) => event.type === 'turn.started' && event.turnId === 'turn-live')).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'message.delta', payload: expect.objectContaining({ delta: 'Working' }) }),
      expect.objectContaining({ type: 'plan.delta', payload: expect.objectContaining({ markdown: '# Draft' }) }),
      expect.objectContaining({
        type: 'plan.updated',
        payload: expect.objectContaining({
          explanation: 'Implementation', status: 'completed',
          steps: [{ step: 'Wire events', status: 'inProgress' }],
        }),
      }),
      expect.objectContaining({ type: 'tool.started', payload: expect.objectContaining({ messageId: 'assistant-turn-live' }) }),
      expect.objectContaining({ type: 'tool.updated', payload: expect.objectContaining({ update: expect.objectContaining({ bodyAppend: 'halfway' }) }) }),
      expect.objectContaining({ type: 'clientRequest.resolved', payload: expect.objectContaining({ reason: 'host' }) }),
      expect.objectContaining({ type: 'approval.resolved', payload: expect.objectContaining({ decision: 'approve' }) }),
      expect.objectContaining({
        type: 'conversation.activityChanged',
        conversationId: 'thread-existing',
      }),
    ]));
    expect(events.map((event) => event.seq)).toStrictEqual(
      [...events.map((event) => event.seq)].sort((left, right) => left - right),
    );
    expect(new Set(events.map((event) => event.seq)).size).toBe(events.length);
    expect(handleEvents.every((event) => 'conversationId' in event && event.conversationId === 'thread-existing')).toBe(true);

    const handleEventCount = handleEvents.length;
    unsubscribeConversation();
    transport.emitNotification('item/agentMessage/delta', { threadId: 'thread-existing', turnId: 'turn-live', itemId: 'agent-live', delta: ' done' });
    expect(handleEvents).toHaveLength(handleEventCount);
    const surfaceEventCount = events.length;
    unsubscribeSurface();
    transport.emitNotification('item/agentMessage/delta', { threadId: 'thread-existing', turnId: 'turn-live', itemId: 'agent-live', delta: '!' });
    expect(events).toHaveLength(surfaceEventCount);
  });

  it('exposes safe reasoning summaries while keeping raw reasoning content internal', async () => {
    const { surface, transport } = createSurface('turn/start');
    await surface.connect();
    await surface.sendMessage('Think carefully');
    const replica = createCodexConversationReplica(surface.getConversationSnapshot('thread-existing'));
    surface.onConversationEvent('thread-existing', event => replica.apply(event));

    transport.emitNotification('item/started', {
        threadId: 'thread-existing', turnId: 'turn-live', startedAtMs: 1,
        item: { type: 'reasoning', id: 'reasoning-live', summary: [], content: [] },
      });
    expect(replica.getSnapshot().messages.at(-1)?.parts).toContainEqual({
      type: 'reasoning', summary: '', itemId: 'reasoning-live', summaryIndex: 0,
    });
    transport.emitNotification('item/completed', {
        threadId: 'thread-existing', turnId: 'turn-live', completedAtMs: 2,
        item: { type: 'reasoning', id: 'reasoning-live', summary: ['Internal'], content: ['Hidden'] },
      });

    const assistant = surface.getSnapshot().messages.at(-1);
    expect(assistant).toMatchObject({
      id: 'assistant-turn-live',
      role: 'assistant',
      status: 'streaming',
      parts: [{
        type: 'reasoning',
        summary: 'Internal',
        itemId: 'reasoning-live',
        summaryIndex: 0,
      }],
    });
    expect(JSON.stringify(surface.getSnapshot().messages)).not.toContain('Hidden');
  });

  it('preserves agent message phase before and during streaming', async () => {
    const { surface, transport } = createSurface();
    await surface.connect();
    const events: CodexSurfaceEvent[] = [];
    surface.onEvent((event) => events.push(event));
    const replica = createCodexConversationReplica(surface.getConversationSnapshot('thread-existing'));
    surface.onConversationEvent('thread-existing', event => replica.apply(event));
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-live', 'inProgress', []) });
    transport.emitNotification('item/started', {
        threadId: 'thread-existing',
        turnId: 'turn-live',
        startedAtMs: 1,
        item: { delivery: null, questions: null,
          type: 'agentMessage',
          id: 'agent-final',
          text: '',
          phase: 'final_answer',
          memoryCitation: null,
        },
      });
    transport.emitNotification('item/agentMessage/delta', {
        threadId: 'thread-existing',
        turnId: 'turn-live',
        itemId: 'agent-final',
        delta: 'Final response',
      });

    expect(surface.getSnapshot().messages.flatMap((message) => message.parts)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: 'Final response',
          itemId: 'agent-final',
          phase: 'final_answer',
        }),
      ]),
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: 'message.delta',
      payload: expect.objectContaining({
        itemId: 'agent-final',
        delta: 'Final response',
        phase: 'final_answer',
      }),
    }));
    transport.emitNotification('item/started', {
      threadId: 'thread-existing', turnId: 'turn-live', startedAtMs: 2,
      item: { type: 'agentMessage', id: 'resumed-commentary', text: '', phase: 'commentary',
        memoryCitation: null, delivery: null, questions: null },
    });
    expect(replica.getSnapshot().messages.at(-1)?.parts.at(-1)).toStrictEqual({
      type: 'text', text: '', itemId: 'resumed-commentary', phase: 'commentary',
    });
  });

});

function messagesWithoutCreatedAt(messages: readonly SurfaceMessage[]) {
  return messages.map(({ createdAt: _createdAt, ...message }) => message);
}
