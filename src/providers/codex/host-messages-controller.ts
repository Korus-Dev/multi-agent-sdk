import type { ContinueCodexSafetyReviewOptions } from '../../core/codex-host';
import { promptContentDispatchText, promptContentText } from '../../core/prompt-content';
import type { CodexAppServerClient, v2 } from '@korus-dev/codex-sdk';
import type {
  CodexConversationSummary,
  HostEventOrigin,
  SkillInput,
  CodexHostSnapshot,
  SendMessageOptions,
  StartCodexReviewOptions,
  ConversationMessage,
  UpdateConversationSettings,
} from '../../core/codex-host';
import {
  attachmentInput,
  conversationAttachmentPart,
  validateAttachments,
  validatedSendOptions,
} from './host-data';
import type { HostEventInput } from './host-events';
import {
  createMessageId,
  createQueuedPromptId,
  conversationTurn,
  timestampToIso,
  upsertConversationTurn,
} from './host-events';
import {
  ensureAssistantTurnMessage,
  pruneEmptyAssistantPlaceholders,
} from './host-message-state';
import {
  errorMessage,
  mergeSkillInputs,
  parseGoalSlashCommand,
  parsePlanSlashCommand,
  parseReviewSlashCommand,
  authoredPromptContent,
  promptSkillInputsFromContent,
  promptMentionInputs,
  validateSkillInputs,
} from './host-prompts';
import { turnSettings } from './host-settings';
import type { ThreadRuntimePatch, ThreadRuntimeState } from './host-runtime';

export type CodexHostMessagesDependencies = {
  clearGoalForThread(threadId: string): Promise<void>;
  compactForThread(threadId: string): Promise<void>;
  createConversation(): Promise<void>;
  emitConversationActivity(threadId: string, origin: 'action'): void;
  emitEvent(origin: HostEventOrigin, input: HostEventInput): void;
  ensureConnected(): Promise<void>;
  ensureThreadReady(threadId: string): Promise<ThreadRuntimeState>;
  loadSkillsForThread(threadId: string): Promise<void>;
  getSnapshot(): CodexHostSnapshot;
  getState(): CodexHostSnapshot;
  patchConversationStatus(
    threadId: string,
    status: CodexConversationSummary['status'],
    origin: 'action',
  ): void;
  patchConversationTurnCount(threadId: string, turnCount: number, origin: 'action'): void;
  patchRuntime(threadId: string, patch: ThreadRuntimePatch): void;
  requireRuntime(threadId: string): ThreadRuntimeState;
  setGoal(objective: string): Promise<CodexHostSnapshot>;
  setGoalForThread(threadId: string, objective: string): Promise<void>;
  snapshotForRuntime(runtime: ThreadRuntimeState): CodexHostSnapshot;
  startReview(options: StartCodexReviewOptions): Promise<CodexHostSnapshot>;
  startReviewForThread(threadId: string, options: StartCodexReviewOptions): Promise<void>;
  updateSettings(settings: UpdateConversationSettings): Promise<CodexHostSnapshot>;
  updateSettingsForThread(threadId: string, settings: UpdateConversationSettings): Promise<void>;
};

export class CodexHostMessagesController {
  constructor(
    private readonly client: CodexAppServerClient,
    private readonly host: CodexHostMessagesDependencies,
  ) {}

