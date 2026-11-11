import { expect, it, vi } from 'vitest';
import { adaptHarness } from '../../src/consumer';
import type { ProviderDriver as NativeDriver } from '../../src/driver';

it('publishes authoritative goal mutation results even when the native transport emits no goal frame', async () => {
  const goal = { threadId: 'native', objective: 'Finish checks', status: 'active' as const, tokenBudget: null, tokensUsed: 0,
    timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 };
  const native = { onEvent: () => () => {}, close: vi.fn(),
    setGoal: async () => ({ providerSession: { kind: 'claude', sessionId: 'native', transport: 'stdio' }, goal }),
    clearGoal: async () => ({ providerSession: { kind: 'claude', sessionId: 'native', transport: 'stdio' }, cleared: true }),
  } as unknown as NativeDriver<import('../../src/context').ProviderContext, import('../../src/driver').ProviderEvent>;
  const driver = adaptHarness('claude', native);
  const session = driver.open({ id: 'main', folder: '/tmp' });
  const changed = vi.fn(); driver.onEvent(event => { if (event.type === 'session.changed') changed(event.state.goal); });
  await driver.setGoal(session, 'Finish checks');
  expect(driver.readSession(session).goal).toEqual(goal);
  expect(changed).toHaveBeenLastCalledWith(goal);
  await driver.clearGoal(session);
  expect(driver.readSession(session).goal).toBeNull();
  expect(changed).toHaveBeenLastCalledWith(null);
  await driver.close();
});
