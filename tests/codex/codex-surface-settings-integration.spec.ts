import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '@korus-dev/codex-sdk';
import { CodexSurface } from '../../src/providers/codex';
import type { CodexSurfaceEvent } from '../../src/index';
import {
  configRequirements, MockCodexAppServer, createSurface, lastRequest, resumeResponse,
  testGoal, testModel, thread, threadSettings, turn,
} from './helpers/codex-surface-fixture';

describe('CodexSurface', () => {
  it('connects and clears an authoritative goal when called before bootstrap', async () => {
    const goal = testGoal({ objective: 'Clear me' });
    const transport = new MockCodexAppServer({
      'thread/goal/get': () => ({ goal }),
      'thread/goal/clear': () => ({ cleared: true }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });

    await surface.clearGoal();

    expect(lastRequest(transport, 'initialize')).toBeDefined();
    expect(lastRequest(transport, 'thread/goal/clear')).toMatchObject({
      params: { threadId: 'thread-existing' },
    });
    expect(surface.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-existing', goal: null,
    });
    await surface.close();
  });

  it('creates conversations with app-server-backed permission defaults and interrupts active turns', async () => {
    const { surface, transport } = createSurface(
      'thread/start', 'thread/settings/update', 'turn/start', 'turn/interrupt',
    );
    await surface.connect();
    await surface.createConversation();
    const startRequest = transport.sent.find((message) => 'method' in message && message.method === 'thread/start');
    expect(startRequest).toMatchObject({
      method: 'thread/start',
      params: {
        approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: '/tmp/project', permissions: ':workspace',
      },
    });

    await surface.sendMessage('Inspect this project');
    await surface.interrupt();
    expect(lastRequest(transport, 'turn/interrupt')).toMatchObject({
      params: { threadId: 'thread-new', turnId: 'turn-live' },
    });
    transport.emitNotification('turn/started', { threadId: 'another-thread', turn: turn('ignored-turn', 'inProgress', []) });
  });

  it('maps product options, creates on first send, and queues concurrent prompts', async () => {
    const { surface, transport } = createSurface('thread/start', 'thread/settings/update', 'turn/start');
    await surface.connect();
    await surface.createConversation({
      approvalMode: 'ask', cwd: '/tmp/other', model: 'gpt-mini-runtime', permissionMode: 'full-access',
    });
    expect(lastRequest(transport, 'thread/start')).toMatchObject({
      params: {
        approvalPolicy: 'on-request', cwd: '/tmp/other', model: 'gpt-mini-runtime', sandbox: 'danger-full-access',
      },
    });
    await surface.sendMessage('First', { model: 'gpt-mini-runtime' });
    expect(lastRequest(transport, 'turn/start')).toMatchObject({ params: { model: 'gpt-mini-runtime' } });
    await expect(surface.sendMessage('Second')).resolves.toMatchObject({
      queuedPrompts: [{ text: 'Second' }],
    });

    const fresh = createSurface('turn/start');
    await fresh.surface.sendMessage('Continue automatically');
    expect(lastRequest(fresh.transport, 'thread/start')).toBeUndefined();
    expect(lastRequest(fresh.transport, 'turn/start')).toMatchObject({ params: { threadId: 'thread-existing' } });
  });

  it('passes a host thread source to thread/start', async () => {
    const { surface, transport } = createSurface('thread/start', 'thread/settings/update');
    await surface.connect();

    await surface.createConversation({ threadSource: 'user' });

    expect(lastRequest(transport, 'thread/start')).toMatchObject({
      params: { threadSource: 'user' },
    });
  });

  it('applies host conversation defaults to explicit and automatic thread creation', async () => {
    const responses = {
      'model/list': () => ({
        data: [testModel('gpt-5.6-terra', 'gpt-5.6-terra', true)],
        nextCursor: null,
      }),
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [], nextCursor: null }),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
      'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
    };
    const createTransport = new MockCodexAppServer(responses);
    const createSurface = new CodexSurface({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(createTransport),
      conversationDefaults: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    });
    await createSurface.connect();
    await createSurface.createConversation();
    expect(lastRequest(createTransport, 'thread/start')).toMatchObject({
      params: { model: 'gpt-5.6-terra' },
    });
    expect(lastRequest(createTransport, 'thread/settings/update')).toMatchObject({
      params: {
        threadId: 'thread-new',
        effort: 'medium',
        collaborationMode: {
          mode: 'default',
          settings: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
        },
      },
    });

    const automaticTransport = new MockCodexAppServer(responses);
    const automaticSurface = new CodexSurface({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(automaticTransport),
      conversationDefaults: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    });
    await automaticSurface.connect();
    await automaticSurface.sendMessage('Hello Terra');
    expect(lastRequest(automaticTransport, 'thread/start')).toMatchObject({
      params: { model: 'gpt-5.6-terra' },
    });
    expect(lastRequest(automaticTransport, 'turn/start')).toMatchObject({
      params: {
        threadId: 'thread-new', model: 'gpt-5.6-terra', effort: 'medium',
      },
    });
  });

  it('updates model, reasoning, plan mode, and permissions through app-server settings', async () => {
    const { surface, transport } = createSurface('thread/settings/update');
    await surface.connect();

    const snapshot = await surface.updateConversationSettings({
      modelId: 'gpt-mini',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      approvalPreset: 'full-access',
      planMode: true,
    });

    expect(lastRequest(transport, 'thread/settings/update')).toMatchObject({
      params: {
        threadId: 'thread-existing',
        model: 'gpt-mini-runtime',
        effort: 'high',
        serviceTier: 'priority',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        permissions: ':danger-full-access',
        collaborationMode: {
          mode: 'plan',
          settings: { model: 'gpt-mini-runtime', reasoning_effort: 'high' },
        },
      },
    });
    expect(snapshot).toMatchObject({
      selectedModelId: 'gpt-mini',
      selectedReasoningEffort: 'high',
      selectedServiceTier: 'priority',
      approvalPreset: 'full-access',
      planMode: true,
    });
  });

  it('uses a model selected during generation for the next queued turn', async () => {
    const { surface, transport } = createSurface('turn/start', 'thread/settings/update');
    await surface.connect();
    await surface.sendMessage('First turn');

    await surface.updateConversationSettings({ modelId: 'gpt-mini' });
    await surface.sendMessage('Next turn');

    transport.emitNotification('turn/completed', { threadId: 'thread-existing', turn: turn('turn-live', 'completed', []) });

    await vi.waitFor(() => {
      const starts = transport.sent.filter((message) => 'method' in message && message.method === 'turn/start');
      expect(starts).toHaveLength(2);
    });
    expect(lastRequest(transport, 'turn/start')).toMatchObject({
      params: {
        input: [{ type: 'text', text: 'Next turn' }],
        model: 'gpt-mini-runtime',
        threadId: 'thread-existing',
      },
    });
  });

  it('keeps catalogs and settings useful when there is no persisted conversation', async () => {
    const transport = new MockCodexAppServer({
      'model/list': () => ({ data: [], nextCursor: null }),
      'permissionProfile/list': () => ({ data: [], nextCursor: null }),
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [], nextCursor: null }),
      'thread/start': () => resumeResponse(thread('thread-new', false)),
      'thread/settings/update': () => ({}),
      'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport), cwd: '/tmp/project' });

    await expect(surface.connect()).resolves.toMatchObject({
      activeConversationId: null,
      models: [],
      selectedModelId: null,
      selectedReasoningEffort: null,
      approvalPresets: [],
      approvalPreset: null,
    });
    await surface.updateConversationSettings({ planMode: true });
    expect(lastRequest(transport, 'thread/settings/update')).toBeUndefined();

    await surface.sendMessage('Start the first thread');
    expect(lastRequest(transport, 'thread/start')).toMatchObject({
      params: { approvalPolicy: 'never', sandbox: 'read-only' },
    });
    expect(lastRequest(transport, 'turn/start')).toMatchObject({
      params: { threadId: 'thread-new' },
    });
  });

  it('degrades catalogs safely when app-server catalog requests fail', async () => {
    const transport = new MockCodexAppServer({
      'model/list': () => { throw new Error('models unavailable'); },
      'permissionProfile/list': () => { throw new Error('profiles unavailable'); },
      'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [], nextCursor: null }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport), cwd: '/tmp/project' });

    await expect(surface.connect()).resolves.toMatchObject({
      status: 'ready',
      modelCatalogStatus: 'error',
      models: [],
      permissionProfiles: [],
      approvalPresets: [],
      approvalPreset: null,
    });
    expect(lastRequest(transport, 'configRequirements/read')).toBeUndefined();
  });

  it('paginates catalogs and applies app-server permission requirements', async () => {
    const transport = new MockCodexAppServer({
      'model/list': (params) => (params as { cursor?: string | null }).cursor
        ? { data: [testModel('model-default', 'runtime-default', true)], nextCursor: null }
        : { data: [testModel('model-first', 'runtime-first', false)], nextCursor: 'models-2' },
      'permissionProfile/list': (params) => (params as { cursor?: string | null }).cursor
        ? {
            data: [
              { id: ':danger-full-access', description: null, allowed: true },
              { id: ':disabled', description: null, allowed: false },
            ],
            nextCursor: null,
          }
        : {
            data: [{ id: ':workspace', description: 'Project files', allowed: true }],
            nextCursor: 'profiles-2',
          },
      'configRequirements/read': () => ({ supportsIndependentSpeedModes: null,
        requirements: configRequirements({
          allowedApprovalPolicies: ['on-request'],
          allowedApprovalsReviewers: ['user'],
        }),
      }),
      'thread/list': (params) => (params as { cursor?: string | null }).cursor
        ? { readStates: null, backwardsCursor: null, data: [thread('thread-second-page', false)], nextCursor: null }
        : { readStates: null, backwardsCursor: null, data: [thread('thread-first-page', false)], nextCursor: 'threads-2' },
    });
    const surface = new CodexSurface({
      approvalPreset: 'full-access',
      client: new CodexAppServerClient(transport),
      cwd: '/tmp/project',
    });

    await expect(surface.connect()).resolves.toMatchObject({
      models: [{ id: 'model-first' }, { id: 'model-default' }],
      selectedModelId: 'model-default',
      approvalPresets: ['ask-for-approval'],
      approvalPreset: 'ask-for-approval',
    });
    expect(transport.sent.filter((message) => 'method' in message && message.method === 'model/list')).toHaveLength(2);
    expect(transport.sent.filter((message) => 'method' in message && message.method === 'permissionProfile/list')).toHaveLength(2);
    const threadListRequests = transport.sent.filter(
      (message) => 'method' in message && message.method === 'thread/list',
    );
    expect(threadListRequests).toHaveLength(2);
    expect(threadListRequests).not.toContainEqual(expect.objectContaining({ params: { cwd: expect.anything() } }));
    expect(surface.getSnapshot().conversations.map((conversation) => conversation.id)).toStrictEqual([
      'thread-first-page',
      'thread-second-page',
    ]);
    await expect(surface.createConversation({ approvalPreset: 'full-access' }))
      .rejects.toThrow("Approval preset 'full-access' is not available");
    expect(lastRequest(transport, 'thread/start')).toBeUndefined();
  });

  it('falls back to a supported effort when the model changes', async () => {
    const { surface, transport } = createSurface('thread/settings/update');
    await surface.connect();

    await surface.updateConversationSettings({ modelId: 'gpt-mini', reasoningEffort: 'high' });
    const snapshot = await surface.updateConversationSettings({ modelId: 'gpt-5' });
    expect(snapshot.selectedReasoningEffort).toBe('medium');
    expect(lastRequest(transport, 'thread/settings/update')).toMatchObject({
      params: { model: 'gpt-5', effort: 'medium' },
    });
  });

  it('supports focused settings updates and authoritative settings notifications', async () => {
    const { surface, transport } = createSurface('thread/settings/update');
    await surface.connect();

    await surface.updateConversationSettings({ approvalPreset: 'approve-for-me' });
    expect(lastRequest(transport, 'thread/settings/update')).toMatchObject({
      params: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', permissions: ':workspace' },
    });
    await surface.updateConversationSettings({ planMode: false });
    expect(lastRequest(transport, 'thread/settings/update')).toMatchObject({
      params: { collaborationMode: { mode: 'default' } },
    });

    transport.emitNotification('thread/settings/updated', {
        threadId: 'thread-existing',
        threadSettings: threadSettings({
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          activePermissionProfile: { id: ':danger-no-sandbox', extends: null },
          collaborationMode: {
            mode: 'plan',
            settings: { model: 'gpt-mini-runtime', reasoning_effort: 'high', developer_instructions: null },
          },
          model: 'gpt-mini-runtime',
          effort: 'high',
        }),
      });
    expect(surface.getSnapshot()).toMatchObject({
      approvalPreset: 'full-access',
      planMode: true,
      selectedModelId: 'gpt-mini',
      selectedReasoningEffort: 'high',
    });

    transport.emitNotification('thread/settings/updated', {
        threadId: 'thread-existing',
        threadSettings: threadSettings({
          approvalPolicy: 'on-request',
          approvalsReviewer: 'guardian_subagent',
        }),
      });
    expect(surface.getSnapshot().approvalPreset).toBe('approve-for-me');
  });

  it('routes authoritative settings notifications to a background conversation', async () => {
    const { surface, transport } = createSurface('thread/settings/update');
    const events: CodexSurfaceEvent[] = [];
    surface.onEvent((event) => events.push(event));
    await surface.connect();
    const background = surface.conversation('thread-background');
    await background.load();
    await background.updateSettings({ approvalPreset: 'full-access' });
    events.length = 0;

    transport.emitNotification('thread/settings/updated', {
        threadId: 'thread-background',
        threadSettings: threadSettings({
          approvalPolicy: 'untrusted',
          approvalsReviewer: 'user',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          activePermissionProfile: null,
          collaborationMode: { mode: 'plan', settings: {
            model: 'gpt-5', reasoning_effort: 'medium', developer_instructions: null,
          } },
        }),
      });

    expect(surface.getSnapshot()).toMatchObject({
      activeConversationId: 'thread-existing',
      selectedModelId: 'gpt-5',
      planMode: false,
    });
    expect(surface.getConversationSnapshot('thread-background')).toMatchObject({
      selectedModelId: 'gpt-5',
      selectedReasoningEffort: 'medium',
      approvalPreset: 'full-access',
      planMode: true,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'conversation.settingsChanged',
      origin: 'notification',
      conversationId: 'thread-background',
      payload: expect.objectContaining({
        approvalPreset: 'full-access', selectedModelId: 'gpt-5', planMode: true,
      }),
    }));
    await surface.close();
  });

  it('honors explicit main-process policy defaults', async () => {
    const cases = [
      { options: { approvalPreset: 'full-access' as const }, expected: 'full-access' },
      { options: { approvalMode: 'never' as const, permissionMode: 'full-access' as const }, expected: 'full-access' },
      { options: { approvalMode: 'ask' as const, permissionMode: 'workspace-write' as const }, expected: 'ask-for-approval' },
      { options: { approvalMode: 'never' as const, permissionMode: 'read-only' as const }, expected: null },
    ];

    for (const entry of cases) {
      const transport = new MockCodexAppServer({ 'thread/list': () => ({ readStates: null, backwardsCursor: null, data: [], nextCursor: null }) });
      const surface = new CodexSurface({
        ...entry.options,
        client: new CodexAppServerClient(transport),
        cwd: '/tmp/project',
      });
      expect((await surface.connect()).approvalPreset).toBe(entry.expected);
    }
  });

});
