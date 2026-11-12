import { vi } from 'vitest';
import type { Agent } from '../../../src/contracts/index';
import type { NativeHarnessEvent as HarnessEvent } from '../../../src/internal';
import type { CodexConversation, CodexHost } from '../../../src/providers/codex';
import type { CodexConversationEvent, CodexConversationSnapshot, CodexConversationSummary, CodexEvent } from '../../../src/internal';
import { CodexHostController } from '../../../src/providers/codex/host-controller';
import { CodexHostAdapter, type CodexHostAdapterOptions } from '../../../src/providers/codex/host-adapter';

export function sdkSnapshot(id = 'conversation-a', overrides: Partial<CodexConversationSnapshot> = {}): CodexConversationSnapshot {
  return {
    status: 'ready', authentication: {
      status: 'loaded', account: null, requiresOpenaiAuth: false, error: null,
      login: { status: 'idle', loginId: null, authUrl: null, error: null },
    },
    conversations: [], activeConversationId: id, activeTurnId: null, turnIds: [], turns: [], messages: [],
    clientRequests: [], answeredClientRequestIds: [], approvals: [], models: [],
    modelCatalogStatus: 'loaded', skills: [], skillCatalogStatus: 'loaded', plugins: [], pluginCatalogStatus: 'loaded',
    permissionProfiles: [], approvalPresets: [], approvalPreset: null, selectedModelId: null,
    selectedReasoningEffort: null, selectedServiceTier: null, planMode: false, contextUsage: null,
    goal: null, turnGitDiff: null, threadStatus: null, rateLimits: null, queuedPrompts: [],
    busy: false, historyLoading: false, error: null, ...overrides,
  };
}

export function sdkAgent(id = 'agent-a', conversationId = 'conversation-a'): Agent {
  return {
    id, name: id, folder: '/repo', provider: 'codex',
    providerSession: { kind: 'codex', conversationId: conversationId },
  };
}

export function sdkSummary(id: string, overrides: Partial<CodexConversationSummary> = {}): CodexConversationSummary {
  return { id, title: id, preview: '', cwd: '/repo', status: 'idle', turnCount: 0, createdAt: '2026-09-16T00:00:00Z', updatedAt: '2026-09-16T00:00:00Z', ...overrides };
}

