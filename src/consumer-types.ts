import type { Turn } from './contracts/turn';
import type { ProviderCapabilities, ConversationListInput, ConversationSummary as NativeSummary, Message, SendPromptOptions } from './contracts';
import type { AgentRequest, AgentRequestResponse } from './conversations/agent-request';
export type { PromptPart, PromptMention } from './contracts/prompt';
export type { Message, MessagePart, MessageAttachment, MessageMedia, ToolPart, ToolPartUpdate, ThreadGoal, ThreadPlan, AgentContextUsage } from './contracts/conversation';
export type { AgentRequest, AgentRequestResponse, AgentRequestOutcome } from './conversations/agent-request';
export type { ExecutionObservation, RequestObservation } from './contracts/usage';
export type { HarnessMcpEndpoint, HarnessTextGenerationInput, HarnessTextGenerationResult } from './generation';
/** Provider-authored catalog metadata is optional; portable selection uses model/id. */
export type ModelOption = Omit<import('./contracts/index').ProviderModelOption, 'displayName'> & { displayName?: string };
export type SkillSummary = import('./contracts/index').ProviderSkillSummary;
export type PluginSummary = Omit<import('./contracts/index').ProviderPluginSummary, 'displayName'> & { displayName?: string };
export type RuntimeStatus = Omit<import('./contracts/index').ProviderRuntimeStatus, 'detail' | 'capabilities'> & { detail?: string };
/** Provider-specific account/login detail is an explicit native escape hatch. */
export type Authentication = { connected: boolean; /** Present after `authenticate({ action: 'login' })` starts a managed login. */ login?: AuthenticationLogin; native: import('./contracts/authentication').ProviderAuthentication };
export type { AuthenticationLogin, AuthenticationLoginMethod } from './contracts/authentication';
export type SessionStatus = { type: 'idle' | 'working' | 'awaitingInput' | 'error'; reason?: 'approval' | 'input'; detail?: string; message?: string; native?: import('./contracts/status').AgentStatus };
export type AuthenticationAction = import('./contracts/authentication').ProviderAuthenticationAction;
type AuthenticationLogin = import('./contracts/authentication').AuthenticationLogin;
export type TurnActionResult = { session: Session; activeTurnId: string | null };
export type { HarnessProvider } from './contracts/shared';
type HarnessProvider = import('./contracts/shared').HarnessProvider;
declare const sessionBrand: unique symbol;
declare const refBrand: unique symbol;
/** Driver-owned handle: callers cannot inspect or construct native session identity. */
export type Session = { readonly [sessionBrand]: true };
export type ConversationRef = { readonly [refBrand]: true };
/** Plain restoration data. Consumers own serialization and storage. */
export type ConversationRefData = { provider: HarnessProvider; data: import('./contracts/index').ProviderConversationRef };
export type SessionData = { provider: HarnessProvider; data: import('./contracts/index').ProviderSessionData; defaults?: HarnessDefaults; role: 'main' | 'scope'; parentId?: string };

export type HarnessContext = { id: string; folder: string | null; name?: string | null; defaults?: HarnessDefaults };
/** `null` clears a default the provider would otherwise inherit. */
export type HarnessDefaults = { model?: string; reasoningEffort?: string | null; serviceTier?: string | null; permission?: string };
export type HarnessCapabilities = Omit<ProviderCapabilities, 'approvalPresets' | 'permissionModes' | 'login' | 'realtime' | 'remoteControl' | 'accountUsage'> & {
  permissions: { id: string; dangerous?: boolean }[];
  /** Managed login methods `authenticate({ action: 'login' })` accepts; empty when the provider has none. */
  login: readonly import('./contracts/authentication').AuthenticationLoginMethod[];
  remoteControl: boolean;
  realtime: boolean;
  accountUsage: boolean;
};
export type { StartCodexRealtimeOptions as RealtimeOptions, CodexRealtimeInputAudioChunk as RealtimeAudioChunk, CodexRealtimeEvent as RealtimeEvent } from './core/codex-conversation-types';
export type { CodexRealtimeSession as RealtimeSession } from './providers/codex/realtime-types';
export type { DevicePairingStatus as RemoteControlStatus, DevicePairingSession, PairedDevice } from './contracts/remote-control';
export type PromptOptions = Omit<SendPromptOptions, 'providerOptions' | 'recordUserMessage'>;
export type Admission = { session: Session; turnId?: string; messageId?: string };
export type ConversationSummary = Omit<NativeSummary, 'ref'> & { ref: ConversationRef };
export type { Turn, TurnError, TurnExecutionUsage, TurnStatus, TokenUsage, RequestUsage, RequestUsageField, SafetyFindings, JsonValue } from './contracts/turn';
export type HistoryState = {
  hasOlder: boolean;
  loadingOlder: boolean;
  /** Optional provider-supported paging detail; absence is unknown. */
  itemsView?: 'full' | 'summary';
  loadingStrategy?: 'lazy' | 'eager';
  fullyLoaded?: boolean;
};
/** Provider-reported execution settings. Missing fields remain unknown. */
export type SessionSelection = { model?: string | null; reasoningEffort?: string | null; serviceTier?: string | null };
export type SessionState = {
  selection?: SessionSelection;
  /** Provider-confirmed permission ID; absent or null means unknown. */
  permission?: string | null;
  messages: Message[]; busy: boolean; activeTurnId: string | null;
  turns: Turn[];
  /** Undefined until the native provider supplies evidence. */
  answeredClientRequestIds?: string[];
  historyLoading?: boolean;
  historyState?: HistoryState;
  requests: AgentRequest[]; error: string | null;
  title: string | null; goal: import('./contracts/index').ThreadGoal | null;
  contextUsage: import('./contracts/index').AgentContextUsage | null;
  plan: import('./contracts/index').ThreadPlan | null;
};
export type HarnessEvent =
  | { type: 'session.changed'; session: Session; state: SessionState; revision: number }
  /** The same change as the `session.changed` that follows it, as a revisioned patch for consumers that replicate state elsewhere. */
  | { type: 'session.patch'; session: Session; patch: import('./session-patch').SessionPatch }
  | { type: 'plan.readyForReview'; session: Session; turnId: string; markdown: string; itemId?: string; requestId?: string }
  | { type: 'recovery.required'; session: Session; reason: string }
  | { type: 'request.created'; session: Session; request: AgentRequest }
  | { type: 'request.resolved'; session: Session; id: string; outcome: import('./conversations/agent-request').AgentRequestOutcome }
  | { type: 'status.changed'; session: Session; status: SessionStatus }
  /** Raw provider conversation event for consumers that maintain their own replicas. Prefer `session.changed` for state. */
  | { type: 'provider.event'; session?: Session; event: import('./contracts/events').ProviderEvent }
  | { type: 'usage.observed'; observation: import('./contracts/usage').ExecutionObservation }
  | { type: 'requestUsage.observed'; observation: import('./contracts/usage').RequestObservation };
