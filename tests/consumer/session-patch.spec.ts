import { describe, expect, it } from 'vitest';
import { createScriptedHarness } from '../../src/testing';
import { applySessionPatch, SessionPatchGapError } from '../../src/session-patch';
import type { HarnessEvent, Message, SessionPatch, SessionState } from '../../src';

// A consumer that only receives patches rebuilds exactly the state the harness holds, revision by revision.
const message = (id: string, text: string): Message => ({ id, agentId: 'agent', turnId: 'turn-1', role: 'assistant', status: 'streaming', createdAt: '2026-11-11T00:00:00.000Z', parts: [{ type: 'text', text }] });

function setup() {
  const { harness, script } = createScriptedHarness('claude');
  const session = harness.open({ id: 'agent', folder: '/work' });
  const patches: SessionPatch[] = [];
  harness.onEvent((event: HarnessEvent) => { if (event.type === 'session.patch' && event.session === session) patches.push(event.patch); });
  let revision = 0;
  const snapshot = (messages: Message[], extra: Partial<Record<string, unknown>> = {}) => {
    revision += 1;
    script.emit({ type: 'claude.conversationSnapshotChanged', agentId: 'agent', provider: 'claude', payload: { revision, snapshot: {
      agentId: 'agent', sessionId: 'session', activeTurnId: 'turn-1', turnIds: ['turn-1'], turns: [], messages,
      answeredClientRequestIds: [], busy: true, historyLoading: false, historyState: { hasOlder: false, loadingOlder: false },
      contextUsage: null, plan: null, error: null, ...extra,
    } } } as never);
  };
  return { harness, session, patches, snapshot };
}

describe('incremental session state', () => {
  it('rebuilds the harness state from patches alone, at every revision', () => {
    const { harness, session, patches, snapshot } = setup();
    let local = harness.readSessionSnapshot(session);
    snapshot([message('m1', 'Hel')]);
    snapshot([message('m1', 'Hello')]);
    snapshot([message('m1', 'Hello'), message('m2', 'Done')], { busy: false });
    for (const patch of patches) local = applySessionPatch(local, patch);
    expect(local).toStrictEqual(harness.readSessionSnapshot(session));
    expect(local.state.messages.map(m => m.id)).toStrictEqual(['m1', 'm2']);
  });

  it('sends only the message that changed while text streams', () => {
    const { patches, snapshot } = setup();
    snapshot([message('m0', 'Earlier'), message('m1', 'Hel')]);
    patches.length = 0;
    snapshot([message('m0', 'Earlier'), message('m1', 'Hello')]);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.ops).toStrictEqual([{ op: 'spliceMessages', start: 1, deleteCount: 1, messages: [message('m1', 'Hello')] }]);
  });

  it('inserts older history at the start without resending the rest', () => {
    const { patches, snapshot } = setup();
    snapshot([message('m2', 'Recent')]);
    patches.length = 0;
    snapshot([message('m1', 'Older'), message('m2', 'Recent')]);
    expect(patches[0]!.ops).toStrictEqual([{ op: 'spliceMessages', start: 0, deleteCount: 0, messages: [message('m1', 'Older')] }]);
  });

  it('refuses a patch that skips a revision, so the consumer resyncs from a snapshot', () => {
    const { harness, session, patches, snapshot } = setup();
    const local = harness.readSessionSnapshot(session);
    snapshot([message('m1', 'One')]);
    snapshot([message('m1', 'Two')]);
    expect(() => applySessionPatch(local, patches[1]!)).toThrow(SessionPatchGapError);
    const resynced = harness.readSessionSnapshot(session);
    expect(resynced.revision).toBe(patches[1]!.revision);
    expect((resynced.state as SessionState).messages[0]?.parts[0]).toMatchObject({ text: 'Two' });
  });
});

describe.each(['codex', 'claude', 'cursor', 'antigravity'] as const)('%s session patches', provider => {
  it('replay over JSON to the state the harness reports', () => {
    const { harness, script } = createScriptedHarness(provider);
    const session = harness.open({ id: 'agent', folder: '/work' });
    let local = harness.readSessionSnapshot(session);
    harness.onEvent(event => { if (event.type === 'session.patch' && event.session === session) local = applySessionPatch(local, JSON.parse(JSON.stringify(event.patch))); });
    const base = { agentId: 'agent', provider };
    script.emit({ ...base, type: 'agentRequest.created', payload: { request: { id: 'q1', kind: 'question', conversationId: 'c', question: { delivery: 'tool', blocking: true, questions: [] } } } } as never);
    script.emit({ ...base, type: 'conversation.goalUpdated', payload: { goal: { objective: 'Ship', status: 'active' } } } as never);
    script.emit({ ...base, type: 'agent.updated', payload: { id: 'agent', conversationTitle: 'Release' } } as never);
    script.emit({ ...base, type: 'agentRequest.resolved', payload: { id: 'q1', outcome: { kind: 'cancelled' } } } as never);
    expect(local).toStrictEqual(harness.readSessionSnapshot(session));
    expect(local.state).toMatchObject({ title: 'Release', goal: { objective: 'Ship' }, requests: [] });
  });
});
