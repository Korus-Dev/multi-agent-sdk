import { describe, expect, it } from 'vitest';
import type { HarnessProvider } from '../../src';
import { createScriptedHarness } from '../../src/testing';
import { conversationSessionData, harnessProviders } from '../../src/contracts-entry';

// A session restored from saved data is bound to a conversation the SDK has not read yet. Sending to it continues that
// conversation, so the SDK reads it first: whatever the harness does when it is sent a prompt, the session then
// shows the conversation's history and not only the new turn.
const saved = (provider: HarnessProvider) => ({ provider, data: conversationSessionData(provider, 'conversation-1'), role: 'main' as const });
const fixture = (provider: HarnessProvider, options?: Parameters<typeof createScriptedHarness>[1]) => {
  const { harness, script } = createScriptedHarness(provider, options);
  const order: string[] = [];
  script.on('loadConversation', (context: { providerSession?: unknown }) => { order.push('load'); return context.providerSession ?? null; });
  const turn = (name: string) => (context: { providerSession?: unknown }) => { order.push(name); return { providerSession: context.providerSession ?? conversationSessionData(provider, 'conversation-1'), turnId: 'turn-1', activeTurnId: null }; };
  script.on('sendPrompt', turn('sendPrompt'));
  script.on('steerPrompt', turn('steerPrompt'));
  script.on('continueInterruptedTurn', turn('continueInterruptedTurn'));
  return { harness, script, order };
};

describe.each(harnessProviders)('%s: sending to a restored conversation', provider => {
  it.each(['sendPrompt', 'steerPrompt', 'continueInterruptedTurn'] as const)('reads the conversation before %s', async operation => {
    const { harness, order } = fixture(provider);
    const session = harness.restoreSession({ id: 'agent', folder: '/work' }, saved(provider));
    if (operation === 'sendPrompt') await harness.sendPrompt(session, 'Hello');
    else if (operation === 'steerPrompt') await harness.steerPrompt(session, 'Hello');
    else await harness.continueInterruptedTurn(session);
    expect(order).toStrictEqual(['load', operation]);
  });

  it('reads the conversation before a run sends its prompt', async () => {
    const { harness, order } = fixture(provider);
    const session = harness.restoreSession({ id: 'agent', folder: '/work' }, saved(provider));
    const run = harness.run(session, 'Hello');
    await run.admission;
    expect(order).toStrictEqual(['load', 'sendPrompt']);
  });

  it('reads it once, however many prompts follow', async () => {
    const { harness, order } = fixture(provider);
    const session = harness.restoreSession({ id: 'agent', folder: '/work' }, saved(provider));
    await harness.sendPrompt(session, 'One');
    await harness.sendPrompt(session, 'Two');
    expect(order).toStrictEqual(['load', 'sendPrompt', 'sendPrompt']);
  });

  it('does not read it again after the app loaded it', async () => {
    const { harness, order } = fixture(provider);
    const session = harness.restoreSession({ id: 'agent', folder: '/work' }, saved(provider));
    await harness.loadConversation(session);
    await harness.sendPrompt(session, 'Hello');
    expect(order).toStrictEqual(['load', 'sendPrompt']);
  });

  it('reads a conversation the app syncs onto an open session', async () => {
    const { harness, order } = fixture(provider);
    const session = harness.open({ id: 'agent', folder: '/work' });
    harness.syncSession(session, { data: conversationSessionData(provider, 'conversation-1') });
    await harness.sendPrompt(session, 'Hello');
    expect(order).toStrictEqual(['load', 'sendPrompt']);
  });

  it('starts a new conversation without reading anything', async () => {
    const { harness, order } = fixture(provider);
    const session = harness.open({ id: 'agent', folder: '/work' });
    await harness.sendPrompt(session, 'Hello');
    expect(order).toStrictEqual(['sendPrompt']);
  });

  it('sends nothing when the conversation cannot be read, and says why', async () => {
    const { harness, script, order } = fixture(provider);
    script.on('loadConversation', () => { throw new Error('History is unreadable.'); });
    const session = harness.restoreSession({ id: 'agent', folder: '/work' }, saved(provider));
    await expect(harness.sendPrompt(session, 'Hello')).rejects.toThrow('History is unreadable.');
    expect(order).toStrictEqual([]);
  });

  it('sends straight away when the harness cannot read conversations', async () => {
    const { harness, order } = fixture(provider, { unsupported: ['loadConversation'] });
    const session = harness.restoreSession({ id: 'agent', folder: '/work' }, saved(provider));
    await harness.sendPrompt(session, 'Hello');
    expect(order).toStrictEqual(['sendPrompt']);
  });
});
