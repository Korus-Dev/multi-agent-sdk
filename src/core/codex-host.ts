import type { AgentContextUsage, ThreadGoal, ThreadPlanStep } from '../contracts/conversation';
export type { AgentContextUsage, ThreadGoal, ThreadPlanStep, ThreadPlanStepStatus } from '../contracts/conversation';
import type { HostConnectionStatus, HostEventOrigin } from '../contracts/backend';
export type { HostConnectionStatus, HostEventOrigin } from '../contracts/backend';
import type { ConversationQueuedPrompt, ConversationTurnGitDiff, ConversationExecutionPlan, ConversationHistoryReason, FileActivityAction, FileActivityStatus } from '../contracts/conversation';
export type { ConversationQueuedPrompt, ConversationTurnGitDiff, ConversationExecutionPlan, ConversationHistoryReason, FileActivityAction, FileActivityStatus } from '../contracts/conversation';
import type { ConversationMessageToolPartUpdate, CatalogStatus, ModelDescriptor, PermissionProfile } from '../contracts/ui';
export type { ConversationMessageToolPartUpdate, CatalogStatus, ReasoningEffortOption, ModelDescriptor, PermissionProfile } from '../contracts/ui';
import type {
  ClientSendMessageOptions,
  Approval,
  ApprovalDecision,
  ApprovalScope,
  ClientRequest,
  ClientRequestResponse,
  Plugin,
  Skill,
  SendMessageOptions,
  UpdateConversationSettings,
  ConversationMessage,
  ConversationMessageTextPart,
  ConversationMessageToolPart,
  ApprovalPreset,
} from '../contracts/ui';
export type {
  ClientAttachment,
  ClientSendMessageOptions,
  ConversationRenderStrategy,
  Approval,
  ApprovalDecision,
  ApprovalScope,
  RequestedPermission,
  Attachment,
  ClientRequest,
  ClientRequestResponse,
  Plugin,
  ServiceTier,
  Skill,
  SendMessageOptions,
  UpdateConversationSettings,
  ConversationMessage,
  ConversationMessageAttachment,
  ConversationMessageAttachmentPart,
  ConversationMessageMedia,
  ConversationMessageMediaPart,
  ConversationMessagePart,
  ConversationMessageQuestionPart,
  ConversationMessageStatusPart,
  ConversationMessageTextPart,
  ConversationMessageToolPart,
  AskUserQuestion,
  AskUserAnswers,
  ToolConfirmationDecision,
  SkillInput,
  ApprovalPreset,
  ConversationMessageReasoningPart,
} from '../contracts/ui';
import type {
  JsonValue,
  TurnStatus,
  TurnExecutionUsage,
  SafetyFindings,
  TurnError,
  Turn,
} from '../contracts/turn';
export type {
  JsonValue,
  TurnStatus,
  TokenUsage,
  RequestUsageField,
  RequestUsage,
  TurnExecutionUsage,
  SafetyFindings,
  TurnError,
  Turn,
} from '../contracts/turn';
export { normalizePromptContent, promptContentText, promptContentDispatchText, trimPromptContent, slicePromptContent, replacePromptContentRange } from './prompt-content';
export type { PromptMention, PromptPart } from './prompt-content';

export type CodexConversationSummary = {
  id: string;
  /** Session tree shared by a root conversation and its sub-agents. */
  sessionId?: string;
  /** Parent conversation when this summary represents a sub-agent. */
  parentConversationId?: string;
  /** App-server-assigned sub-agent nickname, when present. */
  agentNickname?: string;
  /** App-server-assigned sub-agent role, when present. */
  agentRole?: string;
  title: string;
  preview: string;
  cwd: string;
  status: 'idle' | 'active' | 'error';
  /** Number of turns present on the app-server thread payload. Thread list responses may report zero. */
  turnCount: number;
  createdAt: string;
  updatedAt: string;
};

/** Current connection from app-server to Codex remote control. */
export type CodexRemoteControlConnectionStatus = {
  status: 'disabled' | 'connecting' | 'connected' | 'errored';
  serverName: string;
  installationId: string;
  environmentId: string | null;
};

export type CodexThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | {
    type: 'active';
    activeFlags: Array<'waitingOnApproval' | 'waitingOnUserInput'>;
  };

export type CodexRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CodexRateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  individualLimit: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: number;
  } | null;
  planType: string | null;
  rateLimitReachedType: string | null;
};

