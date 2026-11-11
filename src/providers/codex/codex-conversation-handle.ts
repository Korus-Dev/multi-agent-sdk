import type { ContinueCodexSafetyReviewOptions } from '../../core/codex-conversation-types';
import type { CodexConversationHistory, CodexConversationHistoryPage, CodexConversationPromptHistory, ApprovalDecision, ApprovalScope, ClientRequestResponse, SendMessageOptions, StartCodexReviewOptions, UpdateConversationSettings } from '../../core/codex-host';
import type { CodexConversationEvent, CodexConversationSnapshot, StartCodexRealtimeOptions } from '../../core/codex-conversation-types';
import type {
  CodexConversation,
  CodexConversationForkResult,
  CodexConversationHostOptions,
  CodexConversationLoadOptions,
  CodexRealtimeSession,
  ForkCodexConversationOptions,
} from './host-contracts';

export type CodexConversationHandleOperations = {
  clearGoal(): Promise<void>;
  compact(): Promise<void>;
  continueInterruptedTurn(): Promise<void>;
  continueAfterSafetyReview?(options: ContinueCodexSafetyReviewOptions): Promise<void>;
  deleteTurn(turnId: string): Promise<void>;
  deleteQueuedPrompt(promptId: string): Promise<void>;
  updateQueuedPrompt(promptId: string, prompt: string, options?: SendMessageOptions): Promise<void>;
  editTurn(turnId: string, content: string, options?: SendMessageOptions): Promise<void>;
  fork(
    options?: ForkCodexConversationOptions,
    hostOptions?: CodexConversationHostOptions,
  ): Promise<CodexConversationForkResult>;
  forkTurn(
    turnId: string,
    options?: ForkCodexConversationOptions,
    hostOptions?: CodexConversationHostOptions,
  ): Promise<CodexConversationForkResult>;
  getSnapshot(): CodexConversationSnapshot;
  interrupt(): Promise<void>;
  load(options?: CodexConversationLoadOptions): Promise<void>;
  onEvent(listener: (event: CodexConversationEvent) => void): () => void;
  onStateChange(listener: (snapshot: CodexConversationSnapshot) => void): () => void;
  readHistory(): Promise<CodexConversationHistory>;
  readContent?: CodexConversation['readContent'];
  readPromptHistory(): Promise<CodexConversationPromptHistory>;
  loadOlderHistory?: () => Promise<CodexConversationHistoryPage>;
  loadTurnHistory?: (turnId: string) => Promise<void>;
  rename(title: string): Promise<void>;
  resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
  ): Promise<void>;
  respondToClientRequest(response: ClientRequestResponse): Promise<void>;
  retryTurn(turnId: string): Promise<void>;
  select(): Promise<void>;
  sendMessage(prompt: string, options?: SendMessageOptions): Promise<void>;
  setGoal(objective: string, tokenBudget?: number | null): Promise<void>;
  startRealtime(options: StartCodexRealtimeOptions): Promise<CodexRealtimeSession>;
  startReview(options?: StartCodexReviewOptions): Promise<void>;
  steerMessage(prompt: string, options?: SendMessageOptions): Promise<void>;
  steerQueuedPrompt(promptId: string, prompt?: string, options?: SendMessageOptions): Promise<void>;
  updateSettings(settings: UpdateConversationSettings): Promise<void>;
};

export function createCodexConversationHandle(
  id: string,
  operations: CodexConversationHandleOperations,
): CodexConversation {
  const snapshotAfter = async (operation: () => Promise<void>): Promise<CodexConversationSnapshot> => {
    await operation();
    return operations.getSnapshot();
  };
  return {
    id,
    fork: operations.fork,
    forkTurn: operations.forkTurn,
    load: (options) => snapshotAfter(() => operations.load(options)),
    select: () => snapshotAfter(operations.select),
    readHistory: operations.readHistory,
    readContent: operations.readContent ?? (async () => { throw new Error('Content reads are unavailable.'); }),
    readPromptHistory: operations.readPromptHistory,
    loadTurnHistory: (turnId) => snapshotAfter(() => operations.loadTurnHistory?.(turnId) ?? Promise.reject(new Error('Turn history is unavailable.'))),
    loadOlderHistory: operations.loadOlderHistory ?? (
      async () => ({ conversationId: id, messages: [], hasOlder: false })
    ),
    rename: (title) => snapshotAfter(() => operations.rename(title)),
    updateSettings: (settings) => snapshotAfter(() => operations.updateSettings(settings)),
    sendMessage: (prompt, options) => snapshotAfter(() => operations.sendMessage(prompt, options)),
    startRealtime: operations.startRealtime,
    compact: () => snapshotAfter(operations.compact),
    continueInterruptedTurn: () => snapshotAfter(operations.continueInterruptedTurn),
    continueAfterSafetyReview: (options) => snapshotAfter(() => operations.continueAfterSafetyReview?.(options) ?? Promise.reject(new Error('Safety review continuation is unavailable.'))),
    startReview: (options) => snapshotAfter(() => operations.startReview(options)),
    steerMessage: (prompt, options) => snapshotAfter(() => operations.steerMessage(prompt, options)),
    interrupt: () => snapshotAfter(operations.interrupt),
    deleteTurn: (turnId) => snapshotAfter(() => operations.deleteTurn(turnId)),
    editTurn: (turnId, content, options) => snapshotAfter(() => operations.editTurn(turnId, content, options)),
    retryTurn: (turnId) => snapshotAfter(() => operations.retryTurn(turnId)),
    deleteQueuedPrompt: (promptId) => snapshotAfter(() => operations.deleteQueuedPrompt(promptId)),
    updateQueuedPrompt: (promptId, prompt, options) => snapshotAfter(() => operations.updateQueuedPrompt(promptId, prompt, options)),
    steerQueuedPrompt: (promptId, prompt, options) => snapshotAfter(() => operations.steerQueuedPrompt(promptId, prompt, options)),
    respondToClientRequest: (response) => snapshotAfter(() => operations.respondToClientRequest(response)),
    resolveApproval: (approvalId, decision, scope) => snapshotAfter(
      () => operations.resolveApproval(approvalId, decision, scope),
    ),
    setGoal: (objective, tokenBudget) => snapshotAfter(() => operations.setGoal(objective, tokenBudget)),
    clearGoal: () => snapshotAfter(operations.clearGoal),
    getSnapshot: operations.getSnapshot,
    onStateChange: operations.onStateChange,
    onEvent: operations.onEvent,
  };
}
