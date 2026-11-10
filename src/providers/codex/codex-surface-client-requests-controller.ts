import type {
  CodexServerRequestResponder,
  ServerRequest,
} from '@korus-dev/codex-sdk';
import type {
  CodexSurfaceClientRequest,
  CodexSurfaceClientRequestResponse,
  SurfaceMessage,
  SurfaceMessageToolPart,
} from '../../core/surface';
import {
  argumentsPreview,
  findPendingMcpToolPart,
  isRecord,
  mcpElicitationResponse,
  persistSupports,
  stringValue,
} from './codex-surface-prompts';
import { addUnique, updateAssistantToolPart, upsertAssistantToolPart } from './codex-surface-message-state';
import type { SurfaceEventInput } from './codex-surface-events';
import { runtimeProjection, type ThreadRuntimePatch, type ThreadRuntimeState } from './codex-surface-runtime';

type ToolInputRequest = Extract<ServerRequest, { method: 'item/tool/requestUserInput' }>;
type McpElicitationRequest = Extract<ServerRequest, { method: 'mcpServer/elicitation/request' }>;
type ClientRequestResolutionReason =
  | 'conversation_closed'
  | 'conversation_removed'
  | 'surface_disconnected';

type PendingClientRequest =
  | {
    kind: 'ask_user';
    itemId: string;
    request: Extract<CodexSurfaceClientRequest, { kind: 'ask_user' }>;
    threadId: string;
    turnId: string;
    responder: CodexServerRequestResponder<'item/tool/requestUserInput'>;
  }
  | {
    kind: 'mcp_tool_approval';
    displayTurnId: string;
    itemId: string;
    request: Extract<CodexSurfaceClientRequest, { kind: 'confirm_tool' }>;
    threadId: string;
    turnId: string | null;
    responder: CodexServerRequestResponder<'mcpServer/elicitation/request'>;
  };

export type CodexSurfaceClientRequestsHost = {
  activeConversationId(): string | null;
  answerAsyncQuestion(threadId: string, prompt: string, displayText: string): Promise<void>;
  emitConversationActivity(threadId: string, origin: 'action' | 'notification'): void;
  emitEvent(origin: 'action' | 'notification', input: SurfaceEventInput): void;
  hasPendingApproval(threadId: string): boolean;
  markRuntimeTurnActive(runtime: ThreadRuntimeState, turnId: string): void;
  messageContainingTool(threadId: string, turnId: string, itemId: string): SurfaceMessage | null;
  patchRuntime(threadId: string, patch: ThreadRuntimePatch): void;
  requireRuntime(threadId: string): ThreadRuntimeState;
};

export class CodexSurfaceClientRequestsController {
  private readonly pending = new Map<string, PendingClientRequest>();

  constructor(private readonly host: CodexSurfaceClientRequestsHost) {}

  requestsForThread(threadId: string): CodexSurfaceClientRequest[] {
    return [...this.pending.values()]
      .filter((pending) => pending.threadId === threadId)
      .map((pending) => pending.request);
  }

  hasForThread(threadId: string): boolean {
    return [...this.pending.values()].some((pending) => pending.threadId === threadId);
  }

  clear(): void {
    this.pending.clear();
  }

  rejectAll(reason: string): void {
    for (const pending of this.pending.values()) pending.responder.reject(reason);
    this.pending.clear();
  }

  clearForThread(threadId: string, reason: string, eventReason: ClientRequestResolutionReason): void {
    const resolved: PendingClientRequest[] = [];
    for (const [requestId, pending] of this.pending) {
      if (pending.threadId !== threadId) continue;
      pending.responder.reject(reason);
      this.pending.delete(requestId);
      resolved.push(pending);
    }
    this.host.patchRuntime(threadId, {});
    for (const pending of resolved) {
      this.host.emitEvent('notification', {
        type: 'clientRequest.resolved',
        conversationId: threadId,
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        payload: {
          request: structuredClone(pending.request),
          response: null,
          reason: eventReason,
        },
      });
    }
  }

