import { expect, it, vi } from 'vitest';
import { harnessForHost } from '../../src/internal';
import type { ProviderContext } from '../../src/context';
import type { ProviderDriver, ProviderEvent, ProviderScopedPromptInput } from '../../src/driver';

function fixture() {
  const pending = new Map<string, { input: ProviderScopedPromptInput; resolve: (value: { text: string; session: { kind: 'cursor'; sessionId: string } }) => void; reject: (error: Error) => void }>();
  const released: string[] = [];
  const cancelled: string[] = [];
  const native = {
    onEvent: (_listener: (event: ProviderEvent) => void) => () => {},
    executeScopedPrompt: vi.fn((context: ProviderContext, input: ProviderScopedPromptInput) => new Promise<{ text: string; session: { kind: 'cursor'; sessionId: string } }>((resolve, reject) => pending.set(context.id, { input, resolve, reject }))),
    cancelScopedPrompt: vi.fn(async (context: ProviderContext) => { cancelled.push(context.id); }),
    releaseConversation: vi.fn(async (id: string) => { released.push(id); }),
    close: vi.fn(async () => {}),
  } satisfies Partial<ProviderDriver<ProviderContext, ProviderEvent>>;
  const driver = harnessForHost('cursor', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
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
  const { createInternalHarness } = await import('../../src/internal');
  const { createQueryHarness } = await import('../native/claude/sdk-query-fixture');
  const harness = createQueryHarness();
  const driver = createInternalHarness('claude', { client: { name: 'cpa' }, claude: { transportOptions: { createQuery: harness.createQuery } } });
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
  const { createInternalHarness } = await import('../../src/internal');
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
  const driver = createInternalHarness('codex', { client: { name: 'cpa' }, codex: { host: { client: new CodexAppServerClient(transport) } } });
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

it('runs a new scope with the parent session\'s defaults', async () => {
  const seen: unknown[] = [];
  const native = {
    onEvent: () => () => {}, getCapabilities: () => ({}), close: async () => {},
    executeScopedPrompt: async (context: { providerDefaults?: unknown }) => { seen.push(structuredClone(context.providerDefaults)); return { text: 'ok', session: { kind: 'cursor', sessionId: 'scope-1' } }; },
    disposeScopedSession: async () => {},
  };
  const { harnessForHost } = await import('../../src/internal');
  const harness = harnessForHost('cursor', native as never);
  const main = harness.restoreSession({ id: 'main', folder: '/work', defaults: { model: 'beta', reasoningEffort: 'xhigh' } }, { provider: 'cursor', data: { kind: 'cursor', sessionId: 's' }, role: 'main' });
  await harness.executeScopedPrompt(main, { prompt: 'review', cwd: '/work', scope: { id: 'r' } });
  expect(seen[0]).toMatchObject({ kind: 'cursor', model: 'beta', reasoningEffort: 'xhigh' });
});

it('opens a scope ahead of its run and steers it while it executes', async () => {
  let release!: () => void;
  const steered: string[] = [];
  const native = {
    onEvent: () => () => {}, getCapabilities: () => ({}), close: async () => {},
    executeScopedPrompt: async () => { await new Promise<void>(resolve => { release = resolve; }); return { text: 'done', session: { kind: 'cursor', sessionId: 'scope-1' } }; },
    steerPrompt: async (context: { id: string }) => { steered.push(context.id); return { providerSession: { kind: 'cursor', sessionId: 'scope-1' }, turnId: 't' }; },
    disposeScopedSession: async () => {},
  };
  const { harnessForHost } = await import('../../src/internal');
  const harness = harnessForHost('cursor', native as never);
  const main = harness.restoreSession({ id: 'main', folder: '/work' }, { provider: 'cursor', data: { kind: 'cursor', sessionId: 's' }, role: 'main' });
  const scope = harness.openScope(main, { cwd: '/work' });
  const running = harness.executeScopedPrompt(main, { prompt: 'review', cwd: '/work', scope: { id: 'r' }, session: scope });
  await new Promise(resolve => setTimeout(resolve, 5));
  await harness.steerPrompt(scope, 'adjust');
  expect(steered).toHaveLength(1);
  expect(steered[0]).toContain(':scope:');
  release();
  expect((await running).text).toBe('done');
});
