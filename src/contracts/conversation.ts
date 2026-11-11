import type { SendMessageOptions } from './ui';
import type { ExecutionSelectionOverrides } from './execution';
import type { PromptPart } from './prompt';
import type { ConversationMessageQuestionPart } from './ui';

export type ThreadGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

export type ThreadGoal = {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type ThreadPlanStepStatus = 'pending' | 'inProgress' | 'completed';

export type ThreadPlanKind = 'execution' | 'proposed';

export type ThreadPlanStatus = 'inProgress' | 'completed' | 'incomplete' | 'interrupted' | 'failed';

export type ThreadPlanStep = {
  step: string;
  status: ThreadPlanStepStatus;
};

export type ThreadPlan = {
  threadId: string;
  turnId: string;
  kind: ThreadPlanKind;
  status: ThreadPlanStatus;
  explanation: string;
  steps: ThreadPlanStep[];
  markdown: string;
  updatedAt: string;
};

export type AgentContextUsage = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  lastTotalTokens: number;
  modelContextWindow: number | null;
  usedPercent: number | null;
};

export type ProviderConversationRef =
  | { provider: 'cursor'; folder: string | null; sessionId: string }
  | { provider: 'antigravity'; folder: string | null; sessionId: string }
  | {
    provider: 'codex';
    threadId: string;
  }
  | {
    provider: 'claude';
    folder: string | null;
    sessionId: string;
    subagentId?: string;
  };

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Structural check for a persisted or wire conversation reference of any provider. */
export function isProviderConversationRef(value: unknown): value is ProviderConversationRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (ref.provider === 'codex') return nonEmptyString(ref.threadId);
  if (ref.provider !== 'claude' && ref.provider !== 'cursor' && ref.provider !== 'antigravity') return false;
  if (!nonEmptyString(ref.sessionId) || !(ref.folder === null || nonEmptyString(ref.folder))) return false;
  return ref.provider !== 'claude' || ref.subagentId === undefined || nonEmptyString(ref.subagentId);
}

/** What a provider's own review feature looks at. */
export type ConversationReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string | null }
  | { type: 'custom'; instructions: string };

export type ConversationStorageState = 'active' | 'archived';

export type ConversationListInput = {
  /** Native archived conversations; omitted/false lists normal active conversations. */
  archived?: boolean;
  /** Optional workspace filter; omitted lists across workspaces. */
  cwd?: string | null;
  searchTerm?: string;
  limit?: number;
};

export type ConversationResumeTarget = {
  ref: ProviderConversationRef;
  storageState: ConversationStorageState;
};

export type ConversationSummary = {
  id: string;
  sessionId?: string;
  parentConversationId?: string;
  agentNickname?: string;
  agentRole?: string;
  title: string;
  preview?: string;
  status?: 'idle' | 'active' | 'error';
  createdAt?: string;
  updatedAt: string;
  messageCount: number;
  storageState: ConversationStorageState;
  ref: ProviderConversationRef;
};

export const subagentStatuses = [
  'pendingInit',
  'running',
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound',
] as const;

export type SubagentStatus = typeof subagentStatuses[number];

export const subagentOperationKinds = [
  'spawnAgent',
  'sendInput',
  'resumeAgent',
  'wait',
  'closeAgent',
  'sendMessage',
  'followupTask',
  'interruptAgent',
  'listAgents',
] as const;

export type SubagentOperationKind = typeof subagentOperationKinds[number];

export const subagentOperationLifecycles = ['started', 'completed'] as const;

export type SubagentOperationLifecycle = typeof subagentOperationLifecycles[number];

export const subagentOperationStatuses = ['inProgress', 'completed', 'failed', 'interrupted'] as const;

export type SubagentOperationStatus = typeof subagentOperationStatuses[number];

export const subagentActivityKinds = ['started', 'interacted', 'interrupted', 'completed'] as const;

export type SubagentActivityKind = typeof subagentActivityKinds[number];

export type SubagentNode = {
  conversationId: string;
  parentConversationId: string;
  createdAt: string;
  status: SubagentStatus;
  statusMessage?: string;
  agentPath?: string;
  agentNickname?: string;
  agentRole?: string;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  updatedAt: string;
};

export type SubagentOperation = {
  id: string;
  turnId?: string;
  lifecycle: SubagentOperationLifecycle;
  kind: SubagentOperationKind;
  status: SubagentOperationStatus;
  senderConversationId: string;
  receiverConversationIds: string[];
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  occurredAt: string;
};

export type SubagentOperationChange = {
  rootConversationId: string;
  operation: SubagentOperation;
  agentStates: Record<string, { status: SubagentStatus; message?: string }>;
};

export type SubagentActivity = {
  id: string;
  turnId?: string;
  lifecycle: SubagentOperationLifecycle;
  kind: SubagentActivityKind;
  conversationId: string;
  agentPath: string;
  occurredAt: string;
};

export type SubagentActivityChange = {
  rootConversationId: string;
  parentConversationId: string;
  activity: SubagentActivity;
};

export type SubagentStatusChange = {
  rootConversationId: string;
  conversationId: string;
  status: SubagentStatus;
  statusMessage?: string;
};

export type SubagentIdentityChange = {
  rootConversationId: string;
  conversationId: string;
  agentNickname?: string;
  agentRole?: string;
};

export type AgentSubagentTree = {
  rootConversationId: string;
  nodes: Record<string, SubagentNode>;
  operations: Record<string, SubagentOperation>;
  activities: Record<string, SubagentActivity>;
};

export type PromptSkillInput = {
  name: string;
  path: string;
};

export type PromptAttachment =
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

export type PromptReferenceAttachment =
  | {
    type: 'image';
    reference: string;
    detail?: 'auto' | 'low' | 'high' | 'original';
  }
  | {
    type: 'file';
    reference: string;
  };

export type SendPromptOptions = {
  content?: readonly PromptPart[];
  attachments?: readonly PromptAttachment[];
  selection?: ExecutionSelectionOverrides;
  planMode?: boolean;
  skills?: PromptSkillInput[];
  inputMethod?: 'typed' | 'dictated';
  /** Internal delivery hint: the provider must not create another visible user row. */
  recordUserMessage?: boolean;
  providerOptions?: ProviderPromptOptions;
};

export type ReferenceSendPromptOptions = Omit<SendPromptOptions, 'attachments' | 'recordUserMessage'> & {
  attachments?: readonly PromptReferenceAttachment[];
};

export type PromptContentOptions = Pick<SendPromptOptions, 'content'>;

export type ProviderPromptOptions =
  | { kind: 'cursor'; permissionMode?: string | null }
  | { kind: 'antigravity'; permissionMode?: string | null }
  | {
    kind: 'codex';
    skills?: PromptSkillInput[];
  }
  | {
    kind: 'claude';
    thinkingBudgetTokens?: number | null;
    permissionMode?: string | null;
  };

export type MessageAttachment = {
  width?: number;
  height?: number;
  kind: 'file' | 'image';
  name: string;
  path?: string;
  url?: string;
  mimeType?: string;
};

export type MessageMedia = {
  width?: number;
  height?: number;
  url: string;
  alt?: string;
  mimeType?: string;
  prompt?: string;
  title?: string;
};

export type MessagePart =
  | { type: 'attachment'; attachment: MessageAttachment }
  /** Media from a tool observation belongs to the work; final-answer media stays visible. */
  | { type: 'media'; media: MessageMedia; itemId?: string; phase?: 'commentary' | 'partial_answer' | 'final_answer' }
  | ConversationMessageQuestionPart
  | { type: 'reasoning'; summary: string; itemId: string; summaryIndex: number }
  | { type: 'text'; text: string; itemId?: string; phase?: 'commentary' | 'partial_answer' | 'final_answer' }
  | {
    type: 'tool';
    id: string;
    kind: string;
    title: string;
    status: 'running' | 'completed' | 'failed';
    statusText?: string;
    body?: string;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
  }
  | { type: 'status'; text: string };

export type ToolPart = Extract<MessagePart, { type: 'tool' }>;

