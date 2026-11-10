import {
  codexConversationBridgeOperations,
  invokeCodexConversationBridgeOperation,
  isCodexConversationBridgeOperation,
  subscribeCodexConversationBridge,
  subscribeCodexConversationReplicaBridge,
  type CodexConversationBridgeHandle,
  type CodexConversationBridgeTarget,
} from '../../src/core/host-bridge';
import type {
  CodexConversationEvent,
  CodexConversationSnapshot,
} from '../../src/core/codex-host';
import { describe, expect, it, vi } from 'vitest';

describe('Codex conversation bridge', () => {
  it('targets concurrent operations by conversation without changing global selection', async () => {
    const calls: Array<{ conversationId: string; prompt: string }> = [];
    const target = conversationTarget(['conversation-a', 'conversation-b'], {
      sendMessage: async (conversationId, prompt) => {
        calls.push({ conversationId, prompt });
        await Promise.resolve();
      },
    });

    const [a, b] = await Promise.all([
      invokeCodexConversationBridgeOperation(target, 'conversation-a', 'sendMessage', ['Run A']),
      invokeCodexConversationBridgeOperation(target, 'conversation-b', 'sendMessage', ['Run B']),
    ]);

    expect(calls).toStrictEqual([
      { conversationId: 'conversation-a', prompt: 'Run A' },
      { conversationId: 'conversation-b', prompt: 'Run B' },
    ]);
    expect(a.activeConversationId).toBe('conversation-a');
    expect(b.activeConversationId).toBe('conversation-b');
    expect(target.conversation).toHaveBeenCalledWith('conversation-a');
    expect(target.conversation).toHaveBeenCalledWith('conversation-b');
  });

  it('subscribes to independently keyed snapshots and events', () => {
    const target = conversationTarget(['conversation-a', 'conversation-b']);
    const aNotifications = vi.fn();
    const bNotifications = vi.fn();
    const unsubscribeA = subscribeCodexConversationBridge(target, 'conversation-a', aNotifications);
    const unsubscribeB = subscribeCodexConversationBridge(target, 'conversation-b', bNotifications);

    target.emitState('conversation-a');
    target.emitEvent('conversation-b', 'message.updated');

    expect(aNotifications).toHaveBeenCalledWith({
      type: 'snapshot',
      conversationId: 'conversation-a',
      snapshot: expect.objectContaining({ activeConversationId: 'conversation-a' }),
    });
    expect(aNotifications).not.toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conversation-b' }));
    expect(bNotifications).toHaveBeenCalledWith({
      type: 'event',
      conversationId: 'conversation-b',
      event: expect.objectContaining({
        type: 'message.updated',
        conversationId: 'conversation-b',
      }),
    });
    expect(bNotifications).not.toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conversation-a' }));

    unsubscribeA();
    unsubscribeB();
    target.emitState('conversation-a');
    expect(aNotifications).toHaveBeenCalledOnce();
  });

  it('boots a replica with one snapshot and then emits only incremental events', () => {
    const target = conversationTarget(['conversation-a']);
    const notifications = vi.fn();

    const unsubscribe = subscribeCodexConversationReplicaBridge(
      target,
      'conversation-a',
      notifications,
    );

    expect(notifications).toHaveBeenCalledExactlyOnceWith({
      type: 'snapshot',
      conversationId: 'conversation-a',
      snapshot: expect.objectContaining({ activeConversationId: 'conversation-a' }),
    });
    target.emitState('conversation-a');
    expect(notifications).toHaveBeenCalledTimes(1);
    target.emitEvent('conversation-a', 'message.updated');
    expect(notifications).toHaveBeenLastCalledWith({
      type: 'event',
      conversationId: 'conversation-a',
      event: expect.objectContaining({ type: 'message.updated' }),
    });

    unsubscribe();
    target.emitEvent('conversation-a', 'message.updated');
    expect(notifications).toHaveBeenCalledTimes(2);
  });

  it('routes every targeted operation through the selected conversation handle', async () => {
    const snapshot = { activeConversationId: 'conversation-a' } as CodexConversationSnapshot;
    const forkSnapshot = { activeConversationId: 'conversation-fork' } as CodexConversationSnapshot;
    const operations = Object.fromEntries([
      'clearGoal', 'compact', 'continueInterruptedTurn', 'deleteTurn', 'deleteQueuedPrompt', 'editTurn', 'getSnapshot',
      'interrupt', 'loadOlderHistory', 'loadTurnHistory', 'onEvent', 'onStateChange', 'readHistory', 'readPromptHistory',
      'rename', 'respondToClientRequest', 'resolveApproval', 'retryTurn', 'sendMessage', 'setGoal',
      'startReview', 'steerMessage', 'steerQueuedPrompt', 'updateQueuedPrompt', 'updateSettings',
    ].map((name) => [name, vi.fn(async () => snapshot)])) as Record<string, ReturnType<typeof vi.fn>>;
    operations.getSnapshot = vi.fn(() => snapshot);
    operations.forkTurn = vi.fn(async () => ({ snapshot: forkSnapshot }));
    const target = {
      conversation: vi.fn(() => operations as unknown as CodexConversationBridgeHandle),
    };
    const response = { id: 'request-1', payload: { decision: 'allow' } };
    const cases = [
      ['clearGoal', [], 'clearGoal', []],
      ['compactConversation', [], 'compact', []],
      ['continueInterruptedTurn', [], 'continueInterruptedTurn', []],
      ['deleteTurn', ['turn-1'], 'deleteTurn', ['turn-1']],
      ['deleteQueuedPrompt', ['queue-1'], 'deleteQueuedPrompt', ['queue-1']],
      ['editTurn', ['turn-2', 'Edited', undefined], 'editTurn', ['turn-2', 'Edited', undefined]],
      ['forkTurn', ['turn-3'], 'forkTurn', ['turn-3']],
      ['getSnapshot', [], 'getSnapshot', []],
      ['interrupt', [], 'interrupt', []],
      ['loadOlderConversationHistory', [], 'loadOlderHistory', []],
      ['loadTurnHistory', ['turn-1'], 'loadTurnHistory', ['turn-1']],
      ['readConversationHistory', [], 'readHistory', []],
      ['readConversationPromptHistory', [], 'readPromptHistory', []],
      ['renameConversation', ['New title'], 'rename', ['New title']],
      ['respondToClientRequest', [response], 'respondToClientRequest', [response]],
      ['resolveApproval', ['approval-1', 'approve', 'session'], 'resolveApproval', ['approval-1', 'approve', 'session']],
      ['retryTurn', ['turn-4'], 'retryTurn', ['turn-4']],
      ['sendMessage', ['Hello'], 'sendMessage', ['Hello', undefined]],
      ['setGoal', ['Ship it', 500], 'setGoal', ['Ship it', 500]],
      ['startReview', [], 'startReview', [undefined]],
      ['steerMessage', ['Adjust'], 'steerMessage', ['Adjust', undefined]],
      ['steerQueuedPrompt', ['queue-2'], 'steerQueuedPrompt', ['queue-2', undefined, undefined]],
      ['updateConversationSettings', [{ planMode: true }], 'updateSettings', [{ planMode: true }]],
      ['updateQueuedPrompt', ['queue-3', 'Updated', undefined], 'updateQueuedPrompt', ['queue-3', 'Updated', undefined]],
    ] as const;

    expect(cases.map(([operation]) => operation)).toStrictEqual([...codexConversationBridgeOperations]);
    for (const [operation, args, handleOperation, expectedArgs] of cases) {
      const result = await invokeCodexConversationBridgeOperation(target, 'conversation-a', operation, args);
      expect(operations[handleOperation]).toHaveBeenLastCalledWith(...expectedArgs);
      expect(result).toBe(operation === 'forkTurn' ? forkSnapshot : snapshot);
    }
  });

  it('publishes and validates the targeted operation set without weakening the global bridge', async () => {
    expect(codexConversationBridgeOperations).toContain('sendMessage');
    expect(codexConversationBridgeOperations).not.toContain('selectConversation');
    expect(isCodexConversationBridgeOperation('sendMessage')).toBe(true);
    expect(isCodexConversationBridgeOperation('selectConversation')).toBe(false);
    expect(isCodexConversationBridgeOperation('__proto__')).toBe(false);

    const target = conversationTarget(['conversation-a']);
    await expect(invokeCodexConversationBridgeOperation(
      target,
      ' ',
      'sendMessage',
      ['Run A'],
    )).rejects.toThrow('Conversation id must be a non-empty string');
    await expect(invokeCodexConversationBridgeOperation(
      target,
      'conversation-a',
      'sendMessage',
      [],
      { operationLabel: 'agent/conversation/invoke' },
    )).rejects.toThrow('agent/conversation/invoke received an invalid number of arguments');
    expect(target.conversation).not.toHaveBeenCalled();
  });

  it('cleans up the state subscription when event subscription fails', () => {
    const unsubscribeState = vi.fn();
    const target = {
      conversation: () => ({
        onStateChange: () => unsubscribeState,
        onEvent: () => { throw new Error('event subscription failed'); },
      }),
    } as unknown as CodexConversationBridgeTarget;

    expect(() => subscribeCodexConversationBridge(target, 'conversation-a', vi.fn()))
      .toThrow('event subscription failed');
    expect(unsubscribeState).toHaveBeenCalledOnce();
  });
});

