export type Consumption = {
  total?: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number | null;
  reasoning?: number | null;
};
export type ExecutionObservation = {
  agentId: string;
  sessionId: string;
  turnId: string;
  provider: string;
  phase: "started" | "completed" | "failed" | "interrupted" | "usage";
  at: number;
  model: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  tokens?: Consumption | null;
  /** Producer attestation that every billable request in this execution is represented. */
  requestCoverage?: "complete" | "partial" | null;
  /** Why the producer cannot establish a complete request set. */
  requestCoverageReason?: RequestCoverageReason | null;
  durationMs?: number;
  /** Daemon-measured elapsed task time, including tools but excluding blocking user waits. */
  taskDurationMs?: number;
  /** Transient provider stream activity, consumed by the daemon clock, never persisted or sent to clients. */
  generation?: "started" | "output" | "ended";
  /** Measured by the backend, never by a driver. */
  timing?: ExecutionTiming | null;
};
export type ExecutionTiming = { activeMs: number; ttftMs: number | null };
export function validConsumption(value: unknown): value is Consumption {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      [
        "total",
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "reasoning",
      ].includes(key),
    ) &&
    ["input", "output", "cacheRead"].every(
      (key) =>
        Number.isSafeInteger(record[key]) &&
        (record[key] as number) >= 0 &&
        (record[key] as number) <= 1e9,
    ) &&
    (record.cacheRead as number) <= (record.input as number) &&
    (record.total === undefined ||
      record.total === null ||
      (Number.isSafeInteger(record.total) &&
        (record.total as number) >= 0 &&
        (record.total as number) <= 1e9)) &&
    (record.cacheWrite === null ||
      (Number.isSafeInteger(record.cacheWrite) &&
        (record.cacheWrite as number) >= 0 &&
        (record.cacheWrite as number) <= 1e9)) &&
    (record.reasoning === undefined ||
      record.reasoning === null ||
      (Number.isSafeInteger(record.reasoning) &&
        (record.reasoning as number) >= 0 &&
        (record.reasoning as number) <= (record.output as number)))
  );
}
export type ApiPricingProvider = "openai" | "anthropic" | "google";
export type RequestObservation = {
  provider: string;
  agentId: string;
  sessionId: string;
  turnId: string;
  requestId: string;
  /** Optional provider correlation; never a second charge identity. */
  upstreamRequestId?: string | null;
  parentToolUseId?: string | null;
  unavailableReason?:
    | "missing-billing-mode"
    | "missing-token-usage"
    | "missing-service-tier"
    | "unsupported-request-iterations";
  at: number;
  revision: number;
  status: "provisional" | "final";
  apiProvider: ApiPricingProvider | null;
  model: string | null;
  /** All measured tokens must belong to this billing modality; mixed/unknown usage is unpriced. */
  modality: "text" | null;
  cacheMode: "implicit" | "explicit" | null;
  tokens: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    /** Empty means proven no writes. Keys are billable lifetimes, or "default" for a scalar write rate. */
    cacheWrite: Record<string, number> | null;
    reasoning: number | null;
    inputIncludesCacheRead: boolean | null;
    inputIncludesCacheWrite: boolean | null;
    outputIncludesReasoning: boolean | null;
  };
  /** context is the provider's request pricing measure, including cached input when applicable. */
  pricingContext: { context: number | null; region: string | null };
  requestedServiceTier: string | null;
  reportedServiceTier: string | null;
  /** Use only an unambiguous documented billing default, never the requested tier. */
  defaultServiceTier?: { tier: string; source: string };
  reportedMode: string | null;
};
export type RequestCoverageReason =
  | "public-runtime-request-evidence-unavailable"
  | "acp-request-evidence-unavailable"
  | "missing-sdk-request-evidence"
  | "incompatible-sdk-request-evidence";
