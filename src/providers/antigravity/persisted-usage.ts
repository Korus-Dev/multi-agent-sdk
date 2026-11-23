import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validConsumption, type PersistedExecutionUsage } from '../../contracts/usage';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const maxSteps = 50_000;
const userInput = 14;
const plannerResponse = 15;
const systemMessage = 101;
const finishedStatuses = new Set([3, 6, 7, 12]);
export type PersistedUsageCache = Map<string, { fingerprint: string; usage: PersistedExecutionUsage[] }>;

async function read<T>(file: string, query: (db: DatabaseSync) => T): Promise<T | undefined> {
  try {
    if (await realpath(file) !== file || !(await stat(file)).isFile()) return;
    const db = new DatabaseSync(file, { readOnly: true });
    try { return query(db); } finally { db.close(); }
  } catch { /* An unavailable native file supplies no evidence this time. */ }
}

/** Only CortexStepMetadata lives here. The transcript and step payloads are never read. */
export async function readPersistedUsage(home: string, rootId: string, cache: PersistedUsageCache): Promise<PersistedExecutionUsage[]> {
  if (!uuid.test(rootId)) return [];
  const absolute = await realpath(home).catch(() => null);
  if (!absolute) return [];
  const cli = path.join(absolute, 'antigravity-cli');
  const sessions = await read(path.join(cli, 'conversation_summaries.db'), db => db.prepare(`
    WITH RECURSIVE tree(id) AS (
      SELECT ? UNION SELECT conversation_id FROM conversation_summaries JOIN tree ON parent_conversation_id=tree.id LIMIT 512
    ) SELECT id FROM tree`).all(rootId).flatMap(({ id }) => typeof id === 'string' && uuid.test(id) ? [id] : []));
  const result: PersistedExecutionUsage[] = [];
  for (const id of sessions ?? [rootId]) {
    const file = path.join(cli, 'conversations', `${id}.db`);
    const fingerprint = await usageFingerprint(file);
    if (!fingerprint) continue;
    const previous = cache.get(file);
    const found = previous?.fingerprint === fingerprint ? previous.usage : await read(file, db => sessionUsage(db, id));
    if (!found) continue;
    cache.delete(file);
    cache.set(file, { fingerprint, usage: found });
    while (cache.size > 128) cache.delete(cache.keys().next().value!);
    result.push(...structuredClone(found));
  }
  return result;
}

async function usageFingerprint(file: string): Promise<string | undefined> {
  const main = await stat(file).catch(() => null);
  if (!main?.isFile() || await realpath(file).catch(() => null) !== file) return;
  const wal = await stat(`${file}-wal`).catch(() => null);
  return `${main.ino}:${main.size}:${main.mtimeMs}:${wal?.ino}:${wal?.size}:${wal?.mtimeMs}`;
}

function sessionUsage(db: DatabaseSync, sessionId: string): PersistedExecutionUsage[] {
  if (db.prepare('SELECT cascade_id FROM trajectory_meta').get()?.cascade_id !== sessionId) return [];
  const steps = db.prepare(`SELECT step_type, status, metadata FROM steps WHERE step_type IN (${userInput}, ${plannerResponse}, ${systemMessage})
    AND length(metadata) BETWEEN 1 AND 65536 ORDER BY idx LIMIT ?`).iterate(maxSteps + 1);
  const executions = new Map<string, PersistedExecutionUsage>();
  const responses = new Set<string>();
  const invalid = new Set<string>();
  let count = 0;
  for (const step of steps) {
    if (++count > maxSteps) return [];
    if (!(step.metadata instanceof Uint8Array)) continue;
    const metadata = fields(step.metadata);
    const executionId = stringField(metadata.get(12)); // CortexStepMetadata.execution_id
    if (!executionId || !uuid.test(executionId)) continue;
    const at = timestamp(metadata.get(1)); // CortexStepMetadata.created_at
    if (!at) { invalid.add(executionId); continue; }
    let execution = executions.get(executionId);
    if (!execution) {
      execution = { sessionId, executionId, startedAt: at, prompted: false,
        tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } };
      executions.set(executionId, execution);
    }
    if (step.step_type === userInput) { execution.prompted = true; execution.startedAt = at; }
    if (step.step_type !== plannerResponse || typeof step.status !== 'number' || !finishedStatuses.has(step.status)) continue;
    const usage = metadata.get(9); // CortexStepMetadata.model_usage (ModelUsageStats)
    if (!(usage instanceof Uint8Array) || !usage.length) continue;
    const counts = fields(usage);
    if (!counts.size) { invalid.add(executionId); continue; }
    const responseId = stringField(counts.get(7));
    const [uncached, output, cacheWrite, cacheRead, reasoning] = [2, 3, 4, 5, 9].map(id => counts.get(id) ?? 0);
    if ([uncached, output, cacheWrite, cacheRead, reasoning].every(n => n === 0)) continue;
    if (!responseId || ![uncached, output, cacheWrite, cacheRead, reasoning].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1e9)
      || Number(reasoning) > Number(output)) {
      invalid.add(executionId);
      continue;
    }
    if (responses.has(responseId)) continue;
    responses.add(responseId);
    const tokens = execution.tokens;
    tokens.input += Number(uncached) + Number(cacheRead);
    tokens.output += Number(output);
    tokens.cacheRead += Number(cacheRead);
    tokens.cacheWrite = (tokens.cacheWrite ?? 0) + Number(cacheWrite);
    tokens.reasoning = (tokens.reasoning ?? 0) + Number(reasoning);
    tokens.total = tokens.input + tokens.output;
  }
  return [...executions.values()].filter(({ executionId, tokens }) => !invalid.has(executionId) && tokens.total && validConsumption(tokens));
}

function stringField(value: unknown): string | undefined {
  if (value instanceof Uint8Array && value.length <= 128) return Buffer.from(value).toString('utf8');
}

function timestamp(value: unknown): number | undefined {
  if (!(value instanceof Uint8Array)) return;
  const parts = fields(value);
  const seconds = parts.get(1), nanos = parts.get(2) ?? 0;
  if (typeof seconds === 'number' && seconds > 0 && seconds < 1e11 && typeof nanos === 'number' && nanos >= 0 && nanos < 1e9)
    return seconds * 1000 + Math.floor(nanos / 1e6);
}

/** Decode the scalar/length-delimited fields of agy's protobuf records, skipping unknown fixed-width data. */
function fields(bytes: Uint8Array): Map<number, number | Uint8Array> {
  const result = new Map<number, number | Uint8Array>();
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 70 && offset < bytes.length; shift += 7) {
      const byte = bytes[offset++]!;
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error('Invalid native usage varint');
  };
  try {
    while (offset < bytes.length) {
      const tag = varint(), id = Math.floor(tag / 8), wire = tag % 8;
      if (!id || id >= 2 ** 29) break;
      if (wire === 0) result.set(id, varint());
      else if (wire === 2) {
        const length = varint();
        if (length > bytes.length - offset) break;
        result.set(id, bytes.subarray(offset, offset + length));
        offset += length;
      } else if (wire === 1 && offset + 8 <= bytes.length) offset += 8;
      else if (wire === 5 && offset + 4 <= bytes.length) offset += 4;
      else break;
    }
    if (offset === bytes.length) return result;
  } catch { /* Incomplete native records are ignored. */ }
  return new Map();
}
