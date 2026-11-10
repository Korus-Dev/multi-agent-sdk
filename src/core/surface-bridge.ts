import { normalizePromptContent } from './prompt-content';
import type {
  CodexConversationEvent,
  CodexConversationHistory,
  CodexConversationHistoryPage,
  CodexConversationPromptHistory,
  CodexConversationSnapshot,
  CodexSurfaceApi,
  CodexSurfaceApprovalDecision,
  CodexSurfaceApprovalScope,
  CodexSurfaceAskUserAnswers,
  CodexSurfaceClientRequestResponse,
  CodexSurfaceJsonValue,
  CodexRendererAttachment,
  CodexRendererSendMessageOptions,
  CodexSurfaceAttachment,
  CodexSurfaceRendererApi,
  CreateCodexRendererConversationOptions,
  ListCodexConversationsOptions,
  ListCodexModelsOptions,
  ListCodexSkillsOptions,
  ReadCodexRateLimitsOptions,
  ConsumeCodexRateLimitResetCreditOptions,
  SendCodexMessageOptions,
  StartCodexReviewOptions,
  StartCodexLiveChatOptions,
  UpdateCodexConversationSettings,
} from './surface';

type RequiredRendererApi = Required<CodexSurfaceRendererApi>;
export type CodexSurfaceBridgeOperation = Exclude<
  keyof RequiredRendererApi,
  'onEvent' | 'onStateChange' | 'onStatePatch' | 'getVersionedSnapshot'
>;
type OperationFunction<Name extends CodexSurfaceBridgeOperation> = Extract<
  RequiredRendererApi[Name],
  (...args: never[]) => unknown
>;
export type CodexSurfaceBridgeOperationArguments<Name extends CodexSurfaceBridgeOperation> =
  Parameters<OperationFunction<Name>>;
export type CodexSurfaceBridgeOperationResult<Name extends CodexSurfaceBridgeOperation> =
  Awaited<ReturnType<OperationFunction<Name>>>;
type Awaitable<Value> = Value | Promise<Value>;
type SurfaceOperationFunction<Name extends CodexSurfaceBridgeOperation> = Name extends keyof Required<CodexSurfaceApi>
  ? Extract<Required<CodexSurfaceApi>[Name], (...args: never[]) => unknown>
  : never;
type OptionalAccountOperation = 'readRateLimits' | 'readAccountUsage' | 'consumeRateLimitResetCredit' | 'listSkills';
type BridgeOperationMethods = {
  [Name in CodexSurfaceBridgeOperation]: (
    ...args: Parameters<SurfaceOperationFunction<Name>>
  ) => Awaitable<Awaited<ReturnType<SurfaceOperationFunction<Name>>>>;
};
export type CodexSurfaceBridgeTarget = Omit<BridgeOperationMethods, OptionalAccountOperation>
  & Partial<Pick<BridgeOperationMethods, OptionalAccountOperation>>
  & Pick<CodexSurfaceApi, 'onEvent' | 'onStateChange'>;

export type CodexSurfaceBridgeAttachmentResolver = (
  attachment: CodexRendererAttachment,
) => Awaitable<CodexSurfaceAttachment>;

export type CodexSurfaceBridgeInvokeOptions = {
  operationLabel?: string;
  resolveAttachment?: CodexSurfaceBridgeAttachmentResolver;
};

type CodexConversationBridgeOperationFunctions = {
  clearGoal(): Awaitable<CodexConversationSnapshot>;
  compactConversation(): Awaitable<CodexConversationSnapshot>;
  continueInterruptedTurn(): Awaitable<CodexConversationSnapshot>;
  deleteTurn(turnId: string): Awaitable<CodexConversationSnapshot>;
  deleteQueuedPrompt(promptId: string): Awaitable<CodexConversationSnapshot>;
  editTurn(turnId: string, content: string, options?: CodexRendererSendMessageOptions): Awaitable<CodexConversationSnapshot>;
  forkTurn(turnId: string): Awaitable<CodexConversationSnapshot>;
  getSnapshot(): Awaitable<CodexConversationSnapshot>;
  interrupt(): Awaitable<CodexConversationSnapshot>;
  loadOlderConversationHistory(): Awaitable<CodexConversationHistoryPage>;
  loadTurnHistory(turnId: string): Awaitable<CodexConversationSnapshot>;
  readConversationHistory(): Awaitable<CodexConversationHistory>;
  readConversationPromptHistory(): Awaitable<CodexConversationPromptHistory>;
  renameConversation(title: string): Awaitable<CodexConversationSnapshot>;
  respondToClientRequest(response: CodexSurfaceClientRequestResponse): Awaitable<CodexConversationSnapshot>;
  resolveApproval(
    approvalId: string,
    decision: CodexSurfaceApprovalDecision,
    scope?: CodexSurfaceApprovalScope,
  ): Awaitable<CodexConversationSnapshot>;
  retryTurn(turnId: string): Awaitable<CodexConversationSnapshot>;
  sendMessage(prompt: string, options?: CodexRendererSendMessageOptions): Awaitable<CodexConversationSnapshot>;
  setGoal(objective: string, tokenBudget?: number | null): Awaitable<CodexConversationSnapshot>;
  startReview(options?: StartCodexReviewOptions): Awaitable<CodexConversationSnapshot>;
  steerMessage(prompt: string, options?: CodexRendererSendMessageOptions): Awaitable<CodexConversationSnapshot>;
  steerQueuedPrompt(promptId: string, prompt?: string, options?: SendCodexMessageOptions): Awaitable<CodexConversationSnapshot>;
  updateConversationSettings(settings: UpdateCodexConversationSettings): Awaitable<CodexConversationSnapshot>;
  updateQueuedPrompt(promptId: string, prompt: string, options?: SendCodexMessageOptions): Awaitable<CodexConversationSnapshot>;
};

