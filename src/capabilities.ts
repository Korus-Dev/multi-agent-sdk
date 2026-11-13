import type { HarnessProvider, ProviderCapabilities } from './contracts';

/** The permission ids each harness accepts. The capability tables and the permission types both derive from these. */
export const harnessPermissionIds = {
  codex: ['ask-for-approval', 'approve-for-me', 'full-access'],
  claude: ['default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'],
  cursor: ['default', 'full-access'],
  antigravity: ['default', 'accept-edits', 'auto'],
} as const;
const unrestricted = new Set<string>(['full-access', 'bypassPermissions']);
const permissionModes = (ids: readonly string[]) => ids.map(id => ({ id, ...(unrestricted.has(id) ? { dangerous: true } : {}) }));

export const codexHarnessCapabilities: ProviderCapabilities = {
  commands: [
    { id: 'codex.compact', provider: 'codex', name: 'compact', displayName: 'Compact', description: 'Compact the current Codex context.', slashName: 'compact', submitOnSelect: true },
    { id: 'codex.plan', provider: 'codex', name: 'plan', displayName: 'Plan', description: 'Switch to Codex Plan mode.', slashName: 'plan', submitOnSelect: true },
    { id: 'codex.goal', provider: 'codex', name: 'goal', displayName: 'Goal', description: 'Set or view the Codex thread goal.', slashName: 'goal', composerMode: { label: 'Goal', placeholder: 'Describe the goal' } },
  ],
  workPhases: true,
  mcpRequiredServers: true, mcpAutoApproval: true,
  turnContinuation: true, conversationContent: true, turnHistory: true, conversationStorage: true, safetyReview: true,
  accountUsage: true,
  textGeneration: true, structuredOutput: true, imageGeneration: true, review: true, bankedResets: true, conversationDelete: true, conversationTitle: true, scopedExecution: true,
  reportsTokens: true,
  questions: true,
  plugins: true,
  conversationArchive: true,
  conversationResume: true,
  remoteControl: true,
  login: ['browser', 'deviceCode'],
  realtime: true,
  attachments: true,
  models: true,
  skills: true,
  reasoningEffort: true,
  serviceTier: true,
  thinkingBudget: false,
  planMode: 'native',
  goals: true,
  steerPrompt: true,
  interrupt: true,
  history: true,
  folderScopedConversations: false, subagentTranscripts: 'separate', conversationFork: true,
  deleteTurn: true,
  editTurn: true,
  retryTurn: true,
  approvals: true,
  approvalPresets: [...harnessPermissionIds.codex],
};

export const claudeHarnessCapabilities: ProviderCapabilities = {
  commands: [
    { id: 'claude.compact', provider: 'claude', name: 'compact', displayName: 'Compact', description: 'Compact the current Claude context while preserving a summary.', slashName: 'compact', submitOnSelect: true },
    { id: 'claude.plan', provider: 'claude', name: 'plan', displayName: 'Plan', description: 'Switch to Claude Plan mode.', slashName: 'plan', submitOnSelect: true },
  ],
  mcpRequiredServers: false, mcpAutoApproval: true,
  turnContinuation: true, conversationContent: true,
  accountUsage: true,
  textGeneration: true, structuredOutput: true, conversationDelete: true, scopedExecution: true,
  reportsTokens: true,
  nativeMonitor: true,
  questions: true,
  plugins: false,
  conversationArchive: false,
  conversationResume: true,
  remoteControl: false,
  attachments: true,
  models: true,
  skills: true,
  reasoningEffort: true,
  serviceTier: true,
  thinkingBudget: false,
  planMode: 'prompted',
  goals: true,
  steerPrompt: true,
  interrupt: true,
  history: true,
  folderScopedConversations: true, subagentTranscripts: 'inline', conversationFork: true,
  deleteTurn: false,
  editTurn: false,
  retryTurn: false,
  approvals: true,
  approvalPresets: [],
  permissionModes: permissionModes(harnessPermissionIds.claude),
};

export function defaultHarnessCapabilities(provider: HarnessProvider): ProviderCapabilities {
  if (provider === 'cursor') return cursorHarnessCapabilities;
  if (provider === 'antigravity') return antigravityHarnessCapabilities;
  return provider === 'claude' ? claudeHarnessCapabilities : codexHarnessCapabilities;
}

export const antigravityHarnessCapabilities: ProviderCapabilities = {
  commands: [
    { id: 'antigravity.plan', provider: 'antigravity', name: 'plan', displayName: 'Plan', description: 'Create an Antigravity plan for review.', slashName: 'plan', submitOnSelect: true },
  ],
  mcpRequiredServers: false, mcpAutoApproval: false,
  turnContinuation: true,
  accountUsage: true,
  textGeneration: true, structuredOutput: false, scopedExecution: true,
  reportsTokens: true, questions: true, plugins: false,
  conversationArchive: false, conversationResume: true,
  remoteControl: false, attachments: true, models: true, skills: false,
  reasoningEffort: true, serviceTier: false, thinkingBudget: false,
  planMode: 'native', goals: false, steerPrompt: false, interrupt: true, history: true,
  folderScopedConversations: true, subagentTranscripts: 'none', conversationFork: false, deleteTurn: false, editTurn: false, retryTurn: false,
  approvals: true, approvalPresets: [],
  permissionModes: permissionModes(harnessPermissionIds.antigravity),
};

// Cursor enables only capabilities implemented and verified by its host.
export const cursorHarnessCapabilities: ProviderCapabilities = {
  commands: [
    { id: 'cursor.plan', provider: 'cursor', name: 'plan', displayName: 'Plan', description: 'Switch to Cursor Plan mode.', slashName: 'plan', submitOnSelect: true },
  ],
  mcpRequiredServers: false, mcpAutoApproval: false,
  turnContinuation: true,
  accountUsage: true,
  scopedExecution: true,
  reportsTokens: false, questions: false, plugins: false,
  conversationArchive: false, conversationResume: true,
  remoteControl: false, attachments: true, models: true, skills: false,
  reasoningEffort: true, serviceTier: false, thinkingBudget: false, planMode: 'native',
  goals: false, steerPrompt: false, interrupt: true, history: true, folderScopedConversations: true, subagentTranscripts: 'none', conversationFork: false,
  deleteTurn: false, editTurn: false, retryTurn: false, approvals: false,
  approvalPresets: [], permissionModes: permissionModes(harnessPermissionIds.cursor),
};
