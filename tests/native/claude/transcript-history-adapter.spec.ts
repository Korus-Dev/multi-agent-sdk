import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { claudeTranscriptGoal, claudeTranscriptSettings, claudeTranscriptToMessages, listClaudeTranscriptSummaries, loadClaudeTranscriptHistory } from '../../../src/providers/claude/transcript-history-adapter';
import type { Agent } from '../../../src/contracts/index';

describe('native Claude goal history', () => {
  it('distinguishes an active goal, native completion, explicit clear, and sidechain records', () => {
    const row = (attachment: object, isSidechain = false) => JSON.stringify({ type: 'attachment', timestamp: '2026-10-04T12:00:00.000Z', isSidechain, attachment: { type: 'goal_status', condition: 'Ship it', ...attachment } });
    const active = row({ met: false, sentinel: true });
    expect(claudeTranscriptGoal(active, 'session')).toMatchObject({ objective: 'Ship it', status: 'active', threadId: 'session' });
    const complete = active + '\n' + row({ met: true, iterations: 2, tokens: 55, durationMs: 1800 });
    expect(claudeTranscriptGoal(complete, 'session')).toMatchObject({ status: 'complete', tokensUsed: 55, timeUsedSeconds: 1.8 });
    expect(claudeTranscriptGoal(complete + '\n' + row({ met: false }, true), 'session')?.status).toBe('complete');
    expect(claudeTranscriptGoal(active + '\n' + row({ met: true, sentinel: true }), 'session')).toBeNull();
    expect(claudeTranscriptGoal('{"type":"assistant","message":{"content":"Goal complete!"}}', 'session')).toBeUndefined();
  });
});

describe('claudeTranscriptToMessages', () => {
  it('excludes unfinished tool chains from fork cutoffs and includes trailing goal records', () => {
    const rows = [
      { type: 'user', uuid: 'user', message: { content: 'work' } },
      { type: 'assistant', uuid: 'tool-call', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } },
    ];
    const unfinished: Record<string, string> = {};
    claudeTranscriptToMessages(rows.map((row) => JSON.stringify(row)).join('\n'), 'agent', 'session', unfinished);
    expect(unfinished).toEqual({});
    const finished: Record<string, string> = {};
    const complete = [...rows,
      { type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'done' }] } },
      { type: 'attachment', uuid: 'goal-met', attachment: { type: 'goal_status', condition: 'work', met: true } },
    ];
    claudeTranscriptToMessages(complete.map((row) => JSON.stringify(row)).join('\n'), 'agent', 'session', finished);
    expect(finished).toEqual({ 'claude-user': 'goal-met' });
  });



  it('ignores Claude meta user records and sidechain entries', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        uuid: 'meta-1',
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'sidechain-1',
        isSidechain: true,
        message: { role: 'user', content: 'ignore sidechain' },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        promptId: 'prompt-1',
        message: { role: 'user', content: 'keep this' },
      }),
    ].join('\n');

    expect(claudeTranscriptToMessages(content, 'agent-claude', 'session-1')).toStrictEqual([
      expect.objectContaining({
        id: 'user-session-1-user-1',
        parts: [{ type: 'text', text: 'keep this' }],
      }),
    ]);
  });

  it('restores completed Claude compaction boundaries', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        promptId: 'prompt-1',
        timestamp: '2026-08-10T12:00:00.000Z',
        message: { role: 'user', content: 'long conversation' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-08-10T12:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Before compaction.' }] },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'boundary-1',
        timestamp: '2026-08-10T12:00:02.000Z',
        compact_metadata: { trigger: 'manual', pre_tokens: 180_000, post_tokens: 30_000 },
      }),
    ].join('\n');

    expect(claudeTranscriptToMessages(content, 'agent-claude', 'session-1')).toStrictEqual([
      expect.objectContaining({ id: 'user-session-1-user-1' }),
      expect.objectContaining({
        id: 'assistant-claude-prompt-1',
        parts: [{ type: 'text', text: 'Before compaction.' }],
      }),
      {
        id: 'compaction-claude-compact-boundary-1',
        agentId: 'agent-claude',
        kind: 'compaction',
        role: 'assistant',
        status: 'complete',
        turnId: 'claude-prompt-1',
        createdAt: '2026-08-10T12:00:02.000Z',
        parts: [],
      },
    ]);
  });
});

