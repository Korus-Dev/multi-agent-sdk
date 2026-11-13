import type { ExecutionSelection } from './execution';
import type {
  HarnessProvider,
  AppText,
  ApprovalPreset,
  ReasoningEffort,
} from './shared';

export type CodexApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';

/** What a harness hands out to continue a conversation later. `conversationId` names the conversation on every harness. */
export type ProviderSessionData =
  | { kind: 'cursor'; conversationId: string }
  | { kind: 'antigravity'; conversationId: string }
  | { kind: 'codex'; conversationId: string }
  | {
    kind: 'claude';
    conversationId: string;
    transport: 'stdio' | 'websocket';
    /** The transcript the conversation reads from, when Claude keeps it under another id. */
    transcriptConversationId?: string;
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
/** `permission` is one of the ids the harness lists in `capabilities.permissions`, the same field for every harness. */
export type ProviderDefaults = ProviderExecutionDefaults & { userSelectedModel?: boolean; permission?: string } & (
  | { kind: 'cursor' }
  | { kind: 'antigravity' }
  | { kind: 'codex' }
  | { kind: 'claude'; thinking?: { type: 'enabled' | 'disabled'; budgetTokens?: number } }
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
  remoteControl?: boolean;
  /** Managed login methods `authenticate({ action: 'login' })` can start; absent or empty means none. */
  login?: readonly import('./authentication').AuthenticationLoginMethod[];
  /** The provider offers a live realtime (voice or text) session. */
  realtime?: boolean;
  /** Whether conversations belong to a working folder; a harness whose conversations span folders names none in their references. */
  folderScopedConversations?: boolean;
  /** The harness reports each text part's work phase (`commentary` or `final_answer`) itself; absent means text carries no phase. */
  workPhases?: boolean;
  /** `getAccountRateLimits` reads subscription usage and rate limits for the signed-in account. */
  accountUsage?: boolean;
  /**
   * Where a subagent's transcript lives: inside its root conversation, as a conversation of its own, or nowhere the
   * app can read.
   */
  subagentTranscripts?: 'inline' | 'separate' | 'none';
  /** `generateText` runs a one-off text generation. */
  textGeneration?: boolean;
  /** `generateText` accepts an `outputSchema` and the provider enforces it natively. */
  structuredOutput?: boolean;
  /** `generateImage` creates images. */
  imageGeneration?: boolean;
  /** `startReview` runs the provider's own review feature. */
  review?: boolean;
  /** `getBankedResets` and `useBankedReset` are available. */
  bankedResets?: boolean;
  /** Turns can stop on safety findings, and `continueInterruptedTurn` takes a safety review to resume them. */
  safetyReview?: boolean;
  /** `deleteConversation` removes a conversation from the provider. */
  conversationDelete?: boolean;
  /** `setConversationTitle` renames a conversation in the provider. */
  conversationTitle?: boolean;
  /** `executeScopedPrompt` runs a prompt in a separate scope. */
  scopedExecution?: boolean;
  /** `continueInterruptedTurn` resumes a turn a restart or safety block interrupted. */
  turnContinuation?: boolean;
  /** `readConversationContent` reads stored tool output and attachments by offset. */
  conversationContent?: boolean;
  /** `loadTurnHistory` loads one turn's full items. */
  turnHistory?: boolean;
  /** `setConversationStorage` archives or restores a conversation by reference. */
  conversationStorage?: boolean;
  /** MCP servers can be marked `required`, so the conversation fails to start without them. */
  mcpRequiredServers?: boolean;
  /** MCP servers can be marked `approval: 'auto'`, so their tools run without a permission request. */
  mcpAutoApproval?: boolean;
  attachments: boolean;
  models: boolean;
  /** The harness's own slash commands, which it handles when a prompt starts with one. */
  commands?: readonly ProviderCommandSummary[];
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
