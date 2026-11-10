import type { ContinueCodexSafetyReviewOptions } from '../../core/surface';
import type { CodexAppServerClient, v2 } from '@korus-dev/codex-sdk';
import type {
  CodexConversationEvent,
  CodexConversationHistory,
  CodexConversationHistoryPage,
  CodexConversationPromptHistory,
  CodexConversationLoadingStrategy,
  CodexConversationSnapshot,
  CodexRealtimeEvent,
  CodexRealtimeInputAudioChunk,
  CodexSurfaceApprovalDecision,
  CodexSurfaceApprovalMode,
  CodexSurfaceApprovalPreset,
  CodexSurfaceApprovalScope,
  CodexSurfaceAttachment,
  CodexSurfaceClientRequestResponse,
  CodexSurfaceJsonValue,
  CodexSurfacePermissionMode,
  CreateCodexConversationOptions,
  SendCodexMessageOptions,
  StartCodexRealtimeOptions,
  StartCodexReviewOptions,
  UpdateCodexConversationSettings,
} from '../../core/surface';
import type { CodexMcpServerDefinition } from './codex-surface-mcp';
import type { CodexAppServerStdioTransportOptions } from '@korus-dev/codex-sdk';
import type { CodexAppServerUnixSocketTransportOptions } from '@korus-dev/codex-sdk';

export type GenerateCodexTextOptions = {
  /** Trusted per-call MCP servers, applied only to the ephemeral thread. */
  mcpServers?: readonly CodexMcpServerDefinition[];
  /** Image-only inputs at trusted absolute paths accessible to app-server. */
  attachments?: readonly Extract<CodexSurfaceAttachment, { type: 'image' }>[];
  baseInstructions?: string;
  cwd?: string;
  developerInstructions?: string;
  model?: string;
  outputSchema?: CodexSurfaceJsonValue;
  reasoningEffort?: string;
  serviceTier?: string | null;
  signal?: AbortSignal;
  /** Generation deadline in milliseconds (default 120 seconds); null disables this timer. */
  timeoutMs?: number | null;
  /**
   * Workspace-tool policy. `none` (default) disables environment access;
   * `read-only` uses the provider's default environment with read-only permissions.
   * This does not disable provider-configured tools unrelated to environments.
   */
  tools?: 'none' | 'read-only';
};

export type CodexGeneratedText = {
  text: string;
};

export type CodexDynamicToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl: string };

export type CodexDynamicToolResult = string | {
  content: readonly CodexDynamicToolContent[];
  success?: boolean;
};

export type CodexDynamicToolCall = {
  callId: string;
  conversationId: string;
  turnId: string;
  arguments: CodexSurfaceJsonValue;
  extensionContext?: unknown;
};

export type CodexDynamicTool = {
  name: string;
  description: string;
  inputSchema: CodexSurfaceJsonValue;
  deferLoading?: boolean;
  execute(call: CodexDynamicToolCall): CodexDynamicToolResult | Promise<CodexDynamicToolResult>;
};

export type CodexThreadStartExtension = {
  baseInstructions?: string;
  config?: Readonly<Record<string, CodexSurfaceJsonValue>>;
  developerInstructions?: string;
};

export type CodexConversationHostOptions = {
  extensionContext?: unknown;
  /** Replaces the surface MCP definitions for this conversation. Main-process only. */
  mcpServers?: readonly CodexMcpServerDefinition[];
};

export type CodexConversationDefaults = Pick<
  CreateCodexConversationOptions,
  'model' | 'reasoningEffort' | 'serviceTier'
>;

export type CodexConversationLoadOptions = CodexConversationHostOptions & {
  cwd?: string;
  loadingStrategy?: CodexConversationLoadingStrategy;
  /** Detail fetched for history pages; independent of turn pagination. Defaults to full. */
  historyItemsView?: 'full' | 'summary';
};

/** Trusted thread-start overrides applied to a fork. Omitted values inherit from the source thread. */
export type ForkCodexConversationOptions = CreateCodexConversationOptions;