export type ReadCodexRateLimitsOptions = {
  excludeResetCreditDetails?: boolean;
};

export type CodexAccountUsage = {
  summary: {
    lifetimeTokens: string | null;
    peakDailyTokens: string | null;
    longestRunningTurnSec: string | null;
    currentStreakDays: string | null;
    longestStreakDays: string | null;
  };
  dailyUsageBuckets: readonly { startDate: string; tokens: string }[] | null;
};

export type ConsumeCodexRateLimitResetCreditOptions = {
  idempotencyKey: string;
  creditId?: string;
};
export type CodexRateLimitResetCreditResult = {
  outcome: 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit';
};

export type CodexRateLimits = {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot> | null;
  rateLimitResetCredits: {
    availableCount: string;
    credits: readonly {
      id: string;
      resetType: string;
      status: string;
      grantedAt: number;
      expiresAt: number | null;
      title: string | null;
      description: string | null;
    }[] | null;
  } | null;
};

/** Controls whether a conversation loads its complete history up front. */
export type CodexConversationLoadingStrategy = 'eager' | 'lazy';

export type CodexConversationHistoryState = {
  /** Missing means full detail; individual turns may already have richer cached content. */
  itemsView?: 'full' | 'summary';
  loadingStrategy: CodexConversationLoadingStrategy;
  hasOlder: boolean;
  loadingOlder: boolean;
  fullyLoaded: boolean;
};

export type CodexHostAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string; workspaceName?: string }
  | { type: 'gcp' }
  | { type: 'amazonBedrock'; credentialSource: 'codexManaged' | 'awsManaged' };

export type CodexHostLoginStatus =
  | 'idle'
  | 'starting'
  | 'pending'
  | 'completed'
  | 'cancelled'
  | 'error';

export type CodexHostLoginState = {
  status: CodexHostLoginStatus;
  loginId: string | null;
  authUrl: string | null;
  error: string | null;
};

/**
 * Protocol-free projection of `account/read` plus the active managed login.
 * `requiresOpenaiAuth` deliberately preserves the app-server field; signed-out
 * hosts should check for a loaded `account === null && requiresOpenaiAuth`.
 */
export type CodexHostAuthentication = {
  status: CatalogStatus;
  account: CodexHostAccount | null;
  requiresOpenaiAuth: boolean | null;
  error: string | null;
  login: CodexHostLoginState;
};

export type CodexChatGptLogin = {
  loginId: string;
  authUrl: string;
};

export type CodexChatGptDeviceCodeLogin = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

export type CodexHostSnapshot = {
  status: HostConnectionStatus;
  authentication: CodexHostAuthentication;
  conversations: CodexConversationSummary[];
  activeConversationId: string | null;
  activeTurnId: string | null;
  turns: Turn[];
  messages: ConversationMessage[];
  clientRequests: ClientRequest[];
  answeredClientRequestIds: string[];
  approvals: Approval[];
  models: ModelDescriptor[];
  modelCatalogStatus: CatalogStatus;
  skills: Skill[];
  skillCatalogStatus: CatalogStatus;
  plugins: Plugin[];
  pluginCatalogStatus: CatalogStatus;
  permissionProfiles: PermissionProfile[];
  approvalPresets: ApprovalPreset[];
  approvalPreset: ApprovalPreset | null;
  selectedModelId: string | null;
  selectedReasoningEffort: string | null;
  /** Selected app-server service tier. Optional for backwards-compatible snapshots. */
  selectedServiceTier?: string | null;
  planMode: boolean;
  /** Latest structured execution plan. Optional for backwards-compatible snapshots. */
  executionPlan?: ConversationExecutionPlan | null;
  contextUsage: AgentContextUsage | null;
  goal: ThreadGoal | null;
  turnGitDiff: ConversationTurnGitDiff | null;
  threadStatus: CodexThreadStatus | null;
  rateLimits: CodexRateLimits | null;
  queuedPrompts: ConversationQueuedPrompt[];
  busy: boolean;
  historyLoading: boolean;
  historyState?: CodexConversationHistoryState;
  error: string | null;
};

export type CodexConversationSnapshot = CodexHostSnapshot & {
  activeConversationId: string;
  turnIds: string[];
};

