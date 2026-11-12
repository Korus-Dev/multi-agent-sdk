import type { ProviderSessionData } from './provider';
import type { HarnessProvider } from './shared';
import type { ProviderConversationRef } from './conversation';
import { isHarnessProvider } from './shared';
import { defaultHarnessCapabilities } from '../capabilities';

/**
 * Readers for the session data, conversation references and defaults a harness hands out for persistence, so an
 * app stores them without knowing how each provider shapes them.
 */

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The id of the conversation persisted session data continues. */
export function sessionConversationId(data: ProviderSessionData): string {
  return data.conversationId;
}

/** The id of the conversation a reference names. */
export function conversationRefId(ref: ProviderConversationRef): string {
  return ref.conversationId;
}

const folderOf = (ref: ProviderConversationRef) => 'folder' in ref ? ref.folder : null;
const subagentIdOf = (ref: ProviderConversationRef) => 'subagentId' in ref ? ref.subagentId : undefined;

/** A reference to conversation `conversationId` on `provider`, in `folder` where the harness keeps conversations by folder. */
function conversationRef(provider: HarnessProvider, conversationId: string, folder: string | null): ProviderConversationRef {
  return (defaultHarnessCapabilities(provider).folderScopedConversations ? { provider, folder, conversationId } : { provider, conversationId }) as ProviderConversationRef;
}

/** Whether two references name the same conversation in the same folder, down to the same subagent transcript. */
export function sameConversationRef(left: ProviderConversationRef, right: ProviderConversationRef): boolean {
  return left.provider === right.provider && conversationRefId(left) === conversationRefId(right)
    && folderOf(left) === folderOf(right) && subagentIdOf(left) === subagentIdOf(right);
}

/** The subagent a reference names within the root conversation `root`; undefined when it names none. */
export function subagentOfRef(ref: ProviderConversationRef, root: ProviderConversationRef): string | undefined {
  if (ref.provider !== root.provider) return undefined;
  const storage = defaultHarnessCapabilities(ref.provider).subagentTranscripts;
  // A subagent's transcript lives inside its root conversation, or is a conversation of its own.
  if (storage === 'inline') { const id = subagentIdOf(ref); return id && sameConversationRef({ ...ref, subagentId: undefined } as ProviderConversationRef, root) ? id : undefined; }
  if (storage === 'separate') return conversationRefId(ref) === conversationRefId(root) ? undefined : conversationRefId(ref);
  return undefined;
}

/** The reference to subagent `subagentId` within the root conversation `root`; null when the provider keeps no subagent transcripts. */
export function subagentRef(root: ProviderConversationRef, subagentId: string): ProviderConversationRef | null {
  const storage = defaultHarnessCapabilities(root.provider).subagentTranscripts;
  if (storage === 'inline') return { ...root, subagentId } as ProviderConversationRef;
  if (storage === 'separate') return conversationRef(root.provider, subagentId, folderOf(root));
  return null;
}

/** The reference to the conversation persisted session data continues, in `folder`. */
export function sessionConversationRef(data: ProviderSessionData, folder: string | null): ProviderConversationRef {
  // Claude may keep a conversation's transcript under another id and in another folder.
  const transcript = data.kind === 'claude' ? data : undefined;
  return conversationRef(data.kind, transcript?.transcriptConversationId ?? data.conversationId, transcript?.transcriptFolder ?? folder);
}

/** Session data that continues conversation `conversationId` on `provider`, as a harness reports attaching to it. */
export function conversationSessionData(provider: HarnessProvider, conversationId: string): ProviderSessionData {
  return (provider === 'claude' ? { kind: provider, conversationId, transport: 'stdio' } : { kind: provider, conversationId }) as ProviderSessionData;
}

/** Whether a reference names the conversation persisted session data continues. */
export function sessionHasConversation(data: ProviderSessionData, ref: ProviderConversationRef): boolean {
  if (data.kind !== ref.provider) return false;
  const id = conversationRefId(ref);
  return id === sessionConversationId(data) || (data.kind === 'claude' && id === data.transcriptConversationId);
}

/** Whether a value is session data a harness can restore. */
export function isProviderSessionData(value: unknown): value is ProviderSessionData {
  if (!record(value) || typeof value.kind !== 'string' || !isHarnessProvider(value.kind) || !text(value.conversationId)) return false;
  return value.kind !== 'claude' || value.transport === 'stdio' || value.transport === 'websocket';
}
