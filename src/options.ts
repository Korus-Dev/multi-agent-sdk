import type { AppText, ProviderSessionData } from './contracts';
import type { HarnessDiagnostic } from './diagnostics';
import type { HarnessMcpEndpoint, HarnessMcpServer } from './generation';
import type { HarnessContext } from './consumer-types';
import type { ModelDescriptor, PromptPart } from './ui-types';

/** Where and how to start a provider's command-line runtime. */
export type HarnessLaunch = { command?: string; env?: Record<string, string | undefined> };

export type HarnessLogLevel = 'debug' | 'info' | 'warn';
export type HarnessLog = (level: HarnessLogLevel, component: string, message: string, details?: Record<string, unknown>) => void;

/** One finished request to a provider runtime, for apps that trace latency. */
export type HarnessRequestRecord = { id: number | string; method: string; outcome: 'ok' | 'error' | 'timeout'; startedAt: number; durationMs: number };

/** What the app adds to a conversation when it starts or resumes. */
export type HarnessConversationConfig = {
  /** Provider configuration keys, as the provider's own settings file names them. */
  config?: Record<string, string | number | boolean>;
  developerInstructions?: string;
};

export type HarnessOptions = {
  /** Identity the provider sees. `title` is the display name; `entrypoint` and `clientApp` label embedded Claude sessions. */
  client: { name: string; title?: string; version?: string; metadataDirectory?: string; temporaryDirectory?: string; entrypoint?: string; clientApp?: string };
  /** Provider home. When set the provider runs against it instead of the user's standard home. */
  home?: string;
  stateDirectory?: () => string;
  /** `planMode` is true when the provider needs the plan-only rule spelled out in its instructions. */
  instructions?: (context: HarnessContext, options: { planMode: boolean }) => string | undefined;
  mcpServers?: (context: HarnessContext) => readonly HarnessMcpEndpoint[];
  formatPrompt?: (prompt: string, content: readonly PromptPart[] | undefined) => string;
  /** The app's own MCP server. Its tools run without a permission prompt. */
  trustedMcpServerName?: string;
  /** Display name for an MCP server in tool presentation. */
  mcpServerLabel?: (server: string | undefined) => string | undefined;
  /** Text for the runtime status line; the SDK supplies plain defaults. */
  statusText?: (status: 'notConfigured' | 'connecting' | 'running') => AppText;
  /** Text for conversations waiting on the person. */
  waitingText?: { approval?: AppText; input?: AppText };
  log?: HarnessLog;
  onDiagnostic?: (record: HarnessDiagnostic) => void;
  /** Rejects or rewrites the MCP servers a text generation may use. */
  generationMcpServers?: (servers: unknown) => readonly HarnessMcpServer[];

  codex?: {
    launch?: HarnessLaunch;
    /** `key=value` overrides for every conversation, in order. */
    config?: readonly string[];
    /** Per-conversation additions, evaluated each time a conversation starts or resumes. */
    conversationConfig?: (context: HarnessContext, scope?: { mcpServerUrl?: string }) => HarnessConversationConfig | Promise<HarnessConversationConfig>;
    defaultModel?: { model: string; reasoningEffort?: string };
    /** Codex may read the workspace but never write to it or ask for approval. */
    readOnly?: boolean;
    /** Whether the conversation title follows the session name. */
    syncTitle?: (context: HarnessContext) => boolean;
    /** Sessions to keep alive for a context, such as reviewers. */
    retainedSessions?: (context: HarnessContext) => readonly ProviderSessionData[];
    imageModel?: (models: readonly ModelDescriptor[]) => { model: string; reasoningEffort?: string };
    onRequestSettled?: (record: HarnessRequestRecord) => void;
  };
  claude?: {
    launch?: (command: string | undefined, env: NodeJS.ProcessEnv | undefined) => { command?: string; env: NodeJS.ProcessEnv };
    disallowedTools?: readonly string[];
    /** Decides a tool call before the consumer is asked. Return nothing to let it through to a permission request. */
    decideTool?: (tool: string, input: Record<string, unknown>) => { behavior: 'deny'; message: string } | undefined;
    /** Rewrites an MCP tool's input for display. */
    presentMcpInput?: (tool: { server: string; tool: string }, input: Record<string, unknown>) => Record<string, unknown>;
  };
  cursor?: {
    command?: () => string | null;
    /** Interrupt and resend when the person steers a running turn. */
    steeringFallback?: () => boolean;
  };
  antigravity?: {
    /** Overrides the ACP runtime executable and its companion harness. */
    command?: string;
    harnessPath?: string;
  };
};

/** Options every harness takes, without any provider's own block. */
export type SharedHarnessOptions = Omit<HarnessOptions, import('./contracts/shared').HarnessProvider>;
/** Options for one harness: the shared options plus that provider's own block. A provider union accepts each of its blocks. */
export type HarnessOptionsFor<P extends import('./contracts/shared').HarnessProvider> = SharedHarnessOptions & Pick<HarnessOptions, P>;
