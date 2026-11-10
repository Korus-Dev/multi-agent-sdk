import type { HarnessContext, HarnessDriver, HarnessEvent, HarnessPromptScope, HarnessScopedPromptInput, HarnessScopedPromptResult } from '../../driver';
import type { HarnessTextGenerationInput } from '../../generation';
import type { CodexPromptPart } from '../../core/surface';
import { defaultRuntimeDirectory } from '../../runtime/paths';
export type AntigravityHostOptions<Context extends HarnessContext = HarnessContext> = {
  stateDirectory?: () => string;
  home?: () => string;
  resolveRuntime?: typeof resolveAcpRuntime;
  runtimeOptions?: () => Partial<Parameters<typeof AcpRuntime.open>[0]>;
  client?: { name: string; title?: string; version?: string; temporaryDirectory?: string; metadataDirectory?: string; trustedMcpServerName?: string };
  instructions?: (context: Context, options: { planMode: boolean }) => string | undefined;
  formatPrompt?: (prompt: string, content: readonly CodexPromptPart[] | undefined) => string;
  mcpServers?: (context: Context) => unknown[];
};
const sameScope = (left?: HarnessPromptScope, right?: HarnessPromptScope) => JSON.stringify(left) === JSON.stringify(right);

import { normalizePromptContent, promptContentText, promptContentDispatchText } from '../../core/surface';


import type { ExecutionObservation } from '../../contracts/usage';
import { mkdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AccountRateLimits, BackendConversationRef, BackendModelOption, BackendRuntimeStatus, BackendSession, ConversationListInput, ConversationSummary, ConversationResumeTarget, SendPromptOptions } from '../../contracts/index';

import { requestFromClientRequest, type AgentRequestResponse } from '../../conversations/agent-request';
import type { ProviderAuthentication, ProviderAuthenticationAction } from '../../contracts/authentication';
import type { AntigravityConversationEvent } from '../../contracts/antigravity-conversation';
import { antigravityBackendCapabilities } from '../../capabilities';




import { AcpRuntime, NativeLoginRequired } from './acp-runtime';
import { AcpSession } from './session';
import { antigravityHome, resolveAcpRuntime } from './runtime';
import { record } from '../../acp/acp-connection';
import { sessionMcpServer } from '../../acp/mcp-bridge';
import { listAcpSessions } from './catalog';
import { acpAttachments } from './attachments';
import { AcpPromptJournal } from './prompt-journal';
import { parseQuotaMessage } from './quota';

export class AntigravityHost<Context extends HarnessContext = HarnessContext> implements HarnessDriver<Context, HarnessEvent> {
  readonly backend = 'antigravity' as const;
  private readonly sessions = new Map<string, AcpSession>();
  private readonly opening = new Map<string, Promise<AcpSession>>();
  private readonly generations = new Map<string, number>();
  private readonly revisions = new Map<string, number>();
  private readonly executionScopes = new Map<string, HarnessPromptScope>();
  private readonly resuming = new Map<string, Promise<void>>();
  private readonly auxiliary = new Set<AcpSession>();
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly usageListeners = new Set<(event: ExecutionObservation) => void>();
  onUsage(listener: (event: ExecutionObservation) => void) { this.usageListeners.add(listener); return () => { this.usageListeners.delete(listener); }; }
  private observeUsage(event: ExecutionObservation) { for (const listener of this.usageListeners) { try { listener(event); } catch { /* Observer isolation. */ } } }
  private authentication?: AcpRuntime;
  private auth?: { action: ProviderAuthenticationAction['action']; abort: AbortController; done: Promise<ProviderAuthentication> };
  private quota?: { at: number; limits: AccountRateLimits | null };
  private quotaRead?: Promise<AccountRateLimits | null>;
  private closed = false;
  constructor(private readonly options: AntigravityHostOptions<Context> = {}) {}

