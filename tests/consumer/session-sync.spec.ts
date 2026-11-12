import { expect, it, vi } from 'vitest';
import { harnessForHost } from '../../src/internal';
import type { ProviderContext } from '../../src/context';
import type { ProviderDriver, ProviderEvent } from '../../src/driver';

const first = { kind: 'cursor' as const, sessionId: 's1', folder: '/work' };
const second = { kind: 'cursor' as const, sessionId: 's2', folder: '/work' };

it('lets the host app re-state a session\'s stored identity and folder so the provider can enforce its own checks', async () => {
  const seen: ProviderContext[] = [];
  const native = {
    onEvent: () => () => {}, getCapabilities: () => ({}), close: vi.fn(async () => {}),
    sendPrompt: vi.fn(async (context: ProviderContext) => { seen.push(structuredClone(context)); return { providerSession: context.providerSession! }; }),
  };
  const harness = harnessForHost('cursor', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  const session = harness.restoreSession({ id: 'main', folder: '/work', name: 'Main' }, { provider: 'cursor', data: first, role: 'main' });
  harness.syncSession(session, { data: second, folder: '/other', name: 'Renamed' });
  await harness.sendPrompt(session, 'hello');
  expect(seen[0]).toMatchObject({ id: 'main', folder: '/other', name: 'Renamed', providerSession: second });
  expect(harness.getSessionData(session).data).toMatchObject({ sessionId: 's2' });
});

it('rejects stored data that belongs to another provider', () => {
  const harness = harnessForHost('cursor', { onEvent: () => () => {}, getCapabilities: () => ({}), close: async () => {} } as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  const session = harness.open({ id: 'main', folder: '/work' });
  expect(() => harness.syncSession(session, { data: { kind: 'codex', threadId: 't' } as never })).toThrow(/invalid persisted/i);
});

it('clears the stored identity when asked, so the next prompt starts a new conversation', async () => {
  const seen: ProviderContext[] = [];
  const native = { onEvent: () => () => {}, getCapabilities: () => ({}), close: async () => {},
    sendPrompt: async (context: ProviderContext) => { seen.push(structuredClone(context)); return { providerSession: first }; } };
  const harness = harnessForHost('cursor', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  const session = harness.restoreSession({ id: 'main', folder: '/work' }, { provider: 'cursor', data: first, role: 'main' });
  harness.syncSession(session, { data: null });
  await harness.sendPrompt(session, 'fresh');
  expect(seen[0]!.providerSession).toBeUndefined();
});

it('replaces the stored defaults when the host app re-states them, instead of merging with earlier ones', async () => {
  const seen: unknown[] = [];
  const native = { onEvent: () => () => {}, getCapabilities: () => ({}), close: async () => {},
    sendPrompt: async (context: ProviderContext) => { seen.push(structuredClone(context.providerDefaults)); return { providerSession: first }; } };
  const harness = harnessForHost('cursor', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  const session = harness.restoreSession({ id: 'main', folder: '/work', defaults: { model: 'alpha', reasoningEffort: 'high' } }, { provider: 'cursor', data: first, role: 'main' });
  harness.syncSession(session, { defaults: { model: 'beta' } });
  await harness.sendPrompt(session, 'hello');
  expect(seen[0]).toStrictEqual({ kind: 'cursor', model: 'beta' });
});

it('lets a provider operation in flight see what the app re-states meanwhile', async () => {
  const record = { data: first as typeof first | null, folder: '/work' as string | null };
  let during: { providerSession?: unknown; folder: string | null } | undefined;
  const native = { onEvent: () => () => {}, getCapabilities: () => ({}), close: async () => {},
    sendPrompt: async (context: ProviderContext) => {
      record.data = second; record.folder = '/moved';
      harness.syncSession(session, { data: record.data, folder: record.folder });
      during = { providerSession: context.providerSession, folder: context.folder };
      return { providerSession: second };
    } };
  const harness = harnessForHost('cursor', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  const session = harness.restoreSession({ id: 'main', folder: '/work' }, { provider: 'cursor', data: first, role: 'main' });
  await harness.sendPrompt(session, 'hello');
  expect(during).toMatchObject({ providerSession: second, folder: '/moved' });
});

it.each([
  ['codex', (id: string) => ({ kind: 'codex' as const, threadId: id })],
  ['antigravity', (id: string) => ({ kind: 'antigravity' as const, sessionId: id })],
] as const)('starts a new %s conversation after the identity is cleared, instead of carrying on in the one it holds', async (provider, stored) => {
  const order: string[] = [];
  const native = { onEvent: () => () => {}, getCapabilities: () => ({}), close: async () => {},
    releaseConversation: async (id: string) => { await Promise.resolve(); order.push(`release:${id}`); },
    sendPrompt: async (context: ProviderContext) => { order.push(`prompt:${context.providerSession ? 'old' : 'new'}`); return { providerSession: stored('t2') }; } };
  const harness = harnessForHost(provider, native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  const session = harness.restoreSession({ id: 'main', folder: '/work' }, { provider, data: stored('t1'), role: 'main' } as never);
  harness.syncSession(session, { data: null });
  await harness.sendPrompt(session, 'fresh');
  expect(order).toStrictEqual(['release:main', 'prompt:new']);
  // Nothing to let go of when no conversation was stored, or when the identity is back before the next prompt.
  const other = harness.open({ id: 'other', folder: '/work' });
  harness.syncSession(other, { data: null });
  await harness.sendPrompt(other, 'first');
  harness.syncSession(session, { data: null });
  harness.syncSession(session, { data: stored('t2') as never });
  await harness.sendPrompt(session, 'same conversation');
  expect(order).toStrictEqual(['release:main', 'prompt:new', 'prompt:new', 'prompt:old']);
});

it('sends a changed selection with the next prompt once, under what that prompt asks for itself', async () => {
  const sent: unknown[] = [];
  const native = { onEvent: () => () => {}, getCapabilities: () => ({}), close: async () => {},
    sendPrompt: async (_context: ProviderContext, _prompt: string, options?: { selection?: unknown }) => { sent.push(options?.selection); return { providerSession: first }; } };
  const harness = harnessForHost('cursor', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  const session = harness.restoreSession({ id: 'main', folder: '/work' }, { provider: 'cursor', data: first, role: 'main' });
  await harness.sendPrompt(session, 'as is');
  harness.updateDefaults(session, { model: 'new', reasoningEffort: 'high', serviceTier: 'fast' });
  await harness.sendPrompt(session, 'changed', { selection: { reasoningEffort: 'low' } } as never);
  await harness.sendPrompt(session, 'settled');
  harness.syncSession(session, { defaults: { model: 'stored', reasoningEffort: 'high' } });
  await harness.sendPrompt(session, 're-stated');
  // A conversation keeps its own settings until the app changes them; the change travels with one prompt.
  expect(sent).toStrictEqual([undefined, { model: 'new', reasoningEffort: 'low', serviceTier: 'fast' }, undefined, undefined]);
});
