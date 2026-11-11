import { CodexHost } from './host';
import {
  TtlCache,
  type TtlCacheOptions,
} from '../../core/ttl-cache';
import type { CodexHostOptions } from './host-contracts';

export type CodexAppHostModuleContext = {
  host: CodexHost;
  closeProvider(): Promise<void>;
  createTtlCache<Value>(options: TtlCacheOptions<Value>): TtlCache<Value>;
};

export type CodexAppHostModule<Service = unknown> = {
  id: string;
  create(context: CodexAppHostModuleContext): Service;
};

export type CodexAppHostOptions = {
  modules?: readonly CodexAppHostModule[];
  host?: CodexHost;
  hostOptions?: CodexHostOptions;
};

/**
 * Composable, in-process backend host for Codex applications.
 *
 * The SDK owns the product-neutral Codex runtime while modules own application
 * services such as agents, teams, or work integrations. Transport and process
 * ownership stay with the embedding application.
 */
export class CodexAppHost {
  readonly host: CodexHost;
  private readonly moduleServices = new Map<string, unknown>();
  private readonly ttlCaches = new Set<{ close(): Promise<void> }>();
  private closePromise: Promise<void> | null = null;

  constructor(options: CodexAppHostOptions = {}) {
    if (options.host && options.hostOptions) {
      throw new Error('Provide either host or hostOptions, not both');
    }
    const modules = (options.modules ?? []).map((module) => ({ id: module.id.trim(), module }));
    const moduleIds = new Set<string>();
    for (const { id } of modules) {
      if (!id) throw new Error('Codex module IDs cannot be empty');
      if (moduleIds.has(id)) throw new Error(`Duplicate Codex module '${id}'`);
      moduleIds.add(id);
    }
    this.host = options.host ?? new CodexHost(options.hostOptions);
    for (const { id, module } of modules) {
      this.moduleServices.set(id, module.create({
        host: this.host,
        closeProvider: () => this.close(),
        createTtlCache: (cacheOptions) => this.createTtlCache(cacheOptions),
      }));
    }
  }

  module<Service>(id: string): Service {
    const normalizedId = id.trim();
    if (!this.moduleServices.has(normalizedId)) throw new Error(`Unknown Codex module '${normalizedId}'`);
    return this.moduleServices.get(normalizedId) as Service;
  }

  createTtlCache<Value>(options: TtlCacheOptions<Value>): TtlCache<Value> {
    if (this.closePromise) throw new Error('Cannot create a cache after the Codex harness is closed');
    const cache = new TtlCache(options);
    this.ttlCaches.add(cache);
    return cache;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    await Promise.all([...this.ttlCaches].map((cache) => cache.close()));
    await this.host.close();
  }
}

export function createCodexAppHost(options: CodexAppHostOptions = {}): CodexAppHost {
  return new CodexAppHost(options);
}
