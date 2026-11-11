import type { HarnessTextGenerationInput, HarnessTextGenerationResult } from '../../generation';
import type { ConversationStorageState } from '../../contracts/conversation';
import type { StartCodexRealtimeOptions } from '../../core/codex-conversation-types';
import type { CodexRealtimeSession } from './host-contracts';
import { clientResponseFromAgentResponse } from '../../conversations/agent-request';
import type {
  Agent,
  ApprovalPreset,
  ProviderCapabilities,
  ProviderConversationRef,
  ProviderModelOption,
  ProviderPluginSummary,
  ProviderRuntimeStatus,
  ProviderSessionData,
  ProviderSkillSummary, ConversationListInput,
  ConversationResumeTarget,
  ConversationSummary,
  Message,
  SendPromptOptions,
  CodexAuthentication,
  CodexChatGptLogin,
  DevicePairingSession,
  DevicePairingStatus,
  PairedDevice
} from '../../contracts/index';
import { codexHarnessCapabilities } from '../../capabilities';
import type { AuthenticationLogin } from '../../contracts/authentication';
import type { ProviderDriver, ProviderApprovalPresetResult, ProviderConversationForkResult, ProviderConversationResumeResult, ProviderEvent, ProviderGoalResult, ProviderSendResult, ProviderTurnActionResult } from '../../driver';
import type { CodexHostAdapter } from './host-adapter';

type CodexPromptCommand = { type: 'review'; prompt: string };

export class CodexHostController<Context extends Agent = Agent> implements ProviderDriver<Context, ProviderEvent> {
  readonly provider = 'codex' as const;

  constructor(
    protected readonly sessionManager: CodexHostAdapter<Context>,
  ) {}

  getAccountRateLimits() { return this.sessionManager.getAccountRateLimits(); }
  getBankedResets() { return this.sessionManager.getBankedResets(); }
  useBankedReset(input: import('../../contracts/banked-resets').UseBankedResetInput) { return this.sessionManager.useBankedReset(input); }

  getRuntimeStatus(): ProviderRuntimeStatus {
    return this.sessionManager.getRuntimeStatus();
  }

  getAuthentication(): Promise<CodexAuthentication> {
    return this.sessionManager.getAuthentication();
  }

  async authenticate(request: import('../../contracts/authentication').ProviderAuthenticationAction): Promise<import('../../contracts/authentication').ProviderAuthentication> {
    if (request.action === 'login') {
      const login: AuthenticationLogin = request.method === 'deviceCode'
        ? await this.startChatGptDeviceCodeLogin().then(({ loginId, verificationUrl, userCode }) => ({ method: 'deviceCode', id: loginId, url: verificationUrl, code: userCode }))
        : await this.startChatGptLogin().then(({ loginId, authUrl }) => ({ method: 'browser', id: loginId, url: authUrl }));
      const state = await this.getAuthentication();
      return { kind: 'codex', connected: Boolean(state.account || !state.requiresOpenaiAuth), state, login };
    }
    const state = await (request.action === 'logout' ? this.logout()
      : request.action === 'cancel' ? this.cancelChatGptLogin(request.loginId) : this.getAuthentication());
    return { kind: 'codex', connected: request.action !== 'logout' && Boolean(state.account || !state.requiresOpenaiAuth), state };
  }

  startChatGptLogin(): Promise<CodexChatGptLogin> {
    return this.sessionManager.startChatGptLogin();
  }

  startChatGptDeviceCodeLogin() {
    return this.sessionManager.startChatGptDeviceCodeLogin();
  }

  cancelChatGptLogin(loginId?: string): Promise<CodexAuthentication> {
    return this.sessionManager.cancelChatGptLogin(loginId);
  }

  logout(): Promise<CodexAuthentication> {
    return this.sessionManager.logout();
  }

