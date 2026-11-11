import { expect, it, vi } from 'vitest';
import { harnessForHost } from '../../src/internal';
import type { SessionState, HarnessEvent } from '../../src/consumer-types';
import type { ProviderDriver as NativeDriver, ProviderEvent as NativeEvent } from '../../src/driver';
import type { ProviderContext } from '../../src/context';
import { emptyCursorSnapshot } from '../../src/conversations/cursor-conversation-replica';
import { emptyAntigravitySnapshot } from '../../src/conversations/antigravity-conversation-replica';
import { sdkSnapshot } from '../native/codex/sdk-host-fixture';
import type { ClaudeConversationSnapshot } from '../../src/contracts';

const timing = { startedAt: '2026-11-10T01:00:00Z', completedAt: '2026-11-10T01:00:02Z', durationMs: 1875 };
const failed = { id: 'failed', status: 'failed' as const, ...timing, willRetry: true,
  error: { message: 'Provider failed', additionalDetails: 'Native retry pending', codexErrorInfo: { code: 'busy' } },
  itemsView: 'summary' as const, detailsLoading: true, detailsError: 'Native details unavailable',
};
const usage = { observedStart: true, last: { totalTokens: 20, inputTokens: 12, cachedInputTokens: 2, cacheWriteInputTokens: null, outputTokens: 8, reasoningOutputTokens: 3 },
  total: { totalTokens: 40, inputTokens: 24, cachedInputTokens: 4, cacheWriteInputTokens: null, outputTokens: 16, reasoningOutputTokens: 6 }, execution: null, model: null };
const codex = sdkSnapshot('native-session', { turns: [{ ...failed, executionUsage: usage }], answeredClientRequestIds: ['answered'], historyLoading: true, historyState: { hasOlder: true, loadingOlder: true, loadingStrategy: 'lazy', fullyLoaded: false, itemsView: 'summary' } });
const claude: ClaudeConversationSnapshot = { agentId: 'tax', sessionId: 'native-session', activeTurnId: null, turnIds: ['failed'], turns: [{ ...failed, error: { ...failed.error, codexErrorInfo: null } }], messages: [],
  answeredClientRequestIds: ['answered'], busy: false, historyLoading: true, historyState: { hasOlder: true, loadingOlder: true }, contextUsage: null, plan: null, error: 'Provider failed' };
const cursor = { ...emptyCursorSnapshot('tax', 'native-session'), turns: [{ id: 'completed', status: 'completed' as const, ...timing, willRetry: false as const, error: null }], answeredClientRequestIds: ['answered'], historyLoading: true };
const antigravity = { ...emptyAntigravitySnapshot('tax', 'native-session'), turns: [{ id: 'interrupted', status: 'interrupted' as const, ...timing, willRetry: false as const, error: null }], answeredClientRequestIds: ['answered'], historyLoading: true };
const frames = [
  { type: 'codex.conversationSnapshotChanged', provider: 'codex', agentId: 'tax', threadId: 'native-session', payload: { revision: 1, snapshot: codex } },
  { type: 'claude.conversationSnapshotChanged', provider: 'claude', agentId: 'tax', payload: { revision: 1, snapshot: claude } },
  { type: 'cursor.conversationSnapshotChanged', provider: 'cursor', agentId: 'tax', payload: { revision: 1, snapshot: cursor } },
  { type: 'antigravity.conversationSnapshotChanged', provider: 'antigravity', agentId: 'tax', payload: { revision: 1, snapshot: antigravity } },
] satisfies NativeEvent[];

for (const frame of frames) it(`${frame.provider}: preserves native turn, answered-request and history evidence in state and events`, async () => {
  let deliver!: (event: NativeEvent) => void;
  const native = { onEvent: (listener: typeof deliver) => { deliver = listener; return () => {}; }, close: vi.fn() } as unknown as NativeDriver<ProviderContext, NativeEvent>;
  const driver = harnessForHost(frame.provider, native);
  const session = driver.open({ id: 'tax', folder: '/ledger' });
  const changes: SessionState[] = [];
  driver.onEvent((event: HarnessEvent) => { if (event.type === 'session.changed') changes.push(event.state); });
  try {
    expect(driver.readSession(session).historyState).toBeUndefined();
    expect(driver.readSession(session).historyLoading).toBeUndefined();
    expect(driver.readSession(session).answeredClientRequestIds).toBeUndefined();
    deliver(frame);
    for (const state of [driver.readSession(session), changes.at(-1)!]) {
      expect(state.turns).toEqual(frame.payload.snapshot.turns);
      expect(state.turns[0]?.durationMs).toBe(1875);
      expect(state.answeredClientRequestIds).toEqual(['answered']);
      expect(state.historyLoading).toBe(true);
      expect(state.historyState).toEqual(frame.payload.snapshot.historyState);
    }
    if (frame.provider === 'codex') {
      expect(driver.readSession(session).turns[0]?.willRetry).toBe(true);
      expect(driver.readSession(session).turns[0]?.executionUsage).toEqual(usage);
      deliver({ ...frame, payload: { revision: 2, snapshot: sdkSnapshot('native-session') } });
      expect(driver.readSession(session).historyState).toBeUndefined();
    }
  } finally { await driver.close(); }
});

