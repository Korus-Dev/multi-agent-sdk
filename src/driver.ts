import type { ApprovalPreset, BackendCapabilities, BackendConversationRef, BackendDefaults, BackendModelOption, BackendPluginSummary, BackendRuntimeStatus, BackendSession, BackendSkillSummary, ConversationListInput, ConversationResumeTarget, ConversationSummary, Message, SendPromptOptions, ThreadGoal } from './contracts';
import type { AgentRequestResponse } from './conversations/agent-request';
import type { HarnessContext } from './context';
import type { HarnessPromptScope, HarnessTextGenerationInput, HarnessTextGenerationResult } from './generation';
export type { HarnessContext } from './context';
export type { HarnessEvent } from './contracts/events';

/** Caller-owned context: the SDK never requires an application Agent record. */
export type HarnessSessionContext = HarnessContext;

export type { HarnessPromptScope } from './generation';
export type HarnessScopedPromptInput = { prompt: string; cwd: string; session?: BackendSession; scope: HarnessPromptScope; options?: SendPromptOptions; signal?: AbortSignal };
export type HarnessScopedPromptResult = { text: string; session: BackendSession };

export type HarnessSendResult = {
  backendSession: BackendSession;
  turnId?: string;
  /** Public provider user-message ID, preserved by canonical history. */
  messageId?: string;
};
export type HarnessTurnActionResult = {
  backendSession: BackendSession;
  activeTurnId: string | null;
};
export type HarnessConversationResumeResult = {
  backendSession: BackendSession;
};
export type HarnessConversationReplacementResult = {
  backendSession: BackendSession;
};
export type HarnessConversationForkResult = HarnessConversationResumeResult & {
  activeTurnId?: string;
};
export type HarnessHistoryLoadResult<HistoryFrame = unknown> = { hasOlder: boolean; frame?: HistoryFrame };
export type HarnessGoalResult = {
  backendSession: BackendSession;
  turnId?: string;
  goal?: ThreadGoal;
  cleared?: boolean;
};
export type HarnessApprovalPresetResult = {
  backendSession: BackendSession;
  approvalPreset: ApprovalPreset;
};
export type HarnessPermissionModeResult = {
  backendDefaults: BackendDefaults;
};

/** Native harness operations; application workflows extend this contract in the host. */
export type HarnessDriver<Context = HarnessSessionContext, Event = unknown, HistoryFrame = unknown> = {
  readonly backend: string;
  authenticate?(request: import('./contracts/authentication').ProviderAuthenticationAction): Promise<import('./contracts/authentication').ProviderAuthentication>;
  getRuntimeStatus(): BackendRuntimeStatus;
  getAccountRateLimits?(): Promise<import('./contracts/index').AccountRateLimits | null>;
  getCapabilities(agent: Context): BackendCapabilities;
  sendPrompt(agent: Context, prompt: string, options?: SendPromptOptions): Promise<HarnessSendResult>;
  executeScopedPrompt?(agent: Context, input: HarnessScopedPromptInput): Promise<HarnessScopedPromptResult>;
  /** Cancels pending admission and active work for this scope only. */
  cancelScopedPrompt?(agent: Context): Promise<void>;
  disposeScopedSession?(agent: Context, session: BackendSession): Promise<void>;
  generateImage?(agent: Context, input: import('./generation').HarnessImageGenerationInput, signal?: AbortSignal): Promise<import('./generation').HarnessImageGenerationResult>;
  generateText?(agent: Context, input: HarnessTextGenerationInput): Promise<HarnessTextGenerationResult>;
  setConversationTitle?(agent: Context, title: string): Promise<void>;
  setGoal?(agent: Context, objective: string): Promise<HarnessGoalResult>;
  clearGoal?(agent: Context): Promise<HarnessGoalResult>;
  setApprovalPreset?(agent: Context, preset: ApprovalPreset): Promise<HarnessApprovalPresetResult>;
  setPermissionMode?(agent: Context, mode: string): Promise<HarnessPermissionModeResult>;
  releaseConversation?(agentId: string): void | Promise<void>;
  archiveAgentConversation?(agent: Context): Promise<void>;
  deleteAgentConversation?(agent: Context): Promise<void>;
  reconcileConversations?(agents: Context[]): Promise<void>;
  interrupt(agent: Context, expectedTurnId?: string): Promise<HarnessSendResult>;
  respondToAgentRequest(response: AgentRequestResponse): Promise<void>;
  loadConversation?(agent: Context): Promise<BackendSession | null>;
  loadOlderHistory?(agent: Context): Promise<HarnessHistoryLoadResult<HistoryFrame>>;
  loadTurnHistory?(agent: Context, turnId: string): Promise<void>;
  readConversationContent?(agent: Context, input: import('./contracts/conversation').ConversationContentInput): Promise<import('./contracts/conversation').ConversationContentChunk>;
  listConversations?(agent: Context, input?: ConversationListInput): Promise<ConversationSummary[]>;
  resumeConversation?(agent: Context, target: ConversationResumeTarget): Promise<HarnessConversationResumeResult>;
  replaceConversationWithSummary?(agent: Context): Promise<HarnessConversationReplacementResult>;
  forkConversation?(agent: Context, targetAgent: Context, turnId?: string): Promise<HarnessConversationForkResult>;
  readConversationMessages?(ref: BackendConversationRef, agentId: string): Promise<Message[]>;
  readConversationSummary?(agent: Context, ref: BackendConversationRef): Promise<ConversationSummary | null>;
  steerPrompt?(agent: Context, prompt: string, options?: SendPromptOptions): Promise<HarnessSendResult>;
  deleteTurn?(agent: Context, turnId: string): Promise<HarnessTurnActionResult>;
  editTurn?(agent: Context, turnId: string, content: string, options?: Pick<SendPromptOptions, 'content'>): Promise<HarnessTurnActionResult>;
  retryTurn?(agent: Context, turnId: string): Promise<HarnessTurnActionResult>;
  listModels?(agent: Context): Promise<BackendModelOption[]>;
  listPlugins?(agent: Context): Promise<BackendPluginSummary[]>;
  listSkills?(agent: Context, forceReload?: boolean): Promise<BackendSkillSummary[]>;
  onEvent(listener: (event: Event) => void): () => void;
  onUsage?(listener: (event: import('./contracts/usage').ExecutionObservation) => void): () => void;
  onRequestUsage?(listener: (event: import('./contracts/usage').RequestObservation) => void): () => void;
  close(): Promise<void>;
};
