import { describe, expect, it, vi } from 'vitest';
import type {
  CodexSnapshot,
  CodexStatePatch,
  ConversationMessage,
} from '../../src/core/codex-host';
import {
  applyCodexHostStateChanges,
  createCodexHostStateMirror,
  diffCodexHostState,
  subscribeCodexHostState,
} from '../../src/core/codex-host-state';

function message(id: string, text: string): ConversationMessage {
  return { id, role: 'assistant', status: 'complete', parts: [{ type: 'text', text }] };
}

function snapshot(messages: ConversationMessage[], extra: Partial<CodexSnapshot> = {}): CodexSnapshot {
  return { busy: false, messages, answeredClientRequestIds: [], ...extra } as unknown as CodexSnapshot;
}

/** Simulates a transport: the receiver only ever sees serialized copies. */
function overTheWire<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

describe('host state patches', () => {
  it('ships only changed list items and preserves identity for the rest', () => {
    const history = Array.from({ length: 50 }, (_, index) => message(`m${index}`, `answer ${index}`));
    const before = snapshot([...history, message('live', 'Hel')]);
    const after = { ...before, busy: true, messages: [...history, message('live', 'Hello')] };
    const receiverBase = overTheWire(before);

    const changes = overTheWire(diffCodexHostState(before, after));
    const received = applyCodexHostStateChanges(receiverBase, changes);

    expect(changes).toStrictEqual([
      { type: 'set', key: 'busy', value: true },
      { type: 'list', key: 'messages', ids: [...history.map((item) => item.id), 'live'], items: [message('live', 'Hello')] },
    ]);
    expect(received).toStrictEqual(after);
    expect(received.messages.slice(0, 50).every((item, index) => item === receiverBase.messages[index])).toBe(true);
    expect(receiverBase.messages[50]).toStrictEqual(message('live', 'Hel'));
  });

  it('handles reordering, removal, and deleted keys', () => {
    const first = message('a', 'A');
    const second = message('b', 'B');
    const third = message('c', 'C');
    const before = snapshot([first, second, third], { executionPlan: { turnId: 't' } } as Partial<CodexSnapshot>);
    const after = snapshot([third, first]);
    Object.assign(after, { busy: before.busy, answeredClientRequestIds: before.answeredClientRequestIds });

    const received = applyCodexHostStateChanges(before, diffCodexHostState(before, after));

    expect(received).toStrictEqual(after);
    expect('executionPlan' in received).toBe(false);
    expect(received.messages[0]).toBe(third);
  });

  it('replaces lists that cannot be merged safely by id', () => {
    const duplicate = [message('same', 'one'), message('same', 'two')];
    const before = snapshot([message('same', 'one')]);
    const after = { ...before, messages: duplicate };

    expect(diffCodexHostState(before, after)).toStrictEqual([{ type: 'set', key: 'messages', value: duplicate }]);
    expect(diffCodexHostState(before, { ...before, answeredClientRequestIds: ['request-1'] })).toStrictEqual([
      { type: 'set', key: 'answeredClientRequestIds', value: ['request-1'] },
    ]);
    expect(() => applyCodexHostStateChanges(before, [
      { type: 'list', key: 'messages', ids: ['missing'], items: [] },
    ])).toThrow("unknown 'messages' item 'missing'");
  });
});

describe('host state mirror', () => {
  const base = snapshot([message('a', 'A')]);
  const patch = (version: number, busy: boolean): CodexStatePatch => ({
    version,
    changes: [{ type: 'set', key: 'busy', value: busy }],
  });

  it('applies sequential patches and ignores ones it already has', () => {
    const mirror = createCodexHostStateMirror();
    mirror.reset({ version: 3, snapshot: base });

    expect(mirror.receive(patch(4, true))).toStrictEqual({ status: 'applied', snapshot: { ...base, busy: true } });
    expect(mirror.receive(patch(4, false))).toStrictEqual({ status: 'ignored' });
    expect(mirror.snapshot?.busy).toBe(true);
  });

  it('asks for a new base on a gap and replays only newer buffered patches', () => {
    const mirror = createCodexHostStateMirror();
    expect(mirror.receive(patch(1, true))).toStrictEqual({ status: 'resync' });
    mirror.reset({ version: 1, snapshot: base });
    expect(mirror.receive(patch(3, true))).toStrictEqual({ status: 'resync' });
    expect(mirror.receive(patch(4, false))).toStrictEqual({ status: 'resync' });

    expect(mirror.reset({ version: 3, snapshot: { ...base, busy: true } })).toStrictEqual({ ...base, busy: false });
    expect(mirror.receive(patch(5, true))).toMatchObject({ status: 'applied' });
  });

  it('asks for a new base instead of applying a patch that does not fit', () => {
    const mirror = createCodexHostStateMirror();
    mirror.reset({ version: 1, snapshot: base });

    expect(mirror.receive({ version: 2, changes: [{ type: 'list', key: 'busy', ids: [], items: [] }] }))
      .toStrictEqual({ status: 'resync' });
    expect(mirror.snapshot).toBe(base);
  });
});

