import type { BackendCapabilities, ConversationListInput, ConversationSummary as NativeSummary, Message, SendPromptOptions } from './contracts';
import type { AgentRequest, AgentRequestResponse } from './conversations/agent-request';
export type { Message, MessagePart, MessageAttachment, MessageMedia, ToolPart, ToolPartUpdate, ThreadGoal, ThreadPlan, AgentContextUsage } from './contracts/conversation';
export type { AgentRequest, AgentRequestResponse, AgentRequestOutcome } from './conversations/agent-request';
export type { ExecutionObservation, RequestObservation } from './contracts/usage';
export type { HarnessMcpEndpoint, HarnessTextGenerationInput, HarnessTextGenerationResult } from './generation';
export type ModelOption = import('./contracts').BackendModelOption;
export type SkillSummary = import('./contracts').BackendSkillSummary;
export type PluginSummary = import('./contracts').BackendPluginSummary;
export type RuntimeStatus = Omit<import('./contracts').BackendRuntimeStatus, 'detail' | 'capabilities'> & { detail?: string };
/** Provider-specific account/login detail is an explicit native escape hatch. */
export type Authentication = { connected: boolean; native: import('./contracts/authentication').ProviderAuthentication };
export type SessionStatus = { type: 'idle' | 'working' | 'awaitingInput' | 'error'; detail?: string; message?: string; native?: import('./contracts/status').AgentStatus };
export type AuthenticationAction = import('./contracts/authentication').ProviderAuthenticationAction;
export type TurnActionResult = { session: Session; activeTurnId: string | null };
export type HarnessProvider = 'codex' | 'claude' | 'cursor' | 'antigravity';
declare const sessionBrand: unique symbol;
declare const refBrand: unique symbol;
/** Driver-owned handle: callers cannot inspect or construct native session identity. */
export type Session = { readonly [sessionBrand]: true };
export type ConversationRef = { readonly [refBrand]: true };
export type HarnessContext = { id: string; folder: string | null; name?: string | null; defaults?: HarnessDefaults };
export type HarnessDefaults = { model?: string; reasoningEffort?: string; serviceTier?: string | null; permission?: string };
export type HarnessCapabilities = Omit<BackendCapabilities, 'approvalPresets' | 'permissionModes'> & { permissions: { id: string; dangerous?: boolean }[] };
export type PromptOptions = Omit<SendPromptOptions, 'backendOptions' | 'recordUserMessage'>;
export type Admission = { session: Session; turnId?: string; messageId?: string };
export type ConversationSummary = Omit<NativeSummary, 'ref'> & { ref: ConversationRef };
/** Full native lifecycle evidence, shared structurally by all supported providers.
 * Native error detail and execution usage remain lossless compatibility DTOs.
 */
export type TurnError = import('./core/surface').CodexSurfaceTurnError;
export type TurnExecutionUsage = import('./core/surface').CodexSurfaceExecutionUsage;
export type Turn = {
  id: string;
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed';
  error: TurnError | null;
  /** Native evidence; never defaulted by the consumer projection. */
  willRetry: boolean;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  itemsView?: 'full' | 'summary';
  detailsLoading?: boolean;
  detailsError?: string | null;
  executionUsage?: TurnExecutionUsage | null;
};
export type HistoryState = {
  hasOlder: boolean;
  loadingOlder: boolean;
  /** Optional provider-supported paging detail; absence is unknown. */
  itemsView?: 'full' | 'summary';
  loadingStrategy?: 'lazy' | 'eager';
  fullyLoaded?: boolean;
};
export type SessionState = {
  messages: Message[]; busy: boolean; activeTurnId: string | null;
  turns: Turn[];
  /** Undefined until the native provider supplies evidence. */
  answeredClientRequestIds?: string[];
  historyLoading?: boolean;
  historyState?: HistoryState;
  requests: AgentRequest[]; error: string | null;
  title: string | null; goal: import('./contracts').ThreadGoal | null;
  contextUsage: import('./contracts').AgentContextUsage | null;
  plan: import('./contracts').ThreadPlan | null;
};
export type HarnessEvent =
  | { type: 'session.changed'; session: Session; state: SessionState }
  | { type: 'plan.readyForReview'; session: Session; turnId: string; markdown: string; itemId?: string; requestId?: string }
  | { type: 'recovery.required'; session: Session; reason: string }
  | { type: 'request.created'; session: Session; request: AgentRequest }
  | { type: 'request.resolved'; session: Session; id: string; outcome: import('./conversations/agent-request').AgentRequestOutcome }
  | { type: 'status.changed'; session: Session; status: SessionStatus }
  | { type: 'usage.observed'; observation: import('./contracts/usage').ExecutionObservation }
  | { type: 'requestUsage.observed'; observation: import('./contracts/usage').RequestObservation };
