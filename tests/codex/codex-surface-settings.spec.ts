import { describe, expect, it } from 'vitest';
import type { v2 } from '@korus-dev/codex-sdk/protocol';
import type { CodexSurfaceModel, CodexSurfaceSnapshot } from '@korus-dev/multi-agent-sdk/surface';
import {
  approvalPresetFromSettings,
  approvalPresetsForProfiles,
  approvalPresetStartParams,
  approvalPresetUpdateParams,
  collaborationMode,
  defaultReasoningEffort,
  nextSelection,
  requireCatalogModel,
  selectedModel,
  sessionSelection,
  threadSettingsSelection,
  turnSettings,
  validateReasoningEffort,
  validateServiceTier,
} from '../../src/providers/codex/codex-surface-settings';
import { initialAuthentication } from '../../src/providers/codex/codex-surface-authentication';
import { initialSurfaceSnapshot } from '../../src/providers/codex/codex-surface-runtime';
import { configRequirements } from './helpers/codex-surface-fixture';

const models: CodexSurfaceModel[] = [
  {
    id: 'fast-id',
    model: 'fast-model',
    displayName: 'Fast',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Low' },
      { reasoningEffort: 'medium', description: 'Medium' },
    ],
    defaultReasoningEffort: 'medium',
    serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Fast mode' }],
    defaultServiceTier: null,
  },
  {
    id: 'default-id',
    model: 'default-model',
    displayName: 'Default',
    supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
    isDefault: true,
  },
];

