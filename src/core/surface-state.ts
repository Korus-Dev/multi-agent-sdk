import type {
  CodexSurfaceSnapshot,
  CodexSurfaceStateChange,
  CodexSurfaceStatePatch,
  CodexVersionedSurfaceSnapshot,
} from './surface';

type Awaitable<Value> = Value | Promise<Value>;
type KeyedItem = { id: string };
type SnapshotRecord = Record<string, unknown>;

/**
 * A state source that can serve a versioned base snapshot and the patches that
 * follow it. `getVersionedSnapshot` resolves null when the other side of a
 * transport cannot stream patches; consumers then use `onStateChange`.
 */
export type CodexSurfaceStatePatchSource = {
  getVersionedSnapshot(): Awaitable<CodexVersionedSurfaceSnapshot | null>;
  onStatePatch(listener: (patch: CodexSurfaceStatePatch) => void): () => void;
};

export type SubscribeCodexSurfaceStateOptions = {
  /**
   * Whether to notify with the base snapshot once it arrives. Defaults to
   * true. Turn it off when another channel already delivered that state.
   */
  emitInitialSnapshot?: boolean;
};

export type CodexSurfaceStateSource =
  | CodexSurfaceStatePatchSource
  | (Partial<CodexSurfaceStatePatchSource> & {
    onStateChange(listener: (snapshot: CodexSurfaceSnapshot) => void): () => void;
  });

export type CodexSurfaceStateMirrorResult =
  | { status: 'applied'; snapshot: CodexSurfaceSnapshot }
  | { status: 'ignored' }
  | { status: 'resync' };

/** Keeps a local snapshot current from a versioned base and sequential patches. */
export type CodexSurfaceStateMirror = {
  readonly snapshot: CodexSurfaceSnapshot | null;
  /** The state version of `snapshot`, or -1 before the first base. */
  readonly version: number;
  /** Adopts an authoritative base, then replays buffered patches that are newer than it. */
  reset(state: CodexVersionedSurfaceSnapshot): CodexSurfaceSnapshot;
  /** Applies the next patch, or buffers it and asks for a new base when the sequence is broken. */
  receive(patch: CodexSurfaceStatePatch): CodexSurfaceStateMirrorResult;
};

const maximumBufferedPatches = 1_000;

export function isCodexSurfaceStatePatchSource(value: unknown): value is CodexSurfaceStatePatchSource {
  const candidate = value as Partial<CodexSurfaceStatePatchSource> | null;
  return typeof candidate?.getVersionedSnapshot === 'function' && typeof candidate.onStatePatch === 'function';
}

/**
 * Describes how `next` differs from `previous` by reference. Arrays whose items
 * all carry unique string ids become `list` changes that ship only the items
 * whose identity changed; everything else is replaced or deleted per key.
 */
export function diffCodexSurfaceState(
  previous: CodexSurfaceSnapshot,
  next: CodexSurfaceSnapshot,
): CodexSurfaceStateChange[] {
  const before = previous as unknown as SnapshotRecord;
  const after = next as unknown as SnapshotRecord;
  const changes: CodexSurfaceStateChange[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const snapshotKey = key as keyof CodexSurfaceSnapshot;
    if (before[key] === after[key]) continue;
    if (!(key in after)) {
      changes.push({ type: 'delete', key: snapshotKey });
      continue;
    }
    changes.push(keyedListChange(snapshotKey, before[key], after[key]) ?? {
      type: 'set',
      key: snapshotKey,
      value: after[key],
    });
  }
  return changes;
}

/** Applies changes to a snapshot without mutating it; unchanged values keep their identity. */
export function applyCodexSurfaceStateChanges(
  snapshot: CodexSurfaceSnapshot,
  changes: readonly CodexSurfaceStateChange[],
): CodexSurfaceSnapshot {
  const current = snapshot as unknown as SnapshotRecord;
  const next: SnapshotRecord = { ...current };
  for (const change of changes) {
    if (change.type === 'delete') {
      delete next[change.key];
    } else if (change.type === 'set') {
      next[change.key] = change.value;
    } else {
      const previous = current[change.key];
      if (!Array.isArray(previous)) throw new Error(`Cannot apply a list patch to non-list state '${change.key}'`);
      const itemsById = new Map((previous as KeyedItem[]).map((item) => [item.id, item]));
      for (const item of change.items) itemsById.set(item.id, item);
      next[change.key] = change.ids.map((id) => {
        const item = itemsById.get(id);
        if (!item) throw new Error(`State patch references unknown '${change.key}' item '${id}'`);
        return item;
      });
    }
  }
  return next as unknown as CodexSurfaceSnapshot;
}

