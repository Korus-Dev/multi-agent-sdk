import type { ApprovalPreset, ProviderCapabilities, ProviderConversationRef, ProviderDefaults, ProviderModelOption, ProviderPluginSummary, ProviderRuntimeStatus, ProviderSessionData, ProviderSkillSummary, ConversationListInput, ConversationResumeTarget, ConversationSummary, Message, SendPromptOptions, ThreadGoal } from './contracts';
import type { AgentRequestResponse } from './conversations/agent-request';
import type { ProviderContext } from './context';
import type { HarnessPromptScope, HarnessTextGenerationInput, HarnessTextGenerationResult } from './generation';
export type { ProviderContext } from './context';
export type { ProviderEvent } from './contracts/events';

/** Caller-owned context: the SDK never requires an application Agent record. */
export type ProviderSessionContext = ProviderContext;

export type { HarnessPromptScope } from './generation';
export type ProviderScopedPromptInput = { prompt: string; cwd: string; session?: ProviderSessionData; scope: HarnessPromptScope; options?: SendPromptOptions; signal?: AbortSignal };
export type ProviderScopedPromptResult = { text: string; session: ProviderSessionData };

export type ProviderSendResult = {
  providerSession: ProviderSessionData;
  turnId?: string;
  /** Public provider user-message ID, preserved by canonical history. */
  messageId?: string;
};
export type ProviderTurnActionResult = {
  providerSession: ProviderSessionData;
  activeTurnId: string | null;
};
export type ProviderConversationResumeResult = {
  providerSession: ProviderSessionData;
};
export type ProviderConversationReplacementResult = {
  providerSession: ProviderSessionData;
};
export type ProviderConversationForkResult = ProviderConversationResumeResult & {
  activeTurnId?: string;
};
export type ProviderHistoryLoadResult<HistoryFrame = unknown> = { hasOlder: boolean; frame?: HistoryFrame };
export type ProviderGoalResult = {
  providerSession: ProviderSessionData;
  turnId?: string;
  goal?: ThreadGoal;
  cleared?: boolean;
};
export type ProviderApprovalPresetResult = {
  providerSession: ProviderSessionData;
  approvalPreset: ApprovalPreset;
};
export type ProviderPermissionModeResult = {
  providerDefaults: ProviderDefaults;
};

