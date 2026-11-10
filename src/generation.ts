import type { PromptAttachment, BackendModelOption } from './contracts';
import type { ExecutionSelectionOverrides } from './contracts/execution';
/** Host trust is independent of tool availability. Omission inherits native permission policy.
 * `auto` explicitly trusts the selected tools (Codex/Claude only; ACP rejects it).
 * `required: true` requires connection at startup (Codex only; other providers reject it).
 * `required: false` leaves startup optional; providers without startup enforcement accept it as a no-op.
 * There is no portable forced-human approval mode: native permission policy remains authoritative.
 */
export type HarnessMcpPolicy = { approval?: 'inherit' | 'auto'; required?: boolean };
export type HarnessMcpServer = HarnessMcpPolicy & { name: string; url: string; enabledTools: readonly string[] };
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

/** Caller-owned tool scope; identity changes require a native configuration transition. */
export type HarnessPromptScope = {
  id: string;
  mcpServers?: HarnessMcpEndpoint[];
  allowedTools?: string[];
  developerInstructions?: string;
};