it('Codex exposes restored native execution selection without consumer persistence', async () => {
  let deliver!: (event: NativeEvent) => void;
  const native = { onEvent: (listener: typeof deliver) => { deliver = listener; return () => {}; }, close: vi.fn() } as unknown as NativeDriver<ProviderContext, NativeEvent>;
  const driver = harnessForHost('codex', native);
  const session = driver.open({ id: 'tax', folder: '/ledger' });
  const snapshot = sdkSnapshot('native', { models: [{ id: 'catalog-terra', model: 'gpt-6.1-terra', displayName: 'Terra',
    supportedReasoningEfforts: [], defaultReasoningEffort: 'high', isDefault: false }],
    selectedModelId: 'catalog-terra', selectedReasoningEffort: 'low', selectedServiceTier: 'default', approvalPreset: 'full-access' });
  deliver({ type: 'codex.conversationSnapshotChanged', provider: 'codex', agentId: 'tax', threadId: 'native', payload: { revision: 1, snapshot } });
  expect(driver.readSession(session).selection).toEqual({ model: 'gpt-6.1-terra', reasoningEffort: 'low', serviceTier: 'default' });
  expect(driver.readSession(session).permission).toBe('full-access');
  deliver({ type: 'codex.conversationSnapshotChanged', provider: 'codex', agentId: 'tax', threadId: 'native', payload: { revision: 2, snapshot: sdkSnapshot('native') } });
  expect(driver.readSession(session).selection).toEqual({ model: null, reasoningEffort: null, serviceTier: null });
  expect(driver.readSession(session).permission).toBeNull();
  await driver.close();
});

it('Claude publishes model settings recovered from provider history and later native settings events', async () => {
  let deliver!: (event: NativeEvent) => void;
  const saved = { kind: 'claude' as const, sessionId: 'native', transport: 'stdio' as const, model: 'claude-opus', reasoningEffort: 'high' };
  const native = { onEvent: (listener: typeof deliver) => { deliver = listener; return () => {}; }, close: vi.fn(),
    resumeConversation: async () => ({ providerSession: saved }), loadConversation: async () => ({ ...saved, reasoningEffort: undefined }),
    sendPrompt: async () => ({ providerSession: saved }),
  } as unknown as NativeDriver<ProviderContext, NativeEvent>;
  const driver = harnessForHost('claude', native);
  const session = driver.open({ id: 'tax', folder: '/ledger' });
  const ref = driver.restoreRef({ provider: 'claude', data: { provider: 'claude', folder: '/ledger', sessionId: 'native' } });
  await driver.resumeConversation(session, { ref, storageState: 'active' });
  expect(driver.readSession(session).selection).toEqual({ model: 'claude-opus', reasoningEffort: 'high' });
  await driver.loadConversation(session);
  expect(driver.readSession(session).selection).toEqual({ model: 'claude-opus' });
  deliver({ type: 'conversation.settingsUpdated', provider: 'claude', agentId: 'tax', payload: { settings: { model: 'claude-sonnet', reasoningEffort: 'medium' } } });
  expect(driver.readSession(session).selection).toEqual({ model: 'claude-sonnet', reasoningEffort: 'medium' });
  deliver({ type: 'conversation.settingsUpdated', provider: 'claude', agentId: 'tax', payload: { settings: { model: 'claude-opus', reasoningEffort: 'high', serviceTier: 'fast' } } });
  deliver({ type: 'conversation.modeUpdated', provider: 'claude', agentId: 'tax', payload: { mode: 'default', permissionMode: 'dontAsk' } });
  expect(driver.readSession(session).permission).toBe('dontAsk');
  await driver.sendPrompt(session, 'Continue');
  expect(driver.readSession(session).selection).toEqual({ model: 'claude-opus', reasoningEffort: 'high', serviceTier: 'fast' });
  await driver.close();
});


it.each(['codex', 'claude'] as const)('%s publishes accepted permission changes and keeps the last confirmed mode on failure', async provider => {
  const mode = provider === 'codex' ? 'full-access' : 'dontAsk';
  const update = vi.fn().mockResolvedValue(provider === 'codex'
    ? { providerSession: { kind: 'codex', threadId: 'native' }, approvalPreset: mode }
    : { providerDefaults: { kind: 'claude', permissionMode: mode } });
  const native = { onEvent: () => () => {}, close: vi.fn(),
    getCapabilities: () => provider === 'codex' ? { approvalPresets: [mode] } : { permissionModes: [{ id: mode }] },
    setApprovalPreset: update, setPermissionMode: update,
  } as unknown as NativeDriver<ProviderContext, NativeEvent>;
  const driver = harnessForHost(provider, native);
  const session = driver.open({ id: 'tax', folder: '/ledger' });
  expect(driver.readSession(session).permission).toBeUndefined();
  await driver.setPermission(session, mode);
  expect(driver.readSession(session).permission).toBe(mode);
  update.mockRejectedValueOnce(new Error('Permission update failed'));
  await expect(driver.setPermission(session, mode)).rejects.toThrow('Permission update failed');
  expect(driver.readSession(session).permission).toBe(mode);
  await driver.close();
});
