import { describe, expect, it } from 'vitest';
import type { CodexAuthenticationState } from '../../src/internal';
import {
  createThreadRuntime,
  initialHostSnapshot,
  runtimeProjection,
} from '../../src/providers/codex/host-runtime';

const authentication: CodexAuthenticationState = {
  status: 'notLoaded',
  account: null,
  requiresOpenaiAuth: null,
  error: null,
  login: { status: 'idle', loginId: null, authUrl: null, error: null },
};

describe('Codex host runtime state', () => {
  it('creates the complete idle host state', () => {
    const state = initialHostSnapshot(authentication);
    expect(state).toStrictEqual({
      status: 'idle',
      authentication,
      conversations: [],
      activeConversationId: null,
      activeTurnId: null,
      turns: [],
      messages: [],
      clientRequests: [],
      answeredClientRequestIds: [],
      approvals: [],
      models: [],
      modelCatalogStatus: 'notLoaded',
      skills: [],
      skillCatalogStatus: 'notLoaded',
      plugins: [],
      pluginCatalogStatus: 'notLoaded',
      permissionProfiles: [],
      approvalPresets: [],
      approvalPreset: null,
      selectedModelId: null,
      selectedReasoningEffort: null,
      selectedServiceTier: null,
      planMode: false,
      executionPlan: null,
      contextUsage: null,
      goal: null,
      turnGitDiff: null,
      threadStatus: null,
      rateLimits: null,
      queuedPrompts: [],
      busy: false,
      historyLoading: false,
      historyState: {
        loadingStrategy: 'lazy',
        hasOlder: false,
        loadingOlder: false,
        fullyLoaded: false,
      },
      error: null,
    });
  });

  it('inherits catalog defaults into a new isolated thread runtime', () => {
    const state = initialHostSnapshot(authentication);
    state.approvalPreset = 'approve-for-me';
    state.approvalPresets = ['ask-for-approval', 'approve-for-me'];
    state.permissionProfiles = [{ id: ':workspace', description: null, allowed: true }];
    state.skills = [{ name: 'review', path: '/skills/review/SKILL.md', enabled: true }];
    state.skillCatalogStatus = 'loaded';
    state.selectedModelId = 'model-1';
    state.selectedReasoningEffort = 'high';
    state.selectedServiceTier = 'priority';
    state.historyState = {
      loadingStrategy: 'eager',
      hasOlder: true,
      loadingOlder: true,
      fullyLoaded: true,
    };

    const runtime = createThreadRuntime('thread-1', state, { cwd: '/workspace', busy: true });
    expect(runtime).toStrictEqual({
      threadId: 'thread-1',
      cwd: '/workspace',
      hydrated: false,
      activeTurnId: null,
      turns: [],
      turnIds: [],
      messages: [],
      answeredClientRequestIds: [],
      approvalPreset: 'approve-for-me',
      approvalPresets: ['ask-for-approval', 'approve-for-me'],
      permissionProfiles: [{ id: ':workspace', description: null, allowed: true }],
      skills: [{ name: 'review', path: '/skills/review/SKILL.md', enabled: true }],
      skillCatalogStatus: 'loaded',
      selectedModelId: 'model-1',
      selectedReasoningEffort: 'high',
      selectedServiceTier: 'priority',
      planMode: false,
      executionPlan: null,
      contextUsage: null,
      goal: null,
      turnGitDiff: null,
      threadStatus: null,
      queuedPrompts: [],
      busy: true,
      turnStartPending: false,
      historyLoading: false,
      loadingStrategy: 'eager',
      historyItemsView: 'full',
      historyCursor: null,
      historyHasOlder: false,
      historyLoadingOlder: false,
      historyMode: 'legacy',
      fullHistoryHydrated: false,
      error: null,
      planMarkdownByTurn: new Map(),
    });
    expect(runtime.approvalPresets).not.toBe(state.approvalPresets);
    expect(runtime.permissionProfiles).not.toBe(state.permissionProfiles);
    expect(runtime.skills).not.toBe(state.skills);
    expect(runtime.planMarkdownByTurn).toBeInstanceOf(Map);

    expect(createThreadRuntime('fallback', { ...state, historyState: undefined }).loadingStrategy)
      .toBe('lazy');
  });

  it('projects conversation-owned state with pending approvals and client requests', () => {
    const runtime = createThreadRuntime('thread-1', initialHostSnapshot(authentication), {
      messages: [{ id: 'assistant', role: 'assistant', status: 'streaming', parts: [] }],
      answeredClientRequestIds: ['answered'],
      planMode: true,
      busy: true,
      historyLoading: true,
      error: 'waiting',
    });
    const approvals = [{
      id: 'approval-1', kind: 'command' as const, conversationId: 'thread-1',
      itemId: 'item-1', title: 'Run tests',
    }];
    const clientRequests = [{
      id: 'request-1', kind: 'ask_user' as const, conversationId: 'thread-1',
      turnId: 'turn-1', itemId: 'item-1',
      payload: {
        request: { itemId: 'item-1', delivery: 'tool' as const, blocking: true, questions: [] },
      },
    }];

    expect(runtimeProjection(runtime, approvals, clientRequests)).toStrictEqual({
      approvalPreset: null,
      approvalPresets: [],
      answeredClientRequestIds: ['answered'],
      approvals,
      activeTurnId: null,
      busy: true,
      clientRequests,
      contextUsage: null,
      error: 'waiting',
      executionPlan: null,
      goal: null,
      historyLoading: true,
      historyState: {
        loadingStrategy: 'lazy',
        hasOlder: false,
        loadingOlder: false,
        fullyLoaded: false,
      },
      messages: runtime.messages,
      permissionProfiles: [],
      planMode: true,
      queuedPrompts: [],
      selectedModelId: null,
      selectedReasoningEffort: null,
      selectedServiceTier: null,
      skillCatalogStatus: 'notLoaded',
      skills: [],
      threadStatus: null,
      turnGitDiff: null,
      turns: [],
    });
  });

  it('derives pending and answered asynchronous questions from durable message history', () => {
    const request = {
      id: 'async-question:agent-question',
      kind: 'ask_user' as const,
      conversationId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'agent-question',
      payload: {
        request: {
          itemId: 'agent-question',
          delivery: 'async' as const,
          blocking: false,
          questions: [],
        },
      },
    };
    const pendingRuntime = createThreadRuntime('thread-1', initialHostSnapshot(authentication), {
      messages: [{
        id: 'assistant-question', role: 'assistant', status: 'complete',
        parts: [{ type: 'question', request }],
      }],
    });

    expect(runtimeProjection(pendingRuntime, [], []).clientRequests).toStrictEqual([request]);

    pendingRuntime.messages.push({
      id: 'user-answer', role: 'user', status: 'complete', parts: [{ type: 'text', text: 'Vue' }],
      metadata: { asyncQuestionRequestIds: [request.id] },
    });
    const answered = runtimeProjection(pendingRuntime, [], []);
    expect(answered.clientRequests).toStrictEqual([]);
    expect(answered.answeredClientRequestIds).toStrictEqual([request.id]);
  });
});
