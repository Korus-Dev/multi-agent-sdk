import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk';
import { CodexHost } from '../../src/providers/codex';
import type { CodexHostEvent } from '../../src/index';
import {
  MockCodexAppServer,
  lastRequest,
  lastResponse,
  requestsFor,
  resumeResponse,
  thread,
  turn,
} from './helpers/host-fixture';

describe('CodexHost conversation forks', () => {
  it.each(['latest', 'turn'] as const)(
    'inherits source host context when forking the %s boundary',
    async (boundary) => {
      const configureConversation = vi.fn(async () => ({}));
      const transport = forkTransport();
      const host = new CodexHost({
        client: new CodexAppServerClient(transport),
        extensions: [{ configureConversation }],
      });
      await host.connect();
      await host.conversation('thread-existing').load({
        extensionContext: { source: 'remembered' },
      });
      configureConversation.mockClear();

      if (boundary === 'latest') {
        await host.forkConversation('thread-existing');
      } else {
        await host.forkConversationAtTurn('thread-existing', 'turn-history');
      }

      expect(configureConversation).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'start',
        extensionContext: { source: 'remembered' },
      }));
    },
  );

  it('forks the latest completed conversation into an unselected usable handle', async () => {
    const transport = forkTransport();
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      cwd: '/tmp/project',
    });
    const events: CodexHostEvent[] = [];
    host.onEvent((event) => events.push(event));

    const result = await host.conversation('thread-existing').fork();

    expect(transport.start).toHaveBeenCalledOnce();
    expect(lastRequest(transport, 'thread/fork')).toMatchObject({
      method: 'thread/fork',
      params: {
        threadId: 'thread-existing',
        excludeTurns: true,
        deferGoalContinuation: true,
      },
    });
    expect(lastRequest(transport, 'thread/turns/list')).toMatchObject({
      params: {
        threadId: 'thread-forked',
        cursor: null,
        limit: 5,
        sortDirection: 'desc',
        itemsView: 'full',
      },
    });
    expect(result).toMatchObject({
      conversationId: 'thread-forked',
      conversation: { id: 'thread-forked' },
      snapshot: {
        activeConversationId: 'thread-forked',
        turnIds: ['turn-forked-history'],
      },
    });
    expect(result.snapshot.messages.flatMap((message) => message.parts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'Forked request' }),
      expect.objectContaining({ type: 'text', text: 'Forked reply' }),
    ]));
    expect(host.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-existing',
      conversations: expect.arrayContaining([expect.objectContaining({ id: 'thread-forked' })]),
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'conversation.summaryUpserted', conversationId: 'thread-forked', origin: 'action',
        payload: expect.objectContaining({ reason: 'created' }),
      }),
      expect.objectContaining({
        type: 'conversation.historyReplaced', conversationId: 'thread-forked', origin: 'action',
        payload: expect.objectContaining({ reason: 'fork' }),
      }),
      expect.objectContaining({
        type: 'conversation.activityChanged', conversationId: 'thread-forked', origin: 'action',
      }),
      expect.objectContaining({
        type: 'conversation.settingsChanged', conversationId: 'thread-forked', origin: 'action',
      }),
      expect.objectContaining({
        type: 'conversation.skillsChanged', conversationId: 'thread-forked', origin: 'action',
      }),
      expect.objectContaining({
        type: 'conversation.permissionsChanged', conversationId: 'thread-forked', origin: 'action',
      }),
    ]));

    await result.conversation.sendMessage('Continue from the fork');
    expect(lastRequest(transport, 'turn/start')).toMatchObject({
      params: {
        threadId: 'thread-forked',
        input: [{ type: 'text', text: 'Continue from the fork' }],
      },
    });
  });

  it('applies trusted fork overrides and host extension context', async () => {
    const execute = vi.fn(async () => 'done');
    const configureConversation = vi.fn(async () => ({
      config: { extension_flag: true },
      developerInstructions: 'Extension instructions',
    }));
    const transport = forkTransport({
      model: 'gpt-mini-runtime',
      serviceTier: 'priority',
      cwd: '/workspace/fork',
      reasoningEffort: 'high',
    });
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      cwd: '/tmp/project',
      extensions: [{
        configureConversation,
        dynamicTools: [{
          name: 'inspect', description: 'Inspect', inputSchema: { type: 'object' }, execute,
        }],
      }],
    });
    await host.connect();
    configureConversation.mockClear();

    const result = await host.forkConversation('thread-existing', {
      approvalPreset: 'full-access',
      baseInstructions: 'Fork base instructions',
      config: { host_flag: 'fork' },
      cwd: '/workspace/fork',
      developerInstructions: 'Host instructions',
      model: 'gpt-mini',
      reasoningEffort: 'high',
      serviceTier: 'priority',
    }, { extensionContext: { agentId: 'agent-forked' } });

    expect(configureConversation).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'start',
      conversationId: null,
      cwd: '/workspace/fork',
      extensionContext: { agentId: 'agent-forked' },
    }));
    expect(lastRequest(transport, 'thread/fork')).toMatchObject({
      params: {
        threadId: 'thread-existing',
        model: 'gpt-mini-runtime',
        serviceTier: 'priority',
        cwd: '/workspace/fork',
        baseInstructions: 'Fork base instructions',
        developerInstructions: 'Extension instructions\n\nHost instructions',
        config: { extension_flag: true, host_flag: 'fork' },
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        permissions: ':danger-full-access',
      },
    });
    expect(lastRequest(transport, 'thread/settings/update')).toMatchObject({
      params: { threadId: 'thread-forked', effort: 'high' },
    });
    expect(result.snapshot).toMatchObject({
      selectedModelId: 'gpt-mini',
      selectedReasoningEffort: 'high',
      selectedServiceTier: 'priority',
    });
    transport.emitServerRequest('fork-context', 'item/tool/call', {
        threadId: 'thread-forked', turnId: 'turn-forked', callId: 'call-forked',
        namespace: null, tool: 'inspect', arguments: {},
      });
    await vi.waitFor(() => expect(lastResponse(transport, 'fork-context')).toMatchObject({
      result: { success: true },
    }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'thread-forked', extensionContext: { agentId: 'agent-forked' },
    }));
  });

  it('eagerly hydrates the remaining history of a fork', async () => {
    const transport = forkTransport({
      forkNextCursor: 'fork-older',
      forkOlderTurns: [turn('turn-forked-older', 'completed', [
        { type: 'userMessage', id: 'forked-older-user', clientId: null, content: [{ type: 'text', text: 'Older fork prompt', text_elements: [] }] },
        { type: 'agentMessage', id: 'forked-older-agent', text: 'Older fork reply', phase: null, memoryCitation: null, delivery: null, questions: null },
      ])],
    });
    const host = new CodexHost({
      client: new CodexAppServerClient(transport), loadingStrategy: 'eager',
    });
    await host.connect();

    const result = await host.conversation('thread-existing').fork();

    await vi.waitFor(() => expect(result.conversation.getSnapshot().turnIds).toEqual([
      'turn-forked-older', 'turn-forked-history',
    ]));
    expect(requestsFor(transport, 'thread/turns/list')).toEqual(expect.arrayContaining([
      expect.objectContaining({ params: expect.objectContaining({ threadId: 'thread-forked', cursor: 'fork-older' }) }),
    ]));
    await host.close();
  });

  it('forks through the selected turn and discards later turns', async () => {
    const transport = forkTransport({
      sourceTurns: [
        turn('turn-one', 'completed', [
          { type: 'userMessage', id: 'user-one', clientId: null, content: [{ type: 'text', text: 'First', text_elements: [] }] },
          { type: 'agentMessage', id: 'agent-one', text: 'First reply', phase: null, memoryCitation: null, delivery: null, questions: null },
        ]),
        turn('turn-two', 'completed', [
          { type: 'userMessage', id: 'user-two', clientId: null, content: [{ type: 'text', text: 'Second', text_elements: [] }] },
          { type: 'agentMessage', id: 'agent-two', text: 'Second reply', phase: null, memoryCitation: null, delivery: null, questions: null },
        ]),
      ],
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();

    const result = await host.conversation('thread-existing').forkTurn('turn-one');

    expect(lastRequest(transport, 'thread/fork')).toMatchObject({
      params: { threadId: 'thread-existing', lastTurnId: 'turn-one' },
    });
    expect(result).toMatchObject({
      conversationId: 'thread-forked',
      snapshot: { activeConversationId: 'thread-forked' },
    });
    expect(requestsFor(transport, 'turn/start')).toHaveLength(0);
  });

  it('forks through a later selected turn without resubmitting its prompt', async () => {
    const transport = forkTransport({
      sourceTurns: [
        turn('turn-one', 'completed', [
          { type: 'userMessage', id: 'user-one', clientId: null, content: [{ type: 'text', text: 'First', text_elements: [] }] },
          { type: 'agentMessage', id: 'agent-one', text: 'First reply', phase: null, memoryCitation: null, delivery: null, questions: null },
        ]),
        turn('turn-two', 'completed', [
          {
            type: 'userMessage', id: 'user-two', clientId: null,
            content: [
              { type: 'text', text: 'Second request', text_elements: [] },
              { type: 'localImage', path: '/tmp/second.png' },
            ],
          },
          { type: 'agentMessage', id: 'agent-two', text: 'Second reply', phase: null, memoryCitation: null, delivery: null, questions: null },
        ]),
      ],
    });
    const host = new CodexHost({ client: new CodexAppServerClient(transport) });
    await host.connect();

    const result = await host.forkTurn('turn-two');

    expect(lastRequest(transport, 'thread/fork')).toMatchObject({
      params: { threadId: 'thread-existing', lastTurnId: 'turn-two' },
    });
    expect(requestsFor(transport, 'turn/start')).toHaveLength(0);
    expect(result).toMatchObject({ activeConversationId: 'thread-forked', busy: false });
    expect(host.getSnapshot().activeConversationId).toBe('thread-forked');
  });

});

