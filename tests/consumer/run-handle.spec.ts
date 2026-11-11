import { describe, expect, it } from 'vitest';
import { createScriptedHarness } from '../../src/testing';
import { emptyCursorSnapshot } from '../../src/conversations/cursor-conversation-replica';
import type { Run, RunEvent } from '../../src';

// A run follows one prompt to the end of its turn, from the neutral events every harness reports.
const at = '2026-11-11T10:00:00.000Z';
function cursor() {
  const { harness, script } = createScriptedHarness('cursor');
  const session = harness.open({ id: 'agent', folder: '/work' });
  let revision = 1;
  script.emit({ type: 'cursor.conversationSnapshotChanged', agentId: 'agent', provider: 'cursor', payload: { revision, snapshot: emptyCursorSnapshot('agent', 'session') } } as never);
  const frame = (event: Record<string, unknown>) => script.emit({ type: 'cursor.conversationEventReceived', agentId: 'agent', provider: 'cursor',
    payload: { revision: ++revision, event: { agentId: 'agent', sessionId: 'session', occurredAt: at, ...event } } } as never);
  return {
    harness, script, session,
    started: (turnId: string) => frame({ type: 'turn.started', turnId, payload: {} }),
    said: (turnId: string, id: string, text: string) => frame({ type: 'message.upsert', turnId,
      payload: { message: { id, agentId: 'agent', role: 'assistant', status: 'complete', turnId, createdAt: at, parts: [{ type: 'text', text }] } } }),
    completed: (turnId: string, status = 'completed', extra: Record<string, unknown> = {}) => frame({ type: 'turn.completed', turnId, payload: { turn: { id: turnId, status }, ...extra } }),
  };
}
async function drain(run: Run): Promise<RunEvent[]> {
  const seen: RunEvent[] = [];
  for await (const event of run.events) seen.push(event);
  return seen;
}
const turnEvents = (events: RunEvent[]) => events.filter(event => event.type.startsWith('turn.')).map(event => [event.type, 'turnId' in event ? event.turnId : undefined]);
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

describe('run', () => {
  it('yields its turn and ends with it, reporting how it ended and what the agent said', async () => {
    const { harness, session, started, said, completed } = cursor();
    const run = harness.run(session, 'Hello?');
    expect(await run.admission).toMatchObject({ turnId: 'turn-1' });
    started('turn-1'); said('turn-1', 'm1', 'Hi there.'); completed('turn-1');
    said('turn-1', 'm2', 'too late');
    const events = await drain(run);
    expect(turnEvents(events)).toEqual([['turn.started', 'turn-1'], ['turn.output', 'turn-1'], ['turn.completed', 'turn-1']]);
    expect(events.at(-1)?.type).toBe('turn.completed');
    const result = await run.result;
    expect(result).toMatchObject({ session, turnId: 'turn-1', status: 'completed', error: null });
    expect(result.messages.map(message => message.id)).toEqual(['m1']);
  });

  it('ignores the end of another turn and waits out a turn the provider retries', async () => {
    const { harness, session, started, completed } = cursor();
    const run = harness.run(session, 'Again');
    await run.admission;
    completed('turn-0');
    started('turn-1'); completed('turn-1', 'failed', { willRetry: true }); completed('turn-1', 'failed');
    expect(turnEvents(await drain(run))).toEqual([['turn.started', 'turn-1'], ['turn.completed', 'turn-1'], ['turn.completed', 'turn-1']]);
    expect(await run.result).toMatchObject({ turnId: 'turn-1', status: 'failed' });
  });

  it('keeps what happened before admission, and finds its turn when admission names none', async () => {
    const { harness, script, session, started, completed } = cursor();
    const admission = deferred<unknown>();
    script.on('sendPrompt', () => admission.promise);
    const run = harness.run(session, 'Go');
    started('turn-7');
    admission.resolve({ providerSession: { kind: 'cursor', sessionId: 'session', folder: '/work' } });
    await run.admission;
    completed('turn-7');
    expect(turnEvents(await drain(run))).toEqual([['turn.started', 'turn-7'], ['turn.completed', 'turn-7']]);
    expect(await run.result).toMatchObject({ turnId: 'turn-7', status: 'completed' });
  });

  it('rejects its events and result when the prompt is not admitted', async () => {
    const { harness, script, session } = cursor();
    script.on('sendPrompt', () => Promise.reject(new Error('Busy.')));
    const run = harness.run(session, 'Go');
    await expect(run.admission).rejects.toThrow('Busy.');
    await expect(drain(run)).rejects.toThrow('Busy.');
    await expect(run.result).rejects.toThrow('Busy.');
  });

  it('rejects when the session is released or the harness closes before the turn ends', async () => {
    const first = cursor();
    const released = first.harness.run(first.session, 'Go');
    await released.admission;
    await first.harness.release(first.session);
    await expect(released.result).rejects.toThrow('released');
    const second = cursor();
    const closed = second.harness.run(second.session, 'Go');
    await closed.admission;
    await second.harness.close();
    await expect(closed.result).rejects.toThrow('closed');
  });

  it('still settles its result when the consumer stops reading its events', async () => {
    const { harness, session, started, completed } = cursor();
    const run = harness.run(session, 'Go');
    await run.admission;
    started('turn-1');
    for await (const event of run.events) { expect(event.type).toBe('turn.started'); break; }
    completed('turn-1');
    expect(await run.result).toMatchObject({ status: 'completed' });
  });

  it('steers and interrupts its own turn', async () => {
    const { harness, script, session, started } = cursor();
    const run = harness.run(session, 'Go');
    await run.admission;
    started('turn-1');
    await run.steer('Also check the tests.');
    await run.interrupt();
    expect(script.calls('steerPrompt')[0]?.args[1]).toBe('Also check the tests.');
    expect(script.calls('interrupt')[0]?.args[1]).toBe('turn-1');
  });
});
