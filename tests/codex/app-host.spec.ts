import { describe, expect, it, vi } from 'vitest';
import { CodexHost } from '../../src/providers/codex/host';
import {
  createCodexAppHost,
} from '../../src/providers/codex';
import type { TtlCacheScheduler, TtlCacheTimer } from '../../src/core/ttl-cache';

describe('CodexAppHost', () => {
  it('creates app modules over one shared host and exposes them by namespace', () => {
    const host = new CodexHost();
    const create = vi.fn(({ host: moduleHost }) => ({ host: moduleHost, kind: 'teams' }));
    const provider = createCodexAppHost({
      host,
      modules: [{ id: 'app.teams', create }],
    });

    expect(provider.host).toBe(host);
    expect(provider.module<{ host: CodexHost; kind: string }>('app.teams')).toStrictEqual({
      host,
      kind: 'teams',
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it('rejects ambiguous configuration and duplicate or missing module IDs', () => {
    const host = new CodexHost();
    const create = vi.fn(() => null);
    expect(() => createCodexAppHost({ host, hostOptions: {} })).toThrow('either host or hostOptions');
    expect(() => createCodexAppHost({
      host,
      modules: [
        { id: ' app ', create },
        { id: 'app', create: () => null },
      ],
    })).toThrow("Duplicate Codex module 'app'");
    expect(create).not.toHaveBeenCalled();
    expect(() => createCodexAppHost({
      host,
      modules: [{ id: '   ', create }],
    })).toThrow('Codex module IDs cannot be empty');
    expect(() => createCodexAppHost({ host }).module('missing')).toThrow("Unknown Codex module 'missing'");
  });

  it('normalizes module lookup and exposes working cache and close helpers', async () => {
    const host = new CodexHost();
    const closeHost = vi.spyOn(host, 'close').mockResolvedValue();
    const provider = createCodexAppHost({
      host,
      modules: [{
        id: ' app.worker ',
        create: ({ closeProvider, createTtlCache }) => ({ closeProvider, createTtlCache }),
      }],
    });
    const module = provider.module<{
      closeProvider(): Promise<void>;
      createTtlCache: typeof provider.createTtlCache;
    }>(' app.worker ');
    const cache = module.createTtlCache({
      ttlMs: 100,
      identity: (value: { id: string }) => value.id,
      canEvict: () => true,
      onEvict: () => undefined,
    });
    const closeCache = vi.spyOn(cache, 'close');

    const closing = module.closeProvider();
    expect(closing).toBe(provider.close());
    await closing;
    expect(closeCache).toHaveBeenCalledOnce();
    expect(closeHost).toHaveBeenCalledOnce();
    expect(() => provider.createTtlCache({
      ttlMs: 100,
      identity: (value: { id: string }) => value.id,
      canEvict: () => true,
      onEvict: () => undefined,
    })).toThrow('Cannot create a cache after the Codex harness is closed');
  });

  it('shares one idempotent close operation with modules', async () => {
    const host = new CodexHost();
    const close = vi.spyOn(host, 'close').mockResolvedValue();
    const provider = createCodexAppHost({
      host,
      modules: [{ id: 'app', create: ({ closeProvider }) => ({ closeProvider }) }],
    });
    const module = provider.module<{ closeProvider(): Promise<void> }>('app');

    await Promise.all([module.closeProvider(), provider.close()]);

    expect(close).toHaveBeenCalledOnce();
  });

  it('tracks the greatest activity timestamp and evicts only after the TTL', async () => {
    let now = 0;
    const canEvict = vi.fn(() => true);
    const onEvict = vi.fn();
    const provider = createCodexAppHost({ host: new CodexHost() });
    const cache = provider.createTtlCache({
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
    await provider.close();
  });

  it('keeps entries when the host says they are unsafe and supports async eviction', async () => {
    let now = 1000;
    let safe = false;
    const onEvict = vi.fn(async () => undefined);
    const provider = createCodexAppHost({ host: new CodexHost() });
    const cache = provider.createTtlCache({
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
    await provider.close();
  });

  it('uses an injectable unref scheduler and closes its timer cleanly', async () => {
    const timers: Array<{ callback: () => void; handle: TtlCacheTimer }> = [];
    const scheduler: TtlCacheScheduler = {
      set: vi.fn((callback) => {
        const handle = { unref: vi.fn() };
        timers.push({ callback, handle });
        return handle;
      }),
      clear: vi.fn(),
    };
    const provider = createCodexAppHost({ host: new CodexHost() });
    const cache = provider.createTtlCache({
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
    await provider.close();
    expect(scheduler.clear).toHaveBeenCalledWith(timers[0]!.handle);
  });
});