export const codexConversationBridgeOperations = [
  'clearGoal', 'compactConversation', 'continueInterruptedTurn', 'deleteTurn', 'deleteQueuedPrompt', 'editTurn',
  'forkTurn', 'getSnapshot', 'interrupt', 'loadOlderConversationHistory', 'loadTurnHistory',
  'readConversationHistory', 'readConversationPromptHistory', 'renameConversation',
  'respondToClientRequest', 'resolveApproval', 'retryTurn', 'sendMessage', 'setGoal',
  'startReview', 'steerMessage', 'steerQueuedPrompt', 'updateConversationSettings',
  'updateQueuedPrompt',
] as const satisfies readonly (keyof CodexConversationBridgeOperationFunctions)[];

export type CodexConversationBridgeOperation = typeof codexConversationBridgeOperations[number];
export type CodexConversationBridgeOperationArguments<Name extends CodexConversationBridgeOperation> =
  Parameters<CodexConversationBridgeOperationFunctions[Name]>;
export type CodexConversationBridgeOperationResult<Name extends CodexConversationBridgeOperation> =
  Awaited<ReturnType<CodexConversationBridgeOperationFunctions[Name]>>;

export type CodexConversationBridgeHandle = {
  clearGoal(): Awaitable<CodexConversationSnapshot>;
  compact(): Awaitable<CodexConversationSnapshot>;
  continueInterruptedTurn(): Awaitable<CodexConversationSnapshot>;
  deleteTurn(turnId: string): Awaitable<CodexConversationSnapshot>;
  deleteQueuedPrompt(promptId: string): Awaitable<CodexConversationSnapshot>;
  editTurn(turnId: string, content: string, options?: SendCodexMessageOptions): Awaitable<CodexConversationSnapshot>;
  forkTurn(turnId: string): Awaitable<{ snapshot: CodexConversationSnapshot }>;
  getSnapshot(): CodexConversationSnapshot;
  interrupt(): Awaitable<CodexConversationSnapshot>;
  loadOlderHistory(): Awaitable<CodexConversationHistoryPage>;
  loadTurnHistory?(turnId: string): Awaitable<CodexConversationSnapshot>;
  onEvent(listener: (event: CodexConversationEvent) => void): () => void;
  onStateChange(listener: (snapshot: CodexConversationSnapshot) => void): () => void;
  readHistory(): Awaitable<CodexConversationHistory>;
  readPromptHistory(): Awaitable<CodexConversationPromptHistory>;
  rename(title: string): Awaitable<CodexConversationSnapshot>;
  respondToClientRequest(response: CodexSurfaceClientRequestResponse): Awaitable<CodexConversationSnapshot>;
  resolveApproval(
    approvalId: string,
    decision: CodexSurfaceApprovalDecision,
    scope?: CodexSurfaceApprovalScope,
  ): Awaitable<CodexConversationSnapshot>;
  retryTurn(turnId: string): Awaitable<CodexConversationSnapshot>;
  sendMessage(prompt: string, options?: SendCodexMessageOptions): Awaitable<CodexConversationSnapshot>;
  setGoal(objective: string, tokenBudget?: number | null): Awaitable<CodexConversationSnapshot>;
  startReview(options?: StartCodexReviewOptions): Awaitable<CodexConversationSnapshot>;
  steerMessage(prompt: string, options?: SendCodexMessageOptions): Awaitable<CodexConversationSnapshot>;
  steerQueuedPrompt(promptId: string, prompt?: string, options?: SendCodexMessageOptions): Awaitable<CodexConversationSnapshot>;
  updateQueuedPrompt(promptId: string, prompt: string, options?: SendCodexMessageOptions): Awaitable<CodexConversationSnapshot>;
  updateSettings(settings: UpdateCodexConversationSettings): Awaitable<CodexConversationSnapshot>;
};

export type CodexConversationBridgeTarget = {
  conversation(conversationId: string): CodexConversationBridgeHandle;
};

export type CodexConversationBridgeNotification =
  | {
    type: 'snapshot';
    conversationId: string;
    snapshot: CodexConversationSnapshot;
  }
  | {
    type: 'event';
    conversationId: string;
    event: CodexConversationEvent;
  };

const conversationOperationSet = new Set<string>(codexConversationBridgeOperations);

export function isCodexConversationBridgeOperation(value: unknown): value is CodexConversationBridgeOperation {
  return typeof value === 'string' && conversationOperationSet.has(value);
}

