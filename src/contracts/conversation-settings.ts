export type ConversationSettings = {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  approvalPreset?: import('./shared').ApprovalPreset;
  permissionMode?: string;
};