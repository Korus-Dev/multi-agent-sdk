import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createHarness } from '../../../src';

const varint = (value: number): number[] => value < 128 ? [value] : [128 + value % 128, ...varint(Math.floor(value / 128))];
const field = (id: number, value: number | string | Uint8Array): Buffer => {
  if (typeof value === 'number') return Buffer.from([...varint(id * 8), ...varint(value)]);
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([...varint(id * 8 + 2), ...varint(bytes.length)]), bytes]);
};

it('reads numeric usage for a parent and nested workers without starting ACP', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'antigravity-usage-'));
  const root = '00000000-0000-4000-8000-000000000001';
  const child = '00000000-0000-4000-8000-000000000002';
  const grandchild = '00000000-0000-4000-8000-000000000003';
  const executionId = '00000000-0000-4000-8000-000000000004';
  const at = 1795457201000;
  const harness = createHarness('antigravity', { client: { name: 'usage' }, home, antigravity: { command: path.join(home, 'nonexistent') } });
  try {
    const cli = path.join(home, 'antigravity-cli');
    await mkdir(path.join(cli, 'conversations'), { recursive: true });
    const summary = new DatabaseSync(path.join(cli, 'conversation_summaries.db'));
    summary.exec('CREATE TABLE conversation_summaries (conversation_id TEXT, parent_conversation_id TEXT)');
    summary.prepare('INSERT INTO conversation_summaries VALUES (?, ?), (?, ?)').run(child, root, grandchild, child);
    summary.close();
    for (const [sessionId, offset] of [[root, 0], [child, 1], [grandchild, 2]] as const) {
      const file = new DatabaseSync(path.join(cli, 'conversations', `${sessionId}.db`));
      const timestamp = field(1, Buffer.concat([field(1, at / 1000), field(2, offset * 1_000_000)]));
      const execution = Buffer.concat([timestamp, field(12, executionId)]);
      const stats = field(9, Buffer.concat([field(2, 10 + offset), field(3, 6), field(5, 22), field(7, `response-${offset}`), field(9, 4)]));
      file.exec('CREATE TABLE trajectory_meta (cascade_id TEXT); CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, metadata BLOB)');
      file.prepare('INSERT INTO trajectory_meta VALUES (?)').run(sessionId);
      const insert = file.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)');
      insert.run(0, offset === 0 ? 14 : 101, 3, execution);
      const generation = Buffer.concat([execution, stats]);
      insert.run(1, 15, 3, generation);
      insert.run(2, 15, 3, generation); // The same provider response can appear twice.
      insert.run(3, 15, 8, Buffer.concat([execution, field(9, field(2, 400))]));
      file.close();
    }
    expect(await harness.readConversationUsage(root)).toEqual([root, child, grandchild].map((sessionId, offset) => ({
      sessionId, executionId, startedAt: at + offset, prompted: offset === 0,
      tokens: { input: 32 + offset, output: 6, total: 38 + offset, cacheRead: 22, cacheWrite: 0, reasoning: 4 },
    })));
    const running = new DatabaseSync(path.join(cli, 'conversations', `${child}.db`));
    try {
      running.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
      const metadata = Buffer.concat([field(1, field(1, at / 1000 + 1)), field(12, executionId),
        field(9, Buffer.concat([field(2, 40), field(3, 10), field(7, 'later-response')]))]);
      running.prepare('INSERT INTO steps VALUES (4,15,3,?)').run(metadata);
      expect((await harness.readConversationUsage(root)).find(row => row.sessionId === child)?.tokens.total).toBe(89);
    } finally { running.close(); }
    expect(await harness.readConversationUsage('../foreign')).toEqual([]);
  } finally { await harness.close(); await rm(home, { recursive: true, force: true }); }
});
