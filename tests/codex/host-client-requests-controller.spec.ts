import { describe, expect, it, vi } from 'vitest';
import {
  CodexHostClientRequestsController,
  type CodexHostClientRequestsDependencies,
} from '../../src/providers/codex/host-client-requests-controller';
import { createThreadRuntime, initialHostSnapshot } from '../../src/providers/codex/host-runtime';
import { initialAuthentication } from '../../src/providers/codex/host-authentication';

describe('CodexHostClientRequestsController', () => {
  it('rejects empty prompts and resolves normalized ask-user answers', async () => {
    const setup = clientRequests();
    const responder = { resolve: vi.fn(), reject: vi.fn() };
    expect(setup.controller.handleToolInputRequest(askRequest([]), responder as never)).toBe(false);

    expect(setup.controller.handleToolInputRequest(askRequest([{
      id: 'target', header: 'Target', question: 'Which file?', isOther: true, isSecret: false,
      options: [{ label: 'README.md', description: 'Read it' }],
    }]), responder as never)).toBe(true);
    expect(setup.controller.requestsForThread('thread-1')).toMatchObject([{
      id: 'ask-1', kind: 'ask_user', payload: { request: { autoResolutionMs: 60_000 } },
    }]);
    await expect(setup.controller.respond('other', { id: 'ask-1' })).rejects.toThrow("belongs to conversation 'thread-1'");
    await setup.controller.respond('thread-1', {
      id: 'ask-1', payload: { answers: { target: { answers: ['README.md'] } } },
    });
    expect(responder.resolve).toHaveBeenCalledWith({ answers: { target: { answers: ['README.md'] } } });
    expect(setup.runtime.answeredClientRequestIds).toStrictEqual(['ask-1']);
    expect(setup.controller.requestsForThread('thread-1')).toStrictEqual([]);
  });

  it('recognizes only Codex MCP approvals and validates decisions', async () => {
    const setup = clientRequests();
    const responder = { resolve: vi.fn(), reject: vi.fn() };
    expect(setup.controller.handleMcpElicitationRequest(mcpRequest({ mode: 'url' }), responder as never)).toBe(false);
    expect(setup.controller.handleMcpElicitationRequest(mcpRequest(), responder as never)).toBe(true);
    expect(setup.controller.requestsForThread('thread-1')).toMatchObject([{
      id: 'mcp-1', kind: 'confirm_tool',
      payload: { confirmation: { allowConversation: true, allowAlways: true, toolName: 'create_event' } },
    }]);
    const toolPart = setup.runtime.messages[0]?.parts[0];
    expect(JSON.parse((toolPart as { statusText: string }).statusText).params).toMatchObject({
      allowConversation: true,
      allowAlways: true,
    });
    await expect(setup.controller.respond(undefined, {
      id: 'mcp-1', payload: { decision: 'invalid' as never },
    })).rejects.toThrow("Invalid tool confirmation decision 'invalid'");
    await setup.controller.respond(undefined, { id: 'mcp-1', payload: { decision: 'always_allow' } });
    expect(responder.resolve).toHaveBeenCalledWith({ action: 'accept', content: null, _meta: { persist: 'always' } });
  });

  it('rejects cleared requests and records server-side resolution', () => {
    const setup = clientRequests();
    const rejected = { resolve: vi.fn(), reject: vi.fn() };
    setup.controller.handleToolInputRequest(askRequest([{ id: 'q', header: 'Q', question: 'Q?' }]), rejected as never);
    setup.controller.clearForThread('thread-1', 'closed', 'conversation_closed');
    expect(rejected.reject).toHaveBeenCalledWith('closed');
    expect(setup.host.emitEvent).toHaveBeenCalledWith('notification', expect.objectContaining({
      type: 'clientRequest.resolved', payload: expect.objectContaining({ reason: 'conversation_closed' }),
    }));

    const resolved = { resolve: vi.fn(), reject: vi.fn() };
    setup.runtime.activeTurnId = null;
    setup.controller.handleToolInputRequest(askRequest([{ id: 'q', header: 'Q', question: 'Q?' }]), resolved as never);
    setup.runtime.activeTurnId = null;
    setup.controller.handleServerResolved('ask-1', 'thread-1');
    expect(setup.runtime.answeredClientRequestIds).toStrictEqual(['ask-1']);
    expect(setup.runtime.busy).toBe(false);
  });

  it('filters request collections by conversation and clears without resolving them', () => {
    const setup = clientRequests();
    const first = { resolve: vi.fn(), reject: vi.fn() };
    const second = { resolve: vi.fn(), reject: vi.fn() };
    setup.controller.handleToolInputRequest(askRequest([question()], { id: 'first' }), first as never);
    setup.controller.handleToolInputRequest(askRequest([question()], {
      id: 'second', threadId: 'thread-2', turnId: 'turn-2', itemId: 'item-2',
    }), second as never);

    expect(setup.controller.requestsForThread('thread-1').map(({ id }) => id)).toStrictEqual(['first']);
    expect(setup.controller.requestsForThread('thread-2').map(({ id }) => id)).toStrictEqual(['second']);
    expect(setup.controller.hasForThread('missing')).toBe(false);
    expect(setup.controller.hasForThread('thread-2')).toBe(true);

    setup.controller.clear();
    expect(setup.controller.requestsForThread('thread-1')).toStrictEqual([]);
    expect(setup.controller.requestsForThread('thread-2')).toStrictEqual([]);
    expect(first.reject).not.toHaveBeenCalled();
    expect(second.reject).not.toHaveBeenCalled();
  });

  it('rejects every pending request and leaves the collection empty', () => {
    const setup = clientRequests();
    const first = { resolve: vi.fn(), reject: vi.fn() };
    const second = { resolve: vi.fn(), reject: vi.fn() };
    setup.controller.handleToolInputRequest(askRequest([question()], { id: 'first' }), first as never);
    setup.controller.handleToolInputRequest(askRequest([question()], { id: 'second' }), second as never);

    setup.controller.rejectAll('host disconnected');

    expect(first.reject).toHaveBeenCalledWith('host disconnected');
    expect(second.reject).toHaveBeenCalledWith('host disconnected');
    expect(setup.controller.hasForThread('thread-1')).toBe(false);
  });

  it('clears only the requested conversation and emits detached resolution payloads', () => {
    const setup = clientRequests();
    const first = { resolve: vi.fn(), reject: vi.fn() };
    const second = { resolve: vi.fn(), reject: vi.fn() };
    setup.controller.handleToolInputRequest(askRequest([question()], { id: 'first' }), first as never);
    setup.controller.handleToolInputRequest(askRequest([question()], {
      id: 'second', threadId: 'thread-2', turnId: 'turn-2', itemId: 'item-2',
    }), second as never);
    setup.host.emitEvent.mockClear();
    setup.host.patchRuntime.mockClear();

    setup.controller.clearForThread('thread-1', 'removed', 'conversation_removed');

    expect(first.reject).toHaveBeenCalledWith('removed');
    expect(second.reject).not.toHaveBeenCalled();
    expect(setup.controller.hasForThread('thread-1')).toBe(false);
    expect(setup.controller.requestsForThread('thread-2').map(({ id }) => id)).toStrictEqual(['second']);
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('thread-1', {});
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('notification', {
      type: 'clientRequest.resolved',
      conversationId: 'thread-1',
      turnId: 'turn-1',
      payload: {
        request: expect.objectContaining({ id: 'first', kind: 'ask_user' }),
        response: null,
        reason: 'conversation_removed',
      },
    });
  });

  it('rejects unknown responses and applies ask-user defaults with exact state and events', async () => {
    const setup = clientRequests();
    await expect(setup.controller.respond(undefined, { id: 'missing' }))
      .rejects.toThrow("Unknown client request 'missing'");
    const responder = { resolve: vi.fn(), reject: vi.fn() };
    setup.controller.handleToolInputRequest(askRequest([question({ options: undefined })], {
      autoResolutionMs: null,
    }), responder as never);
    const request = setup.controller.requestsForThread('thread-1')[0];
    expect(request).toStrictEqual({
      id: 'ask-1',
      kind: 'ask_user',
      conversationId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'ask-item',
      payload: {
        request: {
          itemId: 'ask-item',
          delivery: 'tool',
          blocking: true,
          questions: [{
            id: 'q', header: 'Question', question: 'Continue?', isOther: false,
            isSecret: false, options: null,
          }],
        },
      },
    });
    setup.runtime.activeTurnId = null;
    setup.host.emitEvent.mockClear();
    setup.host.emitConversationActivity.mockClear();
    const response = { id: 'ask-1' };

    await setup.controller.respond(undefined, response);

    expect(responder.resolve).toHaveBeenCalledWith({ answers: {} });
    expect(setup.runtime.answeredClientRequestIds).toStrictEqual(['ask-1']);
    expect(setup.runtime.busy).toBe(false);
    expect(setup.runtime.messages[0]?.parts).toContainEqual(expect.objectContaining({
      type: 'tool', id: 'ask-item', output: { answers: {} },
    }));
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('action', {
      type: 'clientRequest.resolved',
      conversationId: 'thread-1',
      turnId: 'turn-1',
      payload: { request, response, reason: 'host' },
    });
    expect(setup.host.emitConversationActivity).toHaveBeenCalledExactlyOnceWith('thread-1', 'action');
  });

  it('ignores confirmation-only decision fields on ask-user responses', async () => {
    const setup = clientRequests();
    const responder = { resolve: vi.fn(), reject: vi.fn() };
    setup.controller.handleToolInputRequest(askRequest([question()]), responder as never);

    await setup.controller.respond(undefined, {
      id: 'ask-1', payload: { decision: 'not-for-ask-user' as never },
    });

    expect(responder.resolve).toHaveBeenCalledWith({ answers: {} });
  });

  it('maps every MCP decision, including omitted responses, through one contract', async () => {
    const cases = [
      ['allow', { action: 'accept', content: null, _meta: null }],
      ['allow_conversation', { action: 'accept', content: null, _meta: { persist: 'session' } }],
      ['always_allow', { action: 'accept', content: null, _meta: { persist: 'always' } }],
      ['deny', { action: 'decline', content: null, _meta: null }],
      [undefined, { action: 'decline', content: null, _meta: null }],
    ] as const;

    for (const [decision, expected] of cases) {
      const setup = clientRequests();
      const responder = { resolve: vi.fn(), reject: vi.fn() };
      setup.controller.handleMcpElicitationRequest(mcpRequest(), responder as never);
      setup.runtime.activeTurnId = null;

      await setup.controller.respond('thread-1', {
        id: 'mcp-1',
        ...(decision ? { payload: { decision } } : {}),
      });

      expect(responder.resolve).toHaveBeenCalledWith(expected);
      if (decision) {
        expect(setup.runtime.messages[0]?.parts).toContainEqual(expect.objectContaining({
          type: 'tool', id: 'approval-mcp-1', output: { decision },
        }));
      }
      expect(setup.host.emitConversationActivity).toHaveBeenCalledWith('thread-1', 'action');
    }
  });

  it('records server resolution on the owning conversation but clears waiting state for the reported thread', () => {
    const setup = clientRequests();
    const responder = { resolve: vi.fn(), reject: vi.fn() };
    setup.controller.handleToolInputRequest(askRequest([question()], {
      id: 'owned', threadId: 'thread-2', turnId: 'turn-2', itemId: 'item-2',
    }), responder as never);
    setup.runtimeFor('thread-2').activeTurnId = null;
    setup.runtimeFor('thread-3').busy = true;
    setup.host.emitEvent.mockClear();

    setup.controller.handleServerResolved('owned', 'thread-3');

    expect(setup.runtimeFor('thread-2').answeredClientRequestIds).toStrictEqual(['owned']);
    expect(setup.runtimeFor('thread-3').busy).toBe(false);
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('notification', {
      type: 'clientRequest.resolved',
      conversationId: 'thread-2',
      turnId: 'turn-2',
      payload: {
        request: expect.objectContaining({ id: 'owned' }), response: null, reason: 'server',
      },
    });

    setup.host.emitEvent.mockClear();
    setup.runtime.busy = true;
    setup.controller.handleServerResolved('unknown', 'thread-1');
    expect(setup.runtime.busy).toBe(false);
    expect(setup.host.emitEvent).not.toHaveBeenCalled();
  });

  it('clears busy only when no turn, approval, or client request is pending', () => {
    const setup = clientRequests();
    const cases = [
      { turnStartPending: true, activeTurnId: null, approval: false },
      { turnStartPending: false, activeTurnId: 'turn-1', approval: false },
      { turnStartPending: false, activeTurnId: null, approval: true },
    ] as const;
    for (const entry of cases) {
      setup.runtime.busy = true;
      setup.runtime.turnStartPending = entry.turnStartPending;
      setup.runtime.activeTurnId = entry.activeTurnId;
      setup.host.hasPendingApproval.mockReturnValue(entry.approval);
      setup.controller.maybeClearWaitingBusy('thread-1');
      expect(setup.runtime.busy).toBe(true);
    }

    setup.runtime.turnStartPending = false;
    setup.runtime.activeTurnId = null;
    setup.host.hasPendingApproval.mockReturnValue(false);
    const responder = { resolve: vi.fn(), reject: vi.fn() };
    setup.controller.handleToolInputRequest(askRequest([question()]), responder as never);
    setup.runtime.activeTurnId = null;
    setup.controller.maybeClearWaitingBusy('thread-1');
    expect(setup.runtime.busy).toBe(true);
    setup.controller.clear();
    setup.controller.maybeClearWaitingBusy('thread-1');
    expect(setup.runtime.busy).toBe(false);
  });

  it('publishes exact ask-user tool and request events with cloned option data', () => {
    const setup = clientRequests();
    const responder = { resolve: vi.fn(), reject: vi.fn() };
    const options = [{ label: 'Yes', description: 'Continue' }];
    const request = askRequest([question({ options })], { id: 17 });
    setup.runtime.messages = [{
      id: 'assistant-turn-1', role: 'assistant', status: 'streaming',
      metadata: { conversationId: 'thread-1', turnId: 'turn-1' },
      parts: [
        { type: 'text', text: 'same item id, wrong part type', itemId: 'ask-item' },
        { type: 'tool', id: 'other-item', kind: 'generic', title: 'other', status: 'running' },
      ],
    }];

    expect(setup.controller.handleToolInputRequest(request, responder as never)).toBe(true);

    options[0]!.label = 'mutated';
    const pending = setup.controller.requestsForThread('thread-1')[0];
    expect(pending?.id).toBe('17');
    expect(pending?.payload).toMatchObject({ request: { questions: [{ options: [{ label: 'Yes' }] }] } });
    const toolPart = setup.runtime.messages[0]?.parts.find((part) => part.type === 'tool' && part.id === 'ask-item');
    expect(toolPart).toMatchObject({
      type: 'tool', id: 'ask-item', kind: 'generic', title: 'ask_user_question', status: 'running',
      input: [expect.objectContaining({ question: 'Continue?' })],
      metadata: { requestId: '17', question: 'Continue?' },
    });
    expect(JSON.parse((toolPart as { statusText: string }).statusText)).toStrictEqual({
      source: 'codex', action: 'ask_user_question', phase: 'running',
      params: {
        requestId: '17',
        questions: (pending?.payload as unknown as { request: { questions: readonly unknown[] } }).request.questions,
      },
    });
    expect(setup.host.emitEvent.mock.calls).toStrictEqual([
      ['notification', {
        type: 'tool.started', conversationId: 'thread-1', turnId: 'turn-1',
        payload: { messageId: setup.runtime.messages[0]?.id, toolPart },
      }],
      ['notification', {
        type: 'clientRequest.requested', conversationId: 'thread-1', turnId: 'turn-1',
        payload: { request: pending },
      }],
    ]);
    expect(setup.host.emitConversationActivity).toHaveBeenCalledWith('thread-1', 'notification');
    expect(setup.host.markRuntimeTurnActive).toHaveBeenCalledExactlyOnceWith(setup.runtime, 'turn-1');
  });

  it('still publishes an ask-user request when its tool message cannot be located', () => {
    const setup = clientRequests({ hideToolMessages: true });
    const responder = { resolve: vi.fn(), reject: vi.fn() };

    setup.controller.handleToolInputRequest(askRequest([question()]), responder as never);

    expect(setup.host.emitEvent).toHaveBeenCalledTimes(1);
    expect(setup.host.emitEvent).toHaveBeenCalledWith('notification', expect.objectContaining({
      type: 'clientRequest.requested',
    }));
  });

  it('rejects non-approval MCP forms without creating state', () => {
    const setup = clientRequests();
    const responder = { resolve: vi.fn(), reject: vi.fn() };
    const invalid = [
      mcpRequest({ mode: 'url' }),
      mcpRequest({ _meta: null }),
      mcpRequest({ _meta: [] }),
      mcpRequest({ _meta: { codex_approval_kind: 'other' } }),
    ];

    expect(invalid.map((request) => (
      setup.controller.handleMcpElicitationRequest(request, responder as never)
    ))).toStrictEqual([false, false, false, false]);
    expect(setup.controller.requestsForThread('thread-1')).toStrictEqual([]);
    expect(setup.host.patchRuntime).not.toHaveBeenCalled();
    expect(setup.host.emitEvent).not.toHaveBeenCalled();
  });

  it('uses MCP metadata fallbacks and a synthetic display turn when no turn is active', () => {
    const setup = clientRequests();
    const responder = { resolve: vi.fn(), reject: vi.fn() };
    const request = {
      ...(mcpRequest({
        message: '   ',
        _meta: {
          codex_approval_kind: 'mcp_tool_call', tool_name: ' ', tool_title: ' Search ',
          connector_name: 42, tool_params: { query: 'docs' }, persist: 'session',
        },
      }) as unknown as Record<string, unknown>),
      id: 42,
    } as never;

    setup.controller.handleMcpElicitationRequest(request, responder as never);

    const pending = setup.controller.requestsForThread('thread-1')[0];
    expect(pending).toStrictEqual({
      id: '42', kind: 'confirm_tool', conversationId: 'thread-1', turnId: null,
      itemId: 'approval-42',
      payload: { confirmation: {
        argumentsPreview: '{\n  "query": "docs"\n}',
        integrationId: 'calendar', integrationName: 'calendar',
        summary: 'Allow calendar to run Search?', toolName: 'Search', allowConversation: true,
      } },
    });
    const toolPart = setup.runtime.messages[0]?.parts[0];
    expect(setup.runtime.messages[0]?.metadata?.turnId).toBe('client-request-42');
    expect(setup.runtime.busy).toBe(true);
    expect(toolPart).toMatchObject({
      type: 'tool', id: 'approval-42', kind: 'mcp', title: 'calendar.Search',
      input: { query: 'docs' },
      metadata: { requestId: '42', confirmationRequestId: '42', server: 'calendar', tool: 'Search' },
    });
    expect(JSON.parse((toolPart as { statusText: string }).statusText)).toStrictEqual({
      source: 'mcp', action: 'confirm_tool', phase: 'running',
      params: {
        requestId: '42', confirmationSummary: 'Allow calendar to run Search?',
        argumentsPreview: '{\n  "query": "docs"\n}', allowConversation: true, allowAlways: false,
      },
    });
    expect(setup.host.markRuntimeTurnActive).not.toHaveBeenCalled();
    expect(setup.host.emitEvent.mock.calls[0]).toStrictEqual(['notification', {
      type: 'tool.started', conversationId: 'thread-1', turnId: 'client-request-42',
      payload: { messageId: setup.runtime.messages[0]?.id, toolPart },
    }]);
    expect(setup.host.emitEvent.mock.calls[1]).toStrictEqual(['notification', {
      type: 'clientRequest.requested', conversationId: 'thread-1',
      payload: { request: pending },
    }]);
    expect(setup.host.emitConversationActivity).toHaveBeenCalledExactlyOnceWith('thread-1', 'notification');
  });

  it('reuses a pending MCP tool and active display turn while preserving metadata', () => {
    const setup = clientRequests();
    setup.runtime.activeTurnId = 'active-turn';
    setup.runtime.messages = [{
      id: 'assistant-active', role: 'assistant', status: 'streaming',
      metadata: { conversationId: 'thread-1', turnId: 'active-turn' },
      parts: [{
        type: 'tool', id: 'existing-tool', kind: 'mcp', title: 'calendar.create_event',
        status: 'running', metadata: { server: 'calendar', tool: 'create_event', retained: true },
      }],
    }];
    const responder = { resolve: vi.fn(), reject: vi.fn() };

    setup.controller.handleMcpElicitationRequest(mcpRequest({ message: ' Confirm this ' }), responder as never);

    const pending = setup.controller.requestsForThread('thread-1')[0];
    expect(pending).toMatchObject({ itemId: 'existing-tool', payload: { confirmation: { summary: 'Confirm this' } } });
    expect(setup.runtime.messages[0]?.parts[0]).toMatchObject({
      id: 'existing-tool', metadata: { retained: true, requestId: 'mcp-1' },
    });
    expect(setup.host.emitEvent).toHaveBeenCalledWith('notification', expect.objectContaining({
      type: 'tool.started', conversationId: 'thread-1', turnId: 'active-turn',
    }));
    const started = setup.host.emitEvent.mock.calls.find(([, event]) => event.type === 'tool.started')?.[1];
    expect(started?.payload).toMatchObject({ toolPart: { metadata: { retained: true, requestId: 'mcp-1' } } });
  });

  it('activates an explicit MCP turn, uses the generic tool fallback, and includes the turn in events', () => {
    const setup = clientRequests();
    const responder = { resolve: vi.fn(), reject: vi.fn() };
    const request = mcpRequest({
      turnId: 'explicit-turn',
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: null, persist: [] },
    });

    setup.controller.handleMcpElicitationRequest(request, responder as never);

    expect(setup.host.markRuntimeTurnActive).toHaveBeenCalledExactlyOnceWith(setup.runtime, 'explicit-turn');
    expect(setup.controller.requestsForThread('thread-1')[0]).toMatchObject({
      turnId: 'explicit-turn',
      payload: { confirmation: { toolName: 'tool', summary: 'Allow calendar to run tool?' } },
    });
    expect(setup.host.emitEvent).toHaveBeenCalledWith('notification', {
      type: 'clientRequest.requested', conversationId: 'thread-1', turnId: 'explicit-turn',
      payload: { request: setup.controller.requestsForThread('thread-1')[0] },
    });
  });

  it('publishes an MCP request without a tool event when its message cannot be located', () => {
    const setup = clientRequests({ hideToolMessages: true });
    const responder = { resolve: vi.fn(), reject: vi.fn() };

    setup.controller.handleMcpElicitationRequest(mcpRequest(), responder as never);

    expect(setup.host.emitEvent).toHaveBeenCalledTimes(1);
    expect(setup.host.emitEvent).toHaveBeenCalledWith('notification', expect.objectContaining({
      type: 'clientRequest.requested',
    }));
  });
});

