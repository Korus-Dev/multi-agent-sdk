import { describe, expect, it, vi } from 'vitest';
import { bindCodexWebSocket } from '../../src/web';
import {
  ManualSocket,
  deferred,
  fakeSurface,
  nextTask,
  snapshot,
} from './web-test-helpers';

describe('Codex web server initialization and release', () => {
  it('rejects invalid server byte limits with the server option label', () => {
    expect(() => bindCodexWebSocket({
      socket: new ManualSocket(),
      context: undefined,
      maxMessageBytes: 0,
      authorize: () => null,
    })).toThrow('Codex WebSocket message byte limit must be a positive integer');
  });

  it('supports sockets that do not expose an error listener', async () => {
    const socket = new ManualSocket();
    const port = {
      send: socket.send.bind(socket),
      close: socket.close.bind(socket),
      onMessage: socket.onMessage.bind(socket),
      onClose: socket.onClose.bind(socket),
    };
    const surface = fakeSurface();
    const binding = bindCodexWebSocket({
      socket: port,
      context: undefined,
      authorize: () => ({ surface: surface.target }),
    });

    await expect(binding.ready).resolves.toBeUndefined();
  });

  it('rejects authorization callback failures and closes the socket', async () => {
    const socket = new ManualSocket();
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: async () => { throw new Error('identity provider failed'); },
    });

    await expect(binding.ready).rejects.toThrow('identity provider failed');
    expect(socket.closes).toContainEqual({ code: 1011, reason: 'Codex web session initialization failed' });
  });

  it('releases a lease when surface initialization fails', async () => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const release = vi.fn();
    surface.connect.mockRejectedValueOnce(new Error('app-server unavailable'));
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: () => ({ surface: surface.target, release }),
    });

    await expect(binding.ready).rejects.toThrow('app-server unavailable');
    expect(release).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'surface_failed',
      error: expect.any(Error),
    }));
  });

  it('rejects requests received before authorization completes', async () => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const release = vi.fn();
    const authorization = deferred<{ surface: typeof surface.target; release: typeof release }>();
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: () => authorization.promise,
    });
    socket.emitMessage(validRequest());
    authorization.resolve({ surface: surface.target, release });

    await binding.ready;
    expect(socket.closes).toContainEqual({ code: 4400, reason: 'Request received before the session was ready' });
    expect(release).toHaveBeenCalledWith({ reason: 'socket_closed' });
    expect(surface.connect).not.toHaveBeenCalled();
  });

  it('reports authorization denial and does not add an initialization close after shutdown', async () => {
    const socket = new ManualSocket();
    const authorization = deferred<null>();
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: () => authorization.promise,
    });
    await binding.close(1000, 'shutdown');
    authorization.resolve(null);

    await expect(binding.ready).rejects.toThrow('Codex WebSocket authorization was denied');
    expect(socket.closes).toStrictEqual([
      { code: 1000, reason: 'shutdown' },
      { code: 4401, reason: 'Unauthorized' },
    ]);
  });

  it('ignores retained socket callbacks after server close', async () => {
    const socket = new ManualSocket(true);
    const surface = fakeSurface();
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: () => ({ surface: surface.target }),
    });
    await binding.ready;
    await binding.close(1000, 'shutdown');
    socket.emitMessage(validRequest());

    expect(socket.closes).toStrictEqual([{ code: 1000, reason: 'shutdown' }]);
    expect(surface.refreshAccount).not.toHaveBeenCalled();
  });

  it('does not require a release hook when authorization finishes after closure', async () => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const authorization = deferred<{ surface: typeof surface.target }>();
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: () => authorization.promise,
    });
    socket.emitMessage(validRequest());
    authorization.resolve({ surface: surface.target });

    await expect(binding.ready).resolves.toBeUndefined();
    expect(surface.connect).not.toHaveBeenCalled();
  });

  it('suppresses state and event notifications until surface connection completes', async () => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const connected = deferred<typeof snapshot>();
    surface.connect.mockReturnValueOnce(connected.promise);
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: () => ({ surface: surface.target }),
    });
    await nextTask();

    surface.emitState({ ...snapshot, busy: true });
    surface.emitEvent({
      seq: 2,
      occurredAt: '2026-08-07T10:00:00.000Z',
      origin: 'lifecycle',
      type: 'surface.statusChanged',
      payload: { status: 'ready', error: null },
    });
    expect(socket.sent).toStrictEqual([]);
    connected.resolve(snapshot);
    await binding.ready;
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'ready', snapshot });
  });

  it('supports explicit server close and releases once', async () => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const release = vi.fn();
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: () => ({ surface: surface.target, release }),
    });
    await binding.ready;

    await binding.close(1001, 'deploy');
    await binding.close(1000, 'duplicate');
    expect(socket.closes).toStrictEqual([{ code: 1001, reason: 'deploy' }]);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith({
      reason: 'server_closed',
      close: { code: 1001, reason: 'deploy', wasClean: true },
    });
    expect(surface.offState).toHaveBeenCalledOnce();
    expect(surface.offEvent).toHaveBeenCalledOnce();
    expect(socket.listenerCounts()).toStrictEqual({ close: 0, error: 0, message: 0 });
  });

  it('makes concurrent close calls wait for the same lease release', async () => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const released = deferred<void>();
    const release = vi.fn(() => released.promise);
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: () => ({ surface: surface.target, release }),
    });
    await binding.ready;

    const firstClose = binding.close(1001, 'deploy');
    const secondClose = binding.close(1000, 'duplicate');
    let secondFinished = false;
    void secondClose.then(() => { secondFinished = true; });
    await nextTask();
    expect(secondFinished).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    released.resolve();
    await Promise.all([firstClose, secondClose]);
    expect(secondFinished).toBe(true);
  });

  it('uses default server close metadata', async () => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: () => ({ surface: surface.target }),
    });
    await binding.ready;
    await binding.close();
    expect(socket.closes).toContainEqual({ code: 1000, reason: 'Codex web session closed' });
  });

  it('releases the lease after socket errors', async () => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const release = vi.fn();
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: () => ({ surface: surface.target, release }),
    });
    await binding.ready;
    socket.emitError('connection reset');
    await nextTask();
    expect(release).toHaveBeenCalledWith({ reason: 'socket_closed', error: 'connection reset' });
  });

  it('drops queued requests when the session closes', async () => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const firstResult = deferred<typeof snapshot>();
    surface.refreshAccount.mockReturnValueOnce(firstResult.promise);
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: () => ({ surface: surface.target }),
    });
    await binding.ready;
    socket.emitMessage(validRequest({ id: 'first' }));
    socket.emitMessage(validRequest({ id: 'second' }));
    await nextTask();
    expect(surface.refreshAccount).toHaveBeenCalledOnce();

    await binding.close();
    firstResult.resolve(snapshot);
    await nextTask();
    expect(surface.refreshAccount).toHaveBeenCalledOnce();
    expect(socket.sent.map((message) => JSON.parse(message) as { type: string }).filter(({ type }) => type === 'response'))
      .toStrictEqual([]);
  });
});

