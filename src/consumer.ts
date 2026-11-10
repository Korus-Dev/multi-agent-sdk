import { createHarnessDriver as createNativeHarnessDriver, type HarnessOptions as NativeOptions } from './backend';
import type { HarnessDriver as NativeDriver } from './driver';
import type { HarnessContext as NativeContext } from './context';
import type { BackendConversationRef, BackendDefaults, BackendSession } from './contracts';
import type { HarnessEvent as NativeEvent } from './contracts/events';
import type { Admission, ConversationRef, HarnessCapabilities, HarnessContext, HarnessDriver, HarnessEvent, HarnessProvider, Session, SessionState } from './consumer-types';
import { createConsumerProjection } from './consumer-projection';
/** Shared consumer hooks receive input context only; native options are explicit escape hatches. */
export type HarnessOptions = Omit<NativeOptions, 'instructions' | 'mcpServers'> & {
  instructions?: (context: HarnessContext) => string | undefined;
  mcpServers?: (context: HarnessContext) => readonly import('./generation').HarnessMcpEndpoint[];
};

const emptyState = (): SessionState => ({ messages: [], busy: false, activeTurnId: null, turns: [], requests: [], error: null, title: null, goal: null, contextUsage: null, plan: null });
type Binding = { context: NativeContext; state: SessionState; project: ReturnType<typeof createConsumerProjection>; recovery?: boolean };

