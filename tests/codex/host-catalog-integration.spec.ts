import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk';
import { CodexHost } from '../../src/providers/codex';
import type { CodexHostEvent } from '../../src/index';
import {
  MockCodexAppServer,
  deferred,
  lastRequest,
  lastResponse,
  pluginSummary,
  resumeResponse,
  requestsFor,
  thread,
} from './helpers/host-fixture';

describe('CodexHost', () => {
  it('defers skill discovery through connection, history, creation, forks, and change notifications', async () => {
    const transport = new MockCodexAppServer({
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/fork': () => resumeResponse(thread('thread-forked', false)),
      'thread/settings/update': () => ({}),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport), cwd: '/tmp/project' });
    try {
      await host.connect();
      await host.conversation('thread-other').load();
      await host.createConversation();
      await host.forkConversation('thread-existing');
      transport.emitNotification('skills/changed', {});
      await host.refreshAccount();
      expect(requestsFor(transport, 'skills/list')).toStrictEqual([]);
      expect(host.getSnapshot().skillCatalogStatus).toBe('notLoaded');

      await host.listSkills({ cwd: '/tmp/project' });
      expect(requestsFor(transport, 'skills/list')).toHaveLength(1);
      expect(host.getConversationSnapshot('thread-existing').skillCatalogStatus).toBe('loaded');
      await host.listSkills({ cwd: '/tmp/project' });
      expect(requestsFor(transport, 'skills/list')).toHaveLength(1);

      transport.emitNotification('skills/changed', {});
      await vi.waitFor(() => expect(host.getConversationSnapshot('thread-existing').skillCatalogStatus).toBe('loaded'));
      expect(requestsFor(transport, 'skills/list')).toHaveLength(2);
    } finally { await host.close(); }
  });

  it('connects before serving an explicit catalog request', async () => {
    const transport = new MockCodexAppServer();
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });

    await expect(host.listSkills()).resolves.toStrictEqual([]);
    await expect(host.listModels({ includeHidden: true })).resolves.toHaveLength(2);

    expect(transport.start).toHaveBeenCalledOnce();
    expect(lastRequest(transport, 'initialize')).toBeDefined();
    expect(lastRequest(transport, 'skills/list')).toBeDefined();
    expect(lastRequest(transport, 'model/list')).toMatchObject({ params: { includeHidden: true } });
    await host.close();
  });

  it.each([undefined, '/tmp/project'])('coalesces discovery and rejects stale results after skills change (cwd: %s)', async cwd => {
    const scope = cwd ? { cwd } : {};
    const stale = deferred<v2.SkillsListResponse>();
    let reads = 0;
    const transport = new MockCodexAppServer({ 'skills/list': () => ++reads === 1 ? stale.promise : ({ data: [{
      cwd: '/tmp/project', errors: [], skills: [{ pluginId: null, name: 'fresh', description: 'Fresh',
        path: '/skills/fresh/SKILL.md', scope: 'user', enabled: true }],
    }] }) });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const events: CodexHostEvent[] = [];
    host.onEvent(event => events.push(event));
    try {
      await host.connect();
      const first = host.listSkills(scope);
      const second = host.listSkills(scope);
      const settled = Promise.allSettled([first, second]);
      await vi.waitFor(() => expect(reads).toBe(1));
      transport.emitNotification('skills/changed', {});
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        type: 'catalog.skillsChanged', payload: expect.objectContaining({
          cwd: cwd ?? null, status: 'loaded', skills: [expect.objectContaining({ name: 'fresh' })],
        }),
      })));
      if (!cwd) expect(host.getSnapshot().skills).toEqual([]);
      stale.resolve({ data: [{ cwd: '/tmp/project', errors: [], skills: [] }] });
      expect((await settled).map(result => result.status)).toStrictEqual(['rejected', 'rejected']);
      const cached = await host.listSkills(scope);
      expect(cached[0]?.name).toBe('fresh');
      expect(reads).toBe(2);
      expect(transport.requests('skills/list').map(request => request.params))
        .toStrictEqual([{ ...(cwd ? { cwds: [cwd] } : {}), forceReload: false },
          { ...(cwd ? { cwds: [cwd] } : {}), forceReload: true }]);
    } finally { await host.close(); }
  });

  it('does not publish a catalog failure when closing with a refresh in flight', async () => {
    const pluginCatalog = deferred<v2.PluginInstalledResponse>();
    const transport = new MockCodexAppServer({
      'plugin/installed': () => pluginCatalog.promise,
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const events: CodexHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    expect(host.getSnapshot().pluginCatalogStatus).toBe('loading');
    events.length = 0;

    await host.close();

    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'catalog.pluginsChanged',
      payload: expect.objectContaining({ status: 'error' }),
    }));
    expect(host.getSnapshot()).toMatchObject({ status: 'idle', pluginCatalogStatus: 'loading' });
  });

  it('does not bootstrap plugins while authentication is required', async () => {
    const transport = new MockCodexAppServer({
      'account/read': () => ({ workspaceRouting: null, account: null, requiresOpenaiAuth: true }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });

    await host.connect();
    await host.refreshConversations();
    await Promise.resolve();

    expect(transport.sent.filter((message) => (
      'method' in message && message.method === 'plugin/installed'
    ))).toStrictEqual([]);
    expect(host.getSnapshot().pluginCatalogStatus).toBe('notLoaded');
    await host.close();
  });

  it('publishes conversation skill changes from an explicit catalog refresh', async () => {
    let skillVersion = 0;
    const transport = new MockCodexAppServer({
      'skills/list': () => ({
        data: [{
          cwd: '/tmp/project', errors: [], skills: [{ pluginId: null,
            name: `skill-${skillVersion}`, description: 'Skill', path: `/tmp/skill-${skillVersion}/SKILL.md`,
            scope: 'repo', enabled: true, interface: undefined,
          }],
        }],
      }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport), cwd: '/tmp/project' });
    const events: CodexHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    await host.connect();
    events.length = 0;
    skillVersion = 1;

    await host.listSkills({ cwd: '/tmp/project', forceReload: true });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.skillsChanged',
      origin: 'action',
      conversationId: 'thread-existing',
      payload: expect.objectContaining({
        skills: [expect.objectContaining({ name: 'skill-1' })],
      }),
    }));
    await host.close();
  });

  it('retries a transient plugin catalog failure on an explicit conversation refresh', async () => {
    let attempts = 0;
    const transport = new MockCodexAppServer({
      'plugin/installed': () => {
        attempts += 1;
        if (attempts === 1) throw new Error('catalog unavailable');
        return { marketplaces: [], marketplaceLoadErrors: [] };
      },
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    await vi.waitFor(() => expect(host.getSnapshot().pluginCatalogStatus).toBe('error'));

    await host.refreshConversations();
    await vi.waitFor(() => expect(host.getSnapshot().pluginCatalogStatus).toBe('loaded'));

    expect(attempts).toBe(2);
  });

  it('materializes bounded local plugin icons without exposing filesystem URLs', async () => {
    const readPaths: string[] = [];
    const transport = new MockCodexAppServer({
      'plugin/installed': () => ({
        marketplaces: [{
          name: 'local',
          path: '/tmp/local-marketplace.json',
          interface: null,
          plugins: [
            pluginSummary('local-plugin', 'local-plugin', {
              displayName: 'Local plugin',
              composerIcon: '/plugins/local/icon.svg',
            }),
            pluginSummary('oversized-plugin', 'oversized-plugin', {
              displayName: 'Oversized plugin',
              composerIcon: '/plugins/local/readme.txt',
              logo: '/plugins/local/oversized.png',
            }),
          ],
        }],
        marketplaceLoadErrors: [],
      }),
      'fs/readFile': (params) => {
        const path = (params as { path: string }).path;
        readPaths.push(path);
        return {
          dataBase64: path.endsWith('icon.svg') ? 'PHN2Zy8+' : 'A'.repeat(350_000),
        };
      },
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });

    await host.connect();
    await vi.waitFor(() => expect(host.getSnapshot().pluginCatalogStatus).toBe('loaded'));

    expect(readPaths).toStrictEqual(['/plugins/local/icon.svg', '/plugins/local/oversized.png']);
    expect(host.getSnapshot().plugins).toStrictEqual([
      {
        id: 'local-plugin',
        name: 'local-plugin',
        displayName: 'Local plugin',
        iconUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
        iconUrlDark: 'data:image/svg+xml;base64,PHN2Zy8+',
        enabled: true,
      },
      {
        id: 'oversized-plugin',
        name: 'oversized-plugin',
        displayName: 'Oversized plugin',
        enabled: true,
      },
    ]);
    expect(JSON.stringify(host.getSnapshot().plugins)).not.toContain('file://');
  });

  it('materializes bounded local skill icons without exposing filesystem paths', async () => {
    const readPaths: string[] = [];
    const transport = new MockCodexAppServer({
      'skills/list': () => ({
        data: [{
          cwd: '/tmp/project',
          skills: [
            { pluginId: null,
              name: 'branded-skill',
              description: 'A skill with catalog artwork',
              path: '/skills/branded/SKILL.md',
              scope: 'user',
              enabled: true,
              interface: { iconSmallUrl: null, iconLargeUrl: null,
                displayName: 'Branded Skill',
                iconSmall: '/skills/branded/icon-small.svg',
                iconLarge: '/skills/branded/icon-large.png',
              },
            },
            { pluginId: null,
              name: 'invalid-icons',
              description: 'A skill whose artwork cannot be exposed safely',
              path: '/skills/invalid/SKILL.md',
              scope: 'user',
              enabled: true,
              interface: { iconSmallUrl: null, iconLargeUrl: null,
                iconSmall: '/skills/invalid/readme.txt',
                iconLarge: '/skills/invalid/oversized.png',
              },
            },
          ],
          errors: [],
        }],
      }),
      'fs/readFile': (params) => {
        const path = (params as { path: string }).path;
        readPaths.push(path);
        if (path.endsWith('icon-small.svg')) return { dataBase64: 'PHN2Zy8+' };
        if (path.endsWith('icon-large.png')) return { dataBase64: 'cG5n' };
        return { dataBase64: 'A'.repeat(350_000) };
      },
    });
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      autoSelectFirstConversation: false,
    });

    await host.connect();
    expect(readPaths).toStrictEqual([]);
    const skills = await host.listSkills();

    expect(readPaths).toStrictEqual([
      '/skills/branded/icon-small.svg',
      '/skills/branded/icon-large.png',
      '/skills/invalid/oversized.png',
    ]);
    expect(skills).toMatchObject([
      {
        name: 'branded-skill',
        description: 'A skill with catalog artwork',
        displayName: 'Branded Skill',
        iconSmall: 'data:image/svg+xml;base64,PHN2Zy8+',
        iconLarge: 'data:image/png;base64,cG5n',
        path: '/skills/branded/SKILL.md',
        scope: 'user',
        enabled: true,
      },
      {
        name: 'invalid-icons',
        description: 'A skill whose artwork cannot be exposed safely',
        path: '/skills/invalid/SKILL.md',
        scope: 'user',
        enabled: true,
      },
    ]);
    expect(skills[1]?.iconSmall).toBeUndefined();
    expect(skills[1]?.iconLarge).toBeUndefined();
    expect(JSON.stringify(skills)).not.toContain('/skills/branded/icon-');
    expect(JSON.stringify(skills)).not.toContain('/skills/invalid/readme.txt');
    expect(JSON.stringify(skills)).not.toContain('/skills/invalid/oversized.png');
  });

  it('rereads same-path skill icons when the skill catalog is force reloaded', async () => {
    let iconReads = 0;
    const transport = new MockCodexAppServer({
      'skills/list': () => ({
        data: [{
          cwd: '/tmp/project',
          skills: [{ pluginId: null,
            name: 'changing-skill',
            description: 'A skill whose icon can change in place',
            path: '/skills/changing/SKILL.md',
            scope: 'user',
            enabled: true,
            interface: { iconSmallUrl: null, iconLargeUrl: null, iconSmall: '/skills/changing/icon.png' },
          }],
          errors: [],
        }],
      }),
      'fs/readFile': () => {
        iconReads += 1;
        return { dataBase64: iconReads === 1 ? 'QQ==' : 'Qg==' };
      },
    });
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      autoSelectFirstConversation: false,
    });

    await host.connect();
    const initial = await host.listSkills();
    expect(initial[0]?.iconSmall).toBe('data:image/png;base64,QQ==');

    const reloaded = await host.listSkills({ forceReload: true });
    expect(reloaded[0]?.iconSmall).toBe('data:image/png;base64,Qg==');
    expect(iconReads).toBe(2);
  });

  it('refreshes the plugin catalog when the conversation cwd union grows', async () => {
    let includeSecondCwd = false;
    const pluginScopes: unknown[] = [];
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null,
        data: [
          thread('thread-existing', false),
          ...(includeSecondCwd ? [{ ...thread('thread-new-cwd', false), cwd: '/workspace/new' }] : []),
        ],
        nextCursor: null,
      }),
      'plugin/installed': (params) => {
        pluginScopes.push(params);
        return { marketplaces: [], marketplaceLoadErrors: [] };
      },
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    await vi.waitFor(() => expect(pluginScopes).toHaveLength(1));

    includeSecondCwd = true;
    await host.refreshConversations();
    await vi.waitFor(() => expect(pluginScopes).toHaveLength(2));

    expect(pluginScopes).toStrictEqual([
      { cwds: ['/tmp/project'] },
      { cwds: ['/tmp/project', '/workspace/new'] },
    ]);
  });

  it('refreshes the plugin catalog after creating a conversation in a new cwd', async () => {
    const pluginScopes: unknown[] = [];
    const transport = new MockCodexAppServer({
      'plugin/installed': (params) => {
        pluginScopes.push(params);
        return { marketplaces: [], marketplaceLoadErrors: [] };
      },
      'thread/start': () => {
        const created = { ...thread('thread-new', false), cwd: '/workspace/new' };
        return { ...resumeResponse(created), cwd: '/workspace/new' };
      },
      'thread/settings/update': () => ({}),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();
    await vi.waitFor(() => expect(pluginScopes).toHaveLength(1));

    await host.createConversation({ cwd: '/workspace/new' });
    await vi.waitFor(() => expect(pluginScopes).toHaveLength(2));

    expect(pluginScopes).toStrictEqual([
      { cwds: ['/tmp/project'] },
      { cwds: ['/tmp/project', '/workspace/new'] },
    ]);
  });

  it('deduplicates concurrent bootstrap and honors client and list configuration', async () => {
    const transport = new MockCodexAppServer();
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      clientInfo: { name: 'custom_host', version: '2.0.0' },
      conversationLimit: 12,
      cwd: '/tmp/project',
    });
    const first = host.connect();
    const second = host.connect();
    expect(second).toBe(first);
    await first;
    expect(transport.sent.find((message) => 'method' in message && message.method === 'initialize')).toMatchObject({
      params: { clientInfo: { name: 'custom_host', title: null, version: '2.0.0' } },
    });
    expect(transport.sent.find((message) => 'method' in message && message.method === 'thread/list')).toMatchObject({
      params: { limit: 12 },
    });
    expect(transport.sent.find((message) => 'method' in message && message.method === 'thread/list')).not.toMatchObject({
      params: { cwd: expect.anything() },
    });
  });

  it('owns archive, unarchive, and permanent deletion lifecycle actions', async () => {
    const transport = new MockCodexAppServer({
      'thread/archive': () => ({}),
      'thread/delete': () => ({}),
      'thread/unarchive': (params) => ({
        thread: thread((params as { threadId: string }).threadId, false),
      }),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const removedEvents: CodexHostEvent[] = [];
    const selectedEvents: CodexHostEvent[] = [];
    host.onEvent((event) => {
      if (event.type === 'conversation.summaryRemoved') removedEvents.push(event);
      if (event.type === 'conversation.selected') selectedEvents.push(event);
    });
    await host.connect();
    const handleBeforeArchive = host.conversation('thread-existing');
    selectedEvents.length = 0;

    const beforeUnknownRemoval = host.getSnapshot();
    transport.emitNotification('thread/deleted', { threadId: 'thread-unknown' });
    expect(host.getSnapshot()).toStrictEqual(beforeUnknownRemoval);
    expect(removedEvents).toStrictEqual([]);

    await host.archiveConversation(' thread-existing ');
    expect(lastRequest(transport, 'thread/archive')).toMatchObject({
      params: { threadId: 'thread-existing' },
    });
    expect(host.getSnapshot()).toMatchObject({
      activeConversationId: null,
      conversations: [],
      messages: [],
      answeredClientRequestIds: [],
      approvals: [],
      clientRequests: [],
      contextUsage: null,
      goal: null,
      turnGitDiff: null,
      threadStatus: null,
      queuedPrompts: [],
      busy: false,
      historyLoading: false,
      error: null,
    });
    expect(removedEvents).toStrictEqual([expect.objectContaining({
      origin: 'action',
      conversationId: 'thread-existing',
      payload: { reason: 'archived' },
    })]);
    expect(selectedEvents).toStrictEqual([
      expect.objectContaining({
        origin: 'action',
        payload: { conversationId: null },
      }),
    ]);

    transport.emitNotification('thread/archived', { threadId: 'thread-existing' });
    expect(removedEvents).toHaveLength(1);

    await host.unarchiveConversation('thread-existing');
    expect(lastRequest(transport, 'thread/unarchive')).toMatchObject({
      params: { threadId: 'thread-existing' },
    });
    expect(host.getSnapshot().conversations).toEqual([
      expect.objectContaining({ id: 'thread-existing' }),
    ]);
    expect(host.conversation('thread-existing')).not.toBe(handleBeforeArchive);

    await host.deleteConversation('thread-existing');
    expect(lastRequest(transport, 'thread/delete')).toMatchObject({
      params: { threadId: 'thread-existing' },
    });
    expect(host.getSnapshot().conversations).toStrictEqual([]);
    expect(removedEvents).toStrictEqual([
      expect.objectContaining({ payload: { reason: 'archived' } }),
      expect.objectContaining({
        origin: 'action',
        conversationId: 'thread-existing',
        payload: { reason: 'deleted' },
      }),
    ]);
    expect(selectedEvents).toHaveLength(1);

    transport.emitNotification('thread/deleted', { threadId: 'thread-existing' });
    expect(removedEvents).toHaveLength(2);
    await expect(host.deleteConversation('   ')).rejects.toThrow('Conversation id cannot be empty');
  });

  it('removes a background conversation without disturbing active state and rejects its pending work', async () => {
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null,
        data: [thread('thread-existing', false), thread('thread-background', false)],
        nextCursor: null,
      }),
      'thread/delete': () => ({}),
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    const selectedEvents: CodexHostEvent[] = [];
    const resolvedEvents: CodexHostEvent[] = [];
    host.onEvent((event) => {
      if (event.type === 'conversation.selected') selectedEvents.push(event);
      if (event.type === 'approval.resolved' || event.type === 'clientRequest.resolved') {
        resolvedEvents.push(event);
      }
    });
    await host.connect();
    await host.conversation('thread-background').load();
    selectedEvents.length = 0;
    transport.emitServerRequest('background-approval', 'item/commandExecution/requestApproval', { kind: 'command', startedAtMs: 1,
        threadId: 'thread-background', turnId: 'turn-background', itemId: 'command-background',
        command: 'npm test', cwd: '/tmp/project', reason: null, environmentId: null,
        commandActions: [], networkApprovalContext: null, additionalPermissions: null,
        availableDecisions: ['accept', 'decline'], proposedExecpolicyAmendment: null,
      });
    transport.emitServerRequest('background-input', 'item/tool/requestUserInput', { isBlocking: false,
        threadId: 'thread-background', turnId: 'turn-background', itemId: 'input-background',
        autoResolutionMs: null,
        questions: [{
          id: 'answer', header: 'Answer', question: 'Continue?', isOther: false, isSecret: false,
          options: null,
        }],
      });
    await vi.waitFor(() => expect(host.getConversationSnapshot('thread-background')).toMatchObject({
      approvals: [{ id: 'background-approval' }],
      clientRequests: [{ id: 'background-input' }],
    }));

    await host.deleteConversation('thread-background');

    expect(lastResponse(transport, 'background-approval')).toMatchObject({
      result: { decision: 'decline' },
    });
    expect(lastResponse(transport, 'background-input')).toMatchObject({
      error: { message: 'Codex thread is no longer available' },
    });
    expect(resolvedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'approval.resolved',
        conversationId: 'thread-background',
        payload: expect.objectContaining({ reason: 'conversation_removed' }),
      }),
      expect.objectContaining({
        type: 'clientRequest.resolved',
        conversationId: 'thread-background',
        payload: expect.objectContaining({ reason: 'conversation_removed' }),
      }),
    ]));
    expect(host.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-existing',
      conversations: [expect.objectContaining({ id: 'thread-existing' })],
      messages: expect.arrayContaining([
        expect.objectContaining({ id: 'user-thread-existing-turn-history-user-history' }),
      ]),
    });
    expect(selectedEvents).toStrictEqual([]);
  });

});
