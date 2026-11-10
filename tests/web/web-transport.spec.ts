import { describe, expect, it, vi } from 'vitest';
import type {
  CodexSurfaceEvent,
  CodexSurfaceSnapshot,
  CodexSurfaceStatePatch,
} from '../../src/index';
import type { CodexSurfaceBridgeTarget } from '../../src/core/surface-bridge';
import {
  bindCodexWebSocket,
  createCodexWebSurfaceClient,
  type CodexWebSocketClose,
  type CodexWebSocketPort,
} from '../../src/web';

const snapshot: CodexSurfaceSnapshot = {
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

const event: CodexSurfaceEvent = {
  seq: 1,
  occurredAt: '2026-08-07T10:00:00.000Z',
  origin: 'lifecycle',
  type: 'surface.statusChanged',
  payload: { status: 'ready', error: null },
};

describe('Codex web transport', () => {
  it('authorizes a host session and exposes the complete renderer surface', async () => {
    const [browserSocket, serverSocket] = memorySocketPair();
    const surface = fakeSurface();
    const release = vi.fn();
    const resolveAttachment = vi.fn(async ({ reference }: { reference: string }) => ({
      type: 'file' as const,
      path: `/sessions/user-1/${reference}.md`,
      name: 'notes.md',
      mimeType: 'text/markdown',
    }));
    const authorize = vi.fn(async (_context: { userId: string }) => ({
      surface: surface.target,
      resolveAttachment,
      release,
    }));
    const binding = bindCodexWebSocket({
      socket: serverSocket,
      context: { userId: 'user-1' },
      authorize,
    });
    const client = createCodexWebSurfaceClient({ createSocket: () => browserSocket });
    const states: CodexSurfaceSnapshot[] = [];
    const events: CodexSurfaceEvent[] = [];
    client.onStateChange((value) => states.push(value));
    client.onEvent((value) => events.push(value));

    await expect(client.connect()).resolves.toStrictEqual(snapshot);
    await binding.ready;
    expect(authorize).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(surface.connect).toHaveBeenCalledTimes(1);

    await expect(client.sendMessage('Read this', {
      attachments: [{ type: 'file', reference: 'attachment-1' }],
      serviceTier: 'fast',
    })).resolves.toStrictEqual(snapshot);
    expect(resolveAttachment).toHaveBeenCalledWith({
      type: 'file', reference: 'attachment-1',
    });
    expect(surface.sendMessage).toHaveBeenCalledWith('Read this', {
      attachments: [{
        type: 'file',
        path: '/sessions/user-1/attachment-1.md',
        name: 'notes.md',
        mimeType: 'text/markdown',
      }],
      serviceTier: 'fast',
    });

    await expect(client.createConversation(undefined)).resolves.toStrictEqual(snapshot);
    expect(surface.createConversation).toHaveBeenCalledWith(undefined);

    await expect(client.startChatGptDeviceCodeLogin()).resolves.toStrictEqual({
      loginId: 'device-login-1',
      verificationUrl: 'https://auth.example.test/device',
      userCode: 'ABCD-EFGH',
    });
    expect(surface.startChatGptDeviceCodeLogin).toHaveBeenCalledWith();

    surface.emitState({ ...snapshot, busy: true });
    surface.emitEvent(event);
    await nextTask();
    expect(states).toEqual([snapshot, { ...snapshot, busy: true }]);
    expect(events).toEqual([event]);

    client.disconnect();
    await nextTask();
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ reason: 'socket_closed' }));
  });

  it('negotiates state patches that skip history and survive an update racing the switch', async () => {
    const [browserSocket, serverSocket] = memorySocketPair();
    const surface = patchingSurface({ raceOnSwitch: 'Hel' });
    const frames = recordFrames(serverSocket);
    const binding = bindCodexWebSocket({ socket: serverSocket, context: undefined, authorize: () => ({ surface: surface.target }) });
    const client = createCodexWebSurfaceClient({ createSocket: () => browserSocket });
    const states: CodexSurfaceSnapshot[] = [];
    client.onStateChange((value) => states.push(value));

    await client.connect();
    await binding.ready;
    await nextTask();
    surface.stream('Hello');
    await nextTask();

    expect(states.map((value) => value.messages.at(-1)?.parts)).toStrictEqual([
      surface.history.at(-1)!.parts,
      [{ type: 'text', text: 'Hel' }],
      [{ type: 'text', text: 'Hello' }],
    ]);
    expect(states[2]!.messages[0]).toBe(states[0]!.messages[0]);
    expect(frames.map((frame) => frame.type)).toStrictEqual(['ready', 'statePatch', 'statePatch']);
    expect(frames.slice(1).every((frame) => frame.size < 2_000)).toBe(true);
    expect(frames[0]!.size).toBeGreaterThan(100_000);
    client.disconnect();
  });

  it('keeps sending snapshots to clients that never opt into patches', async () => {
    const [browserSocket, serverSocket] = memorySocketPair();
    const surface = patchingSurface();
    const frames = recordFrames(serverSocket);
    const binding = bindCodexWebSocket({ socket: serverSocket, context: undefined, authorize: () => ({ surface: surface.target }) });
    browserSocket.onMessage(() => undefined);

    await binding.ready;
    surface.stream('Hel');
    await nextTask();

    expect(frames.map((frame) => frame.type)).toStrictEqual(['ready', 'snapshot']);
    browserSocket.close(1000);
  });

  it('accepts snapshots beyond the former 16 MiB ceiling by default', async () => {
    const [browserSocket, serverSocket] = memorySocketPair();
    const largeSnapshot = {
      ...snapshot,
      error: 'x'.repeat(16 * 1024 * 1024),
    };
    const surface = fakeSurface(largeSnapshot);
    const binding = bindCodexWebSocket({
      socket: serverSocket,
      context: undefined,
      authorize: () => ({ surface: surface.target }),
    });
    const client = createCodexWebSurfaceClient({ createSocket: () => browserSocket });

    const connected = await client.connect();
    await binding.ready;
    expect(connected.error).toHaveLength(16 * 1024 * 1024);
    expect(client.getConnectionState()).toBe('ready');
    client.disconnect();
  });

  it('rejects unauthorized upgrades before exposing a surface', async () => {
    const [browserSocket, serverSocket] = memorySocketPair();
    const authorize = vi.fn(async () => null);
    const binding = bindCodexWebSocket({ socket: serverSocket, context: { userId: 'missing' }, authorize });
    const serverReady = binding.ready.catch((error: unknown) => error);
    const client = createCodexWebSurfaceClient({ createSocket: () => browserSocket });

    await expect(client.connect()).rejects.toThrow('Unauthorized');
    expect(await serverReady).toBeInstanceOf(Error);
    expect(authorize).toHaveBeenCalledOnce();
    expect(browserSocket.lastClose).toEqual(expect.objectContaining({ code: 4401 }));
  });

  it('serializes operations and correlates their responses', async () => {
    const [browserSocket, serverSocket] = memorySocketPair();
    const surface = fakeSurface();
    const first = deferred<CodexSurfaceSnapshot>();
    surface.archiveConversation.mockImplementationOnce(() => first.promise);
    const binding = bindCodexWebSocket({
      socket: serverSocket,
      context: undefined,
      authorize: () => ({ surface: surface.target }),
    });
    const client = createCodexWebSurfaceClient({ createSocket: () => browserSocket });
    await client.connect();
    await binding.ready;

    const archive = client.archiveConversation('thread-1');
    const refresh = client.refreshAccount();
    await nextTask();
    expect(surface.archiveConversation).toHaveBeenCalledWith('thread-1');
    expect(surface.refreshAccount).not.toHaveBeenCalled();

    first.resolve({ ...snapshot, activeConversationId: 'thread-1' });
    await expect(archive).resolves.toEqual({ ...snapshot, activeConversationId: 'thread-1' });
    await expect(refresh).resolves.toStrictEqual(snapshot);
    expect(surface.refreshAccount).toHaveBeenCalledOnce();
  });

  it('routes interrupted-turn continuation through the web bridge', async () => {
    const [browserSocket, serverSocket] = memorySocketPair();
    const surface = fakeSurface();
    const binding = bindCodexWebSocket({
      socket: serverSocket,
      context: undefined,
      authorize: () => ({ surface: surface.target }),
    });
    const client = createCodexWebSurfaceClient({ createSocket: () => browserSocket });
    await client.connect();
    await binding.ready;

    await expect(client.continueInterruptedTurn()).resolves.toStrictEqual(snapshot);

    expect(surface.continueInterruptedTurn).toHaveBeenCalledOnce();
  });

  it('keeps concurrently authorized user sessions isolated', async () => {
    const sessionOne = memorySocketPair();
    const sessionTwo = memorySocketPair();
    const userOne = fakeSurface();
    const userTwo = fakeSurface();
    const surfaces = new Map([
      ['user-1', userOne.target],
      ['user-2', userTwo.target],
    ]);
    const bind = (pair: [MemorySocket, MemorySocket], userId: string) => bindCodexWebSocket({
      socket: pair[1],
      context: { userId },
      authorize: ({ userId: authorizedUser }) => ({ surface: surfaces.get(authorizedUser)! }),
    });
    const bindingOne = bind(sessionOne, 'user-1');
    const bindingTwo = bind(sessionTwo, 'user-2');
    const clientOne = createCodexWebSurfaceClient({ createSocket: () => sessionOne[0] });
    const clientTwo = createCodexWebSurfaceClient({ createSocket: () => sessionTwo[0] });

    await Promise.all([clientOne.connect(), clientTwo.connect(), bindingOne.ready, bindingTwo.ready]);
    await Promise.all([clientOne.sendMessage('one'), clientTwo.sendMessage('two')]);
    expect(userOne.sendMessage).toHaveBeenCalledWith('one', undefined);
    expect(userOne.sendMessage).not.toHaveBeenCalledWith('two', undefined);
    expect(userTwo.sendMessage).toHaveBeenCalledWith('two', undefined);
    expect(userTwo.sendMessage).not.toHaveBeenCalledWith('one', undefined);
  });

  it('reconnects with a fresh authorized lease without replaying interrupted operations', async () => {
    const sessions: Array<{ browser: MemorySocket; server: MemorySocket; surface: ReturnType<typeof fakeSurface> }> = [];
    const createSocket = () => {
      const [browser, server] = memorySocketPair();
      const surface = fakeSurface({ ...snapshot, busy: sessions.length > 0 });
      sessions.push({ browser, server, surface });
      bindCodexWebSocket({
        socket: server,
        context: { connection: sessions.length },
        authorize: () => ({ surface: surface.target }),
      });
      return browser;
    };
    const client = createCodexWebSurfaceClient({
      createSocket,
      reconnect: { initialDelayMs: 1, maximumDelayMs: 2, maxAttempts: 2 },
    });
    const states: CodexSurfaceSnapshot[] = [];
    client.onStateChange((value) => states.push(value));
    await client.connect();

    const interrupted = deferred<CodexSurfaceSnapshot>();
    sessions[0]!.surface.archiveConversation.mockImplementationOnce(() => interrupted.promise);
    const operation = client.archiveConversation('thread-1');
    await nextTask();
    sessions[0]!.server.close(1012, 'Service restart');

    await expect(operation).rejects.toThrow('Service restart');
    await vi.waitFor(() => {
      expect(sessions).toHaveLength(2);
      expect(client.getConnectionState()).toBe('ready');
    });
    expect(states.at(-1)).toEqual({ ...snapshot, busy: true });
    expect(sessions[1]!.surface.archiveConversation).not.toHaveBeenCalled();
  });

  it('closes malformed requests without invoking the surface', async () => {
    const [browserSocket, serverSocket] = memorySocketPair();
    const surface = fakeSurface();
    const binding = bindCodexWebSocket({
      socket: serverSocket,
      context: undefined,
      authorize: () => ({ surface: surface.target }),
    });
    await binding.ready;

    browserSocket.send(JSON.stringify({ version: 1, type: 'request', operation: 'refreshAccount', args: [] }));
    await nextTask();
    expect(browserSocket.lastClose).toEqual(expect.objectContaining({ code: 4400 }));
    expect(surface.refreshAccount).not.toHaveBeenCalled();
  });
});