describe('subscribeCodexHostState', () => {
  it('mirrors a patch source from its versioned base', async () => {
    let emit: ((patch: CodexStatePatch) => void) | undefined;
    const kept = message('a', 'A');
    const source = {
      getVersionedSnapshot: vi.fn(async () => ({ version: 7, snapshot: snapshot([kept]) })),
      onStatePatch: (listener: (patch: CodexStatePatch) => void) => { emit = listener; return () => { emit = undefined; }; },
      onStateChange: vi.fn(() => () => undefined),
    };
    const received: CodexSnapshot[] = [];

    const unsubscribe = subscribeCodexHostState(source, (value) => received.push(value));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    emit!({ version: 8, changes: [{ type: 'list', key: 'messages', ids: ['a', 'b'], items: [message('b', 'B')] }] });
    await vi.waitFor(() => expect(received).toHaveLength(2));

    expect(received[1]!.messages.map((item) => item.id)).toStrictEqual(['a', 'b']);
    expect(received[1]!.messages[0]).toBe(received[0]!.messages[0]);
    expect(source.onStateChange).not.toHaveBeenCalled();
    unsubscribe();
    expect(emit).toBeUndefined();
  });

  it('retries a failed base request when the next patch arrives', async () => {
    let emit: ((patch: CodexStatePatch) => void) | undefined;
    const getVersionedSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error('main process busy'))
      .mockResolvedValueOnce({ version: 1, snapshot: snapshot([]) });
    const received: CodexSnapshot[] = [];
    subscribeCodexHostState({
      getVersionedSnapshot,
      onStatePatch: (listener) => { emit = listener; return () => undefined; },
      onStateChange: () => () => undefined,
    }, (value) => received.push(value));
    await vi.waitFor(() => expect(getVersionedSnapshot).toHaveBeenCalledOnce());
    await Promise.resolve();

    emit!({ version: 2, changes: [{ type: 'set', key: 'busy', value: true }] });

    await vi.waitFor(() => expect(received).toStrictEqual([snapshot([], { busy: true })]));
  });

  it('falls back to snapshots when the other side cannot stream patches', async () => {
    let pushSnapshot: ((value: CodexSnapshot) => void) | undefined;
    const stopPatches = vi.fn();
    const received: CodexSnapshot[] = [];
    const unsubscribe = subscribeCodexHostState({
      getVersionedSnapshot: async () => null,
      onStatePatch: () => stopPatches,
      onStateChange: (listener) => { pushSnapshot = listener; return () => { pushSnapshot = undefined; }; },
    }, (value) => received.push(value));
    await vi.waitFor(() => expect(pushSnapshot).toBeDefined());

    pushSnapshot!(snapshot([], { busy: true }));
    unsubscribe();

    expect(stopPatches).toHaveBeenCalledOnce();
    expect(received).toStrictEqual([snapshot([], { busy: true })]);
    expect(pushSnapshot).toBeUndefined();
  });

  it('can stay silent about a base another channel already delivered', async () => {
    let emit: ((patch: CodexStatePatch) => void) | undefined;
    let resolveBase: ((value: { version: number; snapshot: CodexSnapshot }) => void) | undefined;
    const received: CodexSnapshot[] = [];
    subscribeCodexHostState({
      getVersionedSnapshot: () => new Promise((resolve) => { resolveBase = resolve; }),
      onStatePatch: (listener) => { emit = listener; return () => undefined; },
    }, (value) => received.push(value), { emitInitialSnapshot: false });
    await vi.waitFor(() => expect(resolveBase).toBeDefined());

    resolveBase!({ version: 1, snapshot: snapshot([]) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toStrictEqual([]);
    emit!({ version: 2, changes: [{ type: 'set', key: 'busy', value: true }] });

    expect(received).toStrictEqual([snapshot([], { busy: true })]);
  });

  it('falls back to full snapshots when patches are unavailable', () => {
    const unsubscribe = vi.fn();
    const source = { onStateChange: vi.fn(() => unsubscribe) };
    const listener = vi.fn();

    subscribeCodexHostState(source, listener)();

    expect(source.onStateChange).toHaveBeenCalledWith(listener);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
