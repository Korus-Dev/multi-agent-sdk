import type { HarnessProvider, ProviderCapabilities } from './contracts';

export const codexHarnessCapabilities: ProviderCapabilities = {
  mcpRequiredServers: true, mcpAutoApproval: true,
  turnContinuation: true, worktreeFork: true, conversationContent: true, turnHistory: true, conversationStorage: true,
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
  conversationFork: true,
  deleteTurn: true,
  editTurn: true,
  retryTurn: true,
  approvals: true,
  approvalPresets: ['ask-for-approval', 'approve-for-me', 'full-access'],
};

export const claudeHarnessCapabilities: ProviderCapabilities = {
  mcpRequiredServers: false, mcpAutoApproval: true,
  turnContinuation: true, worktreeFork: true, conversationContent: true, turnHistory: true,
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
  conversationFork: true,
  deleteTurn: false,
  editTurn: false,
  retryTurn: false,
  approvals: true,
  approvalPresets: [],
  permissionModes: [
    {
      id: 'default',
    },
    {
      id: 'acceptEdits',
    },
    {
      id: 'dontAsk',
    },
    {
      id: 'auto',
    },
    {
      id: 'bypassPermissions',
      dangerous: true,
    },
  ],
};

export function defaultHarnessCapabilities(provider: HarnessProvider): ProviderCapabilities {
  if (provider === 'cursor') return cursorHarnessCapabilities;
  if (provider === 'antigravity') return antigravityHarnessCapabilities;
  return provider === 'claude' ? claudeHarnessCapabilities : codexHarnessCapabilities;
}

export const antigravityHarnessCapabilities: ProviderCapabilities = {
  mcpRequiredServers: false, mcpAutoApproval: false,
  turnContinuation: true,
  accountUsage: true,
  textGeneration: true, structuredOutput: false, scopedExecution: true,
  reportsTokens: true, questions: true, plugins: false,
  conversationArchive: false, conversationResume: true,
  remoteControl: false, attachments: true, models: true, skills: false,
  reasoningEffort: false, serviceTier: false, thinkingBudget: false,
  planMode: 'native', goals: false, steerPrompt: false, interrupt: true, history: true,
  conversationFork: false, deleteTurn: false, editTurn: false, retryTurn: false,
  approvals: true, approvalPresets: [],
  permissionModes: [
    { id: 'default' },
    { id: 'auto_edit' },
  ],
};

// Cursor enables only capabilities implemented and verified by its host.
export const cursorHarnessCapabilities: ProviderCapabilities = {
  mcpRequiredServers: false, mcpAutoApproval: false,
  turnContinuation: true,
  accountUsage: true,
  scopedExecution: true,
  reportsTokens: false, questions: false, plugins: false,
  conversationArchive: false, conversationResume: true,
  remoteControl: false, attachments: true, models: true, skills: false,
  reasoningEffort: true, serviceTier: false, thinkingBudget: false, planMode: 'native',
  goals: false, steerPrompt: false, interrupt: true, history: true, conversationFork: false,
  deleteTurn: false, editTurn: false, retryTurn: false, approvals: false,
  approvalPresets: [], permissionModes: [
    { id: 'default' },
    { id: 'full-access', dangerous: true },
  ],
};
