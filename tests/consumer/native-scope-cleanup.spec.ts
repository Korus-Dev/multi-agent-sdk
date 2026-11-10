import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { adaptHarnessDriver } from '../../src/consumer';
import { codexSdkFixture, sdkSnapshot } from '../native/codex/sdk-surface-fixture';
import { ClaudeConversationHost } from '../../src/providers/claude/host';
import { ClaudeAgentSdkTransport } from '../../src/providers/claude/agent-sdk-transport';
import { createQueryHarness } from '../native/claude/sdk-query-fixture';

it('repeated Codex scoped execution/disposal removes adapter ownership and subscriptions, retaining main', async () => {
  const fixture = codexSdkFixture();
  let id = 0;
  fixture.surface.createConversation.mockImplementation(async () => {
    const nativeId = `scope-${++id}`; const conversation = fixture.conversation(nativeId);
    conversation.handle.sendMessage.mockImplementation(async () => {
      conversation.setSnapshot({ turnIds: ['finished'], turns: [{ id: 'finished', status: 'completed', error: null, willRetry: false, startedAt: null, completedAt: null, durationMs: null }], messages: [{ id: 'answer', role: 'assistant', status: 'complete', turnId: 'finished', parts: [{ type: 'text', text: 'Done' }] }] });
      return conversation.handle.getSnapshot();
    });
    return sdkSnapshot(nativeId);
  });
  const driver = adaptHarnessDriver('codex', fixture.driver);
  const main = driver.restoreSession({ id: 'main', folder: '/repo' }, JSON.stringify({ version: 1, provider: 'codex', type: 'session', data: { kind: 'codex', threadId: 'main-native' } }));
  const ownership = fixture.adapter as unknown as { sessionsByAgentId: Map<string, unknown>; agentIdsByThreadId: Map<string, string> };
  try {
    await driver.loadConversation(main);
    for (let i = 0; i < 3; ++i) {
      const scope = await driver.executeScopedPrompt(main, { cwd: '/repo', prompt: 'Check', scope: { id: 'private' } });
      expect(ownership.sessionsByAgentId.size).toBe(2);
      expect(fixture.conversation(`scope-${i + 1}`).listenerCount()).toBe(1);
      await driver.disposeScopedSession(scope.session);
      expect(ownership.sessionsByAgentId.size).toBe(1);
      expect(ownership.agentIdsByThreadId.size).toBe(1);
      expect(fixture.conversation(`scope-${i + 1}`).listenerCount()).toBe(0);
      expect(ownership.sessionsByAgentId.has('main')).toBe(true);
      expect(fixture.conversation('main-native').listenerCount()).toBe(1);
    }
  } finally { await driver.close(); }
});

it('repeated Claude scoped execution/disposal releases host replicas, history and live identities, retaining main', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'scope-cleanup-'));
  const query = createQueryHarness();
  const transport = new ClaudeAgentSdkTransport({ createQuery: query.createQuery, deleteSession: vi.fn().mockResolvedValue(undefined) });
  const native = new ClaudeConversationHost(transport, undefined, { homeDir: home });
  const execute = vi.spyOn(native, 'executeScopedPrompt');
  const ownership = native as unknown as { liveSessionIdsByAgentId: Map<string, string>; conversationReplicasByAgentId: Map<string, unknown>; historyWindows: Map<string, unknown> };
  const driver = adaptHarnessDriver('claude', native);
  const main = driver.open({ id: 'main', folder: home });
  const complete = (session: string, index: number) => {
    query.emit({ type: 'system', subtype: 'init', session_id: session }, index);
    query.emit({ type: 'assistant', uuid: `answer-${index}`, session_id: session, message: { content: [{ type: 'text', text: 'Done' }] } }, index);
    query.emit({ type: 'result', subtype: 'success', session_id: session, is_error: false }, index);
  };
  try {
    const sending = driver.sendPrompt(main, 'Main');
    await vi.waitFor(() => expect(query.inputs).toHaveLength(1)); complete('main-native', 0); await sending;
    await vi.waitFor(() => expect(driver.readSession(main).busy).toBe(false));
    for (let i = 0; i < 3; ++i) {
      const execution = driver.executeScopedPrompt(main, { cwd: home, prompt: 'Check', scope: { id: 'private' } });
      await vi.waitFor(() => expect(query.inputs).toHaveLength(i + 2)); complete(`scope-native-${i}`, i + 1);
      const scope = await execution; const scopeId = execute.mock.calls[i]![0].id;
      expect(ownership.conversationReplicasByAgentId.has(scopeId)).toBe(true);
      expect(ownership.liveSessionIdsByAgentId.has(scopeId)).toBe(true);
      await driver.disposeScopedSession(scope.session);
      expect(ownership.conversationReplicasByAgentId.has(scopeId)).toBe(false);
      expect(ownership.liveSessionIdsByAgentId.has(scopeId)).toBe(false);
      expect(ownership.historyWindows.has(scopeId)).toBe(false);
      expect(ownership.conversationReplicasByAgentId.has('main')).toBe(true);
      expect(ownership.liveSessionIdsByAgentId.get('main')).toBe('main-native');
    }
  } finally { await driver.close(); await rm(home, { recursive: true, force: true }); }
});
