import { expect, it, vi } from 'vitest';
import { harnessForHost } from '../../src/internal';
import type { ProviderContext } from '../../src/context';
import type { ProviderDriver, ProviderEvent } from '../../src/driver';
import { HarnessUnsupportedError } from '../../src';

const summary = { ref: { provider: 'cursor' as const, sessionId: 'old-chat', folder: '/work' }, title: 'Old chat', folder: '/work', updatedAt: '2026-01-01T00:00:00.000Z', storageState: 'active' as const };

it('Reads one conversation summary by reference, returning an opaque reference of its own', async () => {
  const native = {
    onEvent: () => () => {}, getCapabilities: () => ({}), close: vi.fn(async () => {}),
    listConversations: vi.fn(async () => [summary]),
    readConversationSummary: vi.fn(async () => summary),
  };
  const host = harnessForHost('cursor', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  const session = host.open({ id: 'main', folder: '/work' });
  const [listed] = await host.listConversations(session);
  const read = await host.readConversationSummary(session, listed!.ref);
  expect(read).toMatchObject({ title: 'Old chat', storageState: 'active' });
  expect(host.getRefData(read!.ref)).toMatchObject({ provider: 'cursor', data: { sessionId: 'old-chat' } });
  expect(native.readConversationSummary).toHaveBeenCalledWith(expect.objectContaining({ id: 'main' }), summary.ref);
});

it('Rejects with the typed unsupported error when the provider cannot read a conversation summary', async () => {
  const native = { onEvent: () => () => {}, getCapabilities: () => ({}), close: vi.fn(async () => {}), listConversations: vi.fn(async () => [summary]) };
  const host = harnessForHost('cursor', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  const session = host.open({ id: 'main', folder: '/work' });
  const [listed] = await host.listConversations(session);
  await expect(host.readConversationSummary(session, listed!.ref)).rejects.toBeInstanceOf(HarnessUnsupportedError);
});
