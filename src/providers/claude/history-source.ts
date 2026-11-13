import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { ClaudeConversationTurn, Message, ThreadGoal } from '../../contracts/index';
import type { ProviderEvent } from '../../driver';
import type { ClaudeTaskPlan } from './claude-task-plan';

export type ClaudeHistoryState = { taskPlan?: ClaudeTaskPlan; goal?: ThreadGoal | null; subagentEvents?: ProviderEvent[] };

export type ClaudeHistorySource = {
  readAll(): Promise<Message[]>;
  isCurrent(): Promise<boolean>;
  loadEarlier?(): Promise<ClaudeHistoryState & { messages: Message[]; turns: ClaudeConversationTurn[]; source: ClaudeHistorySource }>;
};

type IndexedRange = { start: number; end: number; hash: string };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Ephemeral index of one native transcript snapshot. No provider data is copied to disk. */
export async function createClaudeHistorySource(
  file: string,
  content: string,
  decode: (content: string) => Message[],
  snapshot?: { offset: number; version: Stats },
): Promise<ClaudeHistorySource> {
  const version = snapshot?.version ?? await stat(file);
  const offset = snapshot?.offset ?? 0;
  const bytes = Buffer.from(content);
  const whole: IndexedRange = { start: offset, end: offset + bytes.length, hash: hash(bytes) };

  const read = async (range: IndexedRange): Promise<Message[]> => {
    const handle = await open(file, 'r').catch(() => null);
    if (!handle) throw new Error('Claude history is unavailable. Restore it or reload the conversation.');
    try {
      const current = await handle.stat();
      if (current.ino !== version.ino || current.dev !== version.dev || current.size < range.end) throw new Error('changed');
      const result = Buffer.allocUnsafe(range.end - range.start);
      let offset = 0;
      while (offset < result.length) {
        const { bytesRead } = await handle.read(result, offset, result.length - offset, range.start + offset);
        if (!bytesRead) throw new Error('changed');
        offset += bytesRead;
      }
      // Appends leave indexed turns valid; truncation, replacement and in-place rewrites do not.
      if (hash(result) !== range.hash) throw new Error('changed');
      return decode(result.toString('utf8'));
    } catch {
      throw new Error('Claude history changed. Reload the conversation before loading older messages.');
    } finally { await handle.close(); }
  };

  return {
    readAll: () => read(whole),
    async isCurrent() {
      const current = await stat(file).catch(() => null);
      return current !== null && current.ino === version.ino && current.dev === version.dev
        && current.size === whole.end && current.mtimeMs === version.mtimeMs;
    },
  };
}