export async function invokeCodexConversationBridgeOperation<Name extends CodexConversationBridgeOperation>(
  target: CodexConversationBridgeTarget,
  conversationId: string,
  operation: Name,
  args: readonly unknown[],
  options: CodexSurfaceBridgeInvokeOptions = {},
): Promise<CodexConversationBridgeOperationResult<Name>> {
  const id = nonEmptyString(conversationId, 'Conversation id');
  const [minimum, maximum] = conversationArities[operation];
  if (args.length < minimum || args.length > maximum) {
    throw new TypeError(`${options.operationLabel ?? operation} received an invalid number of arguments`);
  }
  const conversation = target.conversation(id);
  const bridgeTarget = conversationOperationTarget(conversation);
  const result = await invokeCodexSurfaceBridgeOperation(bridgeTarget, operation, args, options);
  return result as CodexConversationBridgeOperationResult<Name>;
}

export function subscribeCodexConversationBridge(
  target: CodexConversationBridgeTarget,
  conversationId: string,
  listener: (notification: CodexConversationBridgeNotification) => void,
): () => void {
  const id = nonEmptyString(conversationId, 'Conversation id');
  const conversation = target.conversation(id);
  const emitSnapshot = (snapshot: CodexConversationSnapshot) => {
    if (snapshot.activeConversationId === id) {
      listener({ type: 'snapshot', conversationId: id, snapshot });
    }
  };
  const emitEvent = (event: CodexConversationEvent) => {
    if (event.conversationId === id) listener({ type: 'event', conversationId: id, event });
  };
  const unsubscribeState = conversation.onStateChange(emitSnapshot);
  let unsubscribeEvent: () => void;
  try {
    unsubscribeEvent = conversation.onEvent(emitEvent);
  } catch (error) {
    unsubscribeState();
    throw error;
  }
  return () => {
    unsubscribeEvent();
    unsubscribeState();
  };
}

/**
 * Emits exactly one targeted snapshot followed by semantic conversation events.
 * Events raised while the initial snapshot is captured are buffered so consumers
 * can always initialize a replica before applying deltas.
 */