/** Native harness operations; application workflows extend this contract in the host. */
export type ProviderDriver<Context = ProviderSessionContext, Event = unknown, HistoryFrame = unknown> = {
  readonly provider: string;
  authenticate?(request: import('./contracts/authentication').ProviderAuthenticationAction): Promise<import('./contracts/authentication').ProviderAuthentication>;
  getRuntimeStatus(): ProviderRuntimeStatus;
  getBankedResets?(): Promise<import('./contracts/banked-resets').BankedResets>;
  useBankedReset?(input: import('./contracts/banked-resets').UseBankedResetInput): Promise<import('./contracts/banked-resets').BankedResetResult>;
  getAccountRateLimits?(): Promise<import('./contracts/index').AccountRateLimits | null>;
  /** Archives or restores a stored conversation by reference; no live session is needed. */
  setConversationStorage?(ref: import('./contracts/index').ProviderConversationRef, state: import('./contracts/conversation').ConversationStorageState): Promise<void>;
  startRealtime?(agent: Context, options: import('./consumer-types').RealtimeOptions): Promise<import('./consumer-types').RealtimeSession>;
  getRemoteControlStatus?(): Promise<import('./contracts/remote-control').DevicePairingStatus>;
  enableRemoteControl?(): Promise<import('./contracts/remote-control').DevicePairingStatus>;
  disableRemoteControl?(): Promise<import('./contracts/remote-control').DevicePairingStatus>;
  startDevicePairing?(): Promise<import('./contracts/remote-control').DevicePairingSession>;
  checkDevicePairing?(session: import('./contracts/remote-control').DevicePairingSession): Promise<boolean>;
  listPairedDevices?(environmentId: string): Promise<import('./contracts/remote-control').PairedDevice[]>;
  revokePairedDevice?(environmentId: string, clientId: string): Promise<void>;
  getCapabilities(agent?: Context): ProviderCapabilities;
  sendPrompt(agent: Context, prompt: string, options?: SendPromptOptions): Promise<ProviderSendResult>;
  executeScopedPrompt?(agent: Context, input: ProviderScopedPromptInput): Promise<ProviderScopedPromptResult>;
  /** Cancels pending admission and active work for this scope only. */
  cancelScopedPrompt?(agent: Context): Promise<void>;
  disposeScopedSession?(agent: Context, session: ProviderSessionData): Promise<void>;
  generateImage?(agent: Context, input: import('./generation').HarnessImageGenerationInput, signal?: AbortSignal): Promise<import('./generation').HarnessImageGenerationResult>;
  generateText?(agent: Context, input: HarnessTextGenerationInput): Promise<HarnessTextGenerationResult>;
  setConversationTitle?(agent: Context, title: string): Promise<void>;
  setGoal?(agent: Context, objective: string): Promise<ProviderGoalResult>;
  clearGoal?(agent: Context): Promise<ProviderGoalResult>;
  setApprovalPreset?(agent: Context, preset: ApprovalPreset): Promise<ProviderApprovalPresetResult>;
  setPermissionMode?(agent: Context, mode: string): Promise<ProviderPermissionModeResult>;
  releaseConversation?(agentId: string): void | Promise<void>;
  archiveAgentConversation?(agent: Context): Promise<void>;
  deleteAgentConversation?(agent: Context): Promise<void>;
  reconcileConversations?(agents: Context[]): Promise<void>;
  interrupt(agent: Context, expectedTurnId?: string): Promise<ProviderSendResult>;
  respondToAgentRequest(response: AgentRequestResponse): Promise<void>;
  loadConversation?(agent: Context): Promise<ProviderSessionData | null>;
  loadOlderHistory?(agent: Context): Promise<ProviderHistoryLoadResult<HistoryFrame>>;
  loadTurnHistory?(agent: Context, turnId: string): Promise<void>;
  readConversationContent?(agent: Context, input: import('./contracts/conversation').ConversationContentInput): Promise<import('./contracts/conversation').ConversationContentChunk>;
  listConversations?(agent: Context, input?: ConversationListInput): Promise<ConversationSummary[]>;
  resumeConversation?(agent: Context, target: ConversationResumeTarget): Promise<ProviderConversationResumeResult>;
  forkConversation?(agent: Context, targetAgent: Context, turnId?: string): Promise<ProviderConversationForkResult>;
  readConversationMessages?(ref: ProviderConversationRef, agentId: string, options?: { view?: 'full' | 'last' }): Promise<Message[]>;
  readConversationSummary?(agent: Context, ref: ProviderConversationRef): Promise<ConversationSummary | null>;
  steerPrompt?(agent: Context, prompt: string, options?: SendPromptOptions): Promise<ProviderSendResult>;
  /** The provider's own review feature, when it has one. */
  startReview?(agent: Context, target?: import('./contracts/conversation').ConversationReviewTarget): Promise<ProviderSendResult>;
  forkWorktreeConversation?(agent: Context, targetAgent: Context): Promise<ProviderConversationForkResult | null>;
  tryHandlePromptCommand?(agent: Context, prompt: string): Promise<ProviderSendResult> | null;
  preparePromptOptions?(agent: Context, options?: SendPromptOptions): SendPromptOptions | undefined;
  continueInterruptedTurn?(agent: Context, safetyReview?: import('./contracts/safety-review').ProviderSafetyReviewTarget): Promise<ProviderTurnActionResult>;
  deleteTurn?(agent: Context, turnId: string): Promise<ProviderTurnActionResult>;
  editTurn?(agent: Context, turnId: string, content: string, options?: Pick<SendPromptOptions, 'content'>): Promise<ProviderTurnActionResult>;
  retryTurn?(agent: Context, turnId: string): Promise<ProviderTurnActionResult>;
  listModels?(agent: Context): Promise<ProviderModelOption[]>;
  listPlugins?(agent: Context): Promise<ProviderPluginSummary[]>;
  listSkills?(agent: Context, forceReload?: boolean): Promise<ProviderSkillSummary[]>;
  onEvent(listener: (event: Event) => void): () => void;
  onUsage?(listener: (event: import('./contracts/usage').ExecutionObservation) => void): () => void;
  onRequestUsage?(listener: (event: import('./contracts/usage').RequestObservation) => void): () => void;
  close(): Promise<void>;
};
