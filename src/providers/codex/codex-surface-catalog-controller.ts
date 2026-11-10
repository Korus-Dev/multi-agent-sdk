import { isAbsolute } from 'node:path';
import type { CodexAppServerClient, v2 } from 'codex-sdk';
import type {
  CodexSurfaceApprovalPreset,
  CodexSurfaceEventOrigin,
  CodexSurfaceModel,
  CodexSurfaceSnapshot,
  CodexSurfaceSkill,
  ListCodexModelsOptions,
} from 'multi-agents-sdk/surface';
import {
  boundedImageDataUrl,
  catalogIconMimeType,
  codexModelToSurfaceModel,
  surfacePlugin,
  surfaceSkills,
} from './codex-surface-catalog';
import { reuseUnchangedItems, surfaceRateLimits } from './codex-surface-data';
import type { SurfaceEventInput } from './codex-surface-events';
import {
  approvalPresetsForProfiles,
  defaultReasoningEffort,
  defaultServiceTier,
  selectedModel,
} from './codex-surface-settings';
import type { ListCodexSkillsOptions } from './codex-surface-contracts';
import type { ConversationCatalogs, ThreadRuntimePatch, ThreadRuntimeState } from './codex-surface-runtime';

export type CodexSurfaceCatalogHost = {
  authenticationBlocksBootstrap(): boolean;
  emitConversationSkills(threadId: string, origin: CodexSurfaceEventOrigin): void;
  emitEvent(origin: CodexSurfaceEventOrigin, input: SurfaceEventInput): void;
  ensureConnected(): Promise<void>;
  getState(): CodexSurfaceSnapshot;
  isClosed(): boolean;
  patch(patch: Partial<CodexSurfaceSnapshot>): void;
  patchRuntime(threadId: string, patch: ThreadRuntimePatch): void;
  preferredApprovalPreset(): CodexSurfaceApprovalPreset | null;
  runtimes(): Iterable<ThreadRuntimeState>;
};

