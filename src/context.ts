import type { AgentBackend, AgentContextUsage, BackendDefaults, BackendSession, ThreadPlan } from './contracts';

/** A caller-owned conversation binding; contains no application roster or workflow state. */
export type HarnessContext = {
  id: string;
  backend: AgentBackend;
  folder: string | null;
  name?: string | null;
  backendSession?: BackendSession;
  backendDefaults?: BackendDefaults;
  conversationTitle?: string;
  contextUsage?: AgentContextUsage;
  plan?: ThreadPlan;
};
