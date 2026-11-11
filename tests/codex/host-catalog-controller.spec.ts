import { describe, expect, it, vi } from 'vitest';
import type { CodexAppServerClient } from '@korus-dev/codex-sdk';
import type { CodexSnapshot } from '../../src/internal';
import {
  CodexHostCatalogController,
  type CodexHostCatalogDependencies,
} from '../../src/providers/codex/host-catalog-controller';
import { initialAuthentication } from '../../src/providers/codex/host-authentication';
import { createThreadRuntime, initialHostSnapshot } from '../../src/providers/codex/host-runtime';

describe('CodexHostCatalogController', () => {
  it('returns cached models or paginates and applies a fresh selection', async () => {
    const cached = setupCatalog(vi.fn());
    cached.state.models = [{ id: 'cached', model: 'cached', displayName: 'Cached' }];
    cached.state.modelCatalogStatus = 'loaded';
    await expect(cached.controller.listModels({ forceReload: false })).resolves.toStrictEqual(cached.state.models);
    expect(cached.request).not.toHaveBeenCalled();

    const request = vi.fn(async (_method: string, params: { cursor?: string | null }) => params.cursor
      ? { data: [model('default', true)], nextCursor: null }
      : { data: [model('first', false)], nextCursor: 'page-2' });
    const fresh = setupCatalog(request);
    await expect(fresh.controller.listModels()).resolves.toHaveLength(2);
    expect(fresh.state).toMatchObject({
      modelCatalogStatus: 'loaded', selectedModelId: 'default', selectedReasoningEffort: 'medium',
    });
    expect(fresh.host.emitEvent).toHaveBeenCalledWith('action', expect.objectContaining({
      type: 'catalog.modelsChanged', payload: expect.objectContaining({ status: 'loaded' }),
    }));
  });

  it('updates matching conversation skill catalogs and isolates request failures', async () => {
    const skill = {
      name: 'review', description: 'Review', shortDescription: null, path: '/skills/review/SKILL.md',
      scope: 'user', enabled: true, interface: null,
    };
    const request = vi.fn(async (method: string) => {
      if (method === 'skills/list') return { data: [{ cwd: '/workspace', skills: [skill], errors: [] }] };
      throw new Error('unavailable');
    });
    const setup = setupCatalog(request);
    setup.runtime.cwd = '/workspace';

    await expect(setup.controller.listSkills({ cwd: '/workspace' })).resolves.toMatchObject([{ name: 'review' }]);
    expect(setup.runtime.skillCatalogStatus).toBe('loaded');
    expect(setup.host.emitConversationSkills).toHaveBeenCalledWith('thread-1', 'action');

    await setup.controller.loadModels();
    expect(setup.state).toMatchObject({ modelCatalogStatus: 'error', models: [] });
    await setup.controller.loadPermissionProfiles();
    expect(setup.state).toMatchObject({ permissionProfiles: [], approvalPresets: [], approvalPreset: null });
    await setup.controller.loadRateLimits();
    expect(setup.state.rateLimits).toBeNull();
  });

  it('loads plugin scope once and can explicitly invalidate it', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin/installed') return { marketplaces: [], marketplaceLoadErrors: [] };
      return {};
    });
    const setup = setupCatalog(request);
    setup.state.status = 'ready';
    setup.state.conversations = [{
      id: 'thread-1', title: 'Thread', preview: '', cwd: '/workspace', status: 'idle',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', turnCount: 0,
    }];

    setup.controller.schedulePluginRefresh();
    await vi.waitFor(() => expect(setup.state.pluginCatalogStatus).toBe('loaded'));
    setup.controller.schedulePluginRefresh();
    expect(request.mock.calls.filter(([method]) => method === 'plugin/installed')).toHaveLength(1);
    setup.controller.schedulePluginRefresh(true);
    await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'plugin/installed')).toHaveLength(2));
  });

  it('uses exact model cache flags and never applies hidden-model queries to shared state', async () => {
    const request = vi.fn(async (_method: string, params: { includeHidden: boolean }) => ({
      data: [model(params.includeHidden ? 'hidden' : 'visible', true)], nextCursor: null,
    }));
    const setup = setupCatalog(request);
    setup.state.models = [{ id: 'cached', model: 'cached', displayName: 'Cached' }];
    setup.state.modelCatalogStatus = 'loaded';

    const cached = await setup.controller.listModels({ forceReload: false, includeHidden: false });
    expect(cached).toStrictEqual(setup.state.models);
    expect(cached).not.toBe(setup.state.models);

    await expect(setup.controller.listModels({ forceReload: false, includeHidden: true }))
      .resolves.toMatchObject([{ id: 'hidden' }]);
    expect(request).toHaveBeenCalledWith('model/list', { cursor: null, includeHidden: true });
    expect(setup.state.models).toMatchObject([{ id: 'cached' }]);

    await setup.controller.listModels({ includeHidden: false });
    expect(request).toHaveBeenLastCalledWith('model/list', { cursor: null, includeHidden: false });
    expect(setup.state.models).toMatchObject([{ id: 'visible' }]);

    const notLoaded = setupCatalog(request);
    notLoaded.state.modelCatalogStatus = 'notLoaded';
    await notLoaded.controller.listModels({ forceReload: false, includeHidden: false });
    expect(notLoaded.state.models).toMatchObject([{ id: 'visible' }]);
  });

  it('publishes exact loading and loaded model catalog transitions', async () => {
    const pending = deferred<unknown>();
    const setup = setupCatalog(vi.fn(() => pending.promise));

    const loading = setup.controller.loadModels();
    expect(setup.host.patch).toHaveBeenNthCalledWith(1, { modelCatalogStatus: 'loading' });
    expect(setup.host.emitEvent).toHaveBeenNthCalledWith(1, 'action', {
      type: 'catalog.modelsChanged', payload: { models: [], status: 'loading' },
    });

    pending.resolve({ data: [model('loaded', true)], nextCursor: null });
    await loading;
    expect(setup.request).toHaveBeenCalledWith('model/list', { cursor: null, includeHidden: false });
    expect(setup.state).toMatchObject({
      models: [{ id: 'loaded' }], modelCatalogStatus: 'loaded',
      selectedModelId: 'loaded', selectedReasoningEffort: 'medium', selectedServiceTier: null,
    });
    expect(setup.host.emitEvent).toHaveBeenLastCalledWith('action', {
      type: 'catalog.modelsChanged',
      payload: { models: [expect.objectContaining({ id: 'loaded' })], status: 'loaded' },
    });
  });

  it('publishes exact model catalog errors after a failed reload', async () => {
    const setup = setupCatalog(vi.fn(async () => { throw new Error('models unavailable'); }));
    setup.state.models = [{ id: 'old', model: 'old', displayName: 'Old' }];

    await setup.controller.loadModels();

    expect(setup.host.patch).toHaveBeenLastCalledWith({ modelCatalogStatus: 'error', models: [] });
    expect(setup.host.emitEvent).toHaveBeenLastCalledWith('action', {
      type: 'catalog.modelsChanged', payload: { models: [], status: 'error' },
    });

    const empty = setupCatalog(vi.fn(async () => ({ data: [], nextCursor: null })));
    Object.assign(empty.state, {
      selectedModelId: 'old', selectedReasoningEffort: 'high', selectedServiceTier: 'priority',
    });
    await empty.controller.loadModels();
    expect(empty.state).toMatchObject({
      models: [], selectedModelId: null, selectedReasoningEffort: null, selectedServiceTier: null,
    });
  });

  it('loads the default skill catalog with exact scope, force flag, origin, and detached event data', async () => {
    const listedSkill = skill('review');
    const request = vi.fn(async () => ({ data: [{ cwd: '/project', skills: [listedSkill], errors: [] }] }));
    const setup = setupCatalog(request);

    await setup.controller.loadSkills(true, 'lifecycle');

    expect(request).toHaveBeenCalledWith('skills/list', { cwds: ['/project'], forceReload: true });
    expect(setup.host.patch).toHaveBeenNthCalledWith(1, { skillCatalogStatus: 'loading' });
    expect(setup.host.patch).toHaveBeenNthCalledWith(2, {
      skills: [expect.objectContaining({ name: 'review' })], skillCatalogStatus: 'loaded',
    });
    expect(setup.state).toMatchObject({ skills: [{ name: 'review' }], skillCatalogStatus: 'loaded' });
    expect(setup.host.emitEvent).toHaveBeenNthCalledWith(1, 'lifecycle', {
      type: 'catalog.skillsChanged',
      payload: { cwd: '/project', skills: [], status: 'loading' },
    });
    expect(setup.host.emitEvent).toHaveBeenNthCalledWith(2, 'lifecycle', {
      type: 'catalog.skillsChanged',
      payload: { cwd: '/project', skills: [expect.objectContaining({ name: 'review' })], status: 'loaded' },
    });
    const emittedSkills = (setup.host.emitEvent.mock.calls[1]![1] as { payload: { skills: unknown } }).payload.skills;
    expect(emittedSkills).not.toBe(setup.state.skills);
  });

  it('loads an unscoped skill catalog and reports exact failures', async () => {
    const successful = setupCatalog(vi.fn(async () => ({ data: [{ cwd: null, skills: [], errors: [] }] })), {
      cwd: undefined,
    });
    await successful.controller.loadSkills();
    expect(successful.request).toHaveBeenCalledWith('skills/list', { forceReload: false });
    expect(successful.host.emitEvent).toHaveBeenLastCalledWith('action', {
      type: 'catalog.skillsChanged', payload: { cwd: null, skills: [], status: 'loaded' },
    });

    const failed = setupCatalog(vi.fn(async () => { throw new Error('skills unavailable'); }), { cwd: undefined });
    await failed.controller.loadSkills();
    expect(failed.host.patch).toHaveBeenLastCalledWith({ skills: [], skillCatalogStatus: 'error' });
    expect(failed.host.emitEvent).toHaveBeenLastCalledWith('action', {
      type: 'catalog.skillsChanged', payload: { cwd: null, skills: [], status: 'error' },
    });
 });

  it('caches skill icons, invalidates them on force reload, and resets all catalog caches', async () => {
    let iconReads = 0;
    const iconSkill = {
      ...skill('icon'), interface: { iconSmall: '/skills/icon/icon.png' },
    };
    const request = vi.fn(async (method: string) => {
      if (method === 'skills/list') {
        return { data: [{ cwd: '/project', skills: [iconSkill], errors: [] }] };
      }
      if (method === 'fs/readFile') {
        iconReads += 1;
        return { dataBase64: iconReads === 1 ? 'QQ==' : iconReads === 2 ? 'Qg==' : 'Qw==' };
      }
      if (method === 'plugin/installed') return { marketplaces: [], marketplaceLoadErrors: [] };
      return {};
    });
    const setup = setupCatalog(request);

    await setup.controller.loadSkills(false);
    expect(setup.state.skills[0]?.iconSmall).toBe('data:image/png;base64,QQ==');
    await setup.controller.loadSkills(false);
    expect(iconReads).toBe(1);
    await setup.controller.loadSkills(true);
    expect(setup.state.skills[0]?.iconSmall).toBe('data:image/png;base64,Qg==');
    expect(iconReads).toBe(2);
    await setup.controller.listSkills({ forceReload: false });
    expect(iconReads).toBe(2);
    const reloaded = await setup.controller.listSkills({ forceReload: true });
    expect(reloaded[0]?.iconSmall).toBe('data:image/png;base64,Qw==');
    expect(iconReads).toBe(3);

    setup.state.status = 'ready';
    setup.controller.schedulePluginRefresh();
    await vi.waitFor(() => expect(setup.state.pluginCatalogStatus).toBe('loaded'));
    setup.controller.reset(false);
    await setup.controller.loadSkills(false);
    expect(iconReads).toBe(4);
    setup.controller.schedulePluginRefresh();
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === 'plugin/installed')).toHaveLength(2);
    });
  });

  it('lists scoped skills, updates every matching runtime, and leaves other scopes untouched', async () => {
    const listedSkill = skill('scoped');
    const setup = setupCatalog(vi.fn(async () => ({
      data: [{ cwd: '/workspace', skills: [listedSkill], errors: [] }],
    })));
    setup.runtime.cwd = '/workspace';
    const matching = createThreadRuntime('thread-2', setup.state, { cwd: '/workspace' });
    const unrelated = createThreadRuntime('thread-3', setup.state, { cwd: '/other' });
    setup.runtimes.push(matching, unrelated);

    const result = await setup.controller.listSkills({ cwd: '/workspace', forceReload: true });

    expect(setup.request).toHaveBeenCalledWith('skills/list', { cwds: ['/workspace'], forceReload: true });
    expect(setup.host.patchRuntime).toHaveBeenNthCalledWith(3, 'thread-1', {
      skills: result, skillCatalogStatus: 'loaded',
    });
    expect(setup.host.patchRuntime).toHaveBeenNthCalledWith(4, 'thread-2', {
      skills: result, skillCatalogStatus: 'loaded',
    });
    expect(setup.host.patchRuntime).not.toHaveBeenCalledWith('thread-3', expect.anything());
    expect(setup.host.emitConversationSkills.mock.calls).toStrictEqual([
      ['thread-1', 'action'], ['thread-2', 'action'],
      ['thread-1', 'action'], ['thread-2', 'action'],
    ]);
    expect(setup.host.emitEvent).toHaveBeenCalledWith('action', {
      type: 'catalog.skillsChanged',
      payload: { cwd: '/workspace', skills: result, status: 'loaded' },
    });
    expect(result).not.toBe(setup.runtime.skills);

    const unscoped = setupCatalog(vi.fn(async () => ({ data: [{ cwd: null, skills: [], errors: [] }] })), {
      cwd: undefined,
    });
    await unscoped.controller.listSkills();
    expect(unscoped.request).toHaveBeenCalledWith('skills/list', { forceReload: false });
    expect(unscoped.host.patchRuntime).toHaveBeenCalledWith('thread-1', {
      skills: [], skillCatalogStatus: 'loaded',
    });
  });

  it('paginates permission profiles, applies the preferred available preset, and emits detached data', async () => {
    const request = vi.fn(async (method: string, params?: { cursor?: string | null }) => {
      if (method === 'permissionProfile/list') {
        return params?.cursor
          ? { data: [profile(':danger-full-access')], nextCursor: null }
          : { data: [profile(':workspace')], nextCursor: 'page-2' };
      }
      if (method === 'configRequirements/read') {
        return {
          requirements: {
            allowedApprovalPolicies: ['on-request', 'never'], allowedApprovalsReviewers: ['user'],
          },
        };
      }
      return {};
    });
    const setup = setupCatalog(request, { preferredApprovalPreset: 'full-access' });

    await setup.controller.loadPermissionProfiles();

    expect(request.mock.calls.filter(([method]) => method === 'permissionProfile/list')).toStrictEqual([
      ['permissionProfile/list', { cursor: null, cwd: '/project' }],
      ['permissionProfile/list', { cursor: 'page-2', cwd: '/project' }],
    ]);
    expect(request).toHaveBeenCalledWith('configRequirements/read', undefined);
    expect(setup.state).toMatchObject({
      permissionProfiles: [{ id: ':workspace' }, { id: ':danger-full-access' }],
      approvalPresets: ['ask-for-approval', 'full-access'], approvalPreset: 'full-access',
    });
    expect(setup.host.emitEvent).toHaveBeenCalledWith('action', {
      type: 'catalog.permissionsChanged',
      payload: {
        cwd: '/project', permissionProfiles: setup.state.permissionProfiles,
        approvalPresets: ['ask-for-approval', 'full-access'],
      },
    });
    const payload = (setup.host.emitEvent.mock.calls[0]![1] as {
      payload: { permissionProfiles: unknown; approvalPresets: unknown };
    }).payload;
    expect(payload.permissionProfiles).not.toBe(setup.state.permissionProfiles);
    expect(payload.approvalPresets).not.toBe(setup.state.approvalPresets);
  });

  it('falls back to the first permitted approval preset, preserves null preference, and reports failures', async () => {
    const responses = vi.fn(async (method: string) => {
      if (method === 'permissionProfile/list') {
        return { data: [profile(':workspace')], nextCursor: null };
      }
      return { requirements: { allowedApprovalsReviewers: ['user'] } };
    });
    const unavailable = setupCatalog(responses, { preferredApprovalPreset: 'full-access', cwd: undefined });
    await unavailable.controller.loadPermissionProfiles();
    expect(unavailable.state.approvalPreset).toBe('ask-for-approval');
    expect(unavailable.host.emitEvent).toHaveBeenLastCalledWith('action', {
      type: 'catalog.permissionsChanged',
      payload: {
        cwd: null, permissionProfiles: [profile(':workspace')], approvalPresets: ['ask-for-approval'],
      },
    });

    const noPreference = setupCatalog(responses, { preferredApprovalPreset: null });
    await noPreference.controller.loadPermissionProfiles();
    expect(noPreference.state.approvalPreset).toBeNull();

    const failed = setupCatalog(vi.fn(async () => { throw new Error('permissions unavailable'); }));
    await failed.controller.loadPermissionProfiles();
    expect(failed.host.patch).toHaveBeenLastCalledWith({
      permissionProfiles: [], approvalPresets: [], approvalPreset: null,
    });
    expect(failed.host.emitEvent).toHaveBeenLastCalledWith('action', {
      type: 'catalog.permissionsChanged',
      payload: { cwd: '/project', permissionProfiles: [], approvalPresets: [] },
    });
  });

  it('loads and emits a detached rate-limit snapshot', async () => {
    const response = rateLimitResponse();
    const setup = setupCatalog(vi.fn(async () => response));

    await setup.controller.loadRateLimits();

    expect(setup.request).toHaveBeenCalledWith('account/rateLimits/read', undefined);
    expect(setup.state.rateLimits).toMatchObject({
      rateLimits: { limitId: 'codex', primary: { usedPercent: 25 } },
    });
    expect(setup.host.emitEvent).toHaveBeenCalledWith('action', {
      type: 'rateLimits.changed', payload: { rateLimits: setup.state.rateLimits },
    });
    const emitted = (setup.host.emitEvent.mock.calls[0]![1] as { payload: { rateLimits: unknown } }).payload.rateLimits;
    expect(emitted).not.toBe(setup.state.rateLimits);
  });

  it('publishes an exact null rate-limit transition after a failed read', async () => {
    const setup = setupCatalog(vi.fn(async () => { throw new Error('rate limits unavailable'); }));
    setup.state.rateLimits = { marker: true } as never;

    await setup.controller.loadRateLimits();

    expect(setup.host.patch).toHaveBeenCalledWith({ rateLimits: null });
    expect(setup.host.emitEvent).toHaveBeenCalledWith('action', {
      type: 'rateLimits.changed', payload: { rateLimits: null },
    });
  });

  it('returns detached cached conversation catalogs only for the default loaded scope', async () => {
    const cachedSkills = [{
      name: 'cached', description: 'Cached', path: '/cached/SKILL.md',
      scope: 'user', enabled: true,
    }];
    const setup = setupCatalog(vi.fn(async () => ({ data: [{ cwd: '/project', skills: cachedSkills, errors: [] }] })));
    await setup.controller.listSkills({ cwd: '/project' });
    setup.request.mockClear();
    setup.state.permissionProfiles = [profile(':workspace')];
    setup.state.approvalPresets = ['ask-for-approval'];

    const result = await setup.controller.loadConversationCatalogs('/project', false);

    expect(setup.request).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      skills: expect.arrayContaining([expect.objectContaining({ name: 'cached' })]), skillCatalogStatus: 'loaded',
      permissionProfiles: setup.state.permissionProfiles, approvalPresets: ['ask-for-approval'],
    });
    expect(result.skills).not.toBe(setup.runtime.skills);
    expect(result.permissionProfiles).not.toBe(setup.state.permissionProfiles);
    expect(result.approvalPresets).not.toBe(setup.state.approvalPresets);

    const notLoaded = setupCatalog(vi.fn(async (method: string) => {
      if (method === 'skills/list') return { data: [{ cwd: '/project', skills: [], errors: [] }] };
      if (method === 'permissionProfile/list') return { data: [], nextCursor: null };
      return { requirements: null };
    }));
    notLoaded.state.skillCatalogStatus = 'notLoaded';
    await notLoaded.controller.loadConversationCatalogs('/project', false);
    expect(notLoaded.request).not.toHaveBeenCalled();
  });

  it('loads conversation catalogs for another scope and isolates skill and permission failures', async () => {
    const listedSkill = skill('conversation');
    const successful = setupCatalog(vi.fn(async (method: string) => {
      if (method === 'skills/list') {
        return { data: [{ cwd: '/other', skills: [listedSkill], errors: [] }] };
      }
      if (method === 'permissionProfile/list') {
        return { data: [profile(':workspace')], nextCursor: null };
      }
      return { requirements: { allowedApprovalsReviewers: ['user'] } };
    }));
    await successful.controller.listSkills({ cwd: '/other', forceReload: true });
    await expect(successful.controller.loadConversationCatalogs('/other', true)).resolves.toStrictEqual({
      skills: [expect.objectContaining({ name: 'conversation' })], skillCatalogStatus: 'loaded',
      permissionProfiles: [profile(':workspace')], approvalPresets: ['ask-for-approval'],
    });
    expect(successful.request).toHaveBeenCalledWith('skills/list', {
      cwds: ['/other'], forceReload: true,
    });
    expect(successful.request).toHaveBeenCalledWith('configRequirements/read', undefined);

    const skillFailure = setupCatalog(vi.fn(async (method: string) => {
      if (method === 'skills/list') throw new Error('skills unavailable');
      if (method === 'permissionProfile/list') return { data: [profile(':workspace')], nextCursor: null };
      return { requirements: { allowedApprovalsReviewers: ['user'] } };
    }));
    await expect(skillFailure.controller.listSkills()).rejects.toThrow('skills unavailable');
    await expect(skillFailure.controller.loadConversationCatalogs(undefined)).resolves.toStrictEqual({
      skills: [], skillCatalogStatus: 'notLoaded',
      permissionProfiles: [profile(':workspace')], approvalPresets: ['ask-for-approval'],
    });

    const permissionFailure = setupCatalog(vi.fn(async (method: string) => {
      if (method === 'skills/list') return { data: [{ cwd: null, skills: [], errors: [] }] };
      throw new Error('permissions unavailable');
    }));
    await expect(permissionFailure.controller.loadConversationCatalogs(undefined)).resolves.toStrictEqual({
      skills: [], skillCatalogStatus: 'notLoaded', permissionProfiles: [], approvalPresets: [],
    });
  });

  it('materializes icons while loading a conversation-specific skill catalog', async () => {
    const iconSkill = {
      ...skill('conversation-icon'), interface: { iconSmall: '/skills/conversation/icon.svg' },
    };
    const setup = setupCatalog(vi.fn(async (method: string) => {
      if (method === 'skills/list') {
        return { data: [{ cwd: '/other', skills: [iconSkill], errors: [] }] };
      }
      if (method === 'fs/readFile') return { dataBase64: 'PHN2Zy8+' };
      if (method === 'permissionProfile/list') return { data: [], nextCursor: null };
      return { requirements: null };
    }));

    await setup.controller.listSkills({ cwd: '/other' });
    await expect(setup.controller.loadConversationCatalogs('/other')).resolves.toMatchObject({
      skills: [{ iconSmall: 'data:image/svg+xml;base64,PHN2Zy8+' }], skillCatalogStatus: 'loaded',
    });
    expect(setup.request).toHaveBeenCalledWith('fs/readFile', { path: '/skills/conversation/icon.svg' });
  });

  it('does not schedule plugins while the host is blocked', () => {
    for (const blocked of [
      { closed: true, status: 'ready' as const, authBlocked: false },
      { closed: false, status: 'idle' as const, authBlocked: false },
      { closed: false, status: 'ready' as const, authBlocked: true },
    ]) {
      const setup = setupCatalog(vi.fn());
      setup.controls.closed = blocked.closed;
      setup.controls.authBlocked = blocked.authBlocked;
      setup.state.status = blocked.status;

      setup.controller.schedulePluginRefresh();

      expect(setup.request).not.toHaveBeenCalled();
      expect(setup.host.patch).not.toHaveBeenCalled();
      expect(setup.host.emitEvent).not.toHaveBeenCalled();
    }
  });

  it('emits loading state, deduplicates in-flight refreshes, and reruns a forced request afterward', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let pluginRequests = 0;
    const setup = setupCatalog(vi.fn((method: string, params?: unknown) => {
      if (method !== 'plugin/installed') return Promise.resolve({});
      pluginRequests += 1;
      expect(params).toStrictEqual({ cwds: ['/project', '/runtime', '/workspace'] });
      return pluginRequests === 1 ? first.promise : second.promise;
    }));
    setup.state.status = 'ready';
    setup.state.plugins = [{
      id: 'old', name: 'old', displayName: 'Old', enabled: true,
    }];
    setup.state.conversations = [conversation('/workspace'), conversation('/workspace')];
    setup.runtime.cwd = '/runtime';
    setup.runtimes.push(createThreadRuntime('blank-runtime', setup.state, { cwd: '  ' }));

    setup.controller.schedulePluginRefresh();
    setup.controller.schedulePluginRefresh();
    setup.controller.schedulePluginRefresh(true);

    expect(pluginRequests).toBe(1);
    expect(setup.host.patch).toHaveBeenCalledWith({ pluginCatalogStatus: 'loading' });
    expect(setup.host.emitEvent).toHaveBeenCalledWith('action', {
      type: 'catalog.pluginsChanged',
      payload: { plugins: [{ id: 'old', name: 'old', displayName: 'Old', enabled: true }], status: 'loading' },
    });
    const loadingPlugins = (setup.host.emitEvent.mock.calls[0]![1] as { payload: { plugins: unknown } }).payload.plugins;
    expect(loadingPlugins).not.toBe(setup.state.plugins);

    first.resolve({ marketplaces: [], marketplaceLoadErrors: [] });
    await vi.waitFor(() => expect(pluginRequests).toBe(2));
    second.resolve({ marketplaces: [], marketplaceLoadErrors: [] });
    await vi.waitFor(() => expect(setup.state.pluginCatalogStatus).toBe('loaded'));
    setup.controller.schedulePluginRefresh();
    expect(pluginRequests).toBe(2);
  });

  it('reruns plugin loading when the cwd scope changes during an in-flight request', async () => {
    const first = deferred<unknown>();
    const scopes: unknown[] = [];
    const setup = setupCatalog(vi.fn(async (method: string, params?: unknown) => {
      if (method !== 'plugin/installed') return {};
      scopes.push(params);
      if (scopes.length === 1) return first.promise;
      return { marketplaces: [], marketplaceLoadErrors: [] };
    }));
    setup.state.status = 'ready';

    setup.controller.schedulePluginRefresh();
    setup.state.conversations.push(conversation('/new-scope'));
    first.resolve({ marketplaces: [], marketplaceLoadErrors: [] });

    await vi.waitFor(() => expect(scopes).toHaveLength(2));
    expect(scopes).toStrictEqual([
      { cwds: ['/project'] },
      { cwds: ['/new-scope', '/project'] },
    ]);
  });

  it('deduplicates plugins by first marketplace occurrence and emits the exact loaded catalog', async () => {
    const firstPlugin = plugin('same', 'First');
    const duplicate = plugin('same', 'Duplicate');
    const unique = plugin('unique', 'Unique');
    const setup = setupCatalog(vi.fn(async () => ({
      marketplaces: [
        { name: 'first', plugins: [firstPlugin, unique] },
        { name: 'second', plugins: [duplicate] },
      ],
      marketplaceLoadErrors: [],
    })), { cwd: undefined });
    setup.state.status = 'ready';
    setup.runtime.cwd = null;

    setup.controller.schedulePluginRefresh();

    await vi.waitFor(() => expect(setup.state.pluginCatalogStatus).toBe('loaded'));
    expect(setup.request).toHaveBeenCalledWith('plugin/installed', {});
    expect(setup.state.plugins).toStrictEqual([
      { id: 'same', name: 'same', displayName: 'First', enabled: true },
      { id: 'unique', name: 'unique', displayName: 'Unique', enabled: true },
    ]);
    expect(setup.host.patch).toHaveBeenLastCalledWith({
      plugins: setup.state.plugins, pluginCatalogStatus: 'loaded',
    });
    expect(setup.host.emitEvent).toHaveBeenLastCalledWith('action', {
      type: 'catalog.pluginsChanged', payload: { plugins: setup.state.plugins, status: 'loaded' },
    });
    const emitted = (setup.host.emitEvent.mock.calls.at(-1)![1] as { payload: { plugins: unknown } }).payload.plugins;
    expect(emitted).not.toBe(setup.state.plugins);
  });

  it('reports plugin failures with the existing detached catalog and retries the same scope', async () => {
    let attempts = 0;
    const setup = setupCatalog(vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('plugins unavailable');
      return { marketplaces: [], marketplaceLoadErrors: [] };
    }));
    setup.state.status = 'ready';
    setup.state.plugins = [{ id: 'old', name: 'old', displayName: 'Old', enabled: true }];

    setup.controller.schedulePluginRefresh();
    await vi.waitFor(() => expect(setup.state.pluginCatalogStatus).toBe('error'));
    expect(setup.host.patch).toHaveBeenLastCalledWith({ pluginCatalogStatus: 'error' });
    expect(setup.host.emitEvent).toHaveBeenLastCalledWith('action', {
      type: 'catalog.pluginsChanged', payload: { plugins: setup.state.plugins, status: 'error' },
    });
    const emitted = (setup.host.emitEvent.mock.calls.at(-1)![1] as { payload: { plugins: unknown } }).payload.plugins;
    expect(emitted).not.toBe(setup.state.plugins);

    setup.controller.schedulePluginRefresh();
    await vi.waitFor(() => expect(attempts).toBe(2));
  });

  it('suppresses plugin results when the host becomes blocked in flight', async () => {
    for (const blocking of ['closed', 'authentication'] as const) {
      for (const outcome of ['resolve', 'reject'] as const) {
        const pending = deferred<unknown>();
        const setup = setupCatalog(vi.fn(() => pending.promise));
        setup.state.status = 'ready';
        setup.controller.schedulePluginRefresh();
        setup.host.patch.mockClear();
        setup.host.emitEvent.mockClear();
        if (blocking === 'closed') setup.controls.closed = true;
        else setup.controls.authBlocked = true;
        if (outcome === 'resolve') pending.resolve({ marketplaces: [], marketplaceLoadErrors: [] });
        else pending.reject(new Error('failed'));
        await settleAsyncWork();
        expect(setup.host.patch).not.toHaveBeenCalled();
        expect(setup.host.emitEvent).not.toHaveBeenCalled();
      }
    }
  });

  it('accepts only absolute supported readable icon paths and caches rejected reads', async () => {
    const reads: string[] = [];
    const skills = [
      { ...skill('relative'), interface: { iconSmall: 'relative.png' } },
      { ...skill('unsupported'), interface: { iconSmall: '/icons/readme.txt' } },
      { ...skill('failed'), interface: { iconSmall: '/icons/failed.png', iconLarge: '/icons/failed.png' } },
    ];
    const setup = setupCatalog(vi.fn(async (method: string, params?: unknown) => {
      if (method === 'skills/list') return { data: [{ cwd: '/project', skills, errors: [] }] };
      if (method === 'fs/readFile') {
        reads.push((params as { path: string }).path);
        throw new Error('unreadable');
      }
      return {};
    }));

    await setup.controller.loadSkills();

    expect(reads).toStrictEqual(['/icons/failed.png']);
    expect(setup.state.skills).toMatchObject([
      { name: 'relative', iconSmall: undefined },
      { name: 'unsupported', iconSmall: undefined },
      { name: 'failed', iconSmall: undefined, iconLarge: undefined },
    ]);
  });
});

