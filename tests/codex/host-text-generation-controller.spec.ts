import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelDescriptor, CodexHostSnapshot } from '../../src/index';
import type { CodexAppServerClient, v2 } from '@korus-dev/codex-sdk';
import { initialAuthentication } from '../../src/providers/codex/host-authentication';
import { initialHostSnapshot } from '../../src/providers/codex/host-runtime';
import { CodexHostTextGenerationController } from '../../src/providers/codex/host-text-generation-controller';
import { thread, turn } from './helpers/host-fixture';

afterEach(() => {
  vi.useRealTimers();
});

describe('CodexHostTextGenerationController', () => {
  it('rejects invalid prompts, image attachments and already-aborted requests before connecting', async () => {
    const setup = createController();
    await expect(setup.controller.generate(' \n ')).rejects.toThrow('Generation prompt cannot be empty');

    const abort = new AbortController();
    abort.abort();
    await expect(setup.controller.generate('prompt', { signal: abort.signal }))
      .rejects.toThrow('Codex ephemeral generation was aborted');

    await expect(setup.controller.generate('prompt', { attachments: [{ type: 'image', path: ' ' }] }))
      .rejects.toThrow('Attachment paths cannot be empty');
    await expect(setup.controller.generate('prompt', { attachments: [{ type: 'image', path: 'relative.png' }] }))
      .rejects.toThrow('Attachment path must be absolute');
    // @ts-expect-error Utility generation supports image attachments only, including at runtime.
    await expect(setup.controller.generate('prompt', { attachments: [{ type: 'file', path: '/tmp/file.txt' }] }))
      .rejects.toThrow('Utility generation accepts image attachments only');

    expect(setup.host.ensureConnected).not.toHaveBeenCalled();
    expect(setup.request).not.toHaveBeenCalled();
  });

  it('uses the selected model settings and sends the complete read-only RPC contract', async () => {
    const current = model({
      id: 'current-id',
      model: 'current-runtime',
      efforts: ['low', 'medium'],
      defaultEffort: 'medium',
      tiers: ['priority'],
    });
    const setup = createController({
      state: {
        models: [current],
        selectedModelId: 'current-id',
        selectedReasoningEffort: 'low',
        selectedServiceTier: 'priority',
      },
      turn: turnWithMessage('turn-1', 'completed', ' result '),
    });

    await expect(setup.controller.generate('  prompt text  ', {
      baseInstructions: '',
      developerInstructions: 'developer',
      cwd: '/override',
      outputSchema: { type: 'string' },
    })).resolves.toStrictEqual({ text: 'result' });

    expect(setup.host.ensureConnected).toHaveBeenCalledOnce();
    expect(setup.request).toHaveBeenNthCalledWith(1, 'thread/start', {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      baseInstructions: '',
      developerInstructions: 'developer',
      cwd: '/override',
      dynamicTools: [],
      environments: [],
      ephemeral: true,
      model: 'current-runtime',
      permissions: ':read-only',
      serviceTier: 'priority',
      serviceName: 'codex_app_sdk',
      threadSource: 'sdk_ephemeral_generation',
    });
    expect(setup.request).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'prompt text', text_elements: [] }],
      environments: [],
      permissions: ':read-only',
      model: 'current-runtime',
      effort: 'low',
      serviceTier: 'priority',
      outputSchema: { type: 'string' },
    });
    expect(setup.request).toHaveBeenNthCalledWith(3, 'thread/unsubscribe', { threadId: 'thread-1' });
    expect(setup.request).toHaveBeenCalledTimes(3);
  });

  it('uses an explicitly requested model default while allowing explicit option overrides', async () => {
    const current = model({ id: 'current', model: 'current-runtime', efforts: ['low'], defaultEffort: 'low' });
    const requested = model({
      id: 'requested',
      model: 'requested-runtime',
      efforts: ['medium', 'high'],
      defaultEffort: 'high',
      tiers: ['priority'],
      defaultTier: 'priority',
    });
    const setup = createController({
      state: {
        models: [current, requested],
        selectedModelId: 'current',
        selectedReasoningEffort: 'low',
        selectedServiceTier: null,
      },
      turn: turnWithMessage('turn-1', 'completed', 'answer'),
    });

    await expect(setup.controller.generate('prompt', { model: 'requested' }))
      .resolves.toStrictEqual({ text: 'answer' });
    expect(paramsFor(setup.request, 'thread/start')).toMatchObject({
      model: 'requested-runtime', serviceTier: 'priority', cwd: '/default',
    });
    expect(paramsFor(setup.request, 'turn/start')).toMatchObject({
      model: 'requested-runtime', effort: 'high', serviceTier: 'priority',
    });

    const explicit = createController({
      state: setup.state,
      turn: turnWithMessage('turn-1', 'completed', 'answer'),
    });
    await explicit.controller.generate('prompt', {
      model: 'requested-runtime', reasoningEffort: 'medium', serviceTier: null,
    });
    expect(paramsFor(explicit.request, 'turn/start')).toMatchObject({
      effort: 'medium', serviceTier: null,
    });
  });

  it('omits optional model fields when the catalog has no model', async () => {
    const setup = createController({ turn: turnWithMessage('turn-1', 'completed', 'answer') });

    await setup.controller.generate('prompt');

    expect(paramsFor(setup.request, 'thread/start')).toStrictEqual({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      cwd: '/default',
      dynamicTools: [],
      environments: [],
      ephemeral: true,
      permissions: ':read-only',
      serviceTier: null,
      serviceName: 'codex_app_sdk',
      threadSource: 'sdk_ephemeral_generation',
    });
    expect(paramsFor(setup.request, 'turn/start')).toStrictEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'prompt', text_elements: [] }],
      environments: [],
      permissions: ':read-only',
      serviceTier: null,
    });
  });

  it('validates generation model options before starting a thread', async () => {
    const current = model({ id: 'current', model: 'runtime', efforts: ['low'], tiers: ['priority'] });
    const setup = createController({ state: { models: [current], selectedModelId: 'current' } });

    await expect(setup.controller.generate('prompt', { model: 'missing' }))
      .rejects.toThrow("Unknown model 'missing'");
    await expect(setup.controller.generate('prompt', { reasoningEffort: 'high' }))
      .rejects.toThrow("Reasoning effort 'high' is not available");
    await expect(setup.controller.generate('prompt', { serviceTier: 'slow' }))
      .rejects.toThrow("Service tier 'slow' is not available");
    expect(setup.request).not.toHaveBeenCalled();
  });

  it('deletes a non-ephemeral thread and preserves the protocol error if deletion fails', async () => {
    const setup = createController({ ephemeral: false, rejectMethods: new Set(['thread/delete']) });

    await expect(setup.controller.generate('prompt'))
      .rejects.toThrow('Codex app-server did not create an ephemeral generation thread');
    expect(setup.request).toHaveBeenNthCalledWith(2, 'thread/delete', { threadId: 'thread-1' });
    expect(setup.request).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes without starting a turn when abort wins immediately after thread creation', async () => {
    const abort = new AbortController();
    const setup = createController({ onThreadStart: () => abort.abort() });

    await expect(setup.controller.generate('prompt', { signal: abort.signal }))
      .rejects.toStrictEqual(new Error('Codex ephemeral generation was aborted'));
    expect(methods(setup.request)).toStrictEqual(['thread/start', 'thread/unsubscribe']);
    expect(paramsFor(setup.request, 'thread/unsubscribe')).toStrictEqual({ threadId: 'thread-1' });
    expect(setup.controller.handleNotification(itemCompleted(
      'thread-1', 'turn-1', agentMessage('late'),
    ))).toBe(false);
  });

  it('routes only ephemeral thread notifications and forgets closed or deleted threads', () => {
    const setup = createController();
    expect(setup.controller.handleNotification(notification('thread/started', {
      thread: { ...thread('persisted', false), ephemeral: false },
    }))).toBe(false);
    expect(setup.controller.handleNotification(notification('thread/started', {
      thread: { ...thread('hidden', false), ephemeral: true },
    }))).toBe(true);
    expect(setup.controller.handleNotification(notification('item/completed', {
      threadId: 'hidden', turnId: 'turn', completedAtMs: 1, item: agentMessage('one'),
    }))).toBe(true);
    expect(setup.controller.handleNotification(notification('thread/closed', { threadId: 'hidden' })))
      .toBe(true);
    expect(setup.controller.handleNotification(notification('item/completed', {
      threadId: 'hidden', turnId: 'turn', completedAtMs: 1, item: agentMessage('two'),
    }))).toBe(false);
    expect(setup.controller.handleNotification(notification('thread/started', {
      thread: { ...thread('deleted', false), ephemeral: true },
    }))).toBe(true);
    expect(setup.controller.handleNotification(notification('thread/deleted', { threadId: 'deleted' })))
      .toBe(true);
    expect(setup.controller.handleNotification(notification('thread/deleted', { threadId: 'deleted' })))
      .toBe(false);
    expect(setup.controller.handleNotification(notification('account/updated', { authMode: 'chatgpt' })))
      .toBe(false);
  });

  it('accepts an item notification before turn/start returns and uses the latest agent text', async () => {
    let resolveTurn!: (value: unknown) => void;
    const turnResponse = new Promise((resolve) => { resolveTurn = resolve; });
    const setup = createController({ turnResponse });
    const generated = setup.controller.generate('prompt');
    await waitForRequest(setup.request, 'turn/start');

    expect(setup.controller.handleNotification(itemCompleted('thread-1', 'turn-1', agentMessage(' first '))))
      .toBe(true);
    expect(setup.controller.handleNotification(itemCompleted('thread-1', 'other', agentMessage('wrong'))))
      .toBe(true);
    resolveTurn({ turn: turn('turn-1', 'inProgress', []) });
    await Promise.resolve();
    setup.controller.handleNotification(itemCompleted('thread-1', 'turn-1', {
      type: 'userMessage', id: 'user', content: [], clientId: null,
    }));
    setup.controller.handleNotification(itemCompleted('thread-1', 'turn-1', agentMessage('   ')));
    setup.controller.handleNotification(notification('turn/completed', {
      threadId: 'thread-1',
      turn: turnWithMessage('turn-1', 'completed', ' final '),
    }));

    await expect(generated).resolves.toStrictEqual({ text: 'final' });
    expect(methods(setup.request)).toStrictEqual(['thread/start', 'turn/start', 'thread/unsubscribe']);
  });

  it('locks early item routing to the first observed turn and trims its text', async () => {
    let resolveTurn!: (value: unknown) => void;
    const turnResponse = new Promise((resolve) => { resolveTurn = resolve; });
    const setup = createController({ turnResponse });
    const generated = setup.controller.generate('prompt');
    await waitForRequest(setup.request, 'turn/start');

    setup.controller.handleNotification(itemCompleted('thread-1', 'turn-1', agentMessage(' first ')));
    setup.controller.handleNotification(itemCompleted('thread-1', 'other', agentMessage('wrong')));
    resolveTurn({ turn: turn('turn-1', 'inProgress', []) });
    await Promise.resolve();
    setup.controller.handleNotification(notification('turn/completed', {
      threadId: 'thread-1', turn: turn('turn-1', 'completed', []),
    }));

    await expect(generated).resolves.toStrictEqual({ text: 'first' });
  });

  it('ignores retryable and mismatched errors but rejects a matching fatal error', async () => {
    const setup = createController();
    const generated = setup.controller.generate('prompt');
    await waitForRequest(setup.request, 'turn/start');

    setup.controller.handleNotification(serverError('thread-1', 'other', false, 'wrong turn'));
    setup.controller.handleNotification(serverError('thread-1', 'turn-1', true, 'retrying'));
    setup.controller.handleNotification(serverError('thread-1', 'turn-1', false, 'generation exploded'));

    await expect(generated).rejects.toThrow('generation exploded');
    expect(setup.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-1', turnId: 'turn-1',
    });
    expect(setup.request).toHaveBeenCalledWith('thread/unsubscribe', { threadId: 'thread-1' });
  });

  it('ignores completion for another turn and does not let later notifications replace a result', async () => {
    const setup = createController();
    const generated = setup.controller.generate('prompt');
    await waitForRequest(setup.request, 'turn/start');

    setup.controller.handleNotification(notification('turn/completed', {
      threadId: 'thread-1', turn: turnWithMessage('other', 'completed', 'wrong'),
    }));
    setup.controller.handleNotification(notification('turn/completed', {
      threadId: 'thread-1', turn: turnWithMessage('turn-1', 'completed', 'first'),
    }));
    setup.controller.handleNotification(serverError('thread-1', 'turn-1', false, 'late failure'));
    setup.controller.handleNotification(notification('turn/completed', {
      threadId: 'thread-1', turn: turnWithMessage('turn-1', 'completed', 'second'),
    }));

    await expect(generated).resolves.toStrictEqual({ text: 'first' });
    expect(methods(setup.request)).not.toContain('turn/interrupt');
  });

  it('keeps waiting after an in-progress notification', async () => {
    const setup = createController();
    const generated = setup.controller.generate('prompt');
    await waitForRequest(setup.request, 'turn/start');

    setup.controller.handleNotification(notification('turn/completed', {
      threadId: 'thread-1', turn: turn('turn-1', 'inProgress', []),
    }));
    setup.controller.handleNotification(itemCompleted('thread-1', 'turn-1', agentMessage('answer')));
    setup.controller.handleNotification(notification('turn/completed', {
      threadId: 'thread-1', turn: turn('turn-1', 'completed', []),
    }));

    await expect(generated).resolves.toStrictEqual({ text: 'answer' });
  });

  it('ignores trailing blank notification text after a valid answer', async () => {
    const setup = createController();
    const generated = setup.controller.generate('prompt');
    await waitForRequest(setup.request, 'turn/start');

    setup.controller.handleNotification(itemCompleted('thread-1', 'turn-1', agentMessage('answer')));
    setup.controller.handleNotification(itemCompleted('thread-1', 'turn-1', agentMessage('   ')));
    setup.controller.handleNotification(notification('turn/completed', {
      threadId: 'thread-1', turn: turn('turn-1', 'completed', []),
    }));

    await expect(generated).resolves.toStrictEqual({ text: 'answer' });
  });

  it('ignores trailing blank turn text after a valid answer', async () => {
    const immediateTurn = turn('turn-1', 'completed', [
      agentMessage('answer'),
      agentMessage('   '),
    ]);
    const setup = createController({ turn: immediateTurn });

    await expect(setup.controller.generate('prompt')).resolves.toStrictEqual({ text: 'answer' });
  });

  it('rejects every immediate terminal turn without usable text', async () => {
    const outcomes = [
      [{ ...turn('turn-1', 'failed', []), error: { message: 'server failed' } }, 'server failed'],
      [turn('turn-1', 'failed', []), 'Codex ephemeral generation failed'],
      [turn('turn-1', 'interrupted', []), 'Codex ephemeral generation was interrupted'],
      [turn('turn-1', 'completed', []), 'Codex ephemeral generation returned no text'],
      [turn('turn-1', 'completed', [{
        type: 'userMessage', id: 'user', content: [], clientId: null,
      }]), 'Codex ephemeral generation returned no text'],
      [turnWithMessage('turn-1', 'completed', '   '), 'Codex ephemeral generation returned no text'],
    ] as const;

    for (const [immediateTurn, error] of outcomes) {
      const setup = createController({ turn: immediateTurn });

      await expect(setup.controller.generate('prompt')).rejects.toThrow(error);
      expect(setup.request).toHaveBeenCalledWith('turn/interrupt', {
        threadId: 'thread-1', turnId: 'turn-1',
      });
      expect(setup.request).toHaveBeenCalledWith('thread/unsubscribe', { threadId: 'thread-1' });
    }
  });

  it('cleans up without interrupting when turn/start itself fails', async () => {
    const setup = createController({ rejectMethods: new Set(['turn/start', 'thread/unsubscribe']) });

    await expect(setup.controller.generate('prompt')).rejects.toThrow('turn/start failed');
    expect(methods(setup.request)).toStrictEqual(['thread/start', 'turn/start', 'thread/unsubscribe']);
  });

  it.each([0, 25])('times out after %s ms and cleans up even when cleanup RPCs fail', async (timeoutMs) => {
    vi.useFakeTimers();
    const setup = createController({ rejectMethods: new Set(['turn/interrupt', 'thread/unsubscribe']) });
    const generated = setup.controller.generate('prompt', { timeoutMs });
    const rejection = expect(generated).rejects.toThrow('Codex ephemeral generation timed out');
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(timeoutMs);
    await rejection;
    expect(setup.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-1', turnId: 'turn-1',
    });
    expect(setup.request).toHaveBeenCalledWith('thread/unsubscribe', { threadId: 'thread-1' });
  });

  it('uses the default deadline unless explicitly disabled, while keeping unlimited generation cancellable', async () => {
    vi.useFakeTimers();
    const setup = createController();
    const generated = setup.controller.generate('prompt');
    const rejection = expect(generated).rejects.toThrow('Codex ephemeral generation timed out');
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(119_999);
    let settled = false;
    void generated.finally(() => { settled = true; }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;

    const abort = new AbortController();
    const unlimited = setup.controller.generate('prompt', { timeoutMs: null, signal: abort.signal });
    let unlimitedSettled = false;
    void unlimited.then(() => { unlimitedSettled = true; }, () => { unlimitedSettled = true; });
    await vi.advanceTimersByTimeAsync(240_000);
    expect(unlimitedSettled).toBe(false);
    abort.abort();
    await expect(unlimited).rejects.toThrow('Codex ephemeral generation was aborted');
    expect(methods(setup.request).slice(-2)).toStrictEqual(['turn/interrupt', 'thread/unsubscribe']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timeout and abort listener after successful completion', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const removeEventListener = vi.spyOn(abort.signal, 'removeEventListener');
    const setup = createController({ turn: turnWithMessage('turn-1', 'completed', 'answer') });

    await expect(setup.controller.generate('prompt', { signal: abort.signal }))
      .resolves.toStrictEqual({ text: 'answer' });

    expect(vi.getTimerCount()).toBe(0);
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(setup.controller.handleNotification(itemCompleted(
      'thread-1', 'turn-1', agentMessage('late'),
    ))).toBe(false);
  });

  it('close forgets a hidden thread even when no generation is pending', () => {
    const setup = createController();
    expect(setup.controller.handleNotification(notification('thread/started', {
      thread: { ...thread('hidden', false), ephemeral: true },
    }))).toBe(true);

    setup.controller.close(new Error('closed'));

    expect(setup.controller.handleNotification(itemCompleted(
      'hidden', 'turn-1', agentMessage('late'),
    ))).toBe(false);
  });

  it('close rejects active work, clears hidden routing, and is safe to call again', async () => {
    const setup = createController();
    const generated = setup.controller.generate('prompt');
    await waitForRequest(setup.request, 'turn/start');

    setup.controller.close();
    setup.controller.close(new Error('later close'));

    await expect(generated).rejects.toThrow('Codex host closed');
    expect(setup.controller.handleNotification(itemCompleted(
      'thread-1', 'turn-1', agentMessage('late'),
    ))).toBe(false);
  });
});

