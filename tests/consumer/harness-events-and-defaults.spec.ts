import { expect, it, vi } from 'vitest';
import { adaptHarness } from '../../src/consumer';
import type { ProviderContext } from '../../src/context';
import type { ProviderDriver, ProviderEvent } from '../../src/driver';
import type { HarnessEvent } from '../../src';

function fixture() {
  let deliver!: (event: ProviderEvent) => void;
  const seen: unknown[] = [];
  const native = {
    onEvent: (listener: typeof deliver) => { deliver = listener; return () => {}; },
    getCapabilities: () => ({ permissionModes: [{ id: 'default' }] }),
    sendPrompt: vi.fn(async (context: ProviderContext) => { seen.push(structuredClone(context.providerDefaults)); return { providerSession: { kind: 'cursor' as const, sessionId: context.id } }; }),
    close: vi.fn(async () => {}),
  };
  const harness = adaptHarness('cursor', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  return { harness, native, seen, deliver: (event: ProviderEvent) => deliver(event) };
}

it('forwards provider events to listeners, with the session they belong to when there is one', () => {
  const { harness, deliver } = fixture();
  const session = harness.open({ id: 'chat', folder: '/work' });
  const events: HarnessEvent[] = []; harness.onEvent(event => events.push(event));
  const frame = { type: 'cursor.conversationSnapshotChanged', provider: 'cursor', agentId: 'chat', payload: { revision: 1, snapshot: {} } } as unknown as ProviderEvent;
  deliver(frame);
  deliver({ ...frame, agentId: 'someone-else' } as ProviderEvent);
  const unowned = { type: 'provider.authenticationChanged', provider: 'cursor', payload: { connected: false } } as unknown as ProviderEvent;
  deliver(unowned);
  expect(events.filter(event => event.type === 'provider.event')).toEqual([
    { type: 'provider.event', session, event: frame },
    { type: 'provider.event', session: undefined, event: { ...frame, agentId: 'someone-else' } },
    { type: 'provider.event', session: undefined, event: unowned },
  ]);
});

it('applies new session defaults to the next native call without reopening the session', async () => {
  const { harness, seen } = fixture();
  const session = harness.open({ id: 'chat', folder: '/work', defaults: { model: 'fast' } });
  await harness.sendPrompt(session, 'one');
  harness.updateDefaults(session, { model: 'deep', reasoningEffort: 'high' });
  await harness.sendPrompt(session, 'two');
  expect(seen[0]).toMatchObject({ kind: 'cursor', model: 'fast' });
  expect(seen[1]).toMatchObject({ kind: 'cursor', model: 'deep', reasoningEffort: 'high' });
});

it('reports the provider-level capabilities without needing a session', () => {
  const native = { onEvent: () => () => {}, close: async () => {}, getCapabilities: () => ({ steerPrompt: false, permissionModes: [{ id: 'default' }, { id: 'full-access', dangerous: true }] }) };
  const harness = adaptHarness('cursor', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  expect(harness.getProviderCapabilities()).toMatchObject({ steerPrompt: false, permissions: [{ id: 'default' }, { id: 'full-access', dangerous: true }] });
});
