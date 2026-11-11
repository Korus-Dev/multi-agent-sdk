import type { CodexAppServerClient, RealtimeVoice } from '@korus-dev/codex-sdk';
import type { CodexConversationEvent, CodexRealtimeEvent, StartCodexRealtimeOptions } from '../../core/codex-conversation-types';
import type { CodexRealtimeSession } from './host-contracts';
import {
  normalizedOptionalRealtimeString,
  normalizedRealtimeText,
  realtimeAudioChunkParams,
} from './host-realtime';

export type StartCodexRealtimeSessionContext = {
  client: CodexAppServerClient;
  ensureThreadReady(): Promise<void>;
  onConversationEvent(listener: (event: CodexConversationEvent) => void): () => void;
  options: StartCodexRealtimeOptions;
  threadId: string;
};

export async function startCodexRealtimeSession(
  context: StartCodexRealtimeSessionContext,
): Promise<CodexRealtimeSession> {
  const { client, ensureThreadReady, onConversationEvent, options, threadId } = context;
  await ensureThreadReady();
  const outputModality = options.outputModality;
  if (outputModality !== 'text' && outputModality !== 'audio') {
    throw new TypeError(`Invalid realtime output modality '${String(outputModality)}'`);
  }
  const version = options.version;
  if (version !== undefined && version !== 'v1' && version !== 'v2' && version !== 'v3') {
    throw new TypeError(`Invalid realtime version '${String(version)}'`);
  }
  const model = normalizedOptionalRealtimeString(options.model, 'model');
  const voice = normalizedOptionalRealtimeString(options.voice, 'voice');
  const transport = options.transport ?? { type: 'websocket' };
  if (transport.type !== 'websocket' && transport.type !== 'webrtc') {
    throw new TypeError(`Invalid realtime transport '${String((transport as { type?: unknown }).type)}'`);
  }
  if (transport.type === 'webrtc' && !transport.sdp.trim()) {
    throw new TypeError('WebRTC realtime transport requires a non-empty SDP offer');
  }
  const answer = transport.type === 'webrtc' ? deferredRealtimeSdp(onConversationEvent) : null;
  let remoteSdp: string | null;
  try {
    const [, sdp] = await Promise.all([client.request('thread/realtime/start', {
      threadId,
      outputModality,
      ...(model ? { model } : {}),
      ...(version ? { version } : {}),
      ...(voice ? { voice: voice as RealtimeVoice } : {}),
      ...(options.includeStartupContext !== undefined
        ? { includeStartupContext: options.includeStartupContext }
        : {}),
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(options.flushTranscriptTailOnSessionEnd !== undefined
        ? { flushTranscriptTailOnSessionEnd: options.flushTranscriptTailOnSessionEnd }
        : {}),
      transport: transport.type === 'webrtc'
        ? { type: 'webrtc', sdp: transport.sdp }
        : { type: 'websocket' },
    }), answer?.promise ?? Promise.resolve(null)]);
    remoteSdp = sdp;
  } catch (error) {
    answer?.cancel();
    throw error;
  }

  let stopped = false;
  const requireActive = (): void => {
    if (stopped) throw new Error(`Realtime session for '${threadId}' is stopped`);
  };
  return {
    conversationId: threadId,
    transport: transport.type,
    remoteSdp,
    appendAudio: async (audio) => {
      requireActive();
      if (transport.type === 'webrtc') {
        throw new Error('WebRTC realtime audio must be sent through its negotiated media track');
      }
      await client.request('thread/realtime/appendAudio', {
        threadId,
        audio: realtimeAudioChunkParams(audio),
      });
    },
    appendText: async (text, role = 'user') => {
      requireActive();
      const normalizedText = normalizedRealtimeText(text, 'text');
      if (role !== 'user' && role !== 'developer' && role !== 'assistant') {
        throw new TypeError(`Invalid realtime text role '${String(role)}'`);
      }
      await client.request('thread/realtime/appendText', { threadId, text: normalizedText, role });
    },
    appendSpeech: async (text) => {
      requireActive();
      await client.request('thread/realtime/appendSpeech', {
        threadId,
        text: normalizedRealtimeText(text, 'speech'),
      });
    },
    stop: async () => {
      if (stopped) return;
      await client.request('thread/realtime/stop', { threadId });
      stopped = true;
    },
    onEvent: (listener) => onConversationEvent((event) => {
      if (event.type.startsWith('realtime.')) listener(event as CodexRealtimeEvent);
    }),
  };
}

function deferredRealtimeSdp(
  onConversationEvent: StartCodexRealtimeSessionContext['onConversationEvent'],
): { promise: Promise<string>; cancel(): void } {
  let unsubscribe: () => void = () => undefined;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsubscribe();
  };
  const promise = new Promise<string>((resolve, reject) => {
    unsubscribe = onConversationEvent((event) => {
      if (event.type === 'realtime.sdp') {
        cleanup();
        resolve(event.payload.sdp);
      } else if (event.type === 'realtime.error') {
        cleanup();
        reject(new Error(event.payload.message));
      } else if (event.type === 'realtime.closed') {
        cleanup();
        reject(new Error('Realtime session closed before returning its WebRTC answer'));
      }
    });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the WebRTC realtime SDP answer'));
    }, 30_000);
  });
  return { promise, cancel: cleanup };
}