export type HarnessDriver = {
  getRuntimeStatus(): RuntimeStatus;
  authenticate(action: AuthenticationAction): Promise<Authentication>;
  getAccountRateLimits(): Promise<import('./contracts').AccountRateLimits | null>;
  listModels(session: Session): Promise<ModelOption[]>;
  listSkills(session: Session, forceReload?: boolean): Promise<SkillSummary[]>;
  listPlugins(session: Session): Promise<PluginSummary[]>;
  generateText(session: Session, input: import('./generation').HarnessTextGenerationInput): Promise<import('./generation').HarnessTextGenerationResult>;
  generateImage(session: Session, input: import('./generation').HarnessImageGenerationInput, signal?: AbortSignal): Promise<import('./generation').HarnessImageGenerationResult>;
  setConversationTitle(session: Session, title: string): Promise<void>;
  setGoal(session: Session, objective: string): Promise<Admission & { goal?: import('./contracts').ThreadGoal }>;
  clearGoal(session: Session): Promise<Admission & { cleared?: boolean }>;
  steerPrompt(session: Session, prompt: string, options?: PromptOptions): Promise<Admission>;
  deleteTurn(session: Session, turnId: string): Promise<TurnActionResult>;
  editTurn(session: Session, turnId: string, content: string, options?: Pick<PromptOptions, 'content'>): Promise<TurnActionResult>;
  retryTurn(session: Session, turnId: string): Promise<TurnActionResult>;
  forkConversation(session: Session, target: Session, turnId?: string): Promise<Admission>;
  replaceConversationWithSummary(session: Session): Promise<Admission>;
  archiveConversation(session: Session): Promise<void>;
  deleteConversation(session: Session): Promise<void>;
  readConversationMessages(session: Session, ref: ConversationRef): Promise<Message[]>;
  readConversationContent(session: Session, input: Omit<import('./contracts').ConversationContentInput, 'sessionId'>): Promise<import('./contracts').ConversationContentChunk>;
  open(context: HarnessContext): Session;
  /** Persist as an opaque string in caller storage; contains native session metadata. */
  serializeSession(session: Session): string;
  restoreSession(context: HarnessContext, serialized: string): Session;
  serializeRef(ref: ConversationRef): string;
  restoreRef(serialized: string): ConversationRef;
  getCapabilities(session: Session): HarnessCapabilities;
  readSession(session: Session): SessionState;
  sendPrompt(session: Session, prompt: string, options?: PromptOptions): Promise<Admission>;
  interrupt(session: Session, expectedTurnId?: string): Promise<Admission>;
  respondToRequest(session: Session, response: Omit<AgentRequestResponse, 'agentId'>): Promise<void>;
  setPermission(session: Session, id: string): Promise<void>;
  loadConversation(session: Session): Promise<boolean>;
  loadTurnHistory(session: Session, turnId: string): Promise<void>;
  loadOlderHistory(session: Session): Promise<{ hasOlder: boolean }>;
  listConversations(session: Session, input?: ConversationListInput): Promise<ConversationSummary[]>;
  resumeConversation(session: Session, target: { ref: ConversationRef; storageState: 'active' | 'archived' }): Promise<void>;
  executeScopedPrompt(session: Session, input: { prompt: string; cwd: string; session?: Session; scope: import('./driver').HarnessPromptScope; options?: PromptOptions }): Promise<{ text: string; session: Session }>;
  disposeScopedSession(session: Session): Promise<void>;
  release(session: Session): Promise<void>;
  onEvent(listener: (event: HarnessEvent) => void): () => void;
  close(): Promise<void>;
};
