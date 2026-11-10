import type { CodexAppServerClient, v2 } from '@korus-dev/codex-sdk';
import type {
  CodexConversationSummary,
  CodexApprovalMode,
  ApprovalPreset,
  CodexPermissionMode,
  CodexHostSnapshot,
  CreateCodexConversationOptions,
  UpdateConversationSettings,
} from '../../core/codex-host';
import type { HostEventInput } from './host-events';
import { sameValue } from './host-events';
import {
  approvalPresetStartParams,
  approvalPresetUpdateParams,
  collaborationMode,
  nextSelection,
  selectedModel,
} from './host-settings';
import type { ThreadRuntimePatch, ThreadRuntimeState } from './host-runtime';

export type CodexHostConversationSettingsDependencies = {
  createConversation(): Promise<void>;
  emitConversationSettings(threadId: string, origin: 'action'): void;
  emitEvent(origin: 'action', input: HostEventInput): void;
  emitSummaryUpserted(summary: CodexConversationSummary, reason: 'updated', origin: 'action'): void;
  ensureConnected(): Promise<void>;
  ensureThreadReady(threadId: string): Promise<ThreadRuntimeState>;
  getSnapshot(): CodexHostSnapshot;
  getState(): CodexHostSnapshot;
  patch(patch: Partial<CodexHostSnapshot>): void;
  patchRuntime(threadId: string, patch: ThreadRuntimePatch): void;
  snapshotForRuntime(runtime: ThreadRuntimeState): CodexHostSnapshot;
};

export class CodexHostConversationSettingsController {
  constructor(
    private readonly client: CodexAppServerClient,
    private readonly defaults: {
      approvalMode?: CodexApprovalMode;
      approvalPreset?: ApprovalPreset;
      permissionMode?: CodexPermissionMode;
    },
    private readonly host: CodexHostConversationSettingsDependencies,
  ) {}

  preferredApprovalPreset(): ApprovalPreset | null {
    if (this.defaults.approvalPreset) return this.defaults.approvalPreset;
    if (this.defaults.approvalMode !== undefined || this.defaults.permissionMode !== undefined) {
      if (this.defaults.permissionMode === 'full-access' && this.defaults.approvalMode !== 'ask') {
        return 'full-access';
      }
      if (this.defaults.permissionMode === 'workspace-write' && this.defaults.approvalMode === 'ask') {
        return 'ask-for-approval';
      }
      return null;
    }
    return 'ask-for-approval';
  }

  threadStartSettings(
    options: CreateCodexConversationOptions,
    availablePresets: readonly ApprovalPreset[],
  ): {
    approvalPolicy: v2.AskForApproval;
    approvalsReviewer?: v2.ApprovalsReviewer;
    permissions?: string;
    sandbox?: v2.SandboxMode;
  } {
    const preferred = this.preferredApprovalPreset();
    const preset = options.approvalPreset ?? (
      options.approvalMode === undefined && options.permissionMode === undefined
        ? (availablePresets.includes(preferred ?? 'ask-for-approval')
          ? preferred
          : availablePresets[0] ?? null)
        : null
    );
    if (preset) return approvalPresetStartParams(preset);
    const approvalMode = options.approvalMode ?? this.defaults.approvalMode;
    const permissionMode = options.permissionMode ?? this.defaults.permissionMode ?? 'read-only';
    return {
      approvalPolicy: approvalMode === 'ask' ? 'on-request' : 'never',
      sandbox: permissionMode === 'full-access' ? 'danger-full-access' : permissionMode,
    };
  }

  async rename(threadId: string, title: string): Promise<void> {
    await this.host.ensureThreadReady(threadId);
    const name = title.trim();
    if (!name) throw new Error('Conversation title cannot be empty');
    await this.client.request('thread/name/set', { threadId, name });
    const state = this.host.getState();
    this.host.patch({
      conversations: state.conversations.map((conversation) => conversation.id === threadId
        ? { ...conversation, title: name }
        : conversation),
    });
    const summary = this.host.getState().conversations.find((conversation) => conversation.id === threadId);
    if (summary) this.host.emitSummaryUpserted(summary, 'updated', 'action');
  }

