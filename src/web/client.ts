import {
  codexSurfaceBridgeOperations,
  type CodexSurfaceBridgeOperation,
  type CodexSurfaceBridgeOperationArguments,
  type CodexSurfaceBridgeOperationResult,
} from 'multi-agents-sdk/surface-bridge';
import type {
  CodexSurfaceEvent,
  CodexSurfaceRendererApi,
  CodexSurfaceSnapshot,
  CodexSurfaceStatePatch,
} from 'multi-agents-sdk/surface';
import { createCodexSurfaceStateMirror } from 'multi-agents-sdk/surface-bridge';
import {
  codexWebSocketProtocolVersion,
  encodeCodexWebSocketMessage,
  type CodexWebSocketErrorPayload,
} from './protocol';
import {
  codexWebSocketText,
  defaultCodexWebSocketMaximumMessageBytes,
  positiveWebSocketLimit,
  type CodexWebSocketClose,
  type CodexWebSocketPort,
} from './socket-port';

type Awaitable<Value> = Value | Promise<Value>;

export type CodexWebReconnectOptions = {
  maxAttempts?: number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
};

export type CreateCodexWebSurfaceClientOptions = {
  createSocket(): Awaitable<CodexWebSocketPort>;
  maxMessageBytes?: number;
  reconnect?: boolean | CodexWebReconnectOptions;
  requestTimeoutMs?: number;
};

export type CodexWebSurfaceClientConnectionState =
  | 'closed'
  | 'connecting'
  | 'disconnected'
  | 'ready';

export type CodexWebSurfaceClient = CodexSurfaceRendererApi & {
  disconnect(code?: number, reason?: string): void;
  getConnectionState(): CodexWebSurfaceClientConnectionState;
};

export class CodexWebSocketRemoteError extends Error {
  readonly code: CodexWebSocketErrorPayload['code'];

  constructor(error: CodexWebSocketErrorPayload) {
    super(error.message);
    this.name = 'CodexWebSocketRemoteError';
    this.code = error.code;
  }
}

export class CodexWebSocketTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexWebSocketTransportError';
  }
}

const defaultRequestTimeoutMs = 60_000;

export function createCodexWebSurfaceClient(
  options: CreateCodexWebSurfaceClientOptions,
): CodexWebSurfaceClient {
  const transport = new ClientTransport(options);
  const api: Record<string, unknown> = {
    disconnect: (code?: number, reason?: string) => transport.disconnect(code, reason),
    getConnectionState: () => transport.connectionState,
    onEvent: (listener: (event: CodexSurfaceEvent) => void) => transport.onEvent(listener),
    onStateChange: (listener: (snapshot: CodexSurfaceSnapshot) => void) => transport.onStateChange(listener),
  };
  for (const operation of codexSurfaceBridgeOperations) {
    api[operation] = operation === 'connect'
      ? () => transport.connect()
      : (...args: unknown[]) => transport.invoke(operation, args);
  }
  return Object.freeze(api) as CodexWebSurfaceClient;
}

export function createCodexBrowserWebSocketPort(socket: WebSocket): CodexWebSocketPort {
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (listener) => listenBrowserSocket(socket, 'message', (event) => listener(event.data)),
    onClose: (listener) => listenBrowserSocket(socket, 'close', (event) => listener({
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    })),
    onError: (listener) => listenBrowserSocket(socket, 'error', listener),
  };
}

class ClientTransport {
  readonly #createSocket: CreateCodexWebSurfaceClientOptions['createSocket'];
  readonly #maxMessageBytes: number;
  readonly #requestTimeoutMs: number;
  readonly #reconnect: Required<CodexWebReconnectOptions> | null;
  readonly #stateListeners = new Set<(snapshot: CodexSurfaceSnapshot) => void>();
  readonly #eventListeners = new Set<(event: CodexSurfaceEvent) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #socketUnsubscribers: Array<() => void> = [];
  #socket: CodexWebSocketPort | null = null;
  #connectPromise: Promise<CodexSurfaceSnapshot> | null = null;
  #readyWaiter: ReadyWaiter | null = null;
  #latestSnapshot: CodexSurfaceSnapshot | null = null;
  readonly #state = createCodexSurfaceStateMirror();
  #streamingPatches = false;
  #requestSequence = 0;
  #manualClose = false;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  connectionState: CodexWebSurfaceClientConnectionState = 'disconnected';

