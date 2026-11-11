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

const folderOf = (ref: ProviderConversationRef) => 'folder' in ref ? ref.folder : null;
const subagentIdOf = (ref: ProviderConversationRef) => ref.provider === 'claude' ? ref.subagentId : undefined;

/** Whether two references name the same conversation in the same folder, down to the same subagent transcript. */
export function sameConversationRef(left: ProviderConversationRef, right: ProviderConversationRef): boolean {
  return left.provider === right.provider && conversationRefId(left) === conversationRefId(right)
    && folderOf(left) === folderOf(right) && subagentIdOf(left) === subagentIdOf(right);
}

/** The subagent a reference names within the root conversation `root`; undefined when it names none. */
export function subagentOfRef(ref: ProviderConversationRef, root: ProviderConversationRef): string | undefined {
  if (ref.provider !== root.provider) return undefined;
  // Some providers keep a subagent's transcript inside the root conversation, others give it a conversation of its own.
  if (ref.provider === 'claude') return ref.subagentId && sameConversationRef({ ...ref, subagentId: undefined }, root) ? ref.subagentId : undefined;
  if (ref.provider === 'codex') return conversationRefId(ref) === conversationRefId(root) ? undefined : conversationRefId(ref);
  return undefined;
}

/** The reference to subagent `subagentId` within the root conversation `root`; null when the provider keeps no subagent transcripts. */
export function subagentRef(root: ProviderConversationRef, subagentId: string): ProviderConversationRef | null {
  if (root.provider === 'claude') return { ...root, subagentId };
  if (root.provider === 'codex') return { provider: 'codex', threadId: subagentId };
  return null;
}

/** The reference to the conversation persisted session data continues, in `folder`. */
export function sessionConversationRef(data: ProviderSessionData, folder: string | null): ProviderConversationRef {
  if (data.kind === 'codex') return { provider: 'codex', threadId: data.threadId };
  if (data.kind === 'claude') return { provider: 'claude', folder: data.transcriptFolder ?? folder, sessionId: data.transcriptSessionId ?? data.sessionId };
  return { provider: data.kind, folder, sessionId: data.sessionId };
}

/** Session data that continues conversation `conversationId` on `provider`, as a harness reports attaching to it. */
export function conversationSessionData(provider: import('./shared').HarnessProvider, conversationId: string): ProviderSessionData {
  if (provider === 'codex') return { kind: 'codex', threadId: conversationId };
  if (provider === 'claude') return { kind: 'claude', sessionId: conversationId, transport: 'stdio' };
  return { kind: provider, sessionId: conversationId };
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