  async send(prompt: string, options: SendMessageOptions = {}): Promise<CodexHostSnapshot> {
    await this.host.ensureConnected();
    let text = prompt.trim();
    if (!text) throw new Error('Cannot send an empty message');
    if (!this.host.getState().activeConversationId) {
      const planCommand = parsePlanSlashCommand(text);
      if (planCommand) {
        await this.host.createConversation();
        await this.host.updateSettings({ planMode: true });
        if (!planCommand.prompt) return this.host.getSnapshot();
        text = planCommand.prompt;
        options = { ...options, planMode: true };
      }
      const goalCommand = parseGoalSlashCommand(text);
      if (goalCommand) {
        if (goalCommand.action === 'clear' || goalCommand.action === 'show' || goalCommand.action === 'edit') {
          return this.host.getSnapshot();
        }
        if (goalCommand.action === 'set') return this.host.setGoal(goalCommand.objective);
        throw new Error('Pausing and resuming goals is not supported by Codex app-server');
      }
      if (text === '/compact') return this.host.getSnapshot();
      const reviewCommand = parseReviewSlashCommand(text);
      if (reviewCommand) {
        await this.host.createConversation();
        return this.host.startReview({ target: reviewCommand });
      }
      if (!this.host.getState().activeConversationId) await this.host.createConversation();
    }
    const threadId = this.host.getState().activeConversationId;
    if (!threadId) throw new Error('Codex did not create a conversation');
    await this.sendToThread(threadId, text, options);
    return this.host.getSnapshot();
  }

  async sendToThread(
    threadId: string,
    prompt: string,
    options: SendMessageOptions = {},
  ): Promise<void> {
    const runtime = await this.host.ensureThreadReady(threadId);
    let text = prompt.trim();
    if (!text) throw new Error('Cannot send an empty message');
    const planCommand = parsePlanSlashCommand(text);
    if (planCommand) {
      await this.host.updateSettingsForThread(threadId, { planMode: true });
      if (!planCommand.prompt) return;
      text = planCommand.prompt;
      options = { ...options, planMode: true };
    }
    const goalCommand = parseGoalSlashCommand(text);
    if (goalCommand) {
      if (goalCommand.action === 'clear') return this.host.clearGoalForThread(threadId);
      if (goalCommand.action === 'set') return this.host.setGoalForThread(threadId, goalCommand.objective);
      if (goalCommand.action === 'unsupported') {
        throw new Error('Pausing and resuming goals is not supported by Codex app-server');
      }
      return;
    }
    if (text === '/compact') return this.host.compactForThread(threadId);
    const reviewCommand = parseReviewSlashCommand(text);
    if (reviewCommand) return this.host.startReviewForThread(threadId, { target: reviewCommand });
    options = {
      ...validatedSendOptions(this.host.snapshotForRuntime(runtime), options),
      ...(options.skills ? { skills: await this.validatedSkills(runtime, options.skills) } : {}),
    };
    await this.sendPromptToThread(threadId, text, options);
  }

  async continueInterruptedTurn(): Promise<CodexHostSnapshot> {
    await this.host.ensureConnected();
    const threadId = this.host.getState().activeConversationId;
    if (!threadId) throw new Error('There is no active conversation');
    await this.continueInterruptedTurnForThread(threadId);
    return this.host.getSnapshot();
  }