describe('claudeTranscriptSettings', () => {
  it('returns the latest main-thread model and effort without reading sidechains', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-old',
        effort: 'high',
        message: { id: 'message-old', model: 'claude-sonnet-5', role: 'assistant', content: 'old' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-sidechain',
        isSidechain: true,
        effort: 'max',
        message: { id: 'message-sidechain', model: 'claude-opus-5', role: 'assistant', content: 'ignore' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-new-1',
        effort: 'xhigh',
        message: { id: 'message-new', model: 'claude-sonnet-5', role: 'assistant', content: 'new' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-new-2',
        message: { id: 'message-new', model: 'claude-sonnet-5', role: 'assistant', content: [] },
      }),
    ].join('\n');

    expect(claudeTranscriptSettings(content)).toStrictEqual({
      model: 'claude-sonnet-5',
      reasoningEffort: 'xhigh',
    });
  });

  it('clears an earlier effort when the latest response uses a different model without one', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        effort: 'xhigh',
        message: { id: 'message-sonnet', model: 'claude-sonnet-5', role: 'assistant', content: 'first' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'message-haiku', model: 'claude-haiku-4-5-20251001', role: 'assistant', content: 'second' },
      }),
    ].join('\n');

    expect(claudeTranscriptSettings(content)).toStrictEqual({
      model: 'claude-haiku-4-5-20251001',
    });
  });
});

describe('loadClaudeTranscriptHistory', () => {
  it('restores a native worktree fork from its stored project without changing its execution folder', async () => {
    const projectsRoot = await mkdtemp(path.join(tmpdir(), 'claude-fork-store-'));
    try {
      const transcriptFolder = '/source/project';
      const projectDirectory = path.join(projectsRoot, transcriptFolder.replace(/[^a-zA-Z0-9]/g, '-'));
      await mkdir(projectDirectory);
      await writeFile(path.join(projectDirectory, 'native-child.jsonl'), [
        { type: 'user', uuid: 'assignment', message: { content: 'Task directions' } },
        { type: 'assistant', uuid: 'answer', message: { content: 'Inherited design decision' } },
      ].map(row => JSON.stringify(row)).join('\n'));
      const worker: Agent = { id: 'worker', name: 'Worker', folder: '/worker/worktree', provider: 'claude', providerSession: { kind: 'claude', conversationId: 'native-child', transport: 'stdio', transcriptFolder } };
      const history = await loadClaudeTranscriptHistory(worker, { projectsRoot });
      expect(history?.messages).toContainEqual(expect.objectContaining({ agentId: 'worker', role: 'assistant', parts: [{ type: 'text', text: 'Inherited design decision' }] }));
      expect(history?.providerSession).toMatchObject({ transcriptFolder });
      expect(worker.folder).toBe('/worker/worktree');
    } finally { await rm(projectsRoot, { recursive: true, force: true }); }
  });
  it.each(['/Users/nbonamy/src/id8', '/workspace/project.with_underscore', null])('loads a persisted Claude session with folder %s', async (folder) => {
    const projectsRoot = path.join(tmpdir(), `agent-workspace-claude-history-${Date.now()}-${folder ? 'project' : 'chat'}`);
    const projectDirectory = path.join(projectsRoot, (folder ?? homedir()).replace(/[^a-zA-Z0-9]/g, '-'));
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(path.join(projectDirectory, 'session-1.jsonl'), [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        promptId: 'prompt-1',
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        effort: 'high',
        message: { id: 'message-1', role: 'assistant', model: 'claude-sonnet-5', content: 'hello back' },
      }),
    ].join('\n'));

    const agent: Agent = {
      id: 'agent-claude',
      name: 'Claude',
      folder,
      provider: 'claude',
      providerSession: { kind: 'claude', conversationId: 'session-1', transport: 'stdio' },
    };

    const history = await loadClaudeTranscriptHistory(agent, { projectsRoot });
    const { source, ...restored } = history!;
    expect(await source!.readAll()).toStrictEqual(restored.messages);
    expect(restored).toStrictEqual({
      turnBoundaries: { 'claude-prompt-1': 'assistant-1' },
      nativeMessageTurnIds: { 'user-1': 'claude-prompt-1', 'assistant-1': 'claude-prompt-1' },
      turns: [{
        id: 'claude-prompt-1', status: 'completed', error: null, willRetry: false,
        startedAt: null, completedAt: null, durationMs: null,
      }],
      providerSession: { kind: 'claude',
        conversationId: 'session-1',
        transcriptConversationId: 'session-1',
        transport: 'stdio',
        model: 'claude-sonnet-5',
        reasoningEffort: 'high',
      },
      messages: [
        expect.objectContaining({
          id: 'user-session-1-user-1',
          parts: [{ type: 'text', text: 'hello' }],
        }),
        expect.objectContaining({
          id: 'assistant-claude-prompt-1',
          parts: [{ type: 'text', text: 'hello back' }],
        }),
      ],
    });
    await expect(listClaudeTranscriptSummaries(agent, { projectsRoot })).resolves.toEqual([
      expect.objectContaining({ ref: { provider: 'claude', folder, conversationId: 'session-1' } }),
    ]);
  });
});

