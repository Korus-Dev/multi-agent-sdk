import { describe, expect, it, vi } from 'vitest';
import { CodexSurface } from '../../src/providers/codex/codex-surface';
import {
  createCodexAppBackend,
  type CodexAppBackendTtlCacheScheduler,
  type CodexAppBackendTtlTimer,
} from '../../src/providers/codex';

describe('CodexAppBackend', () => {
  it('creates app modules over one shared surface and exposes them by namespace', () => {
    const surface = new CodexSurface();
    const create = vi.fn(({ surface: moduleSurface }) => ({ surface: moduleSurface, kind: 'teams' }));
    const backend = createCodexAppBackend({
      surface,
      modules: [{ id: 'app.teams', create }],
    });

    expect(backend.surface).toBe(surface);
    expect(backend.module<{ surface: CodexSurface; kind: string }>('app.teams')).toStrictEqual({
      surface,
      kind: 'teams',
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it('rejects ambiguous configuration and duplicate or missing module IDs', () => {
    const surface = new CodexSurface();
    const create = vi.fn(() => null);
    expect(() => createCodexAppBackend({ surface, surfaceOptions: {} })).toThrow('either surface or surfaceOptions');
    expect(() => createCodexAppBackend({
      surface,
      modules: [
        { id: ' app ', create },
        { id: 'app', create: () => null },
      ],
    })).toThrow("Duplicate Codex backend module 'app'");
    expect(create).not.toHaveBeenCalled();
    expect(() => createCodexAppBackend({
      surface,
      modules: [{ id: '   ', create }],
    })).toThrow('Codex backend module IDs cannot be empty');
    expect(() => createCodexAppBackend({ surface }).module('missing')).toThrow("Unknown Codex backend module 'missing'");
  });

  it('normalizes module lookup and exposes working cache and close helpers', async () => {
    const surface = new CodexSurface();
    const closeSurface = vi.spyOn(surface, 'close').mockResolvedValue();
    const backend = createCodexAppBackend({
      surface,
      modules: [{
        id: ' app.worker ',
        create: ({ closeBackend, createTtlCache }) => ({ closeBackend, createTtlCache }),
      }],
    });
    const module = backend.module<{
      closeBackend(): Promise<void>;
      createTtlCache: typeof backend.createTtlCache;
    }>(' app.worker ');
    const cache = module.createTtlCache({
      ttlMs: 100,
      identity: (value: { id: string }) => value.id,
      canEvict: () => true,
      onEvict: () => undefined,
    });
    const closeCache = vi.spyOn(cache, 'close');

    const closing = module.closeBackend();
    expect(closing).toBe(backend.close());
    await closing;
    expect(closeCache).toHaveBeenCalledOnce();
    expect(closeSurface).toHaveBeenCalledOnce();
    expect(() => backend.createTtlCache({
      ttlMs: 100,
      identity: (value: { id: string }) => value.id,
      canEvict: () => true,
      onEvict: () => undefined,
    })).toThrow('Cannot create a cache after the Codex backend is closed');
  });

  it('shares one idempotent close operation with modules', async () => {
    const surface = new CodexSurface();
    const close = vi.spyOn(surface, 'close').mockResolvedValue();
    const backend = createCodexAppBackend({
      surface,
      modules: [{ id: 'app', create: ({ closeBackend }) => ({ closeBackend }) }],
    });
    const module = backend.module<{ closeBackend(): Promise<void> }>('app');

    await Promise.all([module.closeBackend(), backend.close()]);

    expect(close).toHaveBeenCalledOnce();
  });

  it('tracks the greatest activity timestamp and evicts only after the TTL', async () => {
    let now = 0;
    const canEvict = vi.fn(() => true);
    const onEvict = vi.fn();
    const backend = createCodexAppBackend({ surface: new CodexSurface() });
    const cache = backend.createTtlCache({
      ttlMs: 100,
      identity: (value: { id: string }) => value.id,
      canEvict,
      onEvict,
      now: () => now,
    });

    cache.set({ id: 'agent-a' }, 100);
    cache.touch('agent-a', 90);
    cache.touch('agent-a', 120);
    cache.touch('agent-a', 110);
    expect(cache.getRecord('agent-a')).toMatchObject({ lastActivityAt: 120 });

    now = 219;
    await expect(cache.sweep()).resolves.toStrictEqual([]);
    now = 220;
    await expect(cache.sweep()).resolves.toStrictEqual(['agent-a']);
    expect(canEvict).toHaveBeenCalledOnce();
    expect(onEvict).toHaveBeenCalledWith({ id: 'agent-a' }, expect.objectContaining({
      id: 'agent-a', lastActivityAt: 120, now: 220, idleForMs: 100,
    }));
    expect(cache.get('agent-a')).toBeUndefined();
    await backend.close();
  });

  it('keeps entries when the host says they are unsafe and supports async eviction', async () => {
    let now = 1000;
    let safe = false;
    const onEvict = vi.fn(async () => undefined);
    const backend = createCodexAppBackend({ surface: new CodexSurface() });
    const cache = backend.createTtlCache({
      ttlMs: 10,
      identity: (value: { id: string }) => value.id,
      canEvict: async () => safe,
      onEvict,
      now: () => now,
    });

    cache.set({ id: 'conversation-a' });
    now = 1010;
    await expect(cache.sweep()).resolves.toStrictEqual([]);
    expect(cache.size).toBe(1);
    safe = true;
    await expect(cache.sweep()).resolves.toStrictEqual(['conversation-a']);
    expect(onEvict).toHaveBeenCalledOnce();
    await backend.close();
  });

  it('uses an injectable unref scheduler and closes its timer cleanly', async () => {
    const timers: Array<{ callback: () => void; handle: CodexAppBackendTtlTimer }> = [];
    const scheduler: CodexAppBackendTtlCacheScheduler = {
      set: vi.fn((callback) => {
        const handle = { unref: vi.fn() };
        timers.push({ callback, handle });
        return handle;
      }),
      clear: vi.fn(),
    };
    const backend = createCodexAppBackend({ surface: new CodexSurface() });
    const cache = backend.createTtlCache({
      ttlMs: 100,
      sweepIntervalMs: 25,
      scheduler,
      identity: (value: { id: string }) => value.id,
      canEvict: () => false,
      onEvict: () => undefined,
    });

    cache.set({ id: 'thread-a' });
    expect(scheduler.set).toHaveBeenCalledWith(expect.any(Function), 25);
    expect(timers[0]!.handle.unref).toHaveBeenCalledOnce();
    await backend.close();
    expect(scheduler.clear).toHaveBeenCalledWith(timers[0]!.handle);
  });
});
