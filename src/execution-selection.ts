import type { ProviderContext as Agent } from './context';
import type { HarnessProvider, ExecutionSelection, ExecutionSelectionOverrides } from './contracts';
export function defaultExecutionSelection(provider: HarnessProvider): ExecutionSelection {
  return { provider, model: null, reasoningEffort: null, serviceTier: null };
}
export function executionSelectionForAgent(agent: Pick<Agent, 'provider' | 'providerDefaults'>): ExecutionSelection {
  const defaults = agent.providerDefaults?.kind === agent.provider ? agent.providerDefaults : undefined;
  return {
    provider: agent.provider,
    model: defaults?.model ?? null,
    reasoningEffort: defaults?.reasoningEffort ?? null,
    serviceTier: defaults && 'serviceTier' in defaults ? defaults.serviceTier ?? null : null,
  };
}
export function resolveExecutionSelection(base: ExecutionSelection, overrides: ExecutionSelectionOverrides = {}): ExecutionSelection {
  if (overrides.provider !== undefined && overrides.provider !== base.provider) {
    throw new Error('Resolve the target provider defaults before applying execution overrides.');
  }
  return {
    provider: base.provider,
    model: overrides.model === undefined ? base.model : overrides.model,
    reasoningEffort: overrides.reasoningEffort === undefined ? (overrides.model === undefined ? base.reasoningEffort : null) : overrides.reasoningEffort,
    serviceTier: overrides.serviceTier === undefined ? base.serviceTier : overrides.serviceTier,
  };
}