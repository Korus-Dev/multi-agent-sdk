/** Codex app-server client contracts: the shapes the Codex engine reads and writes. Codex-internal; the public API uses the neutral contracts. */
import type { ApprovalPreset } from '../contracts/shared';
export type { ApprovalPreset } from '../contracts/shared';
import type { PromptPart } from '../contracts/prompt';
import type { JsonValue } from '../contracts/turn';
export type ConversationMessageTextPart = {
  type: 'text';
  text: string;
  itemId?: string;
  phase?: 'commentary' | 'partial_answer' | 'final_answer';
};

export type ConversationMessageReasoningPart = {
  type: 'reasoning';
  summary: string;
  itemId: string;
  summaryIndex: number;
};

export type ConversationMessageStatusPart = {
  type: 'status';
  text: string;
};

export type AskUserQuestion = {
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

export type ConversationMessageQuestionPart = {
  type: 'question';
  /** Replayed transcript content, not a live request to answer. */
  historical?: boolean;
  request: Extract<ClientRequest, { kind: 'ask_user' }>;
};

export type ConversationMessageAttachment = {
  /** Intrinsic display dimensions, available before lazy image bytes load. */
  width?: number;
  height?: number;
  kind: 'file' | 'image';
  name: string;
  path?: string;
  url?: string;
  mimeType?: string;
};

export type ConversationMessageAttachmentPart = {
  type: 'attachment';
  attachment: ConversationMessageAttachment;
};

export type ConversationMessageMedia = {
  /** Intrinsic display dimensions, available before lazy image bytes load. */
  width?: number;
  height?: number;
  url: string;
  alt?: string;
  mimeType?: string;
  prompt?: string;
  title?: string;
};

export type ConversationMessageMediaPart = {
  type: 'media';
  /** Tool observations belong to Working; final-answer media stays visible. */
  phase?: ConversationMessageTextPart['phase'];
  media: ConversationMessageMedia;
  itemId?: string;
};

export type ConversationMessageToolPart = {
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

export type ConversationMessagePart =
  | ConversationMessageAttachmentPart
  | ConversationMessageMediaPart
  | ConversationMessageQuestionPart
  | ConversationMessageReasoningPart
  | ConversationMessageTextPart
  | ConversationMessageStatusPart
  | ConversationMessageToolPart;

export type ConversationMessage = {
  id: string;
  kind?: 'compaction' | 'steer';
  role: 'user' | 'assistant' | 'system';
  status: 'complete' | 'streaming' | 'error';
  parts: readonly ConversationMessagePart[];
  createdAt?: string;
  turnId?: string;
  metadata?: Record<string, unknown>;
};

export type Approval = {
  id: string;
  kind: 'command' | 'file-change' | 'permissions';
  conversationId: string;
  turnId?: string;
  itemId: string;
  title: string;
  description?: string;
  command?: string;
  cwd?: string;
  requestedPermissions?: readonly RequestedPermission[];
  allowedScopes?: readonly ApprovalScope[];
  canDeny?: boolean;
  /** Requires a fresh human decision; never satisfy this through automatic or remembered approval. */
  requiresHumanApproval?: boolean;
};

export type RequestedPermission =
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

export type ApprovalDecision = 'approve' | 'deny';
export type ApprovalScope = 'once' | 'session';

export type AskUserAnswers = Record<string, { answers: string[] }>;
export type ToolConfirmationDecision = 'allow' | 'allow_conversation' | 'always_allow' | 'deny';
export type ClientRequestResponse = {
  id: string;
  payload?: {
    answers?: AskUserAnswers;
    cancelled?: boolean;
    decision?: ToolConfirmationDecision | null;
  };
};

export type ClientRequest =
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
        questions: readonly AskUserQuestion[];
        autoResolutionMs?: number;
      };
    };
  };

export type ServiceTier = {
  id: string;
  name: string;
  description: string;
};

export type Skill = {
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

export type Plugin = {
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

/** Controls whether the conversation view mounts all supplied messages. */
export type ConversationRenderStrategy = 'eager' | 'lazy';

export type SendMessageOptions = {
  content?: readonly PromptPart[];
  attachments?: readonly Attachment[];
  inputMethod?: 'typed' | 'dictated';
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  planMode?: boolean;
  skills?: readonly SkillInput[];
  outputSchema?: JsonValue;
};

export type ClientAttachment =
  | {
    type: 'image';
    reference: string;
    detail?: 'auto' | 'low' | 'high' | 'original';
  }
  | {
    type: 'file';
    reference: string;
  };

export type ClientSendMessageOptions = Omit<SendMessageOptions, 'attachments'> & {
  attachments?: readonly ClientAttachment[];
};

export type Attachment =
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

export type SkillInput = Pick<Skill, 'name' | 'path'>;

export type ConversationQueuedPrompt = {
  id: string;
  text: string;
  options?: SendMessageOptions;
};

export type UpdateConversationSettings = {
  approvalPreset?: ApprovalPreset;
  modelId?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  planMode?: boolean;
};

export type ConversationMessageToolPartUpdate = {
  itemId: string;
  title?: string;
  status?: ConversationMessageToolPart['status'];
  statusText?: string | null;
  body?: string;
  bodyDelta?: string;
  bodyAppend?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  fallbackToolPart?: ConversationMessageToolPart;
};

export type CatalogStatus = 'notLoaded' | 'loading' | 'loaded' | 'error';

export type ReasoningEffortOption = {
  reasoningEffort: string;
  description: string;
};

export type ModelDescriptor = {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: ReasoningEffortOption[];
  defaultReasoningEffort?: string | null;
  serviceTiers?: ServiceTier[];
  defaultServiceTier?: string | null;
  isDefault?: boolean;
  providerMetadata?: Record<string, unknown>;
};

export type PermissionProfile = {
  id: string;
  description: string | null;
  allowed: boolean;
};
