import type { CodexConversationSnapshot } from '../../src/core/codex-host';

/** A ready Codex conversation snapshot, as the native host publishes it. */
export function codexSnapshot(overrides: Partial<CodexConversationSnapshot> = {}): CodexConversationSnapshot {
  return {
    status: 'ready',
    authentication: {
      status: 'loaded', account: null, requiresOpenaiAuth: false, error: null,
      login: { status: 'idle', loginId: null, authUrl: null, error: null },
    },
    conversations: [],
    activeConversationId: 'conversation-1',
    activeTurnId: null,
    turns: [],
    turnIds: [],
    messages: [],
    clientRequests: [],
    answeredClientRequestIds: [],
    approvals: [],
    models: [],
    modelCatalogStatus: 'notLoaded',
    skills: [],
    skillCatalogStatus: 'notLoaded',
    plugins: [],
    pluginCatalogStatus: 'notLoaded',
    permissionProfiles: [],
    approvalPresets: [],
    approvalPreset: null,
    selectedModelId: null,
    selectedReasoningEffort: null,
    selectedServiceTier: null,
    planMode: false,
    contextUsage: null,
    goal: null,
    turnGitDiff: null,
    threadStatus: { type: 'idle' },
    rateLimits: null,
    queuedPrompts: [],
    busy: false,
    historyLoading: false,
    historyState: {
      loadingStrategy: 'lazy', hasOlder: false, loadingOlder: false, fullyLoaded: true,
    },
    error: null,
    ...overrides,
  };
}