  getRuntimeStatus(): BackendRuntimeStatus {
    return { backend: this.backend, status: !(this.options.resolveRuntime ? this.options.resolveRuntime() : resolveAcpRuntime(this.options.stateDirectory?.())) ? 'notConfigured' : this.sessions.size ? 'running' : 'starting' };
  }
  getCapabilities() { return antigravityBackendCapabilities; }
  onEvent(listener: (event: HarnessEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  async authenticate(request: ProviderAuthenticationAction): Promise<ProviderAuthentication> {
    if (request.action === 'cancel') {
      this.auth?.abort.abort();
      await this.authentication?.close();
      return this.authState(false);
    }
    if (this.closed) throw new Error('Antigravity host is closed.');
    const previous = this.auth;
    // A background check must never make the user's explicit sign-in fail; the login supersedes it.
    if (previous && !(previous.action === 'check' && request.action === 'login')) throw new Error('Antigravity authentication is already in progress.');
    const abort = new AbortController();
    const entry: NonNullable<typeof this.auth> = { action: request.action, abort, done: Promise.resolve(null as never) };
    entry.done = (async () => {
      if (previous) { previous.abort.abort(); await this.authentication?.close(); await previous.done.catch(() => {}); }
      return this.runAuthentication(request, abort, entry);
    })();
    this.auth = entry;
    return entry.done;
  }

  private async runAuthentication(request: ProviderAuthenticationAction, abort: AbortController, entry: NonNullable<typeof this.auth>): Promise<ProviderAuthentication> {
    try {
      if (abort.signal.aborted || this.closed) throw new Error('Antigravity authentication cancelled.');
      const home = (this.options.home?.() ?? antigravityHome(this.options.stateDirectory?.()));
      await mkdir(home, { recursive: true, mode: 0o700 });
      this.authentication = await AcpRuntime.open({ ...this.nativeRuntimeOptions(), cwd: home, home, interactive: request.action === 'login', signal: abort.signal,
        onRequest: async () => { throw new Error('No session during authentication.'); }, onNotification: () => {}, onClose: () => {},
      });
      if (abort.signal.aborted) throw new Error('Antigravity authentication cancelled.');
      if (request.action === 'logout') {
        await Promise.all([...this.sessions.keys()].map(id => this.releaseConversation(id)));
        await this.authentication.connection.request('logout', {});
        return this.authState(false);
      }
      try {
        await this.authentication.authenticate();
        if (abort.signal.aborted) throw new Error('Antigravity authentication cancelled.');
        return this.authState(true);
      }
      catch (error) { if (error instanceof NativeLoginRequired) return this.authState(false); throw error; }
    } finally {
      await this.authentication?.close(); this.authentication = undefined;
      if (this.auth === entry) this.auth = undefined;
    }
  }

  async sendPrompt(agent: Context, prompt: string, options?: SendPromptOptions) {
    const submitted = await this.submitPrompt(agent, prompt, options);
    return { backendSession: submitted.backendSession, turnId: submitted.turnId };
  }
  private async submitPrompt(agent: Context, prompt: string, options?: SendPromptOptions, scope?: HarnessPromptScope) {
    if (options?.selection?.reasoningEffort != null || options?.selection?.serviceTier != null) throw new Error('Antigravity does not support reasoning effort or service tiers.');
    const content = options?.content === undefined ? undefined : normalizePromptContent(options.content);
    const attachments = await acpAttachments(options?.attachments ?? []);
    const session = await this.ensure(agent, scope);
    const model = options?.selection?.model ?? (agent.backendDefaults?.kind === this.backend ? agent.backendDefaults.model : undefined);
    if (model) await session.setModel(model);
    const permission = options?.backendOptions?.kind === this.backend ? options.backendOptions.permissionMode
      : agent.backendDefaults?.kind === this.backend ? agent.backendDefaults.permissionMode : undefined;
    if (permission) await session.setMode(permission);
    const planning = options?.planMode === true || /^\/plan(?:\s|$)/.test(prompt);
    const instructions = scope?.developerInstructions ?? this.options.instructions?.(agent, { planMode: planning }) ?? '';
    const dispatched = this.options.formatPrompt?.(prompt, content) ?? (content === undefined ? prompt : promptContentDispatchText(content, prompt));
    const body = `${planning && !prompt.startsWith('/plan') ? '/plan ' : ''}${dispatched}`;
    const wireText = instructions ? `${body}\n\n<context id="${randomUUID()}">\n${instructions}\n</context>` : body;
    const { turnId, completion } = session.prompt(content === undefined ? prompt : promptContentText(content), [{ type: 'text', text: wireText }, ...attachments],
      (options?.attachments ?? []).map(attachment => ({ type: 'attachment', attachment: {
        kind: attachment.type, name: attachment.name ?? path.basename(attachment.path), path: attachment.path, mimeType: attachment.mimeType,
      } })), content === undefined ? undefined : { promptContent: content });
    if (planning) void completion.then(() => {
      if (this.sessions.get(agent.id) !== session || session.snapshot.turns.find(turn => turn.id === turnId)?.status !== 'completed') return;
      const markdown = session.writtenPlan ?? session.snapshot.messages.filter(message => message.turnId === turnId && message.role === 'assistant')
        .flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n');
      if (markdown.trim()) this.emit({ type: 'plan.readyForReview', backend: this.backend, agentId: agent.id, conversationId: session.sessionId, turnId, payload: { markdown } });
    });
    return { backendSession: this.reference(session), turnId, session, completion };
  }

  async continueInterruptedTurn(agent: Context): Promise<import('../../driver').HarnessTurnActionResult> {
    if (agent.backendSession?.kind !== 'antigravity') throw new Error('No Antigravity session to continue.');
    const result = await this.sendPrompt(agent, 'continue');
    return { backendSession: result.backendSession, activeTurnId: result.turnId };
  }

  async interrupt(agent: Context, expectedTurnId?: string) {
    const session = this.sessions.get(agent.id);
    if (!session) throw new Error('Antigravity session is not running.');
    const turnId = session.snapshot.activeTurnId ?? undefined;
    await session.interrupt(expectedTurnId);
    return { backendSession: this.reference(session), turnId };
  }

  async executeScopedPrompt(agent: Context, input: HarnessScopedPromptInput): Promise<HarnessScopedPromptResult> {
    input = { ...input, scope: structuredClone(input.scope) };
    if (input.session && input.session.kind !== this.backend) throw new Error('Antigravity cannot continue another provider execution.');
    const scopedContext = { ...agent, folder: input.cwd, backendSession: input.session };
    const { session, turnId, completion } = await this.submitPrompt(scopedContext, input.prompt, input.options, input.scope);
    await completion;
    if (session.snapshot.turns.find(candidate => candidate.id === turnId)?.status !== 'completed') throw new Error(session.snapshot.error ?? 'Antigravity execution was interrupted.');
    const text = session.snapshot.messages.filter(message => message.turnId === turnId && message.role === 'assistant')
      .flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n');
    return { text, session: this.reference(session) };
  }

  /** The runtime answers `/usage` without a model turn; every read opens a short-lived hidden session, so reads are shared and briefly reused. */
  getAccountRateLimits(): Promise<AccountRateLimits | null> {
    if (this.closed) return Promise.reject(new Error('Antigravity host is closed.'));
    if (this.quota && Date.now() - this.quota.at < 120_000) return Promise.resolve(this.quota.limits);
    return this.quotaRead ??= this.readQuota().then(limits => { this.quota = { at: Date.now(), limits }; return limits; })
      .finally(() => { this.quotaRead = undefined; });
  }

  private async readQuota(): Promise<AccountRateLimits | null> {
    const cwd = path.join((this.options.stateDirectory?.() ?? defaultRuntimeDirectory()), 'antigravity-quota');
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const session = await this.openSession({ agentId: `quota-${randomUUID()}`, cwd, mcpServers: [], tools: false, ephemeral: true, changed: () => {} });
    this.auxiliary.add(session);
    try {
      await session.prompt('/usage').completion;
      if (session.snapshot.turns[0]?.status !== 'completed') throw new Error(session.snapshot.error ?? 'Antigravity quota is unavailable.');
      return parseQuotaMessage(session.snapshot.messages.filter(message => message.role === 'assistant')
        .flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n'));
    } finally { this.auxiliary.delete(session); await session.close(); }
  }

  async generateText(agent: Context, input: HarnessTextGenerationInput): Promise<{ text: string }> {
    if (this.closed) throw new Error('Antigravity host is closed.');
    input.signal?.throwIfAborted();
    const inspect = input.tools === true;
    const servers = input.mcpServers ?? [];
    const session = await this.openSession({ agentId: `generation-${randomUUID()}`, cwd: input.cwd, mcpServers: servers.map(server => sessionMcpServer(server.url, server.name, [...server.enabledTools])), utilityMcpTools: servers.map(server => ({server:server.name, tools:server.enabledTools})), tools: inspect ? 'read-only' : false, ...(input.timeoutMs === null ? {promptTimeoutMs:null} : {}), ephemeral: true, changed: () => {}, usage: event => this.observeUsage({ ...event, agentId: agent.id }) });
    this.auxiliary.add(session);
    const abort = () => { void session.interrupt().catch(() => session.close()); };
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      input.signal?.throwIfAborted();
      if (this.closed) throw new Error('Antigravity host is closed.');
      const selection = input.selectModel?.(antigravityModels(session.configuration.models)) ?? input.selection;
      if (selection?.model) await session.setModel(selection.model);
      await session.setMode('default');
      const prompt = [input.developerInstructions, inspect ? 'Inspect the working folder with read-only Git and source tools. Use simple Git commands without shell operators. Start every Git command with `git --no-pager --no-optional-locks -c core.fsmonitor=false`. For git diff, show or log, include --no-ext-diff --no-textconv. Never write files or modify Git state. Return only the requested final text.' : (servers.length ? 'Return only the requested text. The supplied MCP tools are available; workspace tools are disabled.' : 'Return only the requested text. Do not call tools.'),
        input.outputSchema ? `Return JSON matching this schema: ${JSON.stringify(input.outputSchema)}` : '', input.prompt].filter(Boolean).join('\n\n');
      const attachments = await acpAttachments(input.attachments ?? []);
      input.signal?.throwIfAborted();
      const turn = session.prompt(prompt, [{type:'text',text:prompt}, ...attachments]);
      await turn.completion;
      input.signal?.throwIfAborted();
      if (session.snapshot.turns[0]?.status !== 'completed') throw new Error(session.snapshot.error ?? 'Antigravity text generation failed.');
      const text = session.snapshot.messages.filter(message => message.role === 'assistant')
        .flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n');
      if (!text.trim()) throw new Error('Antigravity returned no text.');
      return { text };
    } finally { input.signal?.removeEventListener('abort', abort); this.auxiliary.delete(session); await session.close(); }
  }

  async disposeScopedSession(agent: Context, scopedSession: BackendSession): Promise<void> {
    if (scopedSession.kind !== this.backend) throw new Error('Antigravity cannot dispose another provider execution.');
    const session = this.sessions.get(agent.id);
    if (session && session.sessionId !== scopedSession.sessionId) throw new Error('Antigravity execution session changed.');
    await this.releaseConversation(agent.id);
  }

  async respondToAgentRequest(response: AgentRequestResponse): Promise<void> {
    const session = response.agentId ? this.sessions.get(response.agentId)
      : [...this.sessions.values()].find(candidate => candidate.snapshot.clientRequests.some(request => request.id === response.id));
    if (!session) throw new Error('Antigravity request is no longer pending.');
    session.respond(response);
  }

  async loadConversation(agent: Context): Promise<BackendSession | null> {
    if (!agent.backendSession && !this.sessions.has(agent.id)) return null;
    const session = await this.ensure(agent);
    this.publishSnapshot(agent.id, session);
    return this.reference(session);
  }

  async resumeConversation(agent: Context, target: ConversationResumeTarget) {
    if (target.ref.backend !== this.backend || target.storageState !== 'active') throw new Error('Invalid Antigravity conversation target.');
    if (target.ref.folder !== agent.folder) throw new Error('Antigravity conversation belongs to another workspace.');
    const existing = this.sessions.get(agent.id);
    if (existing?.snapshot.busy || this.opening.has(agent.id) || this.resuming.has(agent.id)) throw new Error('Finish the current Antigravity operation before resuming history.');
    // Open and validate complete replay before replacing the visible conversation.
    const generation = this.generations.get(agent.id) ?? 0;
    let finishResume!: () => void;
    this.resuming.set(agent.id, new Promise<void>(resolve => { finishResume = resolve; }));
    try {
      const next = await this.open(agent, target.ref.sessionId);
      if (this.closed || generation !== (this.generations.get(agent.id) ?? 0)) { await next.close(); throw new Error('Antigravity session was released during history loading.'); }
      await this.releaseConversation(agent.id);
      this.sessions.set(agent.id, next);
      this.publishSnapshot(agent.id, next);
      return { backendSession: this.reference(next) };
    } finally { this.resuming.delete(agent.id); finishResume(); }
  }

  async listConversations(agent: Context, input?: ConversationListInput): Promise<ConversationSummary[]> {
    await mkdir(this.workingDirectory(agent), { recursive: true });
    const runtime = await AcpRuntime.open({ ...this.nativeRuntimeOptions(), cwd: this.workingDirectory(agent),
      onRequest: async () => { throw new Error('No active Antigravity conversation.'); }, onNotification: () => {}, onClose: () => {},
    });
    try {
      await runtime.authenticate();
      const query = input?.searchTerm?.trim().toLocaleLowerCase();
      const cwd = await realpath(this.workingDirectory(agent));
      const home = (this.options.home?.() ?? antigravityHome(this.options.stateDirectory?.()));
      const entries = await Promise.all((await listAcpSessions(runtime.connection)).map(async entry => ({ ...entry, cwd: await realpath(entry.cwd).catch(() => null),
        ephemeral: await AcpPromptJournal.isEphemeral(home, entry.sessionId, this.options.client?.metadataDirectory) })));
      return entries
        .filter(entry => !entry.ephemeral)
        .filter(entry => entry.cwd === cwd)
        .filter(entry => !query || `${entry.title} ${entry.sessionId}`.toLocaleLowerCase().includes(query))
        .slice(0, input?.limit ?? 100)
        .map(entry => ({ id: entry.sessionId, sessionId: entry.sessionId, title: entry.title,
          updatedAt: '', messageCount: 0, storageState: 'active',
          ref: { backend: this.backend, folder: agent.folder, sessionId: entry.sessionId } }));
    } catch (error) { if (error instanceof NativeLoginRequired) this.authState(false); throw error; }
    finally { await runtime.close(); }
  }

  async readConversationMessages(ref: BackendConversationRef, agentId: string) {
    if (ref.backend !== this.backend) throw new Error('Antigravity cannot read another provider conversation.');
    const current = this.sessions.get(agentId);
    if (current?.sessionId === ref.sessionId) {
      if (await realpath(current.cwd) !== await realpath(this.workingDirectory({ id: agentId, folder: ref.folder }))) throw new Error('Antigravity conversation belongs to another workspace.');
      return structuredClone(current.snapshot.messages);
    }
    const session = await this.openSession({ agentId, cwd: this.workingDirectory({ id: agentId, folder: ref.folder }), sessionId: ref.sessionId, mcpServers: [], changed: () => {} });
    try { return structuredClone(session.snapshot.messages); } finally { await session.close(); }
  }

  async readConversationSummary(agent: Context, ref: BackendConversationRef): Promise<ConversationSummary | null> {
    if (ref.backend !== this.backend || ref.folder !== agent.folder) return null;
    return (await this.listConversations(agent)).find(entry => entry.sessionId === ref.sessionId) ?? null;
  }

  async listModels(agent: Context): Promise<BackendModelOption[]> {
    const resuming = this.resuming.get(agent.id);
    if (resuming) await resuming;
    // Read the adopted session; a cancelled resume must not reopen the caller's old reference.
    const session = resuming ? this.sessions.get(agent.id) : await this.ensure(agent);
    if (!session || session.isClosed) throw new Error('Antigravity session was released during model loading.');
    return antigravityModels(session.configuration.models);
  }

  async setPermissionMode(agent: Context, mode: string) {
    await (await this.ensure(agent)).setMode(mode);
    return { backendDefaults: { ...(agent.backendDefaults?.kind === this.backend ? agent.backendDefaults : {}), kind: this.backend, permissionMode: mode } };
  }

  async releaseConversation(agentId: string): Promise<void> {
    this.generations.set(agentId, (this.generations.get(agentId) ?? 0) + 1);
    const session = this.sessions.get(agentId); this.sessions.delete(agentId);
    this.executionScopes.delete(agentId);
    await session?.close();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.auth?.abort.abort();
    await this.authentication?.close();
    await Promise.all([...this.auxiliary].map(session => session.close()));
    await Promise.all([...this.sessions.keys()].map(id => this.releaseConversation(id)));
    await Promise.allSettled(this.opening.values());
  }

  private async ensure(agent: Context, scope?: HarnessPromptScope): Promise<AcpSession> {
    if (this.closed) throw new Error('Antigravity host is closed.');
    if (this.resuming.has(agent.id)) throw new Error('Antigravity history is still loading.');
    if (!sameScope(this.executionScopes.get(agent.id), scope)) {
      if (this.sessions.get(agent.id)?.snapshot.busy || this.opening.has(agent.id)) throw new Error('Antigravity collaboration scope cannot change during a turn.');
      await this.releaseConversation(agent.id);
    }
    const current = this.sessions.get(agent.id);
    if (current && !current.isClosed) return current;
    const pending = this.opening.get(agent.id);
    if (pending) return pending;
    const generation = this.generations.get(agent.id) ?? 0;
    const sessionId = agent.backendSession?.kind === this.backend ? agent.backendSession.sessionId : current?.sessionId;
    if (scope) this.executionScopes.set(agent.id, scope);
    const work = this.open(agent, sessionId, scope).then(async session => {
      if (this.closed || generation !== (this.generations.get(agent.id) ?? 0)) { await session.close(); throw new Error('Antigravity session was released during startup.'); }
      this.sessions.set(agent.id, session);
      this.publishSnapshot(agent.id, session);
      return session;
    }).finally(() => this.opening.delete(agent.id));
    this.opening.set(agent.id, work);
    return work;
  }

  private async open(agent: Context, sessionId?: string, scope?: HarnessPromptScope): Promise<AcpSession> {
    const cwd = this.workingDirectory(agent);
    if (!agent.folder) await mkdir(cwd, { recursive: true, mode: 0o700 });
    const mcpServers = scope ? (scope.mcpServers ?? []).map(server => sessionMcpServer(server.url, server.name, server.enabledTools ? [...server.enabledTools] : undefined)) : this.options.mcpServers?.(agent) ?? [];
    return this.openSession({ agentId: agent.id, cwd, sessionId, mcpServers, ephemeral: Boolean(scope), changed: event => this.conversationEvent(event), usage: event => this.observeUsage(event) });
  }

  private async openSession(options: Parameters<typeof AcpSession.open>[0]): Promise<AcpSession> {
    try { return await AcpSession.open({ ...options, home: options.home ?? this.options.home?.(), client: this.options.client, runtimeOptions: { ...this.nativeRuntimeOptions(), ...options.runtimeOptions } }); }
    catch (error) { if (error instanceof NativeLoginRequired) this.authState(false); throw error; }
  }
  private nativeRuntimeOptions(): Partial<Parameters<typeof AcpRuntime.open>[0]> {
    return { client: this.options.client, ...this.options.runtimeOptions?.() };
  }

  private workingDirectory(agent: Pick<Context, 'folder' | 'id'>): string {
    return agent.folder ?? path.join((this.options.stateDirectory?.() ?? defaultRuntimeDirectory()), 'antigravity-quick-chats', encodeURIComponent(agent.id));
  }

  private conversationEvent(event: AntigravityConversationEvent): void {
    const identity = { agentId: event.agentId, backend: this.backend, backendSessionId: event.sessionId, conversationId: event.sessionId, turnId: event.turnId };
    this.emit({ ...identity, type: 'antigravity.conversationEventReceived', payload: { revision: this.nextRevision(event.agentId), event } });
    if (event.type === 'request.created') this.emit({ ...identity, type: 'agentRequest.created', payload: { request: requestFromClientRequest(event.payload.request, { conversationId: event.sessionId, turnId: event.turnId }) } });
    else if (event.type === 'request.resolved') this.emit({ ...identity, type: 'agentRequest.resolved', payload: event.payload });
    else if (event.type === 'turn.started') this.emit({ ...identity, type: 'agent.statusChanged', payload: { type: 'working' } });
    else if (event.type === 'turn.completed') this.emit({ ...identity, type: 'agent.statusChanged', payload: event.payload.turn.status === 'failed' ? { type: 'error', message: event.payload.error ?? 'Antigravity turn failed.' } : { type: 'idle' } });
  }
  private publishSnapshot(agentId: string, session: AcpSession): void {
    this.emit({ type: 'antigravity.conversationSnapshotChanged', agentId, backend: this.backend, backendSessionId: session.sessionId, conversationId: session.sessionId,
      payload: { revision: this.nextRevision(agentId), snapshot: session.snapshot } });
  }
  private reference(session: AcpSession): BackendSession { return { kind: this.backend, sessionId: session.sessionId }; }
  private nextRevision(agentId: string): number { const revision = (this.revisions.get(agentId) ?? 0) + 1; this.revisions.set(agentId, revision); return revision; }
  private authState(connected: boolean): ProviderAuthentication {
    const state: ProviderAuthentication = { kind: this.backend, connected, state: { loggedIn: connected, homePath: (this.options.home?.() ?? antigravityHome(this.options.stateDirectory?.())) } };
    this.emit({ type: 'provider.authenticationChanged', backend: this.backend, payload: state }); return state;
  }
  private emit(event: HarnessEvent): void { for (const listener of this.listeners) listener(event); }
}

function antigravityModels(models: unknown): BackendModelOption[] {
  if (!record(models) || !Array.isArray(models.availableModels)) return [];
  return models.availableModels.filter(record).filter(model => typeof model.modelId === 'string').map(model => ({
    id: model.modelId as string, model: model.modelId as string,
    displayName: typeof model.name === 'string' ? model.name : model.modelId as string,
    ...(typeof model.description === 'string' ? { description: model.description } : {}),
    isDefault: model.modelId === models.currentModelId,
  }));
}