export function subscribeCodexConversationReplicaBridge(
  target: CodexConversationBridgeTarget,
  conversationId: string,
  listener: (notification: CodexConversationBridgeNotification) => void,
): () => void {
  const id = nonEmptyString(conversationId, 'Conversation id');
  const conversation = target.conversation(id);
  const pending: CodexConversationEvent[] = [];
  let initialized = false;
  const unsubscribe = conversation.onEvent((event) => {
    if (event.conversationId !== id) return;
    if (!initialized) pending.push(event);
    else listener({ type: 'event', conversationId: id, event });
  });
  try {
    const snapshot = conversation.getSnapshot();
    if (snapshot.activeConversationId !== id) {
      throw new Error(
        `Snapshot belongs to '${snapshot.activeConversationId}', not bridge conversation '${id}'`,
      );
    }
    listener({ type: 'snapshot', conversationId: id, snapshot });
    initialized = true;
    for (const event of pending) listener({ type: 'event', conversationId: id, event });
    pending.length = 0;
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return unsubscribe;
}

export const codexSurfaceBridgeOperations = [
  'archiveConversation', 'cancelLogin', 'clearGoal', 'compactConversation', 'connect',
  'continueInterruptedTurn', 'createConversation', 'deleteConversation', 'deleteTurn', 'deleteQueuedPrompt',
  'editTurn', 'forkTurn', 'getSnapshot', 'interrupt', 'listConversations',
  'listModels', 'listSkills', 'loadOlderConversationHistory', 'loadTurnHistory', 'logout', 'readConversationHistory',
  'readConversationPromptHistory', 'refreshAccount', 'refreshConversations', 'renameConversation', 'respondToClientRequest',
  'resolveApproval', 'retryTurn', 'selectConversation', 'sendMessage', 'setGoal',
  'startChatGptDeviceCodeLogin', 'startChatGptLogin', 'startReview', 'steerMessage', 'steerQueuedPrompt',
  'unarchiveConversation', 'updateConversationSettings', 'updateQueuedPrompt',
  'startLiveChat', 'stopLiveChat',
  'readRateLimits',
  'readAccountUsage',
  'consumeRateLimitResetCredit',
] as const satisfies readonly CodexSurfaceBridgeOperation[];

const operationSet = new Set<string>(codexSurfaceBridgeOperations);
export const codexSurfaceBridgeArities: Readonly<
  Record<CodexSurfaceBridgeOperation, readonly [minimum: number, maximum: number]>
> = {
  startLiveChat: [2, 2], stopLiveChat: [1, 1],
  archiveConversation: [1, 1], cancelLogin: [0, 1], clearGoal: [0, 0],
  compactConversation: [0, 0], connect: [0, 0], continueInterruptedTurn: [0, 0], createConversation: [0, 1],
  deleteConversation: [1, 1], deleteTurn: [1, 1], deleteQueuedPrompt: [1, 1],
  editTurn: [2, 3], forkTurn: [1, 1], getSnapshot: [0, 0], interrupt: [0, 0],
  listConversations: [0, 1], listModels: [0, 1], listSkills: [0, 1], loadOlderConversationHistory: [0, 1], loadTurnHistory: [1, 2],
  logout: [0, 0], readConversationHistory: [0, 1], readConversationPromptHistory: [0, 1],
  refreshAccount: [0, 0],
  readRateLimits: [0, 1],
  readAccountUsage: [0, 0],
  consumeRateLimitResetCredit: [1, 1],
  refreshConversations: [0, 0], renameConversation: [1, 1], respondToClientRequest: [1, 1],
  resolveApproval: [2, 3], retryTurn: [1, 1], selectConversation: [1, 1],
  sendMessage: [1, 2], setGoal: [1, 2], startChatGptDeviceCodeLogin: [0, 0],
  startChatGptLogin: [0, 0], startReview: [0, 1],
  steerMessage: [1, 2], steerQueuedPrompt: [1, 3], unarchiveConversation: [1, 1],
  updateConversationSettings: [1, 1], updateQueuedPrompt: [2, 3],
};

const conversationArities: Readonly<
  Record<CodexConversationBridgeOperation, readonly [minimum: number, maximum: number]>
> = {
  clearGoal: [0, 0], compactConversation: [0, 0], continueInterruptedTurn: [0, 0], deleteTurn: [1, 1],
  deleteQueuedPrompt: [1, 1], editTurn: [2, 3], forkTurn: [1, 1], getSnapshot: [0, 0],
  interrupt: [0, 0], loadOlderConversationHistory: [0, 0], loadTurnHistory: [1, 1], readConversationHistory: [0, 0],
  readConversationPromptHistory: [0, 0], renameConversation: [1, 1], respondToClientRequest: [1, 1],
  resolveApproval: [2, 3], retryTurn: [1, 1], sendMessage: [1, 2], setGoal: [1, 2],
  startReview: [0, 1], steerMessage: [1, 2], steerQueuedPrompt: [1, 3],
  updateConversationSettings: [1, 1], updateQueuedPrompt: [2, 3],
};

export function isCodexSurfaceBridgeOperation(value: unknown): value is CodexSurfaceBridgeOperation {
  return typeof value === 'string' && operationSet.has(value);
}

export async function invokeCodexSurfaceBridgeOperation<Name extends CodexSurfaceBridgeOperation>(
  target: CodexSurfaceBridgeTarget,
  operation: Name,
  args: readonly unknown[],
  options: CodexSurfaceBridgeInvokeOptions = {},
): Promise<CodexSurfaceBridgeOperationResult<Name>> {
  const [minimum, maximum] = codexSurfaceBridgeArities[operation];
  if (args.length < minimum || args.length > maximum) {
    throw new TypeError(`${options.operationLabel ?? operation} received an invalid number of arguments`);
  }
  const result = await invokeValidated(target, operation, args, options);
  return result as CodexSurfaceBridgeOperationResult<Name>;
}

function conversationOperationTarget(conversation: CodexConversationBridgeHandle): CodexSurfaceBridgeTarget {
  const target: Pick<CodexSurfaceBridgeTarget, CodexConversationBridgeOperation> = {
    clearGoal: () => conversation.clearGoal(),
    compactConversation: () => conversation.compact(),
    continueInterruptedTurn: () => conversation.continueInterruptedTurn(),
    deleteTurn: (turnId) => conversation.deleteTurn(turnId),
    deleteQueuedPrompt: (promptId) => conversation.deleteQueuedPrompt(promptId),
    editTurn: (turnId, content, options) => conversation.editTurn(turnId, content, options),
    forkTurn: async (turnId) => (await conversation.forkTurn(turnId)).snapshot,
    getSnapshot: () => conversation.getSnapshot(),
    interrupt: () => conversation.interrupt(),
    loadOlderConversationHistory: () => conversation.loadOlderHistory(),
    loadTurnHistory: (turnId) => conversation.loadTurnHistory?.(turnId) ?? Promise.reject(new Error('Turn history is unavailable.')),
    readConversationHistory: () => conversation.readHistory(),
    readConversationPromptHistory: () => conversation.readPromptHistory(),
    renameConversation: (title) => conversation.rename(title),
    respondToClientRequest: (response) => conversation.respondToClientRequest(response),
    resolveApproval: (approvalId, decision, scope) => conversation.resolveApproval(approvalId, decision, scope),
    retryTurn: (turnId) => conversation.retryTurn(turnId),
    sendMessage: (prompt, options) => conversation.sendMessage(prompt, options),
    setGoal: (objective, tokenBudget) => conversation.setGoal(objective, tokenBudget),
    startReview: (options) => conversation.startReview(options),
    steerMessage: (prompt, options) => conversation.steerMessage(prompt, options),
    steerQueuedPrompt: (promptId, prompt, options) => conversation.steerQueuedPrompt(promptId, prompt, options),
    updateConversationSettings: (settings) => conversation.updateSettings(settings),
    updateQueuedPrompt: (promptId, prompt, options) => conversation.updateQueuedPrompt(promptId, prompt, options),
  };
  return target as unknown as CodexSurfaceBridgeTarget;
}

async function invokeValidated(
  target: CodexSurfaceBridgeTarget,
  operation: CodexSurfaceBridgeOperation,
  args: readonly unknown[],
  options: CodexSurfaceBridgeInvokeOptions,
): Promise<unknown> {
  switch (operation) {
    case 'startLiveChat': return target.startLiveChat(
      nonEmptyString(args[0], 'Conversation id'), liveChatOptions(args[1]),
    );
    case 'stopLiveChat': return target.stopLiveChat(nonEmptyString(args[0], 'Conversation id'));
    case 'archiveConversation': return target.archiveConversation(nonEmptyString(args[0], 'Conversation id'));
    case 'cancelLogin': return target.cancelLogin(optionalString(args[0], 'Login id'));
    case 'clearGoal': return target.clearGoal();
    case 'compactConversation': return target.compactConversation();
    case 'connect': return target.connect();
    case 'continueInterruptedTurn': return target.continueInterruptedTurn();
    case 'createConversation': return target.createConversation(conversationOptions(args[0]));
    case 'deleteConversation': return target.deleteConversation(nonEmptyString(args[0], 'Conversation id'));
    case 'deleteTurn': return target.deleteTurn(nonEmptyString(args[0], 'Turn id'));
    case 'deleteQueuedPrompt': return target.deleteQueuedPrompt(nonEmptyString(args[0], 'Queued prompt id'));
    case 'editTurn': return target.editTurn(nonEmptyString(args[0], 'Turn id'), nonEmptyString(args[1], 'Turn content'), await sendOptions(args[2], options.resolveAttachment));
    case 'forkTurn': return target.forkTurn(nonEmptyString(args[0], 'Turn id'));
    case 'getSnapshot': return target.getSnapshot();
    case 'interrupt': return target.interrupt();
    case 'listConversations': return target.listConversations(listConversationOptions(args[0]));
    case 'listModels': return target.listModels(listModelOptions(args[0]));
    case 'listSkills': {
      if (!target.listSkills) throw new Error('Skill discovery is unavailable');
      return target.listSkills(listSkillOptions(args[0]));
    }
    case 'loadTurnHistory': {
      if (!target.loadTurnHistory) throw new Error('Turn history is unavailable.');
      return target.loadTurnHistory(nonEmptyString(args[0], 'Turn id'), optionalString(args[1], 'Conversation id'));
    }
    case 'loadOlderConversationHistory': return target.loadOlderConversationHistory(optionalString(args[0], 'Conversation id'));
    case 'logout': return target.logout();
    case 'readConversationHistory': return target.readConversationHistory(optionalString(args[0], 'Conversation id'));
    case 'readConversationPromptHistory': return target.readConversationPromptHistory(
      optionalString(args[0], 'Conversation id'),
    );
    case 'refreshAccount': return target.refreshAccount();
    case 'readRateLimits': {
      const options = rateLimitsOptions(args[0]);
      if (!target.readRateLimits) throw new Error('Account rate-limit reads are not available.');
      return target.readRateLimits(options);
    }
    case 'readAccountUsage': {
      if (!target.readAccountUsage) throw new Error('Account usage reads are not available.');
      return target.readAccountUsage();
    }
    case 'consumeRateLimitResetCredit': {
      const options = resetCreditOptions(args[0]);
      if (!target.consumeRateLimitResetCredit) throw new Error('Rate-limit reset credits are not available.');
      return target.consumeRateLimitResetCredit(options);
    }
    case 'refreshConversations': return target.refreshConversations();
    case 'renameConversation': return target.renameConversation(nonEmptyString(args[0], 'Conversation title'));
    case 'respondToClientRequest': return target.respondToClientRequest(clientRequestResponse(args[0]));
    case 'resolveApproval': return target.resolveApproval(
      nonEmptyString(args[0], 'Approval id'), approvalDecision(args[1]), approvalScope(args[2]),
    );
    case 'retryTurn': return target.retryTurn(nonEmptyString(args[0], 'Turn id'));
    case 'selectConversation': return target.selectConversation(nonEmptyString(args[0], 'Conversation id'));
    case 'sendMessage': return target.sendMessage(
      nonEmptyString(args[0], 'Message prompt'),
      await sendOptions(args[1], options.resolveAttachment),
    );
    case 'setGoal': return target.setGoal(nonEmptyString(args[0], 'Goal objective'), tokenBudget(args[1]));
    case 'startChatGptDeviceCodeLogin': return target.startChatGptDeviceCodeLogin();
    case 'startChatGptLogin': return target.startChatGptLogin();
    case 'startReview': return target.startReview(reviewOptions(args[0]));
    case 'steerMessage': return target.steerMessage(
      nonEmptyString(args[0], 'Steer prompt'),
      await sendOptions(args[1], options.resolveAttachment),
    );
    case 'steerQueuedPrompt': return target.steerQueuedPrompt(
      nonEmptyString(args[0], 'Queued prompt id'),
      optionalString(args[1], 'Queued prompt'),
      await sendOptions(args[2], options.resolveAttachment),
    );
    case 'unarchiveConversation': return target.unarchiveConversation(nonEmptyString(args[0], 'Conversation id'));
    case 'updateConversationSettings': return target.updateConversationSettings(settings(args[0]));
    case 'updateQueuedPrompt': return target.updateQueuedPrompt(
      nonEmptyString(args[0], 'Queued prompt id'), nonEmptyString(args[1], 'Queued prompt'),
      await sendOptions(args[2], options.resolveAttachment),
    );
  }
}

function liveChatOptions(value: unknown): StartCodexLiveChatOptions {
  const record = plainObject(value, 'Live chat options');
  onlyKeys(record, ['sdp', 'version', 'voice', 'model', 'prompt', 'includeStartupContext', 'flushTranscriptTailOnSessionEnd'], 'Live chat options');
  const result: StartCodexLiveChatOptions = { sdp: nonEmptyString(record.sdp, 'SDP offer') };
  if (record.version !== undefined) {
    if (record.version !== 'v1' && record.version !== 'v2' && record.version !== 'v3') throw new TypeError('Invalid realtime version');
    result.version = record.version;
  }
  for (const key of ['voice', 'model'] as const) {
    if (record[key] !== undefined) result[key] = nonEmptyString(record[key], key);
  }
  if (record.prompt !== undefined) {
    if (record.prompt !== null && typeof record.prompt !== 'string') throw new TypeError('Prompt must be a string or null');
    result.prompt = record.prompt;
  }
  for (const key of ['includeStartupContext', 'flushTranscriptTailOnSessionEnd'] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== 'boolean') throw new TypeError(`${key} must be a boolean`);
      result[key] = record[key];
    }
  }
  return result;
}

