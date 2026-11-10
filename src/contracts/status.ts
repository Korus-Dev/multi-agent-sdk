import type { AppText } from './shared';
export type AgentStatus =
  | { type: 'idle' }
  | { type: 'working'; detail?: AppText }
  | { type: 'awaitingInput'; detail?: AppText }
  | { type: 'error'; message: AppText; safetyReview?: import('./safety-review').ProviderSafetyReview };