import { expect, it, vi } from 'vitest';
import { harnessForHost } from '../../src/internal';
import type { ProviderContext } from '../../src/context';
import type { ProviderDriver, ProviderEvent } from '../../src/driver';
import { HarnessUnsupportedError } from '../../src';

const base = { onEvent: () => () => {}, getCapabilities: () => ({}), close: vi.fn(async () => {}) };
const make = (native: object) => harnessForHost('codex', { ...base, ...native } as unknown as ProviderDriver<ProviderContext, ProviderEvent>);

it('reads and redeems banked resets through the provider', async () => {
  const getBankedResets = vi.fn(async () => ({ status: 'available', resets: [] }));
  const useBankedReset = vi.fn(async () => ({ status: 'redeemed' }));
  const harness = make({ getBankedResets, useBankedReset });
  expect(await harness.getBankedResets()).toMatchObject({ status: 'available' });
  expect(await harness.useBankedReset({ confirmed: true } as never)).toMatchObject({ status: 'redeemed' });
  expect(useBankedReset).toHaveBeenCalledWith({ confirmed: true });
});

it('rejects banked resets with the typed unsupported error when the provider has none', async () => {
  const harness = make({});
  await expect(harness.getBankedResets()).rejects.toBeInstanceOf(HarnessUnsupportedError);
  await expect(harness.useBankedReset({} as never)).rejects.toBeInstanceOf(HarnessUnsupportedError);
});
