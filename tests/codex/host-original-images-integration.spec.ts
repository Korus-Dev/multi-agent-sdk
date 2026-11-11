import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, open, truncate, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexConversationReplica } from '../../src/core/codex-engine';
import { CodexAppServerClient } from '@korus-dev/codex-sdk';
import { CodexHost, ConversationContentTransport } from '../../src/providers/codex';
import { generatedPngBase64, MockCodexAppServer, resumeResponse, thread, turn } from './helpers/host-fixture';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const image = (byte: number) => 'data:image/png;base64,' + Buffer.concat([Buffer.from(generatedPngBase64, 'base64'), Buffer.alloc(80_000, byte)]).toString('base64');
const records = (id: string, images: string[]) => [
  { type: 'session_meta', payload: { id } },
  ...images.flatMap((url, index) => [
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: `call-${index}`, internal_chat_message_metadata_passthrough: { turn_id: 'turn-images' } } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: `call-${index}`, internal_chat_message_metadata_passthrough: { turn_id: 'turn-images' }, output: [{ type: 'input_image', image_url: url }] } },
  ]),
].map(record => JSON.stringify(record)).join('\n') + '\n';

it('reads operation-owned originals after temporary files change or disappear, without changing legacy reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-original-images-')); directories.push(directory);
  const rollout = join(directory, 'rollout.jsonl'), temporary = join(directory, 'failure.png');
  const originals = [image(1), image(2)];
  await writeFile(rollout, records('thread-existing', originals));
  await writeFile(temporary, Buffer.from(image(3).split(',')[1]!, 'base64'));
  const restored = { ...thread('thread-existing', false), path: rollout, turns: [turn('turn-images', 'completed', [
    { type: 'imageView' as const, id: 'exec-first-view', path: temporary },
    { type: 'imageView' as const, id: 'exec-second-view', path: temporary },
  ])] };
  const transport = new MockCodexAppServer({ 'thread/resume': () => resumeResponse(restored), 'thread/turns/list': () => ({ data: restored.turns, nextCursor: null, backwardsCursor: null }) });
  const file = await open(rollout, 'r');
  const prototype = Object.getPrototypeOf(file), originalRead = prototype.read;
  let activeReads = 0, peakReads = 0;
  const reads = vi.spyOn(prototype, 'read').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    peakReads = Math.max(peakReads, ++activeReads);
    try { return await Reflect.apply(originalRead, this, args); } finally { activeReads--; }
  });
  await file.close();
  const host = new CodexHost({ client: new CodexAppServerClient(transport), originalHistoryImages: true });
  try {
    await host.connect();
    const handle = host.conversation('thread-existing');
    const snapshot = handle.getSnapshot();
    const replica = createCodexConversationReplica(snapshot);
    const media = snapshot.messages.flatMap(m => m.parts).filter(p => p.type === 'media');
    expect(media).toHaveLength(2);
    expect(media.map(p => p.itemId)).toEqual(['original-image:call-0:0', 'original-image:call-1:0']);
    expect(media.every(p => p.media.url.startsWith('conversation-image:thread-existing:'))).toBe(true);
    expect(media.map(p => p.phase)).toEqual(['commentary', 'commentary']);
    expect(JSON.stringify(snapshot)).not.toContain(originals[0]);
    expect(snapshot.messages.flatMap(m => m.parts).filter(p => p.type === 'tool').map(p => p.input)).toEqual([{ path: temporary }, { path: temporary }]);
    const ids = media.map(part => part.media.url.split(':')[2]!);
    await appendFile(rollout, '\n'); reads.mockClear(); // A cold batch should build one index.
    const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => handle.readContent(ids[i % 2]!, 0)));
    expect(concurrent.map(chunk => Buffer.from(chunk.data, 'base64').toString())).toEqual(Array.from({ length: 8 }, (_, i) => originals[i % 2]!.slice(0, 64 * 1024)));
    expect(peakReads).toBe(1);
    expect(reads.mock.calls.filter(args => args[3] === 0).length).toBeLessThanOrEqual(4);
    await handle.readContent(ids[0]!, 0); await handle.readContent(ids[1]!, 0);
    const beforeInterleave = reads.mock.calls.length;
    await Promise.all(ids.map(id => handle.readContent(id, 64 * 1024)));
    expect(reads.mock.calls.length).toBe(beforeInterleave);
    const read = async (index: number) => {
      const id = media[index]!.media.url.split(':')[2]!; let offset = 0, text = '';
      for (;;) {
        const chunk = await handle.readContent(id, offset); const bytes = Buffer.from(chunk.data, 'base64');
        expect(bytes.length).toBeLessThanOrEqual(64 * 1024); text += bytes.toString();
        if (chunk.nextOffset === null) break; offset = chunk.nextOffset;
      }
      return text;
    };
    expect(await read(0)).toBe(originals[0]); // Never read the overwritten failure.png.
    await rm(temporary);
    expect(await read(1)).toBe(originals[1]);
    host.onConversationEvent('thread-existing', event => replica.apply(event));
    await handle.load({ cwd: directory });
    expect(replica.getSnapshot().messages).toEqual(handle.getSnapshot().messages);
    expect(handle.getSnapshot().messages.flatMap(m => m.parts).filter(p => p.type === 'media')).toEqual(media);
    await expect(handle.readContent(media[0]!.media.url.split(':')[2]!, -1)).rejects.toThrow();
    await expect(handle.readContent('0'.repeat(64), 0)).rejects.toThrow();
    await expect(handle.readContent(media[0]!.media.url.split(':')[2]!, Number.MAX_SAFE_INTEGER)).rejects.toThrow();
    await expect(host.conversation('foreign').readContent(media[0]!.media.url.split(':')[2]!, 0)).rejects.toThrow();
    const pending = handle.readContent(media[0]!.media.url.split(':')[2]!, 0);
    host.forgetConversation('thread-existing');
    await expect(pending).rejects.toThrow();
    await handle.load();
    await writeFile(rollout, records('wrong-thread', originals));
    await expect(read(0)).rejects.toThrow();
    expect(reads.mock.calls.every(args => typeof args[2] === 'number' && args[2] <= 64 * 1024)).toBe(true);
    // Existing inline content and synchronous readers retain the old chunk shape.
    const inline = { media: { url: originals[0]! } }, legacy = new ConversationContentTransport('thread-existing');
    const ref = legacy.project(inline).media.url.split(':')[2]!;
    expect(Buffer.from(legacy.read(inline, ref, 0).data, 'base64').toString()).toBe(originals[0]!.slice(0, 64 * 1024));
  } finally { await host.close(); }
});

