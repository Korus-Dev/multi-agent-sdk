import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { CodexAppServerClient } from 'codex-sdk';
import type { SurfaceMessage, SurfaceMessageMediaPart } from 'multi-agents-sdk/surface';
import { codexImageDataUrl } from './codex-conversation-history';
import { imageDimensions } from './conversation-content-transport';

const MAX_RECORD = 32 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_IMAGES = 2048;
type Location = { offset: number; length: number; turnId: string; callId: string; imageIndex: number; byteLength: number; hash: string; part: SurfaceMessageMediaPart };
type Index = { path: string; signature: string; images: Map<string, Location> };
type RecordValue = { type?: string; payload?: Record<string, unknown> };

/** Read-only provider history. Retains at most two small offset indexes and two
 * encoded images under a shared budget; never writes files or keeps a second transcript. */
export class CodexOriginalHistoryImages {
  private readonly paths = new Map<string, string>();
  private readonly indexes = new Map<string, Index>();
  private disposed = false;
  private work: Promise<unknown> = Promise.resolve();
  private readonly images = new Map<string, { signature: string; url: string }>();
  constructor(private readonly client: CodexAppServerClient) {}

  forget(threadId: string) { this.paths.delete(threadId); this.indexes.delete(threadId); this.images.clear(); }
  clear() { this.disposed = true; this.paths.clear(); this.indexes.clear(); this.images.clear(); }

  rememberPath(threadId: string, path?: string | null): void {
    if (path !== undefined && path !== this.paths.get(threadId)) { this.indexes.delete(threadId); this.paths.delete(threadId); if (path && isAbsolute(path)) this.paths.set(threadId, path); }
  }

  async prepare(threadId: string, path?: string | null): Promise<(messages: SurfaceMessage[]) => SurfaceMessage[]> {
    this.rememberPath(threadId, path);
    let index: Index | undefined;
    try { index = await this.exclusive(() => this.index(threadId)); } catch { /* Unavailable provider history does not hide the normal transcript. */ }
    const parts = new Map<string, SurfaceMessageMediaPart[]>();
    for (const image of index?.images.values() ?? []) {
      const group = parts.get(image.turnId) ?? []; group.push(image.part); parts.set(image.turnId, group);
    }
    return messages => {
      const lastAssistant = new Map(messages.filter(m => m.role === 'assistant').map(m => [m.turnId, m.id]));
      return messages.map(message => {
        if (message.role !== 'assistant' || message.status === 'streaming') return message;
        const viewed = new Set(message.parts.filter(p => p.type === 'tool' && p.title === 'view_image').map(p => p.type === 'tool' ? p.id : ''));
        const kept = message.parts.filter(p => p.type !== 'media' || (!viewed.has(p.itemId ?? '') && !p.itemId?.startsWith('original-image:')));
        const originals = lastAssistant.get(message.turnId) === message.id ? parts.get(message.turnId ?? '') ?? [] : [];
        const final = kept.findIndex(p => p.type === 'text' && p.phase === 'final_answer');
        const at = final < 0 ? kept.length : final;
        return { ...message, parts: [...kept.slice(0, at), ...originals, ...kept.slice(at)] };
      });
    };
  }

  read(threadId: string, contentId: string, offset: number) {
    return this.exclusive(() => this.readOriginal(threadId, contentId, offset));
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.work.then(operation, operation);
    this.work = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readOriginal(threadId: string, contentId: string, offset: number) {
    const index = await this.index(threadId);
    const location = index.images.get(contentId);
    if (!location) throw new Error('Original conversation image is no longer available.');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= location.byteLength) throw new Error('Invalid content offset.');
    const signature = fileSignature(await stat(index.path));
    if (this.disposed || this.paths.get(threadId) !== index.path) throw new Error('Conversation image reader was released.');
    const cached = this.images.get(contentId);
    let url = cached?.signature === signature ? cached.url : undefined;
    this.images.delete(contentId);
    if (!url) {
      const file = await open(index.path, 'r');
      try {
        await verifyOwner(file, threadId);
        const bytes = Buffer.alloc(location.length);
        for (let position = 0; position < bytes.length;) {
          const result = await file.read(bytes, position, Math.min(64 * 1024, bytes.length - position), location.offset + position);
          if (!result.bytesRead) throw new Error('Original image record was truncated.');
          position += result.bytesRead;
        }
        const record = JSON.parse(bytes.toString('utf8')) as RecordValue;
        const payload = record.payload;
        if (record.type !== 'response_item' || payload?.type !== 'custom_tool_call_output' || payload.call_id !== location.callId
          || turnId(payload) !== location.turnId || !Array.isArray(payload.output)) throw new Error('Original image identity changed.');
        const block = payload.output[location.imageIndex];
        const candidate = imageUrl(block);
        if (!candidate || hash(candidate) !== location.hash) throw new Error('Original image bytes changed.');
        url = candidate;
        if (this.disposed || this.paths.get(threadId) !== index.path) throw new Error('Conversation image reader was released.');
      } finally { await file.close(); }
    }
    this.images.set(contentId, { signature, url });
    while (this.images.size > 2 || [...this.images.values()].reduce((sum, image) => sum + image.url.length, 0) > MAX_IMAGE) {
      this.images.delete(this.images.keys().next().value!);
    }
    const end = Math.min(url.length, offset + 64 * 1024);
    return { data: Buffer.from(url.slice(offset, end)).toString('base64'), totalBytes: url.length, nextOffset: end < url.length ? end : null };
  }

