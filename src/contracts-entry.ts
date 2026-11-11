/** Data contracts, guards and capability tables with no runtime dependencies, for code that runs without Node. */
export { applySessionPatch, SessionPatchGapError, SessionPatchInvalidError, type SessionPatch, type SessionPatchOp, type SessionSnapshot } from './session-patch';
export {
  antigravityHarnessCapabilities, claudeHarnessCapabilities, codexHarnessCapabilities, cursorHarnessCapabilities
} from './capabilities';
export {
  isProviderConversationRef, subagentActivityKinds, subagentOperationKinds, subagentOperationLifecycles,
  subagentOperationStatuses, subagentStatuses, type ToolPart
} from './contracts/conversation';
export {
  isProviderSafetyReview, isProviderSafetyReviewTarget, providerSafetyBlockDetails, providerSafetyBlockMessage,
  type ProviderSafetyReview, type ProviderSafetyReviewTarget
} from './contracts/safety-review';
export { harnessProviders, isHarnessProvider } from './contracts/shared';
export {
  type AgentRequest, type AgentRequestOutcome, type AgentRequestResponse, agentResponseFromClientResponse,
  approvalAgentRequest, approvalOutcome, clientResponseFromAgentResponse, isAgentRequestResponse,
  requestFromClientRequest
} from './conversations/agent-request';
export { toolOutputText } from './conversations/tool-output';
/**
 * Transitional: native conversation replicas and their reducer helpers, for apps that still replay raw provider events
 * instead of consuming neutral session state. They leave this entry once that pipeline is gone.
 */
export { createAntigravityConversationReplica, emptyAntigravitySnapshot } from './conversations/antigravity-conversation-replica';
export { isRecord, parseJsonPreview, stringValue } from './conversations/claude-conversation-payloads';
export {
  appendAgentPlanMarkdownDelta, appendAssistantDeltaWithPlanFilter, planProgressOperation,
  updateAgentPlanMarkdown, upsertPlanProgressToolPart
} from './conversations/claude-conversation-plans';
export { applyClaudeConversationEvent } from './conversations/claude-conversation-reducer';
export { type ClaudeConversationReplica, createClaudeConversationReplica } from './conversations/claude-conversation-replica';
export { applyApprovalRequest, applyToolInputRequest, updateAssistantToolPart, upsertAssistantToolPart } from './conversations/claude-conversation-tools';
export {
  appendAssistantDelta, appendCompactionMarker, appendSystemMessage, assistantMessageId,
  completeAssistantMessage, createUserMessage, ensureAssistantMessage, findAssistantMessage,
  findAssistantMessages, findAssistantMessageWithToolPart, findCompactionMessages,
  pruneSupersededEmptyAssistantPlaceholders
} from './conversations/claude-conversation-transcript';
export { createCursorConversationReplica, emptyCursorSnapshot } from './conversations/cursor-conversation-replica';
export { type CodexConversationReplica, createCodexConversationReplica } from './core/codex-conversation-replica';
