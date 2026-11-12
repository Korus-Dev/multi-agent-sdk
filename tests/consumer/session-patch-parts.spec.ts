import { describe, expect, it } from 'vitest';
import { applySessionPatch, diffSessionState, emptyPatchBase, SessionPatchInvalidError } from '../../src/session-patch';
import type { Message, SessionPatchOp, SessionSnapshot, SessionState } from '../../src';

// Streaming sends what changed inside a message, not the message again.
const state = (messages: Message[]): SessionState => ({ messages, busy: true, activeTurnId: 't', turns: [], requests: [], error: null, title: null, goal: null, contextUsage: null, plan: null });
const message = (id: string, parts: Message['parts'], extra: Partial<Message> = {}): Message => ({ id, agentId: 'a', turnId: 't', role: 'assistant', status: 'streaming', createdAt: '2026-11-11T00:00:00.000Z', parts, ...extra });
const tool = (id: string, status: string, output?: string) => ({ type: 'tool', id, name: 'shell', status, ...(output === undefined ? {} : { output }) }) as never;

function step(before: SessionState, after: SessionState): { ops: SessionPatchOp[]; replayed: SessionState } {
  const base = diffSessionState(emptyPatchBase(), before).base;
  const { ops } = diffSessionState(base, after);
  const snapshot: SessionSnapshot = { revision: 0, state: JSON.parse(JSON.stringify(before)) };
  const replayed = applySessionPatch(snapshot, JSON.parse(JSON.stringify({ revision: 1, ops }))).state;
  return { ops, replayed };
}

describe('message-level session patches', () => {
  it('appends streamed text instead of resending the message', () => {
    const big = 'x'.repeat(20_000);
    const { ops, replayed } = step(
      state([message('m0', [{ type: 'text', text: 'Earlier' }]), message('m1', [tool('t1', 'completed', big), { type: 'text', text: 'Hel' }])]),
      state([message('m0', [{ type: 'text', text: 'Earlier' }]), message('m1', [tool('t1', 'completed', big), { type: 'text', text: 'Hello' }])]));
    expect(ops).toStrictEqual([{ op: 'appendPartText', index: 1, part: 1, field: 'text', text: 'lo' }]);
    expect(replayed.messages[1]!.parts[1]).toMatchObject({ text: 'Hello' });
    expect(JSON.stringify(ops).length).toBeLessThan(200);
  });

  it('replaces only the part that changed', () => {
    const { ops, replayed } = step(
      state([message('m1', [{ type: 'text', text: 'Run' }, tool('t1', 'running')])]),
      state([message('m1', [{ type: 'text', text: 'Run' }, tool('t1', 'completed', 'ok')])]));
    expect(ops).toStrictEqual([{ op: 'spliceParts', index: 0, start: 1, deleteCount: 1, parts: [tool('t1', 'completed', 'ok')] }]);
    expect(replayed.messages[0]!.parts).toHaveLength(2);
  });

  it('adds a new part and updates message fields without resending earlier parts', () => {
    const after = state([message('m1', [{ type: 'text', text: 'Run' }, tool('t1', 'running')], { status: 'complete' })]);
    const { ops, replayed } = step(state([message('m1', [{ type: 'text', text: 'Run' }])]), after);
    expect(ops).toStrictEqual([
      { op: 'setMessageFields', index: 0, fields: { status: 'complete' } },
      { op: 'spliceParts', index: 0, start: 1, deleteCount: 0, parts: [tool('t1', 'running')] },
    ]);
    expect(replayed).toStrictEqual(JSON.parse(JSON.stringify(after)));
  });

  it('removes a message field that went away', () => {
    const before = state([message('m1', [{ type: 'text', text: 'Hi' }], { metadata: { promptContent: [] } })]);
    const after = state([message('m1', [{ type: 'text', text: 'Hi' }])]);
    const { ops, replayed } = step(before, after);
    expect(ops).toStrictEqual([{ op: 'setMessageFields', index: 0, fields: {}, remove: ['metadata'] }]);
    expect(replayed).toStrictEqual(JSON.parse(JSON.stringify(after)));
  });

  it('resends a message whose identity changed, and messages that were added or removed', () => {
    const { ops } = step(state([message('m1', [{ type: 'text', text: 'One' }])]), state([message('m2', [{ type: 'text', text: 'One' }])]));
    expect(ops.map(op => op.op)).toStrictEqual(['spliceMessages']);
  });

  it('patches several changed messages in one revision, such as a phase flip earlier in the turn', () => {
    const before = state([message('m1', [{ type: 'text', text: 'Looking', phase: 'final_answer' }]), message('m2', [{ type: 'text', text: 'Do' }])]);
    const after = state([message('m1', [{ type: 'text', text: 'Looking', phase: 'commentary' }]), message('m2', [{ type: 'text', text: 'Done' }])]);
    const { ops, replayed } = step(before, after);
    expect(ops.map(op => op.op)).toStrictEqual(['spliceParts', 'appendPartText']);
    expect(replayed).toStrictEqual(JSON.parse(JSON.stringify(after)));
  });

  it.each([
    [{ op: 'appendPartText', index: 5, part: 0, field: 'text', text: 'x' }, 'outside the transcript'],
    [{ op: 'appendPartText', index: 0, part: 3, field: 'text', text: 'x' }, 'outside the message'],
    [{ op: 'appendPartText', index: 0, part: 0, field: '__proto__', text: 'x' }, 'not text'],
    [{ op: 'appendPartText', index: 0, part: 0, field: 'type', text: 5 }, 'not text'],
    [{ op: 'spliceParts', index: 0, start: 4, deleteCount: 0, parts: [] }, 'outside the message'],
    [{ op: 'spliceParts', index: 0, start: 0, deleteCount: 0, parts: 'no' }, 'not a list'],
    [{ op: 'setMessageFields', index: 0, fields: { parts: [] } }, 'cannot be set'],
    [{ op: 'setMessageFields', index: 0, fields: JSON.parse('{"__proto__":{"x":1}}') }, 'cannot be set'],
    [{ op: 'setMessageFields', index: 0, fields: {}, remove: ['parts'] }, 'cannot be set'],
  ])('refuses an invalid op %j', (op, detail) => {
    const snapshot: SessionSnapshot = { revision: 0, state: state([message('m1', [{ type: 'text', text: 'Hi' }])]) };
    expect(() => applySessionPatch(snapshot, { revision: 1, ops: [op as never] })).toThrow(SessionPatchInvalidError);
    expect(() => applySessionPatch(snapshot, { revision: 1, ops: [op as never] })).toThrow(detail);
  });
});
