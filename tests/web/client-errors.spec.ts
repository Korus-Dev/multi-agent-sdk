import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexSurfaceSnapshot } from 'multi-agents-sdk/surface';
import {
  CodexWebSocketTransportError,
  createCodexWebSurfaceClient,
} from '../../src/web';
import {
  ManualSocket,
  deferred,
  nextTask,
  readyMessage,
  requestId,
  snapshot,
} from './web-test-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Codex web client validation', () => {
  it.each([
    [{ maxMessageBytes: 0 }, 'Codex WebSocket message byte limit must be a positive integer'],
    [{ requestTimeoutMs: -1 }, 'Codex WebSocket request timeout must be a positive integer'],
    [{ reconnect: { maxAttempts: -1 } }, 'Reconnect maximum attempts must be a non-negative integer'],
    [{ reconnect: { maxAttempts: 1.5 } }, 'Reconnect maximum attempts must be a non-negative integer'],
    [{ reconnect: { initialDelayMs: 0 } }, 'Reconnect initial delay must be a positive integer'],
    [{ reconnect: { maximumDelayMs: Number.POSITIVE_INFINITY } }, 'Reconnect maximum delay must be a positive integer'],
  ] as const)('rejects invalid client options', (invalid, message) => {
    expect(() => createCodexWebSurfaceClient({
      createSocket: () => new ManualSocket(),
      ...invalid,
    })).toThrow(message);
  });

  it.each([
    ['not-json', 10_000],
    [JSON.stringify([]), 10_000],
    [JSON.stringify(42), 10_000],
    [JSON.stringify('ready'), 10_000],
    [JSON.stringify({ version: 2, type: 'ready', snapshot }), 10_000],
    [JSON.stringify({ version: 1, type: 'ready', snapshot: null }), 10_000],
    [JSON.stringify({ version: 1, type: 'snapshot', event: {} }), 10_000],
    [JSON.stringify({ version: 1, type: 'event', snapshot }), 10_000],
    [JSON.stringify({ version: 1, type: 'response', id: 42, ok: true }), 10_000],
    [JSON.stringify({ version: 1, type: 'response', id: 'id', ok: 'yes' }), 10_000],
    [new Uint8Array(20), 10],
  ])('rejects malformed server frames', async (frame, maxMessageBytes) => {
    const socket = new ManualSocket();
    const client = createCodexWebSurfaceClient({
      createSocket: () => socket,
      maxMessageBytes,
    });
    const connecting = client.connect();
    await nextTask();
    socket.emitMessage(frame);

    await expect(connecting).rejects.toBeInstanceOf(CodexWebSocketTransportError);
    expect(socket.closes.at(-1)).toStrictEqual({ code: 4400, reason: 'Invalid Codex WebSocket response' });
    expect(client.getConnectionState()).toBe('disconnected');
  });

  it('reports socket creation failures as transport errors', async () => {
    const client = createCodexWebSurfaceClient({
      createSocket: async () => { throw 'offline'; },
    });

    await expect(client.connect()).rejects.toMatchObject({
      name: 'CodexWebSocketTransportError',
      message: 'offline',
    });
    expect(client.getConnectionState()).toBe('disconnected');
  });

  it('reports structural protocol failures to the pending connection', async () => {
    const socket = new ManualSocket();
    const client = createCodexWebSurfaceClient({ createSocket: () => socket });
    const connecting = client.connect();
    await nextTask();
    socket.emitMessage(JSON.stringify({ version: 2, type: 'ready', snapshot }));

    await expect(connecting).rejects.toMatchObject({
      name: 'CodexWebSocketTransportError',
      message: 'Invalid Codex WebSocket response',
    });
  });
});

