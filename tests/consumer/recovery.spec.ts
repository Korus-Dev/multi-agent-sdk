import { expect, it, vi } from 'vitest';
import { harnessForHost } from '../../src/internal';
import type { ProviderDriver as NativeDriver, ProviderEvent as NativeEvent } from '../../src/driver';
import type { HarnessEvent } from '../../src';
import { emptyCursorSnapshot } from '../../src/conversations/cursor-conversation-replica';

it('surfaces a lost native frame and recovers only from a fresh native snapshot', async () => {
  let deliver!: (event: NativeEvent) => void;
  const native = { onEvent: (listener: typeof deliver) => { deliver = listener; return () => {}; }, close: vi.fn() } as unknown as NativeDriver<import('../../src/context').ProviderContext, NativeEvent>;
  const driver = harnessForHost('cursor', native);
  const session = driver.open({ id: 'tax', folder: '/ledger' });
  const events: HarnessEvent[] = []; driver.onEvent(e => events.push(e));
  const initial = emptyCursorSnapshot('tax', 'native-session');
  const snapshot = (revision: number) => deliver({ type: 'cursor.conversationSnapshotChanged', provider: 'cursor', agentId: 'tax', payload: { revision, snapshot: initial } });
  const started = (revision: number) => deliver({ type: 'cursor.conversationEventReceived', provider: 'cursor', agentId: 'tax', payload: { revision, event: { type: 'turn.started', agentId: 'tax', sessionId: 'native-session', turnId: 't', occurredAt: new Date().toISOString(), payload: { turn: { id: 't' } } } } });
  snapshot(1); started(3);
  expect(events.some(e => e.type === 'recovery.required')).toBe(true);
  expect(driver.readSession(session).busy).toBe(false);
  snapshot(4); started(5); started(5);
  expect(driver.readSession(session).busy).toBe(true);
  expect(driver.readSession(session).turns).toHaveLength(1);
  await driver.close();
});