export type CodexConversationForkResult = {
  readonly conversationId: string;
  readonly conversation: CodexConversation;
  readonly snapshot: CodexConversationSnapshot;
};

export type { ListCodexSkillsOptions } from '../../core/surface';

/** State returned by the app-server remote-control connection. */
export type CodexSurfaceRemoteControlStatus = v2.RemoteControlStatusReadResponse;

/** One-time remote-control pairing details returned by the app-server. */
export type CodexSurfaceRemoteControlPairing = v2.RemoteControlPairingStartResponse;

/** Result of checking whether a remote-control pairing code was claimed. */
export type CodexSurfaceRemoteControlPairingStatus = v2.RemoteControlPairingStatusResponse;

/** A device currently paired with a remote-control environment. */
export type CodexSurfaceRemoteControlClient = v2.RemoteControlClient;

/** A page of devices paired with a remote-control environment. */
export type CodexSurfaceRemoteControlClientPage = v2.RemoteControlClientsListResponse;

/** Managed configuration requirements relevant to the host surface. */
export type CodexSurfaceConfigRequirements = v2.ConfigRequirements;

export type CodexSurfaceExtension = {
  dynamicTools?: readonly CodexDynamicTool[];
  configureConversation?: (context: {
    operation: 'start' | 'resume';
    conversationId: string | null;
    cwd?: string;
    createOptions?: Readonly<CreateCodexConversationOptions>;
    extensionContext?: unknown;
  }) => CodexThreadStartExtension | Promise<CodexThreadStartExtension>;
};

export type CodexConversation = {
  readonly id: string;
  fork(
    options?: ForkCodexConversationOptions,
    hostOptions?: CodexConversationHostOptions,
  ): Promise<CodexConversationForkResult>;
  forkTurn(
    turnId: string,
    options?: ForkCodexConversationOptions,
    hostOptions?: CodexConversationHostOptions,
  ): Promise<CodexConversationForkResult>;
  load(options?: CodexConversationLoadOptions): Promise<CodexConversationSnapshot>;
  select(): Promise<CodexConversationSnapshot>;
  readHistory(): Promise<CodexConversationHistory>;
  readPromptHistory(): Promise<CodexConversationPromptHistory>;
  /** Read current inline or original-history image/diff content in bounded chunks. Main-process only. */
  readContent(contentId: string, offset: number): Promise<{ data: string; totalBytes: number; nextOffset: number | null }>;
  loadOlderHistory(): Promise<CodexConversationHistoryPage>;
  loadTurnHistory(turnId: string): Promise<CodexConversationSnapshot>;
  rename(title: string): Promise<CodexConversationSnapshot>;
  updateSettings(settings: UpdateCodexConversationSettings): Promise<CodexConversationSnapshot>;
  sendMessage(prompt: string, options?: SendCodexMessageOptions): Promise<CodexConversationSnapshot>;
  continueInterruptedTurn(): Promise<CodexConversationSnapshot>;
  /** Main-process only. Call only after explicit user review of the supplied findings. */
  continueAfterSafetyReview?(options: ContinueCodexSafetyReviewOptions): Promise<CodexConversationSnapshot>;
  /** Starts an experimental app-server realtime voice session without exposing JSON-RPC. */
  startRealtime(options: StartCodexRealtimeOptions): Promise<CodexRealtimeSession>;
  compact(): Promise<CodexConversationSnapshot>;
  startReview(options?: StartCodexReviewOptions): Promise<CodexConversationSnapshot>;
  steerMessage(prompt: string, options?: SendCodexMessageOptions): Promise<CodexConversationSnapshot>;
  interrupt(): Promise<CodexConversationSnapshot>;
  deleteTurn(turnId: string): Promise<CodexConversationSnapshot>;
  editTurn(turnId: string, content: string, options?: SendCodexMessageOptions): Promise<CodexConversationSnapshot>;
  retryTurn(turnId: string): Promise<CodexConversationSnapshot>;
  deleteQueuedPrompt(promptId: string): Promise<CodexConversationSnapshot>;
  updateQueuedPrompt(promptId: string, prompt: string, options?: SendCodexMessageOptions): Promise<CodexConversationSnapshot>;
  steerQueuedPrompt(promptId: string, prompt?: string, options?: SendCodexMessageOptions): Promise<CodexConversationSnapshot>;
  respondToClientRequest(response: CodexSurfaceClientRequestResponse): Promise<CodexConversationSnapshot>;
  resolveApproval(
    approvalId: string,
    decision: CodexSurfaceApprovalDecision,
    scope?: CodexSurfaceApprovalScope,
  ): Promise<CodexConversationSnapshot>;
  setGoal(objective: string, tokenBudget?: number | null): Promise<CodexConversationSnapshot>;
  clearGoal(): Promise<CodexConversationSnapshot>;
  getSnapshot(): CodexConversationSnapshot;
  onStateChange(listener: (snapshot: CodexConversationSnapshot) => void): () => void;
  onEvent(listener: (event: CodexConversationEvent) => void): () => void;
};