  async respond(
    threadId: string | undefined,
    response: CodexSurfaceClientRequestResponse,
  ): Promise<void> {
    const pending = this.pending.get(response.id);
    if (!pending) {
      await this.respondToAsyncQuestion(threadId, response);
      return;
    }
    if (threadId !== undefined && pending.threadId !== threadId) {
      throw new Error(`Client request '${response.id}' belongs to conversation '${pending.threadId}', not '${threadId}'`);
    }
    const confirmationDecision = response.payload?.decision ?? 'deny';
    if (
      pending.kind === 'mcp_tool_approval'
      && !['allow', 'allow_conversation', 'always_allow', 'deny'].includes(confirmationDecision)
    ) {
      throw new Error(`Invalid tool confirmation decision '${String(confirmationDecision)}'`);
    }
    this.pending.delete(response.id);
    const runtime = this.host.requireRuntime(pending.threadId);
    const answeredClientRequestIds = addUnique(runtime.answeredClientRequestIds, response.id);
    if (pending.kind === 'ask_user') {
      const answers = response.payload?.answers ?? {};
      pending.responder.resolve({ answers });
      this.host.patchRuntime(pending.threadId, {
        answeredClientRequestIds,
        messages: updateAssistantToolPart(runtime.messages, pending.threadId, pending.turnId, {
          itemId: pending.itemId,
          output: { answers },
        }),
      });
    } else {
      const decision = confirmationDecision;
      pending.responder.resolve(mcpElicitationResponse(decision));
      this.host.patchRuntime(pending.threadId, {
        answeredClientRequestIds,
        messages: updateAssistantToolPart(runtime.messages, pending.threadId, pending.displayTurnId, {
          itemId: pending.itemId,
          output: { decision },
        }),
      });
    }
    this.maybeClearWaitingBusy(pending.threadId);
    this.host.emitEvent('action', {
      type: 'clientRequest.resolved',
      conversationId: pending.threadId,
      ...(pending.turnId ? { turnId: pending.turnId } : {}),
      payload: {
        request: structuredClone(pending.request),
        response: structuredClone(response),
        reason: 'host',
      },
    });
    this.host.emitConversationActivity(pending.threadId, 'action');
  }

  private async respondToAsyncQuestion(
    threadId: string | undefined,
    response: CodexSurfaceClientRequestResponse,
  ): Promise<void> {
    const resolvedThreadId = threadId ?? this.host.activeConversationId();
    const runtime = resolvedThreadId === null ? null : this.host.requireRuntime(resolvedThreadId);
    const request = runtime && runtimeProjection(runtime, [], []).clientRequests.find(
      (candidate): candidate is Extract<CodexSurfaceClientRequest, { kind: 'ask_user' }> => (
        candidate.kind === 'ask_user' && candidate.id === response.id
      ),
    );
    const match = runtime && request ? { request, runtime } : null;
    if (!match) throw new Error(`Unknown client request '${response.id}'`);
    if (match.request.payload.request.delivery !== 'async') {
      throw new Error(`Unknown client request '${response.id}'`);
    }
    const answers = response.payload?.answers ?? {};
    const entries = match.request.payload.request.questions.flatMap((question) => {
      const answer = answers[question.id]?.answers.join(', ').trim() ?? '';
      return answer ? [{
        questionItemId: question.id,
        question: question.question,
        answer,
      }] : [];
    });
    if (response.payload?.cancelled !== true) {
      if (entries.length === 0) throw new Error('At least one answer is required');
      const prompt = '<send_user_message_question_reply>\n'
        + `${JSON.stringify(entries)}\n`
        + '</send_user_message_question_reply>';
      const displayText = entries.length === 1
        ? entries[0]!.answer
        : entries.map((entry) => `${entry.question}: ${entry.answer}`).join('\n');
      await this.host.answerAsyncQuestion(match.runtime.threadId, prompt, displayText);
    }
    this.host.patchRuntime(match.runtime.threadId, {
      answeredClientRequestIds: addUnique(match.runtime.answeredClientRequestIds, response.id),
    });
    this.host.emitEvent('action', {
      type: 'clientRequest.resolved',
      conversationId: match.runtime.threadId,
      ...(match.request.turnId ? { turnId: match.request.turnId } : {}),
      payload: {
        request: structuredClone(match.request),
        response: structuredClone(response),
        reason: 'host',
      },
    });
    this.host.emitConversationActivity(match.runtime.threadId, 'action');
  }

