import type { ClaudeHistorySource, ClaudeHistoryState } from './history-source';
import { createHash } from 'node:crypto';
import { imageDimensions } from '../codex/conversation-content-transport';
import type { ClaudeConversationTurn, Message, MessagePart } from '../../contracts/index';
import type { ConversationContentChunk, ConversationContentInput } from '../../contracts/conversation';

// Leave room for routing envelopes and snapshot state under the 4 MiB event limit.
const pageBytes = 1024 * 1024;
const pageCount = 50;
// A row is shown whole. Only a part of it that is huge on its own (a screenshot, a file dump) is cut, so a long turn with
// many ordinary tool results is never reduced; a row that still would not fit a page is cut part by part, smallest cut first.
const partBytes = 256 * 1024;
const partTiers = [partBytes, 64 * 1024, 16 * 1024, 4 * 1024, 1024];
const messageBytes = 1536 * 1024;
const bodyHead = 8 * 1024;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const chunkBytes = 64 * 1024;

/** One immutable history read, with cursors independent of transcript appends. */
export class ClaudeHistoryWindow {
  private before: number;
  private readonly content = new Map<string, Buffer>();
  private readonly contentByMessage = new Map<string, string>();
  /** The image bytes each message refers to by `conversation-image:` URL, until a read of it is no longer possible. */
  private readonly imagesByMessage = new Map<string, Set<string>>();

  private readonly messages: Message[];
  private readonly initialIds: Set<string>;
  private visibleIds = new Set<string>();
  private readonly archiveTurns = new Map<string, ClaudeConversationTurn>();
  private pendingArchive?: Promise<void>;
  private recoveredState?: ClaudeHistoryState;

  constructor(public sessionId: string | null, messages: Message[] = [], private source?: ClaudeHistorySource) {
    this.initialIds = new Set(messages.map(message => message.id));
    this.messages = [...messages];
    this.before = messages.length;
  }

  reveal(messages: Message[]): void { for (const message of messages) this.visibleIds.add(message.id); }

  isCurrent(): Promise<boolean> { return this.source?.isCurrent() ?? Promise.resolve(false); }

  get hasOlder(): boolean { return this.before > 0 || Boolean(this.source?.loadEarlier); }
  get hasDeferredArchive(): boolean { return Boolean(this.source?.loadEarlier); }
  isDeferred(messageId: string): boolean { return this.contentByMessage.has(messageId); }

  takeRecoveredState(): ClaudeHistoryState | undefined {
    const state = this.recoveredState;
    this.recoveredState = undefined;
    return state;
  }

  async loadEarlier(forContinuation = false): Promise<void> {
    if (!this.source?.loadEarlier || !forContinuation && this.messages.slice(0, this.before).some(message => !this.visibleIds.has(message.id))) return;
    if (this.pendingArchive) return this.pendingArchive;
    const source = this.source;
    const pending = (async () => {
      const archive = await source.loadEarlier!(forContinuation);
      const original = this.messages.filter(message => this.initialIds.has(message.id));
      const split = archive.messages.length - original.length;
      if (split < 0 || archive.messages.slice(split).some((message, index) => message.id !== original[index]!.id)) {
        throw new Error('Claude history changed. Reload the conversation before loading older messages.');
      }
      const older = archive.messages.slice(0, split);
      for (const message of older) this.initialIds.add(message.id);
      this.messages.unshift(...older);
      for (const turn of archive.turns) this.archiveTurns.set(turn.id, turn);
      this.before += older.length;
      this.source = archive.source;
      this.recoveredState = { taskPlan: archive.taskPlan, goal: archive.goal, subagentEvents: archive.subagentEvents };
    })();
    this.pendingArchive = pending;
    try { await pending; }
    finally { if (this.pendingArchive === pending) this.pendingArchive = undefined; }
  }

  pageTurns(messages: Message[]): ClaudeConversationTurn[] {
    return [...new Set(messages.map(message => message.turnId))].flatMap(id => {
      const turn = id ? this.archiveTurns.get(id) : undefined;
      return turn ? [turn] : [];
    });
  }

