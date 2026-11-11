import { claudeWorkingDirectory } from './working-directory';
import { claudeHarnessCapabilities } from '../../capabilities';
import type { ProviderEvent, ProviderPermissionModeResult } from '../../driver';
import type {
  Agent,
  ProviderCapabilities,
  ProviderModelOption,
  ProviderRuntimeStatus,
  ProviderSkillSummary,
} from '../../contracts/index';
import { claudeModelOptions, claudeModelOptionsFromSdk } from './models';
import { listClaudeSkills } from './skills';
import type { ClaudeAvailableModel, ClaudeTurnTransport } from './transport';

export type ClaudeProviderCatalogOptions = {
  homeDir?: string;
  emit: (event: ProviderEvent) => void;
  transport: ClaudeTurnTransport;
};

/** Owns Claude runtime capabilities, models, skills, and persisted defaults. */
export class ClaudeProviderCatalog {
  private modelCatalog = claudeModelOptions.map((model) => ({ ...model }));
  private modelCatalogDiscovery: Promise<void> | null = null;

  constructor(private readonly options: ClaudeProviderCatalogOptions) {}

  getRuntimeStatus(): ProviderRuntimeStatus {
    return {
      provider: 'claude',
      status: 'notConfigured',
    };
  }

  getCapabilities(): ProviderCapabilities {
    return {
      ...claudeHarnessCapabilities,
      reasoningEffort: this.modelCatalog.some((model) => (model.supportedReasoningEfforts?.length ?? 0) > 0),
      serviceTier: this.modelCatalog.some((model) => (model.serviceTiers?.length ?? 0) > 0),
    };
  }

  async listModels(agent: Agent): Promise<ProviderModelOption[]> {
    await this.discoverModels(agent);
    return this.modelCatalog.map((model) => ({ ...model }));
  }

  async listSkills(agent: Agent): Promise<ProviderSkillSummary[]> {
    return listClaudeSkills(agent, { homeDir: this.options.homeDir });
  }

  setPermissionMode(agent: Agent, mode: string): ProviderPermissionModeResult {
    const defaults = agent.providerDefaults?.kind === 'claude'
      ? agent.providerDefaults
      : { kind: 'claude' as const };
    return {
      providerDefaults: {
        ...defaults,
        permissionMode: mode,
      },
    };
  }

  async refreshModels(): Promise<void> {
    const availableModels = await this.options.transport.listModels?.();
    if (availableModels?.length) this.applyModels(availableModels);
  }

  private async discoverModels(agent: Agent): Promise<void> {
    if (!this.options.transport.discoverModels || this.modelCatalogDiscovery) {
      await this.modelCatalogDiscovery;
      return;
    }
    const discovery = this.options.transport.discoverModels({ cwd: claudeWorkingDirectory(agent) })
      .then((availableModels) => {
        if (availableModels?.length) this.applyModels(availableModels);
      })
      .catch(() => undefined);
    this.modelCatalogDiscovery = discovery;
    try {
      await discovery;
    } finally {
      if (this.modelCatalogDiscovery === discovery) this.modelCatalogDiscovery = null;
    }
  }

  private applyModels(availableModels: readonly ClaudeAvailableModel[]): void {
    const models = claudeModelOptionsFromSdk(availableModels);
    if (!models.length || sameModelCatalog(this.modelCatalog, models)) return;
    this.modelCatalog = models;
    this.options.emit({
      provider: 'claude',
      type: 'models.changed',
      payload: { models: this.modelCatalog.map((model) => ({ ...model })) },
    });
    this.options.emit({
      provider: 'claude',
      type: 'provider.statusChanged',
      payload: {
        provider: 'claude',
        status: 'running',
        capabilities: this.getCapabilities(),
      },
    });
  }
}

function sameModelCatalog(left: readonly ProviderModelOption[], right: readonly ProviderModelOption[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
