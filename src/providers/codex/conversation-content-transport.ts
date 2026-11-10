import { createHash } from 'node:crypto';
import { imageSize } from 'image-size';

type Content = { text: string; byteLength: number; charOffset: number; byteOffset: number };
type Projection = { value: unknown; contents: Map<string, Content> };
/** Transport-only image and file-diff references. Reads require the caller's current authoritative
 * snapshot; the weak cache neither owns history nor keeps discarded snapshots alive. */
export class ConversationContentTransport {
  private readonly cache = new WeakMap<object, Projection>();
  constructor(private readonly conversationId: string) {}

  project<T>(source: T): T { return this.projection(source).value as T; }

  read(source: object, contentId: string, offset: number): { data: string; totalBytes: number; nextOffset: number | null } {
    const content = this.projection(source).contents.get(contentId);
    if (!content) throw new Error('Conversation content is no longer available.');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= content.byteLength) throw new Error('Invalid content offset.');
    const end = Math.min(content.byteLength, offset + 64 * 1024);
    return { data: contentChunk(content, offset, end).toString('base64'), totalBytes: content.byteLength, nextOffset: end < content.byteLength ? end : null };
  }

  private projection(source: unknown): Projection {
    if (source && typeof source === 'object') {
      const cached = this.cache.get(source);
      if (cached) return cached;
    }
    const contents = new Map<string, Content>();
    const references = new Map<string, string>();
    const dimensions = new Map<string, { width: number; height: number } | undefined>();
    const visit = (value: unknown, field?: string): unknown => {
      if (typeof value === 'string' && ['url', 'imageUrl', 'image_url', 'previewUrl'].includes(field ?? '') && /^data:image\/[a-z0-9.+-]+;base64,[a-z\d+/]+=*$/i.test(value)) {
        let reference = references.get(value);
        if (!reference) {
          const id = contentHash(value);
          contents.set(id, { text: value, byteLength: value.length, charOffset: 0, byteOffset: 0 });
          reference = `conversation-image:${encodeURIComponent(this.conversationId)}:${id}`;
          references.set(value, reference);
          dimensions.set(reference, imageDimensions(value));
        }
        return reference;
      }
      if (!value || typeof value !== 'object') return value;
      const change = value as { path?: unknown; kind?: { type?: unknown }; diff?: unknown };
      if (typeof change.path === 'string' && ['add', 'update', 'delete'].includes(String(change.kind?.type))
        && typeof change.diff === 'string' && change.diff.length > 0) {
        const byteLength = Buffer.byteLength(change.diff);
        const contentId = contentHash(change.diff);
        contents.set(contentId, { text: change.diff, byteLength, charOffset: 0, byteOffset: 0 });
        return { ...value, diff: byteLength > 64 * 1024 ? '' : change.diff, diffContent: { sessionId: this.conversationId, contentId, byteLength, changeKind: change.kind!.type } };
      }
      let changed = false;
      let size: { width: number; height: number } | undefined;
      const entries = Object.entries(value).map(([key, child]) => {
        const next = visit(child, key); changed ||= next !== child;
        if (typeof next === 'string') size ??= dimensions.get(next);
        return [key, next] as const;
      });
      return changed ? Array.isArray(value) ? entries.map(([, child]) => child) : { ...Object.fromEntries(entries), ...size } : value;
    };
    const projection = { value: visit(source), contents };
    if (source && typeof source === 'object') this.cache.set(source, projection);
    return projection;
  }
}

/** Retain the provider string, not another full binary copy. Non-ASCII diffs are
 * encoded in bounded blocks; the cursor makes sequential chunk reads linear. */
function contentChunk(content: Content, start: number, end: number): Buffer {
  if (content.byteLength === content.text.length) return Buffer.from(content.text.slice(start, end));
  if (start < content.byteOffset) { content.charOffset = 0; content.byteOffset = 0; }
  const chunks: Buffer[] = [];
  while (content.byteOffset < end) {
    const nextChar = blockEnd(content.text, content.charOffset);
    const text = content.text.slice(content.charOffset, nextChar);
    const nextByte = content.byteOffset + Buffer.byteLength(text);
    if (nextByte > start) chunks.push(Buffer.from(text).subarray(Math.max(0, start - content.byteOffset), Math.min(nextByte, end) - content.byteOffset));
    if (nextByte >= end) break;
    content.charOffset = nextChar; content.byteOffset = nextByte;
  }
  return Buffer.concat(chunks, end - start);
}

function blockEnd(text: string, start: number): number {
  const end = Math.min(text.length, start + 16 * 1024);
  const last = text.charCodeAt(end - 1);
  return end < text.length && last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

function contentHash(text: string): string {
  const hash = createHash('sha256');
  for (let start = 0; start < text.length;) {
    const end = blockEnd(text, start);
    hash.update(text.slice(start, end)); start = end;
  }
  return hash.digest('hex');
}

/** Probe a bounded header, never decode or duplicate the full image. Unsupported
 * or truncated headers omit metadata; the image remains readable unchanged. */
export function imageDimensions(dataUrl: string): { width: number; height: number } | undefined {
  try {
    const start = dataUrl.indexOf(',') + 1;
    const { width, height, orientation } = imageSize(Buffer.from(dataUrl.slice(start, start + 64 * 1024), 'base64'));
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return undefined;
    return orientation && orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
  } catch { return undefined; }
}
