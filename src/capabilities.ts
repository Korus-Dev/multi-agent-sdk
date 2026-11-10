import type { AgentBackend, BackendCapabilities } from './contracts';

export const codexBackendCapabilities: BackendCapabilities = {
  reportsTokens: true,
  questions: true,
  plugins: true,
  conversationArchive: true,
  conversationResume: true,
  conversationReplaceWithSummary: true,
  remoteControl: true,
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

export const claudeBackendCapabilities: BackendCapabilities = {
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
      label: "Default",
      description: "Default permission policy for claude.",
    },
    {
      id: 'acceptEdits',
      label: "Accept edits",
      description: "Accept edits permission policy for claude.",
    },
    {
      id: 'dontAsk',
      label: "Do not ask",
      description: "Do not ask permission policy for claude.",
    },
    {
      id: 'auto',
      label: "Automatic",
      description: "Automatic permission policy for claude.",
    },
    {
      id: 'bypassPermissions',
      label: "Bypass permissions",
      description: "Bypass permissions permission policy for claude.",
      dangerous: true,
    },
  ],
};

export function defaultBackendCapabilities(backend: AgentBackend): BackendCapabilities {
  if (backend === 'cursor') return cursorBackendCapabilities;
  if (backend === 'antigravity') return antigravityBackendCapabilities;
  return backend === 'claude' ? claudeBackendCapabilities : codexBackendCapabilities;
}

export const antigravityBackendCapabilities: BackendCapabilities = {
  reportsTokens: true, questions: true, plugins: false,
  conversationArchive: false, conversationResume: true, conversationReplaceWithSummary: false,
  remoteControl: false, attachments: true, models: true, skills: false,
  reasoningEffort: false, serviceTier: false, thinkingBudget: false,
  planMode: 'native', goals: false, steerPrompt: false, interrupt: true, history: true,
  conversationFork: false, deleteTurn: false, editTurn: false, retryTurn: false,
  approvals: true, approvalPresets: [],
  permissionModes: [
    { id: 'default', label: "Default", description: "Default permission policy for antigravity." },
    { id: 'auto_edit', label: "Automatic edits", description: "Automatic edits permission policy for antigravity." },
  ],
};

// Cursor enables only capabilities implemented and verified by its host.
export const cursorBackendCapabilities: BackendCapabilities = {
  reportsTokens: false, questions: false, plugins: false,
  conversationArchive: false, conversationResume: true, conversationReplaceWithSummary: false,
  remoteControl: false, attachments: true, models: true, skills: false,
  reasoningEffort: true, serviceTier: false, thinkingBudget: false, planMode: 'native',
  goals: false, steerPrompt: false, interrupt: true, history: true, conversationFork: false,
  deleteTurn: false, editTurn: false, retryTurn: false, approvals: false,
  approvalPresets: [], permissionModes: [
    { id: 'default', label: "Default", description: "Default permission policy for cursor." },
    { id: 'full-access', label: "Full access", description: "Full access permission policy for cursor.", dangerous: true },
  ],
};
