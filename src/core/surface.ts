export { normalizePromptContent, promptContentText, promptContentDispatchText, trimPromptContent, slicePromptContent, replacePromptContentRange } from './prompt-content';
export type { CodexPromptMention, CodexPromptPart } from './prompt-content';
import type { CodexPromptPart } from './prompt-content';

export type SurfaceMessageTextPart = {
  type: 'text';
  text: string;
  itemId?: string;
  phase?: 'commentary' | 'partial_answer' | 'final_answer';
};

export type SurfaceMessageReasoningPart = {
  type: 'reasoning';
  summary: string;
  itemId: string;
  summaryIndex: number;
};

export type SurfaceMessageStatusPart = {
  type: 'status';
  text: string;
};

export type CodexSurfaceAskUserQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: readonly {
    label: string;
    description: string;
  }[] | null;
};

export type SurfaceMessageQuestionPart = {
  type: 'question';
  /** Replayed transcript content, not a live request to answer. */
  historical?: boolean;
  request: Extract<CodexSurfaceClientRequest, { kind: 'ask_user' }>;
};

export type SurfaceMessageAttachment = {
  /** Intrinsic display dimensions, available before lazy image bytes load. */
  width?: number;
  height?: number;
  kind: 'file' | 'image';
  name: string;
  path?: string;
  url?: string;
  mimeType?: string;
};

export type SurfaceMessageAttachmentPart = {
  type: 'attachment';
  attachment: SurfaceMessageAttachment;
};

export type SurfaceMessageMedia = {
  /** Intrinsic display dimensions, available before lazy image bytes load. */
  width?: number;
  height?: number;
  url: string;
  alt?: string;
  mimeType?: string;
  prompt?: string;
  title?: string;
};

export type SurfaceMessageMediaPart = {
  type: 'media';
  /** Tool observations belong to Working; final-answer media stays visible. */
  phase?: SurfaceMessageTextPart['phase'];
  media: SurfaceMessageMedia;
  itemId?: string;
};

export type SurfaceMessageToolPart = {
  type: 'tool';
  id: string;
  title: string;
  kind?: string;
  status: 'running' | 'completed' | 'failed';
  statusText?: string;
  body?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
};

export type SurfaceMessageToolPartUpdate = {
  itemId: string;
  title?: string;
  status?: SurfaceMessageToolPart['status'];
  statusText?: string | null;
  body?: string;
  bodyDelta?: string;
  bodyAppend?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  fallbackToolPart?: SurfaceMessageToolPart;
};

export type SurfaceMessagePart =
  | SurfaceMessageAttachmentPart
  | SurfaceMessageMediaPart
  | SurfaceMessageQuestionPart
  | SurfaceMessageReasoningPart
  | SurfaceMessageTextPart
  | SurfaceMessageStatusPart
  | SurfaceMessageToolPart;

export type SurfaceMessage = {
  id: string;
  kind?: 'compaction' | 'steer';
  role: 'user' | 'assistant' | 'system';
  status: 'complete' | 'streaming' | 'error';
  parts: readonly SurfaceMessagePart[];
  createdAt?: string;
  turnId?: string;
  metadata?: Record<string, unknown>;
};

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

export type CodexSurfaceApproval = {
  id: string;
  kind: 'command' | 'file-change' | 'permissions';
  conversationId: string;
  turnId?: string;
  itemId: string;
  title: string;
  description?: string;
  command?: string;
  cwd?: string;
  requestedPermissions?: readonly CodexSurfaceRequestedPermission[];
  allowedScopes?: readonly CodexSurfaceApprovalScope[];
  canDeny?: boolean;
  /** Requires a fresh human decision; never satisfy this through automatic or remembered approval. */
  requiresHumanApproval?: boolean;
};

export type CodexSurfaceRequestedPermission =
  | {
    kind: 'filesystem';
    access: 'read' | 'write' | 'deny';
    path: string;
  }
  | {
    kind: 'network';
    enabled: boolean;
    host?: string;
    protocol?: string;
  };

export type CodexSurfaceApprovalDecision = 'approve' | 'deny';
export type CodexSurfaceApprovalScope = 'once' | 'session';
export type CodexSurfaceApprovalPreset = 'ask-for-approval' | 'approve-for-me' | 'full-access';

export type CodexSurfaceAskUserAnswers = Record<string, { answers: string[] }>;
export type CodexSurfaceToolConfirmationDecision = 'allow' | 'allow_conversation' | 'always_allow' | 'deny';
export type CodexSurfaceClientRequestResponse = {
  id: string;
  payload?: {
    answers?: CodexSurfaceAskUserAnswers;
    cancelled?: boolean;
    decision?: CodexSurfaceToolConfirmationDecision | null;
  };
};