export function createCodexSurfaceStateMirror(): CodexSurfaceStateMirror {
  let snapshot: CodexSurfaceSnapshot | null = null;
  let version = -1;
  let stale = true;
  const pending: CodexSurfaceStatePatch[] = [];

  const buffer = (patch: CodexSurfaceStatePatch): CodexSurfaceStateMirrorResult => {
    stale = true;
    pending.push(patch);
    if (pending.length > maximumBufferedPatches) pending.shift();
    return { status: 'resync' };
  };

  const mirror: CodexSurfaceStateMirror = {
    get snapshot() {
      return snapshot;
    },
    get version() {
      return version;
    },
    reset(state) {
      snapshot = state.snapshot;
      version = state.version;
      stale = false;
      const replay = pending.splice(0).sort((left, right) => left.version - right.version);
      for (const patch of replay) {
        if (mirror.receive(patch).status === 'resync') break;
      }
      return snapshot;
    },
    receive(patch) {
      if (stale || !snapshot) return buffer(patch);
      if (patch.version <= version) return { status: 'ignored' };
      if (patch.version !== version + 1) return buffer(patch);
      try {
        snapshot = applyCodexSurfaceStateChanges(snapshot, patch.changes);
      } catch {
        return buffer(patch);
      }
      version = patch.version;
      return { status: 'applied', snapshot };
    },
  };
  return mirror;
}

/**
 * Subscribes to surface state, mirroring patches locally when the source
 * supports them. Unchanged messages, turns, and other keyed items keep their
 * object identity between notifications, so UI frameworks can skip them.
 * Falls back to full `onStateChange` snapshots when the source has no patch
 * members or reports that patches are unavailable.
 */
export function subscribeCodexSurfaceState(
  source: CodexSurfaceStateSource,
  listener: (snapshot: CodexSurfaceSnapshot) => void,
  options: SubscribeCodexSurfaceStateOptions = {},
): () => void {
  const subscribeToSnapshots = () => (
    'onStateChange' in source && typeof source.onStateChange === 'function'
      ? source.onStateChange(listener)
      : () => undefined
  );
  if (!isCodexSurfaceStatePatchSource(source)) return subscribeToSnapshots();
  const mirror = createCodexSurfaceStateMirror();
  let active = true;
  let initialized = false;
  let resyncing = false;
  let unsubscribe: () => void = () => undefined;
  const resync = () => {
    if (resyncing || !active) return;
    resyncing = true;
    void Promise.resolve()
      .then(() => source.getVersionedSnapshot())
      .then((state) => {
        resyncing = false;
        if (!active) return;
        if (!isVersionedSnapshot(state)) {
          if (initialized) return;
          unsubscribe();
          unsubscribe = subscribeToSnapshots();
          return;
        }
        const snapshot = mirror.reset(state);
        // Buffered patches replayed onto the base are changes even when the base itself is not reported.
        const notify = initialized || options.emitInitialSnapshot !== false || mirror.version > state.version;
        initialized = true;
        if (notify) listener(snapshot);
      }, () => {
        resyncing = false;
      });
  };
  unsubscribe = source.onStatePatch((patch) => {
    const result = mirror.receive(patch);
    if (result.status === 'applied') listener(result.snapshot);
    else if (result.status === 'resync') resync();
  });
  resync();
  return () => {
    active = false;
    unsubscribe();
  };
}

function keyedListChange(
  key: keyof CodexSurfaceSnapshot,
  before: unknown,
  after: unknown,
): CodexSurfaceStateChange | null {
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  const previousById = new Map<string, unknown>();
  for (const item of before) {
    if (!isKeyedItem(item) || previousById.has(item.id)) return null;
    previousById.set(item.id, item);
  }
  const ids: string[] = [];
  const items: KeyedItem[] = [];
  const seen = new Set<string>();
  for (const item of after) {
    if (!isKeyedItem(item) || seen.has(item.id)) return null;
    seen.add(item.id);
    ids.push(item.id);
    if (previousById.get(item.id) !== item) items.push(item);
  }
  // Replacing the whole list is smaller when nothing can be reused.
  return items.length === after.length ? null : { type: 'list', key, ids, items };
}

function isVersionedSnapshot(value: unknown): value is CodexVersionedSurfaceSnapshot {
  const candidate = value as Partial<CodexVersionedSurfaceSnapshot> | null | undefined;
  return Number.isSafeInteger(candidate?.version)
    && Boolean(candidate?.snapshot)
    && typeof candidate?.snapshot === 'object';
}

function isKeyedItem(value: unknown): value is KeyedItem {
  return Boolean(value) && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string';
}
