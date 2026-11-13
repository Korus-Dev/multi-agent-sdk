import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent } from '../../../src/contracts/index';
import { loadClaudeTranscriptHistory } from '../../../src/providers/claude/transcript-history-adapter';

// A conversation opens from the end of its transcript: the last window of the file is read, and the window widens only
// when it holds too few messages. What the window holds is the same as the end of a read of the whole file.
const session = { kind: 'claude' as const, conversationId: 'recent-session', transport: 'stdio' as const };
const agent: Agent = { id: 'recent-agent', name: 'Recent', folder: '/synthetic', provider: 'claude', providerSession: session };
const KiB = 1024;
const row = (value: object) => JSON.stringify(value);
// One prompt, a tool call and its result, a steering message in the same turn, and the answer.
const turn = (i: number, output: string) => [
  row({ type: 'user', uuid: `u-${i}`, promptId: `p-${i}`, message: { content: `Prompt ${i}` } }),
  row({ type: 'assistant', uuid: `a-${i}`, message: { content: [{ type: 'tool_use', id: `t-${i}`, name: 'Read', input: { file_path: `/f/${i}` } }] } }),
  row({ type: 'user', uuid: `r-${i}`, message: { content: [{ type: 'tool_result', tool_use_id: `t-${i}`, content: output }] } }),
  row({ type: 'user', uuid: `s-${i}`, promptId: `p-${i}`, message: { content: `Adjustment ${i}` } }),
  row({ type: 'assistant', uuid: `f-${i}`, message: { content: `Answer ${i}` } }),
];
const transcript = (count: number, output: string) => Array.from({ length: count }, (_, i) => turn(i, output)).flat().join('\n');

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function store(content: string) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'claude-recent-'));
  homes.push(home);
  await mkdir(path.join(home, '-synthetic'));
  await writeFile(path.join(home, '-synthetic', `${session.conversationId}.jsonl`), content);
  return home;
}
const open = async (content: string, recentWindows: number[]) => {
  const home = await store(content);
  const full = (await loadClaudeTranscriptHistory(agent, { projectsRoot: home }))!;
  const recent = (await loadClaudeTranscriptHistory(agent, { projectsRoot: home, recent: true, recentWindows }))!;
  return { full, recent };
};
const turnIds = (messages: { turnId?: string }[]) => [...new Set(messages.map(message => message.turnId))];

describe('Claude conversation opened from the end of its transcript', () => {
  it('holds the end of the conversation, and says there is more before it', async () => {
    const { full, recent } = await open(transcript(40, 'x'.repeat(20 * KiB)), [64 * KiB, 256 * KiB, 1024 * KiB]);
    expect(recent.messages.length).toBeGreaterThan(0);
    expect(recent.messages.length).toBeLessThan(full.messages.length);
    expect(recent.messages).toStrictEqual(full.messages.slice(-recent.messages.length));
    expect(recent.source?.loadEarlier).toBeDefined();
  });

  it('holds a transcript that fits the first window whole', async () => {
    const { full, recent } = await open(transcript(3, 'small'), [1024 * KiB]);
    expect(recent.messages).toStrictEqual(full.messages);
    expect(recent.source?.loadEarlier).toBeUndefined();
  });

  it.each([7_001, 12_345, 33_333, 50_021, 77_777])('holds only whole turns when the window of %i bytes begins inside one', async window => {
    const { full, recent } = await open(transcript(30, 'y'.repeat(6 * KiB)), [window]);
    expect(recent.messages.length).toBeGreaterThan(0);
    for (const id of turnIds(recent.messages)) {
      expect(recent.messages.filter(message => message.turnId === id)).toStrictEqual(full.messages.filter(message => message.turnId === id));
    }
    expect(recent.turns?.map(item => item.id)).toStrictEqual(turnIds(recent.messages));
  });

  it('widens the window when the end of the transcript holds too few messages', async () => {
    const content = [transcript(10, 'z'.repeat(100)), ...turn(10, 'w'.repeat(600 * KiB))].join('\n');
    const { full, recent } = await open(content, [64 * KiB, 1024 * KiB]);
    expect(recent.messages).toStrictEqual(full.messages);
  });

  it('reads the whole transcript when no window holds a complete turn', async () => {
    const { full, recent } = await open(transcript(5, 'v'.repeat(20 * KiB)), [512]);
    expect(recent.messages).toStrictEqual(full.messages);
    expect(recent.source?.loadEarlier).toBeUndefined();
  });

  it('agrees with what loading the earlier part returns', async () => {
    const { recent } = await open(transcript(40, 'u'.repeat(20 * KiB)), [64 * KiB, 256 * KiB]);
    const earlier = await recent.source!.loadEarlier!();
    expect(earlier.messages.length).toBeGreaterThan(recent.messages.length);
    expect(earlier.messages.slice(-recent.messages.length)).toStrictEqual(recent.messages);
  });
  describe('the part before the recent window', () => {
    const windows = [64 * KiB, 256 * KiB, 1024 * KiB, 8192 * KiB];
    const long = () => open(transcript(120, 'x'.repeat(20 * KiB)), windows);

    it('is read a step at a time, each step joining the one before it, down to the start of the transcript', async () => {
      const { full, recent } = await long();
      const counts = [recent.messages.length];
      let step = recent;
      while (step.source?.loadEarlier) {
        const wider = await step.source.loadEarlier();
        expect(wider.messages.length).toBeGreaterThan(step.messages.length);
        expect(wider.messages.slice(-step.messages.length)).toStrictEqual(step.messages);
        counts.push(wider.messages.length);
        step = { ...step, messages: wider.messages, source: wider.source };
      }
      expect(counts.length).toBeGreaterThan(2);
      expect(counts[1]).toBeLessThan(full.messages.length);
      expect(step.messages).toStrictEqual(full.messages);
    });

    it('is read whole when the caller needs the complete conversation', async () => {
      const { full, recent } = await long();
      const everything = await recent.source!.loadEarlier!(true);
      expect(everything.messages).toStrictEqual(full.messages);
      expect(everything.source.loadEarlier).toBeUndefined();
    });

    it('carries the task plan, goal and subagents of the wider window', async () => {
      const { recent } = await long();
      const wider = await recent.source!.loadEarlier!();
      expect(wider).toHaveProperty('taskPlan');
      expect(wider.turns.length).toBeGreaterThan(recent.turns!.length);
    });
  });
});