/** Adapts native lifecycle operations without changing admission or completion semantics. */
export function adaptHarnessDriver(provider: HarnessProvider, native: NativeDriver<NativeContext, NativeEvent>): HarnessDriver {
  const bindings = new Map<Session, Binding>();
  const byId = new Map<string, Session>();
  const refs = new Map<ConversationRef, BackendConversationRef>();
  const listeners = new Set<(event: HarnessEvent) => void>();
  const emit = (event: HarnessEvent) => { for (const listener of listeners) { try { listener(event); } catch (error) { process.emitWarning(error instanceof Error ? error : String(error)); } } };
  const get = (session: Session) => { const b = bindings.get(session); if (!b) throw new Error('Session does not belong to this driver.'); return b; };
  const changed = (session: Session) => emit({ type: 'session.changed', session, state: structuredClone(get(session).state) });
  const unsubscribe = native.onEvent(event => {
    const session = event.agentId ? byId.get(event.agentId) : undefined;
    if (!session) return;
    const b = get(session);
    const snapshotFrame = event.type.endsWith('.conversationSnapshotChanged');
    if (!b.recovery || snapshotFrame) {
      try {
        const state = b.project(event);
        if (state) { b.recovery = false; b.state = { ...b.state, ...structuredClone(state) }; changed(session); }
      } catch (error) {
        b.recovery = true;
        const reason = error instanceof Error ? error.message : String(error);
        b.state.error = reason; emit({ type: 'recovery.required', session, reason }); changed(session);
      }
    }
    if (event.type === 'plan.readyForReview') emit({ type: 'plan.readyForReview', session, turnId: event.turnId, ...event.payload });
    else if (event.type === 'agentRequest.created') {
      b.state.requests = [...b.state.requests.filter(r => r.id !== event.payload.request.id), structuredClone(event.payload.request)];
      emit({ type: 'request.created', session, request: structuredClone(event.payload.request) }); changed(session);
    } else if (event.type === 'agentRequest.resolved') {
      b.state.requests = b.state.requests.filter(r => r.id !== event.payload.id);
      emit({ type: 'request.resolved', session, ...event.payload }); changed(session);
    } else if (event.type === 'agent.updated') { b.state.title = event.payload.conversationTitle ?? b.state.title; changed(session); }
    else if (event.type === 'conversation.goalUpdated') { b.state.goal = structuredClone(event.payload.goal); changed(session); }
    else if (event.type === 'conversation.goalCleared') { b.state.goal = null; changed(session); }
    else if (event.type === 'agent.statusChanged') emit({ type: 'status.changed', session, status: { type: event.payload.type, ...('detail' in event.payload && typeof event.payload.detail === 'string' ? { detail: event.payload.detail } : {}), ...('message' in event.payload && typeof event.payload.message === 'string' ? { message: event.payload.message } : {}), native: event.payload } });
    else if (event.type === 'conversation.contextUsageUpdated') { b.state.contextUsage = structuredClone(event.payload.contextUsage); changed(session); }
  });
  const offUsage = native.onUsage?.(observation => emit({ type: 'usage.observed', observation }));
  const offRequests = native.onRequestUsage?.(observation => emit({ type: 'requestUsage.observed', observation }));
  const admitted = (session: Session, result: import('./driver').HarnessSendResult): Admission => {
    get(session).context.backendSession = structuredClone(result.backendSession);
    return { session, ...(result.turnId ? { turnId: result.turnId } : {}), ...(result.messageId ? { messageId: result.messageId } : {}) };
  };
  const capabilities = (session: Session): HarnessCapabilities => {
    const { approvalPresets, permissionModes, ...caps } = native.getCapabilities(get(session).context);
    return { ...caps, remoteControl: false, permissions: [...(approvalPresets ?? []).map(id => ({ id, ...(id === 'full-access' ? { dangerous: true } : {}) })), ...(permissionModes ?? []).map(({ id, dangerous }) => ({ id, ...(dangerous ? { dangerous } : {}) }))] };
  };
  const permission = async (session: Session, id: string) => {
    const b = get(session); const caps = native.getCapabilities(b.context);
    if (!capabilities(session).permissions.some(p => p.id === id)) throw new Error('Unsupported permission option.');
    if (caps.approvalPresets?.includes(id as never)) {
      if (!native.setApprovalPreset) throw new Error('Permission updates are unavailable.');
      const result = await native.setApprovalPreset(b.context, id as import('./contracts').ApprovalPreset);
      b.context.backendSession = result.backendSession;
      b.context.backendDefaults = { ...b.context.backendDefaults, kind: 'codex', approvalPreset: result.approvalPreset };
    } else {
      if (!native.setPermissionMode) throw new Error('Permission updates are unavailable.');
      b.context.backendDefaults = (await native.setPermissionMode(b.context, id)).backendDefaults;
    }
  };
  const unavailable = (operation: string): never => { throw new Error(`${operation} is unavailable for this harness.`); };
  const turnAction = (session: Session, result: import('./driver').HarnessTurnActionResult) => {
    admitted(session, result); return { session, activeTurnId: result.activeTurnId };
  };
  const open = (input: HarnessContext): Session => {
    if (byId.has(input.id)) throw new Error('A session with this id is already open.');
    const session = Object.freeze({}) as Session;
    const { defaults, ...context } = input;
    const { permission: mode, ...selection } = defaults ?? {};
    const backendDefaults = { kind: provider, ...selection, ...(mode ? provider === 'codex' ? { approvalPreset: mode } : { permissionMode: mode } : {}) } as BackendDefaults;
    bindings.set(session, { context: { ...context, backend: provider, backendDefaults }, state: emptyState(), project: createConsumerProjection() }); byId.set(input.id, session);
    if (mode && !capabilities(session).permissions.some(p => p.id === mode)) { bindings.delete(session); byId.delete(input.id); throw new Error('Unsupported permission option.'); }
    return session;
  };
  const decode = (serialized: string, type: 'session' | 'ref'): Record<string, unknown> => {
    const value = JSON.parse(serialized);
    if (!value || value.version !== 1 || value.provider !== provider || value.type !== type || !value.data || typeof value.data !== 'object') throw new Error('Invalid persisted harness handle.');
    const data = value.data;
    const identity = provider === 'codex' ? data.threadId : data.sessionId;
    if (typeof identity !== 'string' || !identity || (type === 'session' ? data.kind : data.backend) !== provider) throw new Error('Invalid persisted harness identity.');
    if (type === 'session' && provider === 'claude' && !['stdio', 'websocket'].includes(data.transport)) throw new Error('Invalid Claude transport.');
    if (type === 'ref' && provider !== 'codex' && data.folder !== null && typeof data.folder !== 'string') throw new Error('Invalid persisted folder.');
    return data;
  };
  const encode = (type: 'session' | 'ref', data: unknown) => JSON.stringify({ version: 1, provider, type, data });
  return {
    getRuntimeStatus() { const { detail, capabilities: _capabilities, ...status } = native.getRuntimeStatus(); return { ...status, ...(typeof detail === 'string' ? { detail } : {}) }; },
    async authenticate(action) { const state = await (native.authenticate?.(action) ?? unavailable('Authentication')); return { connected: state.connected, native: state }; },
    getAccountRateLimits: () => native.getAccountRateLimits?.() ?? Promise.resolve(null),
    listModels: session => native.listModels?.(get(session).context) ?? unavailable('Model catalog'),
    listSkills: (session, forceReload) => native.listSkills?.(get(session).context, forceReload) ?? unavailable('Skill catalog'),
    listPlugins: session => native.listPlugins?.(get(session).context) ?? unavailable('Plugin catalog'),
    generateText: (session, input) => native.generateText?.(get(session).context, input) ?? unavailable('Text generation'),
    generateImage: (session, input, signal) => native.generateImage?.(get(session).context, input, signal) ?? unavailable('Image generation'),
    setConversationTitle: (session, title) => native.setConversationTitle?.(get(session).context, title) ?? unavailable('Conversation title'),
    async setGoal(session, objective) {
      const result = await (native.setGoal?.(get(session).context, objective) ?? unavailable('Goals'));
      return { ...admitted(session, result), ...(result.goal ? { goal: result.goal } : {}) };
    },
    async clearGoal(session) {
      const result = await (native.clearGoal?.(get(session).context) ?? unavailable('Goals'));
      return { ...admitted(session, result), ...(result.cleared === undefined ? {} : { cleared: result.cleared }) };
    },
    async steerPrompt(session, prompt, options) { return admitted(session, await (native.steerPrompt?.(get(session).context, prompt, options) ?? unavailable('Steering'))); },
    async deleteTurn(session, turnId) { return turnAction(session, await (native.deleteTurn?.(get(session).context, turnId) ?? unavailable('Turn deletion'))); },
    async editTurn(session, turnId, content, options) { return turnAction(session, await (native.editTurn?.(get(session).context, turnId, content, options) ?? unavailable('Turn editing'))); },
    async retryTurn(session, turnId) { return turnAction(session, await (native.retryTurn?.(get(session).context, turnId) ?? unavailable('Turn retry'))); },
    async forkConversation(session, target, turnId) { return admitted(target, await (native.forkConversation?.(get(session).context, get(target).context, turnId) ?? unavailable('Conversation fork'))); },
    async replaceConversationWithSummary(session) { return admitted(session, await (native.replaceConversationWithSummary?.(get(session).context) ?? unavailable('Conversation summary replacement'))); },
    archiveConversation: session => native.archiveAgentConversation?.(get(session).context) ?? unavailable('Conversation archive'),
    deleteConversation: session => native.deleteAgentConversation?.(get(session).context) ?? unavailable('Conversation deletion'),
    readConversationMessages(session, ref) {
      const value = refs.get(ref); if (!value) throw new Error('Unknown conversation reference.');
      return native.readConversationMessages?.(value, get(session).context.id) ?? unavailable('Conversation messages');
    },
    readConversationContent(session, input) {
      const context = get(session).context; const binding = context.backendSession;
      if (!binding) throw new Error('Session has not been admitted.');
      const sessionId = binding.kind === 'codex' ? binding.threadId : binding.sessionId;
      return native.readConversationContent?.(context, { ...input, sessionId }) ?? unavailable('Conversation content');
    },
    serializeSession(session) { const data = get(session).context.backendSession; if (!data) throw new Error('Session has not been admitted.'); return JSON.stringify({ ...JSON.parse(encode('session', data)), defaults: consumerContext(get(session).context).defaults }); },
    restoreSession(context, serialized) { const data = decode(serialized, 'session'); const session = open({ ...context, defaults: context.defaults ?? JSON.parse(serialized).defaults }); get(session).context.backendSession = data as BackendSession; return session; },
    serializeRef(ref) { const data = refs.get(ref); if (!data) throw new Error('Unknown conversation reference.'); return encode('ref', data); },
    restoreRef(serialized) { const data = decode(serialized, 'ref'); const ref = Object.freeze({}) as ConversationRef; refs.set(ref, data as BackendConversationRef); return ref; },
    open, getCapabilities: capabilities, readSession: session => structuredClone(get(session).state),
    async sendPrompt(session, prompt, options) { return admitted(session, await native.sendPrompt(get(session).context, prompt, options)); },
    async interrupt(session, expectedTurnId) { return admitted(session, await native.interrupt(get(session).context, expectedTurnId)); },
    async respondToRequest(session, response) {
      const b = get(session);
      if (!b.state.requests.some(r => r.id === response.id)) throw new Error('Request does not belong to this session.');
      await native.respondToAgentRequest({ ...response, agentId: b.context.id });
    },
    setPermission: permission,
    async loadConversation(session) {
      if (!native.loadConversation) throw new Error('Conversation loading is unavailable.');
      const result = await native.loadConversation(get(session).context);
      if (result) get(session).context.backendSession = result;
      return result !== null;
    },
    loadTurnHistory: (session, turnId) => native.loadTurnHistory?.(get(session).context, turnId) ?? unavailable('Turn history'),
    async loadOlderHistory(session) {
      if (!native.loadOlderHistory) throw new Error('History paging is unavailable.');
      const result = await native.loadOlderHistory(get(session).context); return { hasOlder: result.hasOlder };
    },
    async listConversations(session, input) {
      if (!native.listConversations) throw new Error('Conversation listing is unavailable.');
      return (await native.listConversations(get(session).context, input)).map(({ ref, ...summary }) => {
        const handle = Object.freeze({}) as ConversationRef; refs.set(handle, ref); return { ...summary, ref: handle };
      });
    },
    async resumeConversation(session, target) {
      const ref = refs.get(target.ref); if (!ref) throw new Error('Conversation reference does not belong to this driver.');
      if (!native.resumeConversation) throw new Error('Conversation resume is unavailable.');
      const result = await native.resumeConversation(get(session).context, { ...target, ref }); get(session).context.backendSession = result.backendSession;
    },
    async executeScopedPrompt(session, input) {
      if (!native.executeScopedPrompt) throw new Error('Scoped execution is unavailable.');
      const scoped = input.session ?? open({ id: `${get(session).context.id}:scope:${crypto.randomUUID()}`, folder: input.cwd });
      const binding = get(scoped);
      try {
        const result = await native.executeScopedPrompt(binding.context, { ...input, session: binding.context.backendSession });
        binding.context.backendSession = result.session; return { text: result.text, session: scoped };
      } catch (error) {
        if (!input.session) { await native.releaseConversation?.(binding.context.id); byId.delete(binding.context.id); bindings.delete(scoped); }
        throw error;
      }
    },
    async disposeScopedSession(session) {
      const b = get(session); if (!native.disposeScopedSession || !b.context.backendSession) throw new Error('Scoped disposal is unavailable.');
      await native.disposeScopedSession(b.context, b.context.backendSession); byId.delete(b.context.id); bindings.delete(session);
    },
    async release(session) { const b = get(session); await native.releaseConversation?.(b.context.id); byId.delete(b.context.id); bindings.delete(session); },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() { try { await native.close(); } finally { unsubscribe(); offUsage?.(); offRequests?.(); listeners.clear(); bindings.clear(); byId.clear(); refs.clear(); } },
  };
}

/** No provider turn is started until a consumer explicitly sends a prompt. */
export function createHarnessDriver(provider: HarnessProvider, options: HarnessOptions): HarnessDriver {
  return adaptHarnessDriver(provider, createNativeHarnessDriver(provider, { ...options,
    instructions: options.instructions ? context => options.instructions!(consumerContext(context)) : undefined,
    mcpServers: options.mcpServers ? context => options.mcpServers!(consumerContext(context)) : undefined,
  }));
}

function consumerContext(context: NativeContext): HarnessContext {
  const d = context.backendDefaults;
  return { id: context.id, folder: context.folder, ...(context.name === undefined ? {} : { name: context.name }),
    ...(d ? { defaults: { model: d.model ?? undefined, reasoningEffort: d.reasoningEffort ?? undefined, serviceTier: d.serviceTier,
      permission: d.kind === 'codex' ? d.approvalPreset : d.permissionMode } } : {}),
  };
}
