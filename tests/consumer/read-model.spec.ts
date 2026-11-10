import { expect, it, vi } from 'vitest';
import { adaptHarnessDriver } from '../../src/consumer';
import type { SessionState, HarnessEvent } from '../../src/consumer-types';
import type { HarnessDriver as NativeDriver, HarnessEvent as NativeEvent } from '../../src/driver';
import type { HarnessContext } from '../../src/context';
import { emptyCursorSnapshot } from '../../src/conversations/cursor-conversation-replica';
import { emptyAntigravitySnapshot } from '../../src/conversations/antigravity-conversation-replica';
import { sdkSnapshot } from '../native/codex/sdk-surface-fixture';
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
  { type: 'codex.conversationSnapshotChanged', backend: 'codex', agentId: 'tax', threadId: 'native-session', payload: { revision: 1, snapshot: codex } },
  { type: 'claude.conversationSnapshotChanged', backend: 'claude', agentId: 'tax', payload: { revision: 1, snapshot: claude } },
  { type: 'cursor.conversationSnapshotChanged', backend: 'cursor', agentId: 'tax', payload: { revision: 1, snapshot: cursor } },
  { type: 'antigravity.conversationSnapshotChanged', backend: 'antigravity', agentId: 'tax', payload: { revision: 1, snapshot: antigravity } },
] satisfies NativeEvent[];

for (const frame of frames) it(`${frame.backend}: preserves native turn, answered-request and history evidence in state and events`, async () => {
  let deliver!: (event: NativeEvent) => void;
  const native = { onEvent: (listener: typeof deliver) => { deliver = listener; return () => {}; }, close: vi.fn() } as unknown as NativeDriver<HarnessContext, NativeEvent>;
  const driver = adaptHarnessDriver(frame.backend, native);
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
    if (frame.backend === 'codex') {
      expect(driver.readSession(session).turns[0]?.willRetry).toBe(true);
      expect(driver.readSession(session).turns[0]?.executionUsage).toEqual(usage);
      deliver({ ...frame, payload: { revision: 2, snapshot: sdkSnapshot('native-session') } });
      expect(driver.readSession(session).historyState).toBeUndefined();
    }
  } finally { await driver.close(); }
});
