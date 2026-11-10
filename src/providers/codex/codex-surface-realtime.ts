import type { v2 } from 'codex-sdk';
import type { CodexRealtimeInputAudioChunk } from 'multi-agents-sdk/surface';

export function normalizedOptionalRealtimeString(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`Realtime ${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`Realtime ${field} cannot be empty`);
  return normalized;
}

export function normalizedRealtimeText(value: string, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`Realtime ${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`Realtime ${field} cannot be empty`);
  return normalized;
}

export function realtimeAudioChunkParams(audio: CodexRealtimeInputAudioChunk): v2.ThreadRealtimeAudioChunk {
  if (!(audio.data instanceof Uint8Array)) {
    throw new TypeError('Realtime audio data must be a Uint8Array');
  }
  const sampleRate = positiveInteger(audio.sampleRate, 'sampleRate');
  const numChannels = positiveInteger(audio.numChannels, 'numChannels');
  const samplesPerChannel = audio.samplesPerChannel === undefined
    ? Math.floor(audio.data.byteLength / 2 / numChannels)
    : nullableNonNegativeInteger(audio.samplesPerChannel, 'samplesPerChannel');
  const itemId = audio.itemId === undefined ? null : audio.itemId;
  if (itemId !== null && (typeof itemId !== 'string' || !itemId.trim())) {
    throw new TypeError('Realtime audio itemId must be a non-empty string or null');
  }
  return {
    data: Buffer.from(audio.data.buffer, audio.data.byteOffset, audio.data.byteLength).toString('base64'),
    sampleRate,
    numChannels,
    samplesPerChannel,
    itemId,
  };
}

export function realtimeAudioChunk(audio: v2.ThreadRealtimeAudioChunk): {
  data: Uint8Array;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel: number | null;
  itemId: string | null;
} {
  return {
    data: new Uint8Array(Buffer.from(audio.data, 'base64')),
    sampleRate: audio.sampleRate,
    numChannels: audio.numChannels,
    samplesPerChannel: audio.samplesPerChannel,
    itemId: audio.itemId,
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Realtime audio ${field} must be a positive integer`);
  }
  return value;
}

function nullableNonNegativeInteger(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Realtime audio ${field} must be a non-negative integer or null`);
  }
  return value;
}
