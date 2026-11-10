export type CodexAppBackendTtlCacheEvictionContext = {
  readonly id: string;
  readonly lastActivityAt: number;
  readonly now: number;
  readonly idleForMs: number;
};

export type CodexAppBackendTtlCacheRecord<Value> = {
  readonly value: Value;
  readonly lastActivityAt: number;
};

export type CodexAppBackendTtlTimer = {
  unref?: () => void;
};

export type CodexAppBackendTtlCacheScheduler = {
  set(callback: () => void, delayMs: number): CodexAppBackendTtlTimer;
  clear(timer: CodexAppBackendTtlTimer): void;
};

export type CodexAppBackendTtlCacheOptions<Value> = {
  /** Time without a newer activity touch before an entry becomes eligible. */
  ttlMs: number;
  /** Enables periodic sweeps. Omit it to use manual `sweep()` calls only. */
  sweepIntervalMs?: number | null;
  identity: (value: Value) => string;
  canEvict: (value: Value, context: CodexAppBackendTtlCacheEvictionContext) => boolean | Promise<boolean>;
  onEvict: (value: Value, context: CodexAppBackendTtlCacheEvictionContext) => void | Promise<void>;
  now?: () => number;
  scheduler?: CodexAppBackendTtlCacheScheduler;
  onEvictionError?: (
    error: unknown,
    value: Value,
    context: CodexAppBackendTtlCacheEvictionContext,
  ) => void | Promise<void>;
};

type TtlCacheRecord<Value> = {
  value: Value;
  lastActivityAt: number;
};

const defaultScheduler: CodexAppBackendTtlCacheScheduler = {
  set(callback, delayMs) {
    return setTimeout(callback, delayMs) as unknown as CodexAppBackendTtlTimer;
  },
  clear(timer) {
    clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
  },
};

/**
 * Host-owned cache metadata with an optional, unref'd periodic eviction loop.
 * The cache never decides whether an entry is safe to remove; `canEvict` and
 * `onEvict` remain application-owned policies and storage operations.
 */
export class CodexAppBackendTtlCache<Value> {
  private readonly records = new Map<string, TtlCacheRecord<Value>>();
  private readonly now: () => number;
  private readonly scheduler: CodexAppBackendTtlCacheScheduler;
  private readonly sweepIntervalMs: number | null;
  private timer: CodexAppBackendTtlTimer | null = null;
  private activeSweep: Promise<readonly string[]> | null = null;
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: CodexAppBackendTtlCacheOptions<Value>) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('Codex backend cache ttlMs must be greater than zero');
    }
    if (options.sweepIntervalMs !== undefined && options.sweepIntervalMs !== null
      && (!Number.isFinite(options.sweepIntervalMs) || options.sweepIntervalMs <= 0)) {
      throw new Error('Codex backend cache sweepIntervalMs must be greater than zero');
    }
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.sweepIntervalMs = options.sweepIntervalMs ?? null;
  }

  get size(): number {
    return this.records.size;
  }

  set(value: Value, activityAt = this.now()): string {
    this.assertOpen();
    const id = this.requireIdentity(value);
    const previous = this.records.get(id);
    this.records.set(id, {
      value,
      lastActivityAt: previous ? Math.max(previous.lastActivityAt, activityAt) : activityAt,
    });
    this.schedule();
    return id;
  }

  get(id: string): Value | undefined {
    return this.records.get(id)?.value;
  }

  getRecord(id: string): CodexAppBackendTtlCacheRecord<Value> | undefined {
    const record = this.records.get(id);
    return record
      ? { value: record.value, lastActivityAt: record.lastActivityAt }
      : undefined;
  }

  touch(id: string, activityAt = this.now()): boolean {
    this.assertOpen();
    const record = this.records.get(id);
    if (!record) return false;
    record.lastActivityAt = Math.max(record.lastActivityAt, activityAt);
    return true;
  }

  delete(id: string): boolean {
    this.assertOpen();
    const deleted = this.records.delete(id);
    if (this.records.size === 0) this.clearTimer();
    return deleted;
  }

  async sweep(): Promise<readonly string[]> {
    if (this.closed) return [];
    if (this.activeSweep) return this.activeSweep;
    const sweep = this.evictExpired();
    this.activeSweep = sweep;
    try {
      return await sweep;
    } finally {
      this.activeSweep = null;
      this.schedule();
    }
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.clearTimer();
      this.closePromise = Promise.resolve(this.activeSweep).then(() => undefined);
    }
    await this.closePromise;
  }

  private async evictExpired(): Promise<readonly string[]> {
    const now = this.now();
    const evicted: string[] = [];
    for (const [id, record] of [...this.records.entries()]) {
      const idleForMs = now - record.lastActivityAt;
      if (idleForMs < this.options.ttlMs) continue;
      const context: CodexAppBackendTtlCacheEvictionContext = {
        id,
        lastActivityAt: record.lastActivityAt,
        now,
        idleForMs,
      };
      let safeToEvict: boolean;
      try {
        safeToEvict = await this.options.canEvict(record.value, context);
      } catch (error) {
        await this.reportEvictionError(error, record.value, context);
        continue;
      }
      if (!safeToEvict || this.records.get(id) !== record) continue;
      try {
        await this.options.onEvict(record.value, context);
      } catch (error) {
        await this.reportEvictionError(error, record.value, context);
        continue;
      }
      if (this.records.get(id) === record) {
        this.records.delete(id);
        evicted.push(id);
      }
    }
    return evicted;
  }

  private schedule(): void {
    if (this.closed || this.timer || this.records.size === 0 || this.sweepIntervalMs === null) return;
    this.timer = this.scheduler.set(() => {
      this.timer = null;
      void this.sweep();
    }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.scheduler.clear(this.timer);
    this.timer = null;
  }

  private async reportEvictionError(
    error: unknown,
    value: Value,
    context: CodexAppBackendTtlCacheEvictionContext,
  ): Promise<void> {
    const onEvictionError = this.options.onEvictionError;
    if (!onEvictionError) return;
    try {
      await onEvictionError(error, value, context);
    } catch {
      // Error reporting must not strand the periodic eviction loop.
    }
  }

  private requireIdentity(value: Value): string {
    const id = this.options.identity(value);
    if (!id.trim()) throw new Error('Codex backend cache identities cannot be empty');
    return id;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Codex backend cache is closed');
  }
}