/** Conversation-local fields replaced together with a canonical history projection. */
export type CodexConversationHistoryReplacementState = Pick<
  CodexConversationSnapshot,
  | 'activeTurnId'
  | 'answeredClientRequestIds'
  | 'busy'
  | 'contextUsage'
  | 'error'
  | 'executionPlan'
  | 'historyLoading'
  | 'historyState'
  | 'turnGitDiff'
  | 'turnIds'
  | 'turns'
>;

/** Paging metadata refreshed after older canonical history is prepended. */
export type CodexConversationHistoryPrependState = Pick<
  CodexConversationSnapshot,
  'historyLoading' | 'historyState' | 'turnIds' | 'turns'
>;

export type CodexConversationHistory = {
  conversationId: string;
  messages: ConversationMessage[];
  threadStatus: CodexThreadStatus | null;
};

export type CodexConversationHistoryPage = {
  conversationId: string;
  messages: ConversationMessage[];
  hasOlder: boolean;
};

/** A bounded, chronological list of user prompts for composer recall. */
export type CodexConversationPromptHistory = {
  conversationId: string;
  prompts: string[];
};
export type CodexSubagentItemLifecycle = 'started' | 'completed';
export type CodexSubagentTool =
  | 'spawnAgent'
  | 'sendInput'
  | 'resumeAgent'
  | 'wait'
  | 'closeAgent'
  | 'sendMessage'
  | 'followupTask'
  | 'interruptAgent'
  | 'listAgents';
export type CodexSubagentToolCallStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted';
export type CodexSubagentStatus =
  | 'pendingInit'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'notFound';
export type CodexSubagentState = {
  status: CodexSubagentStatus;
  message: string | null;
};
export type CodexSubagentToolCall = {
  id: string;
  tool: CodexSubagentTool;
  status: CodexSubagentToolCallStatus;
  senderConversationId: string;
  receiverConversationIds: readonly string[];
  prompt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agentStates: Readonly<Record<string, CodexSubagentState>>;
};
export type CodexSubagentActivity = {
  id: string;
  kind: 'started' | 'interacted' | 'interrupted' | 'completed';
  agentConversationId: string;
  agentPath: string;
};
/** Explicit user review of the exact findings supplied by the provider. */
export type ContinueCodexSafetyReviewOptions = {
  turnId: string;
  findings: SafetyFindings;
};

/**
 * Signed 16-bit little-endian PCM carried by a Codex realtime session.
 *
 * Realtime is an experimental app-server API. Audio remains ephemeral and is
 * intentionally not projected into conversation history.
 */
export type CodexRealtimeAudioChunk = {
  data: Uint8Array;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel: number | null;
  itemId: string | null;
};

export type CodexRealtimeInputAudioChunk = Omit<
  CodexRealtimeAudioChunk,
  'samplesPerChannel' | 'itemId'
> & {
  samplesPerChannel?: number | null;
  itemId?: string | null;
};

export type CodexRealtimeOutputModality = 'text' | 'audio';
export type CodexRealtimeVersion = 'v1' | 'v2' | 'v3';
export type CodexRealtimeTextRole = 'user' | 'developer' | 'assistant';
export type CodexRealtimeTransport =
  | { type: 'websocket' }
  | { type: 'webrtc'; sdp: string };

export type StartCodexRealtimeOptions = {
  outputModality: CodexRealtimeOutputModality;
  model?: string;
  version?: CodexRealtimeVersion;
  voice?: string;
  includeStartupContext?: boolean;
  prompt?: string | null;
  /**
   * Routes a partial transcript through Codex if the realtime transport ends
   * before the backend finalizes that transcript.
   */
  flushTranscriptTailOnSessionEnd?: boolean;
  /**
   * Websocket accepts PCM through appendAudio and requires API-key auth.
   * WebRTC accepts a browser-generated offer and carries audio over its media
   * track; app-server returns the remote SDP on the session handle.
   */
  transport?: CodexRealtimeTransport;
};

/** Browser live-chat signaling. Media is carried by WebRTC, not the SDK bridge. */
export type StartCodexLiveChatOptions = Omit<StartCodexRealtimeOptions, 'transport' | 'outputModality'> & {
  sdp: string;
};

type CodexHostEventEnvelope<Type extends string, Payload> = {
  readonly seq: number;
  readonly occurredAt: string;
  readonly origin: HostEventOrigin;
  readonly type: Type;
  readonly payload: Payload;
};