type ControllerOptions = {
  ephemeral?: boolean;
  onThreadStart?: () => void;
  rejectMethods?: Set<string>;
  state?: Partial<CodexHostSnapshot> | CodexHostSnapshot;
  turn?: unknown;
  turnResponse?: Promise<unknown>;
};

function createController(options: ControllerOptions = {}) {
  const state = 'authentication' in (options.state ?? {})
    ? options.state as CodexHostSnapshot
    : Object.assign(initialHostSnapshot(initialAuthentication()), options.state);
  const request = vi.fn(async (method: string, _params: unknown): Promise<unknown> => {
    if (options.rejectMethods?.has(method)) throw new Error(`${method} failed`);
    if (method === 'thread/start') {
      options.onThreadStart?.();
      return { thread: { ...thread('thread-1', false), ephemeral: options.ephemeral ?? true } };
    }
    if (method === 'turn/start') {
      if (options.turnResponse) return options.turnResponse;
      return { turn: options.turn ?? turn('turn-1', 'inProgress', []) };
    }
    return {};
  });
  const host = {
    ensureConnected: vi.fn(async () => undefined),
    getSnapshot: vi.fn(() => state),
  };
  const controller = new CodexHostTextGenerationController(
    { request } as unknown as CodexAppServerClient,
    '/default',
    host,
  );
  return { controller, host, request, state };
}

