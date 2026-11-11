import type { CodexConversationEvent, CodexConversationSnapshot, CodexEvent } from './core/codex-conversation-types';
import type { CodexHost } from './providers/codex';
import type { Harness } from './consumer-types';
import type { HarnessOptions } from './options';
import { CodexHarness } from './providers/codex/harness';

type Handler = (...args: never[]) => unknown;
type Recorded = { args: unknown[] };

/** An empty, connected conversation snapshot; tests override what they care about. */
export function scriptedCodexSnapshot(id = 'conversation-a', overrides: Partial<CodexConversationSnapshot> = {}): CodexConversationSnapshot {
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
  } as CodexConversationSnapshot;
}

/** Records calls and runs handlers for every method of a scripted engine object. */
function scriptedObject(defaults: Record<string, Handler>, extra: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>(); const recorded = new Map<string, Recorded[]>();
  const object = new Proxy({ ...extra } as Record<string, unknown>, {
    get(target, property) {
      if (typeof property !== 'string' || property === 'then') return undefined;
      if (property in target) return target[property];
      return (...args: unknown[]) => {
        const list = recorded.get(property) ?? []; list.push({ args }); recorded.set(property, list);
        return (handlers.get(property) ?? defaults[property] ?? (() => undefined))(...(args as never[]));
      };
    },
  });
  return { object, on: (name: string, handler: Handler) => { handlers.set(name, handler); }, calls: (name: string): Recorded[] => [...(recorded.get(name) ?? [])] };
}

export type ScriptedConversation = {
  /** Delivers an engine event for this conversation, as the Codex runtime would. */
  emit(event: CodexConversationEvent): void;
  /** Replaces the conversation's current snapshot. */
  setSnapshot(snapshot: Partial<CodexConversationSnapshot>): void;
  /** Replaces what an engine operation (for example `sendMessage`) does. */
  on(operation: string, handler: Handler): void;
  calls(operation: string): Recorded[];
  listenerCount(): number;
  /** The engine-side conversation object, for operations that hand one back (for example a fork result). */
  handle: unknown;
};

export type ScriptedCodex = {
  harness: Harness;
  conversation(id: string): ScriptedConversation;
  /** Scripts the engine itself (account, login, remote control, conversation lifecycle). */
  engine: { emit(event: CodexEvent): void; on(operation: string, handler: Handler): void; calls(operation: string): Recorded[] };
};

/** A Codex Harness whose engine is scripted by the test; the SDK's own adapter derives requests, status and usage from the events. */
export function createScriptedCodexHarness(options: HarnessOptions = { client: { name: 'scripted' } }): ScriptedCodex {
  const conversations = new Map<string, ReturnType<typeof makeConversation>>();
  const listeners = new Set<(event: CodexEvent) => void>();
  const makeConversation = (id: string) => {
    let snapshot = scriptedCodexSnapshot(id);
    const eventListeners = new Set<(event: CodexConversationEvent) => void>();
    const scripted = scriptedObject({
      getSnapshot: () => snapshot, load: async () => snapshot,
      sendMessage: async () => snapshot, steerMessage: async () => snapshot, interrupt: async () => snapshot, rename: async () => snapshot,
      updateSettings: async () => snapshot, setGoal: async () => snapshot, clearGoal: async () => snapshot, resolveApproval: async () => snapshot,
      respondToClientRequest: async () => snapshot, editTurn: async () => snapshot, deleteTurn: async () => snapshot, retryTurn: async () => snapshot,
      continueInterruptedTurn: async () => snapshot, continueAfterSafetyReview: async () => snapshot, loadTurnHistory: async () => snapshot,
    }, {
      id,
      getSnapshot: () => snapshot,
      onEvent: (listener: (event: CodexConversationEvent) => void) => { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
    });
    return { handle: scripted.object, scripted, setSnapshot: (next: Partial<CodexConversationSnapshot>) => { snapshot = scriptedCodexSnapshot(id, next); },
      emit: (event: CodexConversationEvent) => { for (const listener of [...eventListeners]) listener(event); }, listenerCount: () => eventListeners.size };
  };
  const conversation = (id: string) => { if (!conversations.has(id)) conversations.set(id, makeConversation(id)); return conversations.get(id)!; };
  const engine = scriptedObject({
    getSnapshot: () => scriptedCodexSnapshot(),
    archiveConversation: async (id: string) => scriptedCodexSnapshot(id), deleteConversation: async (id: string) => scriptedCodexSnapshot(id), unarchiveConversation: async (id: string) => scriptedCodexSnapshot(id),
    listConversations: async () => [], listModels: async () => [], listSkills: async () => [], readConfigRequirements: async () => null,
    close: async () => undefined, connect: async () => undefined,
  }, {
    onEvent: (listener: (event: CodexEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    conversation: (id: string) => conversation(id).handle,
  });
  const native = CodexHarness.mapOptions(options);
  const driver = CodexHarness.createHost({ ...native, codex: { ...native.codex, existingHost: engine.object as unknown as CodexHost } });
  return {
    harness: new CodexHarness(driver),
    conversation: id => { const c = conversation(id); return { emit: c.emit, setSnapshot: c.setSnapshot, on: c.scripted.on, calls: c.scripted.calls, listenerCount: c.listenerCount, handle: c.handle }; },
    engine: { emit: event => { for (const listener of [...listeners]) listener(event); }, on: engine.on, calls: engine.calls },
  };
}
