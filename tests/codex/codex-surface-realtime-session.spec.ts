import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexConversationEvent, StartCodexRealtimeOptions } from 'multi-agents-sdk/surface';
import { startCodexRealtimeSession } from '../../src/providers/codex/codex-surface-realtime-session';

describe('startCodexRealtimeSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the thread and validates output modality before starting', async () => {
    const setup = realtime({ outputModality: 'invalid' as never });

    await expect(startCodexRealtimeSession(setup.context))
      .rejects.toThrow("Invalid realtime output modality 'invalid'");

    expect(setup.ensureThreadReady).toHaveBeenCalledOnce();
    expect(setup.request).not.toHaveBeenCalled();
  });

  it.each(['invalid', null, 2])('rejects invalid realtime version %#', async (version) => {
    const setup = realtime({ outputModality: 'text', version: version as never });

    await expect(startCodexRealtimeSession(setup.context))
      .rejects.toThrow(`Invalid realtime version '${String(version)}'`);
    expect(setup.request).not.toHaveBeenCalled();
  });

  it('sends the exact normalized websocket start options including false and empty values', async () => {
    const setup = realtime({
      outputModality: 'audio',
      version: 'v2',
      model: '  gpt-realtime  ',
      voice: '  alloy  ',
      includeStartupContext: false,
      prompt: '',
      flushTranscriptTailOnSessionEnd: false,
      transport: { type: 'websocket' },
    });

    const session = await startCodexRealtimeSession(setup.context);

    expect(setup.request).toHaveBeenCalledExactlyOnceWith('thread/realtime/start', {
      threadId: 'thread-1', outputModality: 'audio', version: 'v2',
      model: 'gpt-realtime', voice: 'alloy', includeStartupContext: false,
      prompt: '', flushTranscriptTailOnSessionEnd: false,
      transport: { type: 'websocket' },
    });
    expect(session).toMatchObject({
      conversationId: 'thread-1', transport: 'websocket', remoteSdp: null,
    });
  });

  it('uses the minimal websocket payload by default', async () => {
    const setup = realtime({ outputModality: 'text' });

    await startCodexRealtimeSession(setup.context);

    expect(setup.request).toHaveBeenCalledExactlyOnceWith('thread/realtime/start', {
      threadId: 'thread-1', outputModality: 'text', transport: { type: 'websocket' },
    });
    const params = setup.request.mock.calls[0]?.[1];
    expect(params).not.toHaveProperty('includeStartupContext');
    expect(params).not.toHaveProperty('prompt');
    expect(params).not.toHaveProperty('flushTranscriptTailOnSessionEnd');
  });

  it('preserves websocket start failures when no SDP negotiation exists to cancel', async () => {
    const setup = realtime({ outputModality: 'text' });
    setup.request.mockRejectedValueOnce(new Error('websocket start failed'));

    await expect(startCodexRealtimeSession(setup.context)).rejects.toThrow('websocket start failed');
    expect(setup.listenerCount()).toBe(0);
  });

  it.each([
    [{ outputModality: 'text', model: '   ' }, 'Realtime model cannot be empty'],
    [{ outputModality: 'text', voice: 4 }, 'Realtime voice must be a string'],
    [{ outputModality: 'text', transport: { type: 'future' } }, "Invalid realtime transport 'future'"],
    [{ outputModality: 'text', transport: { type: 'webrtc', sdp: '   ' } }, 'requires a non-empty SDP offer'],
  ])('rejects invalid start options %#', async (options, message) => {
    const setup = realtime(options as StartCodexRealtimeOptions);

    await expect(startCodexRealtimeSession(setup.context)).rejects.toThrow(message);
    expect(setup.request).not.toHaveBeenCalled();
  });

  it('negotiates WebRTC and returns the exact remote SDP answer', async () => {
    vi.useFakeTimers();
    const setup = realtime({
      outputModality: 'audio', version: 'v1',
      transport: { type: 'webrtc', sdp: ' offer-sdp ' },
    });

    const starting = startCodexRealtimeSession(setup.context);
    await vi.waitFor(() => expect(setup.listenerCount()).toBe(1));
    expect(vi.getTimerCount()).toBe(1);
    setup.emit({
      type: 'realtime.sdp', conversationId: 'thread-1',
      payload: { sdp: 'answer-sdp' },
    } as never);

    await expect(starting).resolves.toMatchObject({
      conversationId: 'thread-1', transport: 'webrtc', remoteSdp: 'answer-sdp',
    });
    expect(setup.request).toHaveBeenCalledExactlyOnceWith('thread/realtime/start', {
      threadId: 'thread-1', outputModality: 'audio', version: 'v1',
      transport: { type: 'webrtc', sdp: ' offer-sdp ' },
    });
    expect(setup.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores unrelated events while waiting for the WebRTC answer', async () => {
    vi.useFakeTimers();
    const setup = realtime({
      outputModality: 'audio', transport: { type: 'webrtc', sdp: 'offer' },
    });
    const starting = startCodexRealtimeSession(setup.context);
    await vi.waitFor(() => expect(setup.listenerCount()).toBe(1));

    setup.emit({ type: 'message.added', conversationId: 'thread-1', payload: {} } as never);
    expect(setup.listenerCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    setup.emit({
      type: 'realtime.sdp', conversationId: 'thread-1', payload: { sdp: 'answer' },
    } as never);

    await expect(starting).resolves.toMatchObject({ remoteSdp: 'answer' });
  });

  it.each([
    [
      { type: 'realtime.error', conversationId: 'thread-1', payload: { message: 'negotiation failed' } },
      'negotiation failed',
    ],
    [
      { type: 'realtime.closed', conversationId: 'thread-1', payload: {} },
      'Realtime session closed before returning its WebRTC answer',
    ],
  ])('rejects WebRTC negotiation on %# and cleans up', async (event, message) => {
    vi.useFakeTimers();
    const setup = realtime({
      outputModality: 'audio', transport: { type: 'webrtc', sdp: 'offer' },
    });
    const starting = startCodexRealtimeSession(setup.context);
    await vi.waitFor(() => expect(setup.listenerCount()).toBe(1));

    setup.emit(event as never);

    await expect(starting).rejects.toThrow(message);
    expect(setup.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out WebRTC negotiation and cleans up the listener', async () => {
    vi.useFakeTimers();
    const setup = realtime({
      outputModality: 'audio', transport: { type: 'webrtc', sdp: 'offer' },
    });
    const starting = startCodexRealtimeSession(setup.context);
    const expectation = expect(starting).rejects.toThrow('Timed out waiting for the WebRTC realtime SDP answer');
    await vi.waitFor(() => expect(setup.listenerCount()).toBe(1));

    await vi.advanceTimersByTimeAsync(30_000);

    await expectation;
    expect(setup.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels WebRTC negotiation when the start request fails', async () => {
    vi.useFakeTimers();
    const setup = realtime({
      outputModality: 'audio', transport: { type: 'webrtc', sdp: 'offer' },
    });
    setup.request.mockRejectedValueOnce(new Error('start rejected'));

    await expect(startCodexRealtimeSession(setup.context)).rejects.toThrow('start rejected');

    expect(setup.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('appends websocket audio, text roles, and speech with exact protocol payloads', async () => {
    const setup = realtime({ outputModality: 'text' });
    const session = await startCodexRealtimeSession(setup.context);
    setup.request.mockClear();

    await session.appendAudio({
      data: new Uint8Array([1, 2, 3, 4]), sampleRate: 24_000, numChannels: 2,
      samplesPerChannel: 1, itemId: 'item-1',
    });
    await session.appendText(' hello ');
    await session.appendText(' instructions ', 'developer');
    await session.appendText(' response ', 'assistant');
    await session.appendSpeech(' spoken words ');

    expect(setup.request.mock.calls).toStrictEqual([
      ['thread/realtime/appendAudio', {
        threadId: 'thread-1',
        audio: {
          data: 'AQIDBA==', sampleRate: 24_000, numChannels: 2,
          samplesPerChannel: 1, itemId: 'item-1',
        },
      }],
      ['thread/realtime/appendText', { threadId: 'thread-1', text: 'hello', role: 'user' }],
      ['thread/realtime/appendText', { threadId: 'thread-1', text: 'instructions', role: 'developer' }],
      ['thread/realtime/appendText', { threadId: 'thread-1', text: 'response', role: 'assistant' }],
      ['thread/realtime/appendSpeech', { threadId: 'thread-1', text: 'spoken words' }],
    ]);
  });

  it('rejects unsupported append operations before issuing requests', async () => {
    const websocket = realtime({ outputModality: 'text' });
    const websocketSession = await startCodexRealtimeSession(websocket.context);
    websocket.request.mockClear();
    await expect(websocketSession.appendText('hello', 'system' as never))
      .rejects.toThrow("Invalid realtime text role 'system'");
    await expect(websocketSession.appendText('   ')).rejects.toThrow('Realtime text cannot be empty');
    await expect(websocketSession.appendSpeech('')).rejects.toThrow('Realtime speech cannot be empty');
    expect(websocket.request).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const webrtc = realtime({
      outputModality: 'audio', transport: { type: 'webrtc', sdp: 'offer' },
    });
    const starting = startCodexRealtimeSession(webrtc.context);
    await vi.waitFor(() => expect(webrtc.listenerCount()).toBe(1));
    webrtc.emit({ type: 'realtime.sdp', conversationId: 'thread-1', payload: { sdp: 'answer' } } as never);
    const webrtcSession = await starting;
    webrtc.request.mockClear();
    await expect(webrtcSession.appendAudio({
      data: new Uint8Array(), sampleRate: 24_000, numChannels: 1,
    })).rejects.toThrow('must be sent through its negotiated media track');
    expect(webrtc.request).not.toHaveBeenCalled();
  });

  it('retries a failed stop, stops once after success, and rejects later appends', async () => {
    const setup = realtime({ outputModality: 'text' });
    const session = await startCodexRealtimeSession(setup.context);
    setup.request.mockClear();
    setup.request.mockRejectedValueOnce(new Error('stop failed'));

    await expect(session.stop()).rejects.toThrow('stop failed');
    await expect(session.stop()).resolves.toBeUndefined();
    await expect(session.stop()).resolves.toBeUndefined();
    expect(setup.request).toHaveBeenCalledTimes(2);
    expect(setup.request).toHaveBeenLastCalledWith('thread/realtime/stop', { threadId: 'thread-1' });
    await expect(session.appendText('late')).rejects.toThrow("Realtime session for 'thread-1' is stopped");
    await expect(session.appendSpeech('late')).rejects.toThrow("Realtime session for 'thread-1' is stopped");
    await expect(session.appendAudio({
      data: new Uint8Array(), sampleRate: 24_000, numChannels: 1,
    })).rejects.toThrow("Realtime session for 'thread-1' is stopped");
  });

  it('forwards only realtime conversation events and returns the host unsubscribe', async () => {
    const setup = realtime({ outputModality: 'text' });
    const session = await startCodexRealtimeSession(setup.context);
    const listener = vi.fn();

    const unsubscribe = session.onEvent(listener);
    setup.emit({ type: 'message.added', conversationId: 'thread-1', payload: {} } as never);
    setup.emit({ type: 'realtime.transcript.delta', conversationId: 'thread-1', payload: { delta: 'hi' } } as never);
    setup.emit({ type: 'realtime.closed', conversationId: 'thread-1', payload: {} } as never);

    expect(listener.mock.calls.map(([event]) => event.type)).toStrictEqual([
      'realtime.transcript.delta', 'realtime.closed',
    ]);
    unsubscribe();
    setup.emit({ type: 'realtime.error', conversationId: 'thread-1', payload: { message: 'late' } } as never);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

function realtime(options: StartCodexRealtimeOptions) {
  const listeners = new Set<(event: CodexConversationEvent) => void>();
  const request = vi.fn(async (_method: string, _params: unknown) => ({}));
  const ensureThreadReady = vi.fn(async () => undefined);
  const onConversationEvent = vi.fn((listener: (event: CodexConversationEvent) => void) => {
    listeners.add(listener);
    return vi.fn(() => listeners.delete(listener));
  });
  return {
    context: {
      client: { request } as never,
      ensureThreadReady,
      onConversationEvent,
      options,
      threadId: 'thread-1',
    },
    emit(event: CodexConversationEvent) {
      for (const listener of listeners) listener(event);
    },
    ensureThreadReady,
    listenerCount: () => listeners.size,
    onConversationEvent,
    request,
  };
}