function fakeSurface(initialSnapshot: CodexSurfaceSnapshot = snapshot) {
  let stateListener: ((value: CodexSurfaceSnapshot) => void) | undefined;
  let eventListener: ((value: CodexSurfaceEvent) => void) | undefined;
  const connect = vi.fn(async () => initialSnapshot);
  const sendMessage = vi.fn(async () => initialSnapshot);
  const archiveConversation = vi.fn(async () => initialSnapshot);
  const continueInterruptedTurn = vi.fn(async () => initialSnapshot);
  const refreshAccount = vi.fn(async () => initialSnapshot);
  const createConversation = vi.fn(async () => initialSnapshot);
  const startChatGptDeviceCodeLogin = vi.fn(async () => ({
    loginId: 'device-login-1',
    verificationUrl: 'https://auth.example.test/device',
    userCode: 'ABCD-EFGH',
  }));
  const partial = {
    connect,
    continueInterruptedTurn,
    createConversation,
    getSnapshot: vi.fn(() => initialSnapshot),
    sendMessage,
    archiveConversation,
    refreshAccount,
    startChatGptDeviceCodeLogin,
    onStateChange: vi.fn((listener: (value: CodexSurfaceSnapshot) => void) => {
      stateListener = listener;
      return () => { stateListener = undefined; };
    }),
    onEvent: vi.fn((listener: (value: CodexSurfaceEvent) => void) => {
      eventListener = listener;
      return () => { eventListener = undefined; };
    }),
  };
  return {
    target: partial as unknown as CodexSurfaceBridgeTarget,
    connect,
    continueInterruptedTurn,
    sendMessage,
    archiveConversation,
    createConversation,
    refreshAccount,
    startChatGptDeviceCodeLogin,
    emitState: (value: CodexSurfaceSnapshot) => stateListener?.(value),
    emitEvent: (value: CodexSurfaceEvent) => eventListener?.(value),
  };
}

