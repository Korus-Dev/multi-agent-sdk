import type { HarnessContext as Agent } from './context';
import type { AgentBackend, ExecutionSelection, ExecutionSelectionOverrides } from './contracts';
export function defaultExecutionSelection(backend: AgentBackend): ExecutionSelection {
  return { backend, model: null, reasoningEffort: null, serviceTier: null };
}
export function executionSelectionForAgent(agent: Pick<Agent, 'backend' | 'backendDefaults'>): ExecutionSelection {
  const defaults = agent.backendDefaults?.kind === agent.backend ? agent.backendDefaults : undefined;
  return {
    backend: agent.backend,
    model: defaults?.model ?? null,
    reasoningEffort: defaults?.reasoningEffort ?? null,
    serviceTier: defaults && 'serviceTier' in defaults ? defaults.serviceTier ?? null : null,
  };
}
export function resolveExecutionSelection(base: ExecutionSelection, overrides: ExecutionSelectionOverrides = {}): ExecutionSelection {
  if (overrides.backend !== undefined && overrides.backend !== base.backend) {
    throw new Error('Resolve the target provider defaults before applying execution overrides.');
  }
  return {
    backend: base.backend,
    model: overrides.model === undefined ? base.model : overrides.model,
    reasoningEffort: overrides.reasoningEffort === undefined ? (overrides.model === undefined ? base.reasoningEffort : null) : overrides.reasoningEffort,
    serviceTier: overrides.serviceTier === undefined ? base.serviceTier : overrides.serviceTier,
  };
}