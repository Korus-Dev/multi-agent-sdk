import { describe, expect, it, vi } from 'vitest';
import {
  registerCodexApprovalHandlers,
  type PendingCodexApproval,
} from '../../src/providers/codex/codex-approvals';

describe('Codex approval protocol conversion', () => {
  it('registers and tears down every supported approval request handler', () => {
    const setup = approvals();

    expect([...setup.handlers.keys()]).toStrictEqual([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'execCommandApproval',
      'applyPatchApproval',
    ]);

    setup.unsubscribe();

    expect(setup.unsubscribers.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);
  });

  it.each([undefined, ['accept', 'acceptForSession', 'decline']])('keeps mandatory-human commands one-time with decision list %s', (availableDecisions) => {
    const setup = approvals();
    const result = setup.request('item/commandExecution/requestApproval', 'human', {
      kind: 'humanCommand', threadId: 'thread', turnId: 'turn', itemId: 'command',
      // Even an inconsistent server allowlist cannot widen a human checkpoint.
      availableDecisions,
    });
    expect(result.pending.approval).toMatchObject({ requiresHumanApproval: true, allowedScopes: ['once'] });
    expect(() => result.pending.resolve('approve', 'session')).toThrow();
    expect(result.responder.resolve).not.toHaveBeenCalled();
    result.pending.resolve('approve', 'once');
    expect(result.responder.resolve).toHaveBeenCalledWith({ decision: 'accept' });
  });

  it('normalizes command metadata, scopes, denial, and additional permissions exactly', () => {
    const setup = approvals();
    const result = setup.request('item/commandExecution/requestApproval', 17, {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', startedAtMs: 1,
      command: 'npm test', cwd: '/workspace', reason: 'Run checks', environmentId: null,
      networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' },
      additionalPermissions: {
        network: { enabled: false },
        fileSystem: {
          read: ['/read'],
          write: ['/write'],
          entries: [
            { access: 'read', path: { type: 'path', path: '/literal' } },
            { access: 'write', path: { type: 'glob_pattern', pattern: '/glob/**' } },
            { access: 'read', path: { type: 'special', value: { kind: 'project_roots', subpath: null } } },
            { access: 'write', path: { type: 'special', value: { kind: 'project_roots', subpath: 'src' } } },
            { access: 'write', path: { type: 'special', value: { kind: 'tmpdir' } } },
            { access: 'write', path: { type: 'special', value: { kind: 'slash_tmp' } } },
            { access: 'deny', path: { type: 'special', value: { kind: 'root' } } },
            { access: 'read', path: { type: 'special', value: { kind: 'minimal' } } },
            { access: 'read', path: { type: 'special', value: { kind: 'unknown', path: null, subpath: 'cache' } } },
          ],
        },
      },
      availableDecisions: ['accept', 'acceptForSession', 'decline'],
    });

    expect(result.claimed).toBe(true);
    expect(result.pending.approval).toStrictEqual({
      id: '17', kind: 'command', conversationId: 'thread-1', turnId: 'turn-1', itemId: 'command-1',
      title: 'Run command', command: 'npm test', cwd: '/workspace', description: 'Run checks',
      requestedPermissions: [
        { kind: 'network', enabled: true, host: 'registry.npmjs.org', protocol: 'https' },
        { kind: 'filesystem', access: 'read', path: '/read' },
        { kind: 'filesystem', access: 'write', path: '/write' },
        { kind: 'filesystem', access: 'read', path: '/literal' },
        { kind: 'filesystem', access: 'write', path: '/glob/**' },
        { kind: 'filesystem', access: 'read', path: 'project roots' },
        { kind: 'filesystem', access: 'write', path: 'project roots/src' },
        { kind: 'filesystem', access: 'write', path: 'system temporary directory' },
        { kind: 'filesystem', access: 'write', path: '/tmp' },
        { kind: 'filesystem', access: 'deny', path: 'filesystem root' },
        { kind: 'filesystem', access: 'read', path: 'minimal runtime paths' },
        { kind: 'filesystem', access: 'read', path: 'cache' },
      ],
      allowedScopes: ['once', 'session'],
      canDeny: true,
    });

    result.pending.resolve('approve', 'once');
    expect(result.responder.resolve).toHaveBeenLastCalledWith({ decision: 'accept' });
    result.pending.resolve('approve', 'session');
    expect(result.responder.resolve).toHaveBeenLastCalledWith({ decision: 'acceptForSession' });
    result.pending.resolve('deny', 'once');
    expect(result.responder.resolve).toHaveBeenLastCalledWith({ decision: 'decline' });
  });

  it('omits unavailable command fields and falls back from decline to cancel', () => {
    const setup = approvals();
    const cancellable = setup.request('item/commandExecution/requestApproval', 'command-cancel', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', startedAtMs: 1,
      command: null, cwd: null, reason: null, environmentId: null,
      networkApprovalContext: null, additionalPermissions: null,
      availableDecisions: ['cancel'],
    });
    expect(cancellable.pending.approval).toStrictEqual({
      id: 'command-cancel', kind: 'command', conversationId: 'thread-1', turnId: 'turn-1',
      itemId: 'command-1', title: 'Run command', command: undefined, cwd: undefined,
      allowedScopes: [], canDeny: true,
    });
    cancellable.pending.resolve('deny', 'session');
    expect(cancellable.responder.resolve).toHaveBeenCalledWith({ decision: 'cancel' });
    expect(() => cancellable.pending.resolve('approve', 'once'))
      .toThrow("Approval decision 'approve:once' is not available for this command");

    const unrestricted = setup.request('item/commandExecution/requestApproval', 'unrestricted', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-2', startedAtMs: 1,
      command: '', cwd: '', reason: '', environmentId: null,
      networkApprovalContext: null, additionalPermissions: undefined, availableDecisions: null,
    });
    expect(unrestricted.pending.approval).not.toHaveProperty('allowedScopes');
    expect(unrestricted.pending.approval).not.toHaveProperty('canDeny');
    unrestricted.pending.resolve('approve', 'session');
    expect(unrestricted.responder.resolve).toHaveBeenCalledWith({ decision: 'acceptForSession' });

    const cannotDeny = setup.request('item/commandExecution/requestApproval', 'cannot-deny', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-3', startedAtMs: 1,
      command: 'true', cwd: '/workspace', reason: null, environmentId: null,
      networkApprovalContext: null, additionalPermissions: null, availableDecisions: ['accept'],
    });
    expect(cannotDeny.pending.approval).toMatchObject({ allowedScopes: ['once'], canDeny: false });
  });

  it('maps file-change requests and every decision scope', () => {
    const setup = approvals();
    const reason = setup.request('item/fileChange/requestApproval', 'file-reason', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-1', startedAtMs: 1,
      reason: 'Modify files', grantRoot: '/ignored',
    });
    expect(reason.pending.approval).toStrictEqual({
      id: 'file-reason', kind: 'file-change', conversationId: 'thread-1', turnId: 'turn-1',
      itemId: 'file-1', title: 'Apply file changes', description: 'Modify files',
    });
    reason.pending.resolve('approve', 'session');
    expect(reason.responder.resolve).toHaveBeenCalledWith({ decision: 'acceptForSession' });

    const root = setup.request('item/fileChange/requestApproval', 'file-root', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-2', startedAtMs: 1,
      reason: null, grantRoot: '/workspace',
    });
    expect(root.pending.approval.description).toBe('Write under /workspace');
    root.pending.resolve('approve', 'once');
    expect(root.responder.resolve).toHaveBeenCalledWith({ decision: 'accept' });
    root.pending.resolve('deny', 'session');
    expect(root.responder.resolve).toHaveBeenLastCalledWith({ decision: 'decline' });

    const plain = setup.request('item/fileChange/requestApproval', 'file-plain', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-3', startedAtMs: 1,
      reason: null, grantRoot: null,
    });
    expect(plain.pending.approval).not.toHaveProperty('description');
  });

  it('returns only approved permission fields with the requested scope', () => {
    const setup = approvals();
    const approved = setup.request('item/permissions/requestApproval', 'permissions', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'permissions-1', startedAtMs: 1,
      environmentId: null, cwd: '/workspace', reason: null,
      permissions: {
        network: { enabled: null },
        fileSystem: { read: ['/read'], write: null, entries: null },
      },
    });
    expect(approved.pending.approval).toStrictEqual({
      id: 'permissions', kind: 'permissions', conversationId: 'thread-1', turnId: 'turn-1',
      itemId: 'permissions-1', title: 'Grant additional permissions',
      description: 'Codex requested additional access for this task.', cwd: '/workspace',
      requestedPermissions: [
        { kind: 'network', enabled: false },
        { kind: 'filesystem', access: 'read', path: '/read' },
      ],
    });
    approved.pending.resolve('approve', 'session');
    expect(approved.responder.resolve).toHaveBeenCalledWith({
      permissions: {
        fileSystem: { read: ['/read'], write: null, entries: null },
        network: { enabled: null },
      },
      scope: 'session',
    });
    approved.pending.resolve('deny', 'once');
    expect(approved.responder.resolve).toHaveBeenLastCalledWith({ permissions: {}, scope: 'turn' });

    const empty = setup.request('item/permissions/requestApproval', 'permissions-empty', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'permissions-2', startedAtMs: 1,
      environmentId: null, cwd: null, reason: 'No extra access',
      permissions: { network: null, fileSystem: null },
    });
    expect(empty.pending.approval).toStrictEqual({
      id: 'permissions-empty', kind: 'permissions', conversationId: 'thread-1', turnId: 'turn-1',
      itemId: 'permissions-2', title: 'Grant additional permissions',
      description: 'No extra access', cwd: null,
    });
  });

  it('maps legacy command requests and decisions exactly', () => {
    const setup = approvals();
    const result = setup.request('execCommandApproval', 22, {
      conversationId: 'thread-1', callId: 'call-1', approvalId: null,
      command: ['npm', 'test'], cwd: '/workspace', reason: 'Verify', parsedCmd: [],
    });
    expect(result.pending.approval).toStrictEqual({
      id: '22', kind: 'command', conversationId: 'thread-1', itemId: 'call-1',
      title: 'Run command', command: 'npm test', cwd: '/workspace', description: 'Verify',
    });
    result.pending.resolve('approve', 'once');
    expect(result.responder.resolve).toHaveBeenLastCalledWith({ decision: 'approved' });
    result.pending.resolve('approve', 'session');
    expect(result.responder.resolve).toHaveBeenLastCalledWith({ decision: 'approved_for_session' });
    result.pending.resolve('deny', 'session');
    expect(result.responder.resolve).toHaveBeenLastCalledWith({
      decision: { denied: { rejection: 'Denied by user' } },
    });

    const noReason = setup.request('execCommandApproval', 'no-reason', {
      conversationId: 'thread-1', callId: 'call-2', approvalId: null,
      command: [], cwd: null, reason: null, parsedCmd: [],
    });
    expect(noReason.pending.approval).not.toHaveProperty('description');
    expect(noReason.pending.approval.command).toBe('');
  });

  it('maps legacy patch descriptions and decisions exactly', () => {
    const setup = approvals();
    const reason = setup.request('applyPatchApproval', 'patch-reason', {
      conversationId: 'thread-1', callId: 'patch-1', fileChanges: {},
      reason: 'Review changes', grantRoot: '/ignored',
    });
    expect(reason.pending.approval).toStrictEqual({
      id: 'patch-reason', kind: 'file-change', conversationId: 'thread-1', itemId: 'patch-1',
      title: 'Apply file changes', description: 'Review changes',
    });
    reason.pending.resolve('approve', 'session');
    expect(reason.responder.resolve).toHaveBeenLastCalledWith({ decision: 'approved_for_session' });
    reason.pending.resolve('deny', 'once');
    expect(reason.responder.resolve).toHaveBeenLastCalledWith({
      decision: { denied: { rejection: 'Denied by user' } },
    });

    const root = setup.request('applyPatchApproval', 'patch-root', {
      conversationId: 'thread-1', callId: 'patch-2', fileChanges: {},
      reason: null, grantRoot: '/workspace',
    });
    expect(root.pending.approval.description).toBe('Write under /workspace');
    root.pending.resolve('approve', 'once');
    expect(root.responder.resolve).toHaveBeenCalledWith({ decision: 'approved' });

    const plain = setup.request('applyPatchApproval', 'patch-plain', {
      conversationId: 'thread-1', callId: 'patch-3', fileChanges: {}, reason: null, grantRoot: null,
    });
    expect(plain.pending.approval).not.toHaveProperty('description');
  });
});

function approvals() {
  type Handler = (request: unknown, responder: unknown) => boolean;
  const handlers = new Map<string, Handler>();
  const unsubscribers: ReturnType<typeof vi.fn>[] = [];
  const client = {
    onServerRequest: vi.fn((method: string, handler: Handler) => {
      handlers.set(method, handler);
      const unsubscribe = vi.fn(() => handlers.delete(method));
      unsubscribers.push(unsubscribe);
      return unsubscribe;
    }),
  };
  const observed: PendingCodexApproval[] = [];
  const unsubscribe = registerCodexApprovalHandlers(client as never, (pending) => observed.push(pending));
  return {
    handlers,
    unsubscribers,
    unsubscribe,
    request(method: string, id: string | number, params: unknown) {
      const responder = { resolve: vi.fn(), reject: vi.fn() };
      const claimed = handlers.get(method)?.({ id, method, params }, responder);
      const pending = observed.at(-1);
      if (!pending) throw new Error(`Handler '${method}' did not publish an approval`);
      return { claimed, pending, responder };
    },
  };
}
