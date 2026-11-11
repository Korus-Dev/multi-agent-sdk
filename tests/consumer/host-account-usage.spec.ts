import { expect, it, vi } from 'vitest';
import { adaptHarness } from '../../src/consumer';
import type { ProviderContext } from '../../src/context';
import type { ProviderDriver, ProviderEvent } from '../../src/driver';
import { antigravityHarnessCapabilities, claudeHarnessCapabilities, codexHarnessCapabilities, cursorHarnessCapabilities } from '../../src/capabilities';

it('Providers with a built-in account usage reader advertise it, so a UI needs no provider knowledge', () => {
  expect([codexHarnessCapabilities, claudeHarnessCapabilities, cursorHarnessCapabilities].map(caps => caps.accountUsage)).toEqual([true, true, true]);
  expect(antigravityHarnessCapabilities.accountUsage).not.toBe(true);
});

it('Host capabilities report accountUsage only when the provider can read it', () => {
  const limits = { primary: null, secondary: null } as never;
  const withReader = { onEvent: () => () => {}, getCapabilities: () => ({ accountUsage: true }), getAccountRateLimits: vi.fn(async () => limits), close: vi.fn(async () => {}) };
  const without = { onEvent: () => () => {}, getCapabilities: () => ({ accountUsage: true }), close: vi.fn(async () => {}) };
  const make = (native: object) => { const host = adaptHarness('cursor', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>); return host.getCapabilities(host.open({ id: 'a', folder: '/work' })).accountUsage; };
  expect(make(withReader)).toBe(true);
  expect(make(without)).toBe(false);
});
