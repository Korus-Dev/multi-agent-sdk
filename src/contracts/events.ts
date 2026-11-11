import type { ClaudeConversationEvent, ClaudeConversationSnapshot, CursorConversationEvent, CursorConversationSnapshot, AntigravityConversationEvent, AntigravityConversationSnapshot } from './index';
import type { CodexConversationEvent, CodexConversationSnapshot } from '../core/codex-conversation-types';
import type { EventWith, ProviderNotice } from './notices';
export type { ProviderNotice } from './notices';
/** A provider's own conversation frames, input to its harness only. */
export type ConversationFrame =
  | EventWith<{ type: 'cursor.conversationSnapshotChanged'; agentId: string; provider: 'cursor'; payload: { revision: number; snapshot: CursorConversationSnapshot } }>
  | EventWith<{ type: 'cursor.conversationEventReceived'; agentId: string; provider: 'cursor'; payload: { revision: number; event: CursorConversationEvent } }>
  | EventWith<{ type: 'antigravity.conversationSnapshotChanged'; agentId: string; provider: 'antigravity'; payload: { revision: number; snapshot: AntigravityConversationSnapshot } }>
  | EventWith<{ type: 'antigravity.conversationEventReceived'; agentId: string; provider: 'antigravity'; payload: { revision: number; event: AntigravityConversationEvent } }>
  | EventWith<{
      type: 'codex.conversationSnapshotChanged';
      agentId: string;
      provider: 'codex';
      threadId: string;
      payload: {
        revision: number;
        snapshot: CodexConversationSnapshot;
      };
    }>
  | EventWith<{
      type: 'codex.conversationEventReceived';
      agentId: string;
      provider: 'codex';
      threadId: string;
      payload: {
        revision: number;
        event: CodexConversationEvent;
      };
    }>
  | EventWith<{
      type: 'claude.conversationSnapshotChanged';
      agentId: string;
      provider: 'claude';
      payload: {
        revision: number;
        snapshot: ClaudeConversationSnapshot;
      };
    }>
  | EventWith<{
      type: 'claude.conversationEventReceived';
      agentId: string;
      provider: 'claude';
      payload: {
        revision: number;
        event: ClaudeConversationEvent;
      };
    }>;
export type ProviderEvent = ProviderNotice | ConversationFrame;
