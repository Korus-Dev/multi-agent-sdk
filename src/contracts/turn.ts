export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
/** Provider counts: cached input is part of input, and reasoning is part of output. */
export type TokenUsage = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** Null when absent. Its relationship to input is not guaranteed by app-server. */
  cacheWriteInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
};

/** Fields lacking public, request-attributable evidence in the supported app-server protocol. */
export type RequestUsageField =
  | 'requestIdentity' | 'timestamp' | 'actualModel' | 'actualProvider' | 'requestTokenUsage'
  | 'cacheWriteLifetimes' | 'cacheWriteInputInclusion' | 'pricingContext'
  | 'requestedModel' | 'requestedServiceTier' | 'reportedServiceTier' | 'finality';

/**
 * Public app-server counters cannot establish independently billable requests.
 * Null requests means unknown coverage, never an empty list or zero consumption.
 */
export type RequestUsage = {
  status: 'unavailable';
  reason: 'public-runtime-request-evidence-unavailable';
  unavailableFields: readonly RequestUsageField[];
  requests: null;
};

export type TurnExecutionUsage = {
  /** This host instance observed the turn start, rather than only its replayed counters. */
  observedStart: boolean;
  /** Latest provider counters; no stable request identity or finality is supplied. */
  last: TokenUsage;
  /** Provider thread counters; may be replayed or reset. */
  total: TokenUsage;
  /** Cumulative replacement since an observed start with a known baseline. */
  execution: TokenUsage | null;
  /** Unknown unless the provider supplies authoritative whole-execution evidence. */
  model: string | null;
  /** Request-pricing capability. Absent on older SDK projections means unknown support. */
  requestUsage?: RequestUsage;
};

/** Provider-authored findings; continuation requires an explanation, instruction and user confirmation. */
export type SafetyFindings = {
  errorType: string | null;
  detailedExplanation: string | null;
  steer: { message: string } | null;
  /** Opaque provider target; its presence alone does not permit continuation. */
  reviewTarget?: string | null;
};

export type TurnError = {
  /** Absent when no provider findings were supplied. */
  misalignment?: SafetyFindings;
  message: string;
  additionalDetails: string | null;
  /** Opaque native compatibility detail; nonportable. Use message/additionalDetails in generic code. */
  codexErrorInfo: JsonValue | null;
};
export type Turn = {
  id: string;
  /** Missing on older/full snapshots. Summary turns can fetch details on expansion. */
  itemsView?: 'full' | 'summary';
  detailsLoading?: boolean;
  detailsError?: string | null;
  status: TurnStatus;
  error: TurnError | null;
  willRetry: boolean;
  /** Provider start time, or the observed live start when the provider omits it. */
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  executionUsage?: TurnExecutionUsage | null;
};