describe('listClaudeTranscriptSummaries', () => {
  it('lists Claude project transcripts newest first with user-facing titles', async () => {
    const projectsRoot = path.join(tmpdir(), `agent-workspace-claude-list-${Date.now()}`);
    const projectDirectory = path.join(projectsRoot, '-Users-nbonamy-src-id8');
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(path.join(projectDirectory, 'session-old.jsonl'), [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        message: { role: 'user', content: 'older prompt' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'older answer' }] },
      }),
    ].join('\n'));
    await writeFile(path.join(projectDirectory, 'session-new.jsonl'), [
      JSON.stringify({
        type: 'user',
        uuid: 'meta-1',
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'user-2',
        message: { role: 'user', content: '<command-name>plan</command-name><command-args>ship history</command-args>' },
      }),
    ].join('\n'));
    await writeFile(path.join(projectDirectory, 'not-a-session.txt'), 'ignored');

    await utimes(path.join(projectDirectory, 'session-old.jsonl'), new Date('2026-06-09T10:00:00.000Z'), new Date('2026-06-09T10:00:00.000Z'));
    await utimes(path.join(projectDirectory, 'session-new.jsonl'), new Date('2026-06-09T11:00:00.000Z'), new Date('2026-06-09T11:00:00.000Z'));

    const agent: Agent = {
      id: 'agent-claude',
      name: 'Claude',
      folder: '/Users/nbonamy/src/id8',
      provider: 'claude',
    };

    await expect(listClaudeTranscriptSummaries(agent, { projectsRoot })).resolves.toStrictEqual([
      {
        id: 'session-new',
        title: '/plan ship history',
        updatedAt: '2026-06-09T11:00:00.000Z',
        messageCount: 1,
        storageState: 'active',
        ref: { provider: 'claude', folder: '/Users/nbonamy/src/id8', conversationId: 'session-new' },
      },
      {
        id: 'session-old',
        title: 'older prompt',
        updatedAt: '2026-06-09T10:00:00.000Z',
        messageCount: 2,
        storageState: 'active',
        ref: { provider: 'claude', folder: '/Users/nbonamy/src/id8', conversationId: 'session-old' },
      },
    ]);
  });
});

describe('thinking written out as narration', () => {
  const rows = (blocks: object[][]) => [
    { type: 'user', uuid: 'prompt', message: { content: 'Do the work' } },
    ...blocks.map((content, index) => ({ type: 'assistant', uuid: `a-${index}`, message: { id: 'msg-1', content } })),
  ].map(row => JSON.stringify(row)).join('\n');
  const parts = (content: string) => claudeTranscriptToMessages(content, 'agent', 'session').filter(message => message.role === 'assistant').flatMap(message => message.parts)
    .map(part => part.type === 'reasoning' ? `reasoning:${part.summary}` : part.type === 'text' ? `text:${part.text}` : part.type);

  it('shows the text of a thinking block as a reasoning part, in the order it was written', () => {
    expect(parts(rows([
      [{ type: 'thinking', thinking: 'I will look first.', signature: 'sig' }],
      [{ type: 'text', text: 'Looking now.' }],
      [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/a' } }],
      [{ type: 'thinking', thinking: 'Found it; reporting.', signature: 'sig' }],
    ]))).toStrictEqual(['reasoning:I will look first.', 'text:Looking now.', 'tool', 'reasoning:Found it; reporting.']);
  });

  it('gives every reasoning part its own id', () => {
    const ids = claudeTranscriptToMessages(rows([[{ type: 'thinking', thinking: 'One.' }], [{ type: 'thinking', thinking: 'Two.' }]]), 'agent', 'session')
      .flatMap(message => message.parts).flatMap(part => part.type === 'reasoning' ? [part.itemId] : []);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('shows only thinking that carries text', () => {
    expect(parts(rows([
      [{ type: 'thinking', thinking: '', signature: 'hidden' }],
      [{ type: 'thinking', thinking: '   ', signature: 'blank' }],
      [{ type: 'redacted_thinking', data: 'x' }],
      [{ type: 'text', text: 'Answer.' }],
    ]))).toStrictEqual(['text:Answer.']);
  });
});