  handleServerResolved(requestId: string, threadId: string): void {
    const pending = this.pending.get(requestId);
    this.pending.delete(requestId);
    if (pending) {
      const runtime = this.host.requireRuntime(pending.threadId);
      this.host.patchRuntime(pending.threadId, {
        answeredClientRequestIds: addUnique(runtime.answeredClientRequestIds, requestId),
      });
    }
    this.maybeClearWaitingBusy(threadId);
    if (!pending) return;
    this.host.emitEvent('notification', {
      type: 'clientRequest.resolved',
      conversationId: pending.threadId,
      ...(pending.turnId ? { turnId: pending.turnId } : {}),
      payload: { request: structuredClone(pending.request), response: null, reason: 'server' },
    });
  }

  maybeClearWaitingBusy(threadId: string): void {
    const runtime = this.host.requireRuntime(threadId);
    if (runtime.turnStartPending || runtime.activeTurnId !== null) return;
    if (!this.host.hasPendingApproval(threadId) && !this.hasForThread(threadId)) {
      this.host.patchRuntime(threadId, { busy: false });
    }
  }

  handleToolInputRequest(
    request: ToolInputRequest,
    responder: CodexServerRequestResponder<'item/tool/requestUserInput'>,
  ): boolean {
    const { threadId, turnId, itemId, questions } = request.params;
    if (questions.length === 0) return false;
    const runtime = this.host.requireRuntime(threadId);
    this.host.markRuntimeTurnActive(runtime, turnId);
    const requestId = String(request.id);
    const normalizedQuestions = questions.map((question) => ({
      ...question,
      options: question.options?.map((option) => ({ ...option })) ?? null,
    }));
    const clientRequest: Extract<CodexSurfaceClientRequest, { kind: 'ask_user' }> = {
      id: requestId,
      kind: 'ask_user',
      conversationId: threadId,
      turnId,
      itemId,
      payload: {
        request: {
          itemId,
          delivery: 'tool',
          blocking: request.params.isBlocking ?? true,
          questions: normalizedQuestions,
          ...(request.params.autoResolutionMs === null
            ? {}
            : { autoResolutionMs: request.params.autoResolutionMs }),
        },
      },
    };
    this.pending.set(requestId, {
      kind: 'ask_user', itemId, request: clientRequest, threadId, turnId, responder,
    });
    this.host.patchRuntime(threadId, {
      busy: true,
      messages: upsertAssistantToolPart(runtime.messages, threadId, turnId, {
        type: 'tool',
        id: itemId,
        kind: 'generic',
        title: 'ask_user_question',
        status: 'running',
        statusText: JSON.stringify({
          source: 'codex', action: 'ask_user_question', phase: 'running',
          params: { requestId, questions: normalizedQuestions },
        }),
        input: normalizedQuestions,
        metadata: { requestId, question: normalizedQuestions[0]!.question },
      }),
    });
    const requestToolMessage = this.host.messageContainingTool(threadId, turnId, itemId);
    const requestToolPart = requestToolMessage?.parts.find((part) => part.type === 'tool' && part.id === itemId);
    if (requestToolMessage && requestToolPart?.type === 'tool') {
      this.host.emitEvent('notification', {
        type: 'tool.started', conversationId: threadId, turnId,
        payload: { messageId: requestToolMessage.id, toolPart: structuredClone(requestToolPart) },
      });
    }
    this.host.emitEvent('notification', {
      type: 'clientRequest.requested', conversationId: threadId, turnId,
      payload: { request: structuredClone(clientRequest) },
    });
    this.host.emitConversationActivity(threadId, 'notification');
    return true;
  }

