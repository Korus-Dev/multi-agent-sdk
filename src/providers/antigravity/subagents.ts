import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { record } from '../../acp/acp-connection';
import type { SubagentStatus } from '../../contracts/index';
import { antigravityConversationDirectory } from './runtime';

const nativeId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const maxRecordBytes = 64 * 1024;
const maxTranscriptTailBytes = 1024 * 1024;

// Values from agy's persisted CortexStepType and CortexStepStatus enums.
const plannerResponse = 15;
const errorMessage = 17;
const stepStatus = { done: 3, canceled: 6, error: 7, interrupted: 12 } as const;

export type AntigravitySubagent = { id: string; name?: string; role?: string; cwd?: string; status?: SubagentStatus };
type TerminalStatus = Extract<SubagentStatus, 'completed' | 'interrupted' | 'errored'>;
type ObservedSubagent = AntigravitySubagent & { stepIndex?: number; terminalStatus?: TerminalStatus };

async function subagentDirectory(home: string, parentId: string): Promise<string | undefined> {
  if (!nativeId.test(parentId)) return;
  const resolvedHome = await realpath(home);
  const directory = path.join(antigravityConversationDirectory(resolvedHome, parentId), '.system_generated', 'subagents');
  if (await realpath(directory).catch(() => undefined) === directory) return directory;
}

async function readRecord(directory: string, id: string): Promise<AntigravitySubagent | undefined> {
  if (!nativeId.test(id)) return;
  try {
    const file = await open(path.join(directory, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: unknown;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxRecordBytes) return;
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await file.read(buffer);
      raw = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    } finally { await file.close(); }
    if (!record(raw) || raw.conversationId !== id || !record(raw.subagentDescriptor)) return;
    const { role, typeName } = raw.subagentDescriptor;
    const workspace = Array.isArray(raw.workspaceUris) ? raw.workspaceUris[0] : undefined;
    let cwd: string | undefined;
    if (typeof workspace === 'string') {
      try { cwd = fileURLToPath(workspace); } catch { /* Use the validated parent workspace. */ }
    }
    return { id, ...(typeof role === 'string' && role.trim() ? { name: role.trim() } : {}),
      ...(typeof typeName === 'string' && typeName.trim() ? { role: typeName.trim() } : {}), ...(cwd ? { cwd } : {}),
      ...(raw.state === 'SUBAGENT_STATE_KILLED' ? { status: 'shutdown' } : {}) };
  } catch { return undefined; }
}

export async function readAntigravitySubagent(home: string, parentId: string, id: string): Promise<AntigravitySubagent | undefined> {
  if (id === parentId || !nativeId.test(id)) return;
  const directory = await subagentDirectory(home, parentId);
  return directory ? readRecord(directory, id) : undefined;
}

async function readDatabase<T>(databasePath: string, read: (database: DatabaseSync) => T): Promise<T | undefined> {
  if (await realpath(databasePath).catch(() => undefined) !== databasePath) return;
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { return read(database); } finally { database.close(); }
  } catch { /* A locked or unfamiliar provider database supplies no status for this scan. */ }
}

async function subagentStatuses(home: string, parentId: string) {
  const databasePath = path.join(home, 'conversation_summaries.db');
  const rows = await readDatabase(databasePath, database => database.prepare(
    'SELECT conversation_id, status, killed, step_count, not_fully_idle FROM conversation_summaries WHERE parent_conversation_id = ?',
  ).all(parentId));
  return new Map(rows?.map(row => [row.conversation_id, row]));
}

async function hasFinalResponse(home: string, childId: string, stepIndex: number): Promise<boolean> {
  const transcript = path.join(home, 'brain', childId, '.system_generated', 'logs', 'transcript_full.jsonl');
  if (await realpath(transcript).catch(() => undefined) !== transcript) return false;
  try {
    const file = await open(transcript, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || !stat.size) return false;
      const buffer = Buffer.alloc(Math.min(stat.size, maxTranscriptTailBytes));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, stat.size - buffer.length);
      const tail = buffer.toString('utf8', 0, bytesRead).trimEnd();
      const step: unknown = JSON.parse(tail.slice(tail.lastIndexOf('\n') + 1));
      return record(step) && step.step_index === stepIndex && step.type === 'PLANNER_RESPONSE' && step.status === 'DONE'
        && typeof step.content === 'string' && Boolean(step.content.trim())
        && (step.tool_calls == null || (Array.isArray(step.tool_calls) && step.tool_calls.length === 0));
    } finally { await file.close(); }
  } catch { return false; }
}

