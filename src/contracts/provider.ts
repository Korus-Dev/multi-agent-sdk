import type { ExecutionSelection } from './execution';
import type {
  HarnessProvider,
  AppText,
  ApprovalPreset,
  ReasoningEffort,
} from './shared';

export type CodexApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';

export type ProviderSessionData =
  | { kind: 'cursor'; sessionId: string }
  | { kind: 'antigravity'; sessionId: string }
  | {
    kind: 'codex';
    threadId: string;
  }
  | {
    kind: 'claude';
    sessionId: string;
    transport: 'stdio' | 'websocket';
    transcriptSessionId?: string;
    /** Native store location; execution still uses the agent's folder. */
    transcriptFolder?: string;
    serverUrl?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
  };

/** Provider settings adapt the shared selection to native defaults alongside provider policy. */
type ProviderExecutionDefaults = {
  [K in Exclude<keyof ExecutionSelection, 'provider'>]?: K extends 'serviceTier' ? ExecutionSelection[K] : NonNullable<ExecutionSelection[K]>;
};
export type ProviderDefaults = ProviderExecutionDefaults & { userSelectedModel?: boolean } & (
  | { kind: 'cursor'; permissionMode?: string }
  | { kind: 'antigravity'; permissionMode?: string }
  | { kind: 'codex'; approvalPreset?: ApprovalPreset; approvalPolicy?: string; approvalsReviewer?: CodexApprovalsReviewer; sandboxMode?: string }
  | { kind: 'claude'; permissionMode?: string; thinking?: { type: 'enabled' | 'disabled'; budgetTokens?: number } }
);

export type CodexThreadSettings = {
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  approvalPolicy?: string;
  approvalsReviewer?: CodexApprovalsReviewer;
  sandboxPolicy?: { type: string };
  activePermissionProfile?: { id: string };
};

export type AccountRateLimitWindow = {
  /** Names what the window limits when an engine has several of the same duration. */
  label?: string | null;
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

/** Display-safe monetary balances, independent of provider-native billing objects. */
export type AccountBilling = {
  includedBalanceUsd: string | null;
  onDemand: {
    enabled: boolean | null;
    unlimited: boolean;
    usedUsd: number | null;
    limitUsd: number | null;
    remainingUsd: number | null;
  };
};

export type AccountRateLimits = {
  limitId: string | null;
  limitName: string | null;
  primary: AccountRateLimitWindow | null;
  secondary: AccountRateLimitWindow | null;
  credits: unknown;
  individualLimit: unknown;
  planType: string | null;
  rateLimitReachedType: string | null;
  billing?: AccountBilling;
};

export type ProviderPlanModeSupport = 'native' | 'prompted' | 'unsupported';

export type ProviderCapabilities = {
  /** Supplies token counters for analytics; absent retains legacy support. */
  reportsTokens?: boolean;
  /** The harness supplies its own background monitor tool; absent means false. */
  nativeMonitor?: boolean;
  questions?: boolean;
  plugins?: boolean;
  conversationArchive?: boolean;
  conversationResume?: boolean;
  conversationReplaceWithSummary?: boolean;
  remoteControl?: boolean;
  /** Managed login methods `authenticate({ action: 'login' })` can start; absent or empty means none. */
  login?: readonly import('./authentication').AuthenticationLoginMethod[];
  /** The provider offers a live realtime (voice or text) session. */
  realtime?: boolean;
  /** `getAccountRateLimits` reads subscription usage and rate limits for the signed-in account. */
  accountUsage?: boolean;
  attachments: boolean;
  models: boolean;
  skills: boolean;
  reasoningEffort: boolean;
  serviceTier?: boolean;
  thinkingBudget: boolean;
  planMode: ProviderPlanModeSupport;
  goals: boolean;
  steerPrompt: boolean;
  interrupt: boolean;
  history: boolean;
  conversationFork?: boolean;
  deleteTurn: boolean;
  editTurn: boolean;
  retryTurn: boolean;
  approvals: boolean;
  approvalPresets?: ApprovalPreset[];
  permissionModes?: ProviderPermissionModeOption[];
};

export type ProviderPermissionModeOption = {
  id: string;
  /** Optional provider-authored metadata; consumers own labels for SDK defaults. */
  label?: AppText;
  description?: AppText;
  dangerous?: boolean;
};

export type CodexAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string }
  | { type: 'amazonBedrock'; credentialSource: 'codexManaged' | 'awsManaged' };

export type CodexAuthentication = {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
  login: {
    status: 'idle' | 'starting' | 'pending' | 'completed' | 'cancelled' | 'error';
    error: string | null;
  };
};

export type CodexChatGptLogin = {
  loginId: string;
  authUrl: string;
};

export type CodexChatGptDeviceCodeLogin = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

export type ProviderReasoningEffortOption = {
  reasoningEffort: ReasoningEffort;
  description: string;
};

export type ProviderServiceTier = {
  id: string;
  name: string;
  description: string;
};

export type ProviderModelOption = {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: ProviderReasoningEffortOption[];
  defaultReasoningEffort?: ReasoningEffort | null;
  serviceTiers?: ProviderServiceTier[];
  defaultServiceTier?: string | null;
  isDefault?: boolean;
  capabilities?: Partial<ProviderCapabilities>;
  providerMetadata?: Record<string, unknown>;
};

export type ProviderSkillSummary = {
  id?: string;
  name: string;
  description?: string;
  shortDescription?: string;
  displayName?: string;
  iconSmall?: string;
  iconLarge?: string;
  brandColor?: string;
  defaultPrompt?: string;
  path: string;
  scope?: string;
  enabled: boolean;
  providerMetadata?: Record<string, unknown>;
};

export type ProviderPluginSummary = {
  id: string;
  name: string;
  displayName: string;
  shortDescription?: string;
  longDescription?: string;
  brandColor?: string;
  iconUrl?: string;
  iconUrlDark?: string;
  enabled: boolean;
};

export type ProviderCommandSummary = {
  id: string;
  provider: HarnessProvider;
  name: string;
  displayName?: string;
  description?: string;
  slashName?: string;
  submitOnSelect?: boolean;
  composerMode?: {
    label?: string;
    placeholder?: string;
  };
  providerMetadata?: Record<string, unknown>;
};

export type ProviderRuntimeStatus = {
  provider: HarnessProvider;
  status: 'notConfigured' | 'starting' | 'running' | 'error';
  detail?: AppText;
  capabilities?: Partial<ProviderCapabilities>;
};

export type ProviderConnectionState = {
  status: 'connecting' | 'connected' | 'reconnecting' | 'error';
  detail?: AppText;
};



export type RuntimeConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error';



export type EventOrigin = 'action' | 'notification' | 'lifecycle';
