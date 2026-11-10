import {
  invokeCodexSurfaceBridgeOperation,
  isCodexSurfaceBridgeOperation,
  type CodexSurfaceBridgeAttachmentResolver,
  type CodexSurfaceBridgeTarget,
} from '../core/surface-bridge';
import type { CodexSurfaceStatePatch } from '../core/surface';
import {
  isCodexSurfaceStatePatchSource,
  type CodexSurfaceStatePatchSource,
} from '../core/surface-bridge';
import {
  codexWebSocketProtocolVersion,
  encodeCodexWebSocketMessage,
  type CodexWebSocketFailure,
  type CodexWebSocketRequest,
  type CodexWebSocketServerMessage,
  type CodexWebSocketStatePatch,
} from './protocol';
import {
  codexWebSocketText,
  defaultCodexWebSocketMaximumMessageBytes,
  positiveWebSocketLimit,
  type CodexWebSocketClose,
  type CodexWebSocketPort,
} from './socket-port';

type Awaitable<Value> = Value | Promise<Value>;

export type CodexWebSocketSessionRelease = {
  reason: 'authorization_failed' | 'server_closed' | 'socket_closed' | 'surface_failed';
  close?: CodexWebSocketClose;
  error?: unknown;
};

/** A host-authorized, connection-scoped lease. The host owns its lifecycle and isolation policy. */
export type CodexWebSocketSessionLease = {
  /** A `CodexSurface` can stream state patches to clients that opt in; other targets send snapshots. */
  surface: CodexSurfaceBridgeTarget & Partial<CodexSurfaceStatePatchSource>;
  resolveAttachment?: CodexSurfaceBridgeAttachmentResolver;
  release?(context: CodexWebSocketSessionRelease): Awaitable<void>;
};

export type BindCodexWebSocketOptions<Context> = {
  socket: CodexWebSocketPort;
  context: Context;
  authorize(context: Context): Awaitable<CodexWebSocketSessionLease | null>;
  maxMessageBytes?: number;
};

export type CodexWebSocketBinding = {
  /** Resolves after authorization and the initial surface snapshot have been sent. */
  ready: Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
};

/** The small EventEmitter-style subset implemented by the popular `ws` package. */
export type CodexNodeWebSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
};

/** The header subset of a Node `IncomingMessage` (or equivalent) needed to check a WebSocket upgrade. */
export type CodexWebSocketUpgradeRequest = {
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
};

/**
 * Returns true only when a WebSocket upgrade carries exactly one `Origin`
 * header matching one of `allowedOrigins`. Browsers do not apply the
 * same-origin policy to WebSockets, so a host that skips this check lets any
 * website the user visits drive its Codex surface. Requests without an
 * `Origin` header are rejected.
 */
export function isAllowedCodexWebSocketOrigin(
  request: CodexWebSocketUpgradeRequest,
  allowedOrigins: readonly string[],
): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return false;
  const requestOrigin = normalizedOrigin(origin);
  if (!requestOrigin) return false;
  return allowedOrigins.some((allowedOrigin) => {
    const allowed = normalizedOrigin(allowedOrigin);
    if (!allowed) throw new TypeError(`Invalid allowed Codex WebSocket origin: ${allowedOrigin}`);
    return allowed === requestOrigin;
  });
}

/**
 * Binds an established socket to a required host authorization callback.
 * HTTP upgrades, cookies, user lookup, runner pooling, and Express integration stay host-owned.
 */
export function bindCodexWebSocket<Context>(
  options: BindCodexWebSocketOptions<Context>,
): CodexWebSocketBinding {
  return new ServerBinding(options);
}

/** Adapts a `ws`-style socket without importing or depending on that library. */
export function createCodexNodeWebSocketPort(socket: CodexNodeWebSocketLike): CodexWebSocketPort {
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (listener) => nodeSocketListener(socket, 'message', listener),
    onClose: (listener) => nodeSocketListener(socket, 'close', (code: unknown, reason: unknown) => listener({
      code: typeof code === 'number' ? code : undefined,
      reason: socketReason(reason),
    })),
    onError: (listener) => nodeSocketListener(socket, 'error', listener),
  };
}

class ServerBinding<Context> implements CodexWebSocketBinding {
  readonly ready: Promise<void>;
  readonly #socket: CodexWebSocketPort;
  readonly #context: Context;
  readonly #authorize: BindCodexWebSocketOptions<Context>['authorize'];
  readonly #maxMessageBytes: number;
  readonly #unsubscribers: Array<() => void> = [];
  #lease: CodexWebSocketSessionLease | null = null;
  #requestQueue = Promise.resolve();
  #acceptingRequests = false;
  #finished = false;
  #releasePromise: Promise<void> | null = null;
  // State stays on full snapshots unless the surface can stream patches and
  // the client opts in after a `ready` that advertised `stateVersion`.
  #patchSource: CodexSurfaceStatePatchSource | null = null;
  #readyStateVersion: number | null = null;
  #patchMode: 'off' | 'starting' | 'on' = 'off';
  readonly #pendingPatches: CodexSurfaceStatePatch[] = [];