/** A surface that, like `CodexSurface`, reports every change as both a snapshot and a structural patch. */
function patchingSurface(options: { raceOnSwitch?: string } = {}) {
  const history = Array.from({ length: 200 }, (_, index) => ({
    id: `m${index}`,
    role: 'assistant' as const,
    status: 'complete' as const,
    parts: [{ type: 'text' as const, text: `Answer ${index} `.repeat(40) }],
  }));
  let state: CodexSurfaceSnapshot = { ...snapshot, messages: history };
  let version = 0;
  let baseRequests = 0;
  const patchListeners = new Set<(patch: CodexSurfaceStatePatch) => void>();
  const base = fakeSurface(state);
  const stream = (text: string) => {
    const live = { id: 'live', role: 'assistant' as const, status: 'streaming' as const, parts: [{ type: 'text' as const, text }] };
    state = { ...state, messages: [...history, live] };
    version += 1;
    for (const listener of patchListeners) listener({
      version,
      changes: [{ type: 'list', key: 'messages', ids: state.messages.map((message) => message.id), items: [live] }],
    });
    base.emitState(state);
  };
  const target = {
    ...base.target,
    connect: async () => state,
    getVersionedSnapshot: async () => {
      const current = { version, snapshot: state };
      // The second request is the switch to patches; an update lands while it is in flight.
      if (++baseRequests === 2 && options.raceOnSwitch) queueMicrotask(() => stream(options.raceOnSwitch!));
      return current;
    },
    onStatePatch: (listener: (patch: CodexSurfaceStatePatch) => void) => {
      patchListeners.add(listener);
      return () => patchListeners.delete(listener);
    },
  };
  return { target: target as CodexSurfaceBridgeTarget, history, stream };
}

