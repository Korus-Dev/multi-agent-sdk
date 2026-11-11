export type AppTextDescriptor = {
  key: string;
  params?: Record<string, string | number>;
};

export type AppText = string | AppTextDescriptor;

export const harnessProviders = ['codex', 'claude', 'cursor', 'antigravity'] as const;
export type HarnessProvider = typeof harnessProviders[number];

export function isHarnessProvider(value: unknown): value is HarnessProvider {
  return harnessProviders.includes(value as HarnessProvider);
}

export type ApprovalPreset = 'ask-for-approval' | 'approve-for-me' | 'full-access';

export type ReasoningEffort = string;