function conversationOptions(value: unknown): CreateCodexRendererConversationOptions | undefined {
  if (value === undefined) return undefined;
  const record = plainObject(value, 'Conversation options');
  onlyKeys(record, ['model', 'reasoningEffort', 'serviceTier', 'approvalPreset'], 'Conversation options');
  return {
    ...(record.model === undefined ? {} : { model: nonEmptyString(record.model, 'Conversation model') }),
    ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: nonEmptyString(record.reasoningEffort, 'Conversation reasoning effort') }),
    ...(record.serviceTier === undefined ? {} : { serviceTier: nullableString(record.serviceTier, 'Conversation service tier') }),
    ...(record.approvalPreset === undefined ? {} : { approvalPreset: approvalPreset(record.approvalPreset) }),
  };
}

function listConversationOptions(value: unknown): ListCodexConversationsOptions | undefined {
  if (value === undefined) return undefined;
  const record = plainObject(value, 'Conversation list options');
  onlyKeys(record, ['archived', 'cwd', 'limit', 'searchTerm'], 'Conversation list options');
  if (record.archived !== undefined && typeof record.archived !== 'boolean') {
    throw new TypeError('Conversation list archived flag must be a boolean');
  }
  if (record.limit !== undefined && (!Number.isInteger(record.limit) || (record.limit as number) < 0)) {
    throw new TypeError('Conversation list limit must be a non-negative integer');
  }
  const cwd = record.cwd === undefined ? undefined : Array.isArray(record.cwd)
    ? record.cwd.map((entry) => nonEmptyString(entry, 'Conversation list cwd'))
    : nonEmptyString(record.cwd, 'Conversation list cwd');
  return {
    ...(record.archived === undefined ? {} : { archived: record.archived }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(record.limit === undefined ? {} : { limit: record.limit as number }),
    ...(record.searchTerm === undefined ? {} : { searchTerm: nonEmptyString(record.searchTerm, 'Conversation list search term') }),
  };
}

function rateLimitsOptions(value: unknown): ReadCodexRateLimitsOptions | undefined {
  if (value === undefined) return undefined;
  const record = plainObject(value, 'Rate-limit read options');
  onlyKeys(record, ['excludeResetCreditDetails'], 'Rate-limit read options');
  return record.excludeResetCreditDetails === undefined ? {} : {
    excludeResetCreditDetails: booleanValue(record.excludeResetCreditDetails, 'Exclude reset credit details'),
  };
}

function resetCreditOptions(value: unknown): ConsumeCodexRateLimitResetCreditOptions {
  const record = plainObject(value, 'Reset-credit options');
  onlyKeys(record, ['idempotencyKey', 'creditId'], 'Reset-credit options');
  return {
    idempotencyKey: nonEmptyString(record.idempotencyKey, 'Reset-credit idempotency key'),
    ...(record.creditId === undefined ? {} : { creditId: nonEmptyString(record.creditId, 'Reset credit id') }),
  };
}

function listModelOptions(value: unknown): ListCodexModelsOptions | undefined {
  if (value === undefined) return undefined;
  const record = plainObject(value, 'Model list options');
  onlyKeys(record, ['includeHidden', 'forceReload'], 'Model list options');
  return {
    ...(record.includeHidden === undefined ? {} : { includeHidden: booleanValue(record.includeHidden, 'Model list includeHidden') }),
    ...(record.forceReload === undefined ? {} : { forceReload: booleanValue(record.forceReload, 'Model list forceReload') }),
  };
}

function listSkillOptions(value: unknown): ListCodexSkillsOptions | undefined {
  if (value === undefined) return undefined;
  const record = plainObject(value, 'Skill list options');
  onlyKeys(record, ['cwd', 'forceReload'], 'Skill list options');
  return {
    ...(record.cwd === undefined ? {} : { cwd: nonEmptyString(record.cwd, 'Skill list cwd') }),
    ...(record.forceReload === undefined ? {} : { forceReload: booleanValue(record.forceReload, 'Skill list forceReload') }),
  };
}

function settings(value: unknown): UpdateCodexConversationSettings {
  const record = plainObject(value, 'Conversation settings');
  onlyKeys(record, ['modelId', 'reasoningEffort', 'serviceTier', 'approvalPreset', 'planMode'], 'Conversation settings');
  return {
    ...(record.modelId === undefined ? {} : { modelId: nonEmptyString(record.modelId, 'Conversation model id') }),
    ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: nonEmptyString(record.reasoningEffort, 'Conversation reasoning effort') }),
    ...(record.serviceTier === undefined ? {} : { serviceTier: nullableString(record.serviceTier, 'Conversation service tier') }),
    ...(record.approvalPreset === undefined ? {} : { approvalPreset: approvalPreset(record.approvalPreset) }),
    ...(record.planMode === undefined ? {} : { planMode: booleanValue(record.planMode, 'Conversation plan mode') }),
  };
}