type CodexConversationEventEnvelope<Type extends string, Payload> =
  & CodexHostEventEnvelope<Type, Payload>
  & { readonly conversationId: string };

type CodexTurnEventEnvelope<Type extends string, Payload> =
  & CodexConversationEventEnvelope<Type, Payload>
  & { readonly turnId: string };

/**
 * Ordered, serializable semantic events emitted by the host after its matching
 * snapshot mutation has been applied. The union is intentionally protocol-free so
 * hosts can consume it without importing generated app-server JSON-RPC types.
 */
export type CodexHostEvent =
  | CodexHostEventEnvelope<'host.statusChanged', {
    status: HostConnectionStatus;
    error: string | null;
  }>
  | CodexHostEventEnvelope<'authentication.changed', {
    authentication: CodexHostAuthentication;
  }>
  | CodexHostEventEnvelope<'catalog.modelsChanged', {
    models: readonly ModelDescriptor[];
    status: CatalogStatus;
  }>
  | CodexHostEventEnvelope<'catalog.skillsChanged', {
    cwd: string | null;
    skills: readonly Skill[];
    status: CatalogStatus;
  }>
  | CodexHostEventEnvelope<'catalog.pluginsChanged', {
    plugins: readonly Plugin[];
    status: CatalogStatus;
  }>
  | CodexHostEventEnvelope<'catalog.permissionsChanged', {
    cwd: string | null;
    permissionProfiles: readonly PermissionProfile[];
    approvalPresets: readonly ApprovalPreset[];
  }>
  | CodexHostEventEnvelope<'rateLimits.changed', {
    rateLimits: CodexRateLimits | null;
  }>
  | CodexHostEventEnvelope<'remoteControl.statusChanged', {
    status: CodexRemoteControlConnectionStatus;
  }>
  | CodexHostEventEnvelope<'conversation.selected', {
    conversationId: string | null;
  }>
  | CodexConversationEventEnvelope<'conversation.summaryUpserted', {
    summary: CodexConversationSummary;
    reason: 'created' | 'listed' | 'resumed' | 'started' | 'updated';
  }>
  | CodexConversationEventEnvelope<'conversation.summaryRemoved', {
    reason: 'archived' | 'deleted';
  }>
  | CodexConversationEventEnvelope<'conversation.historyReplaced', {
    reason: ConversationHistoryReason;
    messages: readonly ConversationMessage[];
    threadStatus: CodexThreadStatus | null;
    /** Present on current runtimes; optional so recorded events from older SDKs remain consumable. */
    state?: CodexConversationHistoryReplacementState;
  }>
  | CodexConversationEventEnvelope<'conversation.historyPrepended', {
    messages: readonly ConversationMessage[];
    /** Present on current runtimes; optional so recorded events from older SDKs remain consumable. */
    state?: CodexConversationHistoryPrependState;
  }>
  | CodexConversationEventEnvelope<'conversation.historyStateChanged', {
    historyLoading: boolean;
    historyState: CodexConversationHistoryState;
    error: string | null;
  }>
  | CodexConversationEventEnvelope<'conversation.activityChanged', {
    threadStatus: CodexThreadStatus | null;
    busy: boolean;
    error: string | null;
  }>
  | CodexConversationEventEnvelope<'conversation.settingsChanged', {
    approvalPreset: ApprovalPreset | null;
    selectedModelId: string | null;
    selectedReasoningEffort: string | null;
    selectedServiceTier?: string | null;
    planMode: boolean;
  }>
  | CodexConversationEventEnvelope<'conversation.goalChanged', {
    goal: ThreadGoal | null;
  }> & { readonly turnId?: string }
  | CodexTurnEventEnvelope<'conversation.contextUsageChanged', {
    contextUsage: AgentContextUsage | null;
  }>
  | CodexTurnEventEnvelope<'conversation.executionUsageChanged', {
    usage: TurnExecutionUsage;
  }>
  | CodexTurnEventEnvelope<'turn.modelRerouted', {
    fromModel: string;
    toModel: string;
    reason: string;
  }>
  | CodexConversationEventEnvelope<'conversation.skillsChanged', {
    cwd: string | null;
    skills: readonly Skill[];
    status: CatalogStatus;
  }>
  | CodexConversationEventEnvelope<'conversation.permissionsChanged', {
    cwd: string | null;
    permissionProfiles: readonly PermissionProfile[];
    approvalPresets: readonly ApprovalPreset[];
  }>
  | CodexConversationEventEnvelope<'conversation.diffUpdated', {
    diff: ConversationTurnGitDiff | null;
  }>
  | CodexConversationEventEnvelope<'conversation.queueChanged', {
    queuedPrompts: readonly ConversationQueuedPrompt[];
  }>
  | CodexConversationEventEnvelope<'realtime.started', {
    realtimeSessionId: string | null;
    version: CodexRealtimeVersion;
  }>
  | CodexConversationEventEnvelope<'realtime.itemAdded', {
    item: JsonValue;
  }>
  | CodexConversationEventEnvelope<'realtime.itemStarted', {
    item: JsonValue;
  }>
  | CodexConversationEventEnvelope<'realtime.itemCompleted', {
    item: JsonValue;
  }>
  | CodexConversationEventEnvelope<'realtime.itemTranscriptDelta', {
    itemId: string;
    delta: string;
  }>
  | CodexConversationEventEnvelope<'realtime.transcriptDelta', {
    role: string;
    delta: string;
  }>
  | CodexConversationEventEnvelope<'realtime.transcriptCompleted', {
    role: string;
    text: string;
  }>
  | CodexConversationEventEnvelope<'realtime.audioDelta', {
    audio: CodexRealtimeAudioChunk;
  }>
  | CodexConversationEventEnvelope<'realtime.sdp', {
    sdp: string;
  }>
  | CodexConversationEventEnvelope<'realtime.error', {
    message: string;
  }>
  | CodexConversationEventEnvelope<'realtime.closed', {
    reason: string | null;
  }>
  | CodexTurnEventEnvelope<'turn.started', {
    startedAt: string;
  }>
  | CodexTurnEventEnvelope<'turn.completed', {
    status: TurnStatus;
    error: TurnError | null;
    willRetry: boolean;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    executionUsage?: TurnExecutionUsage | null;
  }>
  | CodexTurnEventEnvelope<'turn.error', {
    error: TurnError;
    willRetry: boolean;
  }>
  | CodexConversationEventEnvelope<'message.appended', {
    message: ConversationMessage;
  }> & { readonly turnId?: string }
  | CodexTurnEventEnvelope<'message.delta', {
    messageId: string;
    itemId: string;
    delta: string;
    phase?: ConversationMessageTextPart['phase'];
  }>
  | CodexTurnEventEnvelope<'message.updated', {
    message: ConversationMessage;
  }>
  | CodexTurnEventEnvelope<'tool.started', {
    messageId: string;
    toolPart: ConversationMessageToolPart;
  }>
  | CodexTurnEventEnvelope<'tool.updated', {
    messageId: string;
    update: ConversationMessageToolPartUpdate;
  }>
  | CodexTurnEventEnvelope<'tool.completed', {
    messageId: string;
    toolPart: ConversationMessageToolPart;
  }>
  | CodexTurnEventEnvelope<'file.activity', {
    messageId: string;
    itemId: string;
    path: string;
    action: FileActivityAction;
    status: FileActivityStatus;
  }>
  | CodexTurnEventEnvelope<'subagent.toolCallChanged', {
    lifecycle: CodexSubagentItemLifecycle;
    toolCall: CodexSubagentToolCall;
  }>
  | CodexTurnEventEnvelope<'subagent.activity', {
    lifecycle: CodexSubagentItemLifecycle;
    activity: CodexSubagentActivity;
  }>
  | CodexTurnEventEnvelope<'plan.delta', {
    itemId: string;
    delta: string;
    markdown: string;
  }>
  | CodexTurnEventEnvelope<'plan.updated', {
    explanation: string | null;
    steps: readonly ThreadPlanStep[];
    markdown: string;
    status: 'running' | 'completed';
  }>
  | CodexTurnEventEnvelope<'plan.completed', {
    itemId: string;
    markdown: string;
  }>
  | CodexTurnEventEnvelope<'context.compactionStarted', {
    itemId: string | null;
  }>
  | CodexTurnEventEnvelope<'context.compactionCompleted', {
    itemId: string | null;
    message: ConversationMessage;
  }>
  | CodexConversationEventEnvelope<'approval.requested', {
    approval: Approval;
  }> & { readonly turnId?: string }
  | CodexConversationEventEnvelope<'approval.resolved', {
    approval: Approval;
    decision: ApprovalDecision | null;
    scope: ApprovalScope | null;
    reason: 'host' | 'server' | 'conversation_closed' | 'conversation_removed' | 'host_disconnected';
  }> & { readonly turnId?: string }
  | CodexConversationEventEnvelope<'clientRequest.requested', {
    request: ClientRequest;
  }> & { readonly turnId?: string }
  | CodexConversationEventEnvelope<'clientRequest.resolved', {
    request: ClientRequest;
    response: ClientRequestResponse | null;
    reason: 'host' | 'server' | 'conversation_closed' | 'conversation_removed' | 'host_disconnected';
  }> & { readonly turnId?: string };

