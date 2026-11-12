import { expect, it, vi } from 'vitest';
import { harnessForHost } from '../../src/internal';
import type { ProviderContext } from '../../src/context';
import type { ProviderDriver, ProviderEvent } from '../../src/driver';
import { HarnessUnsupportedError } from '../../src';

const data = { kind: 'codex' as const, conversationId: 't1' };
const base = { onEvent: () => () => {}, getCapabilities: () => ({}), close: vi.fn(async () => {}) };
const open = (native: object) => {
  const harness = harnessForHost('codex', { ...base, ...native } as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  return { harness, session: harness.restoreSession({ id: 'main', folder: '/work' }, { provider: 'codex', data, role: 'main' }) };
};

it('forks into another session, reports the turn it forked from, or reports there is nothing to fork', async () => {
  const target = { kind: 'codex' as const, conversationId: 'forked' };
  const forkConversation = vi.fn(async () => ({ providerSession: target, forkedFromTurnId: 'turn-1' }));
  const { harness, session } = open({ forkConversation });
  const other = harness.open({ id: 'other', folder: '/work-2' });
  expect(await harness.forkConversation(session, other)).toMatchObject({ session: other, forkedFromTurnId: 'turn-1' });
  expect(harness.getSessionData(other).data).toMatchObject({ conversationId: 'forked' });
  const none = open({ forkConversation: async () => null });
  expect(await none.harness.forkConversation(none.session, none.harness.open({ id: 'x', folder: null }))).toBeNull();
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
  expect(readConversationMessages).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 't1' }), 'main', { view: 'last' });
});

it('maps the read-only Codex option to the provider\'s read-only permission and no approval prompts', async () => {
  const { harnesses } = await import('../../src/harnesses');
  expect(harnesses.codex.mapOptions({ client: { name: 'x' }, codex: { readOnly: true } }).codex?.host).toMatchObject({ permissionMode: 'read-only', approvalMode: 'never' });
  expect(harnesses.codex.mapOptions({ client: { name: 'x' } }).codex?.host).not.toHaveProperty('permissionMode');
});

it('leaves plan-exit and every other tool call to the consumer unless it supplies a rule', async () => {
  const { harnesses } = await import('../../src/harnesses');
  expect(harnesses.claude.mapOptions({ client: { name: 'x' } }).claude?.transportOptions).not.toHaveProperty('permissionResult');
  const rule = harnesses.claude.mapOptions({ client: { name: 'x' }, claude: { decideTool: tool => tool === 'ExitPlanMode' ? { behavior: 'deny', message: 'Wait for review.' } : undefined } }).claude!.transportOptions!.permissionResult!;
  expect(rule('ExitPlanMode', {})).toMatchObject({ behavior: 'deny', message: 'Wait for review.' });
  expect(rule('Bash', {})).toBeUndefined();
});

it('starts the provider\'s own review, and rejects when it has none', async () => {
  const startReview = vi.fn(async () => ({ providerSession: data, turnId: 'review-1' }));
  const { harness, session } = open({ startReview });
  expect(await harness.startReview(session, { type: 'baseBranch', branch: 'main' })).toMatchObject({ turnId: 'review-1' });
  expect(startReview).toHaveBeenCalledWith(expect.objectContaining({ id: 'main' }), { type: 'baseBranch', branch: 'main' });
  const plain = open({});
  await expect(plain.harness.startReview(plain.session)).rejects.toBeInstanceOf(HarnessUnsupportedError);
});
