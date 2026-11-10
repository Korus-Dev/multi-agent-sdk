import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { createCodexConversationReplica } from '@korus-dev/multi-agent-sdk/core';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk/protocol';
import { CodexSurface } from '../../src/providers/codex';
import { createSurface, lastResponse, turn, thread, resumeResponse, MockCodexAppServer } from './helpers/codex-surface-fixture';

describe('CodexSurface', () => {
  it.each(['mcp', 'dynamic', 'mcp-envelope', 'mcp-nested', 'imageView'] as const)('keeps %s image results visible through streaming, duplicate completion and history reload', async kind => {
    const { surface, transport } = createSurface();
    onTestFinished(() => surface.close());
    await surface.connect();
    const replica = createCodexConversationReplica(surface.getConversationSnapshot('thread-existing'));
    surface.onConversationEvent('thread-existing', event => replica.apply(event));
    const small = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const data = Buffer.concat([Buffer.from(small, 'base64'), Buffer.alloc(36_000)]).toString('base64');
    const url = `data:image/png;base64,${data}`;
    const blocks = [{ type: 'text', text: 'Captured' }, { type: 'image', mimeType: 'image/png', data }, { type: 'image', mimeType: 'image/png', data: small }];
    const wrapped = [{ type: 'text', text: JSON.stringify({ content: blocks }) }];
    const content = kind === 'mcp-nested' ? [{ type: 'text', text: JSON.stringify({ content: wrapped }) }] : kind === 'mcp-envelope' ? wrapped : blocks;
    const item: v2.ThreadItem = kind === 'imageView' ? { type: 'imageView', id: 'screenshots', path: '/tmp/viewed image.png' } : kind !== 'dynamic'
      ? { mcpAppUi: null, type: 'mcpToolCall', id: 'screenshots', server: 'tools', tool: 'screenshot', status: 'completed', arguments: {}, appContext: null, pluginId: null, readOnlyHint: true,
          result: { content, structuredContent: null, _meta: null }, error: null, durationMs: 1 }
      : { type: 'dynamicToolCall', id: 'screenshots', namespace: 'functions', tool: 'exec', arguments: {}, status: 'completed', success: true, durationMs: 1,
          contentItems: [{ type: 'inputText', text: 'Captured' }, { type: 'inputImage', imageUrl: url }, { type: 'inputImage', imageUrl: `data:image/png;base64,${small}` }] };
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-images', 'inProgress', []) });
    const completed = { threadId: 'thread-existing', turnId: 'turn-images', item, completedAtMs: 2 };
    transport.emitNotification('item/completed', completed);
    transport.emitNotification('item/completed', completed);
    const media = (messages: ReturnType<typeof replica.getSnapshot>['messages']) => messages.flatMap(message => message.parts).filter(part => part.type === 'media');
    expect(media(replica.getSnapshot().messages).map(part => part.media.url)).toStrictEqual(kind === 'imageView' ? ['file:///tmp/viewed%20image.png'] : [url, `data:image/png;base64,${small}`]);
    expect(media(surface.getConversationSnapshot('thread-existing').messages)).toStrictEqual(media(replica.getSnapshot().messages));
    const restoredThread = { ...thread('thread-existing', false), turns: [turn('turn-images', 'completed', [item])] };
    const restored = new CodexSurface({ client: new CodexAppServerClient(new MockCodexAppServer({
      'thread/resume': () => resumeResponse(restoredThread),
    })) });
    onTestFinished(() => restored.close());
    await restored.connect();
    expect(media(restored.getSnapshot().messages)).toStrictEqual(media(replica.getSnapshot().messages));
    if (kind !== 'imageView') expect(restored.getSnapshot().messages.flatMap(m => m.parts).find(p => p.type === 'tool' && p.id === item.id)).not.toHaveProperty('output');
  });
  it.each([
    ['item/completed', true], ['thread/compacted', true],
    ['item/completed', false], ['thread/compacted', false],
  ] as const)(
    'keeps new activity below compaction after a late tool result through %s (start received: %s)', async (method, started) => {
      const { surface, transport } = createSurface();
      await surface.connect();
      const replica = createCodexConversationReplica(surface.getConversationSnapshot('thread-existing'));
      surface.onConversationEvent('thread-existing', (event) => replica.apply(event));
      const params: v2.ItemStartedNotification = {
        threadId: 'thread-existing', turnId: 'turn-stream', startedAtMs: 1,
        item: { type: 'contextCompaction', id: 'compact' },
      };
      transport.emitNotification('turn/started', {
        threadId: params.threadId, turn: turn(params.turnId, 'inProgress', []),
      });
      transport.emitNotification('item/agentMessage/delta', {
        threadId: params.threadId, turnId: params.turnId, itemId: 'before', delta: 'Before compaction',
      });
      const command: v2.ThreadItem = {
        type: 'commandExecution', id: 'long-running-check', command: 'npm run check',
        cwd: '/tmp/project', processId: null, source: 'agent', status: 'inProgress',
        commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null,
        pluginId: null, scriptPath: null,
      };
      transport.emitNotification('item/started', { ...params, item: command });
      if (started) {
        transport.emitNotification('item/started', params);
        expect(replica.getSnapshot().messages.find((message) => message.kind === 'compaction')?.status).toBe('streaming');
      }
      transport.emitNotification(method, params);
      // Duplicate completion and a late start must not reopen the same marker.
      transport.emitNotification(method, params);
      transport.emitNotification('item/started', params);
      transport.emitNotification('item/completed', {
        threadId: params.threadId, turnId: params.turnId, completedAtMs: 2,
        item: { ...command, status: 'completed', exitCode: 0 },
      });
      transport.emitNotification('item/agentMessage/delta', {
        threadId: params.threadId, turnId: params.turnId, itemId: 'answer', delta: 'Continuing work',
      });
      transport.emitNotification('item/started', {
        ...params, item: { ...command, id: 'new-check' },
      });
      for (const snapshot of [surface.getConversationSnapshot(params.threadId), replica.getSnapshot()]) {
        expect(snapshot.busy).toBe(true);
        expect(snapshot.messages.filter((message) => message.kind === 'compaction')).toMatchObject([
          { status: 'complete' },
        ]);
        expect(snapshot.messages.filter((message) => message.turnId === params.turnId)
          .map((message) => message.kind ?? message.parts.map((part) => part.type === 'text' ? part.text : part.type === 'tool' ? part.id : part.type)))
          .toEqual([['Before compaction', 'long-running-check'], 'compaction', ['Continuing work', 'new-check']]);
        expect(snapshot.messages.flatMap((message) => message.parts).find((part) => part.type === 'tool' && part.id === command.id))
          .toMatchObject({ status: 'completed' });
      }
    },
  );

  it('reduces every streamed tool update and resolves cancellation and confirmation variants', async () => {
    const { surface, transport } = createSurface();
    await surface.connect();
    transport.emitNotification('turn/started', { threadId: 'thread-existing', turn: turn('turn-stream', 'inProgress', []) });
    transport.emitNotification('item/started', {
        threadId: 'thread-existing', turnId: 'turn-stream', startedAtMs: 1,
        item: { pluginId: null, scriptPath: null,
          type: 'commandExecution', id: 'cmd-stream', command: 'printf data > output.txt',
          cwd: '/tmp/project', processId: null, source: 'agent', status: 'inProgress',
          commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null,
        },
      });
    transport.emitNotification('item/commandExecution/outputDelta', { threadId: 'thread-existing', turnId: 'turn-stream', itemId: 'cmd-stream', delta: 'one' });
    transport.emitNotification('item/commandExecution/outputDelta', { threadId: 'thread-existing', turnId: 'turn-stream', itemId: 'cmd-stream', delta: 'two' });
    transport.emitNotification('item/fileChange/patchUpdated', {
        threadId: 'thread-existing', turnId: 'turn-stream', itemId: 'patch-stream',
        changes: [{ path: 'src/new.ts', kind: { type: 'add' }, diff: 'one\ntwo' }],
      });
    transport.emitNotification('item/mcpToolCall/progress', { threadId: 'thread-existing', turnId: 'turn-stream', itemId: 'mcp-stream', message: 'opening' });
    transport.emitNotification('item/mcpToolCall/progress', { threadId: 'thread-existing', turnId: 'turn-stream', itemId: 'mcp-stream', message: 'done' });
    transport.emitNotification('item/plan/delta', { threadId: 'thread-existing', turnId: 'turn-stream', itemId: 'plan', delta: 'First\n' });
    transport.emitNotification('item/plan/delta', { threadId: 'thread-existing', turnId: 'turn-stream', itemId: 'plan', delta: 'Second\n' });
    transport.emitNotification('turn/plan/updated', { threadId: 'thread-existing', turnId: 'turn-stream', explanation: null, plan: [] });
    transport.emitNotification('thread/compacted', { threadId: 'thread-existing', turnId: 'turn-stream' });
    transport.emitNotification('thread/compacted', { threadId: 'thread-existing', turnId: 'turn-stream' });
    const parts = surface.getSnapshot().messages.flatMap((message) => message.parts);
    expect(parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cmd-stream', body: 'onetwo' }),
      expect.objectContaining({ id: 'patch-stream', status: 'running' }),
      expect.objectContaining({ id: 'mcp-stream', body: 'opening\ndone' }),
    ]));
    expect(surface.getSnapshot().messages.filter((message) => message.kind === 'compaction')).toHaveLength(1);

    transport.emitServerRequest('ask-cancel', 'item/tool/requestUserInput', { isBlocking: false,
        threadId: 'thread-existing', turnId: 'turn-stream', itemId: 'ask-cancel-item', autoResolutionMs: 60_000,
        questions: [{ id: 'q', header: 'Q', question: 'Answer?', isOther: false, isSecret: true, options: null }],
      });
    await vi.waitFor(() => expect(surface.getSnapshot().messages.some((message) => (
      message.parts.some((part) => part.type === 'tool' && part.id === 'ask-cancel-item')
    ))).toBe(true));
    await surface.respondToClientRequest({ id: 'ask-cancel', payload: { cancelled: true } });
    expect(lastResponse(transport, 'ask-cancel')).toMatchObject({ result: { answers: {} } });
    await expect(surface.respondToClientRequest({ id: 'ask-cancel' })).rejects.toThrow('Unknown client request');

    for (const [id, decision, persist] of [
      ['mcp-once', 'allow', null],
      ['mcp-always', 'always_allow', 'always'],
      ['mcp-deny', 'deny', null],
    ] as const) {
      const itemId = `mcp-${id}`;
      transport.emitNotification('item/started', {
          threadId: 'thread-existing', turnId: 'turn-stream', startedAtMs: 1,
          item: { mcpAppUi: null, readOnlyHint: null,
            type: 'mcpToolCall', id: itemId, server: 'tools', tool: 'Run', status: 'inProgress',
            arguments: { path: 'README.md' }, appContext: null, pluginId: null, result: null,
            error: null, durationMs: null,
          },
        });
      transport.emitServerRequest(id, 'mcpServer/elicitation/request', {
          threadId: 'thread-existing', turnId: 'turn-stream', serverName: 'tools', mode: 'form',
          message: '', requestedSchema: { type: 'object', properties: {} },
          _meta: {
            codex_approval_kind: 'mcp_tool_call', tool_title: 'Run', persist,
            tool_params_display: [{ name: 'path', display_name: 'Path', value: { file: 'README.md' } }, null],
          },
        });
      await vi.waitFor(() => expect(surface.getSnapshot().messages.some((message) => (
        message.parts.some((part) => (
          part.type === 'tool'
          && part.id === itemId
          && part.metadata?.confirmationRequestId === id
        ))
      ))).toBe(true));
      await surface.respondToClientRequest({ id, payload: { decision } });
      transport.emitNotification('item/completed', {
          threadId: 'thread-existing', turnId: 'turn-stream', completedAtMs: 2,
          item: { mcpAppUi: null, readOnlyHint: null,
            type: 'mcpToolCall', id: itemId, server: 'tools', tool: 'Run',
            status: decision === 'deny' ? 'failed' : 'completed', arguments: { path: 'README.md' },
            appContext: null, pluginId: null, result: null, error: null, durationMs: 1,
          },
        });
    }
    expect(lastResponse(transport, 'mcp-once')).toMatchObject({ result: { action: 'accept', _meta: null } });
    expect(lastResponse(transport, 'mcp-always')).toMatchObject({ result: { _meta: { persist: 'always' } } });
    expect(lastResponse(transport, 'mcp-deny')).toMatchObject({ result: { action: 'decline' } });
  });

  it('adapts server approval requests and resolves them through one surface API', async () => {
    const { surface, transport } = createSurface();
    await surface.connect();

    transport.emitServerRequest(90, 'item/commandExecution/requestApproval', { kind: 'command',
        threadId: 'thread-existing', turnId: 'turn-1', itemId: 'command-1', startedAtMs: 1,
        command: 'npm test', cwd: '/tmp/project', reason: 'Run tests', environmentId: null,
        networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' },
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            read: null,
            write: null,
            entries: [{ path: { type: 'glob_pattern', pattern: '/tmp/results/**' }, access: 'write' }],
          },
        },
      });
    await vi.waitFor(() => expect(surface.getSnapshot().approvals).toHaveLength(1));
    expect(surface.getSnapshot().busy).toBe(true);
    expect(surface.getSnapshot().approvals[0]).toMatchObject({
      id: '90', kind: 'command', title: 'Run command', command: 'npm test',
      requestedPermissions: [
        { kind: 'network', enabled: true, host: 'registry.npmjs.org', protocol: 'https' },
        { kind: 'filesystem', access: 'write', path: '/tmp/results/**' },
      ],
    });
    await surface.resolveApproval('90', 'approve', 'session');
    expect(lastResponse(transport, 90)).toMatchObject({ result: { decision: 'acceptForSession' } });

    transport.emitServerRequest('patch-1', 'item/fileChange/requestApproval', { threadId: 'thread-existing', turnId: 'turn-1', itemId: 'patch-item', startedAtMs: 1, grantRoot: '/tmp/project' });
    await vi.waitFor(() => expect(surface.getSnapshot().approvals).toHaveLength(1));
    await surface.resolveApproval('patch-1', 'deny');
    expect(lastResponse(transport, 'patch-1')).toMatchObject({ result: { decision: 'decline' } });

    transport.emitServerRequest(91, 'item/permissions/requestApproval', {
        threadId: 'thread-existing', turnId: 'turn-1', itemId: 'permissions-1', startedAtMs: 1,
        environmentId: null, cwd: '/tmp/project', reason: null,
        permissions: {
          network: { enabled: null },
          fileSystem: {
            read: ['/tmp'],
            write: ['/tmp'],
            entries: [
              { path: { type: 'path', path: '/var/log' }, access: 'read' },
              { path: { type: 'special', value: { kind: 'root' } }, access: 'deny' },
              { path: { type: 'special', value: { kind: 'minimal' } }, access: 'read' },
              { path: { type: 'special', value: { kind: 'project_roots', subpath: 'src' } }, access: 'write' },
              { path: { type: 'special', value: { kind: 'tmpdir' } }, access: 'write' },
              { path: { type: 'special', value: { kind: 'slash_tmp' } }, access: 'write' },
              { path: { type: 'special', value: { kind: 'unknown', path: '/private', subpath: 'cache' } }, access: 'write' },
            ],
          },
        },
      });
    await vi.waitFor(() => expect(surface.getSnapshot().approvals).toHaveLength(1));
    expect(surface.getSnapshot().approvals[0]?.requestedPermissions).toStrictEqual([
      { kind: 'network', enabled: false },
      { kind: 'filesystem', access: 'read', path: '/tmp' },
      { kind: 'filesystem', access: 'write', path: '/tmp' },
      { kind: 'filesystem', access: 'read', path: '/var/log' },
      { kind: 'filesystem', access: 'deny', path: 'filesystem root' },
      { kind: 'filesystem', access: 'read', path: 'minimal runtime paths' },
      { kind: 'filesystem', access: 'write', path: 'project roots/src' },
      { kind: 'filesystem', access: 'write', path: 'system temporary directory' },
      { kind: 'filesystem', access: 'write', path: '/tmp' },
      { kind: 'filesystem', access: 'write', path: '/private/cache' },
    ]);
    await surface.resolveApproval('91', 'approve');
    expect(lastResponse(transport, 91)).toMatchObject({ result: { scope: 'turn' } });

    transport.emitServerRequest(92, 'item/permissions/requestApproval', {
        threadId: 'thread-existing', turnId: 'turn-1', itemId: 'permissions-2', startedAtMs: 1,
        environmentId: null, cwd: '/tmp/project', reason: 'Use network',
        permissions: { fileSystem: null, network: { enabled: true } },
      });
    await vi.waitFor(() => expect(surface.getSnapshot().approvals).toHaveLength(1));
    await surface.resolveApproval('92', 'deny', 'session');
    expect(lastResponse(transport, 92)).toMatchObject({ result: { permissions: {}, scope: 'session' } });

    transport.emitServerRequest('legacy-command', 'execCommandApproval', {
        conversationId: 'thread-existing', callId: 'legacy-command-item', approvalId: null,
        command: ['npm', 'test'], cwd: '/tmp/project', reason: 'Verify', parsedCmd: [],
      });
    await vi.waitFor(() => expect(surface.getSnapshot().approvals).toHaveLength(1));
    await surface.resolveApproval('legacy-command', 'approve');
    expect(lastResponse(transport, 'legacy-command')).toMatchObject({ result: { decision: 'approved' } });

    transport.emitServerRequest('legacy-patch', 'applyPatchApproval', {
        conversationId: 'thread-existing', callId: 'legacy-patch-item', fileChanges: {},
        reason: null, grantRoot: '/tmp/project',
      });
    await vi.waitFor(() => expect(surface.getSnapshot().approvals).toHaveLength(1));
    expect(surface.getSnapshot().approvals[0]?.description).toBe('Write under /tmp/project');
    await surface.resolveApproval('legacy-patch', 'approve', 'session');
    expect(lastResponse(transport, 'legacy-patch')).toMatchObject({ result: { decision: 'approved_for_session' } });

    transport.emitServerRequest(93, 'item/commandExecution/requestApproval', { kind: 'command',
        threadId: 'thread-existing', turnId: 'turn-1', itemId: 'command-2', startedAtMs: 1,
        command: null, cwd: null, reason: null, environmentId: null,
        availableDecisions: ['accept', 'cancel'],
      });
    await vi.waitFor(() => expect(surface.getSnapshot().approvals).toHaveLength(1));
    expect(surface.getSnapshot().approvals[0]).toMatchObject({ allowedScopes: ['once'], canDeny: true });
    await expect(surface.resolveApproval('93', 'approve', 'session')).rejects.toThrow(
      "Approval decision 'approve:session' is not available",
    );
    await surface.resolveApproval('93', 'deny');
    expect(lastResponse(transport, 93)).toMatchObject({ result: { decision: 'cancel' } });

    transport.emitServerRequest('patch-2', 'item/fileChange/requestApproval', {
        threadId: 'thread-existing', turnId: 'turn-1', itemId: 'patch-item-2', startedAtMs: 1,
        reason: 'Update generated files', grantRoot: null,
      });
    await vi.waitFor(() => expect(surface.getSnapshot().approvals).toHaveLength(1));
    await surface.resolveApproval('patch-2', 'approve', 'session');
    expect(lastResponse(transport, 'patch-2')).toMatchObject({ result: { decision: 'acceptForSession' } });

    transport.emitServerRequest(94, 'item/permissions/requestApproval', {
        threadId: 'thread-existing', turnId: 'turn-1', itemId: 'permissions-3', startedAtMs: 1,
        environmentId: null, cwd: '/tmp/project', reason: 'Use network',
        permissions: { fileSystem: null, network: { enabled: true } },
      });
    await vi.waitFor(() => expect(surface.getSnapshot().approvals).toHaveLength(1));
    await surface.resolveApproval('94', 'approve', 'session');
    expect(lastResponse(transport, 94)).toMatchObject({ result: { scope: 'session' } });

    transport.emitServerRequest('legacy-command-deny', 'execCommandApproval', {
        conversationId: 'thread-existing', callId: 'legacy-command-deny-item', approvalId: null,
        command: ['false'], cwd: '/tmp/project', reason: null, parsedCmd: [],
      });
    await vi.waitFor(() => expect(surface.getSnapshot().approvals).toHaveLength(1));
    await surface.resolveApproval('legacy-command-deny', 'deny');
    expect(lastResponse(transport, 'legacy-command-deny')).toMatchObject({
      result: { decision: { denied: { rejection: 'Denied by user' } } },
    });

    transport.emitServerRequest('legacy-patch-deny', 'applyPatchApproval', {
        conversationId: 'thread-existing', callId: 'legacy-patch-deny-item', fileChanges: {},
        reason: 'Review changes', grantRoot: null,
      });
    await vi.waitFor(() => expect(surface.getSnapshot().approvals).toHaveLength(1));
    await surface.resolveApproval('legacy-patch-deny', 'deny');
    expect(lastResponse(transport, 'legacy-patch-deny')).toMatchObject({
      result: { decision: { denied: { rejection: 'Denied by user' } } },
    });

    transport.emitServerRequest('legacy-patch-once', 'applyPatchApproval', {
        conversationId: 'thread-existing', callId: 'legacy-patch-once-item', fileChanges: {},
        reason: null, grantRoot: null,
      });
    await vi.waitFor(() => expect(surface.getSnapshot().approvals).toHaveLength(1));
    await surface.resolveApproval('legacy-patch-once', 'approve');
    expect(lastResponse(transport, 'legacy-patch-once')).toMatchObject({ result: { decision: 'approved' } });
  });

});
