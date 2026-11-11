/** Serializable, provider-neutral presentation DTOs; no runtime initialization. */
export type { Message, MessagePart, MessageAttachment, MessageMedia, ToolPart, ToolPartUpdate } from './contracts/conversation';
export type { Turn, TurnStatus, TurnError, TurnExecutionUsage, TokenUsage, RequestUsage, RequestUsageField, SafetyFindings, JsonValue } from './contracts/turn';
export type { AgentRequest, AgentRequestResponse, AgentRequestOutcome } from './conversations/agent-request';
export type { PromptPart, PromptMention } from './contracts/prompt';
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
  ModelDescriptor,
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
  ConversationMessageToolPart
} from './contracts/ui';
export type { BankedResets, UseBankedResetInput, BankedResetResult } from './contracts/banked-resets';
