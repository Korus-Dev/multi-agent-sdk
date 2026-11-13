import type { Stats } from 'node:fs';
import { open } from 'node:fs/promises';

export type ClaudeTranscriptSlice = { content: string; offset: number; version: Stats };

const MiB = 1024 * 1024;
/** Window sizes a recent read tries from the end of a transcript, smallest first. The last one is the most it reads. */
export const claudeRecentWindows: readonly number[] = [1 * MiB, 5 * MiB, 50 * MiB];

/**
 * The last `window` bytes of a transcript, from the start of a line: `offset` is where the slice begins in the file, and
 * a transcript shorter than the window is returned whole. A line cut by the window is left out.
 */
export async function readClaudeTranscriptWindow(file: string, window: number): Promise<ClaudeTranscriptSlice> {
  const handle = await open(file, 'r');
  try {
    const version = await handle.stat();
    const start = Math.max(0, version.size - window);
    let bytes = await readBytes(handle, start, version.size - start);
    let offset = start;
    if (start > 0) {
      const newline = bytes.indexOf(10);
      if (newline < 0) return { content: '', offset: version.size, version };
      bytes = bytes.subarray(newline + 1);
      offset = start + newline + 1;
    }
    return { content: bytes.toString('utf8'), offset, version };
  } finally { await handle.close(); }
}

/**
 * The slice widened to the last `window` bytes of the snapshot it was read from (all of it for `Infinity`), even if the
 * live query has appended more turns since. The bytes of the original slice must be unchanged.
 */
export async function widenClaudeTranscriptSlice(file: string, slice: ClaudeTranscriptSlice, window: number): Promise<ClaudeTranscriptSlice> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) throw new Error('Claude history is unavailable. Restore it or reload the conversation.');
  try {
    const current = await handle.stat();
    if (current.ino !== slice.version.ino || current.dev !== slice.version.dev || current.size < slice.version.size
      || current.size === slice.version.size && current.mtimeMs !== slice.version.mtimeMs) throw new Error('changed');
    const end = slice.version.size;
    const start = Math.max(0, end - window);
    if (start >= slice.offset) return slice;
    let bytes = await readBytes(handle, start, end - start);
    if (bytes.subarray(slice.offset - start).toString('utf8') !== slice.content) throw new Error('changed');
    let offset = start;
    if (start > 0) {
      const newline = bytes.indexOf(10);
      if (newline < 0 || start + newline + 1 > slice.offset) throw new Error('changed');
      bytes = bytes.subarray(newline + 1);
      offset = start + newline + 1;
    }
    return { content: bytes.toString('utf8'), offset, version: slice.version };
  } catch {
    throw new Error('Claude history changed. Reload the conversation before loading older messages.');
  } finally { await handle.close(); }
}

async function readBytes(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset);
    if (!bytesRead) throw new Error('Claude history changed while reading. Reload the conversation.');
    offset += bytesRead;
  }
  return bytes;
}