export type CodexConversationEvent = Extract<CodexHostEvent, { conversationId: string }>;
export type CodexRealtimeEvent = Extract<CodexConversationEvent, { type: `realtime.${string}` }>;
export type CodexSubagentEvent = Extract<CodexConversationEvent, { type: `subagent.${string}` }>;

export type ListCodexConversationsOptions = {
  archived?: boolean;
  cwd?: string | readonly string[];
  limit?: number;
  searchTerm?: string;
};

export type ListCodexModelsOptions = {
  includeHidden?: boolean;
  forceReload?: boolean;
};

export type ListCodexSkillsOptions = {
  cwd?: string;
  forceReload?: boolean;
};

export type CodexPermissionMode = 'read-only' | 'workspace-write' | 'full-access';
export type CodexApprovalMode = 'ask' | 'never';

export type CreateCodexConversationOptions = {
  approvalPreset?: ApprovalPreset;
  approvalMode?: CodexApprovalMode;
  baseInstructions?: string;
  config?: Readonly<Record<string, JsonValue>>;
  cwd?: string;
  developerInstructions?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  permissionMode?: CodexPermissionMode;
  threadSource?: string;
};

export type CreateCodexClientConversationOptions = Pick<
  CreateCodexConversationOptions,
  'approvalPreset' | 'model' | 'reasoningEffort' | 'serviceTier'