export type CodexRealtimeSession = {
  readonly conversationId: string;
  readonly transport: 'websocket' | 'webrtc';
  readonly remoteSdp: string | null;
  appendAudio(audio: CodexRealtimeInputAudioChunk): Promise<void>;
  appendText(text: string, role?: 'user' | 'developer' | 'assistant'): Promise<void>;
  appendSpeech(text: string): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: CodexRealtimeEvent) => void): () => void;
};

export type CodexAppServerTransportOptions =
  | CodexAppServerStdioTransportOptions
  | CodexAppServerUnixSocketTransportOptions;

export type CodexSurfaceOptions = {
  /** Read original tool images from local provider-owned history. Defaults to false. */
  originalHistoryImages?: boolean;
  /** Read verified local provider history to recover exact per-turn usage, including compaction. */
  originalHistoryUsage?: boolean;
  approvalPreset?: CodexSurfaceApprovalPreset;
  approvalMode?: CodexSurfaceApprovalMode;
  /** Opt in only when the host presents mandatory-human checkpoints to a person. Defaults to false. */
  requiredHumanApproval?: boolean;
  clientInfo?: { name: string; title?: string; version: string };
  /** Host-owned defaults used by explicit and implicit conversation creation. */
  conversationDefaults?: Readonly<CodexConversationDefaults>;
  conversationLimit?: number;
  /** Default history loading strategy for resumed conversations. */
  loadingStrategy?: CodexConversationLoadingStrategy;
  /** Detail fetched for history pages; independent of turn pagination. Defaults to full. */
  historyItemsView?: 'full' | 'summary';
  /** Trusted host-local CODEX_HOME for the app-server. Never expose this through client transports. */
  codexHome?: string;
  cwd?: string;
  autoSelectFirstConversation?: boolean;
  extensions?: readonly CodexSurfaceExtension[];
  /** App-owned MCP servers applied to every started or resumed conversation. Main-process only. */
  mcpServers?: readonly CodexMcpServerDefinition[];
  /** Receives notifications added by a newer app-server than this SDK schema. */
  onUnknownNotification?: (notification: { method: string; params?: unknown }) => void;
  /**
   * Receives exceptions thrown by listeners registered through `onStateChange`,
   * `onStatePatch`, `onEvent`, and conversation subscriptions. Each listener is
   * isolated, so a failing subscriber never fails the action that triggered the
   * change or silences other subscribers. Defaults to a process warning.
   */
  onListenerError?: (error: unknown) => void;
  /** Structured lifecycle measurements; collection and output policy belong to the host. */
  onDiagnostic?: (record: import('../../diagnostics').HarnessDiagnostic) => void;
  onRequestSettled?: import('@korus-dev/codex-sdk').CodexAppServerClientOptions['onRequestSettled'];
  permissionMode?: CodexSurfacePermissionMode;
  /** Defaults to a spawned stdio child; use `{ type: 'unixSocket' }` to reuse an existing local daemon. */
  transport?: CodexAppServerTransportOptions;
  /** Test and advanced embedding seam. Most apps should let the SDK create the client. */
  client?: CodexAppServerClient;
};
