/** Data contracts, guards and capability tables with no runtime dependencies, for code that runs without Node. */
export { applySessionPatch, SessionPatchGapError, SessionPatchInvalidError, type SessionPatch, type SessionPatchOp, type SessionSnapshot } from './session-patch';
export {
  antigravityHarnessCapabilities, claudeHarnessCapabilities, codexHarnessCapabilities, cursorHarnessCapabilities
} from './capabilities';
export {
  isProviderConversationRef, subagentActivityKinds, subagentOperationKinds, subagentOperationLifecycles,
  subagentOperationStatuses, subagentStatuses
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
