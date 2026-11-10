import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { CodexAppServerClient } from '@korus-dev/codex-sdk';
import type { TokenUsage } from '../../core/codex-host';
import { validCounts } from './host-usage-controller';

export type CodexHistoricalExecutionUsage = {
  turnId: string;
  recordedAt: string;
  execution: TokenUsage;
  total: TokenUsage;
  last: TokenUsage;
  status?: 'completed' | 'interrupted';
};
type Index = { identity: string; size: number; mtimeMs: number; offset: number;
  turns: Map<string, CodexHistoricalExecutionUsage>; statuses: Map<string, 'completed' | 'interrupted'> };
const MAX_RECORD = 1024 * 1024;

/** Numeric-only, read-only index of native 0.163/0.164 per-turn replacement counters.
 * File identity and ownership are checked before append reuse; no transcript is retained. */
export class CodexOriginalHistoryUsage {
  private readonly indexes = new Map<string, Index>();
  private work: Promise<unknown> = Promise.resolve();
  private readonly paths = new Map<string, string>();
  constructor(private readonly client?: CodexAppServerClient) {}
  clear(): void { this.indexes.clear(); this.paths.clear(); }
  forget(conversationId: string): void { this.paths.delete(conversationId); }

  async read(conversationId: string): Promise<readonly CodexHistoricalExecutionUsage[]> {
    if (!this.client) throw new Error('A provider client is required.');
    let filePath = this.paths.get(conversationId);
    if (!filePath) {
      const { thread } = await this.client.request('thread/read', { threadId: conversationId, includeTurns: false });
      if (thread.id !== conversationId || !thread.path) throw new Error('Original usage is unavailable.');
      filePath = thread.path;
      this.paths.set(conversationId, filePath);
    }
    return this.readFile(conversationId, filePath);
  }

  readFile(conversationId: string, filePath: string): Promise<readonly CodexHistoricalExecutionUsage[]> {
    const next = this.work.then(() => this.scan(conversationId, filePath));
    this.work = next.catch(() => undefined);
    return next;
  }

  private async scan(conversationId: string, filePath: string): Promise<readonly CodexHistoricalExecutionUsage[]> {
    if (!isAbsolute(filePath)) throw new Error('Original usage requires an absolute provider path.');
    const file = await open(filePath, 'r');
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 2 * 1024 ** 3) throw new Error('Original usage is unavailable.');
      const header = Buffer.alloc(64 * 1024);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      const first = JSON.parse(header.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]!);
      if (first?.type !== 'session_meta' || first.payload?.id !== conversationId) throw new Error('Original usage belongs to a different conversation.');
      const key = `${conversationId}\0${filePath}`;
      const identity = `${metadata.dev}:${metadata.ino}`;
      let index = this.indexes.get(key);
      if (!index || index.identity !== identity || metadata.size < index.size || (metadata.size === index.size && metadata.mtimeMs !== index.mtimeMs)) {
        index = { identity, size: 0, mtimeMs: 0, offset: 0, turns: new Map(), statuses: new Map() };
      }
      if (metadata.size !== index.size || metadata.mtimeMs !== index.mtimeMs) {
        let at = index.offset;
        let pending = Buffer.alloc(0);
        let skipped = false;
        const buffer = Buffer.alloc(64 * 1024);
        while (at < metadata.size) {
          const { bytesRead: count } = await file.read(buffer, 0, Math.min(buffer.length, metadata.size - at), at);
          if (!count) break;
          let start = 0;
          for (let i = 0; i < count; i++) {
            if (buffer[i] !== 10) continue;
            const fragment = buffer.subarray(start, i);
            if (!skipped && pending.length + fragment.length <= MAX_RECORD) {
              this.record(index, conversationId, Buffer.concat([pending, fragment]).toString('utf8'));
            }
            pending = Buffer.alloc(0); skipped = false; start = i + 1; index.offset = at + start;
          }
          const tail = buffer.subarray(start, count);
          if (pending.length + tail.length > MAX_RECORD) { skipped = true; pending = Buffer.alloc(0); }
          else if (!skipped) pending = Buffer.concat([pending, tail]);
          at += count;
        }
        index.size = metadata.size; index.mtimeMs = metadata.mtimeMs;
      }
      this.indexes.delete(key); this.indexes.set(key, index);
      while (this.indexes.size > 8) this.indexes.delete(this.indexes.keys().next().value!);
      return structuredClone([...index.turns.values()].map(value => ({ ...value,
        ...(index.statuses.has(value.turnId) ? { status: index.statuses.get(value.turnId)! } : {}) })));
    } finally { await file.close(); }
  }

  private record(index: Index, conversationId: string, line: string): void {
    if (!line.includes('token_usage_record') && !line.includes('task_complete') && !line.includes('turn_aborted')) return;
    let value: any;
    try { value = JSON.parse(line); } catch { return; }
    const record = value.payload;
    if (value?.type === 'event_msg' && typeof record?.turn_id === 'string'
      && (record.type === 'task_complete' || record.type === 'turn_aborted')) {
      index.statuses.set(record.turn_id, record.type === 'task_complete' ? 'completed' : 'interrupted');
      if (index.statuses.size > 50_000) index.statuses.delete(index.statuses.keys().next().value!);
      return;
    }
    if (value?.type !== 'token_usage_record') return;
    if (record?.thread_id !== conversationId || typeof record.turn_id !== 'string' || !record.turn_id || record.turn_id.length > 256) return;
    if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) return;
    const execution = nativeCounts(record.turn_token_usage);
    const total = nativeCounts(record.thread_token_usage);
    const last = nativeCounts(record.usage);
    if (!execution || !total || !last) return;
    index.turns.set(record.turn_id, { turnId: record.turn_id, recordedAt: value.timestamp, execution, total, last });
    if (index.turns.size > 50_000) index.turns.delete(index.turns.keys().next().value!);
  }
}

function nativeCounts(value: any): TokenUsage | undefined {
  if (!value || typeof value !== 'object') return;
  const result = { totalTokens: value.total_tokens, inputTokens: value.input_tokens, cachedInputTokens: value.cached_input_tokens,
    cacheWriteInputTokens: value.cache_write_input_tokens ?? null, outputTokens: value.output_tokens, reasoningOutputTokens: value.reasoning_output_tokens };
  return validCounts(result) ? result : undefined;
}
