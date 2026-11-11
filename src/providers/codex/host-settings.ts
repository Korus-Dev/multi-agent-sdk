import type { v2 } from '@korus-dev/codex-sdk';
import type { ApprovalPreset, ModelDescriptor, SendMessageOptions, UpdateConversationSettings } from '../../core/codex-host';
import type { CodexSnapshot } from '../../core/codex-conversation-types';

export type HostSelection = Pick<
  CodexSnapshot,
  'approvalPreset' | 'planMode' | 'selectedModelId' | 'selectedReasoningEffort'
  | 'selectedServiceTier'
>;

export function selectedModel(
  models: ModelDescriptor[],
  idOrModel: string | null,
): ModelDescriptor | null {
  return models.find((model) => model.id === idOrModel || model.model === idOrModel)
    ?? models.find((model) => model.isDefault)
    ?? models[0]
    ?? null;
}

export function requireCatalogModel(models: ModelDescriptor[], idOrModel: string): ModelDescriptor {
  const model = models.find((candidate) => candidate.id === idOrModel || candidate.model === idOrModel);
  if (!model) throw new Error(`Unknown model '${idOrModel}'`);
  return model;
}

export function validateReasoningEffort(
  model: ModelDescriptor | null,
  reasoningEffort: string | undefined,
): void {
  if (!reasoningEffort) return;
  if (!model) throw new Error(`Cannot select reasoning effort '${reasoningEffort}' without a model`);
  const supported = model.supportedReasoningEfforts?.map((option) => option.reasoningEffort) ?? [];
  if (supported.length > 0 && !supported.includes(reasoningEffort)) {
    throw new Error(`Reasoning effort '${reasoningEffort}' is not available for '${model.displayName}'`);
  }
}

export function defaultReasoningEffort(model: ModelDescriptor): string | null {
  return model.defaultReasoningEffort
    ?? model.supportedReasoningEfforts?.[0]?.reasoningEffort
    ?? null;
}

export function defaultServiceTier(model: ModelDescriptor): string | null {
  return model.defaultServiceTier ?? null;
}

export function validateServiceTier(
  model: ModelDescriptor | null,
  serviceTier: string | null | undefined,
): void {
  if (!serviceTier) return;
  if (!model) throw new Error(`Cannot select service tier '${serviceTier}' without a model`);
  if (serviceTier === 'default' || serviceTier === model.defaultServiceTier) return;
  const supported = model.serviceTiers?.map((option) => option.id) ?? [];
  if (supported.length > 0 && !supported.includes(serviceTier)) {
    throw new Error(`Service tier '${serviceTier}' is not available for '${model.displayName}'`);
  }
}

export function approvalPresetsForProfiles(
  profiles: CodexSnapshot['permissionProfiles'],
  requirements: v2.ConfigRequirements | null,
): ApprovalPreset[] {
  const allowed = new Set(profiles.filter((profile) => profile.allowed).map((profile) => profile.id));
  const presets: ApprovalPreset[] = [];
  if (
    allowed.has(':workspace')
    && requirementAllows(requirements?.allowedApprovalPolicies, 'on-request')
    && requirementAllows(requirements?.allowedApprovalsReviewers, 'user')
  ) presets.push('ask-for-approval');
  if (
    allowed.has(':workspace')
    && requirementAllows(requirements?.allowedApprovalPolicies, 'on-request')
    && requirementAllows(requirements?.allowedApprovalsReviewers, 'auto_review')
  ) presets.push('approve-for-me');
  if (
    (allowed.has(':danger-full-access') || allowed.has(':danger-no-sandbox'))
    && requirementAllows(requirements?.allowedApprovalPolicies, 'never')
    && requirementAllows(requirements?.allowedApprovalsReviewers, 'user')
  ) presets.push('full-access');
  return presets;
}

function requirementAllows<T>(values: T[] | null | undefined, value: T): boolean {
  return !Array.isArray(values) || values.length === 0 || values.includes(value);
}

export function approvalPresetStartParams(preset: ApprovalPreset): {
  approvalPolicy: v2.AskForApproval;
  approvalsReviewer: v2.ApprovalsReviewer;
  permissions: string;
} {
  if (preset === 'full-access') {
    return {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      permissions: ':danger-full-access',
    };
  }
  return {
    approvalPolicy: 'on-request',
    approvalsReviewer: preset === 'approve-for-me' ? 'auto_review' : 'user',
    permissions: ':workspace',
  };
}

export function approvalPresetUpdateParams(preset: ApprovalPreset): {
  approvalPolicy: v2.AskForApproval;
  approvalsReviewer: v2.ApprovalsReviewer;
  permissions: string;
} {
  return approvalPresetStartParams(preset);
}