function forkTransport(overrides: {
  model?: string;
  serviceTier?: string | null;
  cwd?: string;
  reasoningEffort?: string | null;
  sourceTurns?: v2.Turn[];
  forkNextCursor?: string | null;
  forkOlderTurns?: v2.Turn[];
} = {}): MockCodexAppServer {
  const forkedTurn = turn('turn-forked-history', 'completed', [
    {
      type: 'userMessage', id: 'forked-user', clientId: null,
      content: [{ type: 'text', text: 'Forked request', text_elements: [] }],
    },
    { type: 'agentMessage', id: 'forked-agent', text: 'Forked reply', phase: null, memoryCitation: null, delivery: null, questions: null },
  ]);
  return new MockCodexAppServer({
    'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
    'thread/settings/update': () => ({}),
    'thread/fork': () => ({ disabledPluginIds: [],
      thread: thread('thread-forked', false),
      model: overrides.model ?? 'gpt-5',
      modelProvider: 'openai',
      serviceTier: overrides.serviceTier ?? null,
      cwd: overrides.cwd ?? '/tmp/project',
      runtimeWorkspaceRoots: [],
      instructionSources: [],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: {
        type: 'workspaceWrite', writableRoots: ['/tmp/project'], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
      activePermissionProfile: { id: ':workspace', extends: null },
      reasoningEffort: overrides.reasoningEffort ?? 'medium',
      multiAgentMode: 'explicitRequestOnly',
    }),
    'thread/turns/list': (params) => {
      const { threadId, cursor } = params as { threadId: string; cursor: string | null };
      if (threadId !== 'thread-forked') {
        return {
          data: overrides.sourceTurns ?? thread('thread-existing', true).turns,
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      return cursor === 'fork-older'
        ? { data: overrides.forkOlderTurns ?? [], nextCursor: null, backwardsCursor: null }
        : { data: [forkedTurn], nextCursor: overrides.forkNextCursor ?? null, backwardsCursor: null };
    },
    'thread/resume': (params) => {
      const threadId = (params as { threadId: string }).threadId;
      return threadId === 'thread-forked'
        ? resumeResponse({ ...thread('thread-forked', false), turns: [forkedTurn] })
        : resumeResponse({
          ...thread('thread-existing', false),
          turns: (overrides.sourceTurns ?? thread('thread-existing', true).turns) as ReturnType<typeof turn>[],
        });
    },
  });
}