describe('Codex surface settings policy', () => {
  it('selects catalog models and validates reasoning effort', () => {
    expect(selectedModel(models, 'fast-id')).toBe(models[0]);
    expect(selectedModel(models, 'fast-model')).toBe(models[0]);
    expect(selectedModel(models, 'missing')).toBe(models[1]);
    expect(selectedModel([{ ...models[0]!, isDefault: false }], null)?.id).toBe('fast-id');
    expect(selectedModel([], null)).toBeNull();
    expect(requireCatalogModel(models, 'default-model')).toBe(models[1]);
    expect(() => requireCatalogModel(models, 'missing')).toThrow("Unknown model 'missing'");
    expect(() => validateReasoningEffort(null, undefined)).not.toThrow();
    expect(() => validateReasoningEffort(null, 'high')).toThrow("without a model");
    expect(() => validateReasoningEffort(models[0]!, 'high')).toThrow("not available for 'Fast'");
    expect(() => validateReasoningEffort(models[0]!, 'low')).not.toThrow();
    expect(() => validateServiceTier(models[0]!, 'priority')).not.toThrow();
    expect(() => validateServiceTier(models[0]!, 'default')).not.toThrow();
    expect(() => validateServiceTier({ ...models[0]!, defaultServiceTier: 'standard' }, 'standard')).not.toThrow();
    expect(() => validateServiceTier(models[0]!, 'unknown')).toThrow("not available for 'Fast'");
    expect(() => validateReasoningEffort({ id: 'open', model: 'open', displayName: 'Open' }, 'custom'))
      .not.toThrow();
    expect(defaultReasoningEffort(models[0]!)).toBe('medium');
    expect(defaultReasoningEffort(models[1]!)).toBe('high');
    expect(defaultReasoningEffort({ id: 'none', model: 'none', displayName: 'None' })).toBeNull();
  });

  it('treats absent model capabilities as open while rejecting selections without a model', () => {
    const openModel = { id: 'open', model: 'open', displayName: 'Open' };
    const emptyModel = {
      ...openModel,
      supportedReasoningEfforts: [],
      serviceTiers: [],
    };

    expect(defaultReasoningEffort(openModel)).toBeNull();
    expect(defaultReasoningEffort(emptyModel)).toBeNull();
    expect(() => validateServiceTier(null, undefined)).not.toThrow();
    expect(() => validateServiceTier(null, null)).not.toThrow();
    expect(() => validateServiceTier(openModel, 'custom')).not.toThrow();
    expect(() => validateServiceTier(emptyModel, 'custom')).not.toThrow();
    expect(() => validateServiceTier(null, 'priority')).toThrowError(
      new Error("Cannot select service tier 'priority' without a model"),
    );
    expect(() => validateServiceTier(models[0]!, 'unknown')).toThrowError(
      new Error("Service tier 'unknown' is not available for 'Fast'"),
    );
  });

  it('derives allowed approval presets from profiles and managed requirements', () => {
    const profiles = [
      { id: ':workspace', description: null, allowed: true },
      { id: ':danger-full-access', description: null, allowed: true },
      { id: ':danger-no-sandbox', description: null, allowed: false },
    ];
    expect(approvalPresetsForProfiles(profiles, null)).toStrictEqual([
      'ask-for-approval', 'approve-for-me', 'full-access',
    ]);
    expect(approvalPresetsForProfiles(profiles, configRequirements({
      allowedApprovalPolicies: ['on-request'],
      allowedApprovalsReviewers: ['user'],
    }))).toStrictEqual(['ask-for-approval']);
    expect(approvalPresetsForProfiles([
      { id: ':danger-no-sandbox', description: null, allowed: true },
    ], configRequirements({
      allowedApprovalPolicies: [],
      allowedApprovalsReviewers: [],
    }))).toStrictEqual(['full-access']);
    expect(approvalPresetsForProfiles(profiles.map((profile) => ({ ...profile, allowed: false })), null))
      .toStrictEqual([]);
  });

  it('applies every approval-policy and reviewer requirement independently', () => {
    const workspace = [{ id: ':workspace', description: null, allowed: true }];

    expect(approvalPresetsForProfiles(workspace, configRequirements({
      allowedApprovalPolicies: ['on-request'],
      allowedApprovalsReviewers: ['auto_review'],
    }))).toStrictEqual(['approve-for-me']);
    expect(approvalPresetsForProfiles(workspace, configRequirements({
      allowedApprovalPolicies: ['never'],
      allowedApprovalsReviewers: ['user', 'auto_review'],
    }))).toStrictEqual([]);
    expect(approvalPresetsForProfiles(workspace, configRequirements({
      allowedApprovalPolicies: ['on-request'],
      allowedApprovalsReviewers: ['guardian_subagent'],
    }))).toStrictEqual([]);
    expect(approvalPresetsForProfiles([
      { id: ':danger-full-access', description: null, allowed: true },
    ], configRequirements({
      allowedApprovalPolicies: ['never'],
      allowedApprovalsReviewers: ['auto_review'],
    }))).toStrictEqual([]);
  });

  it('maps approval presets and authoritative settings in both directions', () => {
    expect(approvalPresetStartParams('full-access')).toStrictEqual({
      approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access',
    });
    expect(approvalPresetStartParams('approve-for-me')).toStrictEqual({
      approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', permissions: ':workspace',
    });
    expect(approvalPresetUpdateParams('ask-for-approval')).toStrictEqual({
      approvalPolicy: 'on-request', approvalsReviewer: 'user', permissions: ':workspace',
    });
    expect(approvalPresetFromSettings('never', 'user', { type: 'dangerFullAccess' }, null)).toBe('full-access');
    expect(approvalPresetFromSettings('never', 'user', { type: 'readOnly', networkAccess: false }, { id: ':danger-full-access', extends: null }))
      .toBe('full-access');
    expect(approvalPresetFromSettings('never', 'user', { type: 'readOnly', networkAccess: false }, { id: ':danger-no-sandbox', extends: null }))
      .toBe('full-access');
    expect(approvalPresetFromSettings('on-request', 'auto_review', { type: 'readOnly', networkAccess: false }, null))
      .toBe('approve-for-me');
    expect(approvalPresetFromSettings('on-request', 'guardian_subagent', { type: 'readOnly', networkAccess: false }, null))
      .toBe('approve-for-me');
    expect(approvalPresetFromSettings('on-request', 'user', { type: 'readOnly', networkAccess: false }, null))
      .toBe('ask-for-approval');
    expect(approvalPresetFromSettings('untrusted', 'user', { type: 'readOnly', networkAccess: false }, null)).toBeNull();
  });

  it('requires both never-approval and unrestricted permissions for full access', () => {
    const readOnly = { type: 'readOnly', networkAccess: false } as const;
    const dangerProfile = { id: ':danger-full-access', extends: null };

    expect(approvalPresetFromSettings('never', 'user', readOnly, null)).toBeNull();
    expect(approvalPresetFromSettings('on-request', 'user', { type: 'dangerFullAccess' }, null))
      .toBe('ask-for-approval');
    expect(approvalPresetFromSettings('on-request', 'user', readOnly, dangerProfile))
      .toBe('ask-for-approval');
    expect(approvalPresetFromSettings('untrusted', 'auto_review', readOnly, null)).toBeNull();
  });

  it('computes local selection changes and rejects incompatible settings', () => {
    const current = snapshot({
      models,
      selectedModelId: 'fast-id',
      selectedReasoningEffort: 'low',
      selectedServiceTier: null,
      approvalPreset: 'ask-for-approval',
      planMode: false,
    });
    expect(nextSelection(current, {})).toStrictEqual({
      approvalPreset: 'ask-for-approval',
      planMode: false,
      selectedModelId: 'fast-id',
      selectedReasoningEffort: 'low',
      selectedServiceTier: null,
    });
    expect(nextSelection(current, {
      approvalPreset: 'full-access', modelId: 'default-id', planMode: true,
    })).toStrictEqual({
      approvalPreset: 'full-access',
      planMode: true,
      selectedModelId: 'default-id',
      selectedReasoningEffort: 'high',
      selectedServiceTier: null,
    });
    expect(nextSelection(current, { modelId: 'fast-id', reasoningEffort: 'medium' }).selectedReasoningEffort)
      .toBe('medium');
    expect(nextSelection({ ...current, selectedServiceTier: 'priority' }, { modelId: 'default-id' })
      .selectedServiceTier).toBeNull();
    expect(() => nextSelection(current, { modelId: 'missing' })).toThrow("Unknown model 'missing'");
    expect(() => nextSelection(current, { reasoningEffort: 'high' })).toThrow("not available for 'Fast'");
    expect(nextSelection(snapshot({ models: [], selectedModelId: null }), { planMode: true }))
      .toMatchObject({ selectedModelId: null, planMode: true });
  });

  it('reconciles reasoning and service tiers when the selected model changes', () => {
    const priorityDefault: CodexSurfaceModel = {
      ...models[0]!,
      id: 'priority-id',
      model: 'priority-model',
      defaultServiceTier: 'priority',
    };
    const current = snapshot({
      models: [priorityDefault, models[0]!, models[1]!],
      selectedModelId: 'priority-id',
      selectedReasoningEffort: 'low',
      selectedServiceTier: 'priority',
    });

    expect(nextSelection(current, { modelId: 'fast-id' })).toMatchObject({
      selectedModelId: 'fast-id',
      selectedReasoningEffort: 'low',
      selectedServiceTier: 'priority',
    });
    expect(nextSelection(current, { modelId: 'default-id' })).toMatchObject({
      selectedModelId: 'default-id',
      selectedReasoningEffort: 'high',
      selectedServiceTier: null,
    });
    expect(nextSelection(current, { serviceTier: null })).toMatchObject({
      selectedModelId: 'priority-id',
      selectedReasoningEffort: 'low',
      selectedServiceTier: null,
    });
    expect(() => nextSelection(current, { serviceTier: 'unknown' })).toThrowError(
      new Error("Service tier 'unknown' is not available for 'Fast'"),
    );

    const multiTierModel: CodexSurfaceModel = {
      ...models[0]!,
      id: 'multi-id',
      model: 'multi-model',
      serviceTiers: [
        { id: 'priority', name: 'Priority', description: 'Fast mode' },
        { id: 'flex', name: 'Flex', description: 'Flexible mode' },
      ],
    };
    expect(nextSelection({ ...current, models: [...current.models, multiTierModel] }, { modelId: 'multi-id' })
      .selectedServiceTier).toBe('priority');
    expect(nextSelection({ ...current, selectedServiceTier: 'incompatible' }, { modelId: 'fast-id' })
      .selectedServiceTier).toBeNull();
  });

  it('preserves open-ended model selections and validates explicit capability choices', () => {
    const openModel: CodexSurfaceModel = { id: 'open', model: 'open-model', displayName: 'Open' };
    const current = snapshot({
      models: [openModel],
      selectedModelId: 'open',
      selectedReasoningEffort: 'custom',
      selectedServiceTier: 'custom-tier',
    });

    expect(nextSelection(current, {})).toMatchObject({
      selectedModelId: 'open',
      selectedReasoningEffort: 'custom',
      selectedServiceTier: 'custom-tier',
    });
    expect(nextSelection(current, { modelId: 'open' })).toMatchObject({
      selectedModelId: 'open',
      selectedReasoningEffort: 'custom',
      selectedServiceTier: null,
    });
    expect(nextSelection(current, { modelId: 'open', serviceTier: 'another-tier' }))
      .toMatchObject({
        selectedModelId: 'open',
        selectedReasoningEffort: 'custom',
        selectedServiceTier: 'another-tier',
      });
    expect(nextSelection(current, { reasoningEffort: 'another', serviceTier: 'another-tier' }))
      .toMatchObject({
        selectedModelId: 'open',
        selectedReasoningEffort: 'another',
        selectedServiceTier: 'another-tier',
      });
    expect(() => nextSelection(snapshot({ models: [], selectedModelId: null }), { serviceTier: 'priority' }))
      .toThrowError(new Error("Cannot select service tier 'priority' without a model"));
    expect(nextSelection(snapshot({
      models: [],
      selectedModelId: null,
      selectedServiceTier: 'stale-tier',
    }), {}).selectedServiceTier).toBe('stale-tier');
    expect(nextSelection(snapshot({
      models,
      selectedModelId: 'fast-id',
      selectedReasoningEffort: null,
    }), {}).selectedReasoningEffort).toBeNull();
  });

  it('projects app-server session and thread settings with safe fallbacks', () => {
    const current = snapshot({
      approvalPreset: 'ask-for-approval',
      models,
      planMode: true,
      selectedModelId: 'fast-id',
      selectedReasoningEffort: 'low',
    });
    const session = sessionSelection({
      model: 'fast-model',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: { type: 'readOnly' },
      activePermissionProfile: null,
      reasoningEffort: null,
      serviceTier: null,
    } as v2.ThreadStartResponse, models, current);
    expect(session).toStrictEqual({
      approvalPreset: 'approve-for-me',
      planMode: true,
      selectedModelId: 'fast-id',
      selectedReasoningEffort: 'medium',
      selectedServiceTier: null,
    });

    const thread = threadSettingsSelection({
      model: 'missing',
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly' },
      activePermissionProfile: null,
      effort: 'high',
      collaborationMode: { mode: 'plan', settings: { model: 'default-model', reasoning_effort: 'high', developer_instructions: null } },
    } as v2.ThreadSettings, models, current);
    expect(thread).toStrictEqual({
      approvalPreset: 'ask-for-approval',
      planMode: true,
      selectedModelId: 'default-id',
      selectedReasoningEffort: 'high',
      selectedServiceTier: null,
    });

    expect(sessionSelection({
      model: 'missing', approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: { type: 'readOnly' },
      activePermissionProfile: null, reasoningEffort: null,
    } as v2.ThreadStartResponse, [], current)).toMatchObject({
      approvalPreset: 'ask-for-approval', selectedModelId: 'fast-id', selectedReasoningEffort: null,
    });
  });

  it('distinguishes omitted session values from explicit null values', () => {
    const current = snapshot({
      models,
      selectedModelId: 'fast-id',
      selectedReasoningEffort: 'low',
      selectedServiceTier: 'priority',
    });
    const baseResponse = {
      model: 'fast-model',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly' },
      activePermissionProfile: null,
      reasoningEffort: 'low',
    } as v2.ThreadStartResponse;

    expect(sessionSelection(baseResponse, models, current).selectedServiceTier).toBeNull();
    expect(sessionSelection({ ...baseResponse, serviceTier: null }, models, current).selectedServiceTier)
      .toBeNull();
    expect(sessionSelection({ ...baseResponse, serviceTier: 'priority' }, models, current).selectedServiceTier)
      .toBe('priority');

    const threadWithoutCatalog = threadSettingsSelection({
      model: 'missing',
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly' },
      activePermissionProfile: null,
      effort: null,
      collaborationMode: {
        mode: 'default',
        settings: { model: 'missing', reasoning_effort: null, developer_instructions: null },
      },
    } as v2.ThreadSettings, [], current);
    expect(threadWithoutCatalog.selectedModelId).toBe('fast-id');
  });

  it('builds turn settings only from available or explicit values', () => {
    expect(collaborationMode(true, 'fast-model', 'medium')).toStrictEqual({
      mode: 'plan',
      settings: { model: 'fast-model', reasoning_effort: 'medium', developer_instructions: null },
    });
    expect(collaborationMode(false, 'fast-model', null).mode).toBe('default');
    expect(turnSettings(snapshot({ models: [], selectedModelId: null }), {})).toStrictEqual({});
    expect(turnSettings(snapshot({
      models,
      selectedModelId: 'fast-id',
      selectedReasoningEffort: 'low',
      selectedServiceTier: null,
      planMode: false,
    }), { model: 'explicit', reasoningEffort: 'high', planMode: true, serviceTier: 'priority' })).toStrictEqual({
      model: 'explicit',
      effort: 'high',
      serviceTier: 'priority',
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'explicit', reasoning_effort: 'high', developer_instructions: null },
      },
    });
  });
});

function snapshot(overrides: Partial<CodexSurfaceSnapshot> = {}): CodexSurfaceSnapshot {
  return Object.assign(initialSurfaceSnapshot({
    ...initialAuthentication(),
    status: 'loaded',
  }), {
    status: 'ready',
    modelCatalogStatus: 'loaded',
    skillCatalogStatus: 'loaded',
    pluginCatalogStatus: 'loaded',
    ...overrides,
  });
}