export function approvalPresetFromSettings(
  approvalPolicy: v2.AskForApproval,
  approvalsReviewer: v2.ApprovalsReviewer,
  sandbox: v2.SandboxPolicy,
  activePermissionProfile: v2.ActivePermissionProfile | null,
): ApprovalPreset | null {
  const profile = activePermissionProfile?.id;
  if (
    approvalPolicy === 'never'
    && (
      sandbox.type === 'dangerFullAccess'
      || profile === ':danger-full-access'
      || profile === ':danger-no-sandbox'
    )
  ) return 'full-access';
  if (
    approvalPolicy === 'on-request'
    && (approvalsReviewer === 'auto_review' || approvalsReviewer === 'guardian_subagent')
  ) return 'approve-for-me';
  if (approvalPolicy === 'on-request') return 'ask-for-approval';
  return null;
}

export function sessionSelection(
  response: v2.ThreadForkResponse | v2.ThreadResumeResponse | v2.ThreadStartResponse,
  models: ModelDescriptor[],
  current: CodexSnapshot,
): HostSelection {
  const model = selectedModel(models, response.model);
  return {
    approvalPreset: approvalPresetFromSettings(
      response.approvalPolicy,
      response.approvalsReviewer,
      response.sandbox,
      response.activePermissionProfile,
    ) ?? current.approvalPreset,
    planMode: current.planMode,
    selectedModelId: model?.id ?? current.selectedModelId,
    selectedReasoningEffort: response.reasoningEffort ?? (model ? defaultReasoningEffort(model) : null),
    selectedServiceTier: response.serviceTier !== undefined
      ? response.serviceTier
      : model ? defaultServiceTier(model) : null,
  };
}

export function threadSettingsSelection(
  settings: v2.ThreadSettings,
  models: ModelDescriptor[],
  current: CodexSnapshot,
): HostSelection {
  const model = selectedModel(models, settings.model);
  return {
    approvalPreset: approvalPresetFromSettings(
      settings.approvalPolicy,
      settings.approvalsReviewer,
      settings.sandboxPolicy,
      settings.activePermissionProfile,
    ) ?? current.approvalPreset,
    planMode: settings.collaborationMode.mode === 'plan',
    selectedModelId: model?.id ?? current.selectedModelId,
    selectedReasoningEffort: settings.effort ?? (model ? defaultReasoningEffort(model) : null),
    selectedServiceTier: settings.serviceTier !== undefined
      ? settings.serviceTier
      : model ? defaultServiceTier(model) : null,
  };
}

export function nextSelection(
  current: CodexSnapshot,
  settings: UpdateConversationSettings,
): HostSelection {
  let model = selectedModel(current.models, current.selectedModelId);
  if (settings.modelId) {
    model = current.models.find((candidate) => candidate.id === settings.modelId) ?? null;
    if (!model) throw new Error(`Unknown model '${settings.modelId}'`);
  }

  let reasoningEffort = settings.reasoningEffort ?? current.selectedReasoningEffort;
  let serviceTier = settings.serviceTier !== undefined
    ? settings.serviceTier
    : current.selectedServiceTier ?? null;
  const supported = model?.supportedReasoningEfforts?.map((option) => option.reasoningEffort) ?? [];
  if (settings.reasoningEffort && supported.length > 0 && !supported.includes(settings.reasoningEffort)) {
    throw new Error(`Reasoning effort '${settings.reasoningEffort}' is not available for '${model!.displayName}'`);
  }
  if (settings.modelId && supported.length > 0 && (!reasoningEffort || !supported.includes(reasoningEffort))) {
    reasoningEffort = model ? defaultReasoningEffort(model) : null;
  }
  if (settings.serviceTier !== undefined) validateServiceTier(model, serviceTier);
  if (settings.serviceTier === undefined && settings.modelId && serviceTier
    && !model!.serviceTiers?.some((tier) => tier.id === serviceTier)) {
    serviceTier = model ? defaultServiceTier(model) : null;
  }

  return {
    approvalPreset: settings.approvalPreset ?? current.approvalPreset,
    planMode: settings.planMode ?? current.planMode,
    selectedModelId: model?.id ?? null,
    selectedReasoningEffort: reasoningEffort,
    selectedServiceTier: serviceTier,
  };
}

export function collaborationMode(
  planMode: boolean,
  model: string,
  reasoningEffort: string | null,
): NonNullable<v2.TurnStartParams['collaborationMode']> {
  return {
    mode: planMode ? 'plan' : 'default',
    settings: {
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: null,
    },
  };
}

export function turnSettings(
  state: CodexSnapshot,
  options: SendMessageOptions,
): Pick<v2.TurnStartParams, 'collaborationMode' | 'effort' | 'model' | 'serviceTier'> {
  const selected = selectedModel(state.models, state.selectedModelId);
  const model = options.model ?? selected?.model;
  const effort = options.reasoningEffort ?? state.selectedReasoningEffort;
  const planMode = options.planMode ?? state.planMode;
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(model ? { collaborationMode: collaborationMode(planMode, model, effort) } : {}),
    ...(options.serviceTier !== undefined
      ? { serviceTier: options.serviceTier }
      : state.selectedServiceTier ? { serviceTier: state.selectedServiceTier } : {}),
  };
}
