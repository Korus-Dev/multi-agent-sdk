import type { Message, SessionState } from './consumer-types';

/** One change to a session's state. Patches are plain JSON, so they cross any wire unchanged. */
export type SessionPatchOp =
  | { op: 'set'; key: Exclude<keyof SessionState, 'messages'>; value: unknown }
  /** Replaces `deleteCount` messages at `start` with `messages`: new messages at the tail, history paging at the head. */
  | { op: 'spliceMessages'; start: number; deleteCount: number; messages: Message[] }
  /** Sets fields of the message at `index` other than its parts, and removes those named in `remove`. */
  | { op: 'setMessageFields'; index: number; fields: Record<string, unknown>; remove?: string[] }
  /** Replaces `deleteCount` parts at `start` in the message at `index`. */
  | { op: 'spliceParts'; index: number; start: number; deleteCount: number; parts: MessagePart[] }
  /** Appends `text` to a text field of one part: what streaming adds, without the text already sent. */
  | { op: 'appendPartText'; index: number; part: number; field: string; text: string };
type MessagePart = Message['parts'][number];

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

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// A message's parts change through their own ops, and a field name must never reach an object's prototype.
const settable = (field: unknown) => typeof field === 'string' && field !== 'parts' && field !== '__proto__';

function validate(op: SessionPatchOp, revision: number, messages: readonly Message[]): void {
  const fail = (detail: string): never => { throw new SessionPatchInvalidError(revision, detail); };
  if (op === null || typeof op !== 'object') fail('an op is not an object');
  if (op.op === 'set') { if (!patchableKeys.has(op.key)) fail(`"${String(op.key)}" is not a session state field`); return; }
  if (op.op === 'spliceMessages') {
    if (!count(op.start, messages.length) || !count(op.deleteCount, messages.length - op.start)) fail('the splice is outside the transcript');
    if (!Array.isArray(op.messages)) fail('the spliced messages are not a list');
    return;
  }
  if (op.op !== 'setMessageFields' && op.op !== 'spliceParts' && op.op !== 'appendPartText') fail(`"${String((op as { op?: unknown }).op)}" is not an op`);
  if (!count(op.index, messages.length - 1)) fail('the message is outside the transcript');
  const parts = messages[op.index]!.parts;
  if (op.op === 'setMessageFields') {
    if (!plain(op.fields) || (op.remove !== undefined && !Array.isArray(op.remove))) fail('the message fields are not a record');
    if (![...Object.getOwnPropertyNames(op.fields), ...op.remove ?? []].every(settable)) fail('a message field cannot be set');
  } else if (op.op === 'spliceParts') {
    if (!count(op.start, parts.length) || !count(op.deleteCount, parts.length - op.start)) fail('the splice is outside the message');
    if (!Array.isArray(op.parts)) fail('the spliced parts are not a list');
  } else {
    if (!count(op.part, parts.length - 1)) fail('the part is outside the message');
    const part = parts[op.part] as unknown as Record<string, unknown>;
    if (typeof op.text !== 'string' || !settable(op.field) || !Object.hasOwn(part, op.field) || typeof part[op.field] !== 'string') fail('the part field is not text');
  }
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
    validate(op, patch.revision, state.messages);
    if (op.op === 'set') {
      if (op.value === undefined) delete (state as Record<string, unknown>)[op.key];
      else (state as Record<string, unknown>)[op.key] = structuredClone(op.value);
    } else if (op.op === 'spliceMessages') {
      const messages = [...state.messages];
      messages.splice(op.start, op.deleteCount, ...structuredClone(op.messages));
      state.messages = messages;
    } else {
      const messages = [...state.messages];
      const message = { ...messages[op.index]! } as Record<string, unknown> & Message;
      if (op.op === 'setMessageFields') {
        for (const [field, value] of Object.entries(op.fields)) message[field] = structuredClone(value);
        for (const field of op.remove ?? []) delete message[field];
      } else {
        const parts = [...message.parts];
        if (op.op === 'spliceParts') parts.splice(op.start, op.deleteCount, ...structuredClone(op.parts));
        else { const part = parts[op.part] as unknown as Record<string, string>; parts[op.part] = { ...part, [op.field]: part[op.field] + op.text } as unknown as MessagePart; }
        message.parts = parts;
      }
      messages[op.index] = message;
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
  if (deleteCount > 0 || inserted.length > 0) {
    // The same messages, changed in place: send what changed inside each. Anything else replaces the range.
    const changes = deleteCount === inserted.length ? inserted.map((json, offset) => messageOps(prefix + offset, previous[prefix + offset]!, json)) : [];
    if (changes.length && changes.every(change => change !== null)) ops.push(...changes.flat() as SessionPatchOp[]);
    else ops.push({ op: 'spliceMessages', start: prefix, deleteCount, messages: inserted.map(json => JSON.parse(json) as Message) });
  }
  return { ops, base: { fields, messages } };
}

/** The ops that turn one published message into its next version; null when it is another message. */
function messageOps(index: number, previousJson: string, nextJson: string): SessionPatchOp[] | null {
  if (previousJson === nextJson) return [];
  const previous = JSON.parse(previousJson) as Record<string, unknown>, next = JSON.parse(nextJson) as Record<string, unknown>;
  if (previous.id !== next.id || !Array.isArray(previous.parts) || !Array.isArray(next.parts)) return null;
  const ops: SessionPatchOp[] = [];
  const fields: Record<string, unknown> = {}; const remove: string[] = [];
  for (const field of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (field === 'parts') continue;
    if (!settable(field)) return null;
    if (!(field in next)) remove.push(field);
    else if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) fields[field] = next[field];
  }
  if (Object.keys(fields).length || remove.length) ops.push({ op: 'setMessageFields', index, fields, ...(remove.length ? { remove } : {}) });
  const before = previous.parts.map(part => JSON.stringify(part)), after = next.parts.map(part => JSON.stringify(part));
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const deleteCount = before.length - prefix - suffix;
  const inserted = next.parts.slice(prefix, after.length - suffix) as MessagePart[];
  if (deleteCount === 1 && inserted.length === 1) {
    const appended = appendedText(previous.parts[prefix], inserted[0]);
    if (appended) { ops.push({ op: 'appendPartText', index, part: prefix, ...appended }); return ops; }
  }
  if (deleteCount > 0 || inserted.length > 0) ops.push({ op: 'spliceParts', index, start: prefix, deleteCount, parts: inserted });
  return ops;
}

/** The text one field of a part gained, when that is the part's only change. */
function appendedText(previous: unknown, next: unknown): { field: string; text: string } | null {
  if (!plain(previous) || !plain(next)) return null;
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(previous).length) return null;
  let grown: { field: string; text: string } | null = null;
  for (const field of keys) {
    if (!Object.hasOwn(previous, field)) return null;
    const before = previous[field], after = next[field];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (grown || !settable(field) || typeof before !== 'string' || typeof after !== 'string' || !after.startsWith(before)) return null;
    grown = { field, text: after.slice(before.length) };
  }
  return grown;
}