>;

export type CodexReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string | null }
  | { type: 'custom'; instructions: string };

export type StartCodexReviewOptions = {
  target?: CodexReviewTarget;
};

export type CodexHostApi = {
  readRateLimits?(options?: ReadCodexRateLimitsOptions): Promise<CodexRateLimits>;
  readAccountUsage?(): Promise<CodexAccountUsage>;
  consumeRateLimitResetCredit?(options: ConsumeCodexRateLimitResetCreditOptions): Promise<CodexRateLimitResetCreditResult>;
  startLiveChat?(conversationId: string, options: StartCodexLiveChatOptions): Promise<{ sdp: string }>;
  stopLiveChat?(conversationId: string): Promise<void>;
  connect(): Promise<CodexHostSnapshot>;
  refreshAccount(): Promise<CodexHostSnapshot>;
  startChatGptLogin(): Promise<CodexChatGptLogin>;
  startChatGptDeviceCodeLogin(): Promise<CodexChatGptDeviceCodeLogin>;
  cancelLogin(loginId?: string): Promise<CodexHostSnapshot>;
  logout(): Promise<CodexHostSnapshot>;
  clearGoal(): Promise<CodexHostSnapshot>;
  refreshConversations(): Promise<CodexHostSnapshot>;
  listConversations(options?: ListCodexConversationsOptions): Promise<CodexConversationSummary[]>;
  listModels(options?: ListCodexModelsOptions): Promise<ModelDescriptor[]>;
  listSkills?(options?: ListCodexSkillsOptions): Promise<Skill[]>;
  createConversation(options?: CreateCodexConversationOptions): Promise<CodexHostSnapshot>;
  archiveConversation(conversationId: string): Promise<CodexHostSnapshot>;
  deleteConversation(conversationId: string): Promise<CodexHostSnapshot>;
  unarchiveConversation(conversationId: string): Promise<CodexHostSnapshot>;
  selectConversation(conversationId: string): Promise<CodexHostSnapshot>;
  readConversationHistory(conversationId?: string): Promise<CodexConversationHistory>;
  readConversationPromptHistory(conversationId?: string): Promise<CodexConversationPromptHistory>;
  loadOlderConversationHistory?(conversationId?: string): Promise<CodexConversationHistoryPage>;
  loadTurnHistory?(turnId: string, conversationId?: string): Promise<CodexConversationSnapshot>;
  renameConversation(title: string): Promise<CodexHostSnapshot>;
  updateConversationSettings(settings: UpdateConversationSettings): Promise<CodexHostSnapshot>;
  sendMessage(prompt: string, options?: SendMessageOptions): Promise<CodexHostSnapshot>;
  continueInterruptedTurn(): Promise<CodexHostSnapshot>;
  compactConversation(): Promise<CodexHostSnapshot>;
  startReview(options?: StartCodexReviewOptions): Promise<CodexHostSnapshot>;
  steerMessage(prompt: string, options?: SendMessageOptions): Promise<CodexHostSnapshot>;
  interrupt(): Promise<CodexHostSnapshot>;
  deleteTurn(turnId: string): Promise<CodexHostSnapshot>;
  editTurn(turnId: string, content: string, options?: SendMessageOptions): Promise<CodexHostSnapshot>;
  forkTurn(turnId: string): Promise<CodexHostSnapshot>;
  retryTurn(turnId: string): Promise<CodexHostSnapshot>;
  deleteQueuedPrompt(promptId: string): Promise<CodexHostSnapshot>;
  updateQueuedPrompt(promptId: string, prompt: string, options?: SendMessageOptions): Promise<CodexHostSnapshot>;
  steerQueuedPrompt(promptId: string, prompt?: string, options?: SendMessageOptions): Promise<CodexHostSnapshot>;
  respondToClientRequest(response: ClientRequestResponse): Promise<CodexHostSnapshot>;
  resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
  ): Promise<CodexHostSnapshot>;
  setGoal(objective: string, tokenBudget?: number | null): Promise<CodexHostSnapshot>;
  getSnapshot(): Promise<CodexHostSnapshot>;
  onStateChange(listener: (snapshot: CodexHostSnapshot) => void): () => void;
  onEvent(listener: (event: CodexHostEvent) => void): () => void;
  /**
   * Optional incremental state stream: one versioned snapshot followed by
   * structural patches that carry only changed values and list items.
   * `getVersionedSnapshot` resolves null when patches are unavailable.
   * Prefer `subscribeCodexHostState`, which falls back to `onStateChange`.
   */
  getVersionedSnapshot?(): Promise<CodexVersionedHostSnapshot | null>;
  onStatePatch?(listener: (patch: CodexHostStatePatch) => void): () => void;
};

