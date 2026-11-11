import { consumerContext } from './options-map';
import type { ProviderDriver as NativeDriver } from './driver';
import type { ProviderContext as NativeContext } from './context';
import type { ProviderConversationRef, ProviderDefaults, ProviderSessionData } from './contracts';
import type { ProviderEvent as NativeEvent } from './contracts/events';
import type { Admission, ConversationRef, HarnessCapabilities, HarnessContext, Harness, HarnessEvent, HarnessProvider, Session, SessionState } from './consumer-types';
import { createConsumerProjection } from './consumer-projection';
import { HarnessUnsupportedError } from './errors';

const emptyState = (): SessionState => ({ messages: [], busy: false, activeTurnId: null, turns: [], requests: [], error: null, title: null, goal: null, contextUsage: null, plan: null });
type Binding = { stored?: { providerSession?: unknown }; kind: 'main' | 'scope'; parent?: Session; operation?: 'executing' | 'disposing' | 'releasing' | 'hydrating'; nativeDisposed?: boolean; context: NativeContext; state: SessionState; project: ReturnType<typeof createConsumerProjection>; recovery?: boolean };

/** Adapts native lifecycle operations without changing admission or completion semantics. */
export function adaptHarness(provider: HarnessProvider, native: NativeDriver<NativeContext, NativeEvent>): Harness {
  const bindings = new Map<Session, Binding>();
  const byId = new Map<string, Session>();
  const refs = new WeakMap<ConversationRef, ProviderConversationRef>();
  const listeners = new Set<(event: HarnessEvent) => void>();
  const emit = (event: HarnessEvent) => { for (const listener of listeners) { try { listener(event); } catch (error) { process.emitWarning(error instanceof Error ? error : String(error)); } } };
  const get = (session: Session) => { const b = bindings.get(session); if (!b) throw new Error('Session does not belong to this driver.'); return b; };
  const interactive = (session: Session) => {
    const binding = get(session);
    if (binding.nativeDisposed || binding.operation === 'disposing' || binding.operation === 'releasing') throw new Error('Session cleanup is in progress.');
    return binding;
  };
  const main = (session: Session) => {
    const binding = interactive(session);
    if (binding.kind !== 'main') throw new Error('Scoped sessions require scoped continuation through their parent.');
    return binding;
  };
  const changed = (session: Session) => emit({ type: 'session.changed', session, state: structuredClone(get(session).state) });
  const adoptSession = (session: Session, data: ProviderSessionData, preserveRuntimeSelection = false) => {
    const binding = get(session);
    const previousSession = binding.context.providerSession;
    binding.context.providerSession = structuredClone(data);
    if (data.kind === 'claude') {
      const runtime = preserveRuntimeSelection && previousSession?.kind === 'claude' && previousSession.sessionId === data.sessionId
        ? binding.state.selection : undefined;
      binding.state.selection = {
        ...runtime,
        ...(data.model !== undefined && data.model !== runtime?.model ? { reasoningEffort: undefined, serviceTier: undefined } : {}),
        ...(data.model === undefined ? {} : { model: data.model }),
        ...(data.reasoningEffort === undefined ? {} : { reasoningEffort: data.reasoningEffort }),
      };
      changed(session);
    }
  };
  const unsubscribe = native.onEvent(event => {
    const session = event.agentId ? byId.get(event.agentId) : undefined;
    emit({ type: 'provider.event', session, event });
    if (!session) return;
    const b = get(session);
    const snapshotFrame = event.type.endsWith('.conversationSnapshotChanged');
    if (!b.recovery || snapshotFrame) {
      try {
        const state = b.project(event);
        if (state) {
          b.recovery = false; b.state = { ...b.state, ...structuredClone(state) };
          // Claude has no pending-request snapshot list. Only native answered evidence can prune it.
          const answered = new Set(b.state.answeredClientRequestIds ?? []);
          b.state.requests = b.state.requests.filter(request => !answered.has(request.id));
          changed(session);
        }
      } catch (error) {
        b.recovery = true;
        const reason = error instanceof Error ? error.message : String(error);
        b.state.error = reason; emit({ type: 'recovery.required', session, reason }); changed(session);
      }
    }
    if (event.type === 'plan.readyForReview') emit({ type: 'plan.readyForReview', session, turnId: event.turnId, ...event.payload });
    else if (event.type === 'agentRequest.created') {
      if (b.state.answeredClientRequestIds?.includes(event.payload.request.id)) return;
      b.state.requests = [...b.state.requests.filter(r => r.id !== event.payload.request.id), structuredClone(event.payload.request)];
      emit({ type: 'request.created', session, request: structuredClone(event.payload.request) }); changed(session);
    } else if (event.type === 'agentRequest.resolved') {
      b.state.requests = b.state.requests.filter(r => r.id !== event.payload.id);
      emit({ type: 'request.resolved', session, ...event.payload }); changed(session);
    } else if (event.type === 'conversation.modeUpdated' && event.payload.permissionMode !== undefined) {
      b.state.permission = event.payload.permissionMode;
      changed(session);
    } else if (event.type === 'conversation.settingsUpdated') {
      const { model, reasoningEffort, serviceTier, permissionMode, approvalPreset } = event.payload.settings;
      const permission = approvalPreset ?? permissionMode;
      if (permission !== undefined) b.state.permission = permission;
      if (model !== undefined || reasoningEffort !== undefined || serviceTier !== undefined) {
        const previous = b.state.selection;
        b.state.selection = {
          ...previous,
          ...(model === undefined ? {} : { model }),
          ...(model !== undefined && model !== previous?.model ? { reasoningEffort: undefined, serviceTier: undefined } : {}),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(serviceTier === undefined ? {} : { serviceTier }),
        };
      }
      if (model !== undefined || reasoningEffort !== undefined || serviceTier !== undefined || permission !== undefined) changed(session);
    } else if (event.type === 'agent.updated') { b.state.title = event.payload.conversationTitle ?? b.state.title; changed(session); }
    else if (event.type === 'conversation.goalUpdated') { b.state.goal = structuredClone(event.payload.goal); changed(session); }
    else if (event.type === 'conversation.goalCleared') { b.state.goal = null; changed(session); }
    else if (event.type === 'agent.statusChanged') emit({ type: 'status.changed', session, status: { type: event.payload.type, ...('detail' in event.payload && typeof event.payload.detail === 'string' ? { detail: event.payload.detail } : {}), ...('message' in event.payload && typeof event.payload.message === 'string' ? { message: event.payload.message } : {}), native: event.payload } });
    else if (event.type === 'conversation.contextUsageUpdated') { b.state.contextUsage = structuredClone(event.payload.contextUsage); changed(session); }
  });
  const offUsage = native.onUsage?.(observation => emit({ type: 'usage.observed', observation }));
  const offRequests = native.onRequestUsage?.(observation => emit({ type: 'requestUsage.observed', observation }));
  const admitted = (session: Session, result: import('./driver').ProviderSendResult): Admission => {
    adoptSession(session, result.providerSession, true);
    return { session, ...(result.turnId ? { turnId: result.turnId } : {}), ...(result.messageId ? { messageId: result.messageId } : {}) };
  };
  const capabilities = (session: Session): HarnessCapabilities => normalizedCapabilities(interactive(session).context);
  const normalizedCapabilities = (context?: NativeContext): HarnessCapabilities => {
    const { approvalPresets, permissionModes, login, realtime, remoteControl, accountUsage, ...caps } = native.getCapabilities(context);
    return { ...caps, login: [...(login ?? [])], realtime: Boolean(realtime), accountUsage: Boolean(accountUsage && native.getAccountRateLimits), remoteControl: Boolean(remoteControl && native.getRemoteControlStatus), permissions: [...(approvalPresets ?? []).map(id => ({ id, ...(id === 'full-access' ? { dangerous: true } : {}) })), ...(permissionModes ?? []).map(({ id, dangerous }) => ({ id, ...(dangerous ? { dangerous } : {}) }))] };
  };
  const permission = async (session: Session, id: string) => {
    const b = main(session); const caps = native.getCapabilities(b.context);
    if (!capabilities(session).permissions.some(p => p.id === id)) throw new Error('Unsupported permission option.');
    if (caps.approvalPresets?.includes(id as never)) {
      if (!native.setApprovalPreset) throw new Error('Permission updates are unavailable.');
      const result = await native.setApprovalPreset(b.context, id as import('./contracts').ApprovalPreset);
      b.context.providerSession = result.providerSession;
      b.context.providerDefaults = { ...b.context.providerDefaults, kind: 'codex', approvalPreset: result.approvalPreset };
      b.state.permission = result.approvalPreset;
    } else {
      if (!native.setPermissionMode) throw new Error('Permission updates are unavailable.');
      b.context.providerDefaults = (await native.setPermissionMode(b.context, id)).providerDefaults;
      b.state.permission = 'permissionMode' in b.context.providerDefaults ? b.context.providerDefaults.permissionMode : undefined;
    }
    changed(session);
  };
  const hydrate = async <T>(session: Session, action: (binding: Binding) => Promise<T>): Promise<T> => {
    const binding = interactive(session);
    const scoped = binding.kind === 'scope';
    if (scoped && (binding.operation || binding.state.busy || binding.state.activeTurnId)) throw new Error('Scope is busy.');
    if (scoped) binding.operation = 'hydrating';
    try { return await action(binding); }
    finally { if (scoped) binding.operation = undefined; }
  };
  const unavailable = (operation: string): never => { throw new HarnessUnsupportedError(operation); };
  const turnAction = (session: Session, result: import('./driver').ProviderTurnActionResult) => {
    admitted(session, result); return { session, activeTurnId: result.activeTurnId };
  };
  const open = (input: HarnessContext): Session => {
    if (byId.has(input.id)) throw new Error('A session with this id is already open.');
    const session = Object.freeze({}) as Session;
    const { defaults, ...context } = input;
    const { permission: mode, ...selection } = defaults ?? {};
    const providerDefaults = { kind: provider, ...selection, ...(mode ? provider === 'codex' ? { approvalPreset: mode } : { permissionMode: mode } : {}) } as ProviderDefaults;
    bindings.set(session, { kind: 'main', context: { ...context, provider: provider, providerDefaults }, state: emptyState(), project: createConsumerProjection() }); byId.set(input.id, session);
    if (mode && !capabilities(session).permissions.some(p => p.id === mode)) { bindings.delete(session); byId.delete(input.id); throw new Error('Unsupported permission option.'); }
    return session;
  };
  const validate = (value: { provider: string; data: object }, type: 'session' | 'ref'): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || value.provider !== provider || !value.data || typeof value.data !== 'object') throw new Error('Invalid persisted harness handle.');
    const data = value.data as Record<string, unknown>;
    const identity = provider === 'codex' ? data.threadId : data.sessionId;
    if (typeof identity !== 'string' || !identity || (type === 'session' ? data.kind : data.provider) !== provider) throw new Error('Invalid persisted harness identity.');
    if (type === 'session' && provider === 'claude' && !['stdio', 'websocket'].includes(String(data.transport))) throw new Error('Invalid Claude transport.');
    if (type === 'ref' && provider !== 'codex' && data.folder !== null && typeof data.folder !== 'string') throw new Error('Invalid persisted folder.');
    return data;
  };
  const reference = (data: ProviderConversationRef): ConversationRef => { const ref = Object.freeze({}) as ConversationRef; refs.set(ref, structuredClone(data)); return ref; };
  const mergeDefaults = (current: ProviderDefaults, defaults: Partial<import('./consumer-types').HarnessDefaults>): ProviderDefaults => {
    const { permission: mode, ...selection } = defaults;
    return { ...current, ...Object.fromEntries(Object.entries(selection).filter(([, value]) => value !== undefined)),
      ...(mode ? provider === 'codex' ? { approvalPreset: mode } : { permissionMode: mode } : {}) } as ProviderDefaults;
  };
  const applyDefaults = (session: Session, defaults: Partial<import('./consumer-types').HarnessDefaults>) => {
    const b = get(session);
    b.context.providerDefaults = mergeDefaults(b.context.providerDefaults ?? { kind: provider } as ProviderDefaults, defaults);
  };
  return {
    getRuntimeStatus() { const { detail, capabilities: _capabilities, ...status } = native.getRuntimeStatus(); return { ...status, ...(typeof detail === 'string' ? { detail } : {}) }; },
    async authenticate(action) { const state = await (native.authenticate?.(action) ?? unavailable('Authentication')); return { connected: state.connected, ...(state.login ? { login: state.login } : {}), native: state }; },
    getBankedResets: async () => native.getBankedResets?.() ?? unavailable('Banked resets'),
    useBankedReset: async input => native.useBankedReset?.(input) ?? unavailable('Banked resets'),
    getAccountRateLimits: () => native.getAccountRateLimits?.() ?? Promise.resolve(null),
    startRealtime: async (session, options) => native.startRealtime?.(main(session).context, options) ?? unavailable('Realtime'),
    getRemoteControl: async () => native.getRemoteControlStatus?.() ?? unavailable('Remote control'),
    setRemoteControl: async enabled => (enabled ? native.enableRemoteControl?.() : native.disableRemoteControl?.()) ?? unavailable('Remote control'),
    startDevicePairing: async () => native.startDevicePairing?.() ?? unavailable('Device pairing'),
    checkDevicePairing: async pairing => native.checkDevicePairing?.(pairing) ?? unavailable('Device pairing'),
    listPairedDevices: async environmentId => native.listPairedDevices?.(environmentId) ?? unavailable('Paired devices'),
    revokePairedDevice: async (environmentId, clientId) => native.revokePairedDevice?.(environmentId, clientId) ?? unavailable('Paired devices'),
    listModels: session => native.listModels?.(main(session).context) ?? unavailable('Model catalog'),
    listSkills: (session, forceReload) => native.listSkills?.(main(session).context, forceReload) ?? unavailable('Skill catalog'),
    listPlugins: session => native.listPlugins?.(main(session).context) ?? unavailable('Plugin catalog'),
    generateText: (session, input) => native.generateText?.(main(session).context, input) ?? unavailable('Text generation'),
    generateImage: (session, input, signal) => native.generateImage?.(main(session).context, input, signal) ?? unavailable('Image generation'),
    setConversationTitle: (session, title) => native.setConversationTitle?.(main(session).context, title) ?? unavailable('Conversation title'),
    async setGoal(session, objective) {
      const result = await (native.setGoal?.(main(session).context, objective) ?? unavailable('Goals'));
      const admission = admitted(session, result);
      if (result.goal) { get(session).state.goal = structuredClone(result.goal); changed(session); }
      return { ...admission, ...(result.goal ? { goal: result.goal } : {}) };
    },
    async clearGoal(session) {
      const result = await (native.clearGoal?.(main(session).context) ?? unavailable('Goals'));
      const admission = admitted(session, result);
      if (result.cleared === true) { get(session).state.goal = null; changed(session); }
      return { ...admission, ...(result.cleared === undefined ? {} : { cleared: result.cleared }) };
    },
    async steerPrompt(session, prompt, options) { return admitted(session, await (native.steerPrompt?.(interactive(session).context, prompt, options) ?? unavailable('Steering'))); },
    async deleteTurn(session, turnId) { return turnAction(session, await (native.deleteTurn?.(main(session).context, turnId) ?? unavailable('Turn deletion'))); },
    async editTurn(session, turnId, content, options) { return turnAction(session, await (native.editTurn?.(main(session).context, turnId, content, options) ?? unavailable('Turn editing'))); },
    async retryTurn(session, turnId) { return turnAction(session, await (native.retryTurn?.(main(session).context, turnId) ?? unavailable('Turn retry'))); },
    async assertHandoffReady(session) { await (native.assertHandoffReady?.(main(session).context) ?? unavailable('Hand-off readiness checks')); },
    async forkWorktreeConversation(session, target) {
      const result = await (native.forkWorktreeConversation?.(main(session).context, main(target).context) ?? unavailable('Worktree conversation fork'));
      return result ? admitted(target, result) : null;
    },
    handlePromptCommand(session, prompt) {
      const handled = native.tryHandlePromptCommand?.(main(session).context, prompt);
      return handled ? handled.then(result => admitted(session, result)) : null;
    },
    preparePromptOptions: (session, options) => native.preparePromptOptions ? native.preparePromptOptions(main(session).context, options) : options,
    async continueInterruptedTurn(session, safetyReview) { return turnAction(session, await (native.continueInterruptedTurn?.(main(session).context, safetyReview) ?? unavailable('Interrupted turn continuation'))); },
    async reconcileConversations(sessions) { await native.reconcileConversations?.(sessions.map(session => main(session).context)); },
    async forkConversation(session, target, turnId) { return admitted(target, await (native.forkConversation?.(main(session).context, main(target).context, turnId) ?? unavailable('Conversation fork'))); },
    async replaceConversationWithSummary(session) { return admitted(session, await (native.replaceConversationWithSummary?.(main(session).context) ?? unavailable('Conversation summary replacement'))); },
    archiveConversation: session => native.archiveAgentConversation?.(main(session).context) ?? unavailable('Conversation archive'),
    deleteConversation: session => native.deleteAgentConversation?.(main(session).context) ?? unavailable('Conversation deletion'),
    readConversationMessages(session, ref, options) {
      const value = refs.get(ref); if (!value) throw new Error('Unknown conversation reference.');
      return native.readConversationMessages?.(value, interactive(session).context.id, options) ?? unavailable('Conversation messages');
    },
    async setConversationStorage(ref, state) {
      const value = refs.get(ref); if (!value) throw new Error('Unknown conversation reference.');
      await (native.setConversationStorage?.(value, state) ?? unavailable('Conversation storage'));
    },
    async readConversationSummary(session, ref) {
      const value = refs.get(ref); if (!value) throw new Error('Unknown conversation reference.');
      const found = await (native.readConversationSummary?.(interactive(session).context, value) ?? unavailable('Conversation summary'));
      if (!found) return null;
      const { ref: nativeRef, ...rest } = found; const handle = Object.freeze({}) as ConversationRef; refs.set(handle, nativeRef);
      return { ...rest, ref: handle };
    },
    readConversationContent(session, input) {
      const context = interactive(session).context; const binding = context.providerSession;
      if (!binding) throw new Error('Session has not been admitted.');
      const sessionId = binding.kind === 'codex' ? binding.threadId : binding.sessionId;
      return native.readConversationContent?.(context, { ...input, sessionId }) ?? unavailable('Conversation content');
    },
    getSessionData(session) {
      const binding = get(session); const data = (binding.stored ? binding.stored.providerSession : binding.context.providerSession) as ProviderSessionData | undefined;
      if (!data) throw new Error('Session has not been admitted.');
      if (binding.nativeDisposed || binding.operation === 'disposing' || binding.operation === 'releasing') throw new Error('Scope disposal has already started.');
      const parentId = binding.parent ? get(binding.parent).context.id : undefined;
      return structuredClone({ provider, data, defaults: consumerContext(binding.context).defaults, role: binding.kind, ...(parentId ? { parentId } : {}) });
    },
    restoreSession(context, saved) {
      const data = validate(saved, 'session');
      if (saved.role !== undefined && saved.role !== 'main' && saved.role !== 'scope') throw new Error('Invalid persisted session role.');
      const parent = saved.role === 'scope' ? byId.get(saved.parentId ?? '') : undefined;
      if (saved.role === 'scope' && (!parent || get(parent).kind !== 'main')) throw new Error('Restore the main scope parent first.');
      if (parent) main(parent);
      const session = open({ ...context, defaults: context.defaults ?? saved.defaults });
      const binding = get(session); binding.context.providerSession = data as ProviderSessionData;
      if (parent) { binding.kind = 'scope'; binding.parent = parent; }
      return session;
    },
    getRefData(ref) { const data = refs.get(ref); if (!data) throw new Error('Unknown conversation reference.'); return structuredClone({ provider, data }); },
    restoreRef(saved) { return reference(validate(saved, 'ref') as ProviderConversationRef); },
    getConversationRef(session) {
      const context = interactive(session).context; const data = context.providerSession;
      if (!data) return null;
      return reference(data.kind === 'codex' ? { provider: 'codex', threadId: data.threadId }
        : { provider: data.kind, sessionId: data.sessionId, folder: context.folder });
    },
    open, getCapabilities: capabilities, getProviderCapabilities: () => normalizedCapabilities(), readSession: session => structuredClone(get(session).state),
    async sendPrompt(session, prompt, options) { return admitted(session, await native.sendPrompt(main(session).context, prompt, options)); },
    async interrupt(session, expectedTurnId) { return admitted(session, await native.interrupt(interactive(session).context, expectedTurnId)); },
    async respondToRequest(session, response) {
      const b = interactive(session);
      if (!b.state.requests.some(r => r.id === response.id)) throw new Error('Request does not belong to this session or is no longer pending.');
      await native.respondToAgentRequest({ ...response, agentId: b.context.id });
    },
    setPermission: permission,
    bindSession(session, source) {
      const context = get(session).context as unknown as Record<string, unknown>;
      const binding = get(session);
      const stored = { providerSession: context.providerSession, folder: context.folder, name: context.name, providerDefaults: context.providerDefaults };
      const defaultsOf = () => { const live = source().defaults; if (live === undefined) return stored.providerDefaults; return mergeDefaults({ kind: provider } as ProviderDefaults, live); };
      binding.stored = stored;
      Object.defineProperties(context, {
        providerSession: { enumerable: true, configurable: true, get: () => { const v = source().data; return v === undefined ? stored.providerSession : (v ?? undefined); }, set: (value: unknown) => { stored.providerSession = value; } },
        folder: { enumerable: true, configurable: true, get: () => { const v = source().folder; return v === undefined ? stored.folder : v; }, set: (value: unknown) => { stored.folder = value; } },
        name: { enumerable: true, configurable: true, get: () => { const v = source().name; return v === undefined ? stored.name : v; }, set: (value: unknown) => { stored.name = value; } },
        providerDefaults: { enumerable: true, configurable: true, get: defaultsOf, set: (value: unknown) => { stored.providerDefaults = value as ProviderDefaults | undefined; } },
      });
    },
    syncSession(session, state) {
      const b = get(session);
      if (state.data) validate({ provider, data: state.data }, 'session');
      if (state.data !== undefined) b.context.providerSession = state.data ?? undefined;
      if (state.folder !== undefined) b.context.folder = state.folder;
      if (state.name !== undefined) b.context.name = state.name;
      if (state.defaults !== undefined) { b.context.providerDefaults = { kind: provider } as ProviderDefaults; applyDefaults(session, state.defaults); }
    },
    updateDefaults: applyDefaults,
    loadConversation(session) {
      if (!native.loadConversation) throw new Error('Conversation loading is unavailable.');
      return hydrate(session, async binding => {
        const result = await native.loadConversation!(binding.context);
        if (result) adoptSession(session, result);
        return result !== null;
      });
    },
    loadTurnHistory: (session, turnId) => hydrate(session, binding => native.loadTurnHistory?.(binding.context, turnId) ?? unavailable('Turn history')),
    loadOlderHistory(session) {
      if (!native.loadOlderHistory) throw new Error('History paging is unavailable.');
      return hydrate(session, async binding => { const result = await native.loadOlderHistory!(binding.context); return { hasOlder: result.hasOlder }; });
    },
    async listConversations(session, input) {
      if (!native.listConversations) throw new Error('Conversation listing is unavailable.');
      return (await native.listConversations(main(session).context, input)).map(({ ref, ...summary }) => {
        const handle = Object.freeze({}) as ConversationRef; refs.set(handle, ref); return { ...summary, ref: handle };
      });
    },
    async resumeConversation(session, target) {
      const ref = refs.get(target.ref); if (!ref) throw new Error('Conversation reference does not belong to this driver.');
      if (!native.resumeConversation) throw new Error('Conversation resume is unavailable.');
      const result = await native.resumeConversation(main(session).context, { ...target, ref }); adoptSession(session, result.providerSession);
    },
    openScope(parent, input) {
      const p = main(parent);
      const defaults = consumerContext(p.context).defaults;
      const scoped = open({ id: `${p.context.id}:scope:${crypto.randomUUID()}`, folder: input.cwd, ...(defaults ? { defaults } : {}) });
      const binding = get(scoped);
      binding.kind = 'scope'; binding.parent = parent;
      binding.context.providerDefaults = structuredClone(p.context.providerDefaults);
      return scoped;
    },
    async executeScopedPrompt(session, input) {
      const parent = main(session);
      if (parent.kind !== 'main') throw new Error('Scoped execution requires a main parent session.');
      input.signal?.throwIfAborted();
      if (!native.executeScopedPrompt) throw new Error('Scoped execution is unavailable.');
      if (input.signal && !native.cancelScopedPrompt) throw new Error('Scoped cancellation is unavailable.');
      const scoped = input.session ?? open({ id: `${parent.context.id}:scope:${crypto.randomUUID()}`, folder: input.cwd, ...(consumerContext(parent.context).defaults ? { defaults: consumerContext(parent.context).defaults } : {}) });
      const binding = get(scoped);
      if (input.session) {
        if (binding.kind !== 'scope') throw new Error('Only a scoped session can continue scoped execution.');
        if (binding.parent !== session) throw new Error('Scope belongs to another parent session.');
        if (binding.context.folder !== input.cwd) throw new Error('Scope belongs to another workspace.');
      } else {
        binding.kind = 'scope'; binding.parent = session;
        binding.context.providerDefaults = structuredClone(parent.context.providerDefaults);
      }
      if (binding.operation || binding.state.busy || binding.state.activeTurnId) throw new Error('Scope is busy.');
      if (binding.nativeDisposed) throw new Error('Scope disposal has already started.');
      binding.operation = 'executing';
      let cancellation: Promise<void> | undefined;
      const cancel = () => {
        cancellation ??= (async () => {
          await native.cancelScopedPrompt!(binding.context);
        })();
        // Settlement below owns cleanup errors, without an unhandled rejection in the meantime.
        void cancellation.catch(() => {});
      };
      input.signal?.addEventListener('abort', cancel, { once: true });
      try {
        input.signal?.throwIfAborted();
        const result = await native.executeScopedPrompt(binding.context, { ...input, session: binding.context.providerSession });
        input.signal?.throwIfAborted();
        binding.context.providerSession = result.session; return { text: result.text, session: scoped };
      } catch (error) {
        try { await cancellation; }
        finally {
          if (!input.session || input.signal?.aborted) {
            // A native initialization can finish after the first abort cleanup; release it again.
            await native.releaseConversation?.(binding.context.id); byId.delete(binding.context.id); bindings.delete(scoped);
          }
        }
        input.signal?.throwIfAborted();
        throw error;
      } finally {
        input.signal?.removeEventListener('abort', cancel);
        binding.operation = undefined;
        await cancellation;
      }
    },
    async disposeScopedSession(session) {
      const b = get(session);
      if (b.kind !== 'scope') throw new Error('Only scoped sessions can be disposed as scopes.');
      if (b.operation || b.state.busy || b.state.activeTurnId) throw new Error('Scope is busy.');
      if (!native.disposeScopedSession || !native.releaseConversation || !b.context.providerSession) throw new Error('Scoped disposal is unavailable.');
      b.operation = 'disposing';
      try {
        if (!b.nativeDisposed) {
          await native.disposeScopedSession(b.context, b.context.providerSession);
          b.nativeDisposed = true;
        }
        await native.releaseConversation(b.context.id);
        byId.delete(b.context.id); bindings.delete(session);
      } finally { b.operation = undefined; }
    },
    async release(session) {
      const b = get(session);
      if (b.operation) throw new Error('Session is busy.');
      if (b.kind === 'main' && [...bindings.values()].some(child => child.parent === session)) throw new Error('Release or dispose child scopes before releasing their parent.');
      b.operation = 'releasing';
      try {
        await native.releaseConversation?.(b.context.id); byId.delete(b.context.id); bindings.delete(session);
      } finally { b.operation = undefined; }
    },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() { try { await native.close(); } finally { unsubscribe(); offUsage?.(); offRequests?.(); listeners.clear(); bindings.clear(); byId.clear(); } },
  };
}
