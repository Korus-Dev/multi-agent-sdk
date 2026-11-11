import { describe, expect, it } from 'vitest';
import { createScriptedHarness } from '../../src/testing';
import { emptyCursorSnapshot } from '../../src/conversations/cursor-conversation-replica';
import type { HarnessEvent, HarnessProvider } from '../../src';
import { codexSnapshot } from '../support/codex-snapshot';

// Every harness reports what happens in a conversation as the same neutral events; its native frames never reach consumers.
const at = '2026-11-11T10:00:00.000Z';
const claudeSnapshot = { agentId: 'agent', sessionId: 'session', activeTurnId: null, turnIds: [], turns: [], messages: [], answeredClientRequestIds: [],
  busy: false, historyLoading: false, historyState: { hasOlder: false, loadingOlder: false }, contextUsage: null, plan: null, error: null };

function run(provider: HarnessProvider, snapshot: unknown, events: unknown[], frame: Record<string, unknown> = {}) {
  const { harness, script } = createScriptedHarness(provider);
  const session = harness.open({ id: 'agent', folder: '/work' });
  const seen: HarnessEvent[] = [];
  harness.onEvent(event => seen.push(event));
  const envelope = { agentId: 'agent', provider, ...frame };
  script.emit({ ...envelope, type: `${provider}.conversationSnapshotChanged`, payload: { revision: 1, snapshot } } as never);
  events.forEach((event, index) => script.emit({ ...envelope, type: `${provider}.conversationEventReceived`, payload: { revision: index + 2, event } } as never));
  const activity = seen.filter(event => !['session.changed', 'session.patch'].includes(event.type));
  expect(seen.some(event => event.type.endsWith('.conversationEventReceived') || event.type.endsWith('.conversationSnapshotChanged'))).toBe(false);
  return { session, activity };
}

describe('conversation activity', () => {
  it('reports a Codex turn, its output, a proposed plan and its outcome', () => {
    const scope = { seq: 1, occurredAt: at, origin: 'notification', conversationId: 'conversation-1', turnId: 'turn-1' };
    const { session, activity } = run('codex', codexSnapshot(), [
      { ...scope, type: 'turn.started', payload: { turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } } },
      { ...scope, type: 'message.delta', payload: { messageId: 'm1', itemId: 'item-1', delta: 'Hi' } },
      { ...scope, type: 'turn.proposedPlanCompleted', payload: { itemId: 'plan-1', markdown: '# Plan' } },
      { ...scope, type: 'turn.completed', payload: { status: 'failed', error: { message: 'Quota reached', codexErrorInfo: 'usageLimitExceeded' }, willRetry: false, startedAt: null, completedAt: null, durationMs: null } },
    ], { threadId: 'conversation-1' });
    expect(activity).toEqual(expect.arrayContaining([
      { type: 'turn.started', session, turnId: 'turn-1', conversationId: 'conversation-1' },
      { type: 'turn.output', session, turnId: 'turn-1', conversationId: 'conversation-1' },
      { type: 'plan.readyForReview', session, turnId: 'turn-1', markdown: '# Plan', itemId: 'plan-1' },
      { type: 'turn.completed', session, turnId: 'turn-1', conversationId: 'conversation-1', status: 'failed', willRetry: false,
        error: { message: 'Quota reached', code: 'usageLimitExceeded' } },
    ]));
  });

  it('reports a Claude error with when its limit resets, then the failed turn', () => {
    const scope = { seq: 1, occurredAt: at, agentId: 'agent', provider: 'claude', providerSessionId: 'session', turnId: 'turn-1' };
    const { session, activity } = run('claude', claudeSnapshot, [
      { ...scope, type: 'turn.started', payload: { turn: { id: 'turn-1', provider: 'claude' } } },
      { ...scope, type: 'error', payload: { message: 'Usage limit reached', rateLimit: { resumeAt: 1_800_000_000_000 } } },
      { ...scope, type: 'turn.completed', payload: { turn: { id: 'turn-1', status: 'failed' } } },
    ]);
    expect(activity).toEqual(expect.arrayContaining([
      { type: 'session.error', session, turnId: 'turn-1', conversationId: 'session', willRetry: false, error: { message: 'Usage limit reached', rateLimit: { resumeAt: 1_800_000_000_000 } } },
      { type: 'turn.completed', session, turnId: 'turn-1', conversationId: 'session', status: 'failed', willRetry: false, error: null },
    ]));
  });

  it('reports a Cursor tool call as it runs and finishes', () => {
    const scope = { agentId: 'agent', sessionId: 'session', turnId: 'turn-1', occurredAt: at };
    const tool = (status: string) => ({ id: 'm1', agentId: 'agent', role: 'assistant', status: 'streaming', turnId: 'turn-1', createdAt: at,
      parts: [{ type: 'tool', id: 'call-1', kind: 'command', title: 'npm test', status }] });
    const { session, activity } = run('cursor', emptyCursorSnapshot('agent', 'session'), [
      { ...scope, type: 'turn.started', payload: {} },
      { ...scope, type: 'message.upsert', payload: { message: tool('running') } },
      { ...scope, type: 'message.upsert', payload: { message: tool('completed') } },
      { ...scope, type: 'turn.completed', payload: { turn: { id: 'turn-1', status: 'completed' } } },
    ]);
    expect(activity.filter(event => event.type === 'tool.updated')).toEqual([
      { type: 'tool.updated', session, turnId: 'turn-1', conversationId: 'session', tool: { id: 'call-1', kind: 'command', status: 'running' } },
      { type: 'tool.updated', session, turnId: 'turn-1', conversationId: 'session', tool: { id: 'call-1', kind: 'command', status: 'completed' } },
    ]);
    expect(activity.at(-1)).toMatchObject({ type: 'turn.completed', status: 'completed', error: null });
  });
});