export type ToolPartUpdate = {
  itemId: string;
  title?: string;
  status?: ToolPart['status'];
  statusText?: string | null;
  body?: string;
  bodyDelta?: string;
  bodyAppend?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  fallbackToolPart?: ToolPart;
};

export type Message = {
  metadata?: {
    promptContent?: readonly PromptPart[];
    /** Answers the person gave to non-blocking questions, keyed by question id, shown with their message. */
    asyncQuestionAnswers?: Record<string, { answers: string[] }>;
  };
  id: string;
  agentId: string;
  kind?: 'compaction' | 'steer';
  role: 'user' | 'assistant' | 'system';
  status: 'complete' | 'streaming' | 'error';
  turnId?: string;
  parts: MessagePart[];
  createdAt: string;
  /** Lossless JSON of this message, retrieved in bounded chunks from its owning session. */
  deferredContent?: { contentId: string; byteLength: number };
};

export type ConversationContentInput = { sessionId: string; contentId: string; offset: number };
export type ConversationContentChunk = { data: string; nextOffset: number | null; totalBytes: number };

export type AgentFileActivity = {
  agentId: string;
  turnId: string;
  messageId: string;
  itemId: string;
  path: string;
  action: 'read' | 'edit' | 'create';
  status: 'running' | 'completed' | 'failed';
  occurredAt: string;
};

export type ConversationFileLink = {
  diffContent?: import('./conversation-diff').ConversationDiffContent;
  kind: 'file';
  href: string;
  path: string;
  filepath?: string;
  action?: 'read' | 'edit' | 'create';
  line?: number;
  column?: number;
  turnId?: string;
  messageId?: string;
  itemId?: string;
};

export type AgentQueuedPrompt = {
  id: string;
  agentId: string;
  text: string;
  createdAt: string;
  options?: SendPromptOptions;
  attempts?: number;
  lastError?: string;
  retryAt?: string;
  submitted?: boolean;
};

export type AgentHistoryLoadResult = {
  hasOlder: boolean;
};

export type ToolConfirmationDecision =
  | 'allow'
  | 'allow_conversation'
  | 'always_allow'
  | 'deny';

export type ConfirmToolRequest = {
  argumentsPreview: string;
  integrationId: string;
  integrationName: string;
  summary: string;
  toolName: string;
  allowConversation?: boolean;
  allowAlways?: boolean;
};

export type AskUserQuestionOption = {
  label: string;
  description: string;
};

export type AskUserQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  multiSelect?: boolean;
  options: readonly AskUserQuestionOption[] | null;
};

export type AskUserRequest = {
  itemId: string;
  delivery?: 'tool' | 'async';
  blocking?: boolean;
  questions: readonly AskUserQuestion[];
  autoResolutionMs?: number;
};

export type AskUserAnswers = Record<string, { answers: string[] }>;

export type ClientRequest =
  | {
    id: string;
    kind: 'confirm_tool';
    payload: {
      confirmation: ConfirmToolRequest;
    };
  }
  | {
    id: string;
    kind: 'ask_user';
    conversationId?: string;
    turnId?: string;
    itemId?: string;
    payload: {
      request: AskUserRequest;
    };
  };

export type ClientRequestResponse = {
  id: string;
  /** App routing identity; never forwarded as provider request data. */
  agentId?: string;
  payload?: {
    answers?: AskUserAnswers;
    cancelled?: boolean;
    decision?: ToolConfirmationDecision | null;
  };
};




export type ConversationQueuedPrompt = {
  id: string;
  text: string;
  options?: SendMessageOptions;
};



export type ConversationTurnGitDiff = {
  turnId: string;
  addedLines: number;
  removedLines: number;
  diff?: string;
  updatedAt: string;
};


export type ConversationHistoryReason = 'fork' | 'load' | 'resume' | 'rollback' | 'resync' | 'details' | 'images';


export type FileActivityAction = 'read' | 'edit' | 'create';


export type FileActivityStatus = 'running' | 'completed' | 'failed';


export type ConversationExecutionPlan = {
  turnId: string;
  explanation: string | null;
  steps: readonly ThreadPlanStep[];
  markdown: string;
  updatedAt: string;
};
