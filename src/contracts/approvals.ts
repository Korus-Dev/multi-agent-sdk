export type ProviderApprovalDecision = 'approve' | 'deny';
export type ProviderApprovalScope = 'once' | 'session';
export type ProviderRequestedPermission =
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
export type ProviderApprovalRequest = {
  id: string;
  kind: 'command' | 'file-change' | 'permissions';
  conversationId: string;
  turnId?: string;
  itemId: string;
  title: string;
  description?: string;
  command?: string;
  cwd?: string;
  requestedPermissions?: ProviderRequestedPermission[];
  allowedScopes?: ProviderApprovalScope[];
  canDeny?: boolean;
  /** Native mandatory-human evidence; never reinterpret as an automatic approval. */
  requiresHumanApproval?: boolean;
};