export type CodexSurfaceClientRequest =
  | {
    id: string;
    kind: 'confirm_tool';
    conversationId: string;
    turnId: string | null;
    itemId: string;
    payload: {
      confirmation: {
        argumentsPreview: string;
        integrationId: string;
        integrationName: string;
        summary: string;
        toolName: string;
        allowConversation?: boolean;
        allowAlways?: boolean;
      };
    };
  }
  | {
    id: string;
    kind: 'ask_user';
    conversationId: string;
    turnId: string;
    itemId: string;
    payload: {
      request: {
        itemId: string;
        delivery: 'tool' | 'async';
        blocking: boolean;
        questions: readonly CodexSurfaceAskUserQuestion[];
        autoResolutionMs?: number;
      };
    };
  };

export type CodexSurfaceQueuedPrompt = {
  id: string;
  text: string;
  options?: SendCodexMessageOptions;
};

export type CodexSurfaceCatalogStatus = 'notLoaded' | 'loading' | 'loaded' | 'error';

export type CodexSurfaceReasoningEffortOption = {
  reasoningEffort: string;
  description: string;
};

export type CodexSurfaceServiceTier = {
  id: string;
  name: string;
  description: string;
};

export type CodexSurfaceModel = {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: CodexSurfaceReasoningEffortOption[];
  defaultReasoningEffort?: string | null;
  serviceTiers?: CodexSurfaceServiceTier[];
  defaultServiceTier?: string | null;
  isDefault?: boolean;
  providerMetadata?: Record<string, unknown>;
};

/** Current connection from app-server to Codex remote control. */
export type CodexSurfaceRemoteControlStatus = {
  status: 'disabled' | 'connecting' | 'connected' | 'errored';
  serverName: string;
  installationId: string;
  environmentId: string | null;
};

export type CodexSurfaceSkill = {
  name: string;
  description?: string;
  shortDescription?: string;
  displayName?: string;
  /** Bounded image data URL; no local paths exposed. */
  iconSmall?: string;
  /** Bounded image data URL; no local paths exposed. */
  iconLarge?: string;
  brandColor?: string;
  defaultPrompt?: string;
  path: string;
  scope?: string;
  enabled: boolean;
};

export type CodexSurfacePlugin = {
  /** Canonical app-server plugin id, suitable for matching `plugin://` mentions exactly. */
  id: string;
  name: string;
  displayName: string;
  shortDescription?: string;
  longDescription?: string;
  brandColor?: string;
  /** Remote URL or bounded image data URL; no local paths exposed. */
  iconUrl?: string;
  /** Dark-mode icon with the same guarantees as `iconUrl`. */
  iconUrlDark?: string;
  enabled: boolean;
};

export type CodexSurfacePermissionProfile = {
  id: string;
  description: string | null;
  allowed: boolean;
};

export type CodexSurfaceContextUsage = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  lastTotalTokens: number;
  modelContextWindow: number | null;
  usedPercent: number | null;
};

/** Provider counts: cached input is part of input, and reasoning is part of output. */
export type CodexSurfaceTokenUsage = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** Null when absent. Its relationship to input is not guaranteed by app-server. */
  cacheWriteInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
};

/** Fields lacking public, request-attributable evidence in the supported app-server protocol. */
export type CodexSurfaceRequestUsageField =
  | 'requestIdentity' | 'timestamp' | 'actualModel' | 'actualProvider' | 'requestTokenUsage'
  | 'cacheWriteLifetimes' | 'cacheWriteInputInclusion' | 'pricingContext'
  | 'requestedModel' | 'requestedServiceTier' | 'reportedServiceTier' | 'finality';

/**
 * Public app-server counters cannot establish independently billable requests.
 * Null requests means unknown coverage, never an empty list or zero consumption.
 */
export type CodexSurfaceRequestUsage = {
  status: 'unavailable';
  reason: 'public-runtime-request-evidence-unavailable';
  unavailableFields: readonly CodexSurfaceRequestUsageField[];
  requests: null;
};

export type CodexSurfaceExecutionUsage = {
  /** This surface instance observed the turn start, rather than only its replayed counters. */
  observedStart: boolean;
  /** Latest provider counters; no stable request identity or finality is supplied. */
  last: CodexSurfaceTokenUsage;
  /** Provider thread counters; may be replayed or reset. */
  total: CodexSurfaceTokenUsage;
  /** Cumulative replacement since an observed start with a known baseline. */
  execution: CodexSurfaceTokenUsage | null;
  /** Unknown unless the provider supplies authoritative whole-execution evidence. */
  model: string | null;
  /** Request-pricing capability. Absent on older SDK projections means unknown support. */
  requestUsage?: CodexSurfaceRequestUsage;
};