describe('Codex web client responses and lifecycle', () => {
  it('starts disconnected and reports connecting while the socket factory is pending', async () => {
    const socketResult = deferred<ManualSocket>();
    const client = createCodexWebSurfaceClient({ createSocket: () => socketResult.promise });
    expect(client.getConnectionState()).toBe('disconnected');
    const connecting = client.connect();
    expect(client.getConnectionState()).toBe('connecting');
    const socket = new ManualSocket();
    socketResult.resolve(socket);
    await nextTask();
    socket.emitMessage(readyMessage());
    await connecting;
  });

  it('returns the cached snapshot and supports listener removal', async () => {
    const socket = new ManualSocket();
    const client = createCodexWebSurfaceClient({ createSocket: () => socket });
    const stateListener = vi.fn();
    const eventListener = vi.fn();
    const offState = client.onStateChange(stateListener);
    const offEvent = client.onEvent(eventListener);
    const firstConnect = client.connect();
    const duplicateConnect = client.connect();
    expect(duplicateConnect).toBe(firstConnect);
    await nextTask();
    socket.emitMessage(readyMessage());
    await expect(firstConnect).resolves.toStrictEqual(snapshot);
    await expect(client.connect()).resolves.toStrictEqual(snapshot);

    offState();
    offEvent();
    socket.emitMessage(JSON.stringify({ version: 1, type: 'snapshot', snapshot: { ...snapshot, busy: true } }));
    socket.emitMessage(JSON.stringify({ version: 1, type: 'event', event: { type: 'test' } }));
    expect(stateListener).toHaveBeenCalledOnce();
    expect(eventListener).not.toHaveBeenCalled();

    socket.emitMessage(readyMessage({ ...snapshot, busy: true }));
    expect(client.getConnectionState()).toBe('ready');
  });

  it('resolves successes and exposes valid remote failures', async () => {
    const { client, socket } = await connectedClient();
    const success = client.refreshAccount();
    await nextTask();
    socket.emitMessage(JSON.stringify({
      version: 1, type: 'response', id: requestId(socket), ok: true, result: { ...snapshot, busy: true },
    }));
    await expect(success).resolves.toEqual({ ...snapshot, busy: true });

    const failure = client.refreshAccount();
    await nextTask();
    socket.emitMessage(JSON.stringify({
      version: 1,
      type: 'response',
      id: requestId(socket),
      ok: false,
      error: { code: 'operation_failed', message: 'surface exploded' },
    }));
    await expect(failure).rejects.toMatchObject({
      name: 'CodexWebSocketRemoteError',
      code: 'operation_failed',
      message: 'surface exploded',
    });
  });

  it.each(['invalid_request', 'operation_failed', 'request_timeout', 'transport_closed'] as const)(
    'preserves the %s remote error code',
    async (code) => {
      const { client, socket } = await connectedClient();
      const result = client.refreshAccount();
      await nextTask();
      socket.emitMessage(JSON.stringify({
        version: 1,
        type: 'response',
        id: requestId(socket),
        ok: false,
        error: { code, message: `${code} message` },
      }));
      await expect(result).rejects.toMatchObject({ code, message: `${code} message` });
    },
  );

  it('rejects invalid remote errors and ignores unknown response ids', async () => {
    const { client, socket } = await connectedClient();
    socket.emitMessage(JSON.stringify({ version: 1, type: 'response', id: 'missing', ok: true, result: snapshot }));
    const result = client.refreshAccount();
    await nextTask();
    socket.emitMessage(JSON.stringify({
      version: 1, type: 'response', id: requestId(socket), ok: false, error: { code: 'unknown', message: 'bad' },
    }));
    await expect(result).rejects.toThrow('Codex WebSocket returned an invalid error');
  });

  it.each([
    null,
    [],
    { code: 'operation_failed' },
    { code: 'operation_failed', message: 42 },
    { code: 'unknown', message: 'bad' },
  ])('rejects malformed remote error payloads', async (error) => {
    const { client, socket } = await connectedClient();
    const result = client.refreshAccount();
    await nextTask();
    socket.emitMessage(JSON.stringify({
      version: 1, type: 'response', id: requestId(socket), ok: false, error,
    }));
    await expect(result).rejects.toMatchObject({
      name: 'CodexWebSocketTransportError',
      message: 'Codex WebSocket returned an invalid error',
    });
  });

  it('closes an otherwise valid but unknown server message', async () => {
    const { client, socket } = await connectedClient();
    socket.emitMessage(JSON.stringify({ version: 1, type: 'unknown' }));
    expect(socket.closes.at(-1)).toEqual({ code: 4400, reason: 'Invalid Codex WebSocket response' });
    expect(client.getConnectionState()).toBe('disconnected');
  });

  it('rejects pending work when response-shaped data has the wrong message type', async () => {
    const { client, socket } = await connectedClient();
    const result = client.refreshAccount();
    await nextTask();
    socket.emitMessage(JSON.stringify({
      version: 1,
      type: 'unknown',
      id: requestId(socket),
      ok: true,
    }));

    await expect(result).rejects.toThrow('Invalid Codex WebSocket response');
    expect(socket.closes.at(-1)).toEqual({ code: 4400, reason: 'Invalid Codex WebSocket response' });
  });

  it('rejects requests when sending fails', async () => {
    const { client, socket } = await connectedClient();
    socket.sendError = new Error('write failed');
    await expect(client.refreshAccount()).rejects.toMatchObject({
      name: 'CodexWebSocketTransportError',
      message: 'write failed',
    });
  });

  it('times out unanswered requests', async () => {
    vi.useFakeTimers();
    const socket = new ManualSocket();
    const client = createCodexWebSurfaceClient({ createSocket: () => socket, requestTimeoutMs: 10 });
    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    socket.emitMessage(readyMessage());
    await connecting;
    const result = client.refreshAccount();
    const timedOut = expect(result).rejects.toMatchObject({
      name: 'CodexWebSocketRemoteError',
      code: 'request_timeout',
      message: "Codex WebSocket request 'refreshAccount' timed out",
    });
    await vi.advanceTimersByTimeAsync(11);
    await timedOut;
  });

  it('rejects an operation if its newly ready socket closes before the request is sent', async () => {
    const socket = new ManualSocket();
    const client = createCodexWebSurfaceClient({ createSocket: () => socket });
    const result = client.refreshAccount();
    await nextTask();
    socket.emitMessage(readyMessage());
    socket.emitClose({ code: 1000, reason: 'closed at ready' });
    await expect(result).rejects.toThrow('Codex WebSocket is not connected');
  });

  it('trims trailing undefined arguments from requests', async () => {
    const { client, socket } = await connectedClient();
    const result = client.steerMessage('continue', undefined);
    await nextTask();
    const request = JSON.parse(socket.sent.at(-1)!) as { args: unknown[]; id: string };
    expect(request.args).toStrictEqual(['continue']);
    socket.emitMessage(JSON.stringify({ version: 1, type: 'response', id: request.id, ok: true, result: snapshot }));
    await result;
  });

  it('rejects pending work with close codes when no reason is supplied', async () => {
    const { client, socket } = await connectedClient();
    const result = client.refreshAccount();
    await nextTask();
    socket.emitClose({ code: 1012 });
    await expect(result).rejects.toThrow('Codex WebSocket closed (1012)');
    expect(client.getConnectionState()).toBe('disconnected');
  });

  it.each([
    [{ code: 1012, reason: '   ' }, 'Codex WebSocket closed (1012)'],
    [{}, 'Codex WebSocket closed'],
  ])('normalizes empty close metadata', async (close, message) => {
    const { client, socket } = await connectedClient();
    const result = client.refreshAccount();
    await nextTask();
    socket.emitClose(close);

    await expect(result).rejects.toMatchObject({
      name: 'CodexWebSocketTransportError',
      message,
    });
  });

  it('rejects pending work with manual disconnect and socket-error reasons', async () => {
    const first = await connectedClient();
    const manuallyClosed = first.client.refreshAccount();
    await nextTask();
    first.client.disconnect(4001, 'manual shutdown');
    await expect(manuallyClosed).rejects.toThrow('manual shutdown');
    expect(first.client.getConnectionState()).toBe('closed');

    const second = await connectedClient();
    const errored = second.client.refreshAccount();
    await nextTask();
    second.socket.emitError('network lost');
    await expect(errored).rejects.toThrow('network lost');
    expect(second.client.getConnectionState()).toBe('disconnected');
  });

  it('generates monotonically increasing request ids', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'fixed-random' });
    const { client, socket } = await connectedClient();
    const first = client.refreshAccount();
    const second = client.refreshAccount();
    await nextTask();
    const firstRequest = JSON.parse(socket.sent.at(-2)!) as { id: string };
    const secondRequest = JSON.parse(socket.sent.at(-1)!) as { id: string };
    expect(firstRequest.id).toBe('codex-1-fixed-random');
    expect(secondRequest.id).toBe('codex-2-fixed-random');
    socket.emitMessage(JSON.stringify({ version: 1, type: 'response', id: firstRequest.id, ok: true, result: snapshot }));
    socket.emitMessage(JSON.stringify({ version: 1, type: 'response', id: secondRequest.id, ok: true, result: snapshot }));
    await Promise.all([first, second]);
  });

  it.each([undefined, {}])('falls back to Math.random when crypto UUIDs are unavailable', async (crypto) => {
    vi.stubGlobal('crypto', crypto);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { client, socket } = await connectedClient();
    const result = client.refreshAccount();
    await nextTask();
    const request = JSON.parse(socket.sent.at(-1)!) as { id: string };
    expect(request.id).toBe('codex-1-i');
    socket.emitMessage(JSON.stringify({ version: 1, type: 'response', id: request.id, ok: true, result: snapshot }));
    await result;
  });

  it('closes a socket that arrives after manual disconnection', async () => {
    const socketResult = deferred<ManualSocket>();
    const client = createCodexWebSurfaceClient({ createSocket: () => socketResult.promise });
    const connecting = client.connect();
    client.disconnect(1000, 'closed early');
    const socket = new ManualSocket();
    socketResult.resolve(socket);

    await expect(connecting).rejects.toThrow('Codex web client is closed');
    expect(socket.closes).toContainEqual({ code: 1000, reason: 'Codex web client is closed' });
    expect(client.getConnectionState()).toBe('closed');
  });

  it('rejects a pending ready handshake on manual disconnect', async () => {
    const socket = new ManualSocket();
    const client = createCodexWebSurfaceClient({ createSocket: () => socket });
    const connecting = client.connect();
    await nextTask();
    client.disconnect(4001, 'cancel handshake');

    await expect(connecting).rejects.toThrow('cancel handshake');
    expect(client.getConnectionState()).toBe('closed');
  });

  it('uses the default disconnect metadata', async () => {
    const { client, socket } = await connectedClient();
    expect(socket.listenerCounts()).toStrictEqual({ close: 1, error: 1, message: 1 });
    client.disconnect();
    expect(socket.closes).toContainEqual({ code: 1000, reason: 'Codex web client disconnected' });
    expect(client.getConnectionState()).toBe('closed');
    expect(socket.listenerCounts()).toStrictEqual({ close: 0, error: 0, message: 0 });
  });

  it('connects through a socket that does not expose an error listener', async () => {
    const socket = new ManualSocket();
    const port = {
      send: socket.send.bind(socket),
      close: socket.close.bind(socket),
      onMessage: socket.onMessage.bind(socket),
      onClose: socket.onClose.bind(socket),
    };
    const client = createCodexWebSurfaceClient({ createSocket: () => port });
    const connecting = client.connect();
    await nextTask();
    socket.emitMessage(readyMessage());
    await expect(connecting).resolves.toStrictEqual(snapshot);
  });
});

