import type {
  CodexSurfaceEvent,
  CodexSurfaceSnapshot,
} from '@korus-dev/multi-agent-sdk/surface';
import type { CodexSurfaceBridgeTarget } from '@korus-dev/multi-agent-sdk/surface-bridge';
import { vi } from 'vitest';
import type { CodexWebSocketClose, CodexWebSocketPort } from '../../src/web';

export const snapshot: CodexSurfaceSnapshot = {
  status: 'ready',
  authentication: {
    status: 'loaded',
    account: { type: 'chatgpt', email: 'web@example.test', planType: 'pro' },
    requiresOpenaiAuth: true,
    error: null,
    login: { status: 'idle', loginId: null, authUrl: null, error: null },
  },
  conversations: [],
  activeConversationId: null,
  activeTurnId: null,
  turns: [],
  messages: [],
  clientRequests: [],
  answeredClientRequestIds: [],
  approvals: [],
  models: [],
  modelCatalogStatus: 'loaded',
  skills: [],
  skillCatalogStatus: 'loaded',
  plugins: [],
  pluginCatalogStatus: 'loaded',
  permissionProfiles: [],
  approvalPresets: [],
  approvalPreset: null,
  selectedModelId: null,
  selectedReasoningEffort: null,
  planMode: false,
  contextUsage: null,
  goal: null,
  turnGitDiff: null,
  threadStatus: null,
  rateLimits: null,
  queuedPrompts: [],
  busy: false,
  historyLoading: false,
  error: null,
};

export class ManualSocket implements CodexWebSocketPort {
  readonly sent: string[] = [];
  readonly closes: CodexWebSocketClose[] = [];
  sendError: unknown;
  readonly #messages = new Set<(data: unknown) => void>();
  readonly #closeListeners = new Set<(close: CodexWebSocketClose) => void>();
  readonly #errors = new Set<(error: unknown) => void>();

  constructor(private readonly retainListeners = false) {}

  send(data: string): void {
    if (this.sendError !== undefined) throw this.sendError;
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  onMessage(listener: (data: unknown) => void): () => void {
    this.#messages.add(listener);
    return () => {
      if (!this.retainListeners) this.#messages.delete(listener);
    };
  }

  onClose(listener: (close: CodexWebSocketClose) => void): () => void {
    this.#closeListeners.add(listener);
    return () => {
      if (!this.retainListeners) this.#closeListeners.delete(listener);
    };
  }

  onError(listener: (error: unknown) => void): () => void {
    this.#errors.add(listener);
    return () => {
      if (!this.retainListeners) this.#errors.delete(listener);
    };
  }

  emitMessage(data: unknown): void {
    for (const listener of this.#messages) listener(data);
  }

  emitClose(close: CodexWebSocketClose): void {
    for (const listener of this.#closeListeners) listener(close);
  }

  emitError(error: unknown): void {
    for (const listener of this.#errors) listener(error);
  }

  listenerCounts(): { close: number; error: number; message: number } {
    return {
      close: this.#closeListeners.size,
      error: this.#errors.size,
      message: this.#messages.size,
    };
  }
}

export function readyMessage(value: CodexSurfaceSnapshot = snapshot): string {
  return JSON.stringify({ version: 1, type: 'ready', snapshot: value });
}

export function requestId(socket: ManualSocket, index = -1): string {
  const request = JSON.parse(socket.sent.at(index)!) as { id: string };
  return request.id;
}

export function fakeSurface(initialSnapshot: CodexSurfaceSnapshot = snapshot) {
  let stateListener: ((value: CodexSurfaceSnapshot) => void) | undefined;
  let eventListener: ((value: CodexSurfaceEvent) => void) | undefined;
  const connect = vi.fn(async () => initialSnapshot);
  const archiveConversation = vi.fn(async () => initialSnapshot);
  const refreshAccount = vi.fn(async () => initialSnapshot);
  const offState = vi.fn(() => { stateListener = undefined; });
  const offEvent = vi.fn(() => { eventListener = undefined; });
  const target = {
    connect,
    archiveConversation,
    refreshAccount,
    getSnapshot: vi.fn(() => initialSnapshot),
    onStateChange: vi.fn((listener: (value: CodexSurfaceSnapshot) => void) => {
      stateListener = listener;
      return offState;
    }),
    onEvent: vi.fn((listener: (value: CodexSurfaceEvent) => void) => {
      eventListener = listener;
      return offEvent;
    }),
  };
  return {
    target: target as unknown as CodexSurfaceBridgeTarget,
    connect,
    archiveConversation,
    refreshAccount,
    offState,
    offEvent,
    emitState: (value: CodexSurfaceSnapshot) => stateListener?.(value),
    emitEvent: (value: CodexSurfaceEvent) => eventListener?.(value),
  };
}

export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

export function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
