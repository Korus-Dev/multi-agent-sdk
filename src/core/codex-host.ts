import type { CodexConversationSummary, CodexThreadStatus, CodexRateLimits, CodexSnapshot, CodexConversationSnapshot, StartCodexRealtimeOptions, CodexEvent, CodexConversationEvent } from './codex-conversation-types';
export type { CodexConversationSummary, CodexRemoteControlConnectionStatus, CodexThreadStatus, CodexRateLimitWindow, CodexRateLimitSnapshot, CodexRateLimits, CodexConversationLoadingStrategy, CodexConversationHistoryState, CodexAccountState, CodexLoginStatus, CodexLoginState, CodexAuthenticationState, CodexSnapshot, CodexConversationSnapshot, CodexConversationHistoryReplacementState, CodexConversationHistoryPrependState, CodexSubagentItemLifecycle, CodexSubagentTool, CodexSubagentToolCallStatus, CodexSubagentStatus, CodexSubagentState, CodexSubagentToolCall, CodexSubagentActivity, ContinueCodexSafetyReviewOptions, CodexRealtimeAudioChunk, CodexRealtimeInputAudioChunk, CodexRealtimeOutputModality, CodexRealtimeVersion, CodexRealtimeChannel, StartCodexRealtimeOptions, CodexEvent, CodexConversationEvent, CodexRealtimeEvent } from './codex-conversation-types';
export type { AgentContextUsage, ThreadGoal, ThreadPlanStep, ThreadPlanStepStatus } from '../contracts/conversation';
export type { RuntimeConnectionStatus, EventOrigin } from '../contracts/provider';
export type { ConversationQueuedPrompt, ConversationTurnGitDiff, ConversationExecutionPlan, ConversationHistoryReason, FileActivityAction, FileActivityStatus } from '../contracts/conversation';
import type { ModelDescriptor } from '../contracts/ui';
export type { ConversationMessageToolPartUpdate, CatalogStatus, ReasoningEffortOption, ModelDescriptor, PermissionProfile } from '../contracts/ui';
import type { ClientSendMessageOptions, ApprovalDecision, ApprovalScope, ClientRequestResponse, Skill, SendMessageOptions, UpdateConversationSettings, ConversationMessage, ApprovalPreset } from '../contracts/ui';
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
import type { JsonValue } from '../contracts/turn';
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

export type CodexChatGptLogin = {
  loginId: string;
  authUrl: string;
};

export type CodexChatGptDeviceCodeLogin = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

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
export type CodexRealtimeTextRole = 'user' | 'developer' | 'assistant';