describe('Codex web client reconnect policy', () => {
  it('opts into advertised patches and reconnects for a fresh base when one is skipped', async () => {
    vi.useFakeTimers();
    const first = new ManualSocket();
    const second = new ManualSocket();
    const createSocket = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const client = createCodexWebSurfaceClient({
      createSocket,
      reconnect: { initialDelayMs: 1, maximumDelayMs: 1, maxAttempts: 1 },
    });
    const states: CodexSurfaceSnapshot[] = [];
    client.onStateChange((value) => states.push(value));
    const initial = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    first.emitMessage(JSON.stringify({ version: 1, type: 'ready', snapshot, stateVersion: 3 }));
    await initial;
    expect(first.sent.map((data) => JSON.parse(data))).toStrictEqual([{ version: 1, type: 'enableStatePatches' }]);

    first.emitMessage(JSON.stringify({
      version: 1, type: 'statePatch', patch: { version: 5, changes: [{ type: 'set', key: 'busy', value: true }] },
    }));
    await vi.advanceTimersByTimeAsync(1);
    second.emitMessage(JSON.stringify({ version: 1, type: 'ready', snapshot: { ...snapshot, busy: true } }));

    expect(first.closes).toStrictEqual([{ code: 4001, reason: 'Codex state stream desynchronized' }]);
    expect(second.sent).toStrictEqual([]);
    expect(states.map((value) => value.busy)).toStrictEqual([false, true]);
    expect(client.getConnectionState()).toBe('ready');
  });

  it('does not retry a reconnect whose socket closes cleanly before ready', async () => {
    vi.useFakeTimers();
    const first = new ManualSocket();
    const second = new ManualSocket();
    const third = new ManualSocket();
    const createSocket = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(third);
    const client = createCodexWebSurfaceClient({
      createSocket,
      reconnect: { initialDelayMs: 1, maximumDelayMs: 1, maxAttempts: 2 },
    });
    const initial = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    first.emitMessage(readyMessage());
    await initial;
    first.emitClose({ code: 1012, reason: 'restart' });
    await vi.advanceTimersByTimeAsync(1);
    expect(createSocket).toHaveBeenCalledTimes(2);
    second.emitClose({ code: 1000, reason: 'clean close' });
    await vi.advanceTimersByTimeAsync(10);

    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(client.getConnectionState()).toBe('disconnected');
  });

  it('allows zero reconnect attempts', async () => {
    vi.useFakeTimers();
    const socket = new ManualSocket();
    const createSocket = vi.fn(() => socket);
    const client = createCodexWebSurfaceClient({
      createSocket,
      reconnect: { initialDelayMs: 1, maximumDelayMs: 1, maxAttempts: 0 },
    });
    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    socket.emitMessage(readyMessage());
    await connecting;
    socket.emitClose({ code: 1012 });
    await vi.advanceTimersByTimeAsync(10);
    expect(createSocket).toHaveBeenCalledOnce();
  });

  it('recovers from socket factory failures with default reconnect options', async () => {
    vi.useFakeTimers();
    const socket = new ManualSocket();
    const createSocket = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(socket);
    const client = createCodexWebSurfaceClient({ createSocket, reconnect: true });
    await expect(client.connect()).rejects.toThrow('offline');

    await vi.advanceTimersByTimeAsync(250);
    socket.emitMessage(readyMessage());
    await vi.waitFor(() => expect(client.getConnectionState()).toBe('ready'));
    expect(createSocket).toHaveBeenCalledTimes(2);
  });

  it.each([1000, 4401])('does not reconnect after close code %s', async (code) => {
    vi.useFakeTimers();
    const socket = new ManualSocket();
    const createSocket = vi.fn(() => socket);
    const client = createCodexWebSurfaceClient({
      createSocket,
      reconnect: { initialDelayMs: 1, maximumDelayMs: 1, maxAttempts: 2 },
    });
    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    socket.emitMessage(readyMessage());
    await connecting;
    socket.emitClose({ code });
    await vi.advanceTimersByTimeAsync(10);
    expect(createSocket).toHaveBeenCalledOnce();
  });

  it.each([4400, 4499])('does not reconnect at reserved close boundary %s', async (code) => {
    vi.useFakeTimers();
    const socket = new ManualSocket();
    const createSocket = vi.fn(() => socket);
    const client = createCodexWebSurfaceClient({
      createSocket,
      reconnect: { initialDelayMs: 1, maximumDelayMs: 1, maxAttempts: 1 },
    });
    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    socket.emitMessage(readyMessage());
    await connecting;
    socket.emitClose({ code });
    await vi.advanceTimersByTimeAsync(2);
    expect(createSocket).toHaveBeenCalledOnce();
  });

  it.each([undefined, 4399, 4500] as const)('reconnects after retryable close code %s', async (code) => {
    vi.useFakeTimers();
    const first = new ManualSocket();
    const second = new ManualSocket();
    const createSocket = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const client = createCodexWebSurfaceClient({
      createSocket,
      reconnect: { initialDelayMs: 1, maximumDelayMs: 1, maxAttempts: 1 },
    });
    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    first.emitMessage(readyMessage());
    await connecting;
    first.emitClose({ code });
    await vi.advanceTimersByTimeAsync(1);
    second.emitMessage(readyMessage({ ...snapshot, busy: true }));
    await vi.waitFor(() => expect(client.getConnectionState()).toBe('ready'));
    expect(createSocket).toHaveBeenCalledTimes(2);
  });

  it('cancels a scheduled reconnect on manual disconnect', async () => {
    vi.useFakeTimers();
    const socket = new ManualSocket();
    const createSocket = vi.fn(() => socket);
    const client = createCodexWebSurfaceClient({
      createSocket,
      reconnect: { initialDelayMs: 10, maximumDelayMs: 10, maxAttempts: 1 },
    });
    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    socket.emitMessage(readyMessage());
    await connecting;
    socket.emitClose({ code: 1012, reason: 'restart' });
    client.disconnect();
    await vi.advanceTimersByTimeAsync(20);
    expect(createSocket).toHaveBeenCalledOnce();
    expect(client.getConnectionState()).toBe('closed');
  });

  it('replaces a scheduled reconnect with an immediate explicit connection', async () => {
    vi.useFakeTimers();
    const first = new ManualSocket();
    const second = new ManualSocket();
    const createSocket = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const client = createCodexWebSurfaceClient({
      createSocket,
      reconnect: { initialDelayMs: 10, maximumDelayMs: 10, maxAttempts: 2 },
    });
    const initial = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    first.emitMessage(readyMessage());
    await initial;
    first.emitClose({ code: 1012 });

    const explicit = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    second.emitMessage(readyMessage({ ...snapshot, busy: true }));
    await explicit;
    await vi.advanceTimersByTimeAsync(20);
    expect(createSocket).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a cached snapshot after disconnection', async () => {
    const first = new ManualSocket();
    const second = new ManualSocket();
    const createSocket = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const client = createCodexWebSurfaceClient({ createSocket });
    const initial = client.connect();
    await nextTask();
    first.emitMessage(readyMessage());
    await initial;
    first.emitClose({ code: 1000 });

    const reconnected = client.connect();
    await nextTask();
    expect(createSocket).toHaveBeenCalledTimes(2);
    second.emitMessage(readyMessage({ ...snapshot, busy: true }));
    await expect(reconnected).resolves.toEqual({ ...snapshot, busy: true });
  });

  it('ignores messages and close events retained by a stale socket', async () => {
    vi.useFakeTimers();
    const first = new ManualSocket(true);
    const second = new ManualSocket();
    const createSocket = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const client = createCodexWebSurfaceClient({
      createSocket,
      reconnect: { initialDelayMs: 1, maximumDelayMs: 1, maxAttempts: 1 },
    });
    const initial = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    first.emitMessage(readyMessage());
    await initial;
    first.emitClose({ code: 1012 });
    await vi.advanceTimersByTimeAsync(1);
    second.emitMessage(readyMessage({ ...snapshot, busy: true }));
    await vi.waitFor(() => expect(client.getConnectionState()).toBe('ready'));

    first.emitMessage(readyMessage({ ...snapshot, busy: false }));
    first.emitClose({ code: 1000, reason: 'stale close' });
    expect(client.getConnectionState()).toBe('ready');
    await expect(client.connect()).resolves.toEqual({ ...snapshot, busy: true });
  });

  it('uses exponential reconnect delays capped by the configured maximum', async () => {
    vi.useFakeTimers();
    const first = new ManualSocket();
    const createSocket = vi.fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValue(new Error('offline'));
    const client = createCodexWebSurfaceClient({
      createSocket,
      reconnect: { initialDelayMs: 2, maximumDelayMs: 4, maxAttempts: 3 },
    });
    const initial = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    first.emitMessage(readyMessage());
    await initial;
    first.emitClose({ code: 1012 });

    await vi.advanceTimersByTimeAsync(2);
    expect(createSocket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3);
    expect(createSocket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(createSocket).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4);
    expect(createSocket).toHaveBeenCalledTimes(4);
  });

  it('reconnects after a socket error and stops at the configured attempt limit', async () => {
    vi.useFakeTimers();
    const first = new ManualSocket();
    const createSocket = vi.fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValue(new Error('still offline'));
    const client = createCodexWebSurfaceClient({
      createSocket,
      reconnect: { initialDelayMs: 1, maximumDelayMs: 2, maxAttempts: 2 },
    });
    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    first.emitMessage(readyMessage());
    await connecting;
    first.emitError('network lost');
    await vi.advanceTimersByTimeAsync(20);
    expect(createSocket).toHaveBeenCalledTimes(3);
    expect(client.getConnectionState()).toBe('disconnected');
  });
});

async function connectedClient() {
  const socket = new ManualSocket();
  const client = createCodexWebSurfaceClient({ createSocket: () => socket });
  const connecting = client.connect();
  await nextTask();
  socket.emitMessage(readyMessage());
  await connecting;
  return { client, socket };
}