  constructor(options: CreateCodexWebSurfaceClientOptions) {
    this.#createSocket = options.createSocket;
    this.#maxMessageBytes = positiveWebSocketLimit(
      options.maxMessageBytes,
      defaultCodexWebSocketMaximumMessageBytes,
      'Codex WebSocket message byte limit',
    );
    this.#requestTimeoutMs = positiveWebSocketLimit(
      options.requestTimeoutMs,
      defaultRequestTimeoutMs,
      'Codex WebSocket request timeout',
    );
    this.#reconnect = reconnectOptions(options.reconnect);
  }

  connect(): Promise<CodexSurfaceSnapshot> {
    this.#manualClose = false;
    this.#clearReconnectTimer();
    if (this.connectionState === 'ready' && this.#latestSnapshot) {
      return Promise.resolve(this.#latestSnapshot);
    }
    return this.#beginConnect();
  }

  async invoke<Name extends CodexSurfaceBridgeOperation>(
    operation: Name,
    args: readonly unknown[],
  ): Promise<CodexSurfaceBridgeOperationResult<Name>> {
    await this.connect();
    const socket = this.#socket;
    if (!socket || this.connectionState !== 'ready') {
      throw new CodexWebSocketTransportError('Codex WebSocket is not connected');
    }
    const id = requestId(++this.#requestSequence);
    const result = new Promise<CodexSurfaceBridgeOperationResult<Name>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexWebSocketRemoteError({
          code: 'request_timeout',
          message: `Codex WebSocket request '${operation}' timed out`,
        }));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
    });
    try {
      socket.send(encodeCodexWebSocketMessage({
        version: codexWebSocketProtocolVersion,
        type: 'request',
        id,
        operation,
        args: webSocketArguments(args) as CodexSurfaceBridgeOperationArguments<Name>,
      }));
    } catch (error) {
      this.#rejectPending(id, transportError(error));
    }
    return result;
  }

  onStateChange(listener: (snapshot: CodexSurfaceSnapshot) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  onEvent(listener: (event: CodexSurfaceEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  disconnect(code = 1000, reason = 'Codex web client disconnected'): void {
    this.#manualClose = true;
    this.#clearReconnectTimer();
    const socket = this.#socket;
    if (socket) socket.close(code, reason);
    this.#handleClose({ code, reason, wasClean: true }, socket);
    this.connectionState = 'closed';
  }

  #beginConnect(): Promise<CodexSurfaceSnapshot> {
    if (this.#connectPromise) return this.#connectPromise;
    this.connectionState = 'connecting';
    const connecting = this.#open();
    this.#connectPromise = connecting;
    void connecting.finally(() => {
      if (this.#connectPromise === connecting) this.#connectPromise = null;
    }).catch(() => undefined);
    return connecting;
  }

  async #open(): Promise<CodexSurfaceSnapshot> {
    let socket: CodexWebSocketPort;
    try {
      socket = await this.#createSocket();
    } catch (error) {
      this.connectionState = 'disconnected';
      this.#scheduleReconnect();
      throw transportError(error);
    }
    if (this.#manualClose) {
      socket.close(1000, 'Codex web client is closed');
      throw new CodexWebSocketTransportError('Codex web client is closed');
    }
    this.#replaceSocket(socket);
    return new Promise<CodexSurfaceSnapshot>((resolve, reject) => {
      this.#readyWaiter = { socket, resolve, reject };
    });
  }

  #replaceSocket(socket: CodexWebSocketPort): void {
    this.#clearSocketListeners();
    this.#socket = socket;
    this.#socketUnsubscribers.push(
      socket.onMessage((data) => this.#receive(data, socket)),
      socket.onClose((close) => this.#handleClose(close, socket)),
    );
    if (socket.onError) {
      this.#socketUnsubscribers.push(socket.onError((error) => {
        this.#handleClose({ reason: errorMessage(error), wasClean: false }, socket);
      }));
    }
  }

  #receive(data: unknown, socket: CodexWebSocketPort): void {
    if (socket !== this.#socket || this.#manualClose) return;
    let message: Record<string, unknown>;
    try {
      const value = JSON.parse(codexWebSocketText(data, this.#maxMessageBytes)) as unknown;
      if (!isPlainObject(value) || value.version !== codexWebSocketProtocolVersion) {
        throw new TypeError('Invalid Codex WebSocket response');
      }
      message = value;
    } catch (error) {
      socket.close(4400, 'Invalid Codex WebSocket response');
      this.#handleClose({ code: 4400, reason: errorMessage(error) }, socket);
      return;
    }

    if (message.type === 'ready' && isPlainObject(message.snapshot) && isOptionalStateVersion(message.stateVersion)) {
      const snapshot = this.#adoptSnapshot(message.snapshot as CodexSurfaceSnapshot, message.stateVersion);
      this.#streamingPatches = false;
      this.connectionState = 'ready';
      this.#reconnectAttempts = 0;
      this.#emitSnapshot(snapshot);
      const waiter = this.#readyWaiter;
      this.#readyWaiter = null;
      if (waiter?.socket === socket) waiter.resolve(snapshot);
      // Servers that can stream patches advertise a state version; older ones keep sending snapshots.
      if (message.stateVersion !== undefined) this.#enableStatePatches(socket);
      return;
    }
    if (message.type === 'snapshot' && isPlainObject(message.snapshot) && isOptionalStateVersion(message.stateVersion)) {
      this.#emitSnapshot(this.#adoptSnapshot(message.snapshot as CodexSurfaceSnapshot, message.stateVersion));
      return;
    }
    if (message.type === 'statePatch' && this.#streamingPatches && isStatePatch(message.patch)) {
      const result = this.#state.receive(message.patch);
      if (result.status === 'applied') {
        this.#latestSnapshot = result.snapshot;
        this.#emitSnapshot(result.snapshot);
      } else if (result.status === 'resync') {
        // A fresh connection starts from a new versioned snapshot.
        socket.close(4001, 'Codex state stream desynchronized');
        this.#handleClose({ code: 4001, reason: 'Codex state stream desynchronized' }, socket);
      }
      return;
    }
    if (message.type === 'event' && isPlainObject(message.event)) {
      for (const listener of this.#eventListeners) listener(message.event as CodexSurfaceEvent);
      return;
    }
    if (message.type === 'response' && typeof message.id === 'string' && typeof message.ok === 'boolean') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.ok) {
        pending.resolve(message.result);
      } else if (isRemoteError(message.error)) {
        pending.reject(new CodexWebSocketRemoteError(message.error));
      } else {
        pending.reject(new CodexWebSocketTransportError('Codex WebSocket returned an invalid error'));
      }
      return;
    }
    socket.close(4400, 'Invalid Codex WebSocket response');
    this.#handleClose({ code: 4400, reason: 'Invalid Codex WebSocket response' }, socket);
  }

  #handleClose(close: CodexWebSocketClose, socket: CodexWebSocketPort | null): void {
    if (socket && socket !== this.#socket) return;
    if (socket === this.#socket) this.#socket = null;
    this.#clearSocketListeners();
    const error = new CodexWebSocketTransportError(
      close.reason?.trim() || `Codex WebSocket closed${close.code ? ` (${close.code})` : ''}`,
    );
    const waiter = this.#readyWaiter;
    this.#readyWaiter = null;
    if (waiter && (!socket || waiter.socket === socket)) waiter.reject(error);
    for (const id of [...this.#pending.keys()]) this.#rejectPending(id, error);
    if (this.#manualClose) {
      this.connectionState = 'closed';
      return;
    }
    this.connectionState = 'disconnected';
    if (shouldReconnect(close)) this.#scheduleReconnect();
  }

  #adoptSnapshot(snapshot: CodexSurfaceSnapshot, stateVersion: number | undefined): CodexSurfaceSnapshot {
    const adopted = stateVersion === undefined
      ? snapshot
      : this.#state.reset({ version: stateVersion, snapshot });
    this.#latestSnapshot = adopted;
    return adopted;
  }

  #enableStatePatches(socket: CodexWebSocketPort): void {
    try {
      socket.send(encodeCodexWebSocketMessage({ version: codexWebSocketProtocolVersion, type: 'enableStatePatches' }));
      this.#streamingPatches = true;
    } catch {
      // The session simply stays on snapshots.
    }
  }

  #emitSnapshot(snapshot: CodexSurfaceSnapshot): void {
    for (const listener of this.#stateListeners) listener(snapshot);
  }

  #rejectPending(id: string, error: Error): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  #scheduleReconnect(): void {
    const options = this.#reconnect;
    if (!options || this.#manualClose || this.#reconnectTimer) return;
    if (this.#reconnectAttempts >= options.maxAttempts) return;
    const delay = Math.min(
      options.initialDelayMs * (2 ** this.#reconnectAttempts),
      options.maximumDelayMs,
    );
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#beginConnect().catch(() => undefined);
    }, delay);
  }

  #clearReconnectTimer(): void {
    if (!this.#reconnectTimer) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #clearSocketListeners(): void {
    for (const unsubscribe of this.#socketUnsubscribers.splice(0)) unsubscribe();
  }
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
};

type ReadyWaiter = {
  socket: CodexWebSocketPort;
  resolve(snapshot: CodexSurfaceSnapshot): void;
  reject(error: unknown): void;
};

function listenBrowserSocket<Type extends keyof WebSocketEventMap>(
  socket: WebSocket,
  type: Type,
  listener: (event: WebSocketEventMap[Type]) => void,
): () => void {
  socket.addEventListener(type, listener);
  return () => socket.removeEventListener(type, listener);
}

function reconnectOptions(
  value: CreateCodexWebSurfaceClientOptions['reconnect'],
): Required<CodexWebReconnectOptions> | null {
  if (!value) return null;
  const options = value === true ? {} : value;
  return {
    maxAttempts: nonNegativeInteger(options.maxAttempts, 8, 'Reconnect maximum attempts'),
    initialDelayMs: positiveWebSocketLimit(options.initialDelayMs, 250, 'Reconnect initial delay'),
    maximumDelayMs: positiveWebSocketLimit(options.maximumDelayMs, 5_000, 'Reconnect maximum delay'),
  };
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function shouldReconnect(close: CodexWebSocketClose): boolean {
  if (close.code === 1000) return false;
  return close.code === undefined || close.code < 4400 || close.code > 4499;
}

function requestId(sequence: number): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `codex-${sequence}-${random}`;
}

function webSocketArguments(args: readonly unknown[]): unknown[] {
  let length = args.length;
  while (length > 0 && args[length - 1] === undefined) length -= 1;
  return args.slice(0, length);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function isOptionalStateVersion(value: unknown): value is number | undefined {
  return value === undefined || Number.isSafeInteger(value);
}

function isStatePatch(value: unknown): value is CodexSurfaceStatePatch {
  return isPlainObject(value) && Number.isSafeInteger(value.version) && Array.isArray(value.changes);
}

function isRemoteError(value: unknown): value is CodexWebSocketErrorPayload {
  if (!isPlainObject(value) || typeof value.message !== 'string') return false;
  return value.code === 'invalid_request'
    || value.code === 'operation_failed'
    || value.code === 'request_timeout'
    || value.code === 'transport_closed';
}

function transportError(error: unknown): CodexWebSocketTransportError {
  return error instanceof CodexWebSocketTransportError
    ? error
    : new CodexWebSocketTransportError(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type {
  CodexWebSocketClose,
  CodexWebSocketPort,
} from './socket-port';
