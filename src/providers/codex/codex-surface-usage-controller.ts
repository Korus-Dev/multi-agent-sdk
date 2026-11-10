import type {
  CodexSurfaceEvent, CodexSurfaceEventOrigin, CodexSurfaceExecutionUsage, CodexSurfaceRequestUsage, CodexSurfaceTokenUsage,
} from 'multi-agents-sdk/surface';

type EventInput = CodexSurfaceEvent extends infer Event
  ? Event extends CodexSurfaceEvent ? Omit<Event, 'seq' | 'occurredAt' | 'origin'> : never
  : never;
const unavailableRequestUsage: CodexSurfaceRequestUsage = {
  status: 'unavailable',
  reason: 'public-runtime-request-evidence-unavailable',
  unavailableFields: [
    'requestIdentity', 'timestamp', 'actualModel', 'actualProvider', 'requestTokenUsage',
    'cacheWriteLifetimes', 'cacheWriteInputInclusion', 'pricingContext',
    'requestedModel', 'requestedServiceTier', 'reportedServiceTier', 'finality',
  ],
  requests: null,
};

type Execution = { baseline: CodexSurfaceTokenUsage | null; latest: CodexSurfaceExecutionUsage | null;
  native?: { total: CodexSurfaceTokenUsage; execution: CodexSurfaceTokenUsage } };
type ThreadUsage = {
  total: CodexSurfaceTokenUsage | null;
  lastUsageTurnId: string | null;
  activeTurnId: string | null;
  executions: Map<string, Execution>;
};

/** Attributes provider counters only across locally observed execution boundaries. */
export class CodexSurfaceUsageController {
  private readonly threads = new Map<string, ThreadUsage>();

  clear(): void { this.threads.clear(); }

  recover(id: string, turnId: string, value: { total: CodexSurfaceTokenUsage; last: CodexSurfaceTokenUsage; execution: CodexSurfaceTokenUsage }): CodexSurfaceExecutionUsage | undefined {
    const record = this.threads.get(id)?.executions.get(turnId);
    if (!record) return;
    // Native history can flush after the corresponding live packet. Preserve
    // the newer live suffix while adding any native-only compaction charge.
    const suffix = record.latest ? difference(value.total, record.latest.total) : null;
    const execution = suffix ? add(value.execution, suffix) ?? value.execution : value.execution;
    const total = suffix ? record.latest!.total : value.total;
    const last = suffix ? record.latest!.last : value.last;
    record.native = structuredClone({ total, execution });
    const usage = { ...structuredClone({ last, total, execution }), observedStart: true, model: record.latest?.model ?? null,
      requestUsage: structuredClone(unavailableRequestUsage) };
    record.latest = structuredClone(usage);
    return usage;
  }

  /** A successful thread/start establishes zero prior consumption, unlike resume or fork. */
  observeEmptyConversation(id: string): void {
    // Preserve any provider evidence that arrived before the start response.
    if (this.threads.has(id)) return;
    this.thread(id).total = {
      totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      outputTokens: 0, reasoningOutputTokens: 0,
    };
  }

