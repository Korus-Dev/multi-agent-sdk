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
