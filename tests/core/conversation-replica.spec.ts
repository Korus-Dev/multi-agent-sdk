import {
  createCodexConversationReplica,
  type CodexConversationReplica,
} from '../../src/core/conversation-replica';
import type {
  CodexConversationEvent,
  CodexConversationSnapshot,
  CodexSurfaceEventOrigin,
  SurfaceMessage,
} from '../../src/core/surface';
import { describe, expect, it } from 'vitest';

describe('Codex conversation replica', () => {
  it('retains turn-scoped usage through completion and late replacement without touching other turns', () => {
    const other = turn('other');
    const replica = createCodexConversationReplica(snapshot({ turns: [turn('turn-1'), other] }));
    const counts = { totalTokens: 10, inputTokens: 8, cachedInputTokens: 2, cacheWriteInputTokens: null, outputTokens: 2, reasoningOutputTokens: 1 };
    const usage = { last: counts, total: counts, execution: counts, model: null, observedStart: true };
    apply(replica, event('conversation.executionUsageChanged', 'turn-1', { usage }));
    expect(replica.getSnapshot().turns[0]?.executionUsage).toStrictEqual(usage);
    apply(replica, event('turn.error', 'turn-1', {
      error: { message: 'retry', additionalDetails: null, codexErrorInfo: null }, willRetry: true,
    }));
    expect(replica.getSnapshot().turns[0]?.executionUsage).toStrictEqual(usage);
    apply(replica, event('turn.completed', 'turn-1', {
      status: 'completed', error: null, willRetry: false, startedAt: null, completedAt: null, durationMs: null, executionUsage: usage,
    }));
    const later = { ...usage, execution: { ...counts, totalTokens: 12, outputTokens: 4 } };
    apply(replica, event('conversation.executionUsageChanged', 'turn-1', { usage: later }));
    apply(replica, event('turn.modelRerouted', 'turn-1', { fromModel: 'one', toModel: 'two', reason: 'highRiskCyberActivity' }));
    expect(replica.getSnapshot().turns[0]).toMatchObject({ status: 'completed', executionUsage: later });
    expect(replica.getSnapshot().turns[1]).toBe(other);
  });

  it('projects structured execution plans into the conversation snapshot', () => {
    const replica = createCodexConversationReplica(snapshot());

    apply(replica, event('plan.updated', 'turn-plan', {
      explanation: 'Ship the fix',
      steps: [
        { step: 'Add the regression test', status: 'completed' },
        { step: 'Render the plan panel', status: 'inProgress' },
      ],
      markdown: 'Ship the fix\n- [x] Add the regression test\n- [ ] Render the plan panel',
      status: 'completed',
    }));

    expect(replica.getSnapshot().executionPlan).toStrictEqual({
      turnId: 'turn-plan',
      explanation: 'Ship the fix',
      steps: [
        { step: 'Add the regression test', status: 'completed' },
        { step: 'Render the plan panel', status: 'inProgress' },
      ],
      markdown: 'Ship the fix\n- [x] Add the regression test\n- [ ] Render the plan panel',
      updatedAt: '2026-09-06T20:00:00.000Z',
    });
  });

  it('applies streaming events with structural sharing instead of receiving another full snapshot', () => {
    const oldMessage = userMessage('old-user', 'Earlier', 'turn-old');
    const replica = createCodexConversationReplica(snapshot({
      error: 'stale error',
      messages: [oldMessage],
      turnGitDiff: { turnId: 'turn-old', addedLines: 1, removedLines: 0, updatedAt: 'earlier' },
      turns: [],
      turnIds: [],
    }));

    apply(replica, event('message.appended', 'turn-new', {
      message: userMessage('new-user', 'Hello', 'turn-new'),
    }));
    apply(replica, event('turn.started', 'turn-new', { startedAt: '2026-09-06T20:00:00.000Z' }));
    const beforeDelta = replica.getSnapshot();
    apply(replica, event('message.delta', 'turn-new', {
      messageId: 'assistant-turn-new',
      itemId: 'agent-1',
      delta: 'Hel',
      phase: 'commentary',
    }));
    const afterFirstDelta = replica.getSnapshot();
    apply(replica, event('message.delta', 'turn-new', {
      messageId: 'assistant-turn-new',
      itemId: 'agent-1',
      delta: 'lo',
      phase: 'commentary',
    }));

    expect(afterFirstDelta).not.toBe(beforeDelta);
    expect(afterFirstDelta.messages[0]).toBe(oldMessage);
    expect(replica.getSnapshot()).toMatchObject({
      activeTurnId: 'turn-new',
      busy: true,
      error: null,
      turnGitDiff: null,
      turnIds: ['turn-new'],
      turns: [{ id: 'turn-new', status: 'inProgress' }],
      messages: [
        { id: 'old-user' },
        { id: 'new-user' },
        {
          id: 'assistant-turn-new',
          role: 'assistant',
          status: 'streaming',
          parts: [{ type: 'text', text: 'Hello', itemId: 'agent-1', phase: 'commentary' }],
        },
      ],
    });
  });

  it('replaces and prepends history while keeping turn metadata synchronized', () => {
    const replica = createCodexConversationReplica(snapshot({
      messages: [userMessage('one', 'One', 'turn-1'), userMessage('two', 'Two', 'turn-2')],
      turnIds: ['turn-1', 'turn-2'],
      turns: [turn('turn-1'), turn('turn-2')],
    }));

    apply(replica, event('conversation.historyReplaced', undefined, {
      reason: 'rollback',
      messages: [userMessage('one', 'Edited one', 'turn-1')],
      threadStatus: { type: 'idle' },
      state: {
        activeTurnId: null,
        turns: [turn('turn-1')],
        turnIds: ['turn-1'],
        answeredClientRequestIds: [],
        busy: false,
        contextUsage: null,
        error: null,
        historyLoading: false,
        historyState: {
          loadingStrategy: 'lazy', hasOlder: true, loadingOlder: false, fullyLoaded: false,
        },
        turnGitDiff: null,
      },
    }));
    apply(replica, event('conversation.historyPrepended', undefined, {
      messages: [userMessage('zero', 'Zero', 'turn-0')],
      state: {
        turns: [turn('turn-0'), turn('turn-1')],
        turnIds: ['turn-0', 'turn-1'],
        historyLoading: false,
        historyState: {
          loadingStrategy: 'lazy', hasOlder: false, loadingOlder: false, fullyLoaded: true,
        },
      },
    }));

    expect(replica.getSnapshot()).toMatchObject({
      activeTurnId: null,
      busy: false,
      turnIds: ['turn-0', 'turn-1'],
      messages: [
        { id: 'zero', parts: [{ text: 'Zero' }] },
        { id: 'one', parts: [{ text: 'Edited one' }] },
      ],
      historyState: { hasOlder: false, fullyLoaded: true },
    });
  });

  it('completes turns and replaces individual messages without rebuilding unrelated history', () => {
    const oldMessage = userMessage('old-user', 'Earlier', 'turn-old');
    const assistant = {
      ...assistantMessage('assistant-turn-new', 'Draft', 'turn-new'),
      parts: [
        { type: 'text' as const, text: 'Draft', itemId: 'agent-1' },
        {
          type: 'tool' as const,
          id: 'tool-running',
          title: 'Run',
          status: 'running' as const,
          statusText: JSON.stringify({ action: 'run', phase: 'running' }),
        },
        {
          type: 'tool' as const,
          id: 'tool-with-legacy-status',
          title: 'Legacy',
          status: 'running' as const,
          statusText: 'not-json',
        },
      ],
    };
    const replica = createCodexConversationReplica(snapshot({
      activeTurnId: 'turn-new',
      busy: true,
      messages: [oldMessage, assistant],
      turnIds: ['turn-old', 'turn-new'],
      turns: [turn('turn-old'), { ...turn('turn-new'), status: 'inProgress' }],
    }));

    const replacement = {
      ...assistant,
      parts: [
        { type: 'text' as const, text: 'Final', itemId: 'agent-1' },
        assistant.parts[1]!,
        assistant.parts[2]!,
      ],
    };
    apply(replica, event('message.updated', 'turn-new', { message: replacement }));
    apply(replica, event('turn.completed', 'turn-new', {
      status: 'completed', error: null, willRetry: false,
      startedAt: '2026-09-06T20:00:00.000Z', completedAt: '2026-09-06T20:00:03.000Z', durationMs: 3000,
    }));

    const current = replica.getSnapshot();
    expect(current.messages[0]).toBe(oldMessage);
    expect(current.messages[1]).toMatchObject({
      id: 'assistant-turn-new',
      status: 'complete',
      parts: [
        { type: 'text', text: 'Final' },
        {
          type: 'tool',
          status: 'completed',
          statusText: JSON.stringify({ action: 'run', phase: 'completed' }),
        },
        { type: 'tool', status: 'completed', statusText: 'not-json' },
      ],
    });
    expect(current.activeTurnId).toBeNull();
    expect(current.busy).toBe(false);
    expect(current.turns.at(-1)).toMatchObject({
      id: 'turn-new', status: 'completed', durationMs: 3000,
    });
  });

  it('rejects events and replacement snapshots for another conversation', () => {
    const replica = createCodexConversationReplica(snapshot());
    const foreign = {
      ...event('conversation.activityChanged', undefined, {
        threadStatus: { type: 'idle' }, busy: false, error: null,
      }),
      conversationId: 'other-conversation',
    } as CodexConversationEvent;

    expect(() => replica.apply(foreign)).toThrow("belongs to 'other-conversation'");
    expect(() => replica.replace(snapshot({ activeConversationId: 'other-conversation' })))
      .toThrow("belongs to 'other-conversation'");
  });

  it('projects compact settings, queue, approval, and client-request events', () => {
    const replica = createCodexConversationReplica(snapshot());
    apply(replica, event('conversation.settingsChanged', undefined, {
      approvalPreset: 'full-access',
      selectedModelId: 'gpt-5',
      selectedReasoningEffort: 'high',
      selectedServiceTier: 'priority',
      planMode: true,
    }));
    apply(replica, event('conversation.queueChanged', undefined, {
      queuedPrompts: [{ id: 'queued-1', text: 'Later' }],
    }));
    const approval = {
      id: 'approval-1', kind: 'command' as const, conversationId: 'conversation-1',
      turnId: 'turn-1', itemId: 'tool-1', title: 'Run tests',
    };
    apply(replica, event('approval.requested', 'turn-1', { approval }));
    apply(replica, event('approval.resolved', 'turn-1', {
      approval, decision: 'approve', scope: 'once', reason: 'host',
    }));
    const request = {
      id: 'request-1', kind: 'ask_user' as const, conversationId: 'conversation-1',
      turnId: 'turn-1', itemId: 'question-1',
      payload: {
        request: { itemId: 'question-1', delivery: 'tool' as const, blocking: true, questions: [] },
      },
    };
    apply(replica, event('clientRequest.requested', 'turn-1', { request }));
    apply(replica, event('clientRequest.resolved', 'turn-1', {
      request,
      response: { id: 'request-1', payload: { answers: {} } },
      reason: 'host',
    }));

    expect(replica.getSnapshot()).toMatchObject({
      approvalPreset: 'full-access',
      selectedModelId: 'gpt-5',
      selectedReasoningEffort: 'high',
      selectedServiceTier: 'priority',
      planMode: true,
      queuedPrompts: [{ id: 'queued-1', text: 'Later' }],
      approvals: [],
      clientRequests: [],
      answeredClientRequestIds: ['request-1'],
    });
  });

  it('reduces the complete semantic event vocabulary without transcript snapshots', () => {
    const replica = createCodexConversationReplica(snapshot());
    apply(replica, event('conversation.historyReplaced', undefined, {
      reason: 'resync', messages: [], threadStatus: { type: 'idle' },
    }));
    apply(replica, event('conversation.historyPrepended', undefined, {
      messages: [userMessage('history-user', 'History', 'history-turn')],
    }));
    const summary = {
      id: 'conversation-1', title: 'Current', preview: 'Preview', cwd: '/workspace',
      status: 'active' as const, turnCount: 1,
      createdAt: '2026-09-06T20:00:00.000Z', updatedAt: '2026-09-06T20:00:00.000Z',
    };
    apply(replica, event('conversation.summaryUpserted', undefined, { summary, reason: 'updated' }));
    apply(replica, event('conversation.summaryUpserted', undefined, {
      summary: { ...summary, title: 'Renamed' }, reason: 'updated',
    }));
    apply(replica, event('conversation.activityChanged', undefined, {
      threadStatus: { type: 'active', activeFlags: [] }, busy: true, error: null,
    }));
    apply(replica, event('conversation.goalChanged', undefined, {
      goal: {
        threadId: 'conversation-1', objective: 'Ship', status: 'active', tokenBudget: null,
        tokensUsed: 4, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2,
      },
    }));
    apply(replica, event('conversation.contextUsageChanged', 'turn-1', {
      contextUsage: {
        totalTokens: 10, inputTokens: 8, cachedInputTokens: 2, outputTokens: 2,
        reasoningOutputTokens: 1, lastTotalTokens: 5, modelContextWindow: 100, usedPercent: 10,
      },
    }));
    apply(replica, event('conversation.skillsChanged', undefined, {
      cwd: '/workspace', status: 'loaded',
      skills: [{ name: 'review', path: '/skill', enabled: true }],
    }));
    apply(replica, event('conversation.permissionsChanged', undefined, {
      cwd: '/workspace',
      permissionProfiles: [{ id: 'workspace', description: null, allowed: true }],
      approvalPresets: ['ask-for-approval'],
    }));
    apply(replica, event('conversation.diffUpdated', undefined, {
      diff: { turnId: 'turn-1', addedLines: 2, removedLines: 1, updatedAt: 'now' },
    }));

    apply(replica, event('turn.started', 'turn-1', { startedAt: 'start' }));
    apply(replica, event('turn.started', 'turn-1', { startedAt: 'start' }));
    const tool = {
      type: 'tool' as const, id: 'tool-1', title: 'Run', status: 'running' as const,
      body: 'one', input: { command: 'one' }, metadata: { source: 'test' },
    };
    apply(replica, event('tool.started', 'turn-1', {
      messageId: 'assistant-turn-1', toolPart: tool,
    }));
    apply(replica, event('tool.updated', 'turn-1', {
      messageId: 'assistant-turn-1',
      update: {
        itemId: 'tool-1', title: 'Ran', status: 'completed', statusText: null,
        body: 'body', bodyDelta: '+delta', bodyAppend: 'append', input: { command: 'two' },
        output: { ok: true }, metadata: { finished: true },
      },
    }));
    apply(replica, event('tool.updated', 'turn-1', {
      messageId: 'assistant-turn-1', update: { itemId: 'tool-1' },
    }));
    apply(replica, event('tool.completed', 'turn-1', {
      messageId: 'assistant-turn-1',
      toolPart: { ...tool, status: 'completed', output: { ok: true } },
    }));
    apply(replica, event('tool.updated', 'turn-1', {
      messageId: 'fallback-message',
      update: { itemId: 'fallback', fallbackToolPart: { ...tool, id: 'fallback' } },
    }));
    expect(replica.getSnapshot().messages.find((message) => message.id === 'fallback-message'))
      .toMatchObject({
        turnId: 'turn-1',
        metadata: { conversationId: 'conversation-1', turnId: 'turn-1' },
      });
    apply(replica, event('tool.updated', 'turn-1', {
      messageId: 'missing-message', update: { itemId: 'missing' },
    }));
    apply(replica, event('tool.updated', 'turn-1', {
      messageId: 'assistant-turn-1', update: { itemId: 'missing-on-existing' },
    }));
    apply(replica, event('plan.delta', 'turn-1', { itemId: 'plan', delta: 'A', markdown: 'A' }));
    apply(replica, event('plan.updated', 'turn-1', {
      explanation: null, steps: [], markdown: 'B', status: 'running',
    }));
    apply(replica, event('plan.updated', 'turn-1', {
      explanation: null, steps: [], markdown: 'C', status: 'completed',
    }));
    apply(replica, event('plan.completed', 'turn-1', { itemId: 'plan', markdown: 'D' }));
    expect(replica.getSnapshot().messages.flatMap((message) => message.parts).find((part) => (
      part.type === 'tool' && part.id === 'plan-progress-turn-1'
    ))).toMatchObject({
      status: 'completed',
      statusText: JSON.stringify({
        source: 'codex',
        action: 'plan',
        phase: 'completed',
        params: { addedLines: 1, operation: 'write', target: 'plan' },
      }),
    });
    apply(replica, event('plan.delta', 'plan-only-turn', {
      itemId: 'plan-only', delta: 'Only', markdown: 'Only',
    }));
    apply(replica, event('context.compactionStarted', 'turn-1', { itemId: 'compact' }));
    expect(replica.getSnapshot().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'fallback-message', status: 'complete' }),
      expect.objectContaining({ id: 'compaction-turn-1', status: 'streaming' }),
    ]));
    apply(replica, event('context.compactionStarted', 'turn-1', { itemId: 'compact' }));
    const compaction = {
      id: 'compaction-turn-1', kind: 'compaction' as const, role: 'assistant' as const,
      status: 'complete' as const, turnId: 'turn-1', parts: [],
    };
    apply(replica, event('context.compactionCompleted', 'turn-1', {
      itemId: 'compact', message: compaction,
    }));
    apply(replica, event('turn.error', 'turn-1', {
      error: { message: 'retrying', additionalDetails: null, codexErrorInfo: null },
      willRetry: true,
    }));
    apply(replica, event('turn.error', 'turn-1', {
      error: { message: 'failed', additionalDetails: null, codexErrorInfo: null },
      willRetry: false,
    }));
    apply(replica, event('turn.completed', 'other-turn', {
      status: 'failed',
      error: { message: 'other failed', additionalDetails: null, codexErrorInfo: null },
      willRetry: false, startedAt: null, completedAt: null, durationMs: null,
    }));

    const ignoredTypes = [
      'file.activity', 'subagent.toolCallChanged', 'subagent.activity', 'realtime.started',
      'realtime.itemAdded', 'realtime.transcriptDelta', 'realtime.transcriptCompleted',
      'realtime.audioDelta', 'realtime.sdp', 'realtime.error', 'realtime.closed',
    ] as const;
    for (const type of ignoredTypes) {
      const before = replica.getSnapshot();
      apply(replica, event(type, type.startsWith('realtime.') ? undefined : 'turn-1', {} as never));
      expect(replica.getSnapshot()).toBe(before);
    }
    apply(replica, event('conversation.summaryRemoved', undefined, { reason: 'deleted' }));

    expect(replica.getSnapshot()).toMatchObject({
      conversations: [],
      activeTurnId: null,
      busy: false,
      error: 'other failed',
      goal: { objective: 'Ship' },
      contextUsage: { totalTokens: 10 },
      skills: [{ name: 'review' }],
      permissionProfiles: [{ id: 'workspace' }],
      turnGitDiff: null,
    });
  });

  it('segments steers and handles absent turn metadata and empty deltas defensively', () => {
    const replica = createCodexConversationReplica(snapshot({
      activeTurnId: 'turn-1',
      busy: true,
      messages: [assistantMessage('assistant-turn-1', 'First', 'turn-1')],
      turnIds: ['turn-1'],
      turns: [{ ...turn('turn-1'), status: 'inProgress' }],
    }));
    apply(replica, event('message.appended', 'turn-1', {
      message: { ...userMessage('steer-1', 'Redirect', 'turn-1'), kind: 'steer' },
    }));
    apply(replica, event('message.appended', undefined, {
      message: {
        id: 'orphan-steer', kind: 'steer', role: 'user', status: 'complete',
        parts: [{ type: 'text', text: 'Orphan' }],
      },
    }));
    apply(replica, event('turn.started', 'turn-empty', { startedAt: 'start-empty' }));
    apply(replica, event('message.appended', 'turn-empty', {
      message: { ...userMessage('steer-empty', 'Empty segment', 'turn-empty'), kind: 'steer' },
    }));
    apply(replica, event('message.appended', 'turn-without-assistant', {
      message: {
        ...userMessage('steer-without-assistant', 'No prior segment', 'turn-without-assistant'),
        kind: 'steer',
        createdAt: undefined,
      },
    }));
    apply(replica, event('message.appended', undefined, {
      message: {
        id: 'metadata-turn', role: 'user', status: 'complete', parts: [],
        metadata: { turnId: 'metadata-only' },
      },
    }));
    apply(replica, event('message.delta', 'turn-1', {
      messageId: 'assistant-turn-1-segment-1', itemId: 'empty', delta: '',
    }));
    const replay = event('message.delta', 'turn-1', {
      messageId: 'assistant-turn-1-segment-1', itemId: 'answer', delta: 'Once',
    });
    apply(replica, replay);
    apply(replica, replay);
    apply(replica, event('message.delta', 'turn-new-delta', {
      messageId: 'delta-created', itemId: 'new-part', delta: 'Created',
    }));
    apply(replica, event('message.delta', 'turn-new-delta', {
      messageId: 'delta-created', itemId: 'new-part', delta: ' again',
    }));

    expect(replica.getSnapshot().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'assistant-turn-1', status: 'complete' }),
      expect.objectContaining({ id: 'steer-1', kind: 'steer' }),
      expect.objectContaining({ id: 'orphan-steer', kind: 'steer' }),
      expect.objectContaining({
        id: 'assistant-turn-1-segment-1',
        parts: [expect.objectContaining({ text: 'Once' })],
      }),
      expect.objectContaining({ id: 'delta-created', parts: [expect.objectContaining({ text: 'Created again' })] }),
    ]));
  });

  it('writes resolved client-request results back to their tool parts', () => {
    const toolMessage: SurfaceMessage = {
      id: 'tool-message', role: 'assistant', status: 'streaming',
      parts: [{ type: 'tool', id: 'question-1', title: 'Question', status: 'running' }],
      metadata: { turnId: 'turn-1' },
    };
    const replica = createCodexConversationReplica(snapshot({ messages: [toolMessage] }));
    const askRequest = {
      id: 'ask-1', kind: 'ask_user' as const, conversationId: 'conversation-1',
      turnId: 'turn-1', itemId: 'question-1',
      payload: {
        request: { itemId: 'question-1', delivery: 'tool' as const, blocking: true, questions: [] },
      },
    };
    apply(replica, event('clientRequest.resolved', undefined, {
      request: askRequest, response: null, reason: 'server',
    }));
    const confirmRequest = {
      id: 'confirm-1', kind: 'confirm_tool' as const, conversationId: 'conversation-1',
      turnId: null, itemId: 'confirmation-1',
      payload: {
        confirmation: {
          argumentsPreview: '', integrationId: 'plugin', integrationName: 'Plugin',
          summary: 'Confirm', toolName: 'run',
        },
      },
    };
    apply(replica, event('clientRequest.resolved', undefined, {
      request: confirmRequest, response: null, reason: 'server',
    }));

    expect(replica.getSnapshot()).toMatchObject({
      answeredClientRequestIds: ['ask-1', 'confirm-1'],
      messages: [{ parts: [expect.objectContaining({ output: { answers: {} } })] }],
    });
  });
});

