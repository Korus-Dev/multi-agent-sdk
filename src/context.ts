import type { HarnessProvider, AgentContextUsage, ProviderDefaults, ProviderSessionData, ThreadPlan } from './contracts';

/** A caller-owned conversation binding; contains no application roster or workflow state. */
export type ProviderContext = {
  id: string;
  provider: HarnessProvider;
  folder: string | null;
  name?: string | null;
  providerSession?: ProviderSessionData;
  providerDefaults?: ProviderDefaults;
  conversationTitle?: string;
  contextUsage?: AgentContextUsage;
  plan?: ThreadPlan;
};
