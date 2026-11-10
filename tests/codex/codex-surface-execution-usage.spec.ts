import { describe, expect, it } from 'vitest';
import { CodexAppServerClient, type v2 } from '../../../codex-sdk/src/protocol';
import { CodexSurface } from '../../src/providers/codex';
import { createCodexConversationReplica } from 'multi-agents-sdk/conversation-replica';
import type { CodexSurfaceEvent } from 'multi-agents-sdk/surface';
import { MockCodexAppServer, resumeResponse, thread, turn } from './helpers/codex-surface-fixture';

const requestUsage = {
  status: 'unavailable',
  reason: 'public-runtime-request-evidence-unavailable',
  unavailableFields: [
    'requestIdentity', 'timestamp', 'actualModel', 'actualProvider', 'requestTokenUsage',
    'cacheWriteLifetimes', 'cacheWriteInputInclusion', 'pricingContext',
    'requestedModel', 'requestedServiceTier', 'reportedServiceTier', 'finality',
  ],
  requests: null,
};

const baseline: v2.TokenUsageBreakdown = {
  totalTokens: 100, inputTokens: 60, cachedInputTokens: 20, cacheWriteInputTokens: 5,
  outputTokens: 40, reasoningOutputTokens: 10,
};
const total: v2.TokenUsageBreakdown = {
  totalTokens: 160, inputTokens: 100, cachedInputTokens: 30, cacheWriteInputTokens: 8,
  outputTokens: 60, reasoningOutputTokens: 15,
};
const last: v2.TokenUsageBreakdown = {
  totalTokens: 20, inputTokens: 15, cachedInputTokens: 5, cacheWriteInputTokens: 1,
  outputTokens: 5, reasoningOutputTokens: 1,
};
const execution = {
  totalTokens: 60, inputTokens: 40, cachedInputTokens: 10, cacheWriteInputTokens: 3,
  outputTokens: 20, reasoningOutputTokens: 5,
};

async function setup(notifyStarted = false, priorUsage?: v2.TokenUsageBreakdown) {
  let nextTurn = 0;
  const transport: MockCodexAppServer = new MockCodexAppServer({
    'thread/start': () => {
      const created = thread('thread-new', false);
      if (notifyStarted) transport.emitNotification('thread/started', { thread: created });
      if (priorUsage) usage(transport, 'turn-history', priorUsage, created.id);
      return resumeResponse(created);
    },
    'thread/fork': params => resumeResponse({ ...thread('thread-new', false), forkedFromId: params.threadId }),
    'thread/settings/update': () => ({}),
    'turn/start': () => ({ turn: turn(`turn-${++nextTurn}`, 'inProgress', []) }),
  });
  const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
  const events: CodexSurfaceEvent[] = [];
  surface.onEvent(event => events.push(event));
  await surface.connect();
  return { surface, events, transport };
}

function usage(transport: MockCodexAppServer, turnId: string, counts = total, threadId = 'thread-existing') {
  transport.emitNotification('thread/tokenUsage/updated', {
    threadId, turnId, tokenUsage: { total: counts, last, modelContextWindow: 2000 },
  });
}

