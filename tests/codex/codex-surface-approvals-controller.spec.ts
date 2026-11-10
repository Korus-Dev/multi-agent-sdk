import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, type ServerRequest } from '@korus-dev/codex-sdk';
import type { CodexSurfaceSnapshot } from '../../src/index';
import {
  CodexSurfaceApprovalsController,
  type CodexSurfaceApprovalsHost,
} from '../../src/providers/codex/codex-surface-approvals-controller';
import { createThreadRuntime, initialSurfaceSnapshot } from '../../src/providers/codex/codex-surface-runtime';
import { initialAuthentication } from '../../src/providers/codex/codex-surface-authentication';
import { MockCodexAppServer } from './helpers/codex-surface-fixture';

describe('CodexSurfaceApprovalsController', () => {
  it('surfaces, validates, and resolves an app-server approval', async () => {
    const setup = approvals();
    await setup.client.start();
    setup.transport.emitServerRequestFrame(commandApproval('approval-1'));
    await vi.waitFor(() => expect(setup.controller.approvalsForThread('thread-1')).toHaveLength(1));
    expect(setup.runtime.busy).toBe(true);
    expect(setup.host.patchConversationStatus).toHaveBeenCalledWith('thread-1', 'active');

    await expect(setup.controller.resolve('other', 'approval-1', 'approve', 'once'))
      .rejects.toThrow("belongs to conversation 'thread-1'");
    await expect(setup.controller.resolve(undefined, 'approval-1', 'approve', 'session'))
      .rejects.toThrow("approve:session' is not available");
    const approval = setup.controller.approvalsForThread('thread-1')[0];
    setup.host.emitEvent.mockClear();
    await setup.controller.resolve(undefined, 'approval-1', 'approve', 'once');
    expect(setup.transport.sent).toContainEqual(expect.objectContaining({
      id: 'approval-1', result: { decision: 'accept' },
    }));
    expect(setup.controller.approvalsForThread('thread-1')).toStrictEqual([]);
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('action', {
      type: 'approval.resolved', conversationId: 'thread-1', turnId: 'turn-1',
      payload: { approval, decision: 'approve', scope: 'once', reason: 'host' },
    });
    setup.controller.close();
  });

  it('denies approvals when a conversation closes and observes server resolution', async () => {
    const setup = approvals();
    await setup.client.start();
    setup.transport.emitServerRequestFrame(commandApproval('approval-close'));
    await vi.waitFor(() => expect(setup.controller.hasForThread('thread-1')).toBe(true));
    setup.controller.clearForThread('thread-1', 'conversation_closed');
    expect(setup.transport.sent).toContainEqual(expect.objectContaining({
      id: 'approval-close', result: { decision: 'decline' },
    }));

    setup.transport.emitServerRequestFrame(commandApproval('approval-server'));
    await vi.waitFor(() => expect(setup.controller.hasForThread('thread-1')).toBe(true));
    setup.controller.handleServerResolved('approval-server');
    expect(setup.host.emitEvent).toHaveBeenCalledWith('notification', expect.objectContaining({
      type: 'approval.resolved', payload: expect.objectContaining({ reason: 'server' }),
    }));
    setup.controller.close();
  });

  it('filters approvals by conversation and denies all pending requests', async () => {
    const setup = approvals();
    await setup.client.start();
    setup.transport.emitServerRequestFrame(commandApproval('first'));
    setup.transport.emitServerRequestFrame(commandApproval('second', { threadId: 'thread-2', itemId: 'command-2' }));
    await vi.waitFor(() => expect(setup.controller.hasForThread('thread-2')).toBe(true));

    expect(setup.controller.approvalsForThread('thread-1').map(({ id }) => id)).toStrictEqual(['first']);
    expect(setup.controller.approvalsForThread('thread-2').map(({ id }) => id)).toStrictEqual(['second']);
    expect(setup.controller.hasForThread('missing')).toBe(false);

    setup.controller.denyAll();

    expect(setup.controller.approvalsForThread('thread-1')).toStrictEqual([]);
    expect(setup.controller.approvalsForThread('thread-2')).toStrictEqual([]);
    expect(setup.transport.sent).toContainEqual({ id: 'first', result: { decision: 'decline' } });
    expect(setup.transport.sent).toContainEqual({ id: 'second', result: { decision: 'decline' } });
    setup.controller.close();
  });

  it('unsubscribes and clears pending approvals when closed', async () => {
    const setup = approvals();
    await setup.client.start();
    setup.transport.emitServerRequestFrame(commandApproval('before-close'));
    await vi.waitFor(() => expect(setup.controller.hasForThread('thread-1')).toBe(true));

    setup.controller.close();
    setup.transport.emitServerRequestFrame(commandApproval('after-close'));

    expect(setup.controller.approvalsForThread('thread-1')).toStrictEqual([]);
  });

  it('rejects unknown, invalid, mismatched, and unavailable resolutions without consuming approval', async () => {
    const setup = approvals();
    await setup.client.start();
    setup.transport.emitServerRequestFrame(commandApproval('approval-1', { availableDecisions: ['accept', 'decline'] }));
    await vi.waitFor(() => expect(setup.controller.hasForThread('thread-1')).toBe(true));

    await expect(setup.controller.resolve(undefined, 'missing', 'deny', 'once'))
      .rejects.toThrow("Unknown approval 'missing'");
    await expect(setup.controller.resolve('thread-2', 'approval-1', 'deny', 'once'))
      .rejects.toThrow("belongs to conversation 'thread-1', not 'thread-2'");
    await expect(setup.controller.resolve(undefined, 'approval-1', 'later' as never, 'once'))
      .rejects.toThrow("Invalid approval decision 'later'");
    await expect(setup.controller.resolve(undefined, 'approval-1', 'approve', 'forever' as never))
      .rejects.toThrow("Invalid approval scope 'forever'");
    await expect(setup.controller.resolve(undefined, 'approval-1', 'approve', 'session'))
      .rejects.toThrow("Approval decision 'approve:session' is not available for 'approval-1'");
    await setup.controller.resolve(undefined, 'approval-1', 'deny', 'session');
    expect(setup.transport.sent).toContainEqual({ id: 'approval-1', result: { decision: 'decline' } });
    expect(setup.controller.hasForThread('thread-1')).toBe(false);
    setup.controller.close();
  });

  it('resolves an approval without a turn and emits exact host activity', async () => {
    const setup = approvals();
    await setup.client.start();
    setup.transport.emitServerRequestFrame(legacyCommandApproval('legacy'));
    await vi.waitFor(() => expect(setup.controller.hasForThread('thread-1')).toBe(true));
    const approval = setup.controller.approvalsForThread('thread-1')[0];
    setup.host.emitEvent.mockClear();
    setup.host.emitConversationActivity.mockClear();
    setup.host.maybeClearWaitingBusy.mockClear();
    setup.host.patch.mockClear();

    await setup.controller.resolve(undefined, 'legacy', 'approve', 'session');

    expect(setup.transport.sent).toContainEqual({ id: 'legacy', result: { decision: 'approved_for_session' } });
    expect(setup.host.patch).toHaveBeenCalledWith({ approvals: [] });
    expect(setup.host.maybeClearWaitingBusy).toHaveBeenCalledExactlyOnceWith('thread-1');
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('action', {
      type: 'approval.resolved', conversationId: 'thread-1',
      payload: { approval, decision: 'approve', scope: 'session', reason: 'host' },
    });
    expect(setup.host.emitConversationActivity).toHaveBeenCalledExactlyOnceWith('thread-1', 'action');
    setup.controller.close();
  });

  it('clears only one conversation and reports every denied approval exactly', async () => {
    const setup = approvals();
    await setup.client.start();
    setup.transport.emitServerRequestFrame(commandApproval('first'));
    setup.transport.emitServerRequestFrame(legacyCommandApproval('without-turn'));
    setup.transport.emitServerRequestFrame(commandApproval('other', { threadId: 'thread-2', itemId: 'other-item' }));
    await vi.waitFor(() => expect(setup.controller.hasForThread('thread-2')).toBe(true));
    setup.host.emitEvent.mockClear();
    setup.host.patchRuntime.mockClear();
    setup.host.patch.mockClear();

    setup.controller.clearForThread('thread-1', 'conversation_removed');

    expect(setup.controller.hasForThread('thread-1')).toBe(false);
    expect(setup.controller.approvalsForThread('thread-2').map(({ id }) => id)).toStrictEqual(['other']);
    expect(setup.transport.sent).toContainEqual({ id: 'first', result: { decision: 'decline' } });
    expect(setup.transport.sent).toContainEqual({
      id: 'without-turn', result: { decision: { denied: { rejection: 'Denied by user' } } },
    });
    expect(setup.host.patch).toHaveBeenCalledWith({ approvals: [] });
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('thread-1', {});
    expect(setup.host.emitEvent.mock.calls).toStrictEqual([
      ['notification', {
        type: 'approval.resolved', conversationId: 'thread-1', turnId: 'turn-1',
        payload: {
          approval: expect.objectContaining({ id: 'first' }),
          decision: 'deny', scope: 'once', reason: 'conversation_removed',
        },
      }],
      ['notification', {
        type: 'approval.resolved', conversationId: 'thread-1',
        payload: {
          approval: expect.objectContaining({ id: 'without-turn' }),
          decision: 'deny', scope: 'once', reason: 'conversation_removed',
        },
      }],
    ]);
    setup.controller.close();
  });

  it('handles known and unknown server resolutions with exact state refresh', async () => {
    const setup = approvals();
    await setup.client.start();
    setup.transport.emitServerRequestFrame(commandApproval('server'));
    await vi.waitFor(() => expect(setup.controller.hasForThread('thread-1')).toBe(true));
    const approval = setup.controller.approvalsForThread('thread-1')[0];
    setup.host.emitEvent.mockClear();
    setup.host.patch.mockClear();

    setup.controller.handleServerResolved('server');

    expect(setup.host.patch).toHaveBeenCalledWith({ approvals: [] });
    expect(setup.host.maybeClearWaitingBusy).toHaveBeenCalledWith('thread-1');
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('notification', {
      type: 'approval.resolved', conversationId: 'thread-1', turnId: 'turn-1',
      payload: { approval, decision: null, scope: null, reason: 'server' },
    });

    setup.host.emitEvent.mockClear();
    setup.host.patch.mockClear();
    setup.controller.handleServerResolved('missing');
    expect(setup.host.patch).toHaveBeenCalledWith({ approvals: [] });
    expect(setup.host.emitEvent).not.toHaveBeenCalled();
    setup.controller.close();
  });

  it('adds approvals with exact runtime, active snapshot, event, and activity updates', async () => {
    const setup = approvals();
    await setup.client.start();
    setup.transport.emitServerRequestFrame(commandApproval('new'));
    await vi.waitFor(() => expect(setup.controller.hasForThread('thread-1')).toBe(true));
    const approval = setup.controller.approvalsForThread('thread-1')[0];

    expect(setup.host.createRuntime).toHaveBeenCalledWith('thread-1', { busy: true });
    expect(setup.host.markRuntimeTurnActive).toHaveBeenCalledWith(setup.runtime, 'turn-1');
    expect(setup.host.patchRuntime).toHaveBeenCalledWith('thread-1', { busy: true });
    expect(setup.host.patchConversationStatus).toHaveBeenCalledWith('thread-1', 'active');
    expect(setup.host.patch).toHaveBeenCalledWith({ approvals: [approval] });
    expect(setup.host.emitEvent).toHaveBeenCalledWith('notification', {
      type: 'approval.requested', conversationId: 'thread-1', turnId: 'turn-1',
      payload: { approval },
    });
    expect(setup.host.emitConversationActivity).toHaveBeenCalledWith('thread-1', 'notification');
    setup.controller.close();
  });

  it('omits turn activation and active approvals when neither exists', async () => {
    const setup = approvals();
    setup.state.activeConversationId = null;
    await setup.client.start();
    setup.transport.emitServerRequestFrame(legacyCommandApproval('background'));
    await vi.waitFor(() => expect(setup.controller.hasForThread('thread-1')).toBe(true));

    expect(setup.host.markRuntimeTurnActive).not.toHaveBeenCalled();
    expect(setup.host.patch).toHaveBeenCalledWith({ approvals: [] });
    expect(setup.host.emitEvent).toHaveBeenCalledWith('notification', {
      type: 'approval.requested', conversationId: 'thread-1',
      payload: { approval: setup.controller.approvalsForThread('thread-1')[0] },
    });
    setup.controller.close();
  });
});