/** A scripted SDK boundary, not an SDK reducer: tests supply snapshots and events explicitly. */
function conversationFixture(id: string) {
  let snapshot = sdkSnapshot(id);
  const listeners = new Set<(event: CodexConversationEvent) => void>();
  const handle = {
    id,
    getSnapshot: vi.fn(() => snapshot),
    onEvent: vi.fn((listener: (event: CodexConversationEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
    load: vi.fn<CodexConversation['load']>(async () => snapshot),
    sendMessage: vi.fn<CodexConversation['sendMessage']>(async () => snapshot),
    steerMessage: vi.fn<CodexConversation['steerMessage']>(async () => snapshot),
    interrupt: vi.fn<CodexConversation['interrupt']>(async () => snapshot),
    rename: vi.fn<CodexConversation['rename']>(async () => snapshot),
    updateSettings: vi.fn<CodexConversation['updateSettings']>(async () => snapshot),
    setGoal: vi.fn<CodexConversation['setGoal']>(async () => snapshot),
    clearGoal: vi.fn<CodexConversation['clearGoal']>(async () => snapshot),
    startReview: vi.fn<CodexConversation['startReview']>(async () => snapshot),
    resolveApproval: vi.fn<CodexConversation['resolveApproval']>(async () => snapshot),
    respondToClientRequest: vi.fn<CodexConversation['respondToClientRequest']>(async () => snapshot),
    editTurn: vi.fn<CodexConversation['editTurn']>(async () => snapshot),
    deleteTurn: vi.fn<CodexConversation['deleteTurn']>(async () => snapshot),
    retryTurn: vi.fn<CodexConversation['retryTurn']>(async () => snapshot),
    continueInterruptedTurn: vi.fn<CodexConversation['continueInterruptedTurn']>(async () => snapshot),
    continueAfterSafetyReview: vi.fn<NonNullable<CodexConversation['continueAfterSafetyReview']>>(async () => snapshot),
    fork: vi.fn<CodexConversation['fork']>(),
    forkTurn: vi.fn<CodexConversation['forkTurn']>(),
    readContent: vi.fn<CodexConversation['readContent']>(),
    readHistory: vi.fn<CodexConversation['readHistory']>(),
    loadOlderHistory: vi.fn<CodexConversation['loadOlderHistory']>(),
    loadTurnHistory: vi.fn<CodexConversation['loadTurnHistory']>(async () => snapshot),
  } satisfies Partial<CodexConversation>;
  return {
    handle,
    setSnapshot(next: Partial<CodexConversationSnapshot>) { snapshot = sdkSnapshot(id, next); },
    emit(event: CodexConversationEvent) { for (const listener of listeners) listener(event); },
    listenerCount: () => listeners.size,
  };
}

export function codexSdkFixture(closeRuntime?: () => Promise<void>, options: CodexHostAdapterOptions = {}) {
  const conversations = new Map<string, ReturnType<typeof conversationFixture>>();
  const listeners = new Set<(event: CodexEvent) => void>();
  const conversation = (id: string) => {
    if (!conversations.has(id)) conversations.set(id, conversationFixture(id));
    return conversations.get(id)!;
  };
  const host = {
    connect: vi.fn<CodexHost['connect']>(),
    close: vi.fn<CodexHost['close']>(),
    getSnapshot: vi.fn<CodexHost['getSnapshot']>(() => sdkSnapshot()),
    onEvent: vi.fn((listener: (event: CodexEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
    conversation: vi.fn((id: string) => conversation(id).handle as unknown as CodexConversation),
    forgetConversation: vi.fn<CodexHost['forgetConversation']>(),
    createConversation: vi.fn<CodexHost['createConversation']>(),
    archiveConversation: vi.fn<CodexHost['archiveConversation']>(async (id) => sdkSnapshot(id)),
    deleteConversation: vi.fn<CodexHost['deleteConversation']>(async (id) => sdkSnapshot(id)),
    unarchiveConversation: vi.fn<CodexHost['unarchiveConversation']>(async (id) => sdkSnapshot(id)),
    listConversations: vi.fn<CodexHost['listConversations']>().mockResolvedValue([]),
    listModels: vi.fn<CodexHost['listModels']>().mockResolvedValue([]),
    listSkills: vi.fn<CodexHost['listSkills']>().mockResolvedValue([]),
    readConversationSummary: vi.fn<CodexHost['readConversationSummary']>(),
    readConversationMessages: vi.fn<CodexHost['readConversationMessages']>(),
    generateText: vi.fn<CodexHost['generateText']>(),
    refreshAccount: vi.fn<CodexHost['refreshAccount']>(),
    startChatGptLogin: vi.fn<CodexHost['startChatGptLogin']>(),
    startChatGptDeviceCodeLogin: vi.fn<CodexHost['startChatGptDeviceCodeLogin']>(),
    cancelLogin: vi.fn<CodexHost['cancelLogin']>(),
    logout: vi.fn<CodexHost['logout']>(),
    readRemoteControlStatus: vi.fn<CodexHost['readRemoteControlStatus']>(),
    readConfigRequirements: vi.fn<CodexHost['readConfigRequirements']>().mockResolvedValue(null),
    enableRemoteControl: vi.fn<CodexHost['enableRemoteControl']>(),
    disableRemoteControl: vi.fn<CodexHost['disableRemoteControl']>(),
    startRemoteControlPairing: vi.fn<CodexHost['startRemoteControlPairing']>(),
    readRemoteControlPairingStatus: vi.fn<CodexHost['readRemoteControlPairingStatus']>(),
    listRemoteControlClients: vi.fn<CodexHost['listRemoteControlClients']>(),
    revokeRemoteControlClient: vi.fn<CodexHost['revokeRemoteControlClient']>(),
    respondToClientRequest: vi.fn<CodexHost['respondToClientRequest']>(),
  } satisfies Partial<CodexHost>;
  // SDK classes have private members; each implemented public member is checked above.
  const adapter = new CodexHostAdapter(host as unknown as CodexHost, closeRuntime, options);
  const driver = new CodexHostController(adapter);
  const events: HarnessEvent[] = [];
  driver.onEvent((event) => events.push(event));
  return { driver, adapter, host, conversation, events,
    emit(event: CodexEvent) { for (const listener of listeners) listener(event); },
  };
}