function clientRequestResponse(value: unknown): CodexSurfaceClientRequestResponse {
  const record = plainObject(value, 'Client request response');
  onlyKeys(record, ['id', 'payload'], 'Client request response');
  const id = nonEmptyString(record.id, 'Client request id');
  if (record.payload === undefined) return { id };
  const payload = plainObject(record.payload, 'Client request response payload');
  onlyKeys(payload, ['answers', 'cancelled', 'decision'], 'Client request response payload');
  const decision = payload.decision;
  const validDecisions = [null, 'allow', 'allow_conversation', 'always_allow', 'deny'];
  if (decision !== undefined && !validDecisions.includes(decision as string | null)) {
    throw new TypeError('Client request decision is invalid');
  }
  const answers = payload.answers === undefined ? undefined : askUserAnswers(payload.answers);
  return {
    id,
    payload: {
      ...(answers === undefined ? {} : { answers }),
      ...(payload.cancelled === undefined ? {} : { cancelled: booleanValue(payload.cancelled, 'Client request cancelled flag') }),
      ...(decision === undefined ? {} : { decision: decision as NonNullable<CodexSurfaceClientRequestResponse['payload']>['decision'] }),
    },
  };
}

function askUserAnswers(value: unknown): CodexSurfaceAskUserAnswers {
  const record = plainObject(value, 'Client request answers');
  const answers: CodexSurfaceAskUserAnswers = {};
  for (const [questionId, rawAnswer] of Object.entries(record)) {
    if (!questionId.trim()) throw new TypeError('Client request question id must be non-empty');
    const answer = plainObject(rawAnswer, 'Client request answer');
    onlyKeys(answer, ['answers'], 'Client request answer');
    if (!Array.isArray(answer.answers) || !answer.answers.every((item) => typeof item === 'string')) {
      throw new TypeError('Client request answer values must be an array of strings');
    }
    answers[questionId] = { answers: [...answer.answers] };
  }
  return answers;
}