/** Browser live-chat signaling. Media is carried by WebRTC, not the SDK bridge. */
export type StartCodexLiveChatOptions = Omit<StartCodexRealtimeOptions, 'transport' | 'outputModality'> & {
  sdp: string;
};
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
  connect(): Promise<CodexSnapshot>;
  refreshAccount(): Promise<CodexSnapshot>;
  startChatGptLogin(): Promise<CodexChatGptLogin>;
  startChatGptDeviceCodeLogin(): Promise<CodexChatGptDeviceCodeLogin>;
  cancelLogin(loginId?: string): Promise<CodexSnapshot>;
  logout(): Promise<CodexSnapshot>;
  clearGoal(): Promise<CodexSnapshot>;
  refreshConversations(): Promise<CodexSnapshot>;
  listConversations(options?: ListCodexConversationsOptions): Promise<CodexConversationSummary[]>;
  listModels(options?: ListCodexModelsOptions): Promise<ModelDescriptor[]>;
  listSkills?(options?: ListCodexSkillsOptions): Promise<Skill[]>;
  createConversation(options?: CreateCodexConversationOptions): Promise<CodexSnapshot>;
  archiveConversation(conversationId: string): Promise<CodexSnapshot>;
  deleteConversation(conversationId: string): Promise<CodexSnapshot>;
  unarchiveConversation(conversationId: string): Promise<CodexSnapshot>;
  selectConversation(conversationId: string): Promise<CodexSnapshot>;
  readConversationHistory(conversationId?: string): Promise<CodexConversationHistory>;
  readConversationPromptHistory(conversationId?: string): Promise<CodexConversationPromptHistory>;
  loadOlderConversationHistory?(conversationId?: string): Promise<CodexConversationHistoryPage>;
  loadTurnHistory?(turnId: string, conversationId?: string): Promise<CodexConversationSnapshot>;
  renameConversation(title: string): Promise<CodexSnapshot>;
  updateConversationSettings(settings: UpdateConversationSettings): Promise<CodexSnapshot>;
  sendMessage(prompt: string, options?: SendMessageOptions): Promise<CodexSnapshot>;
  continueInterruptedTurn(): Promise<CodexSnapshot>;
  compactConversation(): Promise<CodexSnapshot>;
  startReview(options?: StartCodexReviewOptions): Promise<CodexSnapshot>;
  steerMessage(prompt: string, options?: SendMessageOptions): Promise<CodexSnapshot>;
  interrupt(): Promise<CodexSnapshot>;
  deleteTurn(turnId: string): Promise<CodexSnapshot>;
  editTurn(turnId: string, content: string, options?: SendMessageOptions): Promise<CodexSnapshot>;
  forkTurn(turnId: string): Promise<CodexSnapshot>;
  retryTurn(turnId: string): Promise<CodexSnapshot>;
  deleteQueuedPrompt(promptId: string): Promise<CodexSnapshot>;
  updateQueuedPrompt(promptId: string, prompt: string, options?: SendMessageOptions): Promise<CodexSnapshot>;
  steerQueuedPrompt(promptId: string, prompt?: string, options?: SendMessageOptions): Promise<CodexSnapshot>;
  respondToClientRequest(response: ClientRequestResponse): Promise<CodexSnapshot>;
  resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
  ): Promise<CodexSnapshot>;
  setGoal(objective: string, tokenBudget?: number | null): Promise<CodexSnapshot>;
  getSnapshot(): Promise<CodexSnapshot>;
  onStateChange(listener: (snapshot: CodexSnapshot) => void): () => void;
  onEvent(listener: (event: CodexEvent) => void): () => void;
  /**
   * Optional incremental state stream: one versioned snapshot followed by
   * structural patches that carry only changed values and list items.
   * `getVersionedSnapshot` resolves null when patches are unavailable.
   * Prefer `subscribeCodexHostState`, which falls back to `onStateChange`.
   */
  getVersionedSnapshot?(): Promise<CodexVersionedSnapshot | null>;
  onStatePatch?(listener: (patch: CodexStatePatch) => void): () => void;
};

/** A snapshot paired with the state version that the next patch continues from. */
export type CodexVersionedSnapshot = {
  version: number;
  snapshot: CodexSnapshot;
};

/**
 * One top-level snapshot change. `list` updates an array of `{ id }` items:
 * `ids` is the complete new order and `items` holds only new or changed items,
 * so unchanged items keep their identity on the receiving side.
 */
export type CodexStateChange =
  | { type: 'set'; key: keyof CodexSnapshot; value: unknown }
  | { type: 'delete'; key: keyof CodexSnapshot }
  | { type: 'list'; key: keyof CodexSnapshot; ids: string[]; items: Array<{ id: string }> };

/** Changes that turn state `version - 1` into state `version`. */
export type CodexStatePatch = {
  version: number;
  changes: CodexStateChange[];
};

export type CodexHostClientApi = Omit<
  CodexHostApi,
  'createConversation' | 'sendMessage' | 'steerMessage' | 'updateQueuedPrompt' | 'steerQueuedPrompt' | 'editTurn'
> & {
  editTurn(turnId: string, content: string, options?: ClientSendMessageOptions): Promise<CodexSnapshot>;
  updateQueuedPrompt(promptId: string, prompt: string, options?: ClientSendMessageOptions): Promise<CodexSnapshot>;
  steerQueuedPrompt(promptId: string, prompt?: string, options?: ClientSendMessageOptions): Promise<CodexSnapshot>;
  createConversation(options?: CreateCodexClientConversationOptions): Promise<CodexSnapshot>;
  sendMessage(prompt: string, options?: ClientSendMessageOptions): Promise<CodexSnapshot>;
  steerMessage(prompt: string, options?: ClientSendMessageOptions): Promise<CodexSnapshot>;
};
