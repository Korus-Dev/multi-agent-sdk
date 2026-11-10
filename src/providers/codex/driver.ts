import type { HarnessTextGenerationInput, HarnessTextGenerationResult } from '../../generation';
import { clientResponseFromAgentResponse } from 'multi-agents-sdk/conversations/agent-request';
import type {
  Agent,
  ApprovalPreset,
  BackendCapabilities,
  BackendConversationRef,
  BackendModelOption,
  BackendPluginSummary,
  BackendRuntimeStatus,
  BackendSession,
  BackendSkillSummary, ConversationListInput,
  ConversationResumeTarget,
  ConversationSummary,
  RendererMessage,
  SendPromptOptions,
  CodexAuthentication,
  CodexChatGptLogin,
  DevicePairingSession,
  DevicePairingStatus,
  PairedDevice
} from 'multi-agents-sdk/contracts';
import { codexBackendCapabilities } from '../../capabilities';
import type { HarnessDriver, HarnessApprovalPresetResult, HarnessConversationForkResult, HarnessConversationResumeResult, HarnessEvent, HarnessGoalResult, HarnessSendResult, HarnessConversationReplacementResult, HarnessTurnActionResult } from '../../driver';
import type { CodexSurfaceAgentAdapter } from './host';

type CodexPromptCommand = { type: 'review'; prompt: string };

export class CodexBackendDriver<Context extends Agent = Agent> implements HarnessDriver<Context, HarnessEvent> {
  readonly backend = 'codex' as const;

  constructor(
    protected readonly sessionManager: CodexSurfaceAgentAdapter<Context>,
  ) {}

  getBankedResets() { return this.sessionManager.getBankedResets(); }
  useBankedReset(input: import('multi-agents-sdk/contracts/banked-resets').UseBankedResetInput) { return this.sessionManager.useBankedReset(input); }

  getRuntimeStatus(): BackendRuntimeStatus {
    return this.sessionManager.getRuntimeStatus();
  }

  getAuthentication(): Promise<CodexAuthentication> {
    return this.sessionManager.getAuthentication();
  }

