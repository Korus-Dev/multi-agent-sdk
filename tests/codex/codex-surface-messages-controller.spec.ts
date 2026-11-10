import { describe, expect, it, vi } from 'vitest';
import type { SurfaceMessage } from '../../src/index';
import {
  CodexSurfaceMessagesController,
  type CodexSurfaceMessagesHost,
} from '../../src/providers/codex/codex-surface-messages-controller';
import { initialAuthentication } from '../../src/providers/codex/codex-surface-authentication';
import {
  createThreadRuntime,
  initialSurfaceSnapshot,
} from '../../src/providers/codex/codex-surface-runtime';

describe('CodexSurfaceMessagesController', () => {
  it('rejects blank sends after connecting and requires conversation creation to select a thread', async () => {
    const blank = messagesController({ active: false });
    await expect(blank.controller.send('   ')).rejects.toThrow('Cannot send an empty message');
    expect(blank.host.ensureConnected).toHaveBeenCalledOnce();
    expect(blank.host.createConversation).not.toHaveBeenCalled();

    const missing = messagesController({ active: false });
    vi.mocked(missing.host.createConversation).mockImplementation(async () => undefined);
    await expect(missing.controller.send('Hello')).rejects.toThrow('Codex did not create a conversation');
    expect(missing.host.createConversation).toHaveBeenCalledOnce();
  });

  it('creates and configures a conversation for zero-thread plan prompts', async () => {
    const setup = messagesController({ active: false });
    const send = vi.spyOn(setup.controller, 'sendToThread').mockResolvedValue();

    await expect(setup.controller.send(' /plan  Build carefully ', { serviceTier: 'priority' }))
      .resolves.toBe(setup.state);

    expect(setup.host.createConversation).toHaveBeenCalledOnce();
    expect(setup.host.updateSettings).toHaveBeenCalledExactlyOnceWith({ planMode: true });
    expect(send).toHaveBeenCalledExactlyOnceWith('thread-1', 'Build carefully', {
      serviceTier: 'priority', planMode: true,
    });
  });

  it('executes zero-thread plan, goal, compact, and review commands without normal sends', async () => {
    const plan = messagesController({ active: false });
    const planSend = vi.spyOn(plan.controller, 'sendToThread');
    await expect(plan.controller.send('/plan')).resolves.toBe(plan.state);
    expect(plan.host.createConversation).toHaveBeenCalledOnce();
    expect(plan.host.updateSettings).toHaveBeenCalledExactlyOnceWith({ planMode: true });
    expect(planSend).not.toHaveBeenCalled();

    for (const command of ['/goal', '/goal edit', '/goal clear', '/compact']) {
      const setup = messagesController({ active: false });
      await expect(setup.controller.send(command)).resolves.toBe(setup.state);
      expect(setup.host.createConversation).not.toHaveBeenCalled();
    }

    const goal = messagesController({ active: false });
    await expect(goal.controller.send('/goal Ship it')).resolves.toBe(goal.state);
    expect(goal.host.setGoal).toHaveBeenCalledExactlyOnceWith('Ship it');
    expect(goal.host.createConversation).not.toHaveBeenCalled();
    await expect(messagesController({ active: false }).controller.send('/goal pause'))
      .rejects.toThrow('Pausing and resuming goals is not supported');

    const review = messagesController({ active: false });
    await expect(review.controller.send('/review focus on races')).resolves.toBe(review.state);
    expect(review.host.createConversation).toHaveBeenCalledOnce();
    expect(review.host.startReview).toHaveBeenCalledExactlyOnceWith({
      target: { type: 'custom', instructions: 'focus on races' },
    });
  });

  it('routes thread-scoped slash commands and trims their prompts exactly', async () => {
    const setup = messagesController();
    const normal = vi.spyOn(setup.controller, 'sendPromptToThread').mockResolvedValue();

    await setup.controller.sendToThread('thread-1', ' /plan  Investigate ');
    expect(setup.host.updateSettingsForThread).toHaveBeenCalledExactlyOnceWith('thread-1', { planMode: true });
    expect(normal).toHaveBeenCalledExactlyOnceWith('thread-1', 'Investigate', { planMode: true });

    normal.mockClear();
    await setup.controller.sendToThread('thread-1', '/plan');
    expect(normal).not.toHaveBeenCalled();
    await setup.controller.sendToThread('thread-1', '/goal clear');
    expect(setup.host.clearGoalForThread).toHaveBeenCalledExactlyOnceWith('thread-1');
    await setup.controller.sendToThread('thread-1', '/goal Ship it');
    expect(setup.host.setGoalForThread).toHaveBeenCalledExactlyOnceWith('thread-1', 'Ship it');
    await setup.controller.sendToThread('thread-1', '/goal');
    await setup.controller.sendToThread('thread-1', '/goal edit');
    await expect(setup.controller.sendToThread('thread-1', '/goal resume')).rejects.toThrow('not supported');
    await setup.controller.sendToThread('thread-1', '/compact');
    expect(setup.host.compactForThread).toHaveBeenCalledExactlyOnceWith('thread-1');
    await setup.controller.sendToThread('thread-1', '/review');
    expect(setup.host.startReviewForThread).toHaveBeenCalledExactlyOnceWith('thread-1', {
      target: { type: 'uncommittedChanges' },
    });
  });

  it('validates explicit skills against the thread and forwards normalized options', async () => {
    const setup = messagesController();
    setup.runtime.skills = [{ name: 'review', path: '/skills/review/SKILL.md', enabled: true }];
    const send = vi.spyOn(setup.controller, 'sendPromptToThread').mockResolvedValue();
    await setup.controller.sendToThread('thread-1', 'Use it', {
      skills: [{ name: 'review', path: '/skills/review/SKILL.md' }],
    });
    expect(send).toHaveBeenCalledExactlyOnceWith('thread-1', 'Use it', {
      skills: [{ name: 'review', path: '/skills/review/SKILL.md' }],
    });
    await expect(setup.controller.sendToThread('thread-1', 'Use it', {
      skills: [{ name: 'review', path: '/wrong' }],
    })).rejects.toThrow("Skill 'review' is not an enabled skill");
    await expect(setup.controller.sendToThread('thread-1', '   ')).rejects.toThrow('empty message');
  });

  it('queues busy prompts with normalized options and emits compact queue replacements', async () => {
    const setup = messagesController({ busy: true });
    await setup.controller.sendPromptToThread('thread-1', 'Queue me');
    await setup.controller.sendPromptToThread('thread-1', 'Queue with options', { planMode: true });

    expect(setup.runtime.queuedPrompts).toEqual([
      { id: expect.any(String), text: 'Queue me' },
      { id: expect.any(String), text: 'Queue with options', options: { planMode: true } },
    ]);
    expect(setup.client.request).not.toHaveBeenCalled();
    expect(setup.host.emitEvent).toHaveBeenNthCalledWith(1, 'action', {
      type: 'conversation.queueChanged', conversationId: 'thread-1',
      payload: { queuedPrompts: [expect.objectContaining({ text: 'Queue me' })] },
    });
    expect(setup.host.emitEvent).toHaveBeenNthCalledWith(2, 'action', {
      type: 'conversation.queueChanged', conversationId: 'thread-1',
      payload: { queuedPrompts: [
        expect.objectContaining({ text: 'Queue me' }),
        expect.objectContaining({ text: 'Queue with options' }),
      ] },
    });
    expect(setup.host.patchConversationStatus).not.toHaveBeenCalled();
  });

  it('starts a prompt with exact optimistic state, inputs, settings, and events', async () => {
    const setup = messagesController();
    setup.runtime.skills = [{ name: 'review', path: '/skills/review/SKILL.md', enabled: true }];
    setup.state.skills = setup.runtime.skills;
    setup.state.selectedServiceTier = 'priority';
    const attachment = {
      type: 'file' as const, path: '/workspace/README.md', name: 'Read me', mimeType: 'text/markdown',
    };
    await setup.controller.sendPromptToThread('thread-1', 'Use $review', {
      attachments: [attachment], outputSchema: { type: 'object' },
    });

    expect(setup.client.request).toHaveBeenCalledExactlyOnceWith('turn/start', {
      threadId: 'thread-1', clientUserMessageId: expect.any(String),
      input: [
        { type: 'text', text: 'Use $review', text_elements: [] },
        { type: 'text', text: '<attached_file>\n{"name":"Read me","path":"/workspace/README.md"}\n</attached_file>', text_elements: [] },
      ],
      serviceTier: 'priority', outputSchema: { type: 'object' },
    });
    const optimistic = setup.runtime.messages.find((message) => message.role === 'user');
    expect(optimistic).toMatchObject({
      id: expect.any(String), role: 'user', status: 'complete',
      parts: [
        { type: 'text', text: 'Use $review' },
        { type: 'attachment', attachment: { kind: 'file', name: 'Read me', path: '/workspace/README.md' } },
      ],
      turnId: 'turn-new',
      metadata: { conversationId: 'thread-1', turnId: 'turn-new', attachments: [attachment] },
    });
    expect(setup.runtime).toMatchObject({ busy: true, turnStartPending: false, activeTurnId: 'turn-new' });
    expect(setup.runtime.messages.at(-1)).toMatchObject({
      id: 'assistant-turn-new', role: 'assistant', status: 'streaming',
      metadata: { conversationId: 'thread-1', turnId: 'turn-new' },
    });
    expect(setup.host.patchConversationTurnCount).toHaveBeenCalledExactlyOnceWith('thread-1', 1, 'action');
    expect(setup.host.patchConversationStatus).toHaveBeenNthCalledWith(1, 'thread-1', 'active', 'action');
    expect(setup.host.patchConversationStatus).toHaveBeenNthCalledWith(2, 'thread-1', 'active', 'action');
    expect(setup.host.emitEvent).toHaveBeenNthCalledWith(1, 'action', {
      type: 'message.appended', conversationId: 'thread-1', payload: { message: expect.objectContaining({ role: 'user' }) },
    });
    expect(setup.host.emitEvent).toHaveBeenNthCalledWith(2, 'action', {
      type: 'message.updated', conversationId: 'thread-1', turnId: 'turn-new',
      payload: {
        message: expect.objectContaining({
          role: 'user', turnId: 'turn-new',
          metadata: expect.objectContaining({ turnId: 'turn-new' }),
        }),
      },
    });
    expect(setup.host.emitEvent).toHaveBeenNthCalledWith(3, 'action', {
      type: 'turn.started', conversationId: 'thread-1', turnId: 'turn-new',
      payload: { startedAt: '2023-11-14T22:13:20.000Z' },
    });
    expect(setup.host.emitConversationActivity).toHaveBeenCalledTimes(2);
  });

  it('omits absent attachment and schema fields and labels both activity events as actions', async () => {
    const setup = messagesController();
    await setup.controller.sendPromptToThread('thread-1', 'Plain prompt');

    const request = setup.client.request.mock.calls[0];
    expect(request).toStrictEqual(['turn/start', {
      threadId: 'thread-1', clientUserMessageId: expect.any(String),
      input: [{ type: 'text', text: 'Plain prompt', text_elements: [] }],
    }]);
    const optimistic = setup.runtime.messages.find((message) => message.role === 'user');
    expect(optimistic?.metadata).toStrictEqual({ conversationId: 'thread-1', turnId: 'turn-new' });
    expect(setup.host.emitConversationActivity).toHaveBeenNthCalledWith(1, 'thread-1', 'action');
    expect(setup.host.emitConversationActivity).toHaveBeenNthCalledWith(2, 'thread-1', 'action');
  });

  it('settles immediately completed and previously known turns without assistant or duplicate turn event', async () => {
    const setup = messagesController();
    setup.runtime.turnIds = ['turn-done'];
    setup.client.request.mockResolvedValueOnce({ turn: codexTurn('turn-done', 'completed') });
    await setup.controller.sendPromptToThread('thread-1', 'Quick answer');

    expect(setup.runtime).toMatchObject({ busy: false, turnStartPending: false, activeTurnId: null });
    expect(setup.runtime.messages).toHaveLength(1);
    expect(setup.runtime.messages[0]).toMatchObject({ role: 'user', turnId: 'turn-done' });
    expect(setup.host.patchConversationStatus).toHaveBeenLastCalledWith('thread-1', 'idle', 'action');
    expect(setup.host.emitEvent).toHaveBeenCalledTimes(2);
    expect(setup.host.emitEvent).toHaveBeenLastCalledWith('action', {
      type: 'message.updated', conversationId: 'thread-1', turnId: 'turn-done',
      payload: { message: expect.objectContaining({ role: 'user', turnId: 'turn-done' }) },
    });
    expect(setup.host.patchConversationTurnCount).toHaveBeenCalledWith('thread-1', 1, 'action');

    const unknown = messagesController();
    unknown.client.request.mockResolvedValueOnce({ turn: codexTurn('turn-done', 'completed') });
    await unknown.controller.sendPromptToThread('thread-1', 'Also quick');
    expect(unknown.runtime.turnIds).toStrictEqual(['turn-done']);
    expect(unknown.host.emitEvent).toHaveBeenCalledTimes(2);
    expect(unknown.host.emitEvent).not.toHaveBeenCalledWith('action', expect.objectContaining({
      type: 'turn.started',
    }));
  });

  it('records turn-start failures while preserving the optimistic user message', async () => {
    const setup = messagesController();
    setup.client.request.mockRejectedValueOnce(new Error('start failed'));
    await expect(setup.controller.sendPromptToThread('thread-1', 'Will fail')).rejects.toThrow('start failed');

    expect(setup.runtime).toMatchObject({ busy: false, turnStartPending: false, error: 'start failed' });
    expect(setup.runtime.messages).toMatchObject([{ role: 'user', parts: [{ type: 'text', text: 'Will fail' }] }]);
    expect(setup.host.patchConversationStatus).toHaveBeenLastCalledWith('thread-1', 'error', 'action');
    expect(setup.host.emitConversationActivity).toHaveBeenCalledTimes(2);
    expect(setup.host.emitConversationActivity).toHaveBeenLastCalledWith('thread-1', 'action');
  });

  it('steers with exact optimistic segmentation, protocol input, authoritative turn, and events', async () => {
    const setup = messagesController({ activeTurnId: 'turn-old' });
    setup.runtime.messages = [assistant('turn-old', 'Before')];
    setup.client.request.mockResolvedValueOnce({ turnId: 'turn-new' });
    await setup.controller.steerForThread('thread-1', ' Redirect ', {
      attachments: [{ type: 'image', path: '/workspace/image.png', detail: 'high' }],
    });

    expect(setup.client.request).toHaveBeenCalledExactlyOnceWith('turn/steer', {
      threadId: 'thread-1', expectedTurnId: 'turn-old', clientUserMessageId: expect.any(String),
      input: [
        { type: 'text', text: 'Redirect', text_elements: [] },
        { type: 'localImage', path: '/workspace/image.png', detail: 'high' },
      ],
    });
    expect(setup.runtime.activeTurnId).toBe('turn-new');
    expect(setup.runtime.turnIds).toStrictEqual(['turn-new']);
    expect(setup.runtime.messages).toMatchObject([
      { role: 'assistant', status: 'complete', metadata: { turnId: 'turn-old' } },
      {
        kind: 'steer', role: 'user', status: 'complete', turnId: 'turn-new',
        parts: [
          { type: 'text', text: 'Redirect' },
          { type: 'attachment', attachment: { kind: 'image', path: '/workspace/image.png' } },
        ],
        metadata: { conversationId: 'thread-1', turnId: 'turn-new', attachments: [expect.any(Object)] },
      },
      { role: 'assistant', status: 'streaming', metadata: { turnId: 'turn-new' } },
    ]);
    expect(setup.host.emitEvent).toHaveBeenNthCalledWith(1, 'action', {
      type: 'message.appended', conversationId: 'thread-1', turnId: 'turn-old',
      payload: { message: expect.objectContaining({ kind: 'steer', turnId: 'turn-old' }) },
    });
    expect(setup.host.emitEvent).toHaveBeenNthCalledWith(2, 'action', {
      type: 'turn.started', conversationId: 'thread-1', turnId: 'turn-new',
      payload: { startedAt: expect.any(String) },
    });
    expect(setup.host.patchConversationTurnCount).toHaveBeenCalledExactlyOnceWith('thread-1', 1, 'action');
  });

  it('rejects invalid steering and records protocol failures without losing the optimistic steer', async () => {
    await expect(messagesController({ activeTurnId: 'turn-old' }).controller.steerForThread('thread-1', '  '))
      .rejects.toThrow('Cannot steer with an empty message');
    await expect(messagesController().controller.steerForThread('thread-1', 'Redirect'))
      .rejects.toThrow('There is no active turn to steer');

    const failed = messagesController({ activeTurnId: 'turn-old' });
    failed.client.request.mockRejectedValueOnce('rejected');
    await expect(failed.controller.steerForThread('thread-1', 'Redirect')).rejects.toBe('rejected');
    expect(failed.runtime.error).toBe('rejected');
    expect(failed.runtime.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'steer', role: 'user' }),
    ]));
    const optimistic = failed.runtime.messages.find((message) => message.kind === 'steer');
    expect(optimistic?.metadata).toStrictEqual({ conversationId: 'thread-1', turnId: 'turn-old' });
  });

  it('does not emit a duplicate turn-start event when steering stays on a known turn', async () => {
    const setup = messagesController({ activeTurnId: 'turn-known' });
    setup.runtime.turnIds = ['turn-known'];
    setup.runtime.messages = [assistant('turn-known', 'Before')];
    setup.client.request.mockResolvedValueOnce({ turnId: 'turn-known' });
    await setup.controller.steerForThread('thread-1', 'Continue');

    expect(setup.runtime.turnIds).toStrictEqual(['turn-known']);
    expect(setup.host.patchConversationTurnCount).toHaveBeenCalledExactlyOnceWith('thread-1', 1, 'action');
    expect(setup.host.emitEvent).toHaveBeenCalledExactlyOnceWith('action', {
      type: 'message.appended', conversationId: 'thread-1', turnId: 'turn-known',
      payload: {
        message: expect.objectContaining({
          kind: 'steer', metadata: { conversationId: 'thread-1', turnId: 'turn-known' },
        }),
      },
    });
  });

  it('uses active-conversation wrappers and rejects them when none is selected', async () => {
    const setup = messagesController();
    const steer = vi.spyOn(setup.controller, 'steerForThread').mockResolvedValue();
    await expect(setup.controller.steer('Hi', { planMode: true })).resolves.toBe(setup.state);
    expect(steer).toHaveBeenCalledExactlyOnceWith('thread-1', 'Hi', { planMode: true });

    const inactive = messagesController({ active: false });
    await expect(inactive.controller.steer('Hi')).rejects.toThrow('There is no active conversation');
    await expect(inactive.controller.deleteQueuedPrompt('id')).rejects.toThrow('There is no active conversation');
    await expect(inactive.controller.updateQueuedPrompt('id', 'text')).rejects.toThrow('There is no active conversation');
    await expect(inactive.controller.steerQueuedPrompt('id')).rejects.toThrow('There is no active conversation');
  });

  it('deletes and updates only the selected queued prompt', async () => {
    const setup = messagesController();
    setup.runtime.queuedPrompts = [
      { id: 'first', text: 'First' },
      { id: 'target', text: 'Original', options: { planMode: true } },
      { id: 'last', text: 'Last' },
    ];
    await setup.controller.updateQueuedPromptForThread('thread-1', 'target', ' Edited ');
    expect(setup.runtime.queuedPrompts).toStrictEqual([
      { id: 'first', text: 'First' },
      { id: 'target', text: 'Edited', options: { planMode: true } },
      { id: 'last', text: 'Last' },
    ]);
    await setup.controller.deleteQueuedPromptForThread('thread-1', 'target');
    expect(setup.runtime.queuedPrompts.map((prompt) => prompt.id)).toStrictEqual(['first', 'last']);
    await expect(setup.controller.updateQueuedPromptForThread('thread-1', 'missing', 'text'))
      .rejects.toThrow("Unknown queued prompt 'missing'");
    await expect(setup.controller.updateQueuedPromptForThread('thread-1', 'first', '   '))
      .rejects.toThrow('empty content');
    await expect(setup.controller.deleteQueuedPromptForThread('thread-1', 'missing'))
      .rejects.toThrow("Unknown queued prompt 'missing'");
  });

  it('removes and routes queued prompts through steer or send with preserved options', async () => {
    const busy = messagesController({ busy: true, activeTurnId: 'turn-old' });
    busy.runtime.queuedPrompts = [
      { id: 'keep', text: 'Keep' },
      { id: 'target', text: 'Original', options: { planMode: true } },
    ];
    const steer = vi.spyOn(busy.controller, 'steerForThread').mockResolvedValue();
    await busy.controller.steerQueuedPromptForThread('thread-1', 'target', 'Replacement');
    expect(busy.runtime.queuedPrompts).toStrictEqual([{ id: 'keep', text: 'Keep' }]);
    expect(steer).toHaveBeenCalledExactlyOnceWith('thread-1', 'Replacement', { planMode: true });

    const idle = messagesController();
    idle.runtime.queuedPrompts = [{ id: 'target', text: 'Original', options: { serviceTier: 'priority' } }];
    const send = vi.spyOn(idle.controller, 'sendToThread').mockResolvedValue();
    await idle.controller.steerQueuedPromptForThread('thread-1', 'target');
    expect(send).toHaveBeenCalledExactlyOnceWith('thread-1', 'Original', { serviceTier: 'priority' });
    expect(idle.runtime.queuedPrompts).toStrictEqual([]);
    await expect(idle.controller.steerQueuedPromptForThread('thread-1', 'missing'))
      .rejects.toThrow("Unknown queued prompt 'missing'");
  });

  it('drains one queued prompt only while idle and preserves order on failure', async () => {
    const guarded = messagesController({ busy: true });
    guarded.runtime.queuedPrompts = [{ id: 'queued', text: 'Queued' }];
    const guardedSend = vi.spyOn(guarded.controller, 'sendPromptToThread');
    await guarded.controller.sendNextQueuedPrompt('thread-1');
    expect(guardedSend).not.toHaveBeenCalled();
    guarded.runtime.busy = false;
    guarded.runtime.queuedPrompts = [];
    await guarded.controller.sendNextQueuedPrompt('thread-1');
    expect(guardedSend).not.toHaveBeenCalled();

    const success = messagesController();
    success.runtime.queuedPrompts = [
      { id: 'first', text: 'First', options: { planMode: true } },
      { id: 'second', text: 'Second' },
    ];
    const successSend = vi.spyOn(success.controller, 'sendPromptToThread').mockResolvedValue();
    await success.controller.sendNextQueuedPrompt('thread-1');
    expect(successSend).toHaveBeenCalledExactlyOnceWith('thread-1', 'First', { planMode: true });
    expect(success.runtime.queuedPrompts).toStrictEqual([{ id: 'second', text: 'Second' }]);

    const failed = messagesController();
    failed.runtime.queuedPrompts = [
      { id: 'first', text: 'First' },
      { id: 'second', text: 'Second' },
    ];
    vi.spyOn(failed.controller, 'sendPromptToThread').mockRejectedValue(new Error('send failed'));
    await failed.controller.sendNextQueuedPrompt('thread-1');
    expect(failed.runtime.error).toBe('send failed');
    expect(failed.runtime.queuedPrompts).toStrictEqual([
      { id: 'first', text: 'First' },
      { id: 'second', text: 'Second' },
    ]);
  });
});