it('bounds original-history scans and skips malformed, orphaned, and foreign-turn outputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-original-bounds-')); directories.push(directory);
  const path = join(directory, 'rollout.jsonl');
  const valid = records('thread-existing', [image(1)]).trimEnd().split('\n');
  const output = JSON.parse(valid[2]!);
  const orphan = { ...output, payload: { ...output.payload, call_id: 'orphan' } };
  const foreign = { ...output, payload: { ...output.payload, internal_chat_message_metadata_passthrough: { turn_id: 'foreign-turn' } } };
  const oversized = { ...output, payload: { ...output.payload, output: [{ type: 'input_image', image_url: image(2) }] }, padding: 'x'.repeat(32 * 1024 * 1024) };
  await writeFile(path, [valid[0], '{broken', JSON.stringify(orphan), valid[1], JSON.stringify(foreign), JSON.stringify(oversized), valid[2], 'partial record'].join('\n'));
  const restored = { ...thread('thread-existing', false), path, turns: [turn('turn-images', 'completed', [{ type: 'imageView' as const, id: 'view', path: '/deleted/failure.png' }])] };
  const transport = new MockCodexAppServer({ 'thread/resume': () => resumeResponse(restored) });
  const host = new CodexHost({ client: new CodexAppServerClient(transport), originalHistoryImages: true });
  try {
    await host.connect();
    const media = () => host.getSnapshot().messages.flatMap(m => m.parts).filter(p => p.type === 'media');
    expect(media()).toHaveLength(1);
    expect(media()[0]?.itemId).toBe('original-image:call-0:0');
    const chunk = await host.conversation('thread-existing').readContent(media()[0]!.media.url.split(':')[2]!, 0);
    expect(Buffer.from(chunk.data, 'base64').toString()).toBe(image(1).slice(0, 64 * 1024));
    await truncate(path, 256 * 1024 * 1024 + 1);
    // A large rollout still has recoverable images beyond an oversized record.
    const later = records('thread-existing', [image(2)]).trimEnd().split('\n').slice(1).map(line => line.replaceAll('call-0', 'call-late')).join('\n');
    await appendFile(path, '\n' + later + '\n');
    await host.conversation('thread-existing').load({ cwd: directory });
    expect(media()).toHaveLength(2);
    const late = media().find(part => part.itemId === 'original-image:call-late:0')!;
    const lateChunk = await host.conversation('thread-existing').readContent(late.media.url.split(':')[2]!, 0);
    expect(Buffer.from(lateChunk.data, 'base64').toString()).toBe(image(2).slice(0, 64 * 1024));
    expect(host.getSnapshot().messages.flatMap(m => m.parts)).toContainEqual(expect.objectContaining({ type: 'tool', id: 'view' }));
  } finally { await host.close(); }
});

