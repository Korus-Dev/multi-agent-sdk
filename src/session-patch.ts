import type { Message, SessionState } from './consumer-types';

/** One change to a session's state. Patches are plain JSON, so they cross any wire unchanged. */
export type SessionPatchOp =
  | { op: 'set'; key: Exclude<keyof SessionState, 'messages'>; value: unknown }
  /** Replaces `deleteCount` messages at `start` with `messages`: streaming touches the tail, history paging the head. */
  | { op: 'spliceMessages'; start: number; deleteCount: number; messages: Message[] };

/** The changes from `revision - 1` to `revision`. */
export type SessionPatch = { revision: number; ops: SessionPatchOp[] };

/** A session's full state at a revision, the starting point patches apply to. */
export type SessionSnapshot = { revision: number; state: SessionState };

/** A patch does not follow the consumer's revision; read a fresh snapshot and continue from it. */
export class SessionPatchGapError extends Error {
  constructor(readonly expected: number, readonly received: number) {
    super(`Session patch ${received} does not follow revision ${expected - 1}; read a fresh snapshot.`);
    this.name = 'SessionPatchGapError';
  }
}

/** A patch that is not a valid change to session state, such as one from a peer on another version; read a fresh snapshot. */
export class SessionPatchInvalidError extends Error {
  constructor(readonly revision: number, detail: string) {
    super(`Session patch ${revision} is invalid: ${detail}; read a fresh snapshot.`);
    this.name = 'SessionPatchInvalidError';
  }
}

const stateKeys = ['selection', 'permission', 'planMode', 'busy', 'activeTurnId', 'turns', 'answeredClientRequestIds', 'historyLoading',
  'historyState', 'requests', 'error', 'title', 'goal', 'contextUsage', 'plan'] as const satisfies readonly Exclude<keyof SessionState, 'messages'>[];
// Every session state field must be patchable: adding one without listing it here fails to compile.
const allStateKeys: Exclude<keyof SessionState, 'messages'> extends (typeof stateKeys)[number] ? true : never = true;
void allStateKeys;
const patchableKeys = new Set<string>(stateKeys);
const count = (value: unknown, max: number) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;

function validate(op: SessionPatchOp, revision: number, messages: number): void {
  const fail = (detail: string) => { throw new SessionPatchInvalidError(revision, detail); };
  if (op === null || typeof op !== 'object') fail('an op is not an object');
  if (op.op === 'set') { if (!patchableKeys.has(op.key)) fail(`"${String(op.key)}" is not a session state field`); return; }
  if (op.op !== 'spliceMessages') fail(`"${String((op as { op?: unknown }).op)}" is not an op`);
  const splice = op as Extract<SessionPatchOp, { op: 'spliceMessages' }>;
  if (!count(splice.start, messages) || !count(splice.deleteCount, messages - splice.start)) fail('the splice is outside the transcript');
  if (!Array.isArray(splice.messages)) fail('the spliced messages are not a list');
}

/**
 * Applies a patch to a snapshot, returning the next snapshot. Throws `SessionPatchGapError` when a revision was missed,
 * and `SessionPatchInvalidError` when the patch is not a valid change to session state.
 */
export function applySessionPatch(snapshot: SessionSnapshot, patch: SessionPatch): SessionSnapshot {
  if (patch.revision !== snapshot.revision + 1) throw new SessionPatchGapError(snapshot.revision + 1, patch.revision);
  if (!Array.isArray(patch.ops)) throw new SessionPatchInvalidError(patch.revision, 'ops are not a list');
  const state = { ...snapshot.state } as Record<string, unknown> & SessionState;
  for (const op of patch.ops) {
    validate(op, patch.revision, state.messages.length);
    if (op.op === 'set') {
      if (op.value === undefined) delete (state as Record<string, unknown>)[op.key];
      else (state as Record<string, unknown>)[op.key] = structuredClone(op.value);
    } else {
      const messages = [...state.messages];
      messages.splice(op.start, op.deleteCount, ...structuredClone(op.messages));
      state.messages = messages;
    }
  }
  return { revision: patch.revision, state };
}

/** What a session last published, kept to compute the next patch. */
export type SessionPatchBase = { fields: Map<string, string>; messages: string[] };

export function emptyPatchBase(): SessionPatchBase { return { fields: new Map(), messages: [] }; }

/** The ops that turn the published state into `state`, and the new base to diff against next time. */
export function diffSessionState(base: SessionPatchBase, state: SessionState): { ops: SessionPatchOp[]; base: SessionPatchBase } {
  const ops: SessionPatchOp[] = [];
  const fields = new Map<string, string>();
  const keys = new Set<string>([...base.fields.keys(), ...Object.keys(state)]);
  for (const key of keys) {
    if (key === 'messages') continue;
    const value = (state as Record<string, unknown>)[key];
    const json = value === undefined ? undefined : JSON.stringify(value);
    if (json !== undefined) fields.set(key, json);
    if (json !== base.fields.get(key)) ops.push({ op: 'set', key: key as Exclude<keyof SessionState, 'messages'>, value: json === undefined ? undefined : JSON.parse(json) });
  }
  const messages = state.messages.map(message => JSON.stringify(message));
  const previous = base.messages;
  let prefix = 0;
  while (prefix < previous.length && prefix < messages.length && previous[prefix] === messages[prefix]) prefix++;
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < messages.length - prefix
    && previous[previous.length - 1 - suffix] === messages[messages.length - 1 - suffix]) suffix++;
  const deleteCount = previous.length - prefix - suffix;
  const inserted = messages.slice(prefix, messages.length - suffix);
  if (deleteCount > 0 || inserted.length > 0) ops.push({ op: 'spliceMessages', start: prefix, deleteCount, messages: inserted.map(json => JSON.parse(json) as Message) });
  return { ops, base: { fields, messages } };
}
