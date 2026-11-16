import { describe, expect, it } from 'vitest';
import type { ClaudeSdkMessage } from '../../../src/providers/claude/protocol';
import type { Session } from '../../../src';
import { harnessForHost } from '../../../src/internal';
import { ClaudeHost } from '../../../src/providers/claude/host';
import { ClaudeHistoryWindow } from '../../../src/providers/claude/history-window';
import type { Message } from '../../../src/contracts/index';

// A screenshot in a message stays an image the conversation can show. One too big to travel inline is named by a
// `conversation-image:<session>:<hash>` URL, as Codex names its images, and read by that hash in chunks that form its
// data URL. A frame stays bounded however large the image is.
const KiB = 1024;
/** A PNG header for an image of the given size, followed by filler: enough to be read as that image. */
const png = (width: number, height: number, length: number) => {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8); header.write('IHDR', 12); header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20); header[24] = 8; header[25] = 6;
  return Buffer.concat([header, Buffer.alloc(Math.max(0, length - header.length), 7)]);
};
const dataUrl = (raw: Buffer) => `data:image/png;base64,${raw.toString('base64')}`;
const message = (parts: Message['parts']): Message => ({ id: 'm-1', agentId: 'agent', role: 'user', status: 'complete', createdAt: '2026-11-16T00:00:00Z', parts });
const reference = /^conversation-image:session:([a-f0-9]{64})$/;
const readAll = async (read: (offset: number) => { data: string; nextOffset: number | null } | Promise<{ data: string; nextOffset: number | null }>) => {
  const chunks: Buffer[] = []; let offset: number | null = 0;
  while (offset !== null) { const chunk = await read(offset); chunks.push(Buffer.from(chunk.data, 'base64')); offset = chunk.nextOffset; }
  return Buffer.concat(chunks).toString('utf8');
};

describe('images in a message that is too big to travel whole', () => {
  it('keeps an attachment as an image, named by URL, and reads it as the data URL', async () => {
    const window = new ClaudeHistoryWindow('session');
    const url = dataUrl(png(1200, 800, 700 * KiB));
    const projected = window.project(message([{ type: 'text', text: 'Look' }, { type: 'attachment', attachment: { kind: 'image', name: 'screenshot.png', url } }]));
    const part = projected.parts[1];
    expect(part).toMatchObject({ type: 'attachment', attachment: { kind: 'image', name: 'screenshot.png', mimeType: 'image/png', width: 1200, height: 800 } });
    if (part?.type !== 'attachment') throw new Error('attachment expected');
    const contentId = reference.exec(part.attachment.url ?? '')?.[1];
    expect(contentId).toBeDefined();
    expect(JSON.stringify(projected).length).toBeLessThan(4 * KiB);
    expect(projected.deferredContent).toBeUndefined();
    expect(await readAll(offset => window.read({ sessionId: 'session', contentId: contentId!, offset }))).toBe(url);
  });

  it('keeps media as an image the same way', async () => {
    const window = new ClaudeHistoryWindow('session');
    const url = dataUrl(png(10, 20, 400 * KiB));
    const part = window.project(message([{ type: 'media', media: { url, alt: 'Chart' } }])).parts[0];
    expect(part).toMatchObject({ type: 'media', media: { alt: 'Chart', mimeType: 'image/png', width: 10, height: 20 } });
    if (part?.type !== 'media') throw new Error('media expected');
    const contentId = reference.exec(part.media.url)?.[1];
    expect(await readAll(offset => window.read({ sessionId: 'session', contentId: contentId!, offset }))).toBe(url);
  });

  it('leaves an image that fits as it is', () => {
    const window = new ClaudeHistoryWindow('session');
    const whole = message([{ type: 'attachment', attachment: { kind: 'image', name: 'small.png', url: dataUrl(png(4, 4, 10 * KiB)) } }]);
    expect(window.project(whole)).toBe(whole);
  });

  it('keeps every image of a message with several', () => {
    const window = new ClaudeHistoryWindow('session');
    const parts = Array.from({ length: 6 }, (_, index): Message['parts'][number] => ({ type: 'attachment', attachment: { kind: 'image', name: `shot-${index}.png`, url: dataUrl(png(8, 8, (300 + index) * KiB)) } }));
    const projected = window.project(message(parts));
    expect(projected.parts.map(part => part.type === 'attachment' && reference.test(part.attachment.url ?? ''))).toEqual(Array(6).fill(true));
    expect(JSON.stringify(projected).length).toBeLessThan(16 * KiB);
  });

  it('only gives the content to the session it belongs to', () => {
    const window = new ClaudeHistoryWindow('session');
    const part = window.project(message([{ type: 'attachment', attachment: { kind: 'image', name: 'a.png', url: dataUrl(png(8, 8, 700 * KiB)) } }])).parts[0];
    if (part?.type !== 'attachment') throw new Error('attachment expected');
    expect(() => window.read({ sessionId: 'another', contentId: reference.exec(part.attachment.url ?? '')![1]!, offset: 0 })).toThrow();
  });

  it('keeps the image readable while any message refers to it, and not after', () => {
    const window = new ClaudeHistoryWindow('session');
    const url = dataUrl(png(8, 8, 700 * KiB));
    const refer = (id: string) => { const part = window.project({ ...message([{ type: 'attachment', attachment: { kind: 'image', name: 'a.png', url }, }]), id }).parts[0]; if (part?.type !== 'attachment') throw new Error('attachment expected'); return reference.exec(part.attachment.url ?? '')![1]!; };
    const contentId = refer('m-1');
    expect(refer('m-2')).toBe(contentId);
    window.project({ ...message([{ type: 'text', text: 'replaced' }]), id: 'm-1' });
    expect(() => window.read({ sessionId: 'session', contentId, offset: 0 })).not.toThrow();
    window.project({ ...message([{ type: 'text', text: 'replaced' }]), id: 'm-2' });
    expect(() => window.read({ sessionId: 'session', contentId, offset: 0 })).toThrow();
  });
});