  getCapabilities(agent: Context): ProviderCapabilities {
    return this.sessionManager.getCapabilities?.(agent) ?? codexHarnessCapabilities;
  }
  async generateText(agent: Context, input: HarnessTextGenerationInput): Promise<HarnessTextGenerationResult> {
    return this.sessionManager.generateText(agent, input);
  }

  generateImage(_agent: Context, input: import('../../generation').HarnessImageGenerationInput, signal?: AbortSignal) {
    return this.sessionManager.generateImage(input, signal);
  }





  cancelScopedPrompt(agent: Context): Promise<void> { return this.sessionManager.cancelScopedPrompt(agent); }

  executeScopedPrompt(agent: Context, input: import('../../driver').ProviderScopedPromptInput) { return this.sessionManager.executeScopedPrompt(agent, input); }
  disposeScopedSession(_agent: Context, session: ProviderSessionData) { return this.sessionManager.disposeScopedSession(session); }

  async listModels(_agent: Context): Promise<ProviderModelOption[]> {
    return this.sessionManager.listModels();
  }

  async listSkills(agent: Context, forceReload = false): Promise<ProviderSkillSummary[]> {
    return this.sessionManager.listSkills(agent, forceReload);
  }

  async listPlugins(_agent: Context): Promise<ProviderPluginSummary[]> {
    return this.sessionManager.listPlugins();
  }

  setConversationStorage(ref: ProviderConversationRef, state: ConversationStorageState): Promise<void> {
    return this.sessionManager.setConversationStorage(ref, state);
  }

  startRealtime(agent: Context, options: StartCodexRealtimeOptions): Promise<CodexRealtimeSession> {
    return this.sessionManager.startRealtime(agent, options);
  }

  getRemoteControlStatus(): Promise<DevicePairingStatus> {
    return this.sessionManager.getRemoteControlStatus();
  }

  enableRemoteControl(): Promise<DevicePairingStatus> {
    return this.sessionManager.enableRemoteControl();
  }

  disableRemoteControl(): Promise<DevicePairingStatus> {
    return this.sessionManager.disableRemoteControl();
  }

  startDevicePairing(): Promise<DevicePairingSession> {
    return this.sessionManager.startDevicePairing();
  }

  checkDevicePairing(session: DevicePairingSession): Promise<boolean> {
    return this.sessionManager.checkDevicePairing(session);
  }

  listPairedDevices(environmentId: string): Promise<PairedDevice[]> {
    return this.sessionManager.listPairedDevices(environmentId);
  }

  revokePairedDevice(environmentId: string, clientId: string): Promise<void> {
    return this.sessionManager.revokePairedDevice(environmentId, clientId);
  }

  tryHandlePromptCommand(agent: Context, prompt: string): Promise<ProviderSendResult> | null {
    const command = codexPromptCommand(prompt);
    if (!command) {
      return null;
    }

    return this.runPromptCommand(agent, command);
  }

  preparePromptOptions(_agent: Context, options?: SendPromptOptions): SendPromptOptions | undefined {
    const skills = options?.skills?.length ? options.skills : options?.providerOptions?.kind === 'codex' ? options.providerOptions.skills : undefined;
    return cleanedPromptOptions({ ...options, ...(skills?.length ? { skills } : {}) });
  }

  async sendPrompt(agent: Context, prompt: string, options?: SendPromptOptions): Promise<ProviderSendResult> {
    const result = await this.sessionManager.sendPrompt(agent, prompt, options);
    return {
      providerSession: codexProviderSession(result.threadId),
      turnId: result.turnId,
      ...(result.messageId ? { messageId: result.messageId } : {}),
    };
  }

  async setConversationTitle(agent: Context, title: string): Promise<void> {
    await this.sessionManager.setConversationTitle(agent, title);
  }

  async setGoal(agent: Context, objective: string): Promise<ProviderGoalResult> {
    const result = await this.sessionManager.setThreadGoal(agent, objective);
    return {
      providerSession: codexProviderSession(result.threadId),
      goal: result.goal,
    };
  }

