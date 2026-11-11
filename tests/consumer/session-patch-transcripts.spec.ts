import { describe, expect, it } from 'vitest';
import { createScriptedHarness } from '../../src/testing';
import { applySessionPatch } from '../../src/session-patch';
import { emptyCursorSnapshot } from '../../src/conversations/cursor-conversation-replica';
import { emptyAntigravitySnapshot } from '../../src/conversations/antigravity-conversation-replica';
import type { HarnessProvider } from '../../src';
import { codexSnapshot } from '../support/codex-snapshot';

// A consumer that only receives patches, over JSON, holds exactly the state each harness reports, through that
// harness's own projection of a real native transcript: snapshot, turn start, streamed text, and completion.
const at = '2026-11-11T10:00:00.000Z';
const message = (id: string, text: string, turnId = 'turn-1') => ({ id, agentId: 'agent', role: 'assistant' as const, status: 'streaming' as const, turnId, createdAt: at, parts: [{ type: 'text' as const, text }] });
const claudeSnapshot = { agentId: 'agent', sessionId: 'session', activeTurnId: null, turnIds: [], turns: [], messages: [], answeredClientRequestIds: [],
  busy: false, historyLoading: false, historyState: { hasOlder: false, loadingOlder: false }, contextUsage: null, plan: null, error: null };

const traffic: Record<HarnessProvider, { snapshot: unknown; events: unknown[]; frame?: Record<string, unknown> }> = {
  codex: {
    frame: { threadId: 'conversation-1' },
    snapshot: codexSnapshot(),
    events: [
      { seq: 1, occurredAt: at, origin: 'notification', conversationId: 'conversation-1', turnId: 'turn-1', type: 'message.appended', payload: { message: { ...message('m1', ''), parts: [] } } },
      { seq: 2, occurredAt: at, origin: 'notification', conversationId: 'conversation-1', turnId: 'turn-1', type: 'message.delta', payload: { messageId: 'm1', itemId: 'item-1', delta: 'Hel' } },
      { seq: 3, occurredAt: at, origin: 'notification', conversationId: 'conversation-1', turnId: 'turn-1', type: 'message.delta', payload: { messageId: 'm1', itemId: 'item-1', delta: 'lo' } },
      { seq: 4, occurredAt: at, origin: 'action', conversationId: 'conversation-1', type: 'conversation.settingsChanged',
        payload: { approvalPreset: null, selectedModelId: null, selectedReasoningEffort: null, selectedServiceTier: null, planMode: true } },
    ],
  },
  claude: {
    snapshot: claudeSnapshot,
    events: [
      { seq: 1, occurredAt: at, agentId: 'agent', provider: 'claude', turnId: 'turn-1', type: 'turn.started', payload: { turn: { id: 'turn-1', provider: 'claude' } } },
      { seq: 2, occurredAt: at, agentId: 'agent', provider: 'claude', turnId: 'turn-1', type: 'message.delta', payload: { messageId: 'm1', delta: 'Hel' } },
      { seq: 3, occurredAt: at, agentId: 'agent', provider: 'claude', turnId: 'turn-1', type: 'message.delta', payload: { messageId: 'm1', delta: 'lo' } },
    ],
  },
  cursor: {
    snapshot: emptyCursorSnapshot('agent', 'session'),
    events: [
      { agentId: 'agent', sessionId: 'session', turnId: 'turn-1', occurredAt: at, type: 'turn.started', payload: {} },
      { agentId: 'agent', sessionId: 'session', turnId: 'turn-1', occurredAt: at, type: 'message.upsert', payload: { message: message('m1', 'Hel') } },
      { agentId: 'agent', sessionId: 'session', turnId: 'turn-1', occurredAt: at, type: 'message.upsert', payload: { message: message('m1', 'Hello') } },
      { agentId: 'agent', sessionId: 'session', turnId: 'turn-1', occurredAt: at, type: 'turn.completed', payload: { turn: { id: 'turn-1', status: 'completed' } } },
    ],
  },
  antigravity: {
    snapshot: emptyAntigravitySnapshot('agent', 'session'),
    events: [
      { agentId: 'agent', sessionId: 'session', turnId: 'turn-1', occurredAt: at, type: 'turn.started', payload: {} },
      { agentId: 'agent', sessionId: 'session', turnId: 'turn-1', occurredAt: at, type: 'message.upsert', payload: { message: message('m1', 'Hel') } },
      { agentId: 'agent', sessionId: 'session', turnId: 'turn-1', occurredAt: at, type: 'message.upsert', payload: { message: message('m1', 'Hello') } },
      { agentId: 'agent', sessionId: 'session', turnId: 'turn-1', occurredAt: at, type: 'turn.completed', payload: { turn: { id: 'turn-1', status: 'completed' } } },
    ],
  },
};

describe.each(Object.keys(traffic) as HarnessProvider[])('%s transcript over patches', provider => {
  it('replays a native transcript, through JSON, to the state the harness reports', () => {
    const { harness, script } = createScriptedHarness(provider);
    const session = harness.open({ id: 'agent', folder: '/work' });
    let local = harness.readSessionSnapshot(session);
    const revisions: number[] = [];
    harness.onEvent(event => {
      if (event.type !== 'session.patch' || event.session !== session) return;
      revisions.push(event.patch.revision);
      local = applySessionPatch(local, JSON.parse(JSON.stringify(event.patch)));
    });
    const { snapshot, events, frame = {} } = traffic[provider];
    const envelope = { agentId: 'agent', provider, ...frame };
    script.emit({ ...envelope, type: `${provider}.conversationSnapshotChanged`, payload: { revision: 1, snapshot } } as never);
    events.forEach((event, index) => script.emit({ ...envelope, type: `${provider}.conversationEventReceived`, payload: { revision: index + 2, event } } as never));
    expect(harness.readSession(session).error).toBeNull();
    expect(local).toStrictEqual(harness.readSessionSnapshot(session));
    expect(local.state.messages.at(-1)?.parts).toMatchObject([{ type: 'text', text: 'Hello' }]);
    expect(revisions.length).toBeGreaterThanOrEqual(3);
  });
});
