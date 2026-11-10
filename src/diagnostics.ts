/** Structured measurements only; applications own collection, filtering and output. */
export type HarnessDiagnostic = {
  layer: string;
  stage: string;
  threadId: string;
  agentId?: string;
  /** Epoch milliseconds; durations are measured with the monotonic clock. */
  at: number;
  startAt?: number;
  stageMs?: number;
  elapsedMs?: number;
  revision?: number;
  messages?: number;
  projectMs?: number;
  emitMs?: number;
};