  async clearGoal(agent: Context): Promise<ProviderGoalResult> {
    const result = await this.sessionManager.clearThreadGoal(agent);
    return {
      providerSession: codexProviderSession(result.threadId),
      cleared: result.cleared,
    };
  }

  async setApprovalPreset(agent: Context, preset: ApprovalPreset): Promise<ProviderApprovalPresetResult> {
    const result = await this.sessionManager.setApprovalPreset(agent, preset);
    return {
      providerSession: codexProviderSession(result.threadId),
      approvalPreset: result.approvalPreset,
    };
  }

  /** Starts Codex's own review (`review/start`). */
  async startReview(agent: Context, target: import('../../contracts/conversation').ConversationReviewTarget = { type: 'uncommittedChanges' }): Promise<ProviderSendResult> {
    const result = await this.sessionManager.reviewThread(agent, target);
    return { providerSession: codexProviderSession(result.threadId), ...(result.turnId ? { turnId: result.turnId } : {}) };
  }

  /** `/review` runs the native review; text after it is the review's instructions. */
  private runPromptCommand(agent: Context, command: CodexPromptCommand): Promise<ProviderSendResult> {
    const instructions = command.prompt.replace(/^\/review\b/, '').trim();
    return this.startReview(agent, instructions ? { type: 'custom', instructions } : { type: 'uncommittedChanges' });
  }

  async steerPrompt(agent: Context, prompt: string, options?: SendPromptOptions): Promise<ProviderSendResult> {
    const result = await this.sessionManager.steerPrompt(agent, prompt, options);
    return {
      providerSession: codexProviderSession(result.threadId),
      turnId: result.turnId,
      ...(result.messageId ? { messageId: result.messageId } : {}),
    };
  }

  async interrupt(agent: Context, expectedTurnId?: string): Promise<ProviderSendResult> {
    const result = await this.sessionManager.interruptTurn(agent, expectedTurnId);
    return {
      providerSession: codexProviderSession(result.threadId),
      turnId: result.turnId,
    };
  }

  releaseConversation(agentId: string): void {
    this.sessionManager.releaseConversation(agentId);
  }

  async deleteTurn(agent: Context, turnId: string): Promise<ProviderTurnActionResult> {
    const result = await this.sessionManager.deleteTurn(agent, turnId);
    return {
      providerSession: codexProviderSession(result.threadId),
      activeTurnId: result.activeTurnId,
    };
  }

  async editTurn(agent: Context, turnId: string, content: string, options?: Pick<SendPromptOptions, 'content'>): Promise<ProviderTurnActionResult> {
    const result = await this.sessionManager.editTurn(agent, turnId, content, options);
    return {
      providerSession: codexProviderSession(result.threadId),
      activeTurnId: result.activeTurnId,
    };
  }

  async retryTurn(agent: Context, turnId: string): Promise<ProviderTurnActionResult> {
    const result = await this.sessionManager.retryTurn(agent, turnId);
    return {
      providerSession: codexProviderSession(result.threadId),
      activeTurnId: result.activeTurnId,
    };
  }

  async continueInterruptedTurn(agent: Context, safetyReview?: import('../../contracts/safety-review').ProviderSafetyReviewTarget): Promise<ProviderTurnActionResult> {
    const result = await this.sessionManager.continueInterruptedTurn(agent, safetyReview);
    return {
      providerSession: codexProviderSession(result.threadId),
      activeTurnId: result.activeTurnId,
    };
  }

  readConversationContent(agent: Context, input: import('../../contracts/conversation').ConversationContentInput) {
    return this.sessionManager.readConversationContent(agent, input);
  }

  async loadConversation(agent: Context): Promise<ProviderSessionData | null> {
    const threadId = await this.sessionManager.loadConversation(agent);
    return threadId ? codexProviderSession(threadId) : null;
  }

  loadTurnHistory(agent: Context, turnId: string): Promise<void> {
    return this.sessionManager.loadTurnHistory(agent, turnId);
  }

