import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '@korus-dev/codex-sdk/protocol';
import { CodexSurface, CodexOriginalHistoryUsage } from '../../src/providers/codex';
import { MockCodexAppServer, resumeResponse, thread, turn } from './helpers/codex-surface-fixture';

const counts = (input: number, output: number) => ({ input_tokens: input, cached_input_tokens: 20,
  cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const packet = (input: number, output: number) => ({ inputTokens: input, cachedInputTokens: 20,
  cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + output });
const record = (execution = counts(40, 20), total = counts(100, 60)) => JSON.stringify({ type: 'token_usage_record',
  timestamp: '2026-11-01T12:00:01Z', payload: { thread_id: 'thread-existing', turn_id: 'turn-live',
    usage: counts(20, 5), turn_token_usage: execution, thread_token_usage: total } }) + '\n';

it('recovers the first execution after resume, includes compaction charges and replaces repeated samples', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'native-usage-'));
  const file = path.join(dir, 'rollout.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'thread-existing', cli_version: '0.164.0' } }) + '\n');
  let started = 0;
  const transport = new MockCodexAppServer({
    'thread/read': () => ({ thread: { ...thread('thread-existing', false), path: file }, readState: null }),
    'turn/start': () => ({ turn: turn(++started === 1 ? 'turn-live' : 'turn-second', 'inProgress', []) }),
    'thread/resume': () => resumeResponse(thread('thread-existing', false)),
  });
  const surface = new CodexSurface({ client: new CodexAppServerClient(transport), originalHistoryUsage: true });
  const recovered: Array<number | null | undefined> = [];
  surface.onEvent(event => {
    if (event.type === 'conversation.executionUsageChanged' && event.origin === 'action') recovered.push(event.payload.usage.execution?.totalTokens);
  });
  try {
    await surface.connect();
    await surface.selectConversation('thread-existing');
    await surface.sendMessage('Synthetic prompt');
    await appendFile(file, record().replaceAll('"cache_write_input_tokens":0,', ''));
    const usage = (total = packet(100, 60)) => transport.emitNotification('thread/tokenUsage/updated', {
      threadId: 'thread-existing', turnId: 'turn-live', tokenUsage: { total, last: packet(20, 5), modelContextWindow: 2000 },
    });
    usage();
    await vi.waitFor(() => expect(surface.getSnapshot().turns.find(t => t.id === 'turn-live')?.executionUsage?.execution?.totalTokens).toBe(60));
    recovered.length = 0;
    usage(packet(115, 65));
    await vi.waitFor(() => expect(recovered.length).toBeGreaterThan(0));
    expect(recovered.at(-1)).toBe(80); // A delayed history flush must not roll live counters back.
    // Native per-turn usage contains a compaction request omitted from public thread counters.
    await appendFile(file, record(counts(60, 25), counts(130, 70)));
    usage(packet(115, 65));
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-live', 'completed', []) });
    await vi.waitFor(() => expect(surface.getSnapshot().turns.find(t => t.id === 'turn-live')?.executionUsage?.execution?.totalTokens).toBe(85));
    usage(packet(115, 65));
    await vi.waitFor(() => expect(surface.getSnapshot().turns.find(t => t.id === 'turn-live')?.executionUsage?.execution?.totalTokens).toBe(85));
    // Legacy live packets can omit cache writes too; never fill that unknown
    // counter from a previous known zero when extending native evidence.
    const legacy = { ...packet(130, 70) } as Partial<ReturnType<typeof packet>>;
    delete legacy.cacheWriteInputTokens;
    recovered.length = 0;
    transport.emitRaw({ method: 'thread/tokenUsage/updated', params: {
      threadId: 'thread-existing', turnId: 'turn-live', tokenUsage: { total: legacy, last: legacy, modelContextWindow: 2000 },
    } });
    await vi.waitFor(() => expect(recovered.length).toBeGreaterThan(0));
    expect(surface.getSnapshot().turns.find(t => t.id === 'turn-live')?.executionUsage?.execution?.cacheWriteInputTokens).toBeNull();
    // A replay after reload is not a new observed execution. The next terminal
    // turn can still recover when its live usage packet was never delivered.
    await surface.selectConversation('thread-existing');
    usage(packet(130, 70));
    await surface.sendMessage('Synthetic second prompt');
    await appendFile(file, record(counts(60, 25), counts(190, 95)).replaceAll('turn-live', 'turn-second'));
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-second', 'completed', []) });
    await vi.waitFor(() => expect(surface.getSnapshot().turns.find(t => t.id === 'turn-second')?.executionUsage?.execution?.totalTokens).toBe(85));
  } finally { await surface.close(); await rm(dir, { recursive: true, force: true }); }
});

