import { normalizeMcpServers, mcpServerConfig } from './host-mcp';
import type { CodexAppServerClient, ServerNotification, v2 } from '@korus-dev/codex-sdk';
import type { CodexHostSnapshot } from '../../core/codex-host';
import type {
  HarnessTextGenerationResult,
  GenerateCodexTextOptions,
} from './host-contracts';
import {
  defaultReasoningEffort,
  requireCatalogModel,
  selectedModel,
  validateReasoningEffort,
  validateServiceTier,
} from './host-settings';
import { attachmentInput, validateAttachments } from './host-data';

const DEFAULT_GENERATION_TIMEOUT_MS = 120_000;

type PendingGeneration = {
  readonly promise: Promise<HarnessTextGenerationResult>;
  readonly resolve: (result: HarnessTextGenerationResult) => void;
  readonly reject: (error: Error) => void;
  readonly texts: string[];
  turnId: string | null;
};

export type CodexHostTextGenerationDependencies = {
  ensureConnected(): Promise<void>;
  getSnapshot(): CodexHostSnapshot;
};

/** Runs isolated, non-persisted text turns without projecting them into host state. */
export class CodexHostTextGenerationController {
  private readonly hiddenThreadIds = new Set<string>();
  private readonly pendingByThread = new Map<string, PendingGeneration>();

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly defaultCwd: string | undefined,
    private readonly host: CodexHostTextGenerationDependencies,
  ) {}

  /** Returns true when a notification belongs to an ephemeral thread and must stay hidden. */
  handleNotification(notification: ServerNotification): boolean {
    if (notification.method === 'thread/started' && notification.params.thread.ephemeral) {
      this.hiddenThreadIds.add(notification.params.thread.id);
    }
    const threadId = notificationThreadId(notification);
    if (!threadId || !this.hiddenThreadIds.has(threadId)) return false;

    const pending = this.pendingByThread.get(threadId);
    if (pending) this.consumeNotification(pending, notification);
    if (notification.method === 'thread/closed' || notification.method === 'thread/deleted') {
      this.hiddenThreadIds.delete(threadId);
    }
    return true;
  }

  async generate(prompt: string, options: GenerateCodexTextOptions = {}): Promise<HarnessTextGenerationResult> {
    const text = prompt.trim();
    if (!text) throw new Error('Generation prompt cannot be empty');
    if (options.signal?.aborted) throw abortedError();
    if (options.attachments?.some(attachment => attachment.type !== 'image')) {
      throw new Error('Utility generation accepts image attachments only');
    }
    const attachments = validateAttachments(options.attachments ?? []);
    const servers = normalizeMcpServers(options.mcpServers ?? []);
    await this.host.ensureConnected();

    const state = this.host.getSnapshot();
    const currentModel = selectedModel(state.models, state.selectedModelId);
    const requestedModel = options.model ? requireCatalogModel(state.models, options.model) : currentModel;
    const model = requestedModel?.model;
    const reasoningEffort = options.reasoningEffort
      ?? (requestedModel?.id === currentModel?.id
        ? state.selectedReasoningEffort
        : requestedModel ? defaultReasoningEffort(requestedModel) : null)
      ?? undefined;
    const serviceTier = options.serviceTier !== undefined
      ? options.serviceTier
      : requestedModel?.id === currentModel?.id
        ? state.selectedServiceTier
        : requestedModel?.defaultServiceTier ?? null;
    validateReasoningEffort(requestedModel, reasoningEffort);
    validateServiceTier(requestedModel, serviceTier);

    const started = await this.client.request('thread/start', {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      ...(options.baseInstructions === undefined ? {} : { baseInstructions: options.baseInstructions }),
      ...(options.developerInstructions === undefined
        ? {}
        : { developerInstructions: options.developerInstructions }),
      cwd: options.cwd ?? this.defaultCwd,
      dynamicTools: [],
      ...(servers.length ? { config: mcpServerConfig(servers) } : {}),
      ...(options.tools === 'read-only' ? {} : { environments: [] }),
      ephemeral: true,
      ...(model ? { model } : {}),
      permissions: ':read-only',
      serviceTier,
      serviceName: 'codex_app_sdk',
      threadSource: 'sdk_ephemeral_generation',
    });
    const threadId = started.thread.id;
    if (!started.thread.ephemeral) {
      await ignoreFailure(() => this.client.request('thread/delete', { threadId }));
      throw new Error('Codex app-server did not create an ephemeral generation thread');
    }
    this.hiddenThreadIds.add(threadId);
    if (options.signal?.aborted) {
      await ignoreFailure(() => this.client.request('thread/unsubscribe', { threadId }));
      this.hiddenThreadIds.delete(threadId);
      throw abortedError();
    }
    const pending = createPendingGeneration();
    this.pendingByThread.set(threadId, pending);
    let turnId: string | null = null;
    let completed = false;
    const abort = () => pending.reject(abortedError());
    options.signal?.addEventListener('abort', abort);
    const timeout = options.timeoutMs === null ? undefined : setTimeout(() => {
      pending.reject(new Error('Codex ephemeral generation timed out'));
    }, options.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS);

    try {
      const turnResponse = await this.client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }, ...attachments.map(attachmentInput)],
        ...(options.tools === 'read-only' ? {} : { environments: [] }),
        permissions: ':read-only',
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { effort: reasoningEffort as v2.TurnStartParams['effort'] } : {}),
        serviceTier,
        ...(options.outputSchema === undefined
          ? {}
          : { outputSchema: options.outputSchema as v2.TurnStartParams['outputSchema'] }),
      });
      turnId = turnResponse.turn.id;
      pending.turnId = turnId;
      completeFromTurn(pending, turnResponse.turn);
      const result = await pending.promise;
      completed = true;
      return result;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      this.pendingByThread.delete(threadId);
      if (!completed && turnId) {
        const interruptedTurnId = turnId;
        await ignoreFailure(() => this.client.request('turn/interrupt', {
          threadId, turnId: interruptedTurnId,
        }));
      }
      await ignoreFailure(() => this.client.request('thread/unsubscribe', { threadId }));
      this.hiddenThreadIds.delete(threadId);
    }
  }

  close(error = new Error('Codex host closed')): void {
    for (const pending of this.pendingByThread.values()) pending.reject(error);
    this.pendingByThread.clear();
    this.hiddenThreadIds.clear();
  }

  private consumeNotification(pending: PendingGeneration, notification: ServerNotification): void {
    if (notification.method === 'item/completed') {
      if (pending.turnId && notification.params.turnId !== pending.turnId) return;
      if (!pending.turnId) pending.turnId = notification.params.turnId;
      if (notification.params.item.type === 'agentMessage') {
        const text = notification.params.item.text.trim();
        if (text) pending.texts.push(text);
      }
      return;
    }
    if (notification.method === 'error') {
      if (pending.turnId && notification.params.turnId !== pending.turnId) return;
      if (!notification.params.willRetry) pending.reject(new Error(notification.params.error.message));
      return;
    }
    if (notification.method === 'turn/completed') {
      if (pending.turnId && notification.params.turn.id !== pending.turnId) return;
      completeFromTurn(pending, notification.params.turn);
    }
  }
}