  async continueInterruptedTurnForThread(threadId: string, safetyReview?: ContinueCodexSafetyReviewOptions): Promise<void> {
    const reviewedTurnId = safetyReview?.turnId;
    const reviewedFindings = safetyReview ? safetyFindingsKey(safetyReview.findings) : null;
    const runtime = await this.host.ensureThreadReady(threadId);
    if (runtime.busy || runtime.turnStartPending || runtime.activeTurnId) {
      throw new Error('Cannot continue while a turn is active');
    }
    const latestTurnId = runtime.turnIds.at(-1);
    const latestTurn = latestTurnId
      ? runtime.turns.find((turn) => turn.id === latestTurnId)
      : undefined;
    let input: v2.UserInput[] = [];
    if (safetyReview) {
      const findings = latestTurn?.error?.misalignment;
      if (latestTurn?.status !== 'failed' || latestTurnId !== reviewedTurnId
        || !findings?.detailedExplanation?.trim() || !findings.steer?.message.trim()
        || safetyFindingsKey(findings) !== reviewedFindings) {
        throw new Error('Provider safety continuation is unavailable or the reviewed findings have changed');
      }
      input = [{ type: 'text', text: findings.steer.message, text_elements: [] }];
    } else if (latestTurn?.status !== 'interrupted') {
      throw new Error('The latest turn is not interrupted');
    }

    this.host.patchRuntime(threadId, { busy: true, turnStartPending: true, error: null });
    this.host.patchConversationStatus(threadId, 'active', 'action');
    this.host.emitConversationActivity(threadId, 'action');

    try {
      const response = await this.client.request('turn/start', {
        threadId,
        input,
        ...turnSettings(this.host.snapshotForRuntime(runtime), {}),
      });
      const wasKnownTurn = runtime.turnIds.includes(response.turn.id);
      runtime.activeTurnId = response.turn.status === 'inProgress' ? response.turn.id : null;
      if (!wasKnownTurn) runtime.turnIds.push(response.turn.id);
      this.host.patchConversationTurnCount(threadId, runtime.turnIds.length, 'action');
      const busy = response.turn.status === 'inProgress';
      this.host.patchRuntime(threadId, {
        busy,
        turnStartPending: false,
        turns: upsertConversationTurn(runtime.turns, conversationTurn(response.turn)),
        messages: busy
          ? ensureAssistantTurnMessage(runtime.messages, threadId, response.turn.id)
          : runtime.messages,
      });
      this.host.patchConversationStatus(threadId, busy ? 'active' : 'idle', 'action');
      if (busy && !wasKnownTurn) {
        this.host.emitEvent('action', {
          type: 'turn.started', conversationId: threadId, turnId: response.turn.id,
          payload: { startedAt: timestampToIso(response.turn.startedAt) },
        });
      }
      this.host.emitConversationActivity(threadId, 'action');
    } catch (error) {
      this.host.patchRuntime(threadId, {
        busy: false, turnStartPending: false, error: errorMessage(error),
      });
      this.host.patchConversationStatus(threadId, 'error', 'action');
      this.host.emitConversationActivity(threadId, 'action');
      throw error;
    }
  }