function clientRequests(options: { hideToolMessages?: boolean } = {}) {
  const runtime = createThreadRuntime('thread-1', initialHostSnapshot(initialAuthentication()));
  const runtimes = new Map([['thread-1', runtime]]);
  const runtimeFor = (threadId: string) => {
    let target = runtimes.get(threadId);
    if (!target) {
      target = createThreadRuntime(threadId, initialHostSnapshot(initialAuthentication()));
      runtimes.set(threadId, target);
    }
    return target;
  };
  const host: CodexHostClientRequestsDependencies = {
    activeConversationId: () => 'thread-1',
    answerAsyncQuestion: vi.fn(async () => undefined),
    emitConversationActivity: vi.fn(),
    emitEvent: vi.fn(),
    hasPendingApproval: vi.fn(() => false),
    markRuntimeTurnActive: vi.fn((target, turnId) => {
      target.activeTurnId = turnId;
      target.busy = true;
    }),
    messageContainingTool: (threadId, turnId, itemId) => options.hideToolMessages ? null : runtimeFor(threadId).messages.find((message) => (
      message.metadata?.turnId === turnId
      && message.parts.some((part) => part.type === 'tool' && part.id === itemId)
    )) ?? null,
    patchRuntime: vi.fn((threadId, patch) => Object.assign(runtimeFor(threadId), patch)),
    requireRuntime: runtimeFor,
  };
  return {
    controller: new CodexHostClientRequestsController(host),
    host: host as typeof host & {
      emitConversationActivity: ReturnType<typeof vi.fn>;
      emitEvent: ReturnType<typeof vi.fn>;
      hasPendingApproval: ReturnType<typeof vi.fn>;
      patchRuntime: ReturnType<typeof vi.fn>;
    },
    runtime,
    runtimeFor,
  };
}

function askRequest(questions: unknown[], overrides: Record<string, unknown> = {}) {
  const { id = 'ask-1', ...params } = overrides;
  return {
    id, method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'ask-item', autoResolutionMs: 60_000,
      isBlocking: true, questions,
      ...params,
    },
  } as never;
}

function question(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q', header: 'Question', question: 'Continue?', isOther: false, isSecret: false,
    options: [{ label: 'Yes', description: 'Continue' }],
    ...overrides,
  };
}

function mcpRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mcp-1', method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread-1', turnId: null, serverName: 'calendar', mode: 'form',
      message: '', requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call', tool_name: 'create_event', connector_name: 'Calendar',
        tool_params: { title: 'Planning' }, persist: ['session', 'always'],
      },
      ...overrides,
    },
  } as never;
}
