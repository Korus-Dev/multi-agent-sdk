import { describe, expect, it } from 'vitest';
import type { CodexRealtimeInputAudioChunk } from 'multi-agents-sdk/surface';
import {
  normalizedOptionalRealtimeString,
  normalizedRealtimeText,
  realtimeAudioChunk,
  realtimeAudioChunkParams,
} from '../../src/providers/codex/codex-surface-realtime';

describe('Codex surface realtime codecs', () => {
  it('normalizes optional model and voice strings', () => {
    expect(normalizedOptionalRealtimeString(undefined, 'model')).toBeUndefined();
    expect(normalizedOptionalRealtimeString('  gpt-realtime  ', 'model')).toBe('gpt-realtime');
    expect(() => normalizedOptionalRealtimeString('   ', 'voice')).toThrow('Realtime voice cannot be empty');
    expect(() => normalizedOptionalRealtimeString(4 as unknown as string, 'model'))
      .toThrow('Realtime model must be a string');
  });

  it('normalizes required realtime text', () => {
    expect(normalizedRealtimeText('  hello  ', 'text')).toBe('hello');
    expect(() => normalizedRealtimeText('', 'speech')).toThrow('Realtime speech cannot be empty');
    expect(() => normalizedRealtimeText(null as unknown as string, 'text'))
      .toThrow('Realtime text must be a string');
  });

  it('encodes sliced PCM bytes and derives samples per channel', () => {
    const backing = new Uint8Array([99, 1, 2, 3, 4, 88]);
    const data = backing.subarray(1, 5);
    expect(realtimeAudioChunkParams({
      data,
      sampleRate: 24_000,
      numChannels: 2,
      itemId: ' item-1 ',
    })).toStrictEqual({
      data: 'AQIDBA==',
      sampleRate: 24_000,
      numChannels: 2,
      samplesPerChannel: 1,
      itemId: ' item-1 ',
    });

    expect(realtimeAudioChunkParams({
      data: new Uint8Array([1, 2]),
      sampleRate: 16_000,
      numChannels: 1,
      samplesPerChannel: null,
      itemId: null,
    }).samplesPerChannel).toBeNull();
    expect(realtimeAudioChunkParams({
      data: new Uint8Array([1, 2]),
      sampleRate: 16_000,
      numChannels: 1,
      samplesPerChannel: 7,
    })).toMatchObject({ samplesPerChannel: 7, itemId: null });
    expect(realtimeAudioChunkParams({
      data: new Uint8Array(),
      sampleRate: 16_000,
      numChannels: 1,
      samplesPerChannel: 0,
    })).toMatchObject({ samplesPerChannel: 0, itemId: null });
  });

  it.each([
    [{ data: 'not-bytes', sampleRate: 24_000, numChannels: 1 }, 'data must be a Uint8Array'],
    [{ data: new Uint8Array(), sampleRate: 0, numChannels: 1 }, 'sampleRate must be a positive integer'],
    [{ data: new Uint8Array(), sampleRate: -1, numChannels: 1 }, 'sampleRate must be a positive integer'],
    [{ data: new Uint8Array(), sampleRate: 1.5, numChannels: 1 }, 'sampleRate must be a positive integer'],
    [{ data: new Uint8Array(), sampleRate: Number.MAX_VALUE, numChannels: 1 }, 'sampleRate must be a positive integer'],
    [{ data: new Uint8Array(), sampleRate: 24_000, numChannels: 0 }, 'numChannels must be a positive integer'],
    [{ data: new Uint8Array(), sampleRate: 24_000, numChannels: 1, samplesPerChannel: -1 }, 'samplesPerChannel must be a non-negative integer or null'],
    [{ data: new Uint8Array(), sampleRate: 24_000, numChannels: 1, samplesPerChannel: 1.5 }, 'samplesPerChannel must be a non-negative integer or null'],
    [{ data: new Uint8Array(), sampleRate: 24_000, numChannels: 1, itemId: '' }, 'itemId must be a non-empty string or null'],
    [{ data: new Uint8Array(), sampleRate: 24_000, numChannels: 1, itemId: '  ' }, 'itemId must be a non-empty string or null'],
    [{ data: new Uint8Array(), sampleRate: 24_000, numChannels: 1, itemId: 4 }, 'itemId must be a non-empty string or null'],
  ])('rejects invalid audio input %#', (value, message) => {
    expect(() => realtimeAudioChunkParams(value as unknown as CodexRealtimeInputAudioChunk)).toThrow(message);
  });

  it('decodes server audio chunks', () => {
    expect(realtimeAudioChunk({
      data: 'AQIDBA==',
      sampleRate: 24_000,
      numChannels: 2,
      samplesPerChannel: 1,
      itemId: 'item-1',
    })).toStrictEqual({
      data: new Uint8Array([1, 2, 3, 4]),
      sampleRate: 24_000,
      numChannels: 2,
      samplesPerChannel: 1,
      itemId: 'item-1',
    });
  });
});
