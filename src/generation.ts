import type { PromptAttachment, BackendModelOption } from './contracts';
import type { ExecutionSelectionOverrides } from './contracts/execution';
export type HarnessMcpServer = { name: string; url: string; enabledTools: readonly string[] };
export type HarnessMcpEndpoint = Omit<HarnessMcpServer, 'enabledTools'> & { enabledTools?: readonly string[] };
export type HarnessJsonValue = null | boolean | number | string | HarnessJsonValue[] | { [key: string]: HarnessJsonValue };
export type HarnessTextGenerationInput = {
  /** Explicitly null lets inspection run until completion or cancellation. */
  timeoutMs?: null;
  /** Host-local cancellation; never serialized over RPC. */
  signal?: AbortSignal;
  prompt: string;
  cwd: string;
  selection?: Pick<ExecutionSelectionOverrides, 'model' | 'reasoningEffort'>;
  /** Host-local policy, evaluated against this invocation's native catalog. */
  selectModel?: (models: readonly BackendModelOption[]) => Pick<ExecutionSelectionOverrides, 'model' | 'reasoningEffort'>;
  /** Isolated inspection utilities may use read-only Git and source tools. */
  tools?: boolean;
  /** Private host-owned HTTP capabilities for this invocation only. */
  mcpServers?: readonly HarnessMcpServer[];
  developerInstructions?: string;
  outputSchema?: HarnessJsonValue;
  /** Image paths resolved and authorized by the owning host; independent of workspace tools. */
  attachments?: readonly Extract<PromptAttachment, { type: 'image' }>[];
};
export type HarnessTextGenerationResult = {
  text: string;
};

export type HarnessImageGenerationInput = { prompt: string; cwd: string; selection?: { model?: string; reasoningEffort?: string } };
export type HarnessImageGenerationResult = { images: { mimeType: string; data?: string; path?: string }[] };