type ConversationTarget = CodexConversationBridgeTarget & {
  emitState(conversationId: string): void;
  emitEvent(conversationId: string, type: 'message.updated'): void;
};

function conversationTarget(
  conversationIds: readonly string[],
  options: {
    sendMessage?: (conversationId: string, prompt: string) => Promise<void>;
  } = {},
): ConversationTarget {
  const snapshots = new Map(conversationIds.map((conversationId) => [
    conversationId,
    { activeConversationId: conversationId } as CodexConversationSnapshot,
  ]));
  const stateListeners = new Map<string, Set<(snapshot: CodexConversationSnapshot) => void>>();
  const eventListeners = new Map<string, Set<(event: CodexConversationEvent) => void>>();
  const handles = new Map(conversationIds.map((conversationId) => {
    const snapshot = snapshots.get(conversationId)!;
    return [conversationId, {
      getSnapshot: () => snapshot,
      sendMessage: async (prompt: string) => {
        await options.sendMessage?.(conversationId, prompt);
        return snapshot;
      },
      onStateChange: (listener: (value: CodexConversationSnapshot) => void) => {
        const listeners = stateListeners.get(conversationId) ?? new Set();
        listeners.add(listener);
        stateListeners.set(conversationId, listeners);
        return () => listeners.delete(listener);
      },
      onEvent: (listener: (value: CodexConversationEvent) => void) => {
        const listeners = eventListeners.get(conversationId) ?? new Set();
        listeners.add(listener);
        eventListeners.set(conversationId, listeners);
        return () => listeners.delete(listener);
      },
    }];
  }));
  const conversation = vi.fn((conversationId: string) => handles.get(conversationId));
  return {
    conversation,
    emitState: (conversationId: string) => {
      const snapshot = snapshots.get(conversationId)!;
      for (const listener of stateListeners.get(conversationId) ?? []) listener(snapshot);
    },
    emitEvent: (conversationId: string, type: 'message.updated') => {
      const event = {
        type,
        seq: 1,
        occurredAt: '2026-09-06T00:00:00.000Z',
        conversationId,
        turnId: 'turn-1',
        origin: 'notification',
        payload: {
          message: {
            id: 'message-1', role: 'assistant', status: 'streaming', parts: [], turnId: 'turn-1',
          },
        },
      } as unknown as CodexConversationEvent;
      for (const listener of eventListeners.get(conversationId) ?? []) listener(event);
    },
  } as unknown as ConversationTarget;
}