describe('Codex web server request validation', () => {
  it.each([
    ['null', 'non-object'],
    ['1', 'number'],
    [JSON.stringify('request'), 'string'],
    [JSON.stringify([]), 'array'],
    [JSON.stringify({ version: 1, type: 'request', id: 'id', operation: 'refreshAccount', args: [], extra: true }), 'extra key'],
    [JSON.stringify({ version: 2, type: 'request', id: 'id', operation: 'refreshAccount', args: [] }), 'version'],
    [JSON.stringify({ version: 1, type: 'other', id: 'id', operation: 'refreshAccount', args: [] }), 'type'],
    [JSON.stringify({ version: 1, type: 'request', id: '', operation: 'refreshAccount', args: [] }), 'blank id'],
    [JSON.stringify({ version: 1, type: 'request', id: '   ', operation: 'refreshAccount', args: [] }), 'whitespace id'],
    [JSON.stringify({ version: 1, type: 'request', id: 42, operation: 'refreshAccount', args: [] }), 'numeric id'],
    [JSON.stringify({ version: 1, type: 'request', id: 'x'.repeat(129), operation: 'refreshAccount', args: [] }), 'long id'],
    [JSON.stringify({ version: 1, type: 'request', id: 'id', operation: 'missing', args: [] }), 'operation'],
    [JSON.stringify({ version: 1, type: 'request', id: 'id', operation: 'refreshAccount', args: {} }), 'args'],
    [new Uint8Array(2_001), 'oversized binary'],
    [JSON.stringify({ version: 1, type: 'enableStatePatches' }), 'patches the session never offered'],
    [JSON.stringify({ version: 1, type: 'enableStatePatches', extra: true }), 'patch opt-in extra key'],
  ])('closes malformed requests: %s', async (frame, _label) => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      maxMessageBytes: 2_000,
      authorize: () => ({ surface: surface.target }),
    });
    await binding.ready;
    socket.emitMessage(frame);
    await nextTask();
    expect(socket.closes.at(-1)).toEqual({ code: 4400, reason: 'Invalid Codex WebSocket request' });
  });

  it('returns invalid_request for bridge validation failures', async () => {
    const { socket } = await readyBinding();
    socket.emitMessage(validRequest({ args: ['unexpected'] }));
    await nextTask();
    expect(lastServerMessage(socket)).toMatchObject({
      type: 'response',
      id: 'request-1',
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('releases malformed requests with the protocol close context', async () => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const release = vi.fn();
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: () => ({ surface: surface.target, release }),
    });
    await binding.ready;
    socket.emitMessage('not-json');
    await nextTask();

    expect(release).toHaveBeenCalledWith({
      reason: 'socket_closed',
      close: { code: 4400 },
    });
  });

  it('accepts and preserves a request id at the 128-character boundary', async () => {
    const { socket } = await readyBinding();
    const id = 'x'.repeat(128);
    socket.emitMessage(validRequest({ id }));
    await nextTask();
    expect(lastServerMessage(socket)).toMatchObject({ type: 'response', id, ok: true });
  });

  it('returns operation_failed and bounds host error messages', async () => {
    const surface = fakeSurface();
    surface.refreshAccount.mockRejectedValueOnce('x'.repeat(3_000));
    const { socket } = await readyBinding(surface);
    socket.emitMessage(validRequest());
    await nextTask();
    const response = lastServerMessage(socket) as { error: { code: string; message: string } };
    expect(response.error.code).toBe('operation_failed');
    expect(response.error.message).toHaveLength(2_000);
  });
});