  constructor(options: BindCodexWebSocketOptions<Context>) {
    this.#socket = options.socket;
    this.#context = options.context;
    this.#authorize = options.authorize;
    this.#maxMessageBytes = positiveWebSocketLimit(
      options.maxMessageBytes,
      defaultCodexWebSocketMaximumMessageBytes,
      'Codex WebSocket message byte limit',
    );
    this.#unsubscribers.push(
      this.#socket.onMessage((data) => this.#receive(data)),
      this.#socket.onClose((close) => { void this.#finish({ reason: 'socket_closed', close }); }),
    );
    if (this.#socket.onError) {
      this.#unsubscribers.push(this.#socket.onError((error) => {
        void this.#finish({ reason: 'socket_closed', error });
      }));
    }
    this.ready = this.#initialize();
  }

  async close(code = 1000, reason = 'Codex web session closed'): Promise<void> {
    if (!this.#finished) this.#socket.close(code, reason);
    await this.#finish({ reason: 'server_closed', close: { code, reason, wasClean: true } });
  }

  async #initialize(): Promise<void> {
    try {
      const lease = await this.#authorize(this.#context);
      if (!lease) {
        this.#socket.close(4401, 'Unauthorized');
        await this.#finish({ reason: 'authorization_failed' });
        throw new Error('Codex WebSocket authorization was denied');
      }
      if (this.#finished) {
        await lease.release?.({ reason: 'socket_closed' });
        return;
      }
      this.#lease = lease;
      const patchSource = isCodexSurfaceStatePatchSource(lease.surface) ? lease.surface : null;
      this.#unsubscribers.push(
        lease.surface.onStateChange((snapshot) => {
          if (this.#acceptingRequests && this.#patchMode === 'off') this.#send({
            version: codexWebSocketProtocolVersion,
            type: 'snapshot',
            snapshot,
          });
        }),
        lease.surface.onEvent((event) => {
          if (this.#acceptingRequests) this.#send({
            version: codexWebSocketProtocolVersion,
            type: 'event',
            event,
          });
        }),
      );
      if (patchSource) {
        this.#unsubscribers.push(patchSource.onStatePatch((patch) => {
          if (this.#patchMode === 'on') this.#send(statePatchMessage(patch));
          else if (this.#patchMode === 'starting') this.#pendingPatches.push(patch);
        }));
      }
      const snapshot = await lease.surface.connect();
      const state = patchSource ? await patchSource.getVersionedSnapshot() : null;
      if (this.#finished) return;
      this.#patchSource = state ? patchSource : null;
      this.#readyStateVersion = state?.version ?? null;
      this.#send({
        version: codexWebSocketProtocolVersion,
        type: 'ready',
        ...(state ? { snapshot: state.snapshot, stateVersion: state.version } : { snapshot }),
      });
      this.#acceptingRequests = true;
    } catch (error) {
      if (!this.#finished) {
        this.#socket.close(1011, 'Codex web session initialization failed');
        await this.#finish({ reason: 'surface_failed', error });
      }
      throw error;
    }
  }

  #receive(data: unknown): void {
    if (this.#finished) return;
    if (!this.#acceptingRequests) {
      this.#socket.close(4400, 'Request received before the session was ready');
      void this.#finish({ reason: 'socket_closed', close: { code: 4400 } });
      return;
    }
    let request: CodexWebSocketRequest | 'enableStatePatches';
    try {
      request = parseClientMessage(codexWebSocketText(data, this.#maxMessageBytes));
      if (request === 'enableStatePatches' && (!this.#patchSource || this.#patchMode !== 'off')) {
        throw new TypeError('State patches cannot be enabled for this session');
      }
    } catch {
      this.#socket.close(4400, 'Invalid Codex WebSocket request');
      void this.#finish({ reason: 'socket_closed', close: { code: 4400 } });
      return;
    }
    if (request === 'enableStatePatches') {
      void this.#enableStatePatches();
      return;
    }
    this.#requestQueue = this.#requestQueue.then(() => this.#handle(request));
  }

  async #enableStatePatches(): Promise<void> {
    const patchSource = this.#patchSource!;
    this.#patchMode = 'starting';
    let state;
    try {
      state = await patchSource.getVersionedSnapshot();
    } catch {
      state = null;
    }
    if (this.#finished) return;
    if (!state) {
      // Without a base the client cannot apply patches; a reconnect starts over.
      this.#socket.close(1011, 'Codex state stream unavailable');
      void this.#finish({ reason: 'surface_failed' });
      return;
    }
    // Snapshots sent before the switch moved the client past `ready`; give it a new base.
    if (state.version !== this.#readyStateVersion) this.#send({
      version: codexWebSocketProtocolVersion,
      type: 'snapshot',
      snapshot: state.snapshot,
      stateVersion: state.version,
    });
    this.#patchMode = 'on';
    for (const patch of this.#pendingPatches.splice(0)) {
      if (patch.version > state.version) this.#send(statePatchMessage(patch));
    }
  }

  async #handle(request: CodexWebSocketRequest): Promise<void> {
    const lease = this.#lease;
    if (!lease || this.#finished) return;
    try {
      const result = await invokeCodexSurfaceBridgeOperation(
        lease.surface,
        request.operation,
        request.args,
        lease.resolveAttachment ? { resolveAttachment: lease.resolveAttachment } : {},
      );
      this.#send({
        version: codexWebSocketProtocolVersion,
        type: 'response',
        id: request.id,
        ok: true,
        result,
      });
    } catch (error) {
      this.#send(failure(
        request.id,
        error instanceof TypeError || error instanceof RangeError ? 'invalid_request' : 'operation_failed',
        errorMessage(error),
      ));
    }
  }

  #send(message: CodexWebSocketServerMessage | CodexWebSocketStatePatch): void {
    if (this.#finished) return;
    try {
      const encoded = encodeCodexWebSocketMessage(message);
      if (new TextEncoder().encode(encoded).byteLength > this.#maxMessageBytes) {
        throw new RangeError('Codex WebSocket response exceeds the configured byte limit');
      }
      this.#socket.send(encoded);
    } catch (error) {
      this.#socket.close(1011, 'Codex WebSocket response failed');
      void this.#finish({ reason: 'socket_closed', error });
    }
  }

  #finish(context: CodexWebSocketSessionRelease): Promise<void> {
    if (this.#releasePromise) return this.#releasePromise;
    this.#finished = true;
    this.#acceptingRequests = false;
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    const lease = this.#lease;
    this.#lease = null;
    this.#releasePromise = Promise.resolve(lease?.release?.(context)).then(() => undefined);
    return this.#releasePromise;
  }
}

