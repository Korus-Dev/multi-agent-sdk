import type { Consumption } from '../../contracts/usage';
import { record } from '../../acp/acp-connection';

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1e9;

/**
 * The CLI's ACP completion reports uncached input separately from cache reads.
 * Output already includes thoughts. Both were verified against native generation counters.
 * Nonzero cache writes have no supported mapping.
 */
export function acpConsumption(usage: unknown): Consumption | null {
  if (!record(usage)) return null;
  const { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens } = usage;
  if (!count(inputTokens) || !count(outputTokens)) return null;
  const cached = cachedReadTokens ?? 0, thoughts = thoughtTokens ?? 0;
  if (!count(cached) || !count(thoughts) || thoughts > outputTokens || (cachedWriteTokens ?? 0) !== 0) return null;
  const input = inputTokens + cached;
  const total = input + outputTokens;
  if (totalTokens != null && totalTokens !== total) return null;
  return { input, output: outputTokens, total, cacheRead: cached, cacheWrite: 0, reasoning: thoughts };
}

/** The model the session currently has selected; the ACP never reports the model that served a turn. */
export function selectedModel(configuration: Record<string, unknown>): string | null {
  const options = Array.isArray(configuration.configOptions) ? configuration.configOptions : [];
  const option = options.find(value => record(value) && value.id === 'model');
  if (record(option) && typeof option.currentValue === 'string' && option.currentValue) return option.currentValue;
  const models = record(configuration.models) ? configuration.models : {};
  return typeof models.currentModelId === 'string' && models.currentModelId ? models.currentModelId : null;
}
