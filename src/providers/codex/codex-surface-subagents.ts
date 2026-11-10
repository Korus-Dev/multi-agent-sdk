import type { v2 } from '@korus-dev/codex-sdk';
import type {
  CodexSurfaceSubagentState,
  CodexSurfaceSubagentToolCall,
} from '../../core/surface';

export function surfaceSubagentToolCall(
  item: Extract<v2.ThreadItem, { type: 'collabAgentToolCall' }>,
): CodexSurfaceSubagentToolCall {
  const agentStates: Record<string, CodexSurfaceSubagentState> = {};
  for (const [conversationId, state] of Object.entries(item.agentsStates)) {
    if (state) agentStates[conversationId] = { status: state.status, message: state.message };
  }
  return {
    id: item.id,
    tool: item.tool,
    status: item.status,
    senderConversationId: item.senderThreadId,
    receiverConversationIds: [...item.receiverThreadIds],
    prompt: item.prompt,
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    agentStates,
  };
}
