import type { RateLimitDetails } from './contracts/rate-limit';
import type { TurnStatus } from './contracts/turn';

/** An error a turn or session reported, the same for every harness. */
export type HarnessError = {
  message: string;
  /** A provider's machine-readable error code, when it gave one. */
  code?: string;
  /** When the provider says the limit it hit resets. */
  rateLimit?: RateLimitDetails;
};

export type ActivityScope = { turnId?: string; conversationId?: string };
/** What happened in a session's conversation, as events, for consumers that react to activity rather than state. */
export type ConversationActivity =
  | ActivityScope & { type: 'turn.started'; turnId: string }
  | ActivityScope & { type: 'turn.completed'; turnId: string; status: TurnStatus; error: HarnessError | null; willRetry: boolean }
  /** An error outside a turn's own completion; `willRetry` means the provider is retrying it. */
  | ActivityScope & { type: 'session.error'; error: HarnessError; willRetry: boolean }
  | ActivityScope & { type: 'tool.updated'; tool: { id: string; kind?: string; status: 'running' | 'completed' | 'failed' } }
  /** The turn's first output: text, reasoning, a plan or the start of a tool call. Reported once per turn. */
  | ActivityScope & { type: 'turn.output' }
  /** The conversation's file changes changed. */
  | ActivityScope & { type: 'diff.updated' }
  | ActivityScope & { type: 'file.activity'; path?: string; action: string; status: string };
