import { describe, expect, it, vi } from 'vitest';
import {
  createCodexBrowserWebSocketPort,
  createCodexNodeWebSocketPort,
  type CodexNodeWebSocketLike,
  type BrowserWebSocketLike,
} from '../../src/web';
import {
  codexWebSocketText,
  defaultCodexWebSocketMaximumMessageBytes,
  positiveWebSocketLimit,
} from '../../src/web/socket-port';

describe('Codex WebSocket data helpers', () => {
  it('decodes strings, array buffers, and typed-array views', () => {
    const encoded = new TextEncoder().encode('hello');
    expect(codexWebSocketText('hello', 5)).toBe('hello');
    expect(codexWebSocketText(encoded.buffer, 5)).toBe('hello');
    expect(codexWebSocketText(encoded.subarray(1, 4), 5)).toBe('ell');
    expect(codexWebSocketText(new DataView(encoded.buffer, 1, 3), 5)).toBe('ell');
    expect(defaultCodexWebSocketMaximumMessageBytes).toBe(64 * 1024 * 1024);
  });

  it('rejects unsupported and oversized frames', () => {
    expect(() => codexWebSocketText({ text: 'no' }, 100)).toThrow(
      'Codex WebSocket messages must contain text or UTF-8 bytes',
    );
    expect(() => codexWebSocketText('éé', 3)).toThrow(
      'Codex WebSocket message exceeds the 3 byte limit',
    );
  });

  it('normalizes positive byte and timeout limits', () => {
    expect(positiveWebSocketLimit(undefined, 64, 'Limit')).toBe(64);
    expect(positiveWebSocketLimit(12, 64, 'Limit')).toBe(12);
    for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => positiveWebSocketLimit(value, 64, 'Limit')).toThrow('Limit must be a positive integer');
    }
  });
});

describe('browser WebSocket adapter', () => {
  it('forwards data, close metadata, errors, and listener cleanup', () => {
    const socket = new BrowserSocketStub();
    const port = createCodexBrowserWebSocketPort(socket as unknown as BrowserWebSocketLike);
    const message = vi.fn();
    const close = vi.fn();
    const error = vi.fn();
    const offMessage = port.onMessage(message);
    const offClose = port.onClose(close);
    const offError = port.onError!(error);

    port.send('outbound');
    port.close(1001, 'away');
    socket.emit('message', { data: 'inbound' });
    socket.emit('close', { code: 1001, reason: 'away', wasClean: true });
    socket.emit('error', { type: 'error' });

    expect(socket.send).toHaveBeenCalledWith('outbound');
    expect(socket.close).toHaveBeenCalledWith(1001, 'away');
    expect(message).toHaveBeenCalledWith('inbound');
    expect(close).toHaveBeenCalledWith({ code: 1001, reason: 'away', wasClean: true });
    expect(error).toHaveBeenCalledWith({ type: 'error' });

    offMessage();
    offClose();
    offError();
    expect(socket.listenerCount()).toBe(0);
  });
});

describe('Node WebSocket adapter', () => {
  it('forwards frames and decodes string and binary close reasons', () => {
    const socket = new NodeSocketStub();
    const port = createCodexNodeWebSocketPort(socket);
    const message = vi.fn();
    const close = vi.fn();
    const error = vi.fn();
    const unsubscribers = [port.onMessage(message), port.onClose(close), port.onError!(error)];

    port.send('outbound');
    port.close(1000, 'done');
    socket.emit('message', 'inbound');
    socket.emit('close', 1012, new TextEncoder().encode(' restart '));
    socket.emit('close', 'invalid-code', 'plain');
    socket.emit('close', 1000, new Uint8Array());
    socket.emit('close', 1000, { unknown: true });
    socket.emit('error', new Error('socket failed'));

    expect(socket.send).toHaveBeenCalledWith('outbound');
    expect(socket.close).toHaveBeenCalledWith(1000, 'done');
    expect(message).toHaveBeenCalledWith('inbound');
    expect(close).toHaveBeenNthCalledWith(1, { code: 1012, reason: 'restart' });
    expect(close).toHaveBeenNthCalledWith(2, { code: undefined, reason: 'plain' });
    expect(close).toHaveBeenNthCalledWith(3, { code: 1000, reason: undefined });
    expect(close).toHaveBeenNthCalledWith(4, { code: 1000, reason: undefined });
    expect(error).toHaveBeenCalledOnce();

    for (const unsubscribe of unsubscribers) unsubscribe();
    expect(socket.off).toHaveBeenCalledTimes(3);
  });

  it('falls back to removeListener when off is unavailable', () => {
    const socket = new NodeSocketStub();
    const removeListener = vi.fn();
    Object.defineProperty(socket, 'off', { value: undefined });
    Object.defineProperty(socket, 'removeListener', { value: removeListener });
    const port = createCodexNodeWebSocketPort(socket);

    port.onMessage(vi.fn())();
    expect(removeListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('allows cleanup when the socket has no listener-removal API', () => {
    const socket = new NodeSocketStub();
    Object.defineProperty(socket, 'off', { value: undefined });
    Object.defineProperty(socket, 'removeListener', { value: undefined });
    const port = createCodexNodeWebSocketPort(socket);

    expect(() => port.onMessage(vi.fn())()).not.toThrow();
  });
});

class BrowserSocketStub {
  readonly send = vi.fn();
  readonly close = vi.fn();
  readonly #listeners = new Map<string, Set<(event: never) => void>>();

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
  }

  listenerCount(): number {
    return [...this.#listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

class NodeSocketStub implements CodexNodeWebSocketLike {
  readonly send = vi.fn();
  readonly close = vi.fn();
  readonly off = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    const listeners = this.#listeners.get(event);
    const index = listeners?.indexOf(listener) ?? -1;
    if (index >= 0) listeners?.splice(index, 1);
  });
  readonly removeListener = vi.fn();
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: 'message' | 'close' | 'error', listener: (...args: never[]) => void): unknown {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener as (...args: unknown[]) => void);
    this.#listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }
}