function statePatchMessage(patch: CodexSurfaceStatePatch): CodexWebSocketStatePatch {
  return { version: codexWebSocketProtocolVersion, type: 'statePatch', patch };
}

function parseClientMessage(text: string): CodexWebSocketRequest | 'enableStatePatches' {
  const value = JSON.parse(text) as unknown;
  if (!isPlainObject(value)) throw new TypeError('Codex WebSocket request must be an object');
  if (value.type === 'enableStatePatches') {
    onlyKeys(value, ['version', 'type']);
    if (value.version !== codexWebSocketProtocolVersion) throw new TypeError('Codex WebSocket version is invalid');
    return 'enableStatePatches';
  }
  onlyKeys(value, ['version', 'type', 'id', 'operation', 'args']);
  if (value.version !== codexWebSocketProtocolVersion || value.type !== 'request') {
    throw new TypeError('Codex WebSocket request version or type is invalid');
  }
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 128) {
    throw new TypeError('Codex WebSocket request id is invalid');
  }
  if (!isCodexSurfaceBridgeOperation(value.operation)) {
    throw new TypeError('Codex WebSocket operation is invalid');
  }
  if (!Array.isArray(value.args)) throw new TypeError('Codex WebSocket request args must be an array');
  return {
    version: codexWebSocketProtocolVersion,
    type: 'request',
    id: value.id,
    operation: value.operation,
    args: value.args,
  };
}

function failure(
  id: string,
  code: CodexWebSocketFailure['error']['code'],
  message: string,
): CodexWebSocketFailure {
  return {
    version: codexWebSocketProtocolVersion,
    type: 'response',
    id,
    ok: false,
    error: { code, message: message.slice(0, 2_000) },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function onlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  if (Reflect.ownKeys(record).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('Codex WebSocket request contains unsupported properties');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nodeSocketListener(
  socket: CodexNodeWebSocketLike,
  event: 'message' | 'close' | 'error',
  listener: (first: unknown, second?: unknown) => void,
): () => void {
  if (event === 'message') socket.on(event, listener as (data: unknown) => void);
  if (event === 'close') socket.on(event, listener as (code: number, reason: unknown) => void);
  if (event === 'error') socket.on(event, listener as (error: unknown) => void);
  return () => {
    const removable = socket as CodexNodeWebSocketLike & {
      off?(name: string, callback: (first: unknown, second?: unknown) => void): unknown;
      removeListener?(name: string, callback: (first: unknown, second?: unknown) => void): unknown;
    };
    if (removable.off) removable.off(event, listener);
    else removable.removeListener?.(event, listener);
  };
}

function normalizedOrigin(value: string): string | null {
  try {
    const { origin } = new URL(value.trim());
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

function socketReason(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const reason = new TextDecoder().decode(value).trim();
    return reason || undefined;
  }
  return undefined;
}

export type {
  CodexWebSocketClose,
  CodexWebSocketPort,
} from './socket-port';