function model(options: {
  id: string;
  model: string;
  efforts?: string[];
  defaultEffort?: string;
  tiers?: string[];
  defaultTier?: string | null;
}): ModelDescriptor {
  return {
    id: options.id,
    model: options.model,
    displayName: options.id,
    supportedReasoningEfforts: options.efforts?.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    defaultReasoningEffort: options.defaultEffort,
    serviceTiers: options.tiers?.map((id) => ({ id, name: id, description: id })),
    defaultServiceTier: options.defaultTier,
  };
}

function agentMessage(text: string): v2.ThreadItem {
  return { type: 'agentMessage', id: `agent-${text}`, text, phase: null, memoryCitation: null, delivery: null, questions: null };
}

function turnWithMessage(id: string, status: v2.TurnStatus, text: string) {
  return turn(id, status, [agentMessage(text)]);
}

function notification(method: string, params: unknown) {
  return { method, params } as never;
}

function itemCompleted(threadId: string, turnId: string, item: unknown) {
  return notification('item/completed', { threadId, turnId, completedAtMs: 1, item });
}

function serverError(
  threadId: string,
  turnId: string,
  willRetry: boolean,
  message: string,
) {
  return notification('error', {
    threadId,
    turnId,
    error: { message, codexErrorInfo: null, additionalDetails: null },
    willRetry,
  });
}

function methods(request: ReturnType<typeof vi.fn>): string[] {
  return request.mock.calls.map(([method]) => String(method));
}

function paramsFor(request: ReturnType<typeof vi.fn>, method: string): unknown {
  return request.mock.calls.find(([candidate]) => candidate === method)?.[1];
}

async function waitForRequest(request: ReturnType<typeof vi.fn>, method: string): Promise<void> {
  await vi.waitFor(() => expect(methods(request)).toContain(method));
}
