import type { HarnessProvider, ProviderCapabilities } from './contracts';

export const codexHarnessCapabilities: ProviderCapabilities = {
  accountUsage: true,
  reportsTokens: true,
  questions: true,
  plugins: true,
  conversationArchive: true,
  conversationResume: true,
  conversationReplaceWithSummary: true,
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
  accountUsage: true,
  reportsTokens: true,
  nativeMonitor: true,
  questions: true,
  plugins: false,
  conversationArchive: false,
  conversationResume: true,
  conversationReplaceWithSummary: false,
  remoteControl: false,
  attachments: true,
  models: true,
  skills: true,
  reasoningEffort: false,
  serviceTier: false,
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
  reportsTokens: true, questions: true, plugins: false,
  conversationArchive: false, conversationResume: true, conversationReplaceWithSummary: false,
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
  accountUsage: true,
  reportsTokens: false, questions: false, plugins: false,
  conversationArchive: false, conversationResume: true, conversationReplaceWithSummary: false,
  remoteControl: false, attachments: true, models: true, skills: false,
  reasoningEffort: true, serviceTier: false, thinkingBudget: false, planMode: 'native',
  goals: false, steerPrompt: false, interrupt: true, history: true, conversationFork: false,
  deleteTurn: false, editTurn: false, retryTurn: false, approvals: false,
  approvalPresets: [], permissionModes: [
    { id: 'default' },
    { id: 'full-access', dangerous: true },
  ],
};
