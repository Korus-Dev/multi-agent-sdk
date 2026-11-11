import type { ProviderDriver as NativeHost } from './driver';
import type { ProviderContext } from './context';
import type { ProviderCapabilities, ProviderConversationRef, ProviderDefaults, ProviderSessionData } from './contracts';
import type { ProviderEvent } from './contracts/events';
import type {
  Admission, ConversationRef, Harness, HarnessCapabilities, HarnessContext, HarnessDefaults, HarnessEvent, HarnessProvider,
  Session, SessionSelection, SessionState, TurnActionResult,
} from './consumer-types';
import { harnessContext } from './harness-options';
import type { HarnessProjection } from './harness-projection';
import { HarnessUnsupportedError } from './errors';

const emptyState = (): SessionState => ({ messages: [], busy: false, activeTurnId: null, turns: [], requests: [], error: null, title: null, goal: null, contextUsage: null, plan: null });
type Binding = {
  stored?: { providerSession?: unknown };
  kind: 'main' | 'scope';
  parent?: Session;
  operation?: 'executing' | 'disposing' | 'releasing' | 'hydrating';
  nativeDisposed?: boolean;
  context: ProviderContext;
  state: SessionState;
  project: HarnessProjection;
  recovery?: boolean;
};
type SendResult = import('./driver').ProviderSendResult;
type TurnResult = import('./driver').ProviderTurnActionResult;
const unavailable = (operation: string): never => { throw new HarnessUnsupportedError(operation); };

/**
 * Everything every harness shares: sessions, conversation references, events, scopes and request tracking.
 * A concrete harness owns its native runtime and answers the provider questions through the protected hooks below.
 */
export abstract class ProviderHarness<P extends HarnessProvider = HarnessProvider> implements Harness {
  private readonly bindings = new Map<Session, Binding>();
  private readonly byId = new Map<string, Session>();
  private readonly refs = new WeakMap<ConversationRef, ProviderConversationRef>();
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly unsubscribe: () => void;
  private readonly offUsage?: () => void;
  private readonly offRequests?: () => void;

  protected constructor(readonly provider: P, protected readonly native: NativeHost<ProviderContext, ProviderEvent>) {
    this.unsubscribe = native.onEvent(event => this.receive(event));
    this.offUsage = native.onUsage?.(observation => this.emit({ type: 'usage.observed', observation }));
    this.offRequests = native.onRequestUsage?.(observation => this.emit({ type: 'requestUsage.observed', observation }));
  }

  // ---- Provider hooks -------------------------------------------------------------------------------------------

  /** The native conversation id carried by persisted session or reference data. */
  protected abstract identityOf(data: Record<string, unknown>): unknown;
  /** The reference that names a session's conversation. */
  protected abstract conversationRef(data: ProviderSessionData, context: ProviderContext): ProviderConversationRef;
  /** Native defaults that select a permission option. */
  protected abstract permissionDefaults(id: string): Partial<ProviderDefaults>;
  /** The permission option native defaults select. */
  protected abstract permissionOf(defaults: ProviderDefaults): string | undefined;
  /** The permission options native capabilities offer. */
  protected abstract permissionOptions(capabilities: ProviderCapabilities): HarnessCapabilities['permissions'];
  /** Applies a permission option natively, updating the context, and returns the option the provider confirmed. */
  protected abstract applyPermission(context: ProviderContext, id: string): Promise<string | null | undefined>;
  /** A fresh projection from native conversation events to session state. */
  protected abstract createProjection(): HarnessProjection;
  /** The permission option a native settings or mode event reports; undefined when it reports none. */
  protected abstract permissionFromEvent(event: ProviderEvent): string | null | undefined;
  /** Extra checks on persisted session data. */
  protected validateSessionData(_data: Record<string, unknown>): void {}
  /** Extra checks on persisted reference data. */
  protected validateRefData(_data: Record<string, unknown>): void {}
  /** Selection a provider records in its session data; undefined leaves the session's selection alone. */
  protected selectionFromSession(_data: ProviderSessionData, _previous: ProviderSessionData | undefined, _current: SessionSelection | undefined, _preserveRuntime: boolean): SessionSelection | undefined { return undefined; }