it('validates file ownership and numeric evidence, handles partial appends and invalidates replaced files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'native-usage-files-'));
  const file = path.join(dir, 'rollout.jsonl');
  const reader = new CodexOriginalHistoryUsage();
  const header = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n';
  try {
    await expect(reader.read('thread-existing')).rejects.toThrow('provider client');
    for (const id of ['another-thread', 'thread-existing']) {
      const client = new CodexAppServerClient(new MockCodexAppServer({
        'thread/read': () => ({ thread: { ...thread(id, false), path: null }, readState: null }),
      }));
      await client.start();
      try { await expect(new CodexOriginalHistoryUsage(client).read('thread-existing')).rejects.toThrow('unavailable'); }
      finally { await client.close(); }
    }
    await expect(reader.readFile('thread-existing', dir)).rejects.toThrow('unavailable');
    await writeFile(file, header('another-thread') + record());
    await expect(reader.readFile('thread-existing', file)).rejects.toThrow('different conversation');
    await expect(reader.readFile('thread-existing', 'relative.jsonl')).rejects.toThrow('absolute');
    const line = record();
    const invalid = [
      '{"type":"token_usage_record", broken}\n',
      JSON.stringify({ type: 'unsupported', payload: 'token_usage_record' }) + '\n',
      line.replace('"turn_id":"turn-live"', '"turn_id":""'),
      line.replace('2026-11-01T12:00:01Z', 'invalid-time'),
      line.replace('"timestamp":"2026-11-01T12:00:01Z",', ''),
      line.replace('"turn_id":"turn-live"', `"turn_id":"${'x'.repeat(300)}"`),
      line.replace('"turn_token_usage":{', '"turn_token_usage":42,"ignored":{'),
      line.replace('"turn_token_usage":{', '"turn_token_usage":null,"ignored":{'),
      line.replace('"thread_token_usage":{', '"thread_token_usage":null,"ignored":{'),
      line.replace('"usage":{', '"usage":null,"ignored":{'),
    ].join('');
    await writeFile(file, header('thread-existing') + JSON.stringify({ type: 'response_item', payload: 'x'.repeat(1100000) }) + '\n' + invalid
      + record().replace('"thread_id":"thread-existing"', '"thread_id":"another-thread"')
      + record(counts(-1, 20)) + line.slice(0, -12));
    expect(await reader.readFile('thread-existing', file)).toStrictEqual([]);
    await appendFile(file, line.slice(-12));
    const recovered = await reader.readFile('thread-existing', file);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.execution.totalTokens).toBe(60);
    recovered[0]!.execution.totalTokens = 999;
    expect((await reader.readFile('thread-existing', file))[0]?.execution.totalTokens).toBe(60);
    await appendFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-live' } }) + '\n');
    expect((await reader.readFile('thread-existing', file))[0]?.status).toBe('interrupted');
    await appendFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-live' } }) + '\n');
    expect((await reader.readFile('thread-existing', file))[0]?.status).toBe('completed');
    const replacement = path.join(dir, 'replacement.jsonl');
    await writeFile(replacement, header('thread-existing') + record(counts(50, 25)));
    await rename(replacement, file);
    expect((await reader.readFile('thread-existing', file))[0]).toMatchObject({ execution: { totalTokens: 75 } });
    await writeFile(file, header('thread-existing'));
    expect(await reader.readFile('thread-existing', file)).toStrictEqual([]);
    // Older native packets omit cache-write evidence; it stays unknown rather than zero.
    await appendFile(file, record().replaceAll('"cache_write_input_tokens":0,', ''));
    expect((await reader.readFile('thread-existing', file))[0]?.execution.cacheWriteInputTokens).toBeNull();
    reader.clear();
    expect((await reader.readFile('thread-existing', file))[0]?.execution.totalTokens).toBe(60);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('retains public usage when optional native history is unavailable, without interrupting the turn', async () => {
  const failures = vi.fn();
  const historyRead = vi.fn(() => { throw new Error('Native history is unavailable'); });
  const transport = new MockCodexAppServer({
    'thread/read': historyRead,
    'thread/resume': () => resumeResponse(thread('thread-existing', false)),
    'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
  });
  const surface = new CodexSurface({ client: new CodexAppServerClient(transport), originalHistoryUsage: true, onListenerError: failures });
  const usage = (turnId: string, input: number, output: number) => transport.emitNotification('thread/tokenUsage/updated', {
    threadId: 'thread-existing', turnId, tokenUsage: { total: packet(input, output), last: packet(20, 5), modelContextWindow: 2000 },
  });
  try {
    await surface.connect(); await surface.selectConversation('thread-existing');
    usage('turn-history', 60, 40);
    await surface.sendMessage('Synthetic prompt');
    usage('turn-live', 100, 60);
    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-live', 'completed', []) });
    await vi.waitFor(() => expect(historyRead).toHaveBeenCalled());
    expect(surface.getSnapshot().turns.find(t => t.id === 'turn-live')).toMatchObject({ status: 'completed', executionUsage: { execution: { totalTokens: 60 } } });
    expect(failures).not.toHaveBeenCalled();
  } finally { await surface.close(); }
});