function apply(replica: CodexConversationReplica, value: CodexConversationEvent): void {
  replica.apply(value);
}

function event<Type extends CodexConversationEvent['type']>(
  type: Type,
  turnId: string | undefined,
  payload: Extract<CodexConversationEvent, { type: Type }>['payload'],
): Extract<CodexConversationEvent, { type: Type }> {
  return {
    seq: nextSequence++,
    occurredAt: '2026-09-06T20:00:00.000Z',
    origin: 'notification' as CodexSurfaceEventOrigin,
    type,
    conversationId: 'conversation-1',
    ...(turnId ? { turnId } : {}),
    payload,
  } as Extract<CodexConversationEvent, { type: Type }>;
}

let nextSequence = 1;

function snapshot(overrides: Partial<CodexConversationSnapshot> = {}): CodexConversationSnapshot {
  return {
    status: 'ready',
    authentication: {
      status: 'loaded', account: null, requiresOpenaiAuth: false, error: null,
      login: { status: 'idle', loginId: null, authUrl: null, error: null },
    },
    conversations: [],
    activeConversationId: 'conversation-1',
    activeTurnId: null,
    turns: [],
    turnIds: [],
    messages: [],
    clientRequests: [],
    answeredClientRequestIds: [],
    approvals: [],
    models: [],
    modelCatalogStatus: 'notLoaded',
    skills: [],
    skillCatalogStatus: 'notLoaded',
    plugins: [],
    pluginCatalogStatus: 'notLoaded',
    permissionProfiles: [],
    approvalPresets: [],
    approvalPreset: null,
    selectedModelId: null,
    selectedReasoningEffort: null,
    selectedServiceTier: null,
    planMode: false,
    contextUsage: null,
    goal: null,
    turnGitDiff: null,
    threadStatus: { type: 'idle' },
    rateLimits: null,
    queuedPrompts: [],
    busy: false,
    historyLoading: false,
    historyState: {
      loadingStrategy: 'lazy', hasOlder: false, loadingOlder: false, fullyLoaded: true,
    },
    error: null,
    ...overrides,
  };
}

function turn(id: string) {
  return {
    id,
    status: 'completed' as const,
    error: null,
    willRetry: false,
    startedAt: '2026-09-06T20:00:00.000Z',
    completedAt: '2026-09-06T20:00:01.000Z',
    durationMs: 1000,
  };
}

function userMessage(id: string, text: string, turnId: string): SurfaceMessage {
  return {
    id, role: 'user', status: 'complete', turnId,
    parts: [{ type: 'text', text }],
    metadata: { conversationId: 'conversation-1', turnId },
  };
}

function assistantMessage(id: string, text: string, turnId: string): SurfaceMessage {
  return {
    id, role: 'assistant', status: 'streaming', turnId,
    parts: [{ type: 'text', text, itemId: 'agent-1' }],
    metadata: { conversationId: 'conversation-1', turnId },
  };
}