  older(known = this.visibleIds): { messages: Message[]; hasOlder: boolean } {
    const page = this.recent(this.messages.slice(0, this.before).filter(message => !known.has(message.id)));
    this.before = page.length ? this.messages.findIndex(message => message.id === page[0]!.id) : 0;
    this.reveal(page);
    return { messages: page, hasOlder: this.hasOlder };
  }

  /** Reopening a bounded window makes its preceding history reachable again. */
  reopen(messages: Message[]): Message[] {
    this.capture(messages);
    const page = this.recent(messages);
    this.visibleIds = new Set(page.map(message => message.id));
    const first = page[0];
    const index = first ? this.messages.findIndex((message) => message.id === first.id) : -1;
    if (index >= 0) this.before = index;
    return page;
  }

  capture(messages: Message[]): void {
    const indexes = new Map(this.messages.map((message, index) => [message.id, index]));
    for (const message of messages) {
      const index = indexes.get(message.id);
      if (index === undefined) {
        indexes.set(message.id, this.messages.length);
        this.messages.push(message);
      } else if (!message.deferredContent) this.messages[index] = message;
    }
  }

  async readMessages(current: Message[]): Promise<Message[]> {
    this.capture(current);
    if (!this.source) return structuredClone(this.messages);
    const original = await this.source.readAll();
    const known = new Set(original.map(message => message.id));
    return [...original, ...structuredClone(this.messages.filter(message => !known.has(message.id)))];
  }

  private recent(messages: Message[]): Message[] {
    const page: Message[] = [];
    let bytes = 2;
    const sources = new Map(this.messages.map(message => [message.id, message]));
    for (let i = messages.length - 1; i >= 0 && page.length < pageCount; i--) {
      const message = this.project(sources.get(messages[i]!.id) ?? messages[i]!);
      const size = Buffer.byteLength(JSON.stringify(message)) + 1;
      if (page.length && bytes + size > pageBytes) break;
      page.unshift(message);
      bytes += size;
    }
    return page;
  }

  /** The row as it travels: unchanged unless a part of it is too big, in which case only those parts are cut and the full row stays readable by content ID. */
  project(message: Message): Message {
    let parts = message.parts;
    let cut = false;
    const stored = new Set<string>();
    // An image too big to travel inline becomes a `conversation-image:` URL the session can read. A new conversation has no
    // session id yet: what fits a row is shown as it was sent, and a bigger image is named `pending` until the id is known,
    // when the message is projected again with the real one.
    const keepInline = this.sessionId === null && size(message.parts) <= messageBytes;
    const reference = keepInline ? null : (dataUrl: string) => {
      const contentId = createHash('sha256').update(dataUrl).digest('hex');
      this.content.set(contentId, Buffer.from(dataUrl));
      stored.add(contentId);
      return `conversation-image:${encodeURIComponent(this.sessionId ?? 'pending')}:${contentId}`;
    };
    for (const limit of partTiers) {
      parts = message.parts.map((part) => shrinkPart(part, limit, reference));
      cut = parts.some((part, index) => part !== message.parts[index] && !isImageReference(part));
      if (size(parts) <= messageBytes) break;
    }
    if (size(parts) > messageBytes) {
      // Thousands of small rows: keep what fits, in order, and say the rest is elsewhere.
      let used = 2;
      const fit = parts.filter((part) => (used += size(part) + 1) <= messageBytes - 1024);
      parts = [...fit, { type: 'status', text: 'More rows are not shown here' }];
      cut = true;
    }
    this.keepImages(message.id, new Set(parts.flatMap(part => { const id = imageContentId(part); return id ? [id] : []; })), stored);
    if (!cut) {
      const previous = this.contentByMessage.get(message.id);
      if (previous && !message.deferredContent) { this.content.delete(previous); this.contentByMessage.delete(message.id); }
      return parts.every((part, index) => part === message.parts[index]) ? message : { ...message, parts };
    }
    const bytes = Buffer.from(JSON.stringify(message));
    const contentId = createHash('sha256').update(bytes).digest('hex');
    const previous = this.contentByMessage.get(message.id);
    if (previous && previous !== contentId) this.content.delete(previous);
    this.contentByMessage.set(message.id, contentId);
    this.content.set(contentId, bytes);
    return { ...message, parts, deferredContent: { contentId, byteLength: bytes.length } };
  }

