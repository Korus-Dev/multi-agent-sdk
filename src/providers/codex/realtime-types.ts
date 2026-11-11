import type { CodexRealtimeInputAudioChunk, CodexRealtimeEvent } from '../../core/codex-conversation-types';

export type CodexRealtimeSession = {
  readonly conversationId: string;
  readonly transport: 'websocket' | 'webrtc';
  readonly remoteSdp: string | null;
  appendAudio(audio: CodexRealtimeInputAudioChunk): Promise<void>;
  appendText(text: string, role?: 'user' | 'developer' | 'assistant'): Promise<void>;
  appendSpeech(text: string): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: CodexRealtimeEvent) => void): () => void;
};

