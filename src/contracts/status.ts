import type { AppText } from './shared';
export type AgentStatus =
  | { type: 'idle' }
  | { type: 'working'; detail?: AppText }
  /** `reason` says what the person is asked for: an approval, or an answer or other input. */
  | { type: 'awaitingInput'; reason?: 'approval' | 'input'; detail?: AppText }
  | { type: 'error'; message: AppText; safetyReview?: import('./safety-review').ProviderSafetyReview };