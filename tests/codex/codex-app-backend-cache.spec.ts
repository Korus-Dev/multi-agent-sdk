import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexAppBackendTtlCache,
  type CodexAppBackendTtlCacheOptions,
  type CodexAppBackendTtlCacheScheduler,
  type CodexAppBackendTtlTimer,
} from '../../src/providers/codex';

type Value = { id: string; version?: number };

function options(
  overrides: Partial<CodexAppBackendTtlCacheOptions<Value>> = {},
): CodexAppBackendTtlCacheOptions<Value> {
  return {
    ttlMs: 100,
    identity: (value) => value.id,
    canEvict: () => true,
    onEvict: () => undefined,
    now: () => 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function schedulerHarness() {
  const scheduled: Array<{ callback: () => void; delayMs: number; timer: CodexAppBackendTtlTimer }> = [];
  const scheduler: CodexAppBackendTtlCacheScheduler = {
    set: vi.fn((callback, delayMs) => {
      const timer = { unref: vi.fn() };
      scheduled.push({ callback, delayMs, timer });
      return timer;
    }),
    clear: vi.fn(),
  };
  return { scheduled, scheduler };
}

describe('CodexAppBackendTtlCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid ttl %s', (ttlMs) => {
    expect(() => new CodexAppBackendTtlCache(options({ ttlMs }))).toThrow(
      'Codex backend cache ttlMs must be greater than zero',
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid sweep interval %s',
    (sweepIntervalMs) => {
      expect(() => new CodexAppBackendTtlCache(options({ sweepIntervalMs }))).toThrow(
        'Codex backend cache sweepIntervalMs must be greater than zero',
      );
    },
  );

  it.each([undefined, null])('supports manual sweeping when the interval is %s', async (sweepIntervalMs) => {
    const scheduler = schedulerHarness();
    const cache = new CodexAppBackendTtlCache(options({ scheduler: scheduler.scheduler, sweepIntervalMs }));

    cache.set({ id: 'manual' });
    await cache.sweep();
    await cache.close();

    expect(scheduler.scheduler.set).not.toHaveBeenCalled();
    expect(scheduler.scheduler.clear).not.toHaveBeenCalled();
  });

  it('stores replacement values while preserving the greatest activity time', () => {
    const cache = new CodexAppBackendTtlCache(options());
    const first = { id: 'entry', version: 1 };
    const replacement = { id: 'entry', version: 2 };

    expect(cache.set(first, 20)).toBe('entry');
    cache.set(replacement, 10);

    expect(cache.size).toBe(1);
    expect(cache.get('entry')).toBe(replacement);
    expect(cache.getRecord('entry')).toStrictEqual({ value: replacement, lastActivityAt: 20 });
    expect(cache.getRecord('missing')).toBeUndefined();
  });

  it('uses the clock for set and touch and never moves activity backwards', () => {
    let now = 10;
    const cache = new CodexAppBackendTtlCache(options({ now: () => now }));
    cache.set({ id: 'entry' });
    now = 30;
    expect(cache.touch('entry')).toBe(true);
    expect(cache.touch('missing')).toBe(false);
    expect(cache.touch('entry', 20)).toBe(true);

    expect(cache.getRecord('entry')?.lastActivityAt).toBe(30);
  });

  it.each(['', '   ', '\n\t'])('rejects an empty identity %#', (id) => {
    const cache = new CodexAppBackendTtlCache(options());
    expect(() => cache.set({ id })).toThrow('Codex backend cache identities cannot be empty');
    expect(cache.size).toBe(0);
  });

  it('deletes entries and clears the periodic timer only after the final deletion', () => {
    const harness = schedulerHarness();
    const cache = new CodexAppBackendTtlCache(options({ scheduler: harness.scheduler, sweepIntervalMs: 10 }));
    cache.set({ id: 'one' });
    cache.set({ id: 'two' });

    expect(cache.delete('missing')).toBe(false);
    expect(cache.delete('one')).toBe(true);
    expect(harness.scheduler.clear).not.toHaveBeenCalled();
    expect(cache.delete('two')).toBe(true);
    expect(harness.scheduler.clear).toHaveBeenCalledWith(harness.scheduled[0]?.timer);
  });

  it('evicts every expired safe record in insertion order with exact contexts', async () => {
    const canEvict = vi.fn((_value: Value) => true);
    const onEvict = vi.fn();
    const cache = new CodexAppBackendTtlCache(options({ canEvict, onEvict, now: () => 250 }));
    cache.set({ id: 'fresh' }, 151);
    cache.set({ id: 'first' }, 100);
    cache.set({ id: 'second' }, 120);

    await expect(cache.sweep()).resolves.toStrictEqual(['first', 'second']);
    expect(canEvict.mock.calls.map(([value]) => value.id)).toStrictEqual(['first', 'second']);
    expect(onEvict).toHaveBeenNthCalledWith(1, { id: 'first' }, {
      id: 'first', lastActivityAt: 100, now: 250, idleForMs: 150,
    });
    expect(cache.get('fresh')).toStrictEqual({ id: 'fresh' });
  });

  it('coalesces concurrent sweeps and schedules once after the active sweep finishes', async () => {
    const gate = deferred<boolean>();
    const harness = schedulerHarness();
    const canEvict = vi.fn(() => gate.promise);
    const cache = new CodexAppBackendTtlCache(options({
      canEvict, now: () => 100, scheduler: harness.scheduler, sweepIntervalMs: 10,
    }));
    cache.set({ id: 'entry' }, 0);
    const first = cache.sweep();
    const second = cache.sweep();
    gate.resolve(false);

    await expect(Promise.all([first, second])).resolves.toStrictEqual([[], []]);
    expect(canEvict).toHaveBeenCalledOnce();
    expect(harness.scheduler.set).toHaveBeenCalledOnce();
  });

  it('does not remove a record replaced while canEvict is pending', async () => {
    const gate = deferred<boolean>();
    let now = 100;
    const original = { id: 'entry', version: 1 };
    const replacement = { id: 'entry', version: 2 };
    const onEvict = vi.fn();
    const cache = new CodexAppBackendTtlCache(options({
      canEvict: () => gate.promise, onEvict, now: () => now,
    }));
    cache.set(original, 0);
    const sweeping = cache.sweep();
    now = 200;
    cache.set(replacement);
    gate.resolve(true);

    await expect(sweeping).resolves.toStrictEqual([]);
    expect(onEvict).not.toHaveBeenCalled();
    expect(cache.get('entry')).toBe(replacement);
  });

  it('does not delete or report a record replaced while onEvict is pending', async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const original = { id: 'entry', version: 1 };
    const replacement = { id: 'entry', version: 2 };
    const cache = new CodexAppBackendTtlCache(options({
      now: () => 100,
      onEvict: () => {
        started.resolve();
        return gate.promise;
      },
    }));
    cache.set(original, 0);
    const sweeping = cache.sweep();
    await started.promise;
    cache.set(replacement, 100);
    gate.resolve();

    await expect(sweeping).resolves.toStrictEqual([]);
    expect(cache.get('entry')).toBe(replacement);
  });

  it('reports canEvict and onEvict failures, retains entries, and continues the sweep', async () => {
    const canError = new Error('can failed');
    const evictError = new Error('evict failed');
    const onEvictionError = vi.fn();
    const cache = new CodexAppBackendTtlCache(options({
      now: () => 100,
      canEvict: vi.fn((value) => {
        if (value.id === 'can-error') throw canError;
        return true;
      }),
      onEvict: vi.fn((value) => {
        if (value.id === 'evict-error') throw evictError;
      }),
      onEvictionError,
    }));
    cache.set({ id: 'can-error' }, 0);
    cache.set({ id: 'evict-error' }, 0);
    cache.set({ id: 'safe' }, 0);

    await expect(cache.sweep()).resolves.toStrictEqual(['safe']);
    expect(onEvictionError).toHaveBeenNthCalledWith(
      1, canError, { id: 'can-error' }, expect.objectContaining({ id: 'can-error' }),
    );
    expect(onEvictionError).toHaveBeenNthCalledWith(
      2, evictError, { id: 'evict-error' }, expect.objectContaining({ id: 'evict-error' }),
    );
    expect(cache.get('can-error')).toBeDefined();
    expect(cache.get('evict-error')).toBeDefined();
  });

  it('swallows failures from the optional eviction-error reporter and continues', async () => {
    const cache = new CodexAppBackendTtlCache(options({
      now: () => 100,
      canEvict: (value) => {
        if (value.id === 'broken') throw new Error('cannot inspect');
        return true;
      },
      onEvictionError: () => { throw new Error('reporting failed'); },
    }));
    cache.set({ id: 'broken' }, 0);
    cache.set({ id: 'safe' }, 0);

    await expect(cache.sweep()).resolves.toStrictEqual(['safe']);
    expect(cache.get('broken')).toBeDefined();
  });

  it('retains a failed entry when no eviction-error reporter is configured', async () => {
    const cache = new CodexAppBackendTtlCache(options({
      now: () => 100,
      canEvict: () => { throw new Error('cannot inspect'); },
      onEvictionError: undefined,
    }));
    cache.set({ id: 'broken' }, 0);

    await expect(cache.sweep()).resolves.toStrictEqual([]);
    expect(cache.get('broken')).toBeDefined();
  });

  it('runs an unrefed periodic sweep and reschedules while records remain', async () => {
    const harness = schedulerHarness();
    const canEvict = vi.fn(() => false);
    const cache = new CodexAppBackendTtlCache(options({
      canEvict, now: () => 100, scheduler: harness.scheduler, sweepIntervalMs: 25,
    }));
    cache.set({ id: 'entry' }, 0);

    expect(harness.scheduled).toHaveLength(1);
    expect(harness.scheduled[0]?.delayMs).toBe(25);
    expect(harness.scheduled[0]?.timer.unref).toHaveBeenCalledOnce();
    harness.scheduled[0]?.callback();
    await vi.waitFor(() => expect(harness.scheduled).toHaveLength(2));
    expect(canEvict).toHaveBeenCalledOnce();
  });

  it('does not reschedule a periodic sweep after it evicts the final record', async () => {
    const harness = schedulerHarness();
    const onEvict = vi.fn();
    const cache = new CodexAppBackendTtlCache(options({
      now: () => 100, onEvict, scheduler: harness.scheduler, sweepIntervalMs: 25,
    }));
    cache.set({ id: 'entry' }, 0);

    harness.scheduled[0]?.callback();
    await vi.waitFor(() => expect(cache.size).toBe(0));

    expect(onEvict).toHaveBeenCalledOnce();
    expect(harness.scheduled).toHaveLength(1);
  });

  it('supports scheduler handles without unref', () => {
    const scheduler: CodexAppBackendTtlCacheScheduler = {
      set: vi.fn(() => ({})), clear: vi.fn(),
    };
    const cache = new CodexAppBackendTtlCache(options({ scheduler, sweepIntervalMs: 10 }));

    expect(() => cache.set({ id: 'entry' })).not.toThrow();
  });

  it('uses the default scheduler to evict periodically', async () => {
    vi.useFakeTimers();
    let now = 0;
    const onEvict = vi.fn();
    const cache = new CodexAppBackendTtlCache(options({
      ttlMs: 5, sweepIntervalMs: 10, now: () => now, onEvict,
    }));
    cache.set({ id: 'entry' });
    now = 10;

    await vi.advanceTimersByTimeAsync(10);

    expect(onEvict).toHaveBeenCalledOnce();
    expect(cache.size).toBe(0);
    await cache.close();
  });

  it('cancels a pending default-scheduler timer when closed', async () => {
    vi.useFakeTimers();
    const cache = new CodexAppBackendTtlCache(options({ sweepIntervalMs: 10 }));
    cache.set({ id: 'entry' });
    expect(vi.getTimerCount()).toBe(1);

    await cache.close();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes idempotently, waits for an active sweep, and rejects later mutations', async () => {
    const gate = deferred<boolean>();
    const harness = schedulerHarness();
    const canEvict = vi.fn(() => gate.promise);
    const cache = new CodexAppBackendTtlCache(options({
      canEvict, now: () => 100,
      scheduler: harness.scheduler, sweepIntervalMs: 10,
    }));
    cache.set({ id: 'entry' }, 0);
    const sweeping = cache.sweep();
    const firstClose = cache.close();
    const secondClose = cache.close();
    let closed = false;
    void firstClose.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    gate.resolve(false);
    await Promise.all([sweeping, firstClose, secondClose]);

    expect(harness.scheduler.clear).toHaveBeenCalledOnce();
    expect(await cache.sweep()).toStrictEqual([]);
    expect(canEvict).toHaveBeenCalledOnce();
    expect(() => cache.set({ id: 'later' })).toThrow('Codex backend cache is closed');
    expect(() => cache.touch('entry')).toThrow('Codex backend cache is closed');
    expect(() => cache.delete('entry')).toThrow('Codex backend cache is closed');
    expect(cache.get('entry')).toStrictEqual({ id: 'entry' });
  });
});