export type CodexSurfaceGoal = {
  threadId: string;
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type CodexSurfaceTurnGitDiff = {
  turnId: string;
  addedLines: number;
  removedLines: number;
  diff?: string;
  updatedAt: string;
};

export type CodexSurfaceThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | {
    type: 'active';
    activeFlags: Array<'waitingOnApproval' | 'waitingOnUserInput'>;
  };

export type CodexSurfaceRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CodexSurfaceRateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: CodexSurfaceRateLimitWindow | null;
  secondary: CodexSurfaceRateLimitWindow | null;
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

export type CodexSurfaceAccountUsage = {
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
export type CodexSurfaceRateLimitResetCreditResult = {
  outcome: 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit';
};

export type CodexSurfaceRateLimits = {
  rateLimits: CodexSurfaceRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, CodexSurfaceRateLimitSnapshot> | null;
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

export type CodexSurfaceStatus = 'idle' | 'connecting' | 'ready' | 'error';

/** Controls whether a conversation loads its complete history up front. */
export type CodexConversationLoadingStrategy = 'eager' | 'lazy';

/** Controls whether the conversation view mounts all supplied messages. */
export type CodexConversationRenderStrategy = 'eager' | 'lazy';

export type CodexConversationHistoryState = {
  /** Missing means full detail; individual turns may already have richer cached content. */
  itemsView?: 'full' | 'summary';
  loadingStrategy: CodexConversationLoadingStrategy;
  hasOlder: boolean;
  loadingOlder: boolean;
  fullyLoaded: boolean;
};

export type CodexSurfaceAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string; workspaceName?: string }
  | { type: 'gcp' }
  | { type: 'amazonBedrock'; credentialSource: 'codexManaged' | 'awsManaged' };

export type CodexSurfaceLoginStatus =
  | 'idle'
  | 'starting'
  | 'pending'
  | 'completed'
  | 'cancelled'
  | 'error';

export type CodexSurfaceLoginState = {
  status: CodexSurfaceLoginStatus;
  loginId: string | null;
  authUrl: string | null;
  error: string | null;
};

/**
 * Protocol-free projection of `account/read` plus the active managed login.
 * `requiresOpenaiAuth` deliberately preserves the app-server field; signed-out
 * hosts should check for a loaded `account === null && requiresOpenaiAuth`.
 */
export type CodexSurfaceAuthentication = {
  status: CodexSurfaceCatalogStatus;
  account: CodexSurfaceAccount | null;
  requiresOpenaiAuth: boolean | null;
  error: string | null;
  login: CodexSurfaceLoginState;
};

export type CodexSurfaceChatGptLogin = {
  loginId: string;
  authUrl: string;
};

export type CodexSurfaceChatGptDeviceCodeLogin = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

export type CodexSurfaceSnapshot = {
  status: CodexSurfaceStatus;
  authentication: CodexSurfaceAuthentication;
  conversations: CodexConversationSummary[];
  activeConversationId: string | null;
  activeTurnId: string | null;
  turns: CodexSurfaceTurn[];
  messages: SurfaceMessage[];
  clientRequests: CodexSurfaceClientRequest[];
  answeredClientRequestIds: string[];
  approvals: CodexSurfaceApproval[];
  models: CodexSurfaceModel[];
  modelCatalogStatus: CodexSurfaceCatalogStatus;
  skills: CodexSurfaceSkill[];
  skillCatalogStatus: CodexSurfaceCatalogStatus;
  plugins: CodexSurfacePlugin[];
  pluginCatalogStatus: CodexSurfaceCatalogStatus;
  permissionProfiles: CodexSurfacePermissionProfile[];
  approvalPresets: CodexSurfaceApprovalPreset[];
  approvalPreset: CodexSurfaceApprovalPreset | null;
  selectedModelId: string | null;
  selectedReasoningEffort: string | null;
  /** Selected app-server service tier. Optional for backwards-compatible snapshots. */
  selectedServiceTier?: string | null;
  planMode: boolean;
  /** Latest structured execution plan. Optional for backwards-compatible snapshots. */
  executionPlan?: CodexSurfaceExecutionPlan | null;
  contextUsage: CodexSurfaceContextUsage | null;
  goal: CodexSurfaceGoal | null;
  turnGitDiff: CodexSurfaceTurnGitDiff | null;
  threadStatus: CodexSurfaceThreadStatus | null;
  rateLimits: CodexSurfaceRateLimits | null;
  queuedPrompts: CodexSurfaceQueuedPrompt[];
  busy: boolean;
  historyLoading: boolean;
  historyState?: CodexConversationHistoryState;
  error: string | null;
};

export type CodexConversationSnapshot = CodexSurfaceSnapshot & {
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
  messages: SurfaceMessage[];
  threadStatus: CodexSurfaceThreadStatus | null;
};

export type CodexConversationHistoryPage = {
  conversationId: string;
  messages: SurfaceMessage[];
  hasOlder: boolean;
};

/** A bounded, chronological list of user prompts for composer recall. */
export type CodexConversationPromptHistory = {
  conversationId: string;
  prompts: string[];
};

export type CodexSurfaceEventOrigin = 'action' | 'notification' | 'lifecycle';
export type CodexSurfaceHistoryReason = 'fork' | 'load' | 'resume' | 'rollback' | 'resync' | 'details' | 'images';
export type CodexSurfaceTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export type CodexSurfaceFileActivityAction = 'read' | 'edit' | 'create';
export type CodexSurfaceFileActivityStatus = 'running' | 'completed' | 'failed';
export type CodexSurfacePlanStepStatus = 'pending' | 'inProgress' | 'completed';
export type CodexSurfacePlanStep = {
  step: string;
  status: CodexSurfacePlanStepStatus;
};
export type CodexSurfaceExecutionPlan = {
  turnId: string;
  explanation: string | null;
  steps: readonly CodexSurfacePlanStep[];
  markdown: string;
  updatedAt: string;
};
export type CodexSurfaceSubagentItemLifecycle = 'started' | 'completed';
export type CodexSurfaceSubagentTool =
  | 'spawnAgent'
  | 'sendInput'
  | 'resumeAgent'
  | 'wait'
  | 'closeAgent'
  | 'sendMessage'
  | 'followupTask'
  | 'interruptAgent'
  | 'listAgents';
export type CodexSurfaceSubagentToolCallStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted';
export type CodexSurfaceSubagentStatus =
  | 'pendingInit'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'notFound';
export type CodexSurfaceSubagentState = {
  status: CodexSurfaceSubagentStatus;
  message: string | null;
};
export type CodexSurfaceSubagentToolCall = {
  id: string;
  tool: CodexSurfaceSubagentTool;
  status: CodexSurfaceSubagentToolCallStatus;
  senderConversationId: string;
  receiverConversationIds: readonly string[];
  prompt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agentStates: Readonly<Record<string, CodexSurfaceSubagentState>>;
};
export type CodexSurfaceSubagentActivity = {
  id: string;
  kind: 'started' | 'interacted' | 'interrupted' | 'completed';
  agentConversationId: string;
  agentPath: string;
};
/** Provider-authored findings; continuation requires an explanation, instruction and user confirmation. */
export type CodexSurfaceMisalignmentErrorDetails = {
  errorType: string | null;
  detailedExplanation: string | null;
  steer: { message: string } | null;
  /** Opaque provider target; its presence alone does not permit continuation. */
  reviewTarget?: string | null;
};

/** Explicit user review of the exact findings supplied by the provider. */
export type ContinueCodexSafetyReviewOptions = {
  turnId: string;
  findings: CodexSurfaceMisalignmentErrorDetails;
};

export type CodexSurfaceTurnError = {
  /** Absent when no provider findings were supplied. */
  misalignment?: CodexSurfaceMisalignmentErrorDetails;
  message: string;
  additionalDetails: string | null;
  codexErrorInfo: CodexSurfaceJsonValue | null;
};
export type CodexSurfaceTurn = {
  id: string;
  /** Missing on older/full snapshots. Summary turns can fetch details on expansion. */
  itemsView?: 'full' | 'summary';
  detailsLoading?: boolean;
  detailsError?: string | null;
  status: CodexSurfaceTurnStatus;
  error: CodexSurfaceTurnError | null;
  willRetry: boolean;
  /** Provider start time, or the observed live start when the provider omits it. */
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  executionUsage?: CodexSurfaceExecutionUsage | null;
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

type CodexSurfaceEventEnvelope<Type extends string, Payload> = {
  readonly seq: number;
  readonly occurredAt: string;
  readonly origin: CodexSurfaceEventOrigin;
  readonly type: Type;
  readonly payload: Payload;
};

type CodexConversationEventEnvelope<Type extends string, Payload> =
  & CodexSurfaceEventEnvelope<Type, Payload>
  & { readonly conversationId: string };

type CodexTurnEventEnvelope<Type extends string, Payload> =
  & CodexConversationEventEnvelope<Type, Payload>
  & { readonly turnId: string };

/**
 * Ordered, serializable semantic events emitted by the surface after its matching
 * snapshot mutation has been applied. The union is intentionally protocol-free so
 * hosts can consume it without importing generated app-server JSON-RPC types.
 */
export type CodexSurfaceEvent =
  | CodexSurfaceEventEnvelope<'surface.statusChanged', {
    status: CodexSurfaceStatus;
    error: string | null;
  }>
  | CodexSurfaceEventEnvelope<'authentication.changed', {
    authentication: CodexSurfaceAuthentication;
  }>
  | CodexSurfaceEventEnvelope<'catalog.modelsChanged', {
    models: readonly CodexSurfaceModel[];
    status: CodexSurfaceCatalogStatus;
  }>
  | CodexSurfaceEventEnvelope<'catalog.skillsChanged', {
    cwd: string | null;
    skills: readonly CodexSurfaceSkill[];
    status: CodexSurfaceCatalogStatus;
  }>
  | CodexSurfaceEventEnvelope<'catalog.pluginsChanged', {
    plugins: readonly CodexSurfacePlugin[];
    status: CodexSurfaceCatalogStatus;
  }>
  | CodexSurfaceEventEnvelope<'catalog.permissionsChanged', {
    cwd: string | null;
    permissionProfiles: readonly CodexSurfacePermissionProfile[];
    approvalPresets: readonly CodexSurfaceApprovalPreset[];
  }>
  | CodexSurfaceEventEnvelope<'rateLimits.changed', {
    rateLimits: CodexSurfaceRateLimits | null;
  }>
  | CodexSurfaceEventEnvelope<'remoteControl.statusChanged', {
    status: CodexSurfaceRemoteControlStatus;
  }>
  | CodexSurfaceEventEnvelope<'conversation.selected', {
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
    reason: CodexSurfaceHistoryReason;
    messages: readonly SurfaceMessage[];
    threadStatus: CodexSurfaceThreadStatus | null;
    /** Present on current runtimes; optional so recorded events from older SDKs remain consumable. */
    state?: CodexConversationHistoryReplacementState;
  }>
  | CodexConversationEventEnvelope<'conversation.historyPrepended', {
    messages: readonly SurfaceMessage[];
    /** Present on current runtimes; optional so recorded events from older SDKs remain consumable. */
    state?: CodexConversationHistoryPrependState;
  }>
  | CodexConversationEventEnvelope<'conversation.historyStateChanged', {
    historyLoading: boolean;
    historyState: CodexConversationHistoryState;
    error: string | null;
  }>
  | CodexConversationEventEnvelope<'conversation.activityChanged', {
    threadStatus: CodexSurfaceThreadStatus | null;
    busy: boolean;
    error: string | null;
  }>
  | CodexConversationEventEnvelope<'conversation.settingsChanged', {
    approvalPreset: CodexSurfaceApprovalPreset | null;
    selectedModelId: string | null;
    selectedReasoningEffort: string | null;
    selectedServiceTier?: string | null;
    planMode: boolean;
  }>
  | CodexConversationEventEnvelope<'conversation.goalChanged', {
    goal: CodexSurfaceGoal | null;
  }> & { readonly turnId?: string }
  | CodexTurnEventEnvelope<'conversation.contextUsageChanged', {
    contextUsage: CodexSurfaceContextUsage | null;
  }>
  | CodexTurnEventEnvelope<'conversation.executionUsageChanged', {
    usage: CodexSurfaceExecutionUsage;
  }>
  | CodexTurnEventEnvelope<'turn.modelRerouted', {
    fromModel: string;
    toModel: string;
    reason: string;
  }>
  | CodexConversationEventEnvelope<'conversation.skillsChanged', {
    cwd: string | null;
    skills: readonly CodexSurfaceSkill[];
    status: CodexSurfaceCatalogStatus;
  }>
  | CodexConversationEventEnvelope<'conversation.permissionsChanged', {
    cwd: string | null;
    permissionProfiles: readonly CodexSurfacePermissionProfile[];
    approvalPresets: readonly CodexSurfaceApprovalPreset[];
  }>
  | CodexConversationEventEnvelope<'conversation.diffUpdated', {
    diff: CodexSurfaceTurnGitDiff | null;
  }>
  | CodexConversationEventEnvelope<'conversation.queueChanged', {
    queuedPrompts: readonly CodexSurfaceQueuedPrompt[];
  }>
  | CodexConversationEventEnvelope<'realtime.started', {
    realtimeSessionId: string | null;
    version: CodexRealtimeVersion;
  }>
  | CodexConversationEventEnvelope<'realtime.itemAdded', {
    item: CodexSurfaceJsonValue;
  }>
  | CodexConversationEventEnvelope<'realtime.itemStarted', {
    item: CodexSurfaceJsonValue;
  }>
  | CodexConversationEventEnvelope<'realtime.itemCompleted', {
    item: CodexSurfaceJsonValue;
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
    status: CodexSurfaceTurnStatus;
    error: CodexSurfaceTurnError | null;
    willRetry: boolean;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    executionUsage?: CodexSurfaceExecutionUsage | null;
  }>
  | CodexTurnEventEnvelope<'turn.error', {
    error: CodexSurfaceTurnError;
    willRetry: boolean;
  }>
  | CodexConversationEventEnvelope<'message.appended', {
    message: SurfaceMessage;
  }> & { readonly turnId?: string }
  | CodexTurnEventEnvelope<'message.delta', {
    messageId: string;
    itemId: string;
    delta: string;
    phase?: SurfaceMessageTextPart['phase'];
  }>
  | CodexTurnEventEnvelope<'message.updated', {
    message: SurfaceMessage;
  }>
  | CodexTurnEventEnvelope<'tool.started', {
    messageId: string;
    toolPart: SurfaceMessageToolPart;
  }>
  | CodexTurnEventEnvelope<'tool.updated', {
    messageId: string;
    update: SurfaceMessageToolPartUpdate;
  }>
  | CodexTurnEventEnvelope<'tool.completed', {
    messageId: string;
    toolPart: SurfaceMessageToolPart;
  }>
  | CodexTurnEventEnvelope<'file.activity', {
    messageId: string;
    itemId: string;
    path: string;
    action: CodexSurfaceFileActivityAction;
    status: CodexSurfaceFileActivityStatus;
  }>
  | CodexTurnEventEnvelope<'subagent.toolCallChanged', {
    lifecycle: CodexSurfaceSubagentItemLifecycle;
    toolCall: CodexSurfaceSubagentToolCall;
  }>
  | CodexTurnEventEnvelope<'subagent.activity', {
    lifecycle: CodexSurfaceSubagentItemLifecycle;
    activity: CodexSurfaceSubagentActivity;
  }>
  | CodexTurnEventEnvelope<'plan.delta', {
    itemId: string;
    delta: string;
    markdown: string;
  }>
  | CodexTurnEventEnvelope<'plan.updated', {
    explanation: string | null;
    steps: readonly CodexSurfacePlanStep[];
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
    message: SurfaceMessage;
  }>
  | CodexConversationEventEnvelope<'approval.requested', {
    approval: CodexSurfaceApproval;
  }> & { readonly turnId?: string }
  | CodexConversationEventEnvelope<'approval.resolved', {
    approval: CodexSurfaceApproval;
    decision: CodexSurfaceApprovalDecision | null;
    scope: CodexSurfaceApprovalScope | null;
    reason: 'host' | 'server' | 'conversation_closed' | 'conversation_removed' | 'surface_disconnected';
  }> & { readonly turnId?: string }
  | CodexConversationEventEnvelope<'clientRequest.requested', {
    request: CodexSurfaceClientRequest;
  }> & { readonly turnId?: string }
  | CodexConversationEventEnvelope<'clientRequest.resolved', {
    request: CodexSurfaceClientRequest;
    response: CodexSurfaceClientRequestResponse | null;
    reason: 'host' | 'server' | 'conversation_closed' | 'conversation_removed' | 'surface_disconnected';
  }> & { readonly turnId?: string };

export type CodexConversationEvent = Extract<CodexSurfaceEvent, { conversationId: string }>;
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

export type CodexSurfacePermissionMode = 'read-only' | 'workspace-write' | 'full-access';
export type CodexSurfaceApprovalMode = 'ask' | 'never';

export type CreateCodexConversationOptions = {
  approvalPreset?: CodexSurfaceApprovalPreset;
  approvalMode?: CodexSurfaceApprovalMode;
  baseInstructions?: string;
  config?: Readonly<Record<string, CodexSurfaceJsonValue>>;
  cwd?: string;
  developerInstructions?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  permissionMode?: CodexSurfacePermissionMode;
  threadSource?: string;
};

export type CreateCodexClientConversationOptions = Pick<
  CreateCodexConversationOptions,
  'approvalPreset' | 'model' | 'reasoningEffort' | 'serviceTier'
>;

export type SendCodexMessageOptions = {
  content?: readonly CodexPromptPart[];
  attachments?: readonly CodexSurfaceAttachment[];
  inputMethod?: 'typed' | 'dictated';
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  planMode?: boolean;
  skills?: readonly CodexSurfaceSkillInput[];
  outputSchema?: CodexSurfaceJsonValue;
};

export type CodexClientAttachment =
  | {
    type: 'image';
    reference: string;
    detail?: 'auto' | 'low' | 'high' | 'original';
  }
  | {
    type: 'file';
    reference: string;
  };

export type CodexClientSendMessageOptions = Omit<SendCodexMessageOptions, 'attachments'> & {
  attachments?: readonly CodexClientAttachment[];
};

export type CodexSurfaceAttachment =
  | {
    type: 'image';
    path: string;
    detail?: 'auto' | 'low' | 'high' | 'original';
    name?: string;
    mimeType?: string;
    previewUrl?: string;
  }
  | {
    type: 'file';
    path: string;
    name?: string;
    mimeType?: string;
  };

export type CodexSurfaceJsonValue =
  | null
  | boolean
  | number
  | string
  | CodexSurfaceJsonValue[]
  | { [key: string]: CodexSurfaceJsonValue };

export type CodexSurfaceSkillInput = Pick<CodexSurfaceSkill, 'name' | 'path'>;

export type CodexSurfaceReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string | null }
  | { type: 'custom'; instructions: string };

export type StartCodexReviewOptions = {
  target?: CodexSurfaceReviewTarget;
};

export type UpdateCodexConversationSettings = {
  approvalPreset?: CodexSurfaceApprovalPreset;
  modelId?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  planMode?: boolean;
};

export type CodexSurfaceApi = {
  readRateLimits?(options?: ReadCodexRateLimitsOptions): Promise<CodexSurfaceRateLimits>;
  readAccountUsage?(): Promise<CodexSurfaceAccountUsage>;
  consumeRateLimitResetCredit?(options: ConsumeCodexRateLimitResetCreditOptions): Promise<CodexSurfaceRateLimitResetCreditResult>;
  startLiveChat?(conversationId: string, options: StartCodexLiveChatOptions): Promise<{ sdp: string }>;
  stopLiveChat?(conversationId: string): Promise<void>;
  connect(): Promise<CodexSurfaceSnapshot>;
  refreshAccount(): Promise<CodexSurfaceSnapshot>;
  startChatGptLogin(): Promise<CodexSurfaceChatGptLogin>;
  startChatGptDeviceCodeLogin(): Promise<CodexSurfaceChatGptDeviceCodeLogin>;
  cancelLogin(loginId?: string): Promise<CodexSurfaceSnapshot>;
  logout(): Promise<CodexSurfaceSnapshot>;
  clearGoal(): Promise<CodexSurfaceSnapshot>;
  refreshConversations(): Promise<CodexSurfaceSnapshot>;
  listConversations(options?: ListCodexConversationsOptions): Promise<CodexConversationSummary[]>;
  listModels(options?: ListCodexModelsOptions): Promise<CodexSurfaceModel[]>;
  listSkills?(options?: ListCodexSkillsOptions): Promise<CodexSurfaceSkill[]>;
  createConversation(options?: CreateCodexConversationOptions): Promise<CodexSurfaceSnapshot>;
  archiveConversation(conversationId: string): Promise<CodexSurfaceSnapshot>;
  deleteConversation(conversationId: string): Promise<CodexSurfaceSnapshot>;
  unarchiveConversation(conversationId: string): Promise<CodexSurfaceSnapshot>;
  selectConversation(conversationId: string): Promise<CodexSurfaceSnapshot>;
  readConversationHistory(conversationId?: string): Promise<CodexConversationHistory>;
  readConversationPromptHistory(conversationId?: string): Promise<CodexConversationPromptHistory>;
  loadOlderConversationHistory?(conversationId?: string): Promise<CodexConversationHistoryPage>;
  loadTurnHistory?(turnId: string, conversationId?: string): Promise<CodexConversationSnapshot>;
  renameConversation(title: string): Promise<CodexSurfaceSnapshot>;
  updateConversationSettings(settings: UpdateCodexConversationSettings): Promise<CodexSurfaceSnapshot>;
  sendMessage(prompt: string, options?: SendCodexMessageOptions): Promise<CodexSurfaceSnapshot>;
  continueInterruptedTurn(): Promise<CodexSurfaceSnapshot>;
  compactConversation(): Promise<CodexSurfaceSnapshot>;
  startReview(options?: StartCodexReviewOptions): Promise<CodexSurfaceSnapshot>;
  steerMessage(prompt: string, options?: SendCodexMessageOptions): Promise<CodexSurfaceSnapshot>;
  interrupt(): Promise<CodexSurfaceSnapshot>;
  deleteTurn(turnId: string): Promise<CodexSurfaceSnapshot>;
  editTurn(turnId: string, content: string, options?: SendCodexMessageOptions): Promise<CodexSurfaceSnapshot>;
  forkTurn(turnId: string): Promise<CodexSurfaceSnapshot>;
  retryTurn(turnId: string): Promise<CodexSurfaceSnapshot>;
  deleteQueuedPrompt(promptId: string): Promise<CodexSurfaceSnapshot>;
  updateQueuedPrompt(promptId: string, prompt: string, options?: SendCodexMessageOptions): Promise<CodexSurfaceSnapshot>;
  steerQueuedPrompt(promptId: string, prompt?: string, options?: SendCodexMessageOptions): Promise<CodexSurfaceSnapshot>;
  respondToClientRequest(response: CodexSurfaceClientRequestResponse): Promise<CodexSurfaceSnapshot>;
  resolveApproval(
    approvalId: string,
    decision: CodexSurfaceApprovalDecision,
    scope?: CodexSurfaceApprovalScope,
  ): Promise<CodexSurfaceSnapshot>;
  setGoal(objective: string, tokenBudget?: number | null): Promise<CodexSurfaceSnapshot>;
  getSnapshot(): Promise<CodexSurfaceSnapshot>;
  onStateChange(listener: (snapshot: CodexSurfaceSnapshot) => void): () => void;
  onEvent(listener: (event: CodexSurfaceEvent) => void): () => void;
  /**
   * Optional incremental state stream: one versioned snapshot followed by
   * structural patches that carry only changed values and list items.
   * `getVersionedSnapshot` resolves null when patches are unavailable.
   * Prefer `subscribeCodexSurfaceState`, which falls back to `onStateChange`.
   */
  getVersionedSnapshot?(): Promise<CodexVersionedSurfaceSnapshot | null>;
  onStatePatch?(listener: (patch: CodexSurfaceStatePatch) => void): () => void;
};

/** A snapshot paired with the state version that the next patch continues from. */
export type CodexVersionedSurfaceSnapshot = {
  version: number;
  snapshot: CodexSurfaceSnapshot;
};

/**
 * One top-level snapshot change. `list` updates an array of `{ id }` items:
 * `ids` is the complete new order and `items` holds only new or changed items,
 * so unchanged items keep their identity on the receiving side.
 */
export type CodexSurfaceStateChange =
  | { type: 'set'; key: keyof CodexSurfaceSnapshot; value: unknown }
  | { type: 'delete'; key: keyof CodexSurfaceSnapshot }
  | { type: 'list'; key: keyof CodexSurfaceSnapshot; ids: string[]; items: Array<{ id: string }> };

/** Changes that turn state `version - 1` into state `version`. */
export type CodexSurfaceStatePatch = {
  version: number;
  changes: CodexSurfaceStateChange[];
};

export type CodexSurfaceClientApi = Omit<
  CodexSurfaceApi,
  'createConversation' | 'sendMessage' | 'steerMessage' | 'updateQueuedPrompt' | 'steerQueuedPrompt' | 'editTurn'
> & {
  editTurn(turnId: string, content: string, options?: CodexClientSendMessageOptions): Promise<CodexSurfaceSnapshot>;
  updateQueuedPrompt(promptId: string, prompt: string, options?: CodexClientSendMessageOptions): Promise<CodexSurfaceSnapshot>;
  steerQueuedPrompt(promptId: string, prompt?: string, options?: CodexClientSendMessageOptions): Promise<CodexSurfaceSnapshot>;
  createConversation(options?: CreateCodexClientConversationOptions): Promise<CodexSurfaceSnapshot>;
  sendMessage(prompt: string, options?: CodexClientSendMessageOptions): Promise<CodexSurfaceSnapshot>;
  steerMessage(prompt: string, options?: CodexClientSendMessageOptions): Promise<CodexSurfaceSnapshot>;
};

/** @deprecated Use CreateCodexClientConversationOptions. */
export type CreateCodexRendererConversationOptions = CreateCodexClientConversationOptions;
/** @deprecated Use CodexClientAttachment. */
export type CodexRendererAttachment = CodexClientAttachment;
/** @deprecated Use CodexClientSendMessageOptions. */
export type CodexRendererSendMessageOptions = CodexClientSendMessageOptions;
/** @deprecated Use CodexSurfaceClientApi. */
export type CodexSurfaceRendererApi = CodexSurfaceClientApi;