  handleMcpElicitationRequest(
    request: McpElicitationRequest,
    responder: CodexServerRequestResponder<'mcpServer/elicitation/request'>,
  ): boolean {
    const params = request.params;
    if (params.mode !== 'form') return false;
    const meta = params._meta;
    if (!isRecord(meta) || meta.codex_approval_kind !== 'mcp_tool_call') return false;
    const requestId = String(request.id);
    const toolName = stringValue(meta.tool_name) ?? stringValue(meta.tool_title) ?? 'tool';
    const runtime = this.host.requireRuntime(params.threadId);
    if (params.turnId) this.host.markRuntimeTurnActive(runtime, params.turnId);
    const displayTurnId = params.turnId ?? runtime.activeTurnId ?? `client-request-${requestId}`;
    const existingTool = findPendingMcpToolPart(
      runtime.messages, displayTurnId, params.serverName, toolName,
    );
    const itemId = existingTool?.id ?? `approval-${requestId}`;
    const summary = params.message.trim() || `Allow ${params.serverName} to run ${toolName}?`;
    const clientRequest: Extract<CodexSurfaceClientRequest, { kind: 'confirm_tool' }> = {
      id: requestId,
      kind: 'confirm_tool',
      conversationId: params.threadId,
      turnId: params.turnId,
      itemId,
      payload: {
        confirmation: {
          argumentsPreview: argumentsPreview(meta),
          integrationId: params.serverName,
          integrationName: stringValue(meta.connector_name) ?? params.serverName,
          summary,
          toolName,
          ...(persistSupports(meta.persist, 'session') ? { allowConversation: true } : {}),
          ...(persistSupports(meta.persist, 'always') ? { allowAlways: true } : {}),
        },
      },
    };
    this.pending.set(requestId, {
      kind: 'mcp_tool_approval', displayTurnId, itemId, request: clientRequest,
      threadId: params.threadId, turnId: params.turnId, responder,
    });
    const toolPart: SurfaceMessageToolPart = {
      type: 'tool',
      id: itemId,
      kind: 'mcp',
      title: `${params.serverName}.${toolName}`,
      status: 'running',
      statusText: JSON.stringify({
        source: 'mcp', action: 'confirm_tool', phase: 'running',
        params: {
          requestId, confirmationSummary: summary, argumentsPreview: argumentsPreview(meta),
          allowConversation: persistSupports(meta.persist, 'session'),
          allowAlways: persistSupports(meta.persist, 'always'),
        },
      }),
      input: meta.tool_params,
      metadata: {
        ...(existingTool?.metadata ?? {}),
        requestId, confirmationRequestId: requestId, server: params.serverName, tool: toolName,
      },
    };
    this.host.patchRuntime(params.threadId, {
      busy: true,
      messages: upsertAssistantToolPart(runtime.messages, params.threadId, displayTurnId, toolPart),
    });
    const toolMessage = this.host.messageContainingTool(params.threadId, displayTurnId, itemId);
    if (toolMessage) {
      this.host.emitEvent('notification', {
        type: 'tool.started', conversationId: params.threadId, turnId: displayTurnId,
        payload: { messageId: toolMessage.id, toolPart: structuredClone(toolPart) },
      });
    }
    this.host.emitEvent('notification', {
      type: 'clientRequest.requested',
      conversationId: params.threadId,
      ...(params.turnId ? { turnId: params.turnId } : {}),
      payload: { request: structuredClone(clientRequest) },
    });
    this.host.emitConversationActivity(params.threadId, 'notification');
    return true;
  }
}