  async sendPromptToThread(
    threadId: string,
    text: string,
    options: SendMessageOptions = {},
    displayText?: string,
  ): Promise<void> {
    const runtime = this.host.requireRuntime(threadId);
    const normalizedOptions = validatedSendOptions(this.host.snapshotForRuntime(runtime), options);
    const content = authoredPromptContent(normalizedOptions.content);
    if (content) normalizedOptions.content = content;
    const visibleText = content ? promptContentText(content) : displayText?.trim() || text;
    const skillInputs = await this.validatedSkills(runtime, mergeSkillInputs(promptSkillInputsFromContent(content), normalizedOptions.skills ?? []));
    const attachments = validateAttachments(normalizedOptions.attachments ?? []);
    if (runtime.busy) {
      this.host.patchRuntime(threadId, {
        queuedPrompts: [
          ...runtime.queuedPrompts,
          {
            id: createQueuedPromptId(),
            text: visibleText,
            ...(Object.keys(normalizedOptions).length > 0 ? { options: normalizedOptions } : {}),
          },
        ],
      });
      this.emitQueuedPrompts(threadId);
      return;
    }

    const messageId = createMessageId();
    const optimisticMessage: ConversationMessage = {
      id: messageId,
      role: 'user',
      status: 'complete',
      parts: [{ type: 'text', text: visibleText }, ...attachments.map(conversationAttachmentPart)],
      createdAt: new Date().toISOString(),
      metadata: {
        conversationId: threadId,
        ...(content ? { promptContent: content } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    };
    this.host.patchRuntime(threadId, {
      busy: true, turnStartPending: true, error: null,
      messages: [...runtime.messages, optimisticMessage],
    });
    this.host.patchConversationStatus(threadId, 'active', 'action');
    this.host.emitEvent('action', {
      type: 'message.appended', conversationId: threadId,
      payload: { message: structuredClone(optimisticMessage) },
    });
    this.host.emitConversationActivity(threadId, 'action');

    try {
      const response = await this.client.request('turn/start', {
        threadId,
        clientUserMessageId: messageId,
        input: [
          { type: 'text', text: promptContentDispatchText(content ?? [], text), text_elements: [] },
          ...attachments.map(attachmentInput),
          ...promptMentionInputs(content),
          ...skillInputs.map((skill) => ({ type: 'skill' as const, name: skill.name, path: skill.path })),
        ],
        ...turnSettings(this.host.snapshotForRuntime(runtime), normalizedOptions),
        ...(normalizedOptions.outputSchema === undefined
          ? {}
          : { outputSchema: normalizedOptions.outputSchema as v2.TurnStartParams['outputSchema'] }),
      });
      const wasKnownTurn = runtime.turnIds.includes(response.turn.id);
      runtime.activeTurnId = response.turn.status === 'inProgress' ? response.turn.id : null;
      if (!runtime.turnIds.includes(response.turn.id)) runtime.turnIds.push(response.turn.id);
      this.host.patchConversationTurnCount(threadId, runtime.turnIds.length, 'action');
      const busy = response.turn.status === 'inProgress';
      const messages = runtime.messages.map((message) => message.id === messageId
        ? { ...message, turnId: response.turn.id, metadata: { ...message.metadata, turnId: response.turn.id } }
        : message);
      this.host.patchRuntime(threadId, {
        busy,
        turnStartPending: false,
        turns: upsertConversationTurn(runtime.turns, conversationTurn(response.turn)),
        messages: busy ? ensureAssistantTurnMessage(messages, threadId, response.turn.id) : messages,
      });
      this.host.patchConversationStatus(threadId, busy ? 'active' : 'idle', 'action');
      const startedMessage = messages.find((message) => message.id === messageId);
      if (startedMessage) {
        this.host.emitEvent('action', {
          type: 'message.updated', conversationId: threadId, turnId: response.turn.id,
          payload: { message: structuredClone(startedMessage) },
        });
      }
      if (busy && !wasKnownTurn) {
        this.host.emitEvent('action', {
          type: 'turn.started', conversationId: threadId, turnId: response.turn.id,
          payload: { startedAt: timestampToIso(response.turn.startedAt) },
        });
      }
      this.host.emitConversationActivity(threadId, 'action');
    } catch (error) {
      this.host.patchRuntime(threadId, {
        busy: false, turnStartPending: false, error: errorMessage(error),
      });
      this.host.patchConversationStatus(threadId, 'error', 'action');
      this.host.emitConversationActivity(threadId, 'action');
      throw error;
    }
  }

  async steer(
    prompt: string,
    options: SendMessageOptions = {},
  ): Promise<CodexHostSnapshot> {
    const threadId = this.requiredActiveConversation();
    await this.steerForThread(threadId, prompt, options);
    return this.host.getSnapshot();
  }

  async steerForThread(
    threadId: string,
    prompt: string,
    options: SendMessageOptions = {},
    displayText?: string,
  ): Promise<void> {
    const runtime = await this.host.ensureThreadReady(threadId);
    const text = prompt.trim();
    const content = authoredPromptContent(options.content);
    const skillInputs = await this.validatedSkills(runtime, mergeSkillInputs(promptSkillInputsFromContent(content), options.skills ?? []));
    const visibleText = content ? promptContentText(content) : displayText?.trim() || text;
    if (!text) throw new Error('Cannot steer with an empty message');
    if (!runtime.activeTurnId) throw new Error('There is no active turn to steer');
    const attachments = validateAttachments(options.attachments ?? []);
    const messageId = createMessageId();
    const optimisticSteer: ConversationMessage = {
      id: messageId, kind: 'steer', role: 'user', status: 'complete',
      parts: [{ type: 'text', text: visibleText }, ...attachments.map(conversationAttachmentPart)],
      createdAt: new Date().toISOString(),
      turnId: runtime.activeTurnId,
      metadata: {
        conversationId: threadId,
        turnId: runtime.activeTurnId,
        ...(content ? { promptContent: content } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    };
    this.host.patchRuntime(threadId, {
      error: null,
      messages: ensureAssistantTurnMessage(
        [...runtime.messages, optimisticSteer], threadId, runtime.activeTurnId, { forceSegment: true },
      ),
    });
    this.host.emitEvent('action', {
      type: 'message.appended', conversationId: threadId, turnId: runtime.activeTurnId,
      payload: { message: structuredClone(optimisticSteer) },
    });
    try {
      const response = await this.client.request('turn/steer', {
        threadId,
        expectedTurnId: runtime.activeTurnId,
        clientUserMessageId: messageId,
        input: [
          { type: 'text', text: promptContentDispatchText(content ?? [], text), text_elements: [] },
          ...attachments.map(attachmentInput),
          ...promptMentionInputs(content),
          ...skillInputs.map(skill => ({ type: 'skill' as const, name: skill.name, path: skill.path })),
        ],
      });
      const wasKnownTurn = runtime.turnIds.includes(response.turnId);
      runtime.activeTurnId = response.turnId;
      if (!runtime.turnIds.includes(response.turnId)) runtime.turnIds.push(response.turnId);
      runtime.turns = upsertConversationTurn(runtime.turns, {
        id: response.turnId,
        status: 'inProgress',
        error: null,
        willRetry: false,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      });
      this.host.patchConversationTurnCount(threadId, runtime.turnIds.length, 'action');
      const steeredMessages = runtime.messages.map((message) => message.id === messageId
        ? { ...message, turnId: response.turnId, metadata: { ...message.metadata, turnId: response.turnId } }
        : message);
      this.host.patchRuntime(threadId, {
        messages: pruneEmptyAssistantPlaceholders(
          ensureAssistantTurnMessage(steeredMessages, threadId, response.turnId),
          threadId,
        ),
      });
      if (!wasKnownTurn) {
        this.host.emitEvent('action', {
          type: 'turn.started', conversationId: threadId, turnId: response.turnId,
          payload: { startedAt: new Date().toISOString() },
        });
      }
    } catch (error) {
      this.host.patchRuntime(threadId, { error: errorMessage(error) });
      throw error;
    }
  }

  async answerAsyncQuestion(threadId: string, prompt: string, displayText: string): Promise<void> {
    const runtime = await this.host.ensureThreadReady(threadId);
    if (runtime.activeTurnId) {
      await this.steerForThread(threadId, prompt, {}, displayText);
      return;
    }
    await this.sendPromptToThread(threadId, prompt, {}, displayText);
  }

  async deleteQueuedPrompt(promptId: string): Promise<CodexHostSnapshot> {
    const threadId = this.requiredActiveConversation();
    await this.deleteQueuedPromptForThread(threadId, promptId);
    return this.host.getSnapshot();
  }

  async deleteQueuedPromptForThread(threadId: string, promptId: string): Promise<void> {
    const runtime = await this.host.ensureThreadReady(threadId);
    const queuedPrompts = runtime.queuedPrompts.filter((prompt) => prompt.id !== promptId);
    if (queuedPrompts.length === runtime.queuedPrompts.length) {
      throw new Error(`Unknown queued prompt '${promptId}'`);
    }
    this.host.patchRuntime(runtime.threadId, { queuedPrompts });
    this.emitQueuedPrompts(runtime.threadId);
  }

  async updateQueuedPrompt(promptId: string, prompt: string, options?: SendMessageOptions): Promise<CodexHostSnapshot> {
    const threadId = this.requiredActiveConversation();
    await this.updateQueuedPromptForThread(threadId, promptId, prompt, options);
    return this.host.getSnapshot();
  }

  async updateQueuedPromptForThread(threadId: string, promptId: string, prompt: string, options?: SendMessageOptions): Promise<void> {
    const runtime = await this.host.ensureThreadReady(threadId);
    const text = prompt.trim();
    if (!text) throw new Error('Cannot update a queued prompt with empty content');
    const content = authoredPromptContent(options?.content);
    if (runtime.queuedPrompts.some(candidate => candidate.id === promptId)) {
      await this.validatedSkills(runtime, promptSkillInputsFromContent(content));
    }
    let found = false;
    const queuedPrompts = runtime.queuedPrompts.map((candidate) => {
      if (candidate.id !== promptId) return candidate;
      found = true;
      const nextOptions = { ...candidate.options, ...options };
      if (content) nextOptions.content = content;
      else delete nextOptions.content;
      return { ...candidate, text, options: nextOptions };
    });
    if (!found) throw new Error(`Unknown queued prompt '${promptId}'`);
    this.host.patchRuntime(runtime.threadId, { queuedPrompts });
    this.emitQueuedPrompts(runtime.threadId);
  }

  async steerQueuedPrompt(promptId: string, prompt?: string, options?: SendMessageOptions): Promise<CodexHostSnapshot> {
    const threadId = this.requiredActiveConversation();
    await this.steerQueuedPromptForThread(threadId, promptId, prompt, options);
    return this.host.getSnapshot();
  }

  async steerQueuedPromptForThread(threadId: string, promptId: string, replacement?: string, options?: SendMessageOptions): Promise<void> {
    const runtime = await this.host.ensureThreadReady(threadId);
    const prompt = runtime.queuedPrompts.find((candidate) => candidate.id === promptId);
    if (!prompt) throw new Error(`Unknown queued prompt '${promptId}'`);
    this.host.patchRuntime(runtime.threadId, {
      queuedPrompts: runtime.queuedPrompts.filter((candidate) => candidate.id !== promptId),
    });
    this.emitQueuedPrompts(runtime.threadId);
    const text = replacement ?? prompt.text;
    const sendOptions = replacement === undefined ? prompt.options : { ...prompt.options, ...options, content: options?.content };
    if (runtime.busy) await this.steerForThread(threadId, text, sendOptions);
    else await this.sendToThread(threadId, text, sendOptions);
  }

  async sendNextQueuedPrompt(threadId: string): Promise<void> {
    const runtime = this.host.requireRuntime(threadId);
    if (runtime.busy || runtime.queuedPrompts.length === 0) return;
    const next = runtime.queuedPrompts[0]!;
    const queuedPrompts = runtime.queuedPrompts.slice(1);
    this.host.patchRuntime(threadId, { queuedPrompts });
    this.emitQueuedPrompts(threadId, 'notification');
    try {
      await this.sendPromptToThread(threadId, next.text, next.options);
    } catch (error) {
      this.host.patchRuntime(threadId, {
        error: errorMessage(error), queuedPrompts: [next, ...runtime.queuedPrompts],
      });
      this.emitQueuedPrompts(threadId, 'notification');
    }
  }

  private emitQueuedPrompts(
    threadId: string,
    origin: HostEventOrigin = 'action',
  ): void {
    const queuedPrompts = this.host.requireRuntime(threadId).queuedPrompts;
    this.host.emitEvent(origin, {
      type: 'conversation.queueChanged',
      conversationId: threadId,
      payload: { queuedPrompts: structuredClone(queuedPrompts) },
    });
  }

  private requiredActiveConversation(): string {
    const threadId = this.host.getState().activeConversationId;
    if (!threadId) throw new Error('There is no active conversation');
    return threadId;
  }

  private async validatedSkills(runtime: ThreadRuntimeState, inputs: readonly SkillInput[]): Promise<SkillInput[]> {
    if (inputs.length > 0 && runtime.skillCatalogStatus !== 'loaded') await this.host.loadSkillsForThread(runtime.threadId);
    return validateSkillInputs(inputs, runtime.skills);
  }
}

function safetyFindingsKey(findings: ContinueCodexSafetyReviewOptions['findings']): string {
  return JSON.stringify([findings.errorType, findings.detailedExplanation, findings.steer?.message, findings.reviewTarget]);
}