  async update(settings: UpdateConversationSettings): Promise<CodexHostSnapshot> {
    const state = this.host.getState();
    const threadId = state.activeConversationId;
    if (!threadId) {
      const next = nextSelection(state, settings);
      if (settings.approvalPreset && !state.approvalPresets.includes(settings.approvalPreset)) {
        throw new Error(`Approval preset '${settings.approvalPreset}' is not available`);
      }
      this.host.patch(next);
      return this.host.getSnapshot();
    }
    await this.updateForThread(threadId, settings);
    return this.host.getSnapshot();
  }

  async updateForThread(threadId: string, settings: UpdateConversationSettings): Promise<void> {
    const runtime = await this.host.ensureThreadReady(threadId);
    const runtimeSnapshot = this.host.snapshotForRuntime(runtime);
    const next = nextSelection(runtimeSnapshot, settings);
    const changed = runtime.approvalPreset !== next.approvalPreset
      || runtime.selectedModelId !== next.selectedModelId
      || runtime.selectedReasoningEffort !== next.selectedReasoningEffort
      || runtime.selectedServiceTier !== next.selectedServiceTier
      || runtime.planMode !== next.planMode;
    if (settings.approvalPreset && !runtimeSnapshot.approvalPresets.includes(settings.approvalPreset)) {
      throw new Error(`Approval preset '${settings.approvalPreset}' is not available`);
    }
    const model = selectedModel(this.host.getState().models, next.selectedModelId);
    await this.client.request('thread/settings/update', {
      threadId,
      ...(settings.approvalPreset ? approvalPresetUpdateParams(settings.approvalPreset) : {}),
      ...(settings.modelId && model ? { model: model.model } : {}),
      ...(settings.reasoningEffort || settings.modelId ? { effort: next.selectedReasoningEffort } : {}),
      ...(settings.serviceTier !== undefined || settings.modelId
        ? { serviceTier: next.selectedServiceTier }
        : {}),
      ...(model && (
        typeof settings.planMode === 'boolean'
        || Boolean(settings.modelId)
        || Boolean(settings.reasoningEffort)
      ) ? { collaborationMode: collaborationMode(next.planMode, model.model, next.selectedReasoningEffort) } : {}),
    });
    this.host.patchRuntime(threadId, next);
    if (changed) this.host.emitConversationSettings(threadId, 'action');
  }

  async setGoal(objective: string, tokenBudget?: number | null): Promise<CodexHostSnapshot> {
    await this.host.ensureConnected();
    if (!this.host.getState().activeConversationId) await this.host.createConversation();
    const threadId = this.host.getState().activeConversationId;
    if (!threadId) throw new Error('Codex did not create a conversation');
    await this.setGoalForThread(threadId, objective, tokenBudget);
    return this.host.getSnapshot();
  }

  async setGoalForThread(threadId: string, objective: string, tokenBudget?: number | null): Promise<void> {
    const runtime = await this.host.ensureThreadReady(threadId);
    const normalizedObjective = objective.trim();
    if (!normalizedObjective) throw new Error('Goal objective cannot be empty');
    const response = await this.client.request('thread/goal/set', {
      threadId, objective: normalizedObjective, status: 'active',
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
    });
    if (response.goal.threadId !== threadId) {
      throw new Error(`Codex thread/goal/set returned a goal for '${response.goal.threadId}' instead of '${threadId}'`);
    }
    const changed = !sameValue(runtime.goal, response.goal);
    this.host.patchRuntime(threadId, { goal: { ...response.goal } });
    if (changed) {
      this.host.emitEvent('action', {
        type: 'conversation.goalChanged', conversationId: threadId,
        payload: { goal: structuredClone(response.goal) },
      });
    }
  }

  async clearGoal(): Promise<CodexHostSnapshot> {
    await this.host.ensureConnected();
    const threadId = this.host.getState().activeConversationId;
    if (!threadId) return this.host.getSnapshot();
    await this.clearGoalForThread(threadId);
    return this.host.getSnapshot();
  }

  async clearGoalForThread(threadId: string): Promise<void> {
    const runtime = await this.host.ensureThreadReady(threadId);
    await this.client.request('thread/goal/clear', { threadId });
    const changed = runtime.goal !== null;
    this.host.patchRuntime(threadId, { goal: null });
    if (changed) {
      this.host.emitEvent('action', {
        type: 'conversation.goalChanged', conversationId: threadId, payload: { goal: null },
      });
    }
  }
}