/** A provider harness. `P` narrows provider-specific inputs such as permission ids when the provider is known. */
export type Harness<P extends HarnessProvider = HarnessProvider> = {
  getRuntimeStatus(): RuntimeStatus;
  authenticate(action: AuthenticationAction): Promise<Authentication>;
  getBankedResets(): Promise<import('./contracts/banked-resets').BankedResets>;
  useBankedReset(input: import('./contracts/banked-resets').UseBankedResetInput): Promise<import('./contracts/banked-resets').BankedResetResult>;
  getAccountRateLimits(): Promise<import('./contracts/index').AccountRateLimits | null>;
  /** Live voice or text session on the conversation; check `capabilities.realtime`. */
  startRealtime(session: Session, options: import('./consumer-types').RealtimeOptions): Promise<import('./consumer-types').RealtimeSession>;
  /** Remote control and device pairing; check `capabilities.remoteControl`. */
  getRemoteControl(): Promise<import('./contracts/remote-control').DevicePairingStatus>;
  setRemoteControl(enabled: boolean): Promise<import('./contracts/remote-control').DevicePairingStatus>;
  startDevicePairing(): Promise<import('./contracts/remote-control').DevicePairingSession>;
  checkDevicePairing(pairing: import('./contracts/remote-control').DevicePairingSession): Promise<boolean>;
  listPairedDevices(environmentId: string): Promise<import('./contracts/remote-control').PairedDevice[]>;
  revokePairedDevice(environmentId: string, clientId: string): Promise<void>;
  listModels(session: Session): Promise<ModelOption[]>;
  listSkills(session: Session, forceReload?: boolean): Promise<SkillSummary[]>;
  listPlugins(session: Session): Promise<PluginSummary[]>;
  generateText(session: Session, input: import('./generation').HarnessTextGenerationInput): Promise<import('./generation').HarnessTextGenerationResult>;
  generateImage(session: Session, input: import('./generation').HarnessImageGenerationInput, signal?: AbortSignal): Promise<import('./generation').HarnessImageGenerationResult>;
  setConversationTitle(session: Session, title: string): Promise<void>;
  setGoal(session: Session, objective: string): Promise<Admission & { goal?: import('./contracts/index').ThreadGoal }>;
  clearGoal(session: Session): Promise<Admission & { cleared?: boolean }>;
  steerPrompt(session: Session, prompt: string, options?: PromptOptions): Promise<Admission>;
  deleteTurn(session: Session, turnId: string): Promise<TurnActionResult>;
  editTurn(session: Session, turnId: string, content: string, options?: Pick<PromptOptions, 'content'>): Promise<TurnActionResult>;
  retryTurn(session: Session, turnId: string): Promise<TurnActionResult>;
  /** Starts the provider's own review (Codex `review/start`). Without a target it reviews uncommitted changes. */
  startReview(session: Session, target?: import('./contracts/conversation').ConversationReviewTarget): Promise<Admission>;
  /** Lets the provider treat a prompt (such as `/compact`) as a command. Returns null right away when it is an ordinary prompt. */
  handlePromptCommand(session: Session, prompt: string): Promise<Admission> | null;
  /** The options the provider will actually send with a prompt (for example with skills resolved). */
  preparePromptOptions(session: Session, options?: PromptOptions): PromptOptions | undefined;
  /** Resumes a turn that was interrupted (for example by a restart). The optional review lets a safety-blocked turn continue after approval. */
  continueInterruptedTurn(session: Session, safetyReview?: import('./contracts/safety-review').ProviderSafetyReviewTarget): Promise<TurnActionResult>;
  /** Brings stored conversation state in line with the provider's own records. A no-op for providers that need no reconciliation. */
  reconcileConversations(sessions: Session[]): Promise<void>;
  /**
   * Forks the conversation into `target`, in the target's folder. Without `turnId`, a running source forks from its last completed turn.
   * Resolves null when the provider cannot fork this conversation right now; `forkedFromTurnId` names the turn the fork ends at when it is not the latest.
   */
  forkConversation(session: Session, target: Session, turnId?: string): Promise<(Admission & { forkedFromTurnId?: string }) | null>;
  archiveConversation(session: Session): Promise<void>;
  deleteConversation(session: Session): Promise<void>;
  /** `view: 'last'` reads only the most recent page, which is much cheaper on long conversations. */
  readConversationMessages(session: Session, ref: ConversationRef, options?: { view?: 'full' | 'last' }): Promise<Message[]>;
  /** Archives (`archived`) or restores (`active`) a stored conversation by reference. No session is required. */
  setConversationStorage(ref: ConversationRef, state: import('./contracts/conversation').ConversationStorageState): Promise<void>;
  readConversationSummary(session: Session, ref: ConversationRef): Promise<ConversationSummary | null>;
  readConversationContent(session: Session, input: Omit<import('./contracts/index').ConversationContentInput, 'sessionId'>): Promise<import('./contracts/index').ConversationContentChunk>;
  open(context: HarnessContext): Session;
  /** Detached native restoration data; the consumer owns serialization and storage. */
  getSessionData(session: Session): SessionData;
  getConversationRef(session: Session): ConversationRef | null;
  restoreSession(context: HarnessContext, data: SessionData): Session;
  getRefData(ref: ConversationRef): ConversationRefData;
  restoreRef(data: ConversationRefData): ConversationRef;
  getCapabilities(session: Session): HarnessCapabilities;
  /** What the provider offers in general, before any session exists. Session capabilities can be narrower. */
  getProviderCapabilities(): HarnessCapabilities;
  readSession(session: Session): SessionState;
  /** The full state with its revision: where a replica starts, or resyncs after missing a patch. */
  readSessionSnapshot(session: Session): import('./session-patch').SessionSnapshot;
  sendPrompt(session: Session, prompt: string, options?: PromptOptions): Promise<Admission>;
  interrupt(session: Session, expectedTurnId?: string): Promise<Admission>;
  respondToRequest(session: Session, response: Omit<AgentRequestResponse, 'agentId'>): Promise<void>;
  setPermission(session: Session, id: import('./contracts/permissions').PermissionFor<P>): Promise<void>;
  /** Changes the model, reasoning effort, speed or permission used by the session's next calls. */
  updateDefaults(session: Session, defaults: Partial<HarnessDefaults>): void;
  /**
   * Makes the session follow the host app's own record: the provider reads the stored conversation, folder, name and defaults
   * from `source` each time it looks, so a change made while an operation is in flight is seen by that operation.
   */
  bindSession(session: Session, source: () => { data?: import('./contracts/index').ProviderSessionData | null; folder?: string | null; name?: string | null; defaults?: HarnessDefaults }): void;
  /**
   * Re-states what the host app has stored for a session: its provider conversation (`null` clears it), folder or name.
   * Providers keep enforcing their own identity and workspace checks against the re-stated values.
   */
  syncSession(session: Session, state: { data?: import('./contracts/index').ProviderSessionData | null; folder?: string | null; name?: string | null; /** Replaces the session's defaults; nothing from earlier defaults is kept. */ defaults?: HarnessDefaults }): void;
  loadConversation(session: Session): Promise<boolean>;
  loadTurnHistory(session: Session, turnId: string): Promise<void>;
  loadOlderHistory(session: Session): Promise<{ hasOlder: boolean }>;
  listConversations(session: Session, input?: ConversationListInput): Promise<ConversationSummary[]>;
  resumeConversation(session: Session, target: { ref: ConversationRef; storageState: 'active' | 'archived' }): Promise<void>;
  /** A scope handle for `parent`, created before its run so the run can be steered, interrupted or answered by handle. */
  openScope(parent: Session, input: { cwd: string }): Session;
  executeScopedPrompt(session: Session, input: { prompt: string; cwd: string; session?: Session; scope: import('./generation').HarnessPromptScope; options?: PromptOptions; signal?: AbortSignal }): Promise<{ text: string; session: Session }>;
  disposeScopedSession(session: Session): Promise<void>;
  release(session: Session): Promise<void>;
  onEvent(listener: (event: HarnessEvent) => void): () => void;
  close(): Promise<void>;
};
