import { expect, it } from 'vitest';
import { codexSdkFixture, sdkAgent } from './sdk-host-fixture';
import type { ProviderContext, ProviderDriver, ProviderEvent } from '../../../src/driver';

it('runs a caller-owned CPA scope and restores the normal native MCP configuration', async () => {
  const fixture = codexSdkFixture();
  const driver: ProviderDriver<ProviderContext, ProviderEvent> = fixture.driver;
  const context = sdkAgent();
  const conversation = fixture.conversation('conversation-a');
  conversation.handle.sendMessage.mockImplementationOnce(async () => {
    const turn = { id: 'check', status: 'completed' as const };
    conversation.setSnapshot({ turnIds: ['check'], turns: [turn as never], messages: [{ id: 'answer', role: 'assistant', turnId: 'check', status: 'complete', parts: [{ type: 'text', phase: 'final_answer', text: 'Totals verified.' }] }] });
    // Completion can precede admission; the native host must retain it.
    conversation.emit({ seq: 1, occurredAt: '', origin: 'notification', type: 'turn.completed', conversationId: 'conversation-a', turnId: 'check', payload: { status: 'completed', error: null, willRetry: false, startedAt: null, completedAt: null, durationMs: null } });
    return conversation.handle.getSnapshot();
  });
  try {
    await expect(driver.executeScopedPrompt!(context, { cwd: '/accounting', session: context.providerSession, prompt: 'Check the ledger', scope: { id: 'ledger', mcpServers: [{ name: 'ledger', url: 'http://127.0.0.1:1234/ledger', approval: 'auto', required: true, enabledTools: ['lookup'] }] } })).resolves.toStrictEqual({ text: 'Totals verified.', session: context.providerSession });
    expect(conversation.handle.load).toHaveBeenNthCalledWith(2, { cwd: '/accounting', extensionContext: { ...context, folder: '/accounting' }, mcpServers: [{ name: 'ledger', transport: { type: 'http', url: 'http://127.0.0.1:1234/ledger' }, enabledTools: ['lookup'], toolApprovalMode: 'auto', required: true }] });
    expect(conversation.handle.load).toHaveBeenLastCalledWith({ cwd: '/repo', extensionContext: context, mcpServers: undefined });
    expect(driver.getCapabilities(context)).not.toHaveProperty('codeReview');
  } finally { await driver.close(); }
});

it('rejects a scope switch during an active turn before changing native tools', async () => {
  const fixture = codexSdkFixture();
  const context = sdkAgent();
  const current = fixture.conversation('conversation-a');
  try {
    await fixture.driver.loadConversation(context);
    current.setSnapshot({ busy: true, activeTurnId: 'foreground' });
    await expect(fixture.driver.executeScopedPrompt(context, { cwd: '/repo', prompt: 'Audit', session: context.providerSession, scope: { id: 'audit', mcpServers: [] } })).rejects.toThrow(/active|busy|running/i);
    expect(current.handle.load).toHaveBeenCalledTimes(1);
    expect(current.handle.sendMessage).not.toHaveBeenCalled();
  } finally { await fixture.driver.close(); }
});

it('restores normal tools when applying a native scope fails', async () => {
  const fixture = codexSdkFixture();
  const context = sdkAgent();
  const current = fixture.conversation('conversation-a');
  try {
    await fixture.driver.loadConversation(context);
    current.handle.load.mockRejectedValueOnce(new Error('Native configuration rejected'));
    await expect(fixture.driver.executeScopedPrompt(context, { cwd: '/repo', prompt: 'Audit', session: context.providerSession, scope: { id: 'audit', mcpServers: [] } })).rejects.toThrow('Native configuration rejected');
    expect(current.handle.load).toHaveBeenLastCalledWith({ cwd: '/repo', extensionContext: context, mcpServers: undefined });
    expect(current.handle.sendMessage).not.toHaveBeenCalled();
  } finally { await fixture.driver.close(); }
});