async function ignoreFailure(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    // Best-effort cleanup must not replace the generation result or its original failure.
  }
}

function createPendingGeneration(): PendingGeneration {
  let resolvePromise!: (result: HarnessTextGenerationResult) => void;
  let rejectPromise!: (error: Error) => void;
  const pending: PendingGeneration = {
    promise: new Promise<HarnessTextGenerationResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (result) => {
      resolvePromise(result);
    },
    reject: (error) => {
      rejectPromise(error);
    },
    texts: [],
    turnId: null,
  };
  // The turn/start RPC may still be in flight when an abort, disconnect, or
  // timeout rejects completion. Mark the promise handled until generate awaits it.
  void pending.promise.catch(() => undefined);
  return pending;
}

function completeFromTurn(pending: PendingGeneration, turn: v2.Turn): void {
  for (const item of turn.items) {
    if (item.type !== 'agentMessage') continue;
    const text = item.text.trim();
    if (text) pending.texts.push(text);
  }
  if (turn.status === 'failed') {
    pending.reject(new Error(turn.error?.message ?? 'Codex ephemeral generation failed'));
    return;
  }
  if (turn.status === 'interrupted') {
    pending.reject(new Error('Codex ephemeral generation was interrupted'));
    return;
  }
  if (turn.status !== 'completed') return;
  const text = pending.texts.at(-1);
  if (!text) {
    pending.reject(new Error('Codex ephemeral generation returned no text'));
    return;
  }
  pending.resolve({ text });
}

function notificationThreadId(notification: ServerNotification): string | null {
  if (notification.method === 'thread/started') return notification.params.thread.id;
  const params = notification.params as { threadId?: unknown };
  return typeof params.threadId === 'string' ? params.threadId : null;
}

function abortedError(): Error {
  return new Error('Codex ephemeral generation was aborted');
}