  /** A message keeps the bytes of the images it refers to now, and none it referred to before or tried and left out, unless another message refers to them. */
  private keepImages(messageId: string, referenced: Set<string>, stored: Set<string>): void {
    const before = this.imagesByMessage.get(messageId) ?? new Set<string>();
    if (referenced.size) this.imagesByMessage.set(messageId, referenced); else this.imagesByMessage.delete(messageId);
    for (const contentId of new Set([...stored, ...before])) {
      if (referenced.has(contentId) || [...this.imagesByMessage.values()].some(held => held.has(contentId))) continue;
      this.content.delete(contentId);
    }
  }

  read(input: ConversationContentInput): ConversationContentChunk {
    const bytes = input.sessionId === this.sessionId ? this.content.get(input.contentId) : undefined;
    if (!bytes) throw new Error('Conversation content is no longer available. Reload the conversation.');
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset >= bytes.length) throw new Error('Invalid conversation content offset.');
    const end = Math.min(input.offset + chunkBytes, bytes.length);
    return { data: bytes.subarray(input.offset, end).toString('base64'), nextOffset: end < bytes.length ? end : null, totalBytes: bytes.length };
  }
}

const imageDataUrl = /^data:image\/[a-z0-9.+-]+;base64,[a-z\d+/]+=*$/i;
const imageReference = /^conversation-image:[^:]+:([a-f0-9]{64})$/;
function imageUrlOf(part: Extract<MessagePart, { type: 'attachment' | 'media' }>): string | undefined { return part.type === 'attachment' ? part.attachment.url : part.media.url; }
function isImageDataUrl(url: string | undefined): url is string { return typeof url === 'string' && imageDataUrl.test(url); }
/** The content a part of this kind refers to by `conversation-image:` URL. */
function imageContentId(part: MessagePart): string | undefined {
  return part.type === 'attachment' || part.type === 'media' ? imageReference.exec(imageUrlOf(part) ?? '')?.[1] : undefined;
}
function isImageReference(part: MessagePart): boolean { return imageContentId(part) !== undefined; }

/** The image part with its bytes moved out of the message: its URL names them, and its size is kept so it is laid out as an image. */
function referencedImage(part: Extract<MessagePart, { type: 'attachment' | 'media' }>, reference: (dataUrl: string) => string): MessagePart {
  const dataUrl = imageUrlOf(part)!;
  const dimensions = imageDimensions(dataUrl);
  const url = reference(dataUrl);
  const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'));
  if (part.type === 'attachment') return { ...part, attachment: { ...part.attachment, url, mimeType: part.attachment.mimeType ?? mimeType, ...(part.attachment.width === undefined ? dimensions : {}) } };
  return { ...part, media: { ...part.media, url, mimeType: part.media.mimeType ?? mimeType, ...(part.media.width === undefined ? dimensions : {}) } };
}

/** One part cut to a preview when it is larger than `limit`; every smaller part is returned as it is. */
function shrinkPart(part: MessagePart, limit: number, reference: ((dataUrl: string) => string) | null): MessagePart {
  if (size(part) <= limit) return part;
  if ((part.type === 'attachment' || part.type === 'media') && isImageDataUrl(imageUrlOf(part))) return reference ? referencedImage(part, reference) : part;
  const head = (text: string, keep: number) => `${text.slice(0, keep)}\n… ${(text.length - keep).toLocaleString('en-US')} more characters not shown`;
  if (part.type === 'tool') {
    const full = part.body ?? (part.output === undefined ? '' : typeof part.output === 'string' ? part.output : JSON.stringify(part.output));
    const keep = Math.min(bodyHead, Math.max(256, Math.floor(limit / 2)));
    return { type: 'tool', id: part.id, kind: part.kind, title: part.title.slice(0, 256), status: part.status,
      ...(full ? { body: head(full, keep) } : {}),
      ...(part.input !== undefined && size(part.input) < Math.min(2048, limit / 4) ? { input: part.input } : {}),
      ...(part.statusText && part.statusText.length < 1024 ? { statusText: part.statusText } : {}),
      ...(part.metadata && size(part.metadata) < 1024 ? { metadata: part.metadata } : {}) };
  }
  if (part.type === 'text') return { ...part, text: head(part.text, Math.max(512, Math.floor(limit / 2))) };
  return { type: 'status', text: 'Content available on demand' };
}