  private async index(threadId: string): Promise<Index> {
    if (this.disposed) throw new Error('Conversation image reader was released.');
    let path = this.paths.get(threadId);
    if (!path) {
      const { thread } = await this.client.request('thread/read', { threadId, includeTurns: false });
      if (thread.id !== threadId || !thread.path || !isAbsolute(thread.path)) throw new Error('Original history is unavailable.');
      if (this.disposed) throw new Error('Conversation image reader was released.');
      path = thread.path; this.paths.set(threadId, path);
    }
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error('Original history is not a file.');
    const signature = fileSignature(metadata);
    const cached = this.indexes.get(threadId);
    if (cached?.signature === signature) return cached;
    const images = new Map<string, Location>();
    const calls = new Map<string, string>();
    const file = await open(path, 'r');
    try {
      await verifyOwner(file, threadId);
      let records = 0;
      for await (const line of lines(file, metadata.size)) {
        if (++records > 100_000 || images.size >= MAX_IMAGES) break;
        let record: RecordValue;
        try { record = JSON.parse(line.text) as RecordValue; } catch { continue; }
        const payload = record?.payload;
        if (record?.type !== 'response_item' || !payload || typeof payload.call_id !== 'string' || !payload.call_id || payload.call_id.length > 256) continue;
        const turn = turnId(payload);
        if (!turn) continue;
        if (payload.type === 'custom_tool_call') {
          if (calls.size < 4096) calls.set(payload.call_id, turn);
          continue;
        }
        if (payload.type !== 'custom_tool_call_output' || calls.get(payload.call_id) !== turn || !Array.isArray(payload.output)) continue;
        calls.delete(payload.call_id);
        for (let i = 0; i < Math.min(payload.output.length, 256) && images.size < MAX_IMAGES; i++) {
          const url = imageUrl(payload.output[i]);
          if (!url) continue;
          const digest = hash(url);
          const id = hash(JSON.stringify([threadId, turn, payload.call_id, i, digest]));
          images.set(id, { offset: line.offset, length: line.length, turnId: turn, callId: payload.call_id, imageIndex: i, byteLength: url.length, hash: digest,
            part: { type: 'media', phase: 'commentary', itemId: `original-image:${payload.call_id}:${i}`, media: {
              url: `conversation-image:${encodeURIComponent(threadId)}:${id}`, mimeType: url.slice(5, url.indexOf(';')),
              title: 'Recorded tool image', alt: 'Recorded tool image', ...imageDimensions(url),
            } } });
        }
      }
    } finally { await file.close(); }
    if (this.disposed || this.paths.get(threadId) !== path) throw new Error('Conversation image reader was released.');
    const index = { path, signature, images };
    this.indexes.delete(threadId); this.indexes.set(threadId, index);
    while (this.indexes.size > 2) this.indexes.delete(this.indexes.keys().next().value!);
    return index;
  }
}

function turnId(payload: Record<string, unknown>): string | undefined {
  const metadata = payload.internal_chat_message_metadata_passthrough;
  return metadata && typeof metadata === 'object' && 'turn_id' in metadata && typeof metadata.turn_id === 'string' && metadata.turn_id.length <= 256 ? metadata.turn_id : undefined;
}
function imageUrl(block: unknown): string | undefined {
  if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'input_image' || !('image_url' in block)
    || typeof block.image_url !== 'string' || block.image_url.length > MAX_IMAGE) return;
  return codexImageDataUrl(block.image_url)?.url;
}
function hash(text: string) { return createHash('sha256').update(text).digest('hex'); }
function fileSignature(value: { dev: number; ino: number; size: number; mtimeMs: number }) { return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}`; }
async function verifyOwner(file: FileHandle, threadId: string) {
  const header = Buffer.alloc(64 * 1024); const { bytesRead } = await file.read(header, 0, header.length, 0);
  const line = header.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]!;
  const record = JSON.parse(line) as RecordValue;
  if (record?.type !== 'session_meta' || record.payload?.id !== threadId) throw new Error('Original history belongs to a different conversation.');
}

/** Fixed-size file reads; oversized records are skipped without retaining them. */
async function* lines(file: FileHandle, size: number) {
  let offset = 0, start = 0, length = 0; let pieces: Buffer[] = [];
  while (offset < size) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, size - offset));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
    if (!bytesRead) break;
    let from = 0;
    while (from < bytesRead) {
      const newline = chunk.indexOf(10, from), end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
      const piece = chunk.subarray(from, end); length += piece.length;
      if (length <= MAX_RECORD) pieces.push(piece); else pieces = [];
      if (newline >= 0 && newline < bytesRead) {
        if (length <= MAX_RECORD) yield { offset: start, length, text: Buffer.concat(pieces, length).toString('utf8') };
        start = offset + end + 1; length = 0; pieces = [];
      }
      from = end + 1;
    }
    offset += bytesRead;
  }
  // A trailing partial record is ignored until the provider appends its newline.
}

/** Keep mutable viewed files as operations, not historical screenshot substitutes. */
export function suppressViewedImagePreviews(messages: SurfaceMessage[]): SurfaceMessage[] {
  return messages.map(message => {
    const viewed = new Set(message.parts.filter(p => p.type === 'tool' && p.title === 'view_image').map(p => p.type === 'tool' ? p.id : ''));
    return viewed.size ? { ...message, parts: message.parts.filter(p => p.type !== 'media' || !viewed.has(p.itemId ?? '')) } : message;
  });
}
