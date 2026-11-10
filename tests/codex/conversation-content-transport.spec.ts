import { describe, expect, it } from 'vitest';
import { ConversationContentTransport } from '../../src/providers/codex/conversation-content-transport';

// The transport must avoid aggregate image payloads, preserve exact bytes on demand,
// and refuse content absent from the current authoritative snapshot. No history store.
describe('conversation image transport', () => {
  it('defers full file diffs without changing history and reads exact UTF-8 chunks', () => {
    const transport = new ConversationContentTransport('thread');
    const diff = '🪴 screenshot data\n'.repeat(20_000);
    const change = { path: '/repo/capture.png.b64', kind: { type: 'add' }, diff };
    const snapshot = { messages: [{ parts: [{ type: 'tool', kind: 'fileChange', input: { changes: [change] }, metadata: { changes: [change] } }] }] };
    const beforeProjection = process.memoryUsage().arrayBuffers;
    const projected = transport.project(snapshot);
    expect(process.memoryUsage().arrayBuffers - beforeProjection).toBeLessThan(128 * 1024);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(2000);
    const value = projected.messages[0]!.parts[0]!;
    const deferred = value.input.changes[0] as unknown as { diff: string; diffContent: { sessionId: string; contentId: string; byteLength: number; changeKind: string } };
    expect(deferred.diff).toBe('');
    expect(deferred.diffContent).toMatchObject({ sessionId: 'thread', byteLength: Buffer.byteLength(diff), changeKind: 'add' });
    expect(value.metadata.changes).toStrictEqual(value.input.changes);
    expect(transport.project({ type: 'tool.updated', payload: { changes: [change] } }).payload.changes).toStrictEqual(value.input.changes);
    const chunks: Buffer[] = []; let offset = 0;
    for (;;) {
      const chunk = transport.read(snapshot, deferred.diffContent.contentId, offset);
      chunks.push(Buffer.from(chunk.data, 'base64'));
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe(diff);
    expect(snapshot.messages[0]!.parts[0]!.input.changes[0]!.diff).toBe(diff);
    expect(() => transport.read({ messages: [] }, deferred.diffContent.contentId, 0)).toThrow();
    // Small historical changes must remain readable after reload without a turn-level Git diff.
    for (const kind of ['add', 'update', 'delete']) {
      const text = kind === 'update' ? '@@ -1 +1 @@\n-old\n+README 🪴\n' : '# README 🪴\n';
      const original = { path: '/repo/README.md', kind: { type: kind }, diff: text };
      const reloaded = { changes: [JSON.parse(JSON.stringify(original))] };
      const fresh = new ConversationContentTransport('thread');
      const projected = fresh.project(reloaded).changes[0] as typeof original & { diffContent: { sessionId: string; contentId: string; byteLength: number; changeKind: string } };
      expect(projected).toStrictEqual({ ...original, diffContent: { sessionId: 'thread', contentId: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: Buffer.byteLength(text), changeKind: kind } });
      expect(fresh.read(reloaded, projected.diffContent.contentId, 0)).toStrictEqual({ data: Buffer.from(text).toString('base64'), totalBytes: Buffer.byteLength(text), nextOffset: null });
      expect(reloaded.changes[0]).toStrictEqual(original);
      expect(() => fresh.read({ changes: [] }, projected.diffContent.contentId, 0)).toThrow();
      expect(() => fresh.read(reloaded, '0'.repeat(64), 0)).toThrow();
      expect(() => fresh.read(reloaded, projected.diffContent.contentId, Buffer.byteLength(text))).toThrow();
    }
    const empty = { path: '/repo/empty.md', kind: { type: 'add' }, diff: '' };
    expect(transport.project(empty)).toBe(empty);
    const text = { text: diff, diff, path: '/repo/user-text' };
    expect(transport.project(text)).toBe(text);
  });
  it('preserves unreadable images and carries portrait dimensions on attachments', () => {
    const transport = new ConversationContentTransport('thread');
    const portrait = Buffer.from('89504e470d0a1a0a0000000d49484452000002d000000500', 'hex');
    const url = 'data:image/png;base64,' + portrait.toString('base64');
    const projected = transport.project({ attachment: {kind:'image',url}, media:{url:'data:image/png;base64,Y29ycnVwdA=='} });
    expect(projected.attachment).toMatchObject({width:720,height:1280});
    expect(projected.media).not.toHaveProperty('width');
    expect(projected.media.url).toMatch(/^conversation-image:/);
    expect(Buffer.from(transport.read({media:{url:'data:image/png;base64,Y29ycnVwdA=='}}, projected.media.url.split(':')[2]!, 0).data, 'base64').toString()).toBe('data:image/png;base64,Y29ycnVwdA==');
  });
  it('keeps a screenshot-heavy reset and live updates small, and reads only requested current content', () => {
    const transport = new ConversationContentTransport('thread');
    const bytes = Buffer.alloc(600_000, 123);
    Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes);
    bytes.writeUInt32BE(1600, 16); bytes.writeUInt32BE(900, 20);
    const image = 'data:image/png;base64,' + bytes.toString('base64');
    const messages = Array.from({ length: 99 }, (_, index) => ({ id: String(index), parts: [{ type: 'media', media: { url: image } }] }));
    const snapshot = { messages };
    const beforeProjection = process.memoryUsage().arrayBuffers;
    const projected = transport.project(snapshot);
    expect(process.memoryUsage().arrayBuffers - beforeProjection).toBeLessThan(128 * 1024);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(32_000);
    const reference = projected.messages[0]!.parts[0]!.media.url;
    expect(reference).toMatch(/^conversation-image:thread:[a-f0-9]{64}$/);
    expect(projected.messages[0]!.parts[0]!.media).toMatchObject({width:1600,height:900});
    expect(transport.project({ payload: { message: messages[0] } }).payload.message).toStrictEqual(projected.messages[0]);
    expect(snapshot.messages[0]!.parts[0]!.media.url).toBe(image);
    const contentId = reference.split(':')[2]!;
    const chunks: Buffer[] = []; let offset = 0;
    for (;;) {
      const chunk = transport.read(snapshot, contentId, offset);
      chunks.push(Buffer.from(chunk.data, 'base64'));
      expect(chunk.totalBytes).toBe(Buffer.byteLength(image));
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
    expect(Buffer.concat(chunks).toString()).toBe(image);
    expect(transport.project(snapshot)).toBe(projected);
    expect(() => transport.read({ messages: [] }, contentId, 0)).toThrow();
    expect(() => transport.read(snapshot, '0'.repeat(64), 0)).toThrow();
    expect(() => transport.read(snapshot, contentId, -1)).toThrow();
    expect(() => transport.read(snapshot, contentId, 999_999_999)).toThrow();
    const plain = { messages: [{ text: image, url: 'https://example.com/image.png' }] };
    expect(transport.project(plain)).toBe(plain);
  });
});