export class CodexSurfaceCatalogController {
  private readonly iconDataUrls = new Map<string, Promise<string | undefined>>();
  private readonly skillsByCwd = new Map<string | null, Pick<ConversationCatalogs, 'skills' | 'skillCatalogStatus'>>();
  private readonly skillRequests = new Map<string | null, Promise<CodexSurfaceSkill[]>>();
  private skillRevision = 0;
  private pluginPromise: Promise<void> | null = null;
  private pluginLastAttemptedCwdsKey: string | null = null;
  private pluginRefreshRequested = false;

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly cwd: string | undefined,
    private readonly host: CodexSurfaceCatalogHost,
  ) {}

  reset(pluginRefreshRequested: boolean): void {
    this.iconDataUrls.clear();
    this.skillsByCwd.clear();
    this.skillRequests.clear();
    this.skillRevision += 1;
    this.pluginLastAttemptedCwdsKey = null;
    this.pluginRefreshRequested = pluginRefreshRequested;
  }

  async listModels(options: ListCodexModelsOptions = {}): Promise<CodexSurfaceModel[]> {
    await this.host.ensureConnected();
    const includeHidden = options.includeHidden ?? false;
    const forceReload = options.forceReload ?? true;
    const state = this.host.getState();
    if (!forceReload && !includeHidden && state.modelCatalogStatus === 'loaded') {
      return structuredClone(state.models);
    }
    const models = await this.requestModels(includeHidden);
    if (!includeHidden) this.applyModels(models, 'action');
    return structuredClone(models);
  }

  async loadModels(): Promise<void> {
    this.host.patch({ modelCatalogStatus: 'loading' });
    this.emitModels([], 'loading');
    try {
      this.applyModels(await this.requestModels(false), 'action');
    } catch {
      this.host.patch({ modelCatalogStatus: 'error', models: [] });
      this.emitModels([], 'error');
    }
  }

  async loadSkills(forceReload = false, origin: CodexSurfaceEventOrigin = 'action'): Promise<void> {
    if (forceReload) this.iconDataUrls.clear();
    this.host.patch({ skillCatalogStatus: 'loading' });
    this.emitSkills(this.cwd ?? null, [], 'loading', origin);
    try {
      const response = await this.client.request('skills/list', {
        ...(this.cwd ? { cwds: [this.cwd] } : {}), forceReload,
      });
      const skills = await surfaceSkills(
        response.data.flatMap((entry) => entry.skills),
        (path) => this.iconDataUrl(path),
      );
      this.host.patch({ skills, skillCatalogStatus: 'loaded' });
      this.skillsByCwd.set(this.cwd ?? null, { skills, skillCatalogStatus: 'loaded' });
      this.emitSkills(this.cwd ?? null, skills, 'loaded', origin);
    } catch {
      this.host.patch({ skills: [], skillCatalogStatus: 'error' });
      this.emitSkills(this.cwd ?? null, [], 'error', origin);
    }
  }

  async listSkills(options: ListCodexSkillsOptions = {}): Promise<CodexSurfaceSkill[]> {
    await this.host.ensureConnected();
    const key = options.cwd ?? null;
    const pending = this.skillRequests.get(key);
    if (pending) return structuredClone(await pending);
    const cached = this.skillsByCwd.get(key);
    if (!options.forceReload && cached?.skillCatalogStatus === 'loaded') return structuredClone(cached.skills);
    if (options.forceReload) this.iconDataUrls.clear();
    const revision = this.skillRevision;
    this.publishSkills(key, [], 'loading', 'action');
    const request = (async () => {
      try {
        const response = await this.client.request('skills/list', {
          ...(options.cwd ? { cwds: [options.cwd] } : {}), forceReload: options.forceReload ?? false,
        });
        const skills = await surfaceSkills(response.data.flatMap((entry) => entry.skills), (path) => this.iconDataUrl(path));
        if (revision !== this.skillRevision) throw new Error('Skill discovery was invalidated; retry the request');
        this.skillsByCwd.set(key, { skills, skillCatalogStatus: 'loaded' });
        this.publishSkills(key, skills, 'loaded', 'action');
        return skills;
      } catch (error) {
        if (revision === this.skillRevision) this.publishSkills(key, [], 'error', 'action');
        throw error;
      }
    })();
    this.skillRequests.set(key, request);
    try { return structuredClone(await request); }
    finally { if (this.skillRequests.get(key) === request) this.skillRequests.delete(key); }
  }

  invalidateSkills(): void {
    const discoveredScopes = new Set([...this.skillsByCwd.keys(), ...this.skillRequests.keys()]);
    this.skillRevision += 1;
    this.skillsByCwd.clear();
    this.skillRequests.clear();
    this.iconDataUrls.clear();
    this.host.patch({ skills: [], skillCatalogStatus: 'notLoaded' });
    this.emitSkills(this.cwd ?? null, [], 'notLoaded', 'notification');
    for (const runtime of this.host.runtimes()) {
      this.host.patchRuntime(runtime.threadId, { skills: [], skillCatalogStatus: 'notLoaded' });
      this.host.emitConversationSkills(runtime.threadId, 'notification');
    }
    // Keep catalogs already requested by clients fresh without discovering any
    // unopened workspace. Older renderer clients rely on pushed refreshes.
    for (const cwd of discoveredScopes) {
      void this.listSkills({ ...(cwd ? { cwd } : {}), forceReload: true }).catch(() => undefined);
    }
  }

  async loadPermissionProfiles(): Promise<void> {
    try {
      const profiles = await this.requestPermissionProfiles(this.cwd);
      const requirements = (await this.client.request('configRequirements/read', undefined)).requirements;
      const approvalPresets = approvalPresetsForProfiles(profiles, requirements);
      const preferred = this.host.preferredApprovalPreset();
      this.host.patch({
        permissionProfiles: profiles,
        approvalPresets,
        approvalPreset: preferred
          ? (approvalPresets.includes(preferred) ? preferred : approvalPresets[0] ?? null)
          : null,
      });
      this.emitPermissions(this.cwd ?? null, profiles, approvalPresets);
    } catch {
      this.host.patch({ permissionProfiles: [], approvalPresets: [], approvalPreset: null });
      this.emitPermissions(this.cwd ?? null, [], []);
    }
  }

  async loadRateLimits(): Promise<void> {
    try {
      const rateLimits = surfaceRateLimits(
        await this.client.request('account/rateLimits/read', undefined),
      );
      this.host.patch({ rateLimits });
      this.host.emitEvent('action', {
        type: 'rateLimits.changed', payload: { rateLimits: structuredClone(rateLimits) },
      });
    } catch {
      this.host.patch({ rateLimits: null });
      this.host.emitEvent('action', { type: 'rateLimits.changed', payload: { rateLimits: null } });
    }
  }

  async loadConversationCatalogs(cwd: string | undefined, forceReload = false): Promise<ConversationCatalogs> {
    const state = this.host.getState();
    const skills = this.skillsByCwd.get(cwd ?? null) ?? { skills: [], skillCatalogStatus: 'notLoaded' as const };
    if (!forceReload && cwd === this.cwd) {
      return {
        ...structuredClone(skills),
        permissionProfiles: [...state.permissionProfiles],
        approvalPresets: [...state.approvalPresets],
      };
    }
    const [permissionResult] = await Promise.allSettled([
      (async () => ({
        profiles: await this.requestPermissionProfiles(cwd),
        requirements: (await this.client.request('configRequirements/read', undefined)).requirements,
      }))(),
    ]);
    const permissionProfiles = permissionResult.status === 'fulfilled' ? permissionResult.value.profiles : [];
    return {
      ...structuredClone(skills),
      permissionProfiles,
      approvalPresets: permissionResult.status === 'fulfilled'
        ? approvalPresetsForProfiles(permissionProfiles, permissionResult.value.requirements)
        : [],
    };
  }

  schedulePluginRefresh(force = false): void {
    const state = this.host.getState();
    if (this.host.isClosed() || state.status !== 'ready' || this.host.authenticationBlocksBootstrap()) return;
    const scope = this.pluginScope();
    if (force) {
      this.pluginLastAttemptedCwdsKey = null;
      this.pluginRefreshRequested = true;
    }
    if (this.pluginPromise) return;
    if (!this.pluginRefreshRequested && this.pluginLastAttemptedCwdsKey === scope.key) return;
    this.pluginRefreshRequested = false;
    this.host.patch({ pluginCatalogStatus: 'loading' });
    this.host.emitEvent('action', {
      type: 'catalog.pluginsChanged',
      payload: { plugins: structuredClone(state.plugins), status: 'loading' },
    });
    const loading = this.loadPluginCatalog(scope.cwds, scope.key);
    this.pluginPromise = loading;
    void loading.finally(() => {
      this.pluginPromise = null;
      if (this.pluginRefreshRequested || this.pluginScope().key !== scope.key) this.schedulePluginRefresh();
    }).catch(() => undefined);
  }

  private async requestModels(includeHidden: boolean): Promise<CodexSurfaceModel[]> {
    const models: CodexSurfaceModel[] = [];
    let cursor: string | null | undefined = null;
    do {
      const response: v2.ModelListResponse = await this.client.request('model/list', { cursor, includeHidden });
      models.push(...response.data.map(codexModelToSurfaceModel));
      cursor = response.nextCursor;
    } while (cursor);
    return models;
  }

  private applyModels(models: CodexSurfaceModel[], origin: CodexSurfaceEventOrigin): void {
    const selected = selectedModel(models, this.host.getState().selectedModelId);
    this.host.patch({
      models,
      modelCatalogStatus: 'loaded',
      selectedModelId: selected?.id ?? null,
      selectedReasoningEffort: selected ? defaultReasoningEffort(selected) : null,
      selectedServiceTier: selected ? defaultServiceTier(selected) : null,
    });
    this.emitModels(models, 'loaded', origin);
  }

  private emitModels(
    models: CodexSurfaceModel[],
    status: CodexSurfaceSnapshot['modelCatalogStatus'],
    origin: CodexSurfaceEventOrigin = 'action',
  ): void {
    this.host.emitEvent(origin, {
      type: 'catalog.modelsChanged', payload: { models: structuredClone(models), status },
    });
  }

  private publishSkills(cwd: string | null, skills: CodexSurfaceSkill[], status: CodexSurfaceSnapshot['skillCatalogStatus'], origin: CodexSurfaceEventOrigin): void {
    const activeId = this.host.getState().activeConversationId;
    if (!activeId) this.host.patch({ skills, skillCatalogStatus: status });
    for (const runtime of this.host.runtimes()) {
      if (runtime.cwd !== cwd) continue;
      this.host.patchRuntime(runtime.threadId, { skills, skillCatalogStatus: status });
      this.host.emitConversationSkills(runtime.threadId, origin);
    }
    this.emitSkills(cwd, skills, status, origin);
  }

  private emitSkills(
    cwd: string | null,
    skills: CodexSurfaceSkill[],
    status: CodexSurfaceSnapshot['skillCatalogStatus'],
    origin: CodexSurfaceEventOrigin,
  ): void {
    this.host.emitEvent(origin, {
      type: 'catalog.skillsChanged', payload: { cwd, skills: structuredClone(skills), status },
    });
  }

  private emitPermissions(
    cwd: string | null,
    profiles: CodexSurfaceSnapshot['permissionProfiles'],
    approvalPresets: CodexSurfaceSnapshot['approvalPresets'],
  ): void {
    this.host.emitEvent('action', {
      type: 'catalog.permissionsChanged',
      payload: { cwd, permissionProfiles: structuredClone(profiles), approvalPresets: [...approvalPresets] },
    });
  }

  private async requestPermissionProfiles(cwd: string | undefined) {
    const profiles: CodexSurfaceSnapshot['permissionProfiles'] = [];
    let cursor: string | null | undefined = null;
    do {
      const response: v2.PermissionProfileListResponse = await this.client.request('permissionProfile/list', {
        cursor, ...(cwd ? { cwd } : {}),
      });
      profiles.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return profiles;
  }

  private pluginScope(): { cwds: string[]; key: string } {
    const state = this.host.getState();
    const cwds = [...new Set([
      this.cwd,
      ...state.conversations.map((conversation) => conversation.cwd),
      ...[...this.host.runtimes()].map((runtime) => runtime.cwd ?? undefined),
    ].filter((cwd): cwd is string => typeof cwd === 'string' && cwd.trim().length > 0))].sort();
    return { cwds, key: JSON.stringify(cwds) };
  }

  private async loadPluginCatalog(cwds: readonly string[], key: string): Promise<void> {
    this.pluginLastAttemptedCwdsKey = key;
    try {
      const response = await this.client.request('plugin/installed', {
        ...(cwds.length > 0 ? { cwds: [...cwds] } : {}),
      });
      const summaries = new Map<string, v2.PluginSummary>();
      for (const marketplace of response.marketplaces) {
        for (const plugin of marketplace.plugins) {
          if (!summaries.has(plugin.id)) summaries.set(plugin.id, plugin);
        }
      }
      const plugins = reuseUnchangedItems(this.host.getState().plugins, await Promise.all(
        [...summaries.values()].map((plugin) => surfacePlugin(plugin, (path) => this.iconDataUrl(path))),
      ));
      if (this.host.isClosed() || this.host.authenticationBlocksBootstrap()) return;
      this.host.patch({ plugins, pluginCatalogStatus: 'loaded' });
      this.host.emitEvent('action', {
        type: 'catalog.pluginsChanged', payload: { plugins: structuredClone(plugins), status: 'loaded' },
      });
    } catch {
      if (this.host.isClosed() || this.host.authenticationBlocksBootstrap()) return;
      this.pluginLastAttemptedCwdsKey = null;
      this.host.patch({ pluginCatalogStatus: 'error' });
      this.host.emitEvent('action', {
        type: 'catalog.pluginsChanged',
        payload: { plugins: structuredClone(this.host.getState().plugins), status: 'error' },
      });
    }
  }

  private iconDataUrl(path: string): Promise<string | undefined> {
    const existing = this.iconDataUrls.get(path);
    if (existing) return existing;
    const materialized = this.readIconDataUrl(path);
    this.iconDataUrls.set(path, materialized);
    return materialized;
  }

  private async readIconDataUrl(path: string): Promise<string | undefined> {
    if (!isAbsolute(path)) return undefined;
    const mimeType = catalogIconMimeType(path);
    if (!mimeType) return undefined;
    try {
      const response = await this.client.request('fs/readFile', { path });
      return boundedImageDataUrl(mimeType, response.dataBase64);
    } catch {
      return undefined;
    }
  }
}
