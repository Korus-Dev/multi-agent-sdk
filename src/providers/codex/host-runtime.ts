import type { v2 } from '@korus-dev/codex-sdk';
import type {
  Approval,
  CodexHostAuthentication,
  ClientRequest,
  CodexHostSnapshot,
  CodexConversationLoadingStrategy,
  Skill,
  CodexThreadStatus,
  Turn,
  ConversationMessage,
} from '../../core/codex-host';

export type ThreadRuntimeState = {
  threadId: string;
  cwd: string | null;
  hydrated: boolean;
  activeTurnId: string | null;
  turns: Turn[];
  turnIds: string[];
  messages: ConversationMessage[];
  answeredClientRequestIds: string[];
  approvalPreset: CodexHostSnapshot['approvalPreset'];
  approvalPresets: CodexHostSnapshot['approvalPresets'];
  permissionProfiles: CodexHostSnapshot['permissionProfiles'];
  skills: Skill[];
  skillCatalogStatus: CodexHostSnapshot['skillCatalogStatus'];
  selectedModelId: string | null;
  selectedReasoningEffort: string | null;
  selectedServiceTier: string | null;
  planMode: boolean;
  executionPlan: CodexHostSnapshot['executionPlan'];
  contextUsage: CodexHostSnapshot['contextUsage'];
  goal: CodexHostSnapshot['goal'];
  turnGitDiff: CodexHostSnapshot['turnGitDiff'];
  threadStatus: CodexThreadStatus | null;
  queuedPrompts: CodexHostSnapshot['queuedPrompts'];
  busy: boolean;
  turnStartPending: boolean;
  historyLoading: boolean;
  historyMode: v2.ThreadHistoryMode;
  loadingStrategy: CodexConversationLoadingStrategy;
  historyItemsView: 'full' | 'summary';
  historyCursor: string | null;
  historyHasOlder: boolean;
  historyLoadingOlder: boolean;
  fullHistoryHydrated: boolean;
  error: string | null;
  planMarkdownByTurn: Map<string, string>;
};

export type ThreadRuntimePatch = Partial<Omit<ThreadRuntimeState, 'threadId' | 'planMarkdownByTurn'>>;

export type ConversationCatalogs = Pick<
  ThreadRuntimeState,
  'approvalPresets' | 'permissionProfiles' | 'skillCatalogStatus' | 'skills'
>;

export function initialHostSnapshot(authentication: CodexHostAuthentication): CodexHostSnapshot {
  return {
    status: 'idle',
    authentication,
    conversations: [],
    activeConversationId: null,
    activeTurnId: null,
    turns: [],
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
    executionPlan: null,
    contextUsage: null,
    goal: null,
    turnGitDiff: null,
    threadStatus: null,
    rateLimits: null,
    queuedPrompts: [],
    busy: false,
    historyLoading: false,
    historyState: {
      loadingStrategy: 'lazy',
      hasOlder: false,
      loadingOlder: false,
      fullyLoaded: false,
    },
    error: null,
  };
}

export function createThreadRuntime(
  threadId: string,
  state: CodexHostSnapshot,
  patch: ThreadRuntimePatch = {},
): ThreadRuntimeState {
  return {
    threadId,
    cwd: null,
    hydrated: false,
    activeTurnId: null,
    turns: [],
    turnIds: [],
    messages: [],
    answeredClientRequestIds: [],
    approvalPreset: state.approvalPreset,
    approvalPresets: [...state.approvalPresets],
    permissionProfiles: [...state.permissionProfiles],
    skills: [...state.skills],
    skillCatalogStatus: state.skillCatalogStatus,
    selectedModelId: state.selectedModelId,
    selectedReasoningEffort: state.selectedReasoningEffort,
    selectedServiceTier: state.selectedServiceTier ?? null,
    planMode: false,
    executionPlan: null,
    contextUsage: null,
    goal: null,
    turnGitDiff: null,
    threadStatus: null,
    queuedPrompts: [],
    busy: false,
    turnStartPending: false,
    historyLoading: false,
    historyMode: 'legacy',
    loadingStrategy: state.historyState?.loadingStrategy ?? 'lazy',
    historyItemsView: 'full',
    historyCursor: null,
    historyHasOlder: false,
    historyLoadingOlder: false,
    fullHistoryHydrated: false,
    error: null,
    planMarkdownByTurn: new Map(),
    ...patch,
  };
}

export function runtimeProjection(
  runtime: ThreadRuntimeState,
  approvals: Approval[],
  clientRequests: ClientRequest[],
): Pick<
  CodexHostSnapshot,
  | 'approvalPreset'
  | 'approvalPresets'
  | 'answeredClientRequestIds'
  | 'approvals'
  | 'activeTurnId'
  | 'busy'
  | 'clientRequests'
  | 'contextUsage'
  | 'error'
  | 'executionPlan'
  | 'goal'
  | 'historyLoading'
  | 'historyState'
  | 'messages'
  | 'permissionProfiles'
  | 'planMode'
  | 'queuedPrompts'
  | 'selectedModelId'
  | 'selectedReasoningEffort'
  | 'selectedServiceTier'
  | 'skillCatalogStatus'
  | 'skills'
  | 'threadStatus'
  | 'turnGitDiff'
  | 'turns'
> {
  const projectedClientRequests = [...clientRequests];
  const knownClientRequestIds = new Set(projectedClientRequests.map((request) => request.id));
  const answeredClientRequestIds = new Set(runtime.answeredClientRequestIds);
  for (const message of runtime.messages) {
    const answeredByMessage = message.metadata?.asyncQuestionRequestIds;
    if (Array.isArray(answeredByMessage)) {
      for (const requestId of answeredByMessage) {
        if (typeof requestId === 'string') answeredClientRequestIds.add(requestId);
      }
    }
  }
  for (const message of runtime.messages) {
    for (const part of message.parts) {
      if (
        part.type !== 'question'
        || part.historical === true
        || knownClientRequestIds.has(part.request.id)
        || answeredClientRequestIds.has(part.request.id)
      ) continue;
      knownClientRequestIds.add(part.request.id);
      projectedClientRequests.push(part.request);
    }
  }
  return {
    activeTurnId: runtime.activeTurnId,
    approvalPreset: runtime.approvalPreset,
    approvalPresets: runtime.approvalPresets,
    answeredClientRequestIds: [...answeredClientRequestIds],
    approvals,
    busy: runtime.busy,
    clientRequests: projectedClientRequests,
    contextUsage: runtime.contextUsage,
    error: runtime.error,
    executionPlan: runtime.executionPlan,
    goal: runtime.goal,
    historyLoading: runtime.historyLoading,
    historyState: {
      loadingStrategy: runtime.loadingStrategy,
      ...(runtime.historyItemsView === 'summary' ? { itemsView: 'summary' as const } : {}),
      hasOlder: runtime.historyHasOlder,
      loadingOlder: runtime.historyLoadingOlder,
      fullyLoaded: runtime.fullHistoryHydrated,
    },
    messages: runtime.messages,
    permissionProfiles: runtime.permissionProfiles,
    planMode: runtime.planMode,
    queuedPrompts: runtime.queuedPrompts,
    selectedModelId: runtime.selectedModelId,
    selectedReasoningEffort: runtime.selectedReasoningEffort,
    selectedServiceTier: runtime.selectedServiceTier,
    skillCatalogStatus: runtime.skillCatalogStatus,
    skills: runtime.skills,
    threadStatus: runtime.threadStatus,
    turnGitDiff: runtime.turnGitDiff,
    turns: runtime.turns,
  };
}
