export type CodexWebSocketClose = {
  code?: number;
  reason?: string;
  wasClean?: boolean;
};

/** Minimal socket seam implemented by browser WebSocket, `ws`, or another host adapter. */
export type CodexWebSocketPort = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: unknown) => void): () => void;
  onClose(listener: (event: CodexWebSocketClose) => void): () => void;
  onError?(listener: (error: unknown) => void): () => void;
};

export const defaultCodexWebSocketMaximumMessageBytes = 64 * 1024 * 1024;

export function codexWebSocketText(data: unknown, maximumBytes: number): string {
  let value: string;
  if (typeof data === 'string') {
    value = data;
  } else if (data instanceof ArrayBuffer) {
    value = new TextDecoder().decode(data);
  } else if (ArrayBuffer.isView(data)) {
    value = new TextDecoder().decode(data);
  } else {
    throw new TypeError('Codex WebSocket messages must contain text or UTF-8 bytes');
  }
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new RangeError(`Codex WebSocket message exceeds the ${maximumBytes} byte limit`);
  }
  return value;
}

export function positiveWebSocketLimit(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}
