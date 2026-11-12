import { expect, it, vi } from 'vitest';
import { harnessForHost } from '../../src/internal';
import type { ProviderDriver as NativeDriver } from '../../src/driver';

it('exposes new-chat references and restoration data without owning serialization or storage', async () => {
  const native = {
    onEvent: () => () => {}, close: vi.fn(), releaseConversation: vi.fn(),
    getCapabilities: () => ({ permissionModes: [] }),
    sendPrompt: vi.fn(async () => ({ providerSession: { kind: 'codex', conversationId: 'created-chat' }, turnId: 'turn' })),
    resumeConversation: vi.fn(async () => ({ providerSession: { kind: 'codex', conversationId: 'created-chat' } })),
    readConversationMessages: vi.fn(async () => []),
  } as unknown as NativeDriver<import('../../src/context').ProviderContext, import('../../src/driver').ProviderEvent>;
  const driver = harnessForHost('codex', native);
  const session = driver.open({ id: 'chat', folder: '/workspace', defaults: { model: 'chosen' } });
  try {
    expect(driver.getConversationRef(session)).toBeNull();
    await driver.sendPrompt(session, 'Hello');
    const ref = driver.getConversationRef(session)!;
    const exported = driver.getSessionData(session);
    const refData = driver.getRefData(ref);
    // JSON is the consumer's choice, rather than an SDK persistence format.
    const saved = JSON.stringify({ exported, refData });
    exported.defaults!.model = 'consumer mutation';
    expect(driver.getSessionData(session).defaults?.model).toBe('chosen');
    await driver.release(session);
    const restored = JSON.parse(saved);
    const next = driver.restoreSession({ id: 'chat', folder: '/workspace' }, restored.exported);
    await driver.resumeConversation(next, { ref: driver.restoreRef(restored.refData), storageState: 'active' });
    expect(native.resumeConversation).toHaveBeenCalledWith(expect.objectContaining({ id: 'chat' }), {
      ref: { provider: 'codex', conversationId: 'created-chat' }, storageState: 'active',
    });
  } finally { await driver.close(); }
});