function approvals() {
  const transport = new MockCodexAppServer();
  const client = new CodexAppServerClient(transport);
  const state = initialSurfaceSnapshot(initialAuthentication());
  state.activeConversationId = 'thread-1';
  const runtime = createThreadRuntime('thread-1', state);
  const runtimes = new Map([['thread-1', runtime]]);
  const runtimeFor = (threadId: string) => {
    let target = runtimes.get(threadId);
    if (!target) {
      target = createThreadRuntime(threadId, state);
      runtimes.set(threadId, target);
    }
    return target;
  };
  const host: CodexSurfaceApprovalsHost = {
    activeConversationId: () => state.activeConversationId,
    createRuntime: vi.fn((threadId, patch) => Object.assign(runtimeFor(threadId), patch)),
    emitConversationActivity: vi.fn(),
    emitEvent: vi.fn(),
    markRuntimeTurnActive: vi.fn((target, turnId) => {
      target.activeTurnId = turnId;
      target.busy = true;
    }),
    maybeClearWaitingBusy: vi.fn(),
    patch: vi.fn((patch: Partial<CodexSurfaceSnapshot>) => Object.assign(state, patch)),
    patchConversationStatus: vi.fn(),
    patchRuntime: vi.fn((threadId, patch) => Object.assign(runtimeFor(threadId), patch)),
  };
  return {
    controller: new CodexSurfaceApprovalsController(client, host),
    client,
    host: host as typeof host & {
      createRuntime: ReturnType<typeof vi.fn>;
      emitConversationActivity: ReturnType<typeof vi.fn>;
      emitEvent: ReturnType<typeof vi.fn>;
      markRuntimeTurnActive: ReturnType<typeof vi.fn>;
      maybeClearWaitingBusy: ReturnType<typeof vi.fn>;
      patch: ReturnType<typeof vi.fn>;
      patchRuntime: ReturnType<typeof vi.fn>;
      patchConversationStatus: ReturnType<typeof vi.fn>;
    },
    runtime, state, transport,
  };
}

type CommandApprovalRequest = Extract<ServerRequest, { method: 'item/commandExecution/requestApproval' }>;
type LegacyCommandApprovalRequest = Extract<ServerRequest, { method: 'execCommandApproval' }>;

function commandApproval(
  id: string,
  overrides: Partial<CommandApprovalRequest['params']> = {},
): CommandApprovalRequest {
  return {
    id,
    method: 'item/commandExecution/requestApproval',
    params: {
      kind: 'command', threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', startedAtMs: 1,
      command: 'npm test', cwd: '/workspace', reason: 'Run tests', environmentId: null,
      networkApprovalContext: null, additionalPermissions: null,
      availableDecisions: ['accept', 'decline'],
      ...overrides,
    },
  };
}

function legacyCommandApproval(id: string): LegacyCommandApprovalRequest {
  return {
    id,
    method: 'execCommandApproval',
    params: {
      conversationId: 'thread-1', callId: `item-${id}`, approvalId: null,
      command: ['npm', 'test'], cwd: '/workspace', reason: null, parsedCmd: [],
    },
  };
}
