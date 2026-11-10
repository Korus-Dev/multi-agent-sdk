import type { CodexAppServerClient } from '@korus-dev/codex-sdk';
import type {
  ApprovalDecision,
  ApprovalScope,
  HostEventOrigin,
  CodexHostSnapshot,
} from '../../core/codex-host';
import { registerCodexApprovalHandlers, type PendingCodexApproval } from './codex-approvals';
import type { HostEventInput } from './host-events';
import type { ThreadRuntimePatch, ThreadRuntimeState } from './host-runtime';

type ApprovalResolutionReason =
  | 'conversation_closed'
  | 'conversation_removed'
  | 'host_disconnected';

export type CodexHostApprovalsDependencies = {
  activeConversationId(): string | null;
  createRuntime(threadId: string, patch: ThreadRuntimePatch): ThreadRuntimeState;
  emitConversationActivity(threadId: string, origin: HostEventOrigin): void;
  emitEvent(origin: HostEventOrigin, input: HostEventInput): void;
  markRuntimeTurnActive(runtime: ThreadRuntimeState, turnId: string): void;
  maybeClearWaitingBusy(threadId: string): void;
  patch(patch: Partial<CodexHostSnapshot>): void;
  patchConversationStatus(threadId: string, status: 'active'): void;
  patchRuntime(threadId: string, patch: ThreadRuntimePatch): void;
};

export class CodexHostApprovalsController {
  private readonly pending = new Map<string, PendingCodexApproval>();
  private readonly unsubscribeHandler: () => void;

  constructor(client: CodexAppServerClient, private readonly host: CodexHostApprovalsDependencies) {
    this.unsubscribeHandler = registerCodexApprovalHandlers(client, (pending) => this.add(pending));
  }

  close(): void {
    this.unsubscribeHandler();
    this.pending.clear();
  }

  denyAll(): void {
    for (const pending of this.pending.values()) pending.resolve('deny', 'once');
    this.pending.clear();
  }

  approvalsForThread(threadId: string): CodexHostSnapshot['approvals'] {
    return [...this.pending.values()]
      .map((pending) => pending.approval)
      .filter((approval) => approval.conversationId === threadId);
  }

  hasForThread(threadId: string): boolean {
    return [...this.pending.values()]
      .some((pending) => pending.approval.conversationId === threadId);
  }

  async resolve(
    threadId: string | undefined,
    approvalId: string,
    decision: ApprovalDecision,
    scope: ApprovalScope,
  ): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (!pending) throw new Error(`Unknown approval '${approvalId}'`);
    if (threadId !== undefined && pending.approval.conversationId !== threadId) {
      throw new Error(
        `Approval '${approvalId}' belongs to conversation '${pending.approval.conversationId}', not '${threadId}'`,
      );
    }
    if (decision !== 'approve' && decision !== 'deny') {
      throw new Error(`Invalid approval decision '${String(decision)}'`);
    }
    if (scope !== 'once' && scope !== 'session') {
      throw new Error(`Invalid approval scope '${String(scope)}'`);
    }
    if (decision === 'approve' && pending.approval.allowedScopes && !pending.approval.allowedScopes.includes(scope)) {
      throw new Error(`Approval decision '${decision}:${scope}' is not available for '${approvalId}'`);
    }
    pending.resolve(decision, scope);
    this.pending.delete(approvalId);
    this.refreshActive();
    this.host.maybeClearWaitingBusy(pending.approval.conversationId);
    this.host.emitEvent('action', {
      type: 'approval.resolved',
      conversationId: pending.approval.conversationId,
      ...(pending.approval.turnId ? { turnId: pending.approval.turnId } : {}),
      payload: {
        approval: structuredClone(pending.approval), decision, scope, reason: 'host',
      },
    });
    this.host.emitConversationActivity(pending.approval.conversationId, 'action');
  }

  clearForThread(threadId: string, eventReason: ApprovalResolutionReason): void {
    const resolved: PendingCodexApproval[] = [];
    for (const [approvalId, pending] of this.pending) {
      if (pending.approval.conversationId !== threadId) continue;
      pending.resolve('deny', 'once');
      this.pending.delete(approvalId);
      resolved.push(pending);
    }
    this.refreshActive();
    this.host.patchRuntime(threadId, {});
    for (const pending of resolved) {
      this.host.emitEvent('notification', {
        type: 'approval.resolved',
        conversationId: threadId,
        ...(pending.approval.turnId ? { turnId: pending.approval.turnId } : {}),
        payload: {
          approval: structuredClone(pending.approval),
          decision: 'deny', scope: 'once', reason: eventReason,
        },
      });
    }
  }

  handleServerResolved(requestId: string): void {
    const pending = this.pending.get(requestId);
    this.pending.delete(requestId);
    this.refreshActive();
    if (!pending) return;
    this.host.maybeClearWaitingBusy(pending.approval.conversationId);
    this.host.emitEvent('notification', {
      type: 'approval.resolved',
      conversationId: pending.approval.conversationId,
      ...(pending.approval.turnId ? { turnId: pending.approval.turnId } : {}),
      payload: {
        approval: structuredClone(pending.approval),
        decision: null, scope: null, reason: 'server',
      },
    });
  }

  private add(pending: PendingCodexApproval): void {
    this.pending.set(pending.approval.id, pending);
    const runtime = this.host.createRuntime(pending.approval.conversationId, { busy: true });
    if (pending.approval.turnId) this.host.markRuntimeTurnActive(runtime, pending.approval.turnId);
    this.host.patchRuntime(pending.approval.conversationId, { busy: true });
    this.host.patchConversationStatus(pending.approval.conversationId, 'active');
    this.refreshActive();
    this.host.emitEvent('notification', {
      type: 'approval.requested',
      conversationId: pending.approval.conversationId,
      ...(pending.approval.turnId ? { turnId: pending.approval.turnId } : {}),
      payload: { approval: structuredClone(pending.approval) },
    });
    this.host.emitConversationActivity(pending.approval.conversationId, 'notification');
  }

  private refreshActive(): void {
    const threadId = this.host.activeConversationId();
    this.host.patch({ approvals: threadId ? this.approvalsForThread(threadId) : [] });
  }
}
