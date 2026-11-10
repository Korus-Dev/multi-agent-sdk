import { describe, expect, it, vi } from 'vitest';
import type { CodexSurfaceStatePatch } from '@korus-dev/multi-agent-sdk/surface';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk/protocol';
import { CodexSurface } from '../../src/providers/codex';
import { MockCodexAppServer, pluginSummary, resumeResponse, thread } from './helpers/codex-surface-fixture';

describe('CodexSurface state patches', () => {
  it('lists a conversation once when it moves between pages while paging', async () => {
    const pages = [
      { data: [thread('thread-a', false), thread('thread-b', false)], nextCursor: 'page-2' },
      // thread-b was updated after page 1 was served, so the next page repeats it.
      { data: [thread('thread-b', false), thread('thread-c', false)], nextCursor: null },
    ];
    let page = 0;
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, ...pages[page++ % pages.length]! }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport), autoSelectFirstConversation: false });

    await surface.connect();

    expect(surface.getSnapshot().conversations.map((conversation) => conversation.id))
      .toStrictEqual(['thread-a', 'thread-b', 'thread-c']);
  });

  it('sends no plugin catalog patch when a refresh finds the same plugins', async () => {
    const transport = new MockCodexAppServer({
      'plugin/installed': () => ({
        marketplaces: [{
          name: 'local',
          path: '/tmp/local-marketplace.json',
          interface: null,
          plugins: [pluginSummary('plugin-a', 'plugin-a', {}), pluginSummary('plugin-b', 'plugin-b', {})],
        }],
        marketplaceLoadErrors: [],
      }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport), autoSelectFirstConversation: false });
    await surface.connect();
    await vi.waitFor(() => expect(surface.getSnapshot().pluginCatalogStatus).toBe('loaded'));
    const patches: CodexSurfaceStatePatch[] = [];
    surface.onStatePatch((patch) => patches.push(patch));

    await surface.refreshConversations();
    await vi.waitFor(() => expect(surface.getSnapshot().pluginCatalogStatus).toBe('loaded'));

    expect(patches.flatMap((patch) => patch.changes).filter((change) => change.key === 'plugins')).toStrictEqual([]);
  });

  it('sends only conversation summaries that a list refresh actually changed', async () => {
    const listed = Array.from({ length: 50 }, (_, index) => thread(`thread-${index}`, false));
    let current: v2.Thread[] = listed;
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: current, nextCursor: null }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport), autoSelectFirstConversation: false });
    await surface.connect();
    const patches: CodexSurfaceStatePatch[] = [];
    surface.onStatePatch((patch) => patches.push(patch));

    await surface.refreshConversations();
    const conversationChanges = () => patches.flatMap((patch) => patch.changes).filter((change) => change.key === 'conversations');
    expect(conversationChanges()).toStrictEqual([]);

    current = listed.map((value, index) => (index === 3 ? { ...value, name: 'Renamed elsewhere' } : value));
    await surface.refreshConversations();

    expect(conversationChanges()).toStrictEqual([{
      type: 'list',
      key: 'conversations',
      ids: listed.map((value) => value.id),
      items: [expect.objectContaining({ id: 'thread-3', title: 'Renamed elsewhere' })],
    }]);
  });
});

describe('CodexSurface host listeners', () => {
  it('keeps a throwing host listener from failing the action or silencing other listeners', async () => {
    const transport = new MockCodexAppServer({
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
    });
    const onListenerError = vi.fn();
    const surface = new CodexSurface({
      client: new CodexAppServerClient(transport),
      autoSelectFirstConversation: false,
      onListenerError,
    });
    await surface.connect();
    const states: unknown[] = [];
    const patches: unknown[] = [];
    const events: unknown[] = [];
    surface.onStateChange(() => { throw new Error('state listener bug'); });
    surface.onStatePatch(() => { throw new Error('patch listener bug'); });
    surface.onEvent(() => { throw new Error('event listener bug'); });
    surface.onStateChange((snapshot) => states.push(snapshot));
    surface.onStatePatch((patch) => patches.push(patch));
    surface.onEvent((event) => events.push(event));

    const snapshot = await surface.createConversation();

    expect(snapshot.activeConversationId).toBe('thread-new');
    expect(states.length).toBeGreaterThan(0);
    expect(patches.length).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
    const reported = new Set(onListenerError.mock.calls.map(([error]) => (error as Error).message));
    expect(reported).toStrictEqual(new Set(['state listener bug', 'patch listener bug', 'event listener bug']));
  });
});
