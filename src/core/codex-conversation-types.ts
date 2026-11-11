import type { EventOrigin, RuntimeConnectionStatus } from '../contracts/provider';
import type { CatalogStatus, ModelDescriptor, Skill, Plugin, PermissionProfile, ApprovalPreset, ConversationMessage, ClientRequest, Approval, ConversationMessageTextPart, ConversationMessageToolPart, ConversationMessageToolPartUpdate, ApprovalDecision, ApprovalScope, ClientRequestResponse, ConversationQueuedPrompt } from './codex-client-contracts';
import type { ConversationHistoryReason, ConversationExecutionPlan, AgentContextUsage, ThreadGoal, ConversationTurnGitDiff, FileActivityAction, FileActivityStatus, ThreadPlanStep } from '../contracts/conversation';
import type { Turn, TurnExecutionUsage, JsonValue, TurnStatus, TurnError, SafetyFindings } from '../contracts/turn';

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

export type CodexAccountState =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string; workspaceName?: string }
  | { type: 'gcp' }
  | { type: 'amazonBedrock'; credentialSource: 'codexManaged' | 'awsManaged' };

export type CodexLoginStatus =
  | 'idle'
  | 'starting'
  | 'pending'
  | 'completed'
  | 'cancelled'
  | 'error';

export type CodexLoginState = {
  status: CodexLoginStatus;
  loginId: string | null;
  authUrl: string | null;
  error: string | null;
};

/**
 * Protocol-free projection of `account/read` plus the active managed login.
 * `requiresOpenaiAuth` deliberately preserves the app-server field; signed-out
 * hosts should check for a loaded `account === null && requiresOpenaiAuth`.
 */
export type CodexAuthenticationState = {
  status: CatalogStatus;
  account: CodexAccountState | null;
  requiresOpenaiAuth: boolean | null;
  error: string | null;
  login: CodexLoginState;
};

export type CodexSnapshot = {
  status: RuntimeConnectionStatus;
  authentication: CodexAuthenticationState;
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

export type CodexConversationSnapshot = CodexSnapshot & {
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

export type CodexRealtimeChannel =
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
  transport?: CodexRealtimeChannel;
};

export type CodexEventEnvelope<Type extends string, Payload> = {
  readonly seq: number;
  readonly occurredAt: string;
  readonly origin: EventOrigin;
  readonly type: Type;
  readonly payload: Payload;
};

export type CodexConversationEventEnvelope<Type extends string, Payload> =
  & CodexEventEnvelope<Type, Payload>
  & { readonly conversationId: string };

export type CodexTurnEventEnvelope<Type extends string, Payload> =
  & CodexConversationEventEnvelope<Type, Payload>
  & { readonly turnId: string };

/**
 * Ordered, serializable semantic events emitted by the host after its matching
 * snapshot mutation has been applied. The union is intentionally protocol-free so
 * hosts can consume it without importing generated app-server JSON-RPC types.
 */
export type CodexEvent =
  | CodexEventEnvelope<'host.statusChanged', {
    status: RuntimeConnectionStatus;
    error: string | null;
  }>
  | CodexEventEnvelope<'authentication.changed', {
    authentication: CodexAuthenticationState;
  }>
  | CodexEventEnvelope<'catalog.modelsChanged', {
    models: readonly ModelDescriptor[];
    status: CatalogStatus;
  }>
  | CodexEventEnvelope<'catalog.skillsChanged', {
    cwd: string | null;
    skills: readonly Skill[];
    status: CatalogStatus;
  }>
  | CodexEventEnvelope<'catalog.pluginsChanged', {
    plugins: readonly Plugin[];
    status: CatalogStatus;
  }>
  | CodexEventEnvelope<'catalog.permissionsChanged', {
    cwd: string | null;
    permissionProfiles: readonly PermissionProfile[];
    approvalPresets: readonly ApprovalPreset[];
  }>
  | CodexEventEnvelope<'rateLimits.changed', {
    rateLimits: CodexRateLimits | null;
  }>
  | CodexEventEnvelope<'remoteControl.statusChanged', {
    status: CodexRemoteControlConnectionStatus;
  }>
  | CodexEventEnvelope<'conversation.selected', {
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

export type CodexConversationEvent = Extract<CodexEvent, { conversationId: string }>;

export type CodexRealtimeEvent = Extract<CodexConversationEvent, { type: `realtime.${string}` }>;

