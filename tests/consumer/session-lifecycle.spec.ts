import { expect, it, vi } from 'vitest';
import { harnessForHost } from '../../src/internal';
import type { ProviderContext } from '../../src/context';
import type { ProviderDriver, ProviderEvent } from '../../src/driver';
import { emptyAntigravitySnapshot } from '../../src/conversations/antigravity-conversation-replica';
import { emptyCursorSnapshot } from '../../src/conversations/cursor-conversation-replica';
import { sdkSnapshot } from '../native/codex/sdk-host-fixture';
import { approvalAgentRequest, requestFromClientRequest } from '../../src/conversations/agent-request';

function fixture(provider: 'cursor' | 'antigravity' | 'codex' | 'claude' = 'cursor') {
  let deliver!: (event: ProviderEvent) => void;
  const log: string[] = [];
  const native = {
    onEvent: (listener: typeof deliver) => { deliver = listener; return () => {}; },
    getCapabilities: () => ({ permissionModes: [{ id: 'selected' }], approvalPresets: [] }),
    executeScopedPrompt: vi.fn(async (context: ProviderContext) => { log.push(`execute:${context.id}`); return { text: 'Done', session: provider === 'codex' ? { kind: 'codex' as const, conversationId: context.id } : provider === 'claude' ? { kind: 'claude' as const, conversationId: context.id, transport: 'stdio' as const } : { kind: 'cursor' as const, conversationId: context.id } }; }),
    sendPrompt: vi.fn(async (context: ProviderContext) => ({ providerSession: { kind: 'cursor' as const, conversationId: context.id } })),
    interrupt: vi.fn(async (context: ProviderContext) => ({ providerSession: { kind: 'cursor' as const, conversationId: context.id } })),
    loadConversation: vi.fn(async (context: ProviderContext) => context.providerSession ?? null),
    readConversationContent: vi.fn(async () => ({ text: '', nextOffset: null })),
    disposeScopedSession: vi.fn(async (context: ProviderContext) => { log.push(`dispose:${context.id}`); }),
    releaseConversation: vi.fn(async (id: string) => { log.push(`release:${id}`); }),
    respondToAgentRequest: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  const driver = harnessForHost(provider, native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  return { driver, native, log, deliver: (event: ProviderEvent) => deliver(event) };
}
const question = { id: 'question', kind: 'ask_user' as const, payload: { request: { itemId: 'item', questions: [{ id: 'choice', header: 'Choose', question: 'Continue?', isOther: false, isSecret: false, options: null }] } } };
const confirmation = { id: 'confirmation', kind: 'confirm_tool' as const, payload: { confirmation: { integrationId: 'ledger', integrationName: 'Ledger', toolName: 'write', summary: 'Write ledger?', argumentsPreview: '{}' } } };
const input = { cwd: '/ledger', prompt: 'Check ledger', scope: { id: 'private' } };

it.each(['cursor', 'antigravity'] as const)('%s restores missing requests and removes stale ones from authoritative snapshots', async provider => {
  const { driver, deliver, native } = fixture(provider);
  const session = driver.open({ id: 'main', folder: '/ledger' });
  const snapshot = { ...(provider === 'cursor' ? emptyCursorSnapshot('main', 'native') : emptyAntigravitySnapshot('main', 'native')), activeTurnId: 'turn', clientRequests: [question, confirmation] };
  deliver({ type: `${provider}.conversationSnapshotChanged`, provider: provider, agentId: 'main', payload: { revision: 1, snapshot } } as ProviderEvent);
  expect(driver.readSession(session).requests).toEqual([question, confirmation].map(request => requestFromClientRequest(request, { conversationId: 'native', turnId: 'turn' })));
  await driver.respondToRequest(session, { id: 'question', outcome: { kind: 'cancelled' } });
  expect(native.respondToAgentRequest).toHaveBeenCalledWith({ agentId: 'main', id: 'question', outcome: { kind: 'cancelled' } });
  deliver({ type: `${provider}.conversationSnapshotChanged`, provider: provider, agentId: 'main', payload: { revision: 2, snapshot: { ...snapshot, clientRequests: [] } } } as ProviderEvent);
  expect(driver.readSession(session).requests).toEqual([]);
  await expect(driver.respondToRequest(session, { id: 'question', outcome: { kind: 'cancelled' } })).rejects.toThrow('does not belong');
  await driver.close();
});
it('recovers Codex approvals/questions/confirmations and drops ones resolved without a consumer frame', async () => {
  const { driver, deliver, native } = fixture('codex'); const session = driver.open({ id: 'main', folder: '/ledger' });
  const approval = { id: 'approval', kind: 'command' as const, conversationId: 'native', itemId: 'cmd', title: 'Run?', requiresHumanApproval: true };
  const clients = [{ ...question, conversationId: 'native', turnId: 'turn', itemId: 'item', payload: { request: { ...question.payload.request, delivery: 'tool' as const, blocking: true } } }, { ...confirmation, conversationId: 'native', turnId: 'turn', itemId: 'confirm' }];
  const snapshot = sdkSnapshot('native', { approvals: [approval], clientRequests: clients });
  deliver({ type: 'codex.conversationSnapshotChanged', provider: 'codex', agentId: 'main', threadId: 'native', payload: { revision: 1, snapshot } });
  expect(driver.readSession(session).requests).toEqual([approvalAgentRequest(approval), ...clients.map(request => requestFromClientRequest(request, { conversationId: 'native', turnId: 'turn' }))]);
  for (const id of ['approval', 'confirmation']) await driver.respondToRequest(session, { id, outcome: { kind: 'decision', decision: 'deny' } });
  expect(native.respondToAgentRequest).toHaveBeenCalledWith({ agentId: 'main', id: 'approval', outcome: { kind: 'decision', decision: 'deny' } });
  expect(native.respondToAgentRequest).toHaveBeenCalledWith({ agentId: 'main', id: 'confirmation', outcome: { kind: 'decision', decision: 'deny' } });
  deliver({ type: 'codex.conversationSnapshotChanged', provider: 'codex', agentId: 'main', threadId: 'native', payload: { revision: 2, snapshot: { ...snapshot, approvals: [], clientRequests: [] } } });
  expect(driver.readSession(session).requests).toEqual([]); await driver.close();
});
it('clones parent defaults and never treats a main or foreign-parent handle as a reusable scope', async () => {
  const { driver, native } = fixture();
  const main = driver.open({ id: 'main', folder: '/ledger', defaults: { model: 'selected-model', reasoningEffort: 'high', serviceTier: 'fast', permission: 'selected' } });
  const other = driver.open({ id: 'other', folder: '/ledger' });
  const scope = await driver.executeScopedPrompt(main, { ...input, options: { selection: { model: 'override' } } });
  expect(native.executeScopedPrompt).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ options: { selection: { model: 'override' } } }));
  const context = native.executeScopedPrompt.mock.calls[0]![0];
  expect(context.providerDefaults).toEqual({ kind: 'cursor', model: 'selected-model', reasoningEffort: 'high', serviceTier: 'fast', permission: 'selected' });
  context.providerDefaults!.model = 'mutated';
  const second = await driver.executeScopedPrompt(main, input);
  expect(native.executeScopedPrompt.mock.calls[1]![0].providerDefaults?.model).toBe('selected-model');
  const before = native.executeScopedPrompt.mock.calls.length;
  await expect(driver.executeScopedPrompt(main, { ...input, session: main })).rejects.toThrow(/scope/i);
  await expect(driver.executeScopedPrompt(other, { ...input, session: scope.session })).rejects.toThrow(/parent/i);
  await expect(driver.disposeScopedSession(main)).rejects.toThrow(/scope/i);
  await driver.release(other);
  await expect(driver.executeScopedPrompt(other, { ...input, session: second.session })).rejects.toThrow('does not belong');
  expect(native.executeScopedPrompt).toHaveBeenCalledTimes(before);
  await driver.close();
});
it.each(['codex', 'claude'] as const)('%s disposal releases native ownership and retains a failed disposal for retry', async provider => {
  const { driver, native, log } = fixture(provider); const main = driver.open({ id: 'main', folder: '/ledger' });
  const scope = await driver.executeScopedPrompt(main, input); const id = native.executeScopedPrompt.mock.calls[0]![0].id;
  native.disposeScopedSession.mockRejectedValueOnce(new Error('archive unavailable'));
  await expect(driver.disposeScopedSession(scope.session)).rejects.toThrow('archive unavailable');
  expect(driver.readSession(scope.session)).toBeDefined();
  await driver.disposeScopedSession(scope.session);
  expect(log.slice(-2)).toEqual([`dispose:${id}`, `release:${id}`]);
  expect(() => driver.readSession(scope.session)).toThrow('does not belong');
  expect(driver.readSession(main)).toBeDefined(); await driver.close();
});
it('preserves scope classification across restoration and supports authoritative hydration', async () => {
  const { driver, native } = fixture(); const main = driver.open({ id: 'main', folder: '/ledger' });
  const scope = await driver.executeScopedPrompt(main, input); const saved = driver.getSessionData(scope.session);
  await driver.release(scope.session);
  const restored = driver.restoreSession({ id: 'restored', folder: '/ledger' }, saved);
  expect(await driver.loadConversation(restored)).toBe(true);
  expect(native.loadConversation).toHaveBeenCalledOnce();
  await expect(driver.executeScopedPrompt(main, { ...input, session: restored })).resolves.toMatchObject({ text: 'Done' });
  await expect(driver.sendPrompt(restored, 'not scoped')).rejects.toThrow(/scoped/i);
  await expect(driver.release(main)).rejects.toThrow(/child scopes/i);
  await driver.disposeScopedSession(restored);
  await driver.release(main);
  expect(() => driver.restoreSession({ id: 'orphan', folder: '/ledger' }, saved)).toThrow(/parent first/i);
  await driver.close();
});
it('serializes scoped continuation and disposal before native admission or cleanup finishes', async () => {
  const { driver, native } = fixture(); const main = driver.open({ id: 'main', folder: '/ledger' });
  const scope = await driver.executeScopedPrompt(main, input);
  let finish!: (value: Awaited<ReturnType<typeof native.executeScopedPrompt>>) => void;
  native.executeScopedPrompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const continuation = driver.executeScopedPrompt(main, { ...input, session: scope.session });
  await expect(driver.executeScopedPrompt(main, { ...input, session: scope.session })).rejects.toThrow(/busy/i);
  await expect(driver.disposeScopedSession(scope.session)).rejects.toThrow(/busy/i);
  await expect(driver.release(main)).rejects.toThrow(/child scopes/i);
  finish({ text: 'Done again', session: { kind: 'cursor', conversationId: 'same' } }); await continuation;
  let finishDisposal!: () => void;
  native.disposeScopedSession.mockImplementationOnce(() => new Promise(resolve => { finishDisposal = resolve; }));
  const disposal = driver.disposeScopedSession(scope.session);
  await expect(driver.executeScopedPrompt(main, { ...input, session: scope.session })).rejects.toThrow(/busy/i);
  await expect(driver.disposeScopedSession(scope.session)).rejects.toThrow(/busy/i);
  await expect(driver.sendPrompt(scope.session, 'unsafe')).rejects.toThrow(/cleanup/i);
  await expect(driver.interrupt(scope.session)).rejects.toThrow(/cleanup/i);
  finishDisposal(); await disposal; await driver.close();
});
it('retains cleanup retry without reviving a natively deleted scope', async () => {
  const { driver, native } = fixture(); const main = driver.open({ id: 'main', folder: '/ledger' });
  const scope = await driver.executeScopedPrompt(main, input);
  native.releaseConversation.mockRejectedValueOnce(new Error('release failed'));
  await expect(driver.disposeScopedSession(scope.session)).rejects.toThrow('release failed');
  expect(driver.readSession(scope.session)).toBeDefined();
  await expect(driver.sendPrompt(scope.session, 'unsafe')).rejects.toThrow(/cleanup/i);
  await expect(driver.interrupt(scope.session)).rejects.toThrow(/cleanup/i);
  await expect(driver.respondToRequest(scope.session, { id: 'unknown', outcome: { kind: 'cancelled' } })).rejects.toThrow(/cleanup/i);
  expect(() => driver.readConversationContent(scope.session, { contentId: 'x', offset: 0 })).toThrow(/cleanup/i);
  expect(native.sendPrompt).not.toHaveBeenCalled(); expect(native.interrupt).not.toHaveBeenCalled();
  await driver.disposeScopedSession(scope.session);
  expect(native.disposeScopedSession).toHaveBeenCalledOnce();
  expect(native.releaseConversation).toHaveBeenCalledTimes(2);
  await driver.close();
});
it('rejects new child scopes while their main parent release is pending', async () => {
  const { driver, native } = fixture(); const main = driver.open({ id: 'main', folder: '/ledger' });
  let finish!: () => void; native.releaseConversation.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const releasing = driver.release(main);
  await expect(driver.executeScopedPrompt(main, input)).rejects.toThrow(/cleanup/i);
  expect(native.executeScopedPrompt).not.toHaveBeenCalled(); finish(); await releasing; await driver.close();
});

