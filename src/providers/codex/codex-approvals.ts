import type { CodexAppServerClient, v2 } from '@korus-dev/codex-sdk';
import type {
  Approval,
  ApprovalDecision,
  ApprovalScope,
  RequestedPermission,
} from '../../core/codex-host';

export type PendingCodexApproval = {
  approval: Approval;
  resolve(decision: ApprovalDecision, scope: ApprovalScope): void;
};

export function registerCodexApprovalHandlers(
  client: CodexAppServerClient,
  onApproval: (pending: PendingCodexApproval) => void,
): () => void {
  const unsubscribers = [
    client.onServerRequest('item/commandExecution/requestApproval', (request, responder) => {
      onApproval({
        approval: commandApproval(request.id, request.params),
        resolve: (decision, scope) => responder.resolve({
          decision: commandDecision(request.params, decision, scope),
        }),
      });
      return true;
    }),
    client.onServerRequest('item/fileChange/requestApproval', (request, responder) => {
      onApproval({
        approval: fileChangeApproval(request.id, request.params),
        resolve: (decision, scope) => responder.resolve({
          decision: decision === 'deny' ? 'decline' : scope === 'session' ? 'acceptForSession' : 'accept',
        }),
      });
      return true;
    }),
    client.onServerRequest('item/permissions/requestApproval', (request, responder) => {
      onApproval({
        approval: permissionsApproval(request.id, request.params),
        resolve: (decision, scope) => responder.resolve({
          permissions: decision === 'deny' ? {} : {
            ...(request.params.permissions.fileSystem ? { fileSystem: request.params.permissions.fileSystem } : {}),
            ...(request.params.permissions.network ? { network: request.params.permissions.network } : {}),
          },
          scope: scope === 'session' ? 'session' : 'turn',
        }),
      });
      return true;
    }),
    client.onServerRequest('execCommandApproval', (request, responder) => {
      onApproval({
        approval: {
          id: String(request.id),
          kind: 'command',
          conversationId: request.params.conversationId,
          itemId: request.params.callId,
          title: 'Run command',
          command: request.params.command.join(' '),
          cwd: request.params.cwd,
          ...(request.params.reason ? { description: request.params.reason } : {}),
        },
        resolve: (decision, scope) => responder.resolve({
          decision: decision === 'deny'
            ? { denied: { rejection: 'Denied by user' } }
            : scope === 'session' ? 'approved_for_session' : 'approved',
        }),
      });
      return true;
    }),
    client.onServerRequest('applyPatchApproval', (request, responder) => {
      onApproval({
        approval: {
          id: String(request.id),
          kind: 'file-change',
          conversationId: request.params.conversationId,
          itemId: request.params.callId,
          title: 'Apply file changes',
          ...((request.params.reason || request.params.grantRoot) ? {
            description: request.params.reason ?? `Write under ${request.params.grantRoot}`,
          } : {}),
        },
        resolve: (decision, scope) => responder.resolve({
          decision: decision === 'deny'
            ? { denied: { rejection: 'Denied by user' } }
            : scope === 'session' ? 'approved_for_session' : 'approved',
        }),
      });
      return true;
    }),
  ];

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

function commandApproval(
  id: string | number,
  params: v2.CommandExecutionRequestApprovalParams,
): Approval {
  const availableDecisions = params.availableDecisions;
  const requiresHumanApproval = params.kind === 'humanCommand';
  const additionalPermissions = permissionDetails(params.additionalPermissions);
  const requestedPermissions = [
    ...(params.networkApprovalContext ? [{
      kind: 'network' as const,
      enabled: true,
      host: params.networkApprovalContext.host,
      protocol: params.networkApprovalContext.protocol,
    }] : []),
    ...additionalPermissions.filter((permission) => !params.networkApprovalContext || permission.kind !== 'network'),
  ];
  return {
    id: String(id),
    kind: 'command',
    conversationId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    title: 'Run command',
    command: params.command ?? undefined,
    cwd: params.cwd ?? undefined,
    ...(requiresHumanApproval ? { requiresHumanApproval: true } : {}),
    ...(params.reason ? { description: params.reason } : {}),
    ...(requestedPermissions.length ? { requestedPermissions } : {}),
    ...(availableDecisions ? {
      allowedScopes: [
        ...(availableDecisions.includes('accept') ? ['once' as const] : []),
        ...(!requiresHumanApproval && availableDecisions.includes('acceptForSession') ? ['session' as const] : []),
      ],
      canDeny: availableDecisions.includes('decline') || availableDecisions.includes('cancel'),
    } : requiresHumanApproval ? { allowedScopes: ['once'] } : {}),
  };
}

function fileChangeApproval(
  id: string | number,
  params: v2.FileChangeRequestApprovalParams,
): Approval {
  return {
    id: String(id),
    kind: 'file-change',
    conversationId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    title: 'Apply file changes',
    ...((params.reason || params.grantRoot) ? {
      description: params.reason ?? `Write under ${params.grantRoot}`,
    } : {}),
  };
}

function permissionsApproval(
  id: string | number,
  params: v2.PermissionsRequestApprovalParams,
): Approval {
  const requestedPermissions = permissionDetails(params.permissions);
  return {
    id: String(id),
    kind: 'permissions',
    conversationId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    title: 'Grant additional permissions',
    description: params.reason ?? 'Codex requested additional access for this task.',
    cwd: params.cwd,
    ...(requestedPermissions.length ? { requestedPermissions } : {}),
  };
}

function commandDecision(
  params: v2.CommandExecutionRequestApprovalParams,
  decision: ApprovalDecision,
  scope: ApprovalScope,
): v2.CommandExecutionApprovalDecision {
  const available = params.availableDecisions;
  if (params.kind === 'humanCommand' && decision === 'approve' && scope !== 'once') {
    throw new Error('Mandatory human approval requires a fresh one-time decision');
  }
  const requested = decision === 'deny' ? 'decline' : scope === 'session' ? 'acceptForSession' : 'accept';
  if (!available || available.includes(requested)) return requested;
  if (decision === 'deny' && available.includes('cancel')) return 'cancel';
  throw new Error(`Approval decision '${decision}:${scope}' is not available for this command`);
}

function permissionDetails(
  profile: v2.RequestPermissionProfile | v2.AdditionalPermissionProfile | null | undefined,
): RequestedPermission[] {
  if (!profile) return [];
  const permissions: RequestedPermission[] = [];
  if (profile.network) {
    permissions.push({ kind: 'network', enabled: profile.network.enabled ?? false });
  }
  if (profile.fileSystem) {
    for (const path of profile.fileSystem.read ?? []) {
      permissions.push({ kind: 'filesystem', access: 'read', path });
    }
    for (const path of profile.fileSystem.write ?? []) {
      permissions.push({ kind: 'filesystem', access: 'write', path });
    }
    for (const entry of profile.fileSystem.entries ?? []) {
      permissions.push({
        kind: 'filesystem',
        access: entry.access,
        path: fileSystemPath(entry.path),
      });
    }
  }
  return permissions;
}

function fileSystemPath(path: v2.FileSystemPath): string {
  if (path.type === 'path') return path.path;
  if (path.type === 'glob_pattern') return path.pattern;
  const special = path.value;
  switch (special.kind) {
    case 'project_roots': return special.subpath ? `project roots/${special.subpath}` : 'project roots';
    case 'tmpdir': return 'system temporary directory';
    case 'slash_tmp': return '/tmp';
    case 'root': return 'filesystem root';
    case 'minimal': return 'minimal runtime paths';
    case 'unknown': return [special.path, special.subpath].filter(Boolean).join('/');
  }
}