function setupCatalog(request: ReturnType<typeof vi.fn>, options: {
  cwd?: string;
  preferredApprovalPreset?: 'ask-for-approval' | 'approve-for-me' | 'full-access' | null;
} = {}) {
  const state = initialHostSnapshot(initialAuthentication());
  const runtime = createThreadRuntime('thread-1', state);
  const runtimes = [runtime];
  const controls = { authBlocked: false, closed: false };
  const host = {
    authenticationBlocksBootstrap: () => controls.authBlocked,
    emitConversationSkills: vi.fn(),
    emitEvent: vi.fn(),
    ensureConnected: vi.fn(async () => undefined),
    getState: () => state,
    isClosed: () => controls.closed,
    patch: vi.fn((patch: Partial<CodexSnapshot>) => Object.assign(state, patch)),
    patchRuntime: vi.fn((_threadId, patch) => Object.assign(runtime, patch)),
    preferredApprovalPreset: () => options.preferredApprovalPreset === undefined
      ? 'ask-for-approval'
      : options.preferredApprovalPreset,
    runtimes: () => runtimes,
  } satisfies CodexHostCatalogDependencies;
  const client = { request } as unknown as CodexAppServerClient;
  return {
    controller: new CodexHostCatalogController(
      client, Object.hasOwn(options, 'cwd') ? options.cwd : '/project', host,
    ),
    controls, host, request, runtime, runtimes, state,
  };
}

function model(id: string, isDefault: boolean) {
  return { availableAccessPrograms: { cyber: [] },
    id, model: id, displayName: id, description: 'Model', hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
    defaultReasoningEffort: 'medium', isDefault, inputModalities: ['text'], serviceTiers: [],
    supportsPersonality: false, upgrade: null, upgradeInfo: null,
  };
}

function skill(name: string) {
  return {
    name, description: name, shortDescription: null, path: `/skills/${name}/SKILL.md`,
    scope: 'user', enabled: true, interface: null,
  };
}

function profile(id: string) {
  return { id, description: null, allowed: true };
}

function rateLimitResponse() {
  return {
    rateLimits: {
      limitId: 'codex', limitName: 'Codex',
      primary: { usedPercent: 25, windowDurationMins: 60, resetsAt: 10 },
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: '5' },
      planType: null,
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
  };
}

function conversation(cwd: string) {
  return {
    id: `thread-${cwd}`, title: cwd, preview: '', cwd, status: 'idle' as const, turnCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function plugin(id: string, displayName: string) {
  return {
    id, name: id, installed: true, enabled: true, interface: { displayName },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function settleAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