function recordFrames(socket: MemorySocket): Array<{ type: string; size: number }> {
  const frames: Array<{ type: string; size: number }> = [];
  const send = socket.send.bind(socket);
  socket.send = (data) => {
    frames.push({ type: (JSON.parse(data) as { type: string }).type, size: data.length });
    send(data);
  };
  return frames;
}

class MemorySocket implements CodexWebSocketPort {
  peer: MemorySocket | null = null;
  lastClose: CodexWebSocketClose | null = null;
  readonly #messages = new Set<(data: unknown) => void>();
  readonly #closes = new Set<(close: CodexWebSocketClose) => void>();
  readonly #errors = new Set<(error: unknown) => void>();

  send(data: string): void {
    const peer = this.peer;
    if (!peer) throw new Error('Socket is closed');
    queueMicrotask(() => peer.#emitMessage(data));
  }

  close(code?: number, reason?: string): void {
    const peer = this.peer;
    if (!peer) return;
    this.peer = null;
    peer.peer = null;
    const close = { code, reason, wasClean: code === undefined || code === 1000 };
    queueMicrotask(() => {
      this.#emitClose(close);
      peer.#emitClose(close);
    });
  }

  onMessage(listener: (data: unknown) => void): () => void {
    this.#messages.add(listener);
    return () => this.#messages.delete(listener);
  }

  onClose(listener: (close: CodexWebSocketClose) => void): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.#errors.add(listener);
    return () => this.#errors.delete(listener);
  }

  #emitMessage(data: unknown): void {
    for (const listener of this.#messages) listener(data);
  }

  #emitClose(close: CodexWebSocketClose): void {
    this.lastClose = close;
    for (const listener of this.#closes) listener(close);
  }
}

function memorySocketPair(): [MemorySocket, MemorySocket] {
  const first = new MemorySocket();
  const second = new MemorySocket();
  first.peer = second;
  second.peer = first;
  return [first, second];
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => { resolve = next; });
  return { promise, resolve };
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