async function sendOptions(
  value: unknown,
  resolveAttachment: CodexSurfaceBridgeAttachmentResolver | undefined,
): Promise<SendCodexMessageOptions | undefined> {
  if (value === undefined) return undefined;
  const record = plainObject(value, 'Message options');
  onlyKeys(record, ['content', 'inputMethod', 'attachments', 'model', 'reasoningEffort', 'serviceTier', 'planMode', 'skills', 'outputSchema'], 'Message options');
  const attachments = record.attachments === undefined
    ? undefined
    : await attachmentInputs(record.attachments, resolveAttachment);
  const skills = record.skills === undefined ? undefined : skillInputs(record.skills);
  const inputMethod = record.inputMethod;
  if (inputMethod !== undefined && inputMethod !== 'typed' && inputMethod !== 'dictated') {
    throw new TypeError('Message input method must be typed or dictated');
  }
  if (record.outputSchema !== undefined && !isJsonValue(record.outputSchema)) {
    throw new TypeError('Message output schema must be JSON-serializable');
  }
  return {
    ...(record.content === undefined ? {} : { content: normalizePromptContent(record.content) }),
    ...(inputMethod === undefined ? {} : { inputMethod }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(record.model === undefined ? {} : { model: nonEmptyString(record.model, 'Message model') }),
    ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: nonEmptyString(record.reasoningEffort, 'Message reasoning effort') }),
    ...(record.serviceTier === undefined ? {} : { serviceTier: nullableString(record.serviceTier, 'Message service tier') }),
    ...(record.planMode === undefined ? {} : { planMode: booleanValue(record.planMode, 'Message plan mode') }),
    ...(skills === undefined ? {} : { skills }),
    ...(record.outputSchema === undefined ? {} : { outputSchema: record.outputSchema }),
  };
}

async function attachmentInputs(
  value: unknown,
  resolveAttachment: CodexSurfaceBridgeAttachmentResolver | undefined,
): Promise<NonNullable<SendCodexMessageOptions['attachments']>> {
  if (!Array.isArray(value)) throw new TypeError('Message attachments must be an array');
  if (value.length > 0 && !resolveAttachment) {
    throw new TypeError('Message attachment references are not supported by this host');
  }
  return Promise.all(value.map(async (rawAttachment) => {
    const attachment = plainObject(rawAttachment, 'Message attachment');
    if (attachment.type !== 'image' && attachment.type !== 'file') {
      throw new TypeError('Message attachment type is invalid');
    }
    const image = attachment.type === 'image';
    onlyKeys(
      attachment,
      image ? ['type', 'reference', 'detail'] : ['type', 'reference'],
      'Message attachment',
    );
    if (image && attachment.detail !== undefined && !['auto', 'low', 'high', 'original'].includes(String(attachment.detail))) {
      throw new TypeError('Message image detail is invalid');
    }
    const rendererAttachment: CodexRendererAttachment = image ? {
      type: 'image' as const,
      reference: nonEmptyString(attachment.reference, 'Message attachment reference'),
      ...(attachment.detail === undefined ? {} : { detail: attachment.detail as 'auto' | 'low' | 'high' | 'original' }),
    } : {
      type: 'file' as const,
      reference: nonEmptyString(attachment.reference, 'Message attachment reference'),
    };
    const resolved = await resolveAttachment!(rendererAttachment);
    return resolvedAttachment(resolved, rendererAttachment);
  }));
}

