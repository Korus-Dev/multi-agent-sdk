import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createHarness, type Harness, type HarnessEvent } from '../../../src';
import { subagentRef } from '../../../src/contracts-entry';
import { writeAntigravityRuntimeFixture } from './session-fixture';

it('discovers a native child, updates its status, and replays its transcript through a parent-scoped reference', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'antigravity-child-'));
  const home = path.join(root, 'home');
  const childId = '75382d49-b1e7-467d-b13d-50a96a976003';
  let harness: Harness | undefined;
  let database: DatabaseSync | undefined;
  let trajectory: DatabaseSync | undefined;
  try {
    await writeAntigravityRuntimeFixture(root);
    const fixture = {
      configuration: { models: { currentModelId: 'fixture', availableModels: [{ modelId: 'fixture', name: 'Fixture' }] } },
      updates: [{ sessionUpdate: 'tool_call', name: 'invoke_subagent', kind: 'other', toolCallId: 'invocation', status: 'completed' }],
      completion: { stopReason: 'end_turn' },
      lateUpdate: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
    };
    const fixturePath = path.join(root, 'usage-fixture.json');
    await writeFile(fixturePath, JSON.stringify(fixture));
    harness = createHarness('antigravity', { client: { name: 'worker-test' }, home, antigravity: { command: path.join(root, 'runtime') } });
    const session = harness.open({ id: 'parent', folder: root });
    const events: HarnessEvent[] = [];
    harness.onEvent(event => events.push(event));
    await harness.run(session, 'usage-fixture:spawn').result;
    const parent = harness.getRefData(harness.getConversationRef(session)!);
    const parentId = parent.data.conversationId;
    const directory = path.join(home, 'antigravity-cli', 'brain', parentId, '.system_generated', 'subagents');
    await mkdir(directory, { recursive: true });
    database = new DatabaseSync(path.join(home, 'antigravity-cli', 'conversation_summaries.db'));
    database.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, status TEXT, killed INTEGER, step_count INTEGER, not_fully_idle INTEGER)');
    database.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, 0, 2, 0)').run(childId, parentId, 'CASCADE_RUN_STATUS_IDLE');
    const conversations = path.join(home, 'antigravity-cli', 'conversations');
    await mkdir(conversations, { recursive: true });
    trajectory = new DatabaseSync(path.join(conversations, `${childId}.db`));
    trajectory.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER); INSERT INTO steps VALUES (2, 132, 3);');
    const record = path.join(directory, `${childId}.json`);
    const writeChild = (role: string) => writeFile(record, JSON.stringify({ conversationId: childId, state: 'SUBAGENT_STATE_ALIVE',
      subagentDescriptor: { role, typeName: 'research' } }));
    await writeChild('README Summarizer');
    await expect.poll(() => events.find(event => event.type === 'subagent.identityChanged')?.payload).toMatchObject({
      rootConversationId: parentId, conversationId: childId, agentNickname: 'README Summarizer', agentRole: 'research',
    });
    const childEvents = events.filter(event => event.type === 'subagent.activityChanged' || event.type === 'subagent.identityChanged' || event.type === 'subagent.statusChanged');
    expect(childEvents.map(event => event.type)).toEqual(['subagent.activityChanged', 'subagent.identityChanged', 'subagent.statusChanged']);
    expect(childEvents[0]?.payload).toMatchObject({ rootConversationId: parentId, parentConversationId: parentId, activity: { conversationId: childId } });
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.statusChanged', payload: { rootConversationId: parentId, conversationId: childId, status: 'running' } }));
    database.prepare('UPDATE conversation_summaries SET step_count = 3 WHERE conversation_id = ?').run(childId);
    // The summary catches up between tool calls. Observe that scan through the descriptor update.
    await writeChild('README Researcher');
    await expect.poll(() => events.filter(event => event.type === 'subagent.identityChanged').at(-1)?.payload.agentNickname).toBe('README Researcher');
    expect(events.filter(event => event.type === 'subagent.statusChanged').map(event => event.payload.status)).toEqual(['running']);
    trajectory.exec('INSERT INTO steps VALUES (3, 15, 3)');
    const logs = path.join(home, 'antigravity-cli', 'brain', childId, '.system_generated', 'logs');
    await mkdir(logs, { recursive: true });
    const transcriptFile = path.join(logs, 'transcript_full.jsonl');
    await writeFile(transcriptFile, JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'The README explains the SDK.' }) + '\n');
    database.prepare('UPDATE conversation_summaries SET step_count = 4 WHERE conversation_id = ?').run(childId);
    await expect.poll(() => events.filter(event => event.type === 'subagent.statusChanged').at(-1)?.payload.status).toBe('completed');
    await writeFile(transcriptFile, '{');
    await writeChild('README Reviewer');
    await expect.poll(() => events.filter(event => event.type === 'subagent.identityChanged').at(-1)?.payload.agentNickname).toBe('README Reviewer');
    expect(events.filter(event => event.type === 'subagent.statusChanged').map(event => event.payload.status)).toEqual(['running', 'completed']);
    trajectory.exec('INSERT INTO steps VALUES (4, 15, 8)');
    await expect.poll(() => events.filter(event => event.type === 'subagent.statusChanged').at(-1)?.payload.status).toBe('running');
    // A stale native read can expose an older terminal checkpoint after newer work was observed.
    trajectory.exec('DELETE FROM steps WHERE idx = 4');
    await writeFile(transcriptFile, JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'The README explains the SDK.' }) + '\n');
    await writeChild('Persistence & Recovery Reviewer');
    await expect.poll(() => events.filter(event => event.type === 'subagent.identityChanged').at(-1)?.payload.agentNickname).toBe('Persistence & Recovery Reviewer');
    expect(events.filter(event => event.type === 'subagent.statusChanged').map(event => event.payload.status)).toEqual(['running', 'completed', 'running']);

    // agy persists a separate ERROR_MESSAGE step when a worker stops on quota.
    trajectory.exec('INSERT INTO steps VALUES (4, 132, 3), (5, 17, 3)');
    database.prepare('UPDATE conversation_summaries SET step_count = 6 WHERE conversation_id = ?').run(childId);
    await expect.poll(() => events.filter(event => event.type === 'subagent.statusChanged').at(-1)?.payload.status).toBe('errored');
    trajectory.exec('DELETE FROM steps WHERE idx = 5');
    await writeChild('Persistence Reviewer');
    await expect.poll(() => events.filter(event => event.type === 'subagent.identityChanged').at(-1)?.payload.agentNickname).toBe('Persistence Reviewer');
    expect(events.filter(event => event.type === 'subagent.statusChanged').map(event => event.payload.status)).toEqual(['running', 'completed', 'running', 'errored']);
    trajectory.exec('INSERT INTO steps VALUES (5, 17, 3), (6, 14, 3), (7, 15, 8)');
    await expect.poll(() => events.filter(event => event.type === 'subagent.statusChanged').at(-1)?.payload.status).toBe('running');
    const ref = subagentRef(parent.data, childId);
    expect(ref).toMatchObject({ conversationId: parentId, subagentId: childId });
    const firstChunk = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The README explains the SDK.' } };
    await writeFile(fixturePath, JSON.stringify({ ...fixture, updates: [firstChunk] }));
    const messages = await harness.readConversationMessages(session, harness.restoreRef({ provider: 'antigravity', data: ref! }));
    expect(messages.flatMap(message => message.parts)).toContainEqual(expect.objectContaining({ type: 'text', text: 'The README explains the SDK.' }));
    await writeFile(fixturePath, JSON.stringify({ ...fixture, updates: [firstChunk,
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' It also lists examples.' } },
    ] }));
    const replayed = await harness.readConversationMessages(session, harness.restoreRef({ provider: 'antigravity', data: ref! }));
    expect(replayed.map(({ id, turnId }) => ({ id, turnId }))).toEqual(messages.map(({ id, turnId }) => ({ id, turnId })));
    expect(replayed.flatMap(message => message.parts)).toContainEqual({ type: 'text', text: 'The README explains the SDK. It also lists examples.' });
    const other = harness.restoreRef({ provider: 'antigravity', data: { provider: 'antigravity', folder: root, conversationId: parentId,
      subagentId: '65382d49-b1e7-467d-b13d-50a96a976003' } });
    await expect(harness.readConversationMessages(session, other)).rejects.toThrow('not registered');
    const otherFolder = path.join(root, 'other');
    await mkdir(otherFolder);
    const foreign = harness.restoreRef({ provider: 'antigravity', data: { provider: 'antigravity', folder: otherFolder, conversationId: parentId, subagentId: childId } });
    await expect(harness.readConversationMessages(session, foreign)).rejects.toThrow('belongs to another workspace');
    await expect(harness.resumeConversation(session, { ref: harness.restoreRef({ provider: 'antigravity', data: ref! }), storageState: 'active' })).rejects.toThrow('read-only');
    const saved = harness.getSessionData(session);
    await harness.release(session);
    const restored = harness.restoreSession({ id: 'parent', folder: root }, saved);
    expect(await harness.loadConversation(restored)).toBe(true);
    await expect.poll(() => events.filter(event => event.type === 'subagent.identityChanged' && event.session === restored)).toHaveLength(1);
  } finally { await harness?.close(); trajectory?.close(); database?.close(); await rm(root, { recursive: true, force: true }); }
}, 10_000);