it('publishes summary answers and expanded text before original-image indexing completes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-summary-images-')); directories.push(directory);
  const path = join(directory, 'rollout.jsonl'); await writeFile(path, records('thread-existing', [image(1)]));
  const probe = await open(path, 'r'); const prototype = Object.getPrototypeOf(probe), originalRead = prototype.read; await probe.close();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const reads = vi.spyOn(prototype, 'read').mockImplementationOnce(async function (this: unknown, ...args: unknown[]) { await gate; return Reflect.apply(originalRead, this, args); });
  const summary = { ...turn('turn-images', 'completed', [{ type: 'agentMessage' as const, id: 'final', text: 'Summary answer', phase: 'final_answer' as const, memoryCitation: null, delivery: null, questions: null }]), itemsView: 'summary' as const };
  const transport = new MockCodexAppServer({ 'thread/resume': () => resumeResponse({ ...thread('thread-existing', false), path, turns: [summary] }),
    'thread/items/list': () => ({ data: summary.items.map(item => ({ turnId: summary.id, item, startedAtMs: null, completedAtMs: null })), nextCursor: null, backwardsCursor: null }),
  });
  const host = new CodexHost({ client: new CodexAppServerClient(transport), originalHistoryImages: true, historyItemsView: 'summary' });
  try {
    let ready = false; const connecting = host.connect().then(() => { ready = true; });
    await vi.waitFor(() => expect(ready).toBe(true)); await connecting;
    expect(reads).not.toHaveBeenCalled();
    expect(host.getSnapshot().messages.flatMap(m => m.parts)).toEqual([{ type: 'text', text: 'Summary answer', phase: 'final_answer', itemId: 'final' }]);
    await host.conversation('thread-existing').loadTurnHistory(summary.id);
    await vi.waitFor(() => expect(reads).toHaveBeenCalled());
    expect(host.getSnapshot().messages.flatMap(m => m.parts).filter(p => p.type === 'media')).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(host.getSnapshot().messages.flatMap(m => m.parts).filter(p => p.type === 'media')).toHaveLength(1));
    expect(host.getSnapshot().turns[0]?.itemsView).toBe('full');
  } finally { release(); await host.close(); }
});
