import type { ProviderDefaults, ProviderSessionData } from './provider';
import type { ProviderConversationRef } from './conversation';
import { isHarnessProvider } from './shared';

/**
 * Readers for the session data, conversation references and defaults a harness hands out for persistence, so an
 * app stores them without knowing how each provider shapes them.
 */

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The id of the conversation persisted session data continues. */
export function sessionConversationId(data: ProviderSessionData): string {
  return data.kind === 'codex' ? data.threadId : data.sessionId;
}

/** The id of the conversation a reference names. */
export function conversationRefId(ref: ProviderConversationRef): string {
  return ref.provider === 'codex' ? ref.threadId : ref.sessionId;
}

/** Whether two references name the same conversation, down to the same subagent transcript. */
export function sameConversationRef(left: ProviderConversationRef, right: ProviderConversationRef): boolean {
  if (left.provider !== right.provider || conversationRefId(left) !== conversationRefId(right)) return false;
  const subagent = (ref: ProviderConversationRef) => ref.provider === 'claude' ? ref.subagentId : undefined;
  return subagent(left) === subagent(right);
}

/** The reference to the conversation persisted session data continues, in `folder`. */
export function sessionConversationRef(data: ProviderSessionData, folder: string | null): ProviderConversationRef {
  if (data.kind === 'codex') return { provider: 'codex', threadId: data.threadId };
  if (data.kind === 'claude') return { provider: 'claude', folder: data.transcriptFolder ?? folder, sessionId: data.transcriptSessionId ?? data.sessionId };
  return { provider: data.kind, folder, sessionId: data.sessionId };
}

/** Whether a reference names the conversation persisted session data continues. */
export function sessionHasConversation(data: ProviderSessionData, ref: ProviderConversationRef): boolean {
  if (data.kind !== ref.provider) return false;
  const id = conversationRefId(ref);
  return id === sessionConversationId(data) || (data.kind === 'claude' && id === data.transcriptSessionId);
}

/** Whether a value is session data a harness can restore. */
export function isProviderSessionData(value: unknown): value is ProviderSessionData {
  if (!record(value) || typeof value.kind !== 'string' || !isHarnessProvider(value.kind)) return false;
  if (value.kind === 'codex') return text(value.threadId);
  if (!text(value.sessionId)) return false;
  return value.kind !== 'claude' || value.transport === 'stdio' || value.transport === 'websocket';
}

/** The permission option persisted defaults select; undefined when they select none. */
export function defaultsPermission(defaults: ProviderDefaults | null | undefined): string | undefined {
  if (!defaults) return undefined;
  return defaults.kind === 'codex' ? defaults.approvalPreset : defaults.permissionMode;
}