function messagesController(options: {
  active?: boolean;
  activeTurnId?: string | null;
  busy?: boolean;
} = {}) {
  const state = initialSurfaceSnapshot(initialAuthentication());
  const threadId = 'thread-1';
  state.activeConversationId = options.active === false ? null : threadId;
  const runtime = createThreadRuntime(threadId, state, {
    activeTurnId: options.activeTurnId ?? null,
    busy: options.busy ?? false,
    cwd: '/workspace',
    hydrated: true,
  });
  const request = vi.fn(async (method: string) => method === 'turn/steer'
    ? { turnId: 'turn-new' }
    : { turn: codexTurn('turn-new', 'inProgress') });
  const host: CodexSurfaceMessagesHost = {
    clearGoalForThread: vi.fn(async () => undefined),
    compactForThread: vi.fn(async () => undefined),
    createConversation: vi.fn(async () => { state.activeConversationId = threadId; }),
    emitConversationActivity: vi.fn(),
    emitEvent: vi.fn(),
    ensureConnected: vi.fn(async () => undefined),
    ensureThreadReady: vi.fn(async () => runtime),
    loadSkillsForThread: vi.fn(async () => undefined),
    getSnapshot: vi.fn(() => state),
    getState: vi.fn(() => state),
    patchConversationStatus: vi.fn(),
    patchConversationTurnCount: vi.fn(),
    patchRuntime: vi.fn((_threadId, patch) => Object.assign(runtime, patch)),
    requireRuntime: vi.fn(() => runtime),
    setGoal: vi.fn(async () => state),
    setGoalForThread: vi.fn(async () => undefined),
    snapshotForRuntime: vi.fn(() => state),
    startReview: vi.fn(async () => state),
    startReviewForThread: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => state),
    updateSettingsForThread: vi.fn(async () => undefined),
  };
  const client = { request };
  return {
    client,
    controller: new CodexSurfaceMessagesController(client as never, host),
    host,
    runtime,
    state,
  };
}

function codexTurn(id: string, status: 'inProgress' | 'completed') {
  return { rootTurnId: null,
    id, status, items: [], itemsView: 'full', error: null,
    startedAt: 1_700_000_000, completedAt: null, durationMs: null,
  };
}

function assistant(turnId: string, text: string): SurfaceMessage {
  return {
    id: `assistant-${turnId}`, role: 'assistant', status: 'streaming',
    parts: [{ type: 'text', text }], turnId,
    metadata: { conversationId: 'thread-1', turnId },
  };
}