  // ---- Shared machinery -----------------------------------------------------------------------------------------

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) { try { listener(event); } catch (error) { process.emitWarning(error instanceof Error ? error : String(error)); } }
  }
  private get(session: Session): Binding {
    const binding = this.bindings.get(session);
    if (!binding) throw new Error('Session does not belong to this driver.');
    return binding;
  }
  private interactive(session: Session): Binding {
    const binding = this.get(session);
    if (binding.nativeDisposed || binding.operation === 'disposing' || binding.operation === 'releasing') throw new Error('Session cleanup is in progress.');
    return binding;
  }
  private main(session: Session): Binding {
    const binding = this.interactive(session);
    if (binding.kind !== 'main') throw new Error('Scoped sessions require scoped continuation through their parent.');
    return binding;
  }
  private changed(session: Session): void { this.emit({ type: 'session.changed', session, state: structuredClone(this.get(session).state) }); }
  private context(context: ProviderContext): HarnessContext { return harnessContext(context, defaults => this.permissionOf(defaults)); }
  private adoptSession(session: Session, data: ProviderSessionData, preserveRuntimeSelection = false): void {
    const binding = this.get(session);
    const previous = binding.context.providerSession;
    binding.context.providerSession = structuredClone(data);
    const selection = this.selectionFromSession(data, previous, binding.state.selection, preserveRuntimeSelection);
    if (selection) { binding.state.selection = selection; this.changed(session); }
  }
  private admitted(session: Session, result: SendResult): Admission {
    this.adoptSession(session, result.providerSession, true);
    return { session, ...(result.turnId ? { turnId: result.turnId } : {}), ...(result.messageId ? { messageId: result.messageId } : {}) };
  }
  private turnAction(session: Session, result: TurnResult): TurnActionResult {
    this.admitted(session, result);
    return { session, activeTurnId: result.activeTurnId };
  }
  private capabilitiesFor(context?: ProviderContext): HarnessCapabilities {
    const native = this.native.getCapabilities(context);
    const { approvalPresets: _presets, permissionModes: _modes, login, realtime, remoteControl, accountUsage, ...caps } = native;
    return { ...caps, login: [...(login ?? [])], realtime: Boolean(realtime),
      accountUsage: Boolean(accountUsage && this.native.getAccountRateLimits),
      remoteControl: Boolean(remoteControl && this.native.getRemoteControlStatus),
      permissions: this.permissionOptions(native) };
  }
  private async hydrate<T>(session: Session, action: (binding: Binding) => Promise<T>): Promise<T> {
    const binding = this.interactive(session);
    const scoped = binding.kind === 'scope';
    if (scoped && (binding.operation || binding.state.busy || binding.state.activeTurnId)) throw new Error('Scope is busy.');
    if (scoped) binding.operation = 'hydrating';
    try { return await action(binding); } finally { if (scoped) binding.operation = undefined; }
  }
  private validate(value: { provider: string; data: object }, type: 'session' | 'ref'): Record<string, unknown> {
    if (!value || typeof value !== 'object' || value.provider !== this.provider || !value.data || typeof value.data !== 'object') throw new Error('Invalid persisted harness handle.');
    const data = value.data as Record<string, unknown>;
    const identity = this.identityOf(data);
    if (typeof identity !== 'string' || !identity || (type === 'session' ? data.kind : data.provider) !== this.provider) throw new Error('Invalid persisted harness identity.');
    if (type === 'session') this.validateSessionData(data); else this.validateRefData(data);
    return data;
  }
  private reference(data: ProviderConversationRef): ConversationRef {
    const ref = Object.freeze({}) as ConversationRef;
    this.refs.set(ref, structuredClone(data));
    return ref;
  }
  private nativeRef(ref: ConversationRef, message = 'Unknown conversation reference.'): ProviderConversationRef {
    const value = this.refs.get(ref);
    if (!value) throw new Error(message);
    return value;
  }
  private mergeDefaults(current: ProviderDefaults, defaults: Partial<HarnessDefaults>): ProviderDefaults {
    const { permission: mode, ...selection } = defaults;
    return { ...current, ...Object.fromEntries(Object.entries(selection).filter(([, value]) => value !== undefined)), ...(mode ? this.permissionDefaults(mode) : {}) } as ProviderDefaults;
  }
  private receive(event: ProviderEvent): void {
    const session = event.agentId ? this.byId.get(event.agentId) : undefined;
    this.emit({ type: 'provider.event', session, event });
    if (!session) return;
    const b = this.get(session);
    const snapshotFrame = event.type.endsWith('.conversationSnapshotChanged');
    if (!b.recovery || snapshotFrame) {
      try {
        const state = b.project(event);
        if (state) {
          b.recovery = false; b.state = { ...b.state, ...structuredClone(state) };
          // A provider without a pending-request snapshot list prunes requests only on native answered evidence.
          const answered = new Set(b.state.answeredClientRequestIds ?? []);
          b.state.requests = b.state.requests.filter(request => !answered.has(request.id));
          this.changed(session);
        }
      } catch (error) {
        b.recovery = true;
        const reason = error instanceof Error ? error.message : String(error);
        b.state.error = reason; this.emit({ type: 'recovery.required', session, reason }); this.changed(session);
      }
    }
    if (event.type === 'plan.readyForReview') this.emit({ type: 'plan.readyForReview', session, turnId: event.turnId, ...event.payload });
    else if (event.type === 'agentRequest.created') {
      if (b.state.answeredClientRequestIds?.includes(event.payload.request.id)) return;
      b.state.requests = [...b.state.requests.filter(r => r.id !== event.payload.request.id), structuredClone(event.payload.request)];
      this.emit({ type: 'request.created', session, request: structuredClone(event.payload.request) }); this.changed(session);
    } else if (event.type === 'agentRequest.resolved') {
      b.state.requests = b.state.requests.filter(r => r.id !== event.payload.id);
      this.emit({ type: 'request.resolved', session, ...event.payload }); this.changed(session);
    } else if (event.type === 'conversation.modeUpdated') {
      const permission = this.permissionFromEvent(event);
      if (permission !== undefined) { b.state.permission = permission; this.changed(session); }
    } else if (event.type === 'conversation.settingsUpdated') {
      const { model, reasoningEffort, serviceTier } = event.payload.settings;
      const permission = this.permissionFromEvent(event);
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
      if (model !== undefined || reasoningEffort !== undefined || serviceTier !== undefined || permission !== undefined) this.changed(session);
    } else if (event.type === 'agent.updated') { b.state.title = event.payload.conversationTitle ?? b.state.title; this.changed(session); }
    else if (event.type === 'conversation.goalUpdated') { b.state.goal = structuredClone(event.payload.goal); this.changed(session); }
    else if (event.type === 'conversation.goalCleared') { b.state.goal = null; this.changed(session); }
    else if (event.type === 'agent.statusChanged') {
      const payload = event.payload;
      this.emit({ type: 'status.changed', session, status: { type: payload.type,
        ...('detail' in payload && typeof payload.detail === 'string' ? { detail: payload.detail } : {}),
        ...('message' in payload && typeof payload.message === 'string' ? { message: payload.message } : {}),
        native: payload } });
    } else if (event.type === 'conversation.contextUsageUpdated') { b.state.contextUsage = structuredClone(event.payload.contextUsage); this.changed(session); }
  }
  private newScope(parent: Session, cwd: string): Session {
    const p = this.get(parent);
    const defaults = this.context(p.context).defaults;
    const scoped = this.open({ id: `${p.context.id}:scope:${crypto.randomUUID()}`, folder: cwd, ...(defaults ? { defaults } : {}) });
    const binding = this.get(scoped);
    binding.kind = 'scope'; binding.parent = parent;
    binding.context.providerDefaults = structuredClone(p.context.providerDefaults);
    return scoped;
  }

  // ---- Harness ---------------------------------------------------------------------------------------------------

  getRuntimeStatus() { const { detail, capabilities: _capabilities, ...status } = this.native.getRuntimeStatus(); return { ...status, ...(typeof detail === 'string' ? { detail } : {}) }; }
  async authenticate(action: Parameters<Harness['authenticate']>[0]) {
    const state = await (this.native.authenticate?.(action) ?? unavailable('Authentication'));
    return { connected: state.connected, ...(state.login ? { login: state.login } : {}), native: state };
  }
  async getBankedResets() { return this.native.getBankedResets?.() ?? unavailable('Banked resets'); }
  async useBankedReset(input: Parameters<Harness['useBankedReset']>[0]) { return this.native.useBankedReset?.(input) ?? unavailable('Banked resets'); }
  getAccountRateLimits() { return this.native.getAccountRateLimits?.() ?? Promise.resolve(null); }
  async startRealtime(session: Session, options: Parameters<Harness['startRealtime']>[1]) { return this.native.startRealtime?.(this.main(session).context, options) ?? unavailable('Realtime'); }
  async getRemoteControl() { return this.native.getRemoteControlStatus?.() ?? unavailable('Remote control'); }
  async setRemoteControl(enabled: boolean) { return (enabled ? this.native.enableRemoteControl?.() : this.native.disableRemoteControl?.()) ?? unavailable('Remote control'); }
  async startDevicePairing() { return this.native.startDevicePairing?.() ?? unavailable('Device pairing'); }
  async checkDevicePairing(pairing: Parameters<Harness['checkDevicePairing']>[0]) { return this.native.checkDevicePairing?.(pairing) ?? unavailable('Device pairing'); }
  async listPairedDevices(environmentId: string) { return this.native.listPairedDevices?.(environmentId) ?? unavailable('Paired devices'); }
  async revokePairedDevice(environmentId: string, clientId: string) { return this.native.revokePairedDevice?.(environmentId, clientId) ?? unavailable('Paired devices'); }
  listModels(session: Session) { return this.native.listModels?.(this.main(session).context) ?? unavailable('Model catalog'); }
  listSkills(session: Session, forceReload?: boolean) { return this.native.listSkills?.(this.main(session).context, forceReload) ?? unavailable('Skill catalog'); }
  listPlugins(session: Session) { return this.native.listPlugins?.(this.main(session).context) ?? unavailable('Plugin catalog'); }
  generateText(session: Session, input: Parameters<Harness['generateText']>[1]) { return this.native.generateText?.(this.main(session).context, input) ?? unavailable('Text generation'); }
  generateImage(session: Session, input: Parameters<Harness['generateImage']>[1], signal?: AbortSignal) { return this.native.generateImage?.(this.main(session).context, input, signal) ?? unavailable('Image generation'); }
  setConversationTitle(session: Session, title: string) { return this.native.setConversationTitle?.(this.main(session).context, title) ?? unavailable('Conversation title'); }
  async setGoal(session: Session, objective: string) {
    const result = await (this.native.setGoal?.(this.main(session).context, objective) ?? unavailable('Goals'));
    const admission = this.admitted(session, result);
    if (result.goal) { this.get(session).state.goal = structuredClone(result.goal); this.changed(session); }
    return { ...admission, ...(result.goal ? { goal: result.goal } : {}) };
  }
  async clearGoal(session: Session) {
    const result = await (this.native.clearGoal?.(this.main(session).context) ?? unavailable('Goals'));
    const admission = this.admitted(session, result);
    if (result.cleared === true) { this.get(session).state.goal = null; this.changed(session); }
    return { ...admission, ...(result.cleared === undefined ? {} : { cleared: result.cleared }) };
  }
  async steerPrompt(session: Session, prompt: string, options?: Parameters<Harness['steerPrompt']>[2]) {
    return this.admitted(session, await (this.native.steerPrompt?.(this.interactive(session).context, prompt, options) ?? unavailable('Steering')));
  }
  async deleteTurn(session: Session, turnId: string) { return this.turnAction(session, await (this.native.deleteTurn?.(this.main(session).context, turnId) ?? unavailable('Turn deletion'))); }
  async editTurn(session: Session, turnId: string, content: string, options?: Parameters<Harness['editTurn']>[3]) {
    return this.turnAction(session, await (this.native.editTurn?.(this.main(session).context, turnId, content, options) ?? unavailable('Turn editing')));
  }
  async retryTurn(session: Session, turnId: string) { return this.turnAction(session, await (this.native.retryTurn?.(this.main(session).context, turnId) ?? unavailable('Turn retry'))); }
  async startReview(session: Session, target?: Parameters<Harness['startReview']>[1]) { return this.admitted(session, await (this.native.startReview?.(this.main(session).context, target) ?? unavailable('Review'))); }
  handlePromptCommand(session: Session, prompt: string) {
    const handled = this.native.tryHandlePromptCommand?.(this.main(session).context, prompt);
    return handled ? handled.then(result => this.admitted(session, result)) : null;
  }
  preparePromptOptions(session: Session, options?: Parameters<Harness['preparePromptOptions']>[1]) {
    return this.native.preparePromptOptions ? this.native.preparePromptOptions(this.main(session).context, options) : options;
  }
  async continueInterruptedTurn(session: Session, safetyReview?: Parameters<Harness['continueInterruptedTurn']>[1]) {
    return this.turnAction(session, await (this.native.continueInterruptedTurn?.(this.main(session).context, safetyReview) ?? unavailable('Interrupted turn continuation')));
  }
  async reconcileConversations(sessions: Session[]) { await this.native.reconcileConversations?.(sessions.map(session => this.main(session).context)); }
  async forkConversation(session: Session, target: Session, turnId?: string) {
    const result = await (this.native.forkConversation?.(this.main(session).context, this.main(target).context, turnId) ?? unavailable('Conversation fork'));
    if (!result) return null;
    return { ...this.admitted(target, result), ...(result.forkedFromTurnId === undefined ? {} : { forkedFromTurnId: result.forkedFromTurnId }) };
  }
  archiveConversation(session: Session) { return this.native.archiveAgentConversation?.(this.main(session).context) ?? unavailable('Conversation archive'); }
  deleteConversation(session: Session) { return this.native.deleteAgentConversation?.(this.main(session).context) ?? unavailable('Conversation deletion'); }
  readConversationMessages(session: Session, ref: ConversationRef, options?: { view?: 'full' | 'last' }) {
    const value = this.nativeRef(ref);
    return this.native.readConversationMessages?.(value, this.interactive(session).context.id, options) ?? unavailable('Conversation messages');
  }
  async setConversationStorage(ref: ConversationRef, state: Parameters<Harness['setConversationStorage']>[1]) {
    const value = this.nativeRef(ref);
    await (this.native.setConversationStorage?.(value, state) ?? unavailable('Conversation storage'));
  }
  async readConversationSummary(session: Session, ref: ConversationRef) {
    const value = this.nativeRef(ref);
    const found = await (this.native.readConversationSummary?.(this.interactive(session).context, value) ?? unavailable('Conversation summary'));
    if (!found) return null;
    const { ref: nativeRef, ...rest } = found;
    const handle = Object.freeze({}) as ConversationRef; this.refs.set(handle, nativeRef);
    return { ...rest, ref: handle };
  }
  readConversationContent(session: Session, input: Parameters<Harness['readConversationContent']>[1]) {
    const context = this.interactive(session).context; const data = context.providerSession;
    if (!data) throw new Error('Session has not been admitted.');
    const sessionId = this.identityOf(data) as string;
    return this.native.readConversationContent?.(context, { ...input, sessionId }) ?? unavailable('Conversation content');
  }
  getSessionData(session: Session) {
    const binding = this.get(session);
    const data = (binding.stored ? binding.stored.providerSession : binding.context.providerSession) as ProviderSessionData | undefined;
    if (!data) throw new Error('Session has not been admitted.');
    if (binding.nativeDisposed || binding.operation === 'disposing' || binding.operation === 'releasing') throw new Error('Scope disposal has already started.');
    const parentId = binding.parent ? this.get(binding.parent).context.id : undefined;
    return structuredClone({ provider: this.provider, data, defaults: this.context(binding.context).defaults, role: binding.kind, ...(parentId ? { parentId } : {}) });
  }
  restoreSession(context: HarnessContext, saved: Parameters<Harness['restoreSession']>[1]) {
    const data = this.validate(saved, 'session');
    if (saved.role !== undefined && saved.role !== 'main' && saved.role !== 'scope') throw new Error('Invalid persisted session role.');
    const parent = saved.role === 'scope' ? this.byId.get(saved.parentId ?? '') : undefined;
    if (saved.role === 'scope' && (!parent || this.get(parent).kind !== 'main')) throw new Error('Restore the main scope parent first.');
    if (parent) this.main(parent);
    const session = this.open({ ...context, defaults: context.defaults ?? saved.defaults });
    const binding = this.get(session); binding.context.providerSession = data as ProviderSessionData;
    if (parent) { binding.kind = 'scope'; binding.parent = parent; }
    return session;
  }
  getRefData(ref: ConversationRef) { return structuredClone({ provider: this.provider, data: this.nativeRef(ref) }); }
  restoreRef(saved: Parameters<Harness['restoreRef']>[0]) { return this.reference(this.validate(saved, 'ref') as ProviderConversationRef); }
  getConversationRef(session: Session) {
    const context = this.interactive(session).context; const data = context.providerSession;
    return data ? this.reference(this.conversationRef(data, context)) : null;
  }
  open(input: HarnessContext): Session {
    if (this.byId.has(input.id)) throw new Error('A session with this id is already open.');
    const session = Object.freeze({}) as Session;
    const { defaults, ...context } = input;
    const { permission: mode, ...selection } = defaults ?? {};
    const providerDefaults = { kind: this.provider, ...selection, ...(mode ? this.permissionDefaults(mode) : {}) } as ProviderDefaults;
    this.bindings.set(session, { kind: 'main', context: { ...context, provider: this.provider, providerDefaults }, state: emptyState(), project: this.createProjection() });
    this.byId.set(input.id, session);
    if (mode && !this.getCapabilities(session).permissions.some(p => p.id === mode)) { this.bindings.delete(session); this.byId.delete(input.id); throw new Error('Unsupported permission option.'); }
    return session;
  }
  getCapabilities(session: Session) { return this.capabilitiesFor(this.interactive(session).context); }
  getProviderCapabilities() { return this.capabilitiesFor(); }
  readSession(session: Session) { return structuredClone(this.get(session).state); }
  async sendPrompt(session: Session, prompt: string, options?: Parameters<Harness['sendPrompt']>[2]) { return this.admitted(session, await this.native.sendPrompt(this.main(session).context, prompt, options)); }
  async interrupt(session: Session, expectedTurnId?: string) { return this.admitted(session, await this.native.interrupt(this.interactive(session).context, expectedTurnId)); }
  async respondToRequest(session: Session, response: Parameters<Harness['respondToRequest']>[1]) {
    const b = this.interactive(session);
    if (!b.state.requests.some(r => r.id === response.id)) throw new Error('Request does not belong to this session or is no longer pending.');
    await this.native.respondToAgentRequest({ ...response, agentId: b.context.id });
  }
  async setPermission(session: Session, id: string) {
    const b = this.main(session);
    if (!this.getCapabilities(session).permissions.some(p => p.id === id)) throw new Error('Unsupported permission option.');
    b.state.permission = await this.applyPermission(b.context, id);
    this.changed(session);
  }
  bindSession(session: Session, source: Parameters<Harness['bindSession']>[1]) {
    const binding = this.get(session);
    const context = binding.context as unknown as Record<string, unknown>;
    const stored = { providerSession: context.providerSession, folder: context.folder, name: context.name, providerDefaults: context.providerDefaults };
    const defaultsOf = () => { const live = source().defaults; if (live === undefined) return stored.providerDefaults; return this.mergeDefaults({ kind: this.provider } as ProviderDefaults, live); };
    binding.stored = stored;
    Object.defineProperties(context, {
      providerSession: { enumerable: true, configurable: true, get: () => { const v = source().data; return v === undefined ? stored.providerSession : (v ?? undefined); }, set: (value: unknown) => { stored.providerSession = value; } },
      folder: { enumerable: true, configurable: true, get: () => { const v = source().folder; return v === undefined ? stored.folder : v; }, set: (value: unknown) => { stored.folder = value; } },
      name: { enumerable: true, configurable: true, get: () => { const v = source().name; return v === undefined ? stored.name : v; }, set: (value: unknown) => { stored.name = value; } },
      providerDefaults: { enumerable: true, configurable: true, get: defaultsOf, set: (value: unknown) => { stored.providerDefaults = value as ProviderDefaults | undefined; } },
    });
  }
  syncSession(session: Session, state: Parameters<Harness['syncSession']>[1]) {
    const b = this.get(session);
    if (state.data) this.validate({ provider: this.provider, data: state.data }, 'session');
    if (state.data !== undefined) b.context.providerSession = state.data ?? undefined;
    if (state.folder !== undefined) b.context.folder = state.folder;
    if (state.name !== undefined) b.context.name = state.name;
    if (state.defaults !== undefined) { b.context.providerDefaults = { kind: this.provider } as ProviderDefaults; this.updateDefaults(session, state.defaults); }
  }
  updateDefaults(session: Session, defaults: Partial<HarnessDefaults>) {
    const b = this.get(session);
    b.context.providerDefaults = this.mergeDefaults(b.context.providerDefaults ?? { kind: this.provider } as ProviderDefaults, defaults);
  }
  loadConversation(session: Session) {
    const load = this.native.loadConversation?.bind(this.native);
    if (!load) throw new Error('Conversation loading is unavailable.');
    return this.hydrate(session, async binding => {
      const result = await load(binding.context);
      if (result) this.adoptSession(session, result);
      return result !== null;
    });
  }
  loadTurnHistory(session: Session, turnId: string) { return this.hydrate(session, binding => this.native.loadTurnHistory?.(binding.context, turnId) ?? unavailable('Turn history')); }
  loadOlderHistory(session: Session) {
    const load = this.native.loadOlderHistory?.bind(this.native);
    if (!load) throw new Error('History paging is unavailable.');
    return this.hydrate(session, async binding => { const result = await load(binding.context); return { hasOlder: result.hasOlder }; });
  }
  async listConversations(session: Session, input?: Parameters<Harness['listConversations']>[1]) {
    if (!this.native.listConversations) throw new Error('Conversation listing is unavailable.');
    return (await this.native.listConversations(this.main(session).context, input)).map(({ ref, ...summary }) => {
      const handle = Object.freeze({}) as ConversationRef; this.refs.set(handle, ref); return { ...summary, ref: handle };
    });
  }
  async resumeConversation(session: Session, target: Parameters<Harness['resumeConversation']>[1]) {
    const ref = this.nativeRef(target.ref, 'Conversation reference does not belong to this driver.');
    if (!this.native.resumeConversation) throw new Error('Conversation resume is unavailable.');
    const result = await this.native.resumeConversation(this.main(session).context, { ...target, ref });
    this.adoptSession(session, result.providerSession);
  }
  openScope(parent: Session, input: { cwd: string }) { this.main(parent); return this.newScope(parent, input.cwd); }
  async executeScopedPrompt(session: Session, input: Parameters<Harness['executeScopedPrompt']>[1]) {
    const parent = this.main(session);
    if (parent.kind !== 'main') throw new Error('Scoped execution requires a main parent session.');
    input.signal?.throwIfAborted();
    const execute = this.native.executeScopedPrompt?.bind(this.native);
    const cancelScoped = this.native.cancelScopedPrompt?.bind(this.native);
    if (!execute) throw new HarnessUnsupportedError('Scoped execution');
    if (input.signal && !cancelScoped) throw new HarnessUnsupportedError('Scoped cancellation');
    const scoped = input.session ?? this.newScope(session, input.cwd);
    const binding = this.get(scoped);
    if (input.session) {
      if (binding.kind !== 'scope') throw new Error('Only a scoped session can continue scoped execution.');
      if (binding.parent !== session) throw new Error('Scope belongs to another parent session.');
      if (binding.context.folder !== input.cwd) throw new Error('Scope belongs to another workspace.');
    }
    if (binding.operation || binding.state.busy || binding.state.activeTurnId) throw new Error('Scope is busy.');
    if (binding.nativeDisposed) throw new Error('Scope disposal has already started.');
    binding.operation = 'executing';
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= (async () => { await cancelScoped!(binding.context); })();
      // Settlement below owns cleanup errors, without an unhandled rejection in the meantime.
      void cancellation.catch(() => {});
    };
    input.signal?.addEventListener('abort', cancel, { once: true });
    try {
      input.signal?.throwIfAborted();
      const result = await execute(binding.context, { ...input, session: binding.context.providerSession });
      input.signal?.throwIfAborted();
      binding.context.providerSession = result.session;
      return { text: result.text, session: scoped };
    } catch (error) {
      try { await cancellation; } finally {
        if (!input.session || input.signal?.aborted) {
          // A native initialization can finish after the first abort cleanup; release it again.
          await this.native.releaseConversation?.(binding.context.id); this.byId.delete(binding.context.id); this.bindings.delete(scoped);
        }
      }
      input.signal?.throwIfAborted();
      throw error;
    } finally {
      input.signal?.removeEventListener('abort', cancel);
      binding.operation = undefined;
      await cancellation;
    }
  }
  async disposeScopedSession(session: Session) {
    const b = this.get(session);
    if (b.kind !== 'scope') throw new Error('Only scoped sessions can be disposed as scopes.');
    if (b.operation || b.state.busy || b.state.activeTurnId) throw new Error('Scope is busy.');
    if (!this.native.disposeScopedSession || !this.native.releaseConversation || !b.context.providerSession) throw new Error('Scoped disposal is unavailable.');
    b.operation = 'disposing';
    try {
      if (!b.nativeDisposed) {
        await this.native.disposeScopedSession(b.context, b.context.providerSession);
        b.nativeDisposed = true;
      }
      await this.native.releaseConversation(b.context.id);
      this.byId.delete(b.context.id); this.bindings.delete(session);
    } finally { b.operation = undefined; }
  }
  async release(session: Session) {
    const b = this.get(session);
    if (b.operation) throw new Error('Session is busy.');
    if (b.kind === 'main' && [...this.bindings.values()].some(child => child.parent === session)) throw new Error('Release or dispose child scopes before releasing their parent.');
    b.operation = 'releasing';
    try {
      await this.native.releaseConversation?.(b.context.id); this.byId.delete(b.context.id); this.bindings.delete(session);
    } finally { b.operation = undefined; }
  }
  onEvent(listener: (event: HarnessEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async close() {
    try { await this.native.close(); } finally { this.unsubscribe(); this.offUsage?.(); this.offRequests?.(); this.listeners.clear(); this.bindings.clear(); this.byId.clear(); }
  }
}