function resolvedAttachment(
  value: CodexSurfaceAttachment,
  source: CodexRendererAttachment,
): CodexSurfaceAttachment {
  const attachment = plainObject(value, 'Resolved message attachment');
  if (attachment.type !== source.type) throw new TypeError('Resolved message attachment type does not match');
  const common = {
    path: nonEmptyString(attachment.path, 'Resolved message attachment path'),
    ...(attachment.name === undefined ? {} : { name: displayString(attachment.name, 'Resolved message attachment name') }),
    ...(attachment.mimeType === undefined ? {} : { mimeType: displayString(attachment.mimeType, 'Resolved message attachment MIME type') }),
  };
  return source.type === 'image' ? {
    type: 'image',
    ...common,
    ...(source.detail === undefined ? {} : { detail: source.detail }),
    ...(attachment.previewUrl === undefined
      ? {}
      : { previewUrl: imagePreviewUrl(attachment.previewUrl) }),
  } : { type: 'file', ...common };
}

function skillInputs(value: unknown): NonNullable<SendCodexMessageOptions['skills']> {
  if (!Array.isArray(value)) throw new TypeError('Message skills must be an array');
  return value.map((rawSkill) => {
    const skill = plainObject(rawSkill, 'Message skill');
    onlyKeys(skill, ['name', 'path'], 'Message skill');
    return { name: nonEmptyString(skill.name, 'Message skill name'), path: nonEmptyString(skill.path, 'Message skill path') };
  });
}

function reviewOptions(value: unknown): StartCodexReviewOptions | undefined {
  if (value === undefined) return undefined;
  const record = plainObject(value, 'Review options');
  onlyKeys(record, ['target'], 'Review options');
  if (record.target === undefined) return {};
  const target = plainObject(record.target, 'Review target');
  if (target.type === 'uncommittedChanges') {
    onlyKeys(target, ['type'], 'Review target');
    return { target: { type: 'uncommittedChanges' } };
  }
  if (target.type === 'baseBranch') {
    onlyKeys(target, ['type', 'branch'], 'Review target');
    return { target: { type: 'baseBranch', branch: nonEmptyString(target.branch, 'Review branch') } };
  }
  if (target.type === 'commit') {
    onlyKeys(target, ['type', 'sha', 'title'], 'Review target');
    if (target.title !== undefined && target.title !== null && typeof target.title !== 'string') {
      throw new TypeError('Review commit title must be a string or null');
    }
    return { target: { type: 'commit', sha: nonEmptyString(target.sha, 'Review commit SHA'), ...(target.title === undefined ? {} : { title: target.title }) } };
  }
  if (target.type === 'custom') {
    onlyKeys(target, ['type', 'instructions'], 'Review target');
    return { target: { type: 'custom', instructions: nonEmptyString(target.instructions, 'Review instructions') } };
  }
  throw new TypeError('Review target type is invalid');
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
  if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) throw new TypeError(`${label} must not contain symbol properties`);
  return value as Record<string, unknown>;
}

function onlyKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unknownKey = Object.getOwnPropertyNames(record).find((key) => !allowed.has(key));
  if (unknownKey) throw new TypeError(`${label} contains unsupported property "${unknownKey}"`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, label);
}
function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : nonEmptyString(value, label);
}
function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}
function approvalDecision(value: unknown): CodexSurfaceApprovalDecision {
  if (value !== 'approve' && value !== 'deny') throw new TypeError('Approval decision is invalid');
  return value;
}
function approvalScope(value: unknown): CodexSurfaceApprovalScope | undefined {
  if (value === undefined) return undefined;
  if (value !== 'once' && value !== 'session') throw new TypeError('Approval scope is invalid');
  return value;
}
function approvalPreset(value: unknown): UpdateCodexConversationSettings['approvalPreset'] {
  if (!['ask-for-approval', 'approve-for-me', 'full-access'].includes(String(value))) {
    throw new TypeError('Conversation approval preset is invalid');
  }
  return value as UpdateCodexConversationSettings['approvalPreset'];
}
function tokenBudget(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError('Goal token budget must be a positive number or null');
  }
  return value;
}
function displayString(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (result.length > 1_024) throw new RangeError(`${label} is too long`);
  return result;
}
function imagePreviewUrl(value: unknown): string {
  if (typeof value !== 'string'
    || value.length > 16 * 1024 * 1024
    || !/^data:image\/(?:avif|bmp|gif|heic|heif|jpe?g|png|webp);base64,[a-z\d+/]+={0,2}$/i.test(value)) {
    throw new TypeError('Resolved message attachment preview must be a bounded image data URL');
  }
  return value;
}
function isJsonValue(value: unknown, seen = new Set<object>()): value is CodexSurfaceJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value) || Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) return false;
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return false;
  } else {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if ((prototype !== Object.prototype && prototype !== null) || Object.keys(value).length !== Object.getOwnPropertyNames(value).length) return false;
  }
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

export {
  applyCodexSurfaceStateChanges,
  createCodexSurfaceStateMirror,
  diffCodexSurfaceState,
  isCodexSurfaceStatePatchSource,
  subscribeCodexSurfaceState,
  type CodexSurfaceStateMirror,
  type CodexSurfaceStateMirrorResult,
  type CodexSurfaceStatePatchSource,
  type CodexSurfaceStateSource,
  type SubscribeCodexSurfaceStateOptions,
} from './surface-state';
