import { expect, it, vi } from 'vitest';
import { adaptHarnessDriver } from '../../src/consumer';
import type { HarnessContext } from '../../src/context';
import type { HarnessDriver, HarnessEvent, HarnessScopedPromptInput } from '../../src/driver';

function fixture() {
  const pending = new Map<string, { input: HarnessScopedPromptInput; resolve: (value: { text: string; session: { kind: 'cursor'; sessionId: string } }) => void; reject: (error: Error) => void }>();
  const released: string[] = [];
  const cancelled: string[] = [];
  const native = {
    onEvent: (_listener: (event: HarnessEvent) => void) => () => {},
    executeScopedPrompt: vi.fn((context: HarnessContext, input: HarnessScopedPromptInput) => new Promise<{ text: string; session: { kind: 'cursor'; sessionId: string } }>((resolve, reject) => pending.set(context.id, { input, resolve, reject }))),
    cancelScopedPrompt: vi.fn(async (context: HarnessContext) => { cancelled.push(context.id); }),
    releaseConversation: vi.fn(async (id: string) => { released.push(id); }),
    close: vi.fn(async () => {}),
  } satisfies Partial<HarnessDriver<HarnessContext, HarnessEvent>>;
  const driver = adaptHarnessDriver('cursor', native as unknown as HarnessDriver<HarnessContext, HarnessEvent>);
  return { driver, native, pending, released, cancelled };
}

it('cancels a fresh scope before its first frame and cleans a late native admission without racing native settlement', async () => {
  const { driver, pending, native, released, cancelled } = fixture();
  const main = driver.open({ id: 'main', folder: '/ledger' });
  const abort = new AbortController();
  const first = driver.executeScopedPrompt(main, { cwd: '/ledger', prompt: 'private', scope: { id: 'private' }, signal: abort.signal });
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const firstId = native.executeScopedPrompt.mock.calls[0]![0].id;
  const second = driver.executeScopedPrompt(main, { cwd: '/ledger', prompt: 'concurrent', scope: { id: 'other' } });
  const secondId = native.executeScopedPrompt.mock.calls[1]![0].id;
  let settled = false; void first.then(() => { settled = true; }, () => { settled = true; });
  abort.abort();
  await vi.waitFor(() => expect(cancelled).toEqual([firstId]));
  expect(pending.get(firstId)!.input.signal).toBe(abort.signal);
  expect(settled).toBe(false);
  expect(cancelled).not.toContain('main'); expect(cancelled).not.toContain(secondId);
  pending.get(firstId)!.resolve({ text: 'late admission', session: { kind: 'cursor', sessionId: 'late' } });
  await rejected;
  expect(released).toContain(firstId);
  expect(released).not.toContain('main'); expect(released).not.toContain(secondId);
  pending.get(secondId)!.resolve({ text: 'unaffected', session: { kind: 'cursor', sessionId: 'other' } });
  expect((await second).text).toBe('unaffected');
  expect(driver.readSession(main).busy).toBe(false);
  await driver.close();
});

it('does not admit an already-aborted scope', async () => {
  const { driver, native } = fixture();
  const main = driver.open({ id: 'main', folder: '/ledger' });
  const abort = new AbortController(); abort.abort();
  await expect(driver.executeScopedPrompt(main, { cwd: '/ledger', prompt: 'none', scope: { id: 'none' }, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(native.executeScopedPrompt).not.toHaveBeenCalled();
  expect(native.cancelScopedPrompt).not.toHaveBeenCalled();
  await driver.close();
});

it('Claude cancels a fresh native query before provider session admission', async () => {
  const { createHarnessDriver } = await import('../../src/index');
  const { createQueryHarness } = await import('../native/claude/sdk-query-fixture');
  const harness = createQueryHarness();
  const driver = createHarnessDriver('claude', { client: { name: 'cpa' }, claude: { transportOptions: { createQuery: harness.createQuery } } });
  const main = driver.open({ id: 'main', folder: '/tmp' });
  const abort = new AbortController();
  try {
    const pending = driver.executeScopedPrompt(main, { cwd: '/tmp', prompt: 'wait', scope: { id: 'private' }, signal: abort.signal });
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(harness.inputs).toHaveLength(1));
    abort.abort();
    await cancelled;
    expect(harness.runtimes[0]!.interrupt).toHaveBeenCalledOnce();
    expect(driver.readSession(main).messages).toEqual([]);
  } finally { await driver.close(); }
});

it.each(['before-admission', 'active'] as const)('Codex cancels a private native scope at %s without admitting late work', async phase => {
  const { createHarnessDriver } = await import('../../src/index');
  const { CodexAppServerClient } = await import('@korus-dev/codex-sdk');
  const { MockCodexAppServer, resumeResponse, thread, turn, deferred, requestsFor } = await import('../codex/helpers/host-fixture');
  const admission = deferred<ReturnType<typeof resumeResponse>>();
  const transport = new MockCodexAppServer({
    'thread/start': () => phase === 'before-admission' ? admission.promise : resumeResponse(thread('private-thread', false)),
    'thread/resume': () => resumeResponse(thread('private-thread', false)),
    'thread/settings/update': () => ({}),
    'turn/start': () => ({ turn: turn('private-turn', 'inProgress', []) }),
    'turn/interrupt': () => { queueMicrotask(() => transport.emitNotification('turn/completed', { threadId: 'private-thread', turn: turn('private-turn', 'interrupted', []) })); return {}; },
  });
  const driver = createHarnessDriver('codex', { client: { name: 'cpa' }, codex: { host: { client: new CodexAppServerClient(transport) } } });
  const main = driver.open({ id: 'main', folder: '/tmp' });
  const abort = new AbortController();
  try {
    const pending = driver.executeScopedPrompt(main, { cwd: '/tmp', prompt: 'wait', scope: { id: 'private' }, signal: abort.signal });
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(requestsFor(transport, phase === 'before-admission' ? 'thread/start' : 'turn/start')).toHaveLength(1));
    abort.abort();
    if (phase === 'before-admission') admission.resolve(resumeResponse(thread('private-thread', false)));
    await cancelled;
    expect(requestsFor(transport, 'turn/start')).toHaveLength(phase === 'before-admission' ? 0 : 1);
    expect(requestsFor(transport, 'turn/interrupt')).toHaveLength(phase === 'before-admission' ? 0 : 1);
    expect(driver.readSession(main).messages).toEqual([]);
  } finally { await driver.close(); }
});