async function workerStatus(home: string, child: ObservedSubagent, row: Record<string, SQLOutputValue> | undefined): Promise<SubagentStatus | undefined> {
  if (!row) return;
  if (row.killed === 1) return 'shutdown';
  const active = row.not_fully_idle === 1 || row.status === 'CASCADE_RUN_STATUS_RUNNING' || row.status === 'CASCADE_RUN_STATUS_BUSY' || row.status === 'CASCADE_RUN_STATUS_CANCELING';
  // Idle can describe a checkpoint, including the pause after a tool returns.
  const latest = await readDatabase(path.join(home, 'conversations', `${child.id}.db`),
    database => database.prepare('SELECT idx, step_type, status FROM steps ORDER BY idx DESC LIMIT 1').get());
  if (typeof latest?.idx !== 'number') {
    if (child.stepIndex !== undefined) return;
    if (active) return 'running';
    if (row.step_count === 0) return 'pendingInit';
    return;
  }
  // The trajectory and summary are read independently. Discard older checkpoints and
  // keep confirmed terminal evidence until the native worker records another step.
  if (child.stepIndex !== undefined && latest.idx < child.stepIndex) return;
  if (latest.idx === child.stepIndex && child.terminalStatus) return child.terminalStatus;
  child.stepIndex = latest.idx;
  child.terminalStatus = undefined;
  if (active || row.status !== 'CASCADE_RUN_STATUS_IDLE' || typeof row.step_count !== 'number' || latest.idx >= row.step_count) return 'running';
  if (latest.step_type === errorMessage && latest.status === stepStatus.done) child.terminalStatus = 'errored';
  if (latest.step_type === plannerResponse) {
    if (latest.status === stepStatus.canceled || latest.status === stepStatus.interrupted) child.terminalStatus = 'interrupted';
    if (latest.status === stepStatus.error) child.terminalStatus = 'errored';
    if (latest.status === stepStatus.done && await hasFinalResponse(home, child.id, latest.idx)) child.terminalStatus = 'completed';
  }
  return child.terminalStatus ?? 'running';
}

/** Reads only native records inside this parent; the spawn tool's status is independent of worker status. */
export class AntigravitySubagentMonitor {
  private readonly known = new Map<string, ObservedSubagent>();
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private closed = false;

  constructor(private readonly home: string, private readonly parentId: string,
    private readonly changed: (child: AntigravitySubagent, previous?: AntigravitySubagent) => void) {}

  start(follow = false): void {
    if (this.closed) return;
    if (follow && !this.timer) this.timer = setInterval(() => this.start(), 500).unref();
    if (!this.scanning) {
      this.scanning = true;
      void this.scan().catch(() => {}).finally(() => { this.scanning = false; });
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  private async scan(): Promise<void> {
    const directory = await subagentDirectory(this.home, this.parentId);
    if (!directory || this.closed) return;
    const files = await readdir(directory, { withFileTypes: true });
    const home = path.join(await realpath(this.home), 'antigravity-cli');
    const statuses = await subagentStatuses(home, this.parentId);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const id = file.name.slice(0, -5);
      if (id === this.parentId) continue;
      const child: ObservedSubagent | undefined = await readRecord(directory, id);
      if (!child) continue;
      const previous = this.known.get(id);
      child.stepIndex = previous?.stepIndex;
      child.terminalStatus = previous?.terminalStatus;
      child.status ??= await workerStatus(home, child, statuses.get(id)) ?? previous?.status;
      if (this.closed) return;
      this.known.set(id, child);
      if (!previous || child.name !== previous.name || child.role !== previous.role || child.status !== previous.status) {
        this.changed(child, previous);
      }
    }
    if (this.known.size) this.start(true);
  }
}