  observe(origin: CodexSurfaceEventOrigin, input: EventInput): EventInput {
    if (!('conversationId' in input)) return input;
    const id = input.conversationId;
    if ((input.type === 'conversation.historyReplaced' && input.payload.reason !== 'details' && input.payload.reason !== 'images') || input.type === 'conversation.summaryRemoved') {
      this.threads.delete(id);
      return input;
    }
    if (input.type === 'turn.started' && origin !== 'lifecycle') {
      const thread = this.thread(id);
      if (!thread.executions.has(input.turnId)) {
        thread.executions.set(input.turnId, {
          baseline: thread.lastUsageTurnId === input.turnId ? null : thread.total, latest: null,
        });
      }
      thread.activeTurnId = input.turnId;
      return input;
    }
    if (input.type === 'turn.completed') {
      const thread = this.threads.get(id);
      if (thread?.activeTurnId === input.turnId) thread.activeTurnId = null;
      return { ...input, payload: { ...input.payload, executionUsage: structuredClone(thread?.executions.get(input.turnId)?.latest ?? null) } };
    }
    if (input.type !== 'conversation.executionUsageChanged') return input;

    const thread = this.thread(id);
    const record = thread.executions.get(input.turnId);
    const incoming = input.payload.usage;
    const overlapping = thread.activeTurnId !== null && thread.activeTurnId !== input.turnId;
    if (overlapping) {
      const active = thread.executions.get(thread.activeTurnId!);
      if (active) { active.baseline = null; active.native = undefined; }
      if (record) { record.baseline = null; record.native = undefined; }
    }
    if (record && (!validCounts(incoming.total)
      || (record.latest && !nondecreasing(record.latest.total, incoming.total)))) {
      record.baseline = null; record.native = undefined;
    }
    const nativeDelta = record?.native ? difference(record.native.total, incoming.total) : null;
    const execution = record?.native && nativeDelta ? add(record.native.execution, nativeDelta)
      : record?.baseline ? difference(record.baseline, incoming.total) : null;
    if (record && execution === null) record.baseline = null;
    const usage: CodexSurfaceExecutionUsage = {
      ...incoming, execution, observedStart: Boolean(record),
      requestUsage: structuredClone(unavailableRequestUsage),
    };
    if (record) record.latest = structuredClone(usage);
    thread.total = !overlapping && validCounts(incoming.total) ? structuredClone(incoming.total) : null;
    thread.lastUsageTurnId = input.turnId;
    return { ...input, payload: { usage } };
  }

  private thread(id: string): ThreadUsage {
    let thread = this.threads.get(id);
    if (!thread) {
      thread = { total: null, lastUsageTurnId: null, activeTurnId: null, executions: new Map() };
      this.threads.set(id, thread);
    }
    return thread;
  }
}

const requiredCounts = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const;
export function validCounts(usage: CodexSurfaceTokenUsage): boolean {
  return requiredCounts.every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
    && (usage.cacheWriteInputTokens === null || (Number.isSafeInteger(usage.cacheWriteInputTokens) && usage.cacheWriteInputTokens >= 0))
    && usage.totalTokens === usage.inputTokens + usage.outputTokens
    && usage.cachedInputTokens <= usage.inputTokens && usage.reasoningOutputTokens <= usage.outputTokens;
}

function nondecreasing(before: CodexSurfaceTokenUsage, after: CodexSurfaceTokenUsage): boolean {
  return requiredCounts.every(key => after[key] >= before[key])
    && (before.cacheWriteInputTokens === null || after.cacheWriteInputTokens === null
      || after.cacheWriteInputTokens >= before.cacheWriteInputTokens);
}

function difference(before: CodexSurfaceTokenUsage, after: CodexSurfaceTokenUsage): CodexSurfaceTokenUsage | null {
  if (!validCounts(before) || !validCounts(after) || !nondecreasing(before, after)) return null;
  const delta: CodexSurfaceTokenUsage = {
    totalTokens: after.totalTokens - before.totalTokens,
    inputTokens: after.inputTokens - before.inputTokens,
    cachedInputTokens: after.cachedInputTokens - before.cachedInputTokens,
    cacheWriteInputTokens: before.cacheWriteInputTokens === null || after.cacheWriteInputTokens === null
      ? null : after.cacheWriteInputTokens - before.cacheWriteInputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    reasoningOutputTokens: after.reasoningOutputTokens - before.reasoningOutputTokens,
  };
  return validCounts(delta) ? delta : null;
}

function add(before: CodexSurfaceTokenUsage, delta: CodexSurfaceTokenUsage): CodexSurfaceTokenUsage | null {
  const result = Object.fromEntries(requiredCounts.map(key => [key, before[key] + delta[key]])) as unknown as CodexSurfaceTokenUsage;
  result.cacheWriteInputTokens = before.cacheWriteInputTokens === null || delta.cacheWriteInputTokens === null
    ? null : before.cacheWriteInputTokens + delta.cacheWriteInputTokens;
  return validCounts(result) ? result : null;
}
