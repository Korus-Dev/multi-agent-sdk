import {
  codexSurfaceBridgeArities,
  codexSurfaceBridgeOperations,
  invokeCodexSurfaceBridgeOperation,
  isCodexSurfaceBridgeOperation,
  type CodexSurfaceBridgeOperation,
  type CodexSurfaceBridgeTarget,
} from '../../src/core/surface-bridge';
import { describe, expect, it, vi } from 'vitest';

function recordingTarget() {
  const calls = new Map<string, unknown[][]>();
  const target = Object.fromEntries(codexSurfaceBridgeOperations.map((operation) => [
    operation,
    async (...args: unknown[]) => {
      calls.set(operation, [...(calls.get(operation) ?? []), args]);
      return { operation };
    },
  ])) as unknown as CodexSurfaceBridgeTarget;
  return { calls, target };
}

async function expectRejected(
  operation: CodexSurfaceBridgeOperation,
  args: readonly unknown[],
  message: string,
  options: Parameters<typeof invokeCodexSurfaceBridgeOperation>[3] = {},
) {
  const { target } = recordingTarget();
  await expect(invokeCodexSurfaceBridgeOperation(target, operation, args, options)).rejects.toThrow(message);
}

describe('Codex surface bridge', () => {
  it('recognizes every supported operation without accepting inherited names', () => {
    expect(codexSurfaceBridgeOperations).toContain('sendMessage');
    expect(isCodexSurfaceBridgeOperation('sendMessage')).toBe(true);
    expect(isCodexSurfaceBridgeOperation('toString')).toBe(false);
    expect(isCodexSurfaceBridgeOperation('__proto__')).toBe(false);
    expect(isCodexSurfaceBridgeOperation(42)).toBe(false);
    expect(codexSurfaceBridgeArities).toStrictEqual({
      archiveConversation: [1, 1], cancelLogin: [0, 1], clearGoal: [0, 0],
      compactConversation: [0, 0], connect: [0, 0], continueInterruptedTurn: [0, 0], createConversation: [0, 1],
      deleteConversation: [1, 1], deleteTurn: [1, 1], deleteQueuedPrompt: [1, 1],
      editTurn: [2, 3], forkTurn: [1, 1], getSnapshot: [0, 0], interrupt: [0, 0],
      listConversations: [0, 1], listModels: [0, 1], listSkills: [0, 1], loadOlderConversationHistory: [0, 1], loadTurnHistory: [1, 2],
      logout: [0, 0], readConversationHistory: [0, 1], readConversationPromptHistory: [0, 1],
      refreshAccount: [0, 0], refreshConversations: [0, 0], renameConversation: [1, 1],
      readRateLimits: [0, 1],
      readAccountUsage: [0, 0],
      consumeRateLimitResetCredit: [1, 1],
      respondToClientRequest: [1, 1], resolveApproval: [2, 3], retryTurn: [1, 1],
      selectConversation: [1, 1], sendMessage: [1, 2], setGoal: [1, 2],
      startChatGptDeviceCodeLogin: [0, 0], startChatGptLogin: [0, 0],
      startLiveChat: [2, 2], stopLiveChat: [1, 1],
      startReview: [0, 1], steerMessage: [1, 2],
      steerQueuedPrompt: [1, 3], unarchiveConversation: [1, 1], updateConversationSettings: [1, 1],
      updateQueuedPrompt: [2, 3],
    });
  });

  it('routes every supported operation with validated arguments', async () => {
    const { calls, target } = recordingTarget();
    const prompt = '$cp Alex';
    const authored = { content: [{ type: 'text', text: '$cp ' }, { type: 'mention', kind: 'custom', id: 'agent-1', value: 'agent:1', label: 'Alex', groupId: 'agents' }] };
    const resolveAttachment = vi.fn(async (attachment: { type: 'file' | 'image' }) => attachment.type === 'image'
      ? { type: 'image' as const, path: '/srv/image.png', name: 'image.png', mimeType: 'image/png' }
      : { type: 'file' as const, path: '/srv/notes.md', name: 'notes.md', mimeType: 'text/markdown' });
    const cases: Array<{
      operation: CodexSurfaceBridgeOperation;
      args: readonly unknown[];
      expected?: readonly unknown[];
    }> = [
      { operation: 'archiveConversation', args: ['conversation-1'] },
      { operation: 'cancelLogin', args: ['login-1'] },
      { operation: 'clearGoal', args: [] },
      { operation: 'compactConversation', args: [] },
      { operation: 'connect', args: [] },
      { operation: 'continueInterruptedTurn', args: [] },
      { operation: 'createConversation', args: [{ model: 'gpt-5', reasoningEffort: 'high', serviceTier: null, approvalPreset: 'full-access' }] },
      { operation: 'deleteConversation', args: ['conversation-1'] },
      { operation: 'deleteTurn', args: ['turn-1'] },
      { operation: 'deleteQueuedPrompt', args: ['queued-1'] },
      { operation: 'editTurn', args: ['turn-2', prompt, authored] },
      { operation: 'forkTurn', args: ['turn-1'] },
      { operation: 'getSnapshot', args: [] },
      { operation: 'interrupt', args: [] },
      {
        operation: 'listConversations',
        args: [{ archived: true, cwd: ['/workspace/a', '/workspace/b'], limit: 20, searchTerm: 'needle' }],
      },
      { operation: 'listModels', args: [{ includeHidden: true, forceReload: false }] },
      { operation: 'listSkills', args: [{ cwd: '/workspace', forceReload: true }] },
      { operation: 'loadOlderConversationHistory', args: ['conversation-1'] },
      { operation: 'loadTurnHistory', args: ['turn-1', 'conversation-1'] },
      { operation: 'logout', args: [] },
      { operation: 'readConversationHistory', args: ['conversation-1'] },
      { operation: 'readConversationPromptHistory', args: ['conversation-1'] },
      { operation: 'refreshAccount', args: [] },
      { operation: 'readRateLimits', args: [{ excludeResetCreditDetails: false }] },
      { operation: 'readAccountUsage', args: [] },
      { operation: 'consumeRateLimitResetCredit', args: [{ idempotencyKey: 'logical-attempt', creditId: 'opaque-id' }] },
      { operation: 'refreshConversations', args: [] },
      { operation: 'renameConversation', args: ['New title'] },
      {
        operation: 'respondToClientRequest',
        args: [{
          id: 'request-1',
          payload: {
            answers: { question: { answers: ['one', 'two'] } },
            cancelled: false,
            decision: 'allow_conversation',
          },
        }],
      },
      { operation: 'resolveApproval', args: ['approval-1', 'approve', 'session'] },
      { operation: 'retryTurn', args: ['turn-3'] },
      { operation: 'selectConversation', args: ['conversation-1'] },
      {
        operation: 'sendMessage',
        args: [prompt, {
          ...authored, inputMethod: 'dictated',
          attachments: [
            { type: 'image', reference: 'attachment:image', detail: 'high' },
            { type: 'file', reference: 'attachment:file' },
          ],
          model: 'gpt-5',
          reasoningEffort: 'medium',
          serviceTier: 'priority',
          planMode: true,
          skills: [{ name: 'review', path: '/skills/review' }],
          outputSchema: { type: 'object', required: ['result'], nullable: null },
        }],
        expected: [prompt, {
          ...authored, inputMethod: 'dictated',
          attachments: [
            { type: 'image', path: '/srv/image.png', name: 'image.png', mimeType: 'image/png', detail: 'high' },
            { type: 'file', path: '/srv/notes.md', name: 'notes.md', mimeType: 'text/markdown' },
          ],
          model: 'gpt-5',
          reasoningEffort: 'medium',
          serviceTier: 'priority',
          planMode: true,
          skills: [{ name: 'review', path: '/skills/review' }],
          outputSchema: { type: 'object', required: ['result'], nullable: null },
        }],
      },
      { operation: 'setGoal', args: ['Ship it', 500] },
      { operation: 'startLiveChat', args: ['thread', { sdp: 'offer', version: 'v3', model: 'realtime', voice: 'marin', prompt: '', includeStartupContext: false, flushTranscriptTailOnSessionEnd: true }] },
      { operation: 'stopLiveChat', args: ['thread'] },
      { operation: 'startChatGptDeviceCodeLogin', args: [] },
      { operation: 'startChatGptLogin', args: [] },
      { operation: 'startReview', args: [{ target: { type: 'custom', instructions: 'Focus on errors' } }] },
      { operation: 'steerMessage', args: [prompt, { ...authored, inputMethod: 'typed' }] },
      { operation: 'steerQueuedPrompt', args: ['queued-1', prompt, authored] },
      { operation: 'unarchiveConversation', args: ['conversation-1'] },
      {
        operation: 'updateConversationSettings',
        args: [{ modelId: 'gpt-5', reasoningEffort: 'high', serviceTier: null, approvalPreset: 'approve-for-me', planMode: false }],
      },
      { operation: 'updateQueuedPrompt', args: ['queued-1', prompt, authored] },
    ];

    expect(cases.map(({ operation }) => operation).sort()).toStrictEqual([...codexSurfaceBridgeOperations].sort());
    for (const { operation, args, expected = args } of cases) {
      await expect(invokeCodexSurfaceBridgeOperation(target, operation, args, { resolveAttachment }))
        .resolves.toStrictEqual({ operation });
      expect(calls.get(operation)).toStrictEqual([[...expected]]);
    }
    expect(resolveAttachment).toHaveBeenCalledTimes(2);
  });

  it('validates and forwards renderer input including service tiers', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ marker: 'snapshot' });
    const target = { sendMessage } as unknown as CodexSurfaceBridgeTarget;

    await expect(invokeCodexSurfaceBridgeOperation(target, 'sendMessage', [
      'Hello',
      {
        attachments: [{ type: 'file', reference: 'attachment:notes' }],
        serviceTier: 'priority',
        planMode: true,
      },
    ], {
      resolveAttachment: async (attachment) => ({
        type: attachment.type,
        path: '/srv/user/notes.md',
        name: 'notes.md',
      }),
    })).resolves.toStrictEqual({ marker: 'snapshot' });
    expect(sendMessage).toHaveBeenCalledWith('Hello', {
      attachments: [{ type: 'file', path: '/srv/user/notes.md', name: 'notes.md' }],
      serviceTier: 'priority',
      planMode: true,
    });
  });

  it('supports optional account operations without requiring older hosts to implement them', async () => {
    const { calls, target } = recordingTarget();
    await invokeCodexSurfaceBridgeOperation(target, 'readRateLimits', []);
    await invokeCodexSurfaceBridgeOperation(target, 'readRateLimits', [{}]);
    expect(calls.get('readRateLimits')).toStrictEqual([[undefined], [{}]]);
    delete target.readRateLimits;
    await expect(invokeCodexSurfaceBridgeOperation(target, 'readRateLimits', []))
      .rejects.toThrow('Account rate-limit reads are not available.');
    delete target.readAccountUsage;
    await expect(invokeCodexSurfaceBridgeOperation(target, 'readAccountUsage', []))
      .rejects.toThrow('Account usage reads are not available.');
    await invokeCodexSurfaceBridgeOperation(target, 'consumeRateLimitResetCredit', [{ idempotencyKey: 'provider-selects' }]);
    expect(calls.get('consumeRateLimitResetCredit')).toStrictEqual([[{ idempotencyKey: 'provider-selects' }]]);
    delete target.consumeRateLimitResetCredit;
    await expect(invokeCodexSurfaceBridgeOperation(target, 'consumeRateLimitResetCredit', [{ idempotencyKey: 'attempt' }]))
      .rejects.toThrow('Rate-limit reset credits are not available.');
  });

  it('rejects malformed arity and non-serializable nested values', async () => {
    const target = { sendMessage: vi.fn() } as unknown as CodexSurfaceBridgeTarget;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(invokeCodexSurfaceBridgeOperation(
      target,
      'sendMessage',
      [],
      { operationLabel: 'transport:send-message' },
    )).rejects.toThrow('transport:send-message received an invalid number of arguments');
    await expect(invokeCodexSurfaceBridgeOperation(target, 'sendMessage', [
      'Hello',
      { outputSchema: cyclic },
    ])).rejects.toThrow('Message output schema must be JSON-serializable');
    expect(target.sendMessage).not.toHaveBeenCalled();
  });

  it('validates operation arity at both bounds', async () => {
    await expectRejected('connect', ['unexpected'], 'connect received an invalid number of arguments');
    await expectRejected('editTurn', [0], 'editTurn received an invalid number of arguments');
  });

  it('accepts omitted optional values', async () => {
    const { calls, target } = recordingTarget();
    await invokeCodexSurfaceBridgeOperation(target, 'cancelLogin', []);
    await invokeCodexSurfaceBridgeOperation(target, 'createConversation', []);
    await invokeCodexSurfaceBridgeOperation(target, 'listConversations', []);
    await invokeCodexSurfaceBridgeOperation(target, 'listModels', []);
    await invokeCodexSurfaceBridgeOperation(target, 'loadOlderConversationHistory', []);
    await invokeCodexSurfaceBridgeOperation(target, 'readConversationHistory', []);
    await invokeCodexSurfaceBridgeOperation(target, 'readConversationPromptHistory', []);
    await invokeCodexSurfaceBridgeOperation(target, 'sendMessage', ['hello']);
    await invokeCodexSurfaceBridgeOperation(target, 'setGoal', ['goal']);
    await invokeCodexSurfaceBridgeOperation(target, 'startReview', []);
    await invokeCodexSurfaceBridgeOperation(target, 'createConversation', [{}]);
    await invokeCodexSurfaceBridgeOperation(target, 'listConversations', [{}]);
    await invokeCodexSurfaceBridgeOperation(target, 'listModels', [{}]);
    await invokeCodexSurfaceBridgeOperation(target, 'updateConversationSettings', [{}]);
    await invokeCodexSurfaceBridgeOperation(target, 'respondToClientRequest', [{ id: 'request', payload: {} }]);
    await invokeCodexSurfaceBridgeOperation(target, 'sendMessage', ['hello', {}]);
    expect(calls.get('cancelLogin')).toStrictEqual([[undefined]]);
    expect(calls.get('createConversation')).toStrictEqual([[undefined], [{}]]);
    expect(calls.get('listConversations')).toStrictEqual([[undefined], [{}]]);
    expect(calls.get('listModels')).toStrictEqual([[undefined], [{}]]);
    expect(calls.get('loadOlderConversationHistory')).toStrictEqual([[undefined]]);
    expect(calls.get('readConversationHistory')).toStrictEqual([[undefined]]);
    expect(calls.get('readConversationPromptHistory')).toStrictEqual([[undefined]]);
    expect(calls.get('setGoal')).toStrictEqual([['goal', undefined]]);
    expect(calls.get('startReview')).toStrictEqual([[undefined]]);
    expect(calls.get('updateConversationSettings')).toStrictEqual([[{}]]);
    expect(calls.get('respondToClientRequest')).toStrictEqual([[{ id: 'request', payload: {} }]]);
    expect(calls.get('sendMessage')).toStrictEqual([['hello', undefined], ['hello', {}]]);
  });

  it('accepts alternate list, response, approval, goal, and review forms', async () => {
    const { calls, target } = recordingTarget();
    await invokeCodexSurfaceBridgeOperation(target, 'listConversations', [{ cwd: '/workspace' }]);
    await invokeCodexSurfaceBridgeOperation(target, 'listConversations', [{ limit: 0 }]);
    await invokeCodexSurfaceBridgeOperation(target, 'respondToClientRequest', [{ id: 'request-1' }]);
    await invokeCodexSurfaceBridgeOperation(target, 'respondToClientRequest', [{ id: 'request-2', payload: { decision: null } }]);
    for (const decision of ['allow', 'always_allow', 'deny'] as const) {
      await invokeCodexSurfaceBridgeOperation(target, 'respondToClientRequest', [{
        id: `request-${decision}`,
        payload: { decision },
      }]);
    }
    await invokeCodexSurfaceBridgeOperation(target, 'resolveApproval', ['approval-1', 'deny']);
    await invokeCodexSurfaceBridgeOperation(target, 'resolveApproval', ['approval-2', 'approve', 'once']);
    await invokeCodexSurfaceBridgeOperation(target, 'createConversation', [{ approvalPreset: 'ask-for-approval' }]);
    await invokeCodexSurfaceBridgeOperation(target, 'setGoal', ['goal', null]);
    await invokeCodexSurfaceBridgeOperation(target, 'startReview', [{}]);
    await invokeCodexSurfaceBridgeOperation(target, 'startReview', [{ target: { type: 'uncommittedChanges' } }]);
    await invokeCodexSurfaceBridgeOperation(target, 'startReview', [{ target: { type: 'baseBranch', branch: 'main' } }]);
    await invokeCodexSurfaceBridgeOperation(target, 'startReview', [{ target: { type: 'commit', sha: 'abc123' } }]);
    await invokeCodexSurfaceBridgeOperation(target, 'startReview', [{ target: { type: 'commit', sha: 'abc123', title: null } }]);
    await invokeCodexSurfaceBridgeOperation(target, 'startReview', [{ target: { type: 'commit', sha: 'abc123', title: 'Review title' } }]);
    expect(calls.get('listConversations')).toStrictEqual([[{ cwd: '/workspace' }], [{ limit: 0 }]]);
    expect(calls.get('respondToClientRequest')).toStrictEqual([
      [{ id: 'request-1' }],
      [{ id: 'request-2', payload: { decision: null } }],
      [{ id: 'request-allow', payload: { decision: 'allow' } }],
      [{ id: 'request-always_allow', payload: { decision: 'always_allow' } }],
      [{ id: 'request-deny', payload: { decision: 'deny' } }],
    ]);
    expect(calls.get('resolveApproval')).toStrictEqual([
      ['approval-1', 'deny', undefined],
      ['approval-2', 'approve', 'once'],
    ]);
    expect(calls.get('createConversation')).toStrictEqual([[{ approvalPreset: 'ask-for-approval' }]]);
    expect(calls.get('startReview')).toStrictEqual([
      [{}],
      [{ target: { type: 'uncommittedChanges' } }],
      [{ target: { type: 'baseBranch', branch: 'main' } }],
      [{ target: { type: 'commit', sha: 'abc123' } }],
      [{ target: { type: 'commit', sha: 'abc123', title: null } }],
      [{ target: { type: 'commit', sha: 'abc123', title: 'Review title' } }],
    ]);
  });

  it.each([
    ['sendMessage', ['Literal', { inputMethod: 'unknown' }], 'Message input method must be typed or dictated'],
    ['consumeRateLimitResetCredit', [{}], 'Reset-credit idempotency key must be a non-empty string'],
    ['consumeRateLimitResetCredit', [{ idempotencyKey: ' ' }], 'Reset-credit idempotency key must be a non-empty string'],
    ['consumeRateLimitResetCredit', [{ idempotencyKey: 'key', creditId: null }], 'Reset credit id must be a non-empty string'],
    ['consumeRateLimitResetCredit', [{ idempotencyKey: 'key', accountId: 'account' }], 'Reset-credit options contains unsupported property "accountId"'],
    ['readRateLimits', [{ excludeResetCreditDetails: 'yes' }], 'Exclude reset credit details must be a boolean'],
    ['readRateLimits', [{ threadId: 'thread' }], 'Rate-limit read options contains unsupported property "threadId"'],
    ['startLiveChat', ['thread', { sdp: '' }], 'SDP offer must be a non-empty string'],
    ['startLiveChat', ['thread', { sdp: 'offer', version: 'v4' }], 'Invalid realtime version'],
    ['startLiveChat', ['thread', { sdp: 'offer', includeStartupContext: 'yes' }], 'includeStartupContext must be a boolean'],
    ['startLiveChat', ['thread', { sdp: 'offer', prompt: 42 }], 'Prompt must be a string or null'],
    ['startLiveChat', ['thread', { sdp: 'offer', cwd: '/tmp' }], 'Live chat options contains unsupported property "cwd"'],
    ['archiveConversation', [' '], 'Conversation id must be a non-empty string'],
    ['createConversation', [null], 'Conversation options must be an object'],
    ['createConversation', [{ unknown: true }], 'Conversation options contains unsupported property "unknown"'],
    ['createConversation', [{ model: '' }], 'Conversation model must be a non-empty string'],
    ['createConversation', [{ reasoningEffort: 1 }], 'Conversation reasoning effort must be a non-empty string'],
    ['createConversation', [{ serviceTier: 1 }], 'Conversation service tier must be a non-empty string'],
    ['createConversation', [{ approvalPreset: 'sometimes' }], 'Conversation approval preset is invalid'],
    ['listConversations', [{ archived: 'yes' }], 'Conversation list archived flag must be a boolean'],
    ['listConversations', [null], 'Conversation list options must be an object'],
    ['listConversations', [{ extra: true }], 'Conversation list options contains unsupported property "extra"'],
    ['listConversations', [{ limit: -1 }], 'Conversation list limit must be a non-negative integer'],
    ['listConversations', [{ limit: 1.5 }], 'Conversation list limit must be a non-negative integer'],
    ['listConversations', [{ cwd: [''] }], 'Conversation list cwd must be a non-empty string'],
    ['listConversations', [{ cwd: '' }], 'Conversation list cwd must be a non-empty string'],
    ['listConversations', [{ searchTerm: '' }], 'Conversation list search term must be a non-empty string'],
    ['listModels', [{ includeHidden: 'yes' }], 'Model list includeHidden must be a boolean'],
    ['listModels', [null], 'Model list options must be an object'],
    ['listModels', [{ extra: true }], 'Model list options contains unsupported property "extra"'],
    ['listModels', [{ forceReload: 1 }], 'Model list forceReload must be a boolean'],
    ['listSkills', [{ cwd: '' }], 'Skill list cwd must be a non-empty string'],
    ['listSkills', [{ forceReload: 1 }], 'Skill list forceReload must be a boolean'],
    ['listSkills', [{ extra: true }], 'Skill list options contains unsupported property "extra"'],
    ['updateConversationSettings', [{ modelId: '' }], 'Conversation model id must be a non-empty string'],
    ['updateConversationSettings', [null], 'Conversation settings must be an object'],
    ['updateConversationSettings', [{ extra: true }], 'Conversation settings contains unsupported property "extra"'],
    ['updateConversationSettings', [{ reasoningEffort: '' }], 'Conversation reasoning effort must be a non-empty string'],
    ['updateConversationSettings', [{ serviceTier: false }], 'Conversation service tier must be a non-empty string'],
    ['updateConversationSettings', [{ approvalPreset: null }], 'Conversation approval preset is invalid'],
    ['updateConversationSettings', [{ planMode: 'yes' }], 'Conversation plan mode must be a boolean'],
    ['cancelLogin', [false], 'Login id must be a non-empty string'],
    ['deleteConversation', [' '], 'Conversation id must be a non-empty string'],
    ['deleteQueuedPrompt', [' '], 'Queued prompt id must be a non-empty string'],
    ['editTurn', ['turn-1', ' '], 'Turn content must be a non-empty string'],
    ['loadTurnHistory', [' ', 'conversation-1'], 'Turn id must be a non-empty string'],
    ['loadTurnHistory', ['turn-1', ' '], 'Conversation id must be a non-empty string'],
    ['loadOlderConversationHistory', [' '], 'Conversation id must be a non-empty string'],
    ['readConversationHistory', [' '], 'Conversation id must be a non-empty string'],
    ['readConversationPromptHistory', [' '], 'Conversation id must be a non-empty string'],
    ['renameConversation', [' '], 'Conversation title must be a non-empty string'],
    ['resolveApproval', ['approval-1', 'later'], 'Approval decision is invalid'],
    ['resolveApproval', [' ', 'approve'], 'Approval id must be a non-empty string'],
    ['resolveApproval', ['approval-1', 'approve', 'forever'], 'Approval scope is invalid'],
    ['setGoal', ['goal', 0], 'Goal token budget must be a positive number or null'],
    ['setGoal', [' ', 1], 'Goal objective must be a non-empty string'],
    ['setGoal', ['goal', Number.POSITIVE_INFINITY], 'Goal token budget must be a positive number or null'],
    ['deleteTurn', [' '], 'Turn id must be a non-empty string'],
    ['forkTurn', [1.5], 'Turn id must be a non-empty string'],
    ['retryTurn', [' '], 'Turn id must be a non-empty string'],
    ['selectConversation', [' '], 'Conversation id must be a non-empty string'],
    ['sendMessage', [' '], 'Message prompt must be a non-empty string'],
    ['steerMessage', [' '], 'Steer prompt must be a non-empty string'],
    ['steerQueuedPrompt', [' ', 'prompt'], 'Queued prompt id must be a non-empty string'],
    ['steerQueuedPrompt', ['queue', ' '], 'Queued prompt must be a non-empty string'],
    ['unarchiveConversation', [' '], 'Conversation id must be a non-empty string'],
    ['updateQueuedPrompt', [' ', 'prompt'], 'Queued prompt id must be a non-empty string'],
    ['updateQueuedPrompt', ['queue', ' '], 'Queued prompt must be a non-empty string'],
  ] as const)('rejects invalid %s input', async (operation, args, message) => {
    await expectRejected(operation, args, message);
  });

  it.each([
    [null, 'Client request response must be an object'],
    [{ id: '' }, 'Client request id must be a non-empty string'],
    [{ id: 'request', extra: true }, 'Client request response contains unsupported property "extra"'],
    [{ id: 'request', payload: [] }, 'Client request response payload must be an object'],
    [{ id: 'request', payload: { extra: true } }, 'Client request response payload contains unsupported property "extra"'],
    [{ id: 'request', payload: { decision: 'maybe' } }, 'Client request decision is invalid'],
    [{ id: 'request', payload: { cancelled: 'no' } }, 'Client request cancelled flag must be a boolean'],
    [{ id: 'request', payload: { answers: [] } }, 'Client request answers must be an object'],
    [{ id: 'request', payload: { answers: { ' ': { answers: [] } } } }, 'Client request question id must be non-empty'],
    [{ id: 'request', payload: { answers: { question: null } } }, 'Client request answer must be an object'],
    [{ id: 'request', payload: { answers: { question: { extra: [] } } } }, 'Client request answer contains unsupported property "extra"'],
    [{ id: 'request', payload: { answers: { question: { answers: 'one' } } } }, 'Client request answer values must be an array of strings'],
    [{ id: 'request', payload: { answers: { question: { answers: [1] } } } }, 'Client request answer values must be an array of strings'],
    [{ id: 'request', payload: { answers: { question: { answers: ['one', 2] } } } }, 'Client request answer values must be an array of strings'],
  ] as const)('rejects malformed client responses', async (response, message) => {
    await expectRejected('respondToClientRequest', [response], message);
  });

  it.each([
    [null, 'Review options must be an object'],
    [{ extra: true }, 'Review options contains unsupported property "extra"'],
    [{ target: null }, 'Review target must be an object'],
    [{ target: { type: 'commit', sha: 'abc', title: 123 } }, 'Review commit title must be a string or null'],
    [{ target: { type: 'baseBranch', branch: '' } }, 'Review branch must be a non-empty string'],
    [{ target: { type: 'commit', sha: '' } }, 'Review commit SHA must be a non-empty string'],
    [{ target: { type: 'custom', instructions: '' } }, 'Review instructions must be a non-empty string'],
    [{ target: { type: 'other' } }, 'Review target type is invalid'],
    [{ target: { type: 'uncommittedChanges', extra: true } }, 'Review target contains unsupported property "extra"'],
    [{ target: { type: 'baseBranch', branch: 'main', extra: true } }, 'Review target contains unsupported property "extra"'],
    [{ target: { type: 'commit', sha: 'abc', extra: true } }, 'Review target contains unsupported property "extra"'],
    [{ target: { type: 'custom', instructions: 'Review', extra: true } }, 'Review target contains unsupported property "extra"'],
  ] as const)('rejects malformed review options', async (options, message) => {
    await expectRejected('startReview', [options], message);
  });

  it('rejects non-plain and symbol-bearing objects', async () => {
    await expectRejected('createConversation', ['options'], 'Conversation options must be an object');
    await expectRejected('createConversation', [new Date()], 'Conversation options must be a plain object');
    const options = { model: 'gpt-5' } as Record<PropertyKey, unknown>;
    options[Symbol('secret')] = true;
    await expectRejected('createConversation', [options], 'Conversation options must not contain symbol properties');

    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { model: 'gpt-5' });
    const { calls, target } = recordingTarget();
    await invokeCodexSurfaceBridgeOperation(target, 'createConversation', [nullPrototype]);
    expect(calls.get('createConversation')).toStrictEqual([[{ model: 'gpt-5' }]]);
  });
});