  async authenticate(request: import('multi-agents-sdk/contracts/authentication').ProviderAuthenticationAction): Promise<import('multi-agents-sdk/contracts/authentication').ProviderAuthentication> {
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

  getCapabilities(agent: Context): BackendCapabilities {
    return this.sessionManager.getCapabilities?.(agent) ?? codexBackendCapabilities;
  }
  async assertHandoffReady(agent: Context): Promise<void> {
    await this.sessionManager.assertHandoffReady(agent);
  }

  async generateText(agent: Context, input: HarnessTextGenerationInput): Promise<HarnessTextGenerationResult> {
    return this.sessionManager.generateText(agent, input);
  }

  generateImage(_agent: Context, input: import('../../generation').HarnessImageGenerationInput, signal?: AbortSignal) {
    return this.sessionManager.generateImage(input, signal);
  }





  executeScopedPrompt(agent: Context, input: import('../../driver').HarnessScopedPromptInput) { return this.sessionManager.executeScopedPrompt(agent, input); }
  disposeScopedSession(_agent: Context, session: BackendSession) { return this.sessionManager.disposeScopedSession(session); }
  async replaceConversationWithSummary(agent: Context): Promise<HarnessConversationReplacementResult> {
    const result = await this.sessionManager.replaceConversationWithSummary(agent);
    return { backendSession: codexBackendSession(result.threadId) };
  }

  async listModels(_agent: Context): Promise<BackendModelOption[]> {
    return this.sessionManager.listModels();
  }

  async listSkills(agent: Context, forceReload = false): Promise<BackendSkillSummary[]> {
    return this.sessionManager.listSkills(agent, forceReload);
  }

  async listPlugins(_agent: Context): Promise<BackendPluginSummary[]> {
    return this.sessionManager.listPlugins();
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

  tryHandlePromptCommand(agent: Context, prompt: string): Promise<HarnessSendResult> | null {
    const command = codexPromptCommand(prompt);
    if (!command) {
      return null;
    }

    return this.runPromptCommand(agent, command);
  }

  preparePromptOptions(_agent: Context, options?: SendPromptOptions): SendPromptOptions | undefined {
    const skills = options?.skills?.length ? options.skills : options?.backendOptions?.kind === 'codex' ? options.backendOptions.skills : undefined;
    return cleanedPromptOptions({ ...options, ...(skills?.length ? { skills } : {}) });
  }

  async sendPrompt(agent: Context, prompt: string, options?: SendPromptOptions): Promise<HarnessSendResult> {
    const result = await this.sessionManager.sendPrompt(agent, prompt, options);
    return {
      backendSession: codexBackendSession(result.threadId),
      turnId: result.turnId,
      ...(result.messageId ? { messageId: result.messageId } : {}),
    };
  }

  async setConversationTitle(agent: Context, title: string): Promise<void> {
    await this.sessionManager.setConversationTitle(agent, title);
  }

  async setGoal(agent: Context, objective: string): Promise<HarnessGoalResult> {
    const result = await this.sessionManager.setThreadGoal(agent, objective);
    return {
      backendSession: codexBackendSession(result.threadId),
      goal: result.goal,
    };
  }

  async clearGoal(agent: Context): Promise<HarnessGoalResult> {
    const result = await this.sessionManager.clearThreadGoal(agent);
    return {
      backendSession: codexBackendSession(result.threadId),
      cleared: result.cleared,
    };
  }

  async setApprovalPreset(agent: Context, preset: ApprovalPreset): Promise<HarnessApprovalPresetResult> {
    const result = await this.sessionManager.setApprovalPreset(agent, preset);
    return {
      backendSession: codexBackendSession(result.threadId),
      approvalPreset: result.approvalPreset,
    };
  }

  private async runPromptCommand(agent: Context, command: CodexPromptCommand): Promise<HarnessSendResult> {
    const result = await this.sessionManager.sendPrompt(agent, command.prompt);
    return {
      backendSession: codexBackendSession(result.threadId),
      turnId: result.turnId,
    };
  }

  async steerPrompt(agent: Context, prompt: string, options?: SendPromptOptions): Promise<HarnessSendResult> {
    const result = await this.sessionManager.steerPrompt(agent, prompt, options);
    return {
      backendSession: codexBackendSession(result.threadId),
      turnId: result.turnId,
      ...(result.messageId ? { messageId: result.messageId } : {}),
    };
  }

  async interrupt(agent: Context, expectedTurnId?: string): Promise<HarnessSendResult> {
    const result = await this.sessionManager.interruptTurn(agent, expectedTurnId);
    return {
      backendSession: codexBackendSession(result.threadId),
      turnId: result.turnId,
    };
  }

  releaseConversation(agentId: string): void {
    this.sessionManager.releaseConversation(agentId);
  }

  async deleteTurn(agent: Context, turnId: string): Promise<HarnessTurnActionResult> {
    const result = await this.sessionManager.deleteTurn(agent, turnId);
    return {
      backendSession: codexBackendSession(result.threadId),
      activeTurnId: result.activeTurnId,
    };
  }

  async editTurn(agent: Context, turnId: string, content: string, options?: Pick<SendPromptOptions, 'content'>): Promise<HarnessTurnActionResult> {
    const result = await this.sessionManager.editTurn(agent, turnId, content, options);
    return {
      backendSession: codexBackendSession(result.threadId),
      activeTurnId: result.activeTurnId,
    };
  }

  async retryTurn(agent: Context, turnId: string): Promise<HarnessTurnActionResult> {
    const result = await this.sessionManager.retryTurn(agent, turnId);
    return {
      backendSession: codexBackendSession(result.threadId),
      activeTurnId: result.activeTurnId,
    };
  }

  async continueInterruptedTurn(agent: Context, safetyReview?: import('../../contracts/safety-review').ProviderSafetyReviewTarget): Promise<HarnessTurnActionResult> {
    const result = await this.sessionManager.continueInterruptedTurn(agent, safetyReview);
    return {
      backendSession: codexBackendSession(result.threadId),
      activeTurnId: result.activeTurnId,
    };
  }

  readConversationContent(agent: Context, input: import('multi-agents-sdk/contracts/conversation').ConversationContentInput) {
    return this.sessionManager.readConversationContent(agent, input);
  }

  async loadConversation(agent: Context): Promise<BackendSession | null> {
    const threadId = await this.sessionManager.loadConversation(agent);
    return threadId ? codexBackendSession(threadId) : null;
  }

  loadTurnHistory(agent: Context, turnId: string): Promise<void> {
    return this.sessionManager.loadTurnHistory(agent, turnId);
  }

  async loadOlderHistory(agent: Context) {
    return this.sessionManager.loadOlderHistory(agent);
  }

  async readConversationMessages(ref: BackendConversationRef, agentId: string): Promise<RendererMessage[]> {
    if (ref.backend !== 'codex') {
      throw new Error('Codex cannot read non-Codex conversation history.');
    }
    return this.sessionManager.readConversationMessages(ref.threadId, agentId);
  }

  async readConversationSummary(agent: Context, ref: BackendConversationRef): Promise<ConversationSummary | null> {
    if (ref.backend !== 'codex') return null;
    return this.sessionManager.readConversationSummary(agent, ref.threadId);
  }

  async listConversations(agent: Context, input?: ConversationListInput): Promise<ConversationSummary[]> {
    return this.sessionManager.listConversations(agent, input);
  }

  async resumeConversation(agent: Context, target: ConversationResumeTarget): Promise<HarnessConversationResumeResult> {
    if (target.ref.backend !== 'codex') {
      throw new Error('Codex cannot resume non-Codex conversation history.');
    }

    const result = await this.sessionManager.resumeConversation(agent, target);
    return {
      backendSession: codexBackendSession(result.threadId),
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

  async forkWorktreeConversation(agent: Context, targetAgent: Context): Promise<HarnessConversationForkResult> {
    const result = await this.sessionManager.forkWorktreeConversation(agent, targetAgent);
    return { backendSession: codexBackendSession(result.threadId), ...(result.activeTurnId ? { activeTurnId: result.activeTurnId } : {}) };
  }

  async forkConversation(agent: Context, targetAgent: Context, turnId?: string): Promise<HarnessConversationForkResult> {
    const result = turnId === undefined
      ? await this.sessionManager.forkConversation(agent, targetAgent)
      : await this.sessionManager.forkConversation(agent, targetAgent, turnId);
    return {
      backendSession: codexBackendSession(result.threadId),
      ...(result.activeTurnId ? { activeTurnId: result.activeTurnId } : {}),
    };
  }

  async respondToAgentRequest(response: import('multi-agents-sdk/conversations/agent-request').AgentRequestResponse): Promise<void> {
    await this.sessionManager.respondToClientRequest({
      ...clientResponseFromAgentResponse(response),
      ...(response.agentId ? { agentId: response.agentId } : {}),
    });
  }

  onUsage(listener: (observation: import('multi-agents-sdk/contracts/usage').ExecutionObservation)=>void):()=>void { return this.sessionManager.onUsage(listener); }

  onEvent(listener: (event: HarnessEvent) => void): () => void {
    return this.sessionManager.onEvent(listener);
  }

  async close(): Promise<void> {
    await this.sessionManager.close();
  }
}

function cleanedPromptOptions(options: SendPromptOptions): SendPromptOptions | undefined {
  return Object.keys(options).length > 0 ? options : undefined;
}

function codexBackendSession(threadId: string): Extract<BackendSession, { kind: 'codex' }> {
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