/** A snapshot paired with the state version that the next patch continues from. */
export type CodexVersionedHostSnapshot = {
  version: number;
  snapshot: CodexHostSnapshot;
};

/**
 * One top-level snapshot change. `list` updates an array of `{ id }` items:
 * `ids` is the complete new order and `items` holds only new or changed items,
 * so unchanged items keep their identity on the receiving side.
 */
export type CodexHostStateChange =
  | { type: 'set'; key: keyof CodexHostSnapshot; value: unknown }
  | { type: 'delete'; key: keyof CodexHostSnapshot }
  | { type: 'list'; key: keyof CodexHostSnapshot; ids: string[]; items: Array<{ id: string }> };

/** Changes that turn state `version - 1` into state `version`. */
export type CodexHostStatePatch = {
  version: number;
  changes: CodexHostStateChange[];
};

export type CodexHostClientApi = Omit<
  CodexHostApi,
  'createConversation' | 'sendMessage' | 'steerMessage' | 'updateQueuedPrompt' | 'steerQueuedPrompt' | 'editTurn'
> & {
  editTurn(turnId: string, content: string, options?: ClientSendMessageOptions): Promise<CodexHostSnapshot>;
  updateQueuedPrompt(promptId: string, prompt: string, options?: ClientSendMessageOptions): Promise<CodexHostSnapshot>;
  steerQueuedPrompt(promptId: string, prompt?: string, options?: ClientSendMessageOptions): Promise<CodexHostSnapshot>;
  createConversation(options?: CreateCodexClientConversationOptions): Promise<CodexHostSnapshot>;
  sendMessage(prompt: string, options?: ClientSendMessageOptions): Promise<CodexHostSnapshot>;
  steerMessage(prompt: string, options?: ClientSendMessageOptions): Promise<CodexHostSnapshot>;
};
