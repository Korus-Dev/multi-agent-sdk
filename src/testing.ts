import { harnesses } from './harnesses';
import type { Harness, HarnessProvider } from './consumer-types';
import type { ProviderContext } from './context';
import type { ProviderEvent } from './contracts/events';
import type { ProviderSessionData } from './contracts';
import type { ProviderDriver } from './driver';

/** Provider operations a test can script, named as the provider reports them. */
export type ScriptedOperation =
  | 'sendPrompt' | 'steerPrompt' | 'interrupt' | 'setGoal' | 'clearGoal' | 'deleteTurn' | 'editTurn' | 'retryTurn'
  | 'continueInterruptedTurn' | 'loadConversation' | 'loadOlderHistory' | 'loadTurnHistory' | 'readConversationContent' | 'listConversations' | 'resumeConversation' | 'forkConversation' | 'readConversationMessages' | 'readConversationSummary' | 'executeScopedPrompt'
  | 'cancelScopedPrompt' | 'startReview' | 'tryHandlePromptCommand' | 'preparePromptOptions' | 'disposeScopedSession' | 'generateText' | 'generateImage' | 'setConversationTitle' | 'setPermissionMode' | 'setApprovalPreset' | 'releaseConversation' | 'archiveAgentConversation' | 'deleteAgentConversation' | 'reconcileConversations' | 'respondToAgentRequest' | 'listModels' | 'listSkills'
  | 'listPlugins' | 'authenticate' | 'getAccountRateLimits' | 'getBankedResets' | 'useBankedReset' | 'setConversationStorage' | 'startRealtime' | 'getRemoteControlStatus' | 'enableRemoteControl' | 'disableRemoteControl' | 'startDevicePairing' | 'checkDevicePairing' | 'listPairedDevices' | 'revokePairedDevice' | 'getRuntimeStatus' | 'getCapabilities' | 'close';
type Handler = (...args: never[]) => unknown;

export type ScriptedHarnessOptions = {
  /** ScriptedOperations the scripted provider does not offer; they reject with `HarnessUnsupportedError`. */
  unsupported?: readonly ScriptedOperation[];
  /** Overrides what `getCapabilities` reports. */
  capabilities?: Record<string, unknown>;
};

export type HarnessScript = {
  /** Replaces what an operation does. The handler receives the same arguments the provider would. */
  on(operation: ScriptedOperation, handler: Handler): void;
  /** Delivers a provider event to the harness, as the provider would. */
  emit(event: ProviderEvent): void;
  /** Recorded calls of one operation, oldest first. */
  calls(operation: ScriptedOperation): { args: unknown[] }[];
  /** Forgets recorded calls and handlers. */
  reset(): void;
};

function sessionFor(provider: HarnessProvider, context: ProviderContext): ProviderSessionData {
  return context.providerSession ?? harnesses[provider].sessionData(`${context.id}-session`, context.folder);
}

/**
 * A Harness over a provider that does nothing on its own, for testing an application against the Harness contract.
 * Every operation succeeds with a plausible result, is recorded, and can be replaced; provider events are pushed by the test.
 */
export function createScriptedHarness(provider: HarnessProvider, options: ScriptedHarnessOptions = {}): { harness: Harness; script: HarnessScript } {
  const handlers = new Map<string, Handler>();
  const recorded = new Map<string, { args: unknown[] }[]>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  const unsupported = new Set<string>(options.unsupported ?? []);
  let turns = 0;
  const turn = (context: ProviderContext) => ({ providerSession: sessionFor(provider, context), turnId: `turn-${++turns}` });
  const defaults: Record<string, (...args: never[]) => unknown> = {
    getRuntimeStatus: () => ({ provider, status: 'running' }),
    getCapabilities: () => ({ ...harnesses[provider].capabilities, ...options.capabilities }),
    sendPrompt: (context: ProviderContext) => turn(context),
    steerPrompt: (context: ProviderContext) => turn(context),
    startReview: (context: ProviderContext) => turn(context),
    interrupt: (context: ProviderContext) => ({ providerSession: sessionFor(provider, context) }),
    setGoal: (context: ProviderContext, objective: string) => ({ providerSession: sessionFor(provider, context), goal: { objective, status: 'active' } }),
    clearGoal: (context: ProviderContext) => ({ providerSession: sessionFor(provider, context), cleared: true }),
    deleteTurn: (context: ProviderContext) => ({ providerSession: sessionFor(provider, context), activeTurnId: null }),
    editTurn: (context: ProviderContext) => ({ providerSession: sessionFor(provider, context), activeTurnId: null }),
    retryTurn: (context: ProviderContext) => ({ providerSession: sessionFor(provider, context), activeTurnId: null }),
    continueInterruptedTurn: (context: ProviderContext) => ({ providerSession: sessionFor(provider, context), activeTurnId: null }),
    loadConversation: (context: ProviderContext) => context.providerSession ?? null,
    loadOlderHistory: () => ({ hasOlder: false }),
    loadTurnHistory: () => undefined,
    listConversations: () => [],
    listModels: () => [],
    listSkills: () => [],
    listPlugins: () => [],
    resumeConversation: (context: ProviderContext) => ({ providerSession: sessionFor(provider, context) }),
    forkConversation: (_context: ProviderContext, target: ProviderContext) => ({ providerSession: sessionFor(provider, target) }),
    executeScopedPrompt: (context: ProviderContext) => ({ text: '', session: sessionFor(provider, { ...context, providerSession: undefined, id: `${context.id}-scope` }) }),
    disposeScopedSession: () => undefined,
    setPermissionMode: (context: ProviderContext, mode: string) => ({ providerDefaults: { ...context.providerDefaults, kind: provider, permissionMode: mode } }),
    respondToAgentRequest: () => undefined,
    close: () => undefined,
  };
  const operation = (name: string) => (...args: unknown[]) => {
    const list = recorded.get(name) ?? []; list.push({ args }); recorded.set(name, list);
    return Promise.resolve((handlers.get(name) ?? defaults[name] ?? (() => undefined))(...(args as never[])));
  };
  const driver = new Proxy({ provider } as object, {
    get(target, property) {
      if (property === 'onEvent') return (listener: (event: ProviderEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
      if (property === 'provider') return provider;
      if (property === 'onUsage' || property === 'onRequestUsage') return () => () => {};
      if (property === 'getRuntimeStatus' || property === 'getCapabilities') return (...args: unknown[]) => (handlers.get(property) ?? defaults[property]!)(...(args as never[]));
      if ((property === 'tryHandlePromptCommand' || property === 'preparePromptOptions') && !handlers.has(property)) return undefined;
      if (typeof property !== 'string' || unsupported.has(property) || property === 'then') return (target as Record<string, unknown>)[property as string];
      return operation(property);
    },
  }) as ProviderDriver<ProviderContext, ProviderEvent>;
  const script: HarnessScript = {
    on: (name, handler) => { handlers.set(name, handler); },
    emit: event => { for (const listener of [...listeners]) listener(event); },
    calls: name => [...(recorded.get(name) ?? [])],
    reset: () => { handlers.clear(); recorded.clear(); },
  };
  return { harness: new harnesses[provider](driver), script };
}
export { createScriptedCodexHarness, scriptedCodexSnapshot, type ScriptedCodex, type ScriptedConversation } from './testing-codex';
export { createScriptedClaudeHarness, type ScriptedClaude } from './testing-claude';
