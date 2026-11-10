import { describe, expect, it } from 'vitest';
import type { v2 } from '@korus-dev/codex-sdk';
import { hostSubagentToolCall } from '../../src/providers/codex/host-subagents';

describe('hostSubagentToolCall', () => {
  it('projects the complete protocol shape and omits missing agent states', () => {
    const item = {
      type: 'collabAgentToolCall',
      id: 'call-1',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'thread-parent',
      receiverThreadIds: ['thread-child-1', 'thread-child-2'],
      prompt: 'Investigate the parser',
      model: 'gpt-5.6',
      reasoningEffort: 'high',
      agentsStates: {
        'thread-child-1': { status: 'pendingInit', message: null },
        'thread-child-2': undefined,
      },
    } as Extract<v2.ThreadItem, { type: 'collabAgentToolCall' }>;

    expect(hostSubagentToolCall(item)).toStrictEqual({
      id: 'call-1',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderConversationId: 'thread-parent',
      receiverConversationIds: ['thread-child-1', 'thread-child-2'],
      prompt: 'Investigate the parser',
      model: 'gpt-5.6',
      reasoningEffort: 'high',
      agentStates: {
        'thread-child-1': { status: 'pendingInit', message: null },
      },
    });
  });
});
