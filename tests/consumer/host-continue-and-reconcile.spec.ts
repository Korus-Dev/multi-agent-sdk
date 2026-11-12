import { expect, it, vi } from 'vitest';
import { harnessForHost } from '../../src/internal';
import type { ProviderContext } from '../../src/context';
import type { ProviderDriver, ProviderEvent } from '../../src/driver';
import { HarnessUnsupportedError } from '../../src';

const data = { kind: 'cursor' as const, conversationId: 's1', folder: '/work' };
const base = { onEvent: () => () => {}, getCapabilities: () => ({}), close: vi.fn(async () => {}) };
const open = (native: object) => {
  const harness = harnessForHost('cursor', { ...base, ...native } as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  return { harness, session: harness.restoreSession({ id: 'main', folder: '/work' }, { provider: 'cursor', data, role: 'main' }) };
};

it('continues an interrupted turn and reports the new active turn', async () => {
  const continueInterruptedTurn = vi.fn(async () => ({ providerSession: data, activeTurnId: 'turn-2' }));
  const { harness, session } = open({ continueInterruptedTurn });
  expect(await harness.continueInterruptedTurn(session)).toMatchObject({ activeTurnId: 'turn-2' });
  expect(continueInterruptedTurn).toHaveBeenCalledWith(expect.objectContaining({ id: 'main' }), undefined);
});

it('rejects continuing an interrupted turn with the typed unsupported error when the provider cannot', async () => {
  const { harness, session } = open({});
  await expect(harness.continueInterruptedTurn(session)).rejects.toBeInstanceOf(HarnessUnsupportedError);
});

it('reconciles stored conversations for the given sessions and tolerates providers that do not need it', async () => {
  const reconcileConversations = vi.fn(async () => {});
  const { harness, session } = open({ reconcileConversations });
  await harness.reconcileConversations([session]);
  expect(reconcileConversations).toHaveBeenCalledWith([expect.objectContaining({ id: 'main' })]);
  const plain = open({});
  await expect(plain.harness.reconcileConversations([plain.session])).resolves.toBeUndefined();
});