describe('CodexSurface execution usage', () => {
  it.each([false, true])('attributes a new conversation’s first execution (early thread notification: %s)', async notifyStarted => {
    const { surface, transport, events } = await setup(notifyStarted);
    try {
      await surface.createConversation();
      await surface.sendMessage('First prompt');
      usage(transport, 'turn-1', baseline, 'thread-new');
      usage(transport, 'turn-1', total, 'thread-new');
      transport.emitNotification('turn/completed', { threadId: 'thread-new', turn: turn('turn-1', 'completed', []) });
      expect(events.filter(event => event.type === 'conversation.executionUsageChanged').map(event => event.payload.usage))
        .toStrictEqual([
          { last, total: baseline, execution: baseline, model: null, requestUsage, observedStart: true },
          { last, total, execution: total, model: null, requestUsage, observedStart: true },
        ]);
      expect(events.find(event => event.type === 'turn.completed')?.payload.executionUsage)
        .toStrictEqual({ last, total, execution: total, model: null, requestUsage, observedStart: true });
      expect(surface.getSnapshot().turns.find(item => item.id === 'turn-1')?.executionUsage?.execution)
        .toStrictEqual(total);
    } finally { await surface.close(); }
  });

  it('does not assume a zero baseline for a newly forked conversation', async () => {
    const { surface, transport, events } = await setup();
    try {
      const fork = await surface.forkConversation('thread-existing');
      await fork.conversation.sendMessage('Continue the fork');
      usage(transport, 'turn-1', total, fork.conversationId);
      expect(events.filter(event => event.type === 'conversation.executionUsageChanged').at(-1)?.payload.usage)
        .toStrictEqual({ last, total, execution: null, model: null, requestUsage, observedStart: true });
    } finally { await surface.close(); }
  });

  it('preserves provider counters received before the new thread response', async () => {
    const { surface, transport, events } = await setup(false, baseline);
    try {
      await surface.createConversation();
      await surface.sendMessage('After earlier provider usage');
      usage(transport, 'turn-1', total, 'thread-new');
      expect(events.filter(event => event.type === 'conversation.executionUsageChanged').at(-1)?.payload.usage)
        .toStrictEqual({ last, total, execution, model: null, requestUsage, observedStart: true });
    } finally { await surface.close(); }
  });

  it('does not use counters already containing a new turn as that turn’s starting baseline', async () => {
    const { surface, transport, events } = await setup();
    try {
      usage(transport, 'turn-history', baseline);
      usage(transport, 'turn-1');
      await surface.sendMessage('Start response arrived after usage');
      usage(transport, 'turn-1', { ...total, totalTokens: 170, outputTokens: 70 });
      expect(events.filter(event => event.type === 'conversation.executionUsageChanged').at(-1)?.payload.usage)
        .toMatchObject({ observedStart: true, execution: null });
    } finally { await surface.close(); }
  });

  it('preserves absent cache-write evidence on older packets and invalidates synthetic context-only counters', async () => {
    const { surface, transport, events } = await setup();
    const legacy = ({ totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens }: v2.TokenUsageBreakdown) =>
      ({ totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens });
    const emit = (turnId: string, counts: v2.TokenUsageBreakdown) => transport.emitRaw({
      method: 'thread/tokenUsage/updated', params: {
        threadId: 'thread-existing', turnId,
        tokenUsage: { total: legacy(counts), last: legacy(last), modelContextWindow: 2000 },
      },
    });
    try {
      emit('turn-history', baseline);
      await surface.sendMessage('Legacy usage');
      emit('turn-1', total);
      expect(surface.getSnapshot().turns.find(item => item.id === 'turn-1')?.executionUsage)
        .toStrictEqual({ last: { ...last, cacheWriteInputTokens: null }, total: { ...total, cacheWriteInputTokens: null }, execution: { ...execution, cacheWriteInputTokens: null }, model: null, requestUsage, observedStart: true });
      // A valid cumulative revision can still imply impossible per-turn cache
      // attribution. Such a difference is unknown, not an invented measurement.
      usage(transport, 'turn-1', { ...total, totalTokens: 170, inputTokens: 110, cachedInputTokens: 105 });
      expect(events.filter(event => event.type === 'conversation.executionUsageChanged').at(-1)?.payload.usage.execution).toBeNull();
      usage(transport, 'turn-1', { totalTokens: 2000, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
      expect(events.filter(event => event.type === 'conversation.executionUsageChanged').at(-1)?.payload.usage.execution).toBeNull();
    } finally { await surface.close(); }
  });

  it('replaces live cumulative usage from a known baseline, preserving terminal and late samples without inventing a model', async () => {
    const { surface, transport, events } = await setup();
    try {
      usage(transport, 'turn-history', baseline);
      await surface.sendMessage('First');
      usage(transport, 'turn-1');
      usage(transport, 'turn-1');
      const samples = events.filter(event => event.type === 'conversation.executionUsageChanged');
      expect(samples.map(event => event.payload.usage)).toStrictEqual([
        { last, total: baseline, execution: null, model: null, requestUsage, observedStart: false },
        { last, total, execution, model: null, requestUsage, observedStart: true },
        { last, total, execution, model: null, requestUsage, observedStart: true },
      ]);
      transport.emitNotification('model/rerouted', {
        threadId: 'thread-existing', turnId: 'turn-1', fromModel: 'gpt-5', toModel: 'gpt-mini', reason: 'highRiskCyberActivity',
      });
      expect(events.find(event => event.type === 'turn.modelRerouted')).toMatchObject({
        conversationId: 'thread-existing', turnId: 'turn-1',
        payload: { fromModel: 'gpt-5', toModel: 'gpt-mini', reason: 'highRiskCyberActivity' },
      });
      transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-1', 'completed', []) });
      expect(events.find(event => event.type === 'turn.completed')).toMatchObject({
        turnId: 'turn-1', payload: { executionUsage: { last, total, execution, model: null } },
      });
      usage(transport, 'turn-1', { ...total, totalTokens: 170, outputTokens: 70 });
      expect(surface.getSnapshot().turns.find(item => item.id === 'turn-1')?.executionUsage?.execution)
        .toStrictEqual({ ...execution, totalTokens: 70, outputTokens: 30 });
    } finally { await surface.close(); }
  });

  it('keeps request evidence unavailable across internal completions, retries and replica replay', async () => {
    const { surface, transport, events } = await setup();
    try {
      await surface.updateConversationSettings({ modelId: 'gpt-5', serviceTier: 'priority' });
      await surface.sendMessage('Numeric fixture');
      const replica = createCodexConversationReplica(surface.getConversationSnapshot('thread-existing'));
      usage(transport, 'turn-1', baseline);
      usage(transport, 'turn-1', total);
      // Neither a duplicate internal response nor opaque metadata is a public billing contract.
      const raw: v2.RawResponseCompletedNotification = {
        threadId: 'thread-existing', turnId: 'turn-1', responseId: 'response-fixture', usage: last,
        usageMetadata: { amount: '0.01', metadata: { model: 'unverified', service_tier: 'flex' } },
      };
      transport.emitNotification('rawResponse/completed', raw);
      transport.emitNotification('rawResponse/completed', raw);
      transport.emitNotification('rawResponse/completed', { ...raw, responseId: 'retry-fixture' });
      transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-1', 'completed', []) });
      usage(transport, 'turn-1', { ...total, totalTokens: 170, outputTokens: 70 });
      usage(transport, 'turn-1', { ...total, totalTokens: 170, outputTokens: 70 });
      const samples = events.filter(event => event.type === 'conversation.executionUsageChanged');
      expect(samples.map(event => event.payload.usage)).toStrictEqual([
        { last, total: baseline, execution: null, model: null, observedStart: true, requestUsage },
        { last, total, execution: null, model: null, observedStart: true, requestUsage },
        ...Array.from({ length: 2 }, () => ({ last, total: { ...total, totalTokens: 170, outputTokens: 70 },
          execution: null, model: null, observedStart: true, requestUsage })),
      ]);
      for (const event of events) {
        if ('conversationId' in event && event.conversationId === 'thread-existing') replica.apply(event);
      }
      const expected = surface.getSnapshot().turns.find(item => item.id === 'turn-1')?.executionUsage;
      expect(expected).toStrictEqual(samples.at(-1)?.payload.usage);
      expect(replica.getSnapshot().turns.find(item => item.id === 'turn-1')?.executionUsage).toStrictEqual(expected);
      // Re-delivery of the same semantic event cannot manufacture another observation.
      replica.apply(samples.at(-1)!);
      expect(replica.getSnapshot().turns.find(item => item.id === 'turn-1')?.executionUsage).toStrictEqual(expected);
      expect(surface.getSnapshot()).toMatchObject({ selectedModelId: 'gpt-5', selectedServiceTier: 'priority' });
    } finally { await surface.close(); }
  });

  it('keeps missing baselines, counter resets and history replays unavailable instead of adding last-request counts', async () => {
    const { surface, transport, events } = await setup();
    try {
      await surface.sendMessage('No baseline');
      usage(transport, 'turn-1');
      transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-1', 'completed', []) });
      await surface.sendMessage('Known baseline');
      usage(transport, 'turn-2', { ...total, totalTokens: 170, outputTokens: 70 });
      expect(surface.getSnapshot().turns.find(item => item.id === 'turn-2')?.executionUsage?.execution)
        .toStrictEqual({ totalTokens: 10, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 });
      usage(transport, 'turn-2', baseline);
      usage(transport, 'turn-2', total);
      transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-2', 'completed', []) });
      await surface.selectConversation('thread-existing');
      usage(transport, 'turn-history');
      const samples = events.filter(event => event.type === 'conversation.executionUsageChanged');
      expect(samples.map(event => event.payload.usage.execution)).toStrictEqual([
        null, { totalTokens: 10, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
        null, null, null,
      ]);
      expect(events.filter(event => event.type === 'turn.completed').map(event => event.payload.executionUsage?.execution))
        .toStrictEqual([null, null]);
    } finally { await surface.close(); }
  });

  it('does not attribute a late older-turn increase to a newer execution', async () => {
    const { surface, transport, events } = await setup();
    try {
      usage(transport, 'turn-history', baseline);
      await surface.sendMessage('First');
      usage(transport, 'turn-1');
      transport.emitNotification('thread/status/changed', { threadId: 'thread-existing', status: { type: 'idle' } });
      await surface.sendMessage('Second');
      usage(transport, 'turn-2', { ...total, totalTokens: 170, outputTokens: 70 });
      usage(transport, 'turn-1', { ...total, totalTokens: 180, outputTokens: 80 });
      // Replayed usage can name an older execution whose start was never observed.
      usage(transport, 'turn-unobserved', { ...total, totalTokens: 180, outputTokens: 80 });
      transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-1', 'completed', []) });
      expect(surface.getSnapshot().activeTurnId).toBe('turn-2');
      usage(transport, 'turn-2', { ...total, totalTokens: 190, outputTokens: 90 });
      const current = events.filter(event => event.type === 'conversation.executionUsageChanged').filter(event => event.turnId === 'turn-2');
      expect(current.at(-1)?.payload.usage.execution).toBeNull();
      transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-2', 'completed', []) });
      expect(events.filter(event => event.type === 'turn.completed').at(-1)).toMatchObject({
        turnId: 'turn-2', payload: { executionUsage: { execution: null } },
      });
    } finally { await surface.close(); }
  });
});
