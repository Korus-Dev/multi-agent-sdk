import { expect, it, vi } from 'vitest';
import { adaptHarness } from '../../src/consumer';
import type { ProviderContext } from '../../src/context';
import type { ProviderDriver, ProviderEvent } from '../../src/driver';
import { HarnessUnsupportedError } from '../../src';

const data = { kind: 'codex' as const, threadId: 't1' };
const base = { onEvent: () => () => {}, getCapabilities: () => ({}), close: vi.fn(async () => {}) };
const open = (native: object) => {
  const harness = adaptHarness('codex', { ...base, ...native } as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  return { harness, session: harness.restoreSession({ id: 'main', folder: '/work' }, { provider: 'codex', data, role: 'main' }) };
};

it('asks the provider whether a conversation is ready to hand off', async () => {
  const assertHandoffReady = vi.fn(async () => {});
  const { harness, session } = open({ assertHandoffReady });
  await expect(harness.assertHandoffReady(session)).resolves.toBeUndefined();
  expect(assertHandoffReady).toHaveBeenCalledWith(expect.objectContaining({ id: 'main' }));
  const refusing = open({ assertHandoffReady: async () => { throw new Error('Resolve the turn first.'); } });
  await expect(refusing.harness.assertHandoffReady(refusing.session)).rejects.toThrow('Resolve the turn first.');
  const plain = open({});
  await expect(plain.harness.assertHandoffReady(plain.session)).rejects.toBeInstanceOf(HarnessUnsupportedError);
});

it('forks a worktree conversation into another session, or reports there is nothing to fork', async () => {
  const target = { kind: 'codex' as const, threadId: 'forked' };
  const forkWorktreeConversation = vi.fn(async () => ({ providerSession: target }));
  const { harness, session } = open({ forkWorktreeConversation });
  const other = harness.open({ id: 'other', folder: '/work-2' });
  expect(await harness.forkWorktreeConversation(session, other)).toMatchObject({ session: other });
  expect(harness.getSessionData(other).data).toMatchObject({ threadId: 'forked' });
  const none = open({ forkWorktreeConversation: async () => null });
  expect(await none.harness.forkWorktreeConversation(none.session, none.harness.open({ id: 'x', folder: null }))).toBeNull();
});

it('lets the provider handle a prompt as a command, or declines', async () => {
  const tryHandlePromptCommand = vi.fn((_context: ProviderContext, prompt: string) => prompt.startsWith('/') ? Promise.resolve({ providerSession: data, turnId: 'cmd' }) : null);
  const { harness, session } = open({ tryHandlePromptCommand });
  expect(await harness.handlePromptCommand(session, '/compact')).toMatchObject({ turnId: 'cmd' });
  expect(harness.handlePromptCommand(session, 'hello')).toBeNull();
  const plain = open({});
  expect(plain.harness.handlePromptCommand(plain.session, '/x')).toBeNull();
});

it('lets the provider adjust prompt options before sending', () => {
  const preparePromptOptions = vi.fn((_context: ProviderContext, options?: { content?: unknown }) => ({ ...options, planMode: true }));
  const { harness, session } = open({ preparePromptOptions });
  expect(harness.preparePromptOptions(session, { content: [] } as never)).toMatchObject({ planMode: true });
  const plain = open({});
  const options = { content: [] } as never;
  expect(plain.harness.preparePromptOptions(plain.session, options)).toBe(options);
});

it('passes the history view to the provider when reading conversation messages', async () => {
  const readConversationMessages = vi.fn(async () => []);
  const { harness, session } = open({ readConversationMessages });
  const ref = harness.getConversationRef(session)!;
  await harness.readConversationMessages(session, ref, { view: 'last' });
  expect(readConversationMessages).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't1' }), 'main', { view: 'last' });
});

it('maps the read-only Codex option to the provider\'s read-only permission and no approval prompts', async () => {
  const { providerOptions } = await import('../../src/options-map');
  expect(providerOptions({ client: { name: 'x' }, codex: { readOnly: true } }).codex?.host).toMatchObject({ permissionMode: 'read-only', approvalMode: 'never' });
  expect(providerOptions({ client: { name: 'x' } }).codex?.host).not.toHaveProperty('permissionMode');
});
