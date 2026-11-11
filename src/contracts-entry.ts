/** Data contracts, guards and capability tables with no runtime dependencies, for code that runs without Node. */
export * from './capabilities';
export * from './contracts/shared';
export * from './contracts/conversation';
export * from './contracts/safety-review';
export * from './conversations/agent-request';
export * from './conversations/tool-output';
export * from './conversations/work-phases';
/**
 * Transitional: native conversation replicas and reducers, for apps that still replay raw provider events
 * instead of consuming neutral session state. They leave this entry once that pipeline is gone.
 */
export { createCodexConversationReplica, type CodexConversationReplica } from './core/codex-conversation-replica';
export * from './conversations/claude-conversation-tools';
export * from './conversations/claude-conversation-replica';
export * from './conversations/claude-conversation-plans';
export * from './conversations/claude-conversation-reducer';
export * from './conversations/claude-conversation-transcript';
export * from './conversations/claude-conversation-payloads';
export * from './conversations/cursor-conversation-replica';
export * from './conversations/antigravity-conversation-replica';
