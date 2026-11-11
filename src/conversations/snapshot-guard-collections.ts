import { normalizePromptContent } from '../core/prompt-content';
import { isRecord, optional, includes, isString, isArrayOf } from './snapshot-guard-primitives';
export function isMessage(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.agentId === 'string' &&
    optional(value, 'kind', (candidate) => includes(['compaction', 'steer'], candidate)) &&
    includes(['user', 'assistant', 'system'], value.role) &&
    includes(['complete', 'streaming', 'error'], value.status) &&
    optional(value, 'turnId', isString) &&
    optional(value, 'metadata', metadata => isRecord(metadata) && optional(metadata, 'promptContent', isPromptContent)) &&
    isArrayOf(value.parts, isMessagePart) &&
    typeof value.createdAt === 'string';
}
function isMessagePart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'attachment':
      return isMessageAttachment(value.attachment);
    case 'media':
      return isMessageMedia(value.media) && optional(value, 'itemId', isString);
    case 'reasoning':
      return typeof value.summary === 'string' && typeof value.itemId === 'string' && typeof value.summaryIndex === 'number';
    case 'text':
      return typeof value.text === 'string' &&
        optional(value, 'itemId', isString) &&
        optional(value, 'phase', (candidate) => includes(['commentary', 'partial_answer', 'final_answer'], candidate));
    case 'tool':
      return typeof value.id === 'string' &&
        typeof value.kind === 'string' &&
        typeof value.title === 'string' &&
        includes(['running', 'completed', 'failed'], value.status) &&
        optional(value, 'statusText', isString) &&
        optional(value, 'body', isString) &&
        optional(value, 'metadata', isRecord);
    case 'status':
      return typeof value.text === 'string';
    default:
      return false;
  }
}
function isMessageAttachment(value: unknown): boolean {
  return isRecord(value) &&
    includes(['file', 'image'], value.kind) &&
    typeof value.name === 'string' &&
    optional(value, 'path', isString) &&
    optional(value, 'url', isString) &&
    optional(value, 'mimeType', isString);
}
function isMessageMedia(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.url === 'string' &&
    optional(value, 'alt', isString) &&
    optional(value, 'mimeType', isString) &&
    optional(value, 'prompt', isString) &&
    optional(value, 'title', isString);
}
export function isPromptContent(value: unknown): boolean {
  try { normalizePromptContent(value); return true; }
  catch { return false; }
}
/** @deprecated Use isMessage. */