describe.each([['a new conversation', false], ['an established one', true]])('a screenshot sent in %s', (_name, established) => {
  it('shows as an image while the turn runs, and is read through the session', async () => {
    const data = { kind: 'claude' as const, conversationId: 'screenshots', transport: 'stdio' as const };
    let emit!: (message: ClaudeSdkMessage) => void;
    const host = new ClaudeHost({ startTurn: (_params, listener) => { emit = listener; return { done: new Promise(() => {}), interrupt: async () => {} }; }, close: async () => {} },
      async () => ({ providerSession: data, messages: [] }));
    const harness = harnessForHost('claude', host);
    const session: Session = established ? harness.restoreSession({ id: 'agent', folder: '/synthetic' }, { provider: 'claude', data, role: 'main' }) : harness.open({ id: 'agent', folder: '/synthetic' });
    const url = dataUrl(png(1000, 700, 600 * KiB));
    const shown = () => { const part = harness.readSession(session).messages.find(candidate => candidate.role === 'user')?.parts.find(candidate => candidate.type === 'attachment'); if (part?.type !== 'attachment') throw new Error('attachment expected'); return part.attachment; };
    try {
      const sent = harness.sendPrompt(session, 'Look', { attachments: [{ type: 'image', path: '/tmp/screenshot.png', previewUrl: url } as never] });
      await new Promise(resolve => setTimeout(resolve, 20));
      // A new conversation has no id to name the image by yet, so the image is shown as sent.
      if (established) expect(shown().url).toMatch(/^conversation-image:screenshots:/); else expect(shown().url).toBe(url);
      expect(harness.readSession(session).messages.some(candidate => candidate.parts.some(part => part.type === 'status'))).toBe(false);
      emit({ type: 'system', subtype: 'init', session_id: data.conversationId } as ClaudeSdkMessage);
      await sent;
      expect(shown()).toMatchObject({ kind: 'image', name: 'screenshot.png', width: 1000, height: 700 });
      const contentId = /^conversation-image:screenshots:([a-f0-9]{64})$/.exec(shown().url ?? '')?.[1];
      expect(contentId).toBeDefined();
      expect(await readAll(offset => harness.readConversationContent(session, { contentId: contentId!, offset }))).toBe(url);
    } finally { await harness.close(); }
  });
});

describe('a screenshot bigger than a row can hold, sent in a new conversation', () => {
  it('stays an image before the conversation has an id, and is read once it has', async () => {
    const data = { kind: 'claude' as const, conversationId: 'screenshots', transport: 'stdio' as const };
    let emit!: (message: ClaudeSdkMessage) => void;
    const host = new ClaudeHost({ startTurn: (_params, listener) => { emit = listener; return { done: new Promise(() => {}), interrupt: async () => {} }; }, close: async () => {} },
      async () => ({ providerSession: data, messages: [] }));
    const harness = harnessForHost('claude', host);
    const session = harness.open({ id: 'agent', folder: '/synthetic' });
    const url = dataUrl(png(3000, 2000, 5 * 1024 * KiB));
    const sentMessage = () => harness.readSession(session).messages.find(candidate => candidate.role === 'user');
    const attachment = () => { const part = sentMessage()?.parts.find(candidate => candidate.type === 'attachment'); if (part?.type !== 'attachment') throw new Error('attachment expected'); return part.attachment; };
    try {
      const sent = harness.sendPrompt(session, 'Look', { attachments: [{ type: 'image', path: '/tmp/screenshot.png', previewUrl: url } as never] });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(attachment()).toMatchObject({ kind: 'image', name: 'screenshot.png', width: 3000, height: 2000 });
      expect(attachment().url).toMatch(/^conversation-image:pending:[a-f0-9]{64}$/);
      expect(JSON.stringify(sentMessage()).length).toBeLessThan(16 * KiB);
      expect(sentMessage()?.deferredContent).toBeUndefined();
      emit({ type: 'system', subtype: 'init', session_id: data.conversationId } as ClaudeSdkMessage);
      await sent;
      const contentId = /^conversation-image:screenshots:([a-f0-9]{64})$/.exec(attachment().url ?? '')?.[1];
      expect(contentId).toBeDefined();
      expect(await readAll(offset => harness.readConversationContent(session, { contentId: contentId!, offset }))).toBe(url);
    } finally { await harness.close(); }
  });
});