describe('Codex web server response failures', () => {
  it('sends a response whose encoded size exactly matches the configured limit', async () => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const response = JSON.stringify({
      version: 1,
      type: 'response',
      id: 'request-1',
      ok: true,
      result: snapshot,
    });
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      maxMessageBytes: new TextEncoder().encode(response).byteLength,
      authorize: () => ({ surface: surface.target }),
    });
    await binding.ready;
    socket.emitMessage(validRequest());
    await nextTask();

    expect(socket.sent.at(-1)).toBe(response);
    expect(socket.closes).toStrictEqual([]);
  });

  it('closes and releases when a response exceeds the configured limit', async () => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const release = vi.fn();
    surface.refreshAccount.mockResolvedValueOnce('x'.repeat(4_000) as never);
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      maxMessageBytes: 2_000,
      authorize: () => ({ surface: surface.target, release }),
    });
    await binding.ready;
    socket.emitMessage(validRequest());
    await nextTask();
    expect(socket.closes.at(-1)).toEqual({ code: 1011, reason: 'Codex WebSocket response failed' });
    expect(release).toHaveBeenCalledWith({
      reason: 'socket_closed',
      error: expect.objectContaining({
        name: 'RangeError',
        message: 'Codex WebSocket response exceeds the configured byte limit',
      }),
    });
  });

  it('closes and releases when the socket send method throws', async () => {
    const socket = new ManualSocket();
    const surface = fakeSurface();
    const release = vi.fn();
    const binding = bindCodexWebSocket({
      socket,
      context: undefined,
      authorize: () => ({ surface: surface.target, release }),
    });
    await binding.ready;
    socket.sendError = new Error('write failed');
    socket.emitMessage(validRequest());
    await nextTask();
    expect(socket.closes.at(-1)).toEqual({ code: 1011, reason: 'Codex WebSocket response failed' });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'socket_closed',
      error: expect.any(Error),
    }));
  });

  it('does not emit state or event messages after closure', async () => {
    const surface = fakeSurface();
    const { binding, socket } = await readyBinding(surface);
    await binding.close();
    const sentCount = socket.sent.length;
    surface.emitState({ ...snapshot, busy: true });
    surface.emitEvent({
      seq: 2,
      occurredAt: '2026-08-07T10:00:00.000Z',
      origin: 'lifecycle',
      type: 'surface.statusChanged',
      payload: { status: 'ready', error: null },
    });
    expect(socket.sent).toHaveLength(sentCount);
    socket.emitMessage(validRequest());
    await nextTask();
    expect(surface.refreshAccount).not.toHaveBeenCalled();
  });
});

function validRequest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    type: 'request',
    id: 'request-1',
    operation: 'refreshAccount',
    args: [],
    ...overrides,
  });
}

function lastServerMessage(socket: ManualSocket): unknown {
  return JSON.parse(socket.sent.at(-1)!);
}

async function readyBinding(surface = fakeSurface()) {
  const socket = new ManualSocket();
  const binding = bindCodexWebSocket({
    socket,
    context: undefined,
    authorize: () => ({ surface: surface.target }),
  });
  await binding.ready;
  return { binding, socket, surface };
}