it('Claude preserves unknown pending requests and prunes only explicit native answered/resolved evidence', async () => {
  const { driver, deliver } = fixture('claude'); const session = driver.open({ id: 'main', folder: '/ledger' });
  const q = requestFromClientRequest(question, { conversationId: 'native' });
  const c = requestFromClientRequest(confirmation, { conversationId: 'native' });
  for (const request of [q, c]) deliver({ type: 'agentRequest.created', provider: 'claude', agentId: 'main', payload: { request } });
  const snapshot = { agentId: 'main', sessionId: 'native', activeTurnId: null, turnIds: [], turns: [], messages: [], answeredClientRequestIds: [], busy: false, historyLoading: false, historyState: { hasOlder: false, loadingOlder: false }, contextUsage: null, plan: null, error: null };
  deliver({ type: 'claude.conversationSnapshotChanged', provider: 'claude', agentId: 'main', payload: { revision: 1, snapshot } });
  expect(driver.readSession(session).requests).toEqual([q, c]);
  deliver({ type: 'claude.conversationSnapshotChanged', provider: 'claude', agentId: 'main', payload: { revision: 2, snapshot: { ...snapshot, answeredClientRequestIds: ['question'] } } });
  expect(driver.readSession(session).requests).toEqual([c]);
  deliver({ type: 'agentRequest.created', provider: 'claude', agentId: 'main', payload: { request: q } });
  expect(driver.readSession(session).requests).toEqual([c]);
  deliver({ type: 'agentRequest.resolved', provider: 'claude', agentId: 'main', payload: { id: c.id, outcome: { kind: 'cancelled' } } });
  expect(driver.readSession(session).requests).toEqual([]); await driver.close();
});
it('rejects restoring a saved child while main release is pending', async () => {
  const { driver, native } = fixture(); const main = driver.open({ id: 'main', folder: '/ledger' });
  const scope = await driver.executeScopedPrompt(main, input); const saved = driver.getSessionData(scope.session);
  await driver.release(scope.session);
  let finish!: () => void; native.releaseConversation.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const releasing = driver.release(main);
  expect(() => driver.restoreSession({ id: 'restored-child', folder: '/ledger' }, saved)).toThrow(/cleanup/i);
  finish(); await releasing; await driver.close();
});