  async loadOlderHistory(agent: Context) {
    return this.sessionManager.loadOlderHistory(agent);
  }

  async readConversationMessages(ref: ProviderConversationRef, agentId: string, options?: { view?: 'full' | 'last' }): Promise<Message[]> {
    if (ref.provider !== 'codex') {
      throw new Error('Codex cannot read non-Codex conversation history.');
    }
    return this.sessionManager.readConversationMessages(ref.threadId, agentId, options);
  }

  async readConversationSummary(agent: Context, ref: ProviderConversationRef): Promise<ConversationSummary | null> {
    if (ref.provider !== 'codex') return null;
    return this.sessionManager.readConversationSummary(agent, ref.threadId);
  }

  async listConversations(agent: Context, input?: ConversationListInput): Promise<ConversationSummary[]> {
    return this.sessionManager.listConversations(agent, input);
  }

  async resumeConversation(agent: Context, target: ConversationResumeTarget): Promise<ProviderConversationResumeResult> {
    if (target.ref.provider !== 'codex') {
      throw new Error('Codex cannot resume non-Codex conversation history.');
    }

    const result = await this.sessionManager.resumeConversation(agent, target);
    return {
      providerSession: codexProviderSession(result.threadId),
    };
  }

  async archiveAgentConversation(agent: Context): Promise<void> {
    await this.sessionManager.archiveAgentConversation(agent);
  }

  async deleteAgentConversation(agent: Context): Promise<void> {
    await this.sessionManager.deleteAgentConversation(agent);
  }

  async reconcileConversations(agents: Context[]): Promise<void> {
    await this.sessionManager.reconcileConversations(agents);
  }

  async forkConversation(agent: Context, targetAgent: Context, turnId?: string): Promise<ProviderConversationForkResult | null> {
    const result = turnId === undefined
      ? await this.sessionManager.forkConversation(agent, targetAgent)
      : await this.sessionManager.forkConversation(agent, targetAgent, turnId);
    if (!result) return null;
    return {
      providerSession: codexProviderSession(result.threadId),
      ...(result.activeTurnId ? { activeTurnId: result.activeTurnId } : {}),
      ...(result.forkedFromTurnId === undefined ? {} : { forkedFromTurnId: result.forkedFromTurnId }),
    };
  }

  async respondToAgentRequest(response: import('../../conversations/agent-request').AgentRequestResponse): Promise<void> {
    await this.sessionManager.respondToClientRequest({
      ...clientResponseFromAgentResponse(response),
      ...(response.agentId ? { agentId: response.agentId } : {}),
    });
  }

  onUsage(listener: (observation: import('../../contracts/usage').ExecutionObservation)=>void):()=>void { return this.sessionManager.onUsage(listener); }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    return this.sessionManager.onEvent(listener);
  }

  async close(): Promise<void> {
    await this.sessionManager.close();
  }
}

function cleanedPromptOptions(options: SendPromptOptions): SendPromptOptions | undefined {
  return Object.keys(options).length > 0 ? options : undefined;
}

function codexProviderSession(threadId: string): Extract<ProviderSessionData, { kind: 'codex' }> {
  return {
    kind: 'codex',
    threadId,
  };
}

function codexPromptCommand(prompt: string): CodexPromptCommand | null {
  const parsed = parseSlashName(prompt);
  if (!parsed) {
    return null;
  }

  if (parsed.name === 'review') {
    return {
      type: 'review',
      prompt,
    };
  }

  return null;
}

function parseSlashName(value: string): { name: string; rest: string } | null {
  if (!value.startsWith('/')) {
    return null;
  }

  const stripped = value.slice(1);
  const whitespaceIndex = stripped.search(/\s/);
  const name = whitespaceIndex === -1 ? stripped : stripped.slice(0, whitespaceIndex);
  if (!name || name.includes('/')) {
    return null;
  }

  const rest = whitespaceIndex === -1 ? '' : stripped.slice(whitespaceIndex).trim();
  return { name, rest };
}
