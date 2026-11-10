export type BackendApprovalDecision = 'approve' | 'deny';
export type BackendApprovalScope = 'once' | 'session';
export type BackendRequestedPermission =
  | {
    kind: 'filesystem';
    access: 'read' | 'write' | 'deny';
    path: string;
  }
  | {
    kind: 'network';
    enabled: boolean;
    host?: string;
    protocol?: string;
  };
export type BackendApprovalRequest = {
  id: string;
  kind: 'command' | 'file-change' | 'permissions';
  conversationId: string;
  turnId?: string;
  itemId: string;
  title: string;
  description?: string;
  command?: string;
  cwd?: string;
  requestedPermissions?: BackendRequestedPermission[];
  allowedScopes?: BackendApprovalScope[];
  canDeny?: boolean;
};
