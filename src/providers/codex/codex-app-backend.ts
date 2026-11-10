import { CodexSurface } from './codex-surface';
import {
  CodexAppBackendTtlCache,
  type CodexAppBackendTtlCacheOptions,
} from './codex-app-backend-cache';
import type { CodexSurfaceOptions } from './codex-surface-contracts';

export type CodexAppBackendModuleContext = {
  surface: CodexSurface;
  closeBackend(): Promise<void>;
  createTtlCache<Value>(options: CodexAppBackendTtlCacheOptions<Value>): CodexAppBackendTtlCache<Value>;
};

export type CodexAppBackendModule<Service = unknown> = {
  id: string;
  create(context: CodexAppBackendModuleContext): Service;
};

export type CodexAppBackendOptions = {
  modules?: readonly CodexAppBackendModule[];
  surface?: CodexSurface;
  surfaceOptions?: CodexSurfaceOptions;
};

/**
 * Composable, in-process backend host for Codex applications.
 *
 * The SDK owns the product-neutral Codex runtime while modules own application
 * services such as agents, teams, or work integrations. Transport and process
 * ownership stay with the embedding application.
 */
export class CodexAppBackend {
  readonly surface: CodexSurface;
  private readonly moduleServices = new Map<string, unknown>();
  private readonly ttlCaches = new Set<{ close(): Promise<void> }>();
  private closePromise: Promise<void> | null = null;

  constructor(options: CodexAppBackendOptions = {}) {
    if (options.surface && options.surfaceOptions) {
      throw new Error('Provide either surface or surfaceOptions, not both');
    }
    const modules = (options.modules ?? []).map((module) => ({ id: module.id.trim(), module }));
    const moduleIds = new Set<string>();
    for (const { id } of modules) {
      if (!id) throw new Error('Codex backend module IDs cannot be empty');
      if (moduleIds.has(id)) throw new Error(`Duplicate Codex backend module '${id}'`);
      moduleIds.add(id);
    }
    this.surface = options.surface ?? new CodexSurface(options.surfaceOptions);
    for (const { id, module } of modules) {
      this.moduleServices.set(id, module.create({
        surface: this.surface,
        closeBackend: () => this.close(),
        createTtlCache: (cacheOptions) => this.createTtlCache(cacheOptions),
      }));
    }
  }

  module<Service>(id: string): Service {
    const normalizedId = id.trim();
    if (!this.moduleServices.has(normalizedId)) throw new Error(`Unknown Codex backend module '${normalizedId}'`);
    return this.moduleServices.get(normalizedId) as Service;
  }

  createTtlCache<Value>(options: CodexAppBackendTtlCacheOptions<Value>): CodexAppBackendTtlCache<Value> {
    if (this.closePromise) throw new Error('Cannot create a cache after the Codex backend is closed');
    const cache = new CodexAppBackendTtlCache(options);
    this.ttlCaches.add(cache);
    return cache;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    await Promise.all([...this.ttlCaches].map((cache) => cache.close()));
    await this.surface.close();
  }
}

export function createCodexAppBackend(options: CodexAppBackendOptions = {}): CodexAppBackend {
  return new CodexAppBackend(options);
}
