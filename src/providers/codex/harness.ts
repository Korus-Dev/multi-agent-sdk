import type { ProviderContext } from '../../context';
import type { ProviderCapabilities, ProviderConversationRef, ProviderDefaults, ProviderSessionData } from '../../contracts';
import type { ProviderDriver, ProviderEvent } from '../../driver';
import type { HarnessPromptScope } from '../../generation';
import type { HarnessCapabilities, Turn } from '../../consumer-types';
import type { HarnessConversationConfig, HarnessOptions } from '../../options';
import { ProviderHarness } from '../../harness';
import { codexHarnessCapabilities } from '../../capabilities';
import { harnessContext, mcpEndpoints, providerHome, sharedProviderOptions, type SharedProviderOptions } from '../../harness-options';
import { replicaProjection, type HarnessProjection } from '../../harness-projection';
import { createCodexConversationReplica } from '../../core/codex-conversation-replica';
import { approvalAgentRequest, requestFromClientRequest } from '../../conversations/agent-request';
import { createCodexHost, type CodexHost, type CodexHostOptions } from './index';
import { mcpServerConfig } from './host-mcp';
import { CodexHostAdapter, conversationMessages, type CodexHostAdapterOptions } from './host-adapter';
import { CodexHostController } from './host-controller';

export type CodexProviderOptions<Context extends ProviderContext = ProviderContext> = SharedProviderOptions<Context> & {
  codex?: {
    host?: CodexHostOptions;
    adapter?: CodexHostAdapterOptions<Context>;
    /** Tests supply a ready host instead of starting one. */
    existingHost?: CodexHost;
    /** Per-conversation configuration the app adds on start or resume. */
    conversationConfig?: (context: Context, scope?: HarnessPromptScope) => HarnessConversationConfig | Promise<HarnessConversationConfig>;
  };
};
type CodexBinding<Context> = { context: Context; scope?: HarnessPromptScope };

const permissionOf = (defaults: ProviderDefaults) => defaults.kind === 'codex' ? defaults.approvalPreset : undefined;

export class CodexHarness extends ProviderHarness<'codex'> {
  static readonly provider = 'codex';
  static readonly capabilities = codexHarnessCapabilities;
  /** A fresh session record for a conversation id. */
  static sessionData(id: string): ProviderSessionData { return { kind: 'codex', threadId: id }; }

  constructor(native: ProviderDriver<ProviderContext, ProviderEvent>) { super('codex', native); }

  /** Maps app-facing options onto the Codex runtime. */
  static mapOptions(options: HarnessOptions): CodexProviderOptions {
    const context = (native: ProviderContext) => harnessContext(native, permissionOf);
    const conversationConfig = options.codex?.conversationConfig;
    return {
      ...sharedProviderOptions(options, permissionOf),
      codex: {
        ...(conversationConfig ? { conversationConfig: (native: ProviderContext, scope?: HarnessPromptScope) => conversationConfig(context(native), scope?.mcpServers?.[0]?.url ? { mcpServerUrl: scope.mcpServers[0].url } : undefined) } : {}),
        host: {
          ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
          ...(options.codex?.onRequestSettled ? { onRequestSettled: info => options.codex!.onRequestSettled!(info) } : {}),
          ...(options.codex?.defaultModel ? { conversationDefaults: options.codex.defaultModel } : {}),
          ...(options.codex?.readOnly ? { permissionMode: 'read-only' as const, approvalMode: 'never' as const } : {}),
          loadingStrategy: 'lazy', historyItemsView: 'summary', originalHistoryImages: true, originalHistoryUsage: true,
          transport: { ...(options.codex?.launch?.command ? { command: options.codex.launch.command } : {}), ...(options.codex?.launch?.env ? { env: options.codex.launch.env as NodeJS.ProcessEnv } : {}), ...(options.codex?.config ? { configOverrides: [...options.codex.config] } : {}) },
        },
        adapter: {
          inheritNativeSettings: true,
          ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
          ...(options.codex?.defaultModel ? { defaultModel: options.codex.defaultModel } : {}),
          displayName: native => native.name ?? native.id,
          ...(options.codex?.syncTitle ? { shouldSyncTitle: native => options.codex!.syncTitle!(context(native)) } : {}),
          ...(options.codex?.retainedSessions ? { retainedSessions: native => options.codex!.retainedSessions!(context(native)) } : {}),
          ...(options.codex?.imageModel || options.log ? { images: {
            ...(options.codex?.imageModel ? { selectModel: models => options.codex!.imageModel!(models as never) } : {}),
            ...(options.log ? { log: (message, details) => options.log!('warn', 'image-generation', message, details) } : {}),
          } } : {}),
        },
      },
    };
  }

  /** Starts the Codex runtime without connecting, authenticating or executing a turn. */
  static createHost<Context extends ProviderContext = ProviderContext>(options: CodexProviderOptions<Context>): ProviderDriver<Context, ProviderEvent> {
    const home = providerHome(options);
    const nativeHostOptions = options.codex?.host ?? {};
    if (home && nativeHostOptions.codexHome && home !== nativeHostOptions.codexHome) throw new Error('Runtime home conflicts with codex.host.codexHome.');
    const hostOptions = { ...nativeHostOptions, ...(home ? { codexHome: home } : {}) };
    const host = options.codex?.existingHost ?? createCodexHost({ ...hostOptions, autoSelectFirstConversation: false,
      clientInfo: hostOptions.clientInfo ?? { name: options.client.name, title: options.client.title ?? options.client.name, version: options.client.version ?? '1' },
      extensions: [...hostOptions.extensions ?? [], { configureConversation: ({ extensionContext }) => {
        const binding = extensionContext as CodexBinding<Context> | undefined;
        if (!binding?.context) return {};
        const build = (app?: HarnessConversationConfig) => {
          const instructions = binding.scope?.developerInstructions ?? app?.developerInstructions ?? options.instructions?.(binding.context);
          return {
            ...(app?.config ? { config: app.config } : {}),
            ...(!binding.scope && options.mcpServers ? { config: { ...app?.config, ...mcpServerConfig(mcpEndpoints(options, 'codex', codexHarnessCapabilities, binding.context).map(server => ({ name: server.name, transport: { type: 'http', url: server.url }, ...(server.enabledTools ? { enabledTools: [...server.enabledTools] } : {}), ...(server.approval === 'auto' ? { toolApprovalMode: 'auto' as const } : {}), ...(server.required === undefined ? {} : { required: server.required }) }))) } } : {}),
            ...(instructions === undefined ? {} : { developerInstructions: instructions }),
          };
        };
        const app = options.codex?.conversationConfig?.(binding.context, binding.scope);
        return app instanceof Promise ? app.then(build) : build(app);
      } }],
    });
    const adapter = new CodexHostAdapter<Context>(host, () => host.close(), {
      ...options.codex?.adapter,
      extensionContext: (context, scope) => ({ context, scope } satisfies CodexBinding<Context>),
      formatPrompt: options.formatPrompt ?? options.codex?.adapter?.formatPrompt,
    });
    return new CodexHostController(adapter);
  }

  protected identityOf(data: Record<string, unknown>): unknown { return data.threadId; }
  protected conversationRef(data: ProviderSessionData): ProviderConversationRef { return { provider: 'codex', threadId: (data as { threadId: string }).threadId }; }
  protected permissionDefaults(id: string): Partial<ProviderDefaults> { return { approvalPreset: id } as Partial<ProviderDefaults>; }
  protected permissionOf(defaults: ProviderDefaults): string | undefined { return permissionOf(defaults); }
  protected permissionOptions(capabilities: ProviderCapabilities): HarnessCapabilities['permissions'] {
    return (capabilities.approvalPresets ?? []).map(id => ({ id, ...(id === 'full-access' ? { dangerous: true } : {}) }));
  }
  /** Codex reports its permission as the approval preset in settings events. */
  protected permissionFromEvent(event: ProviderEvent): string | null | undefined {
    return event.type === 'conversation.settingsUpdated' ? event.payload.settings.approvalPreset : undefined;
  }
  protected async applyPermission(context: ProviderContext, id: string): Promise<string> {
    if (!this.native.setApprovalPreset) throw new Error('Permission updates are unavailable.');
    const result = await this.native.setApprovalPreset(context, id as import('../../contracts').ApprovalPreset);
    context.providerSession = result.providerSession;
    context.providerDefaults = { ...context.providerDefaults, kind: 'codex', approvalPreset: result.approvalPreset };
    return result.approvalPreset;
  }
  protected createProjection(): HarnessProjection {
    return replicaProjection({
      snapshotEvent: 'codex.conversationSnapshotChanged', conversationEvent: 'codex.conversationEventReceived', label: 'Codex',
      create: createCodexConversationReplica,
      apply: (replica, event) => replica.apply(event),
      state: (replica, event) => {
        const s = replica.getSnapshot();
        return { messages: conversationMessages(s.messages, event.agentId!), busy: s.busy, activeTurnId: s.activeTurnId, turns: s.turns satisfies Turn[], answeredClientRequestIds: s.answeredClientRequestIds, historyLoading: s.historyLoading, historyState: s.historyState,
          requests: [...s.approvals.map(approvalAgentRequest), ...s.clientRequests.map(request => requestFromClientRequest(request, { conversationId: s.activeConversationId, turnId: request.turnId ?? undefined }))],
          selection: { model: s.models.find(model => model.id === s.selectedModelId)?.model ?? s.selectedModelId, reasoningEffort: s.selectedReasoningEffort, serviceTier: s.selectedServiceTier },
          permission: s.approvalPreset, planMode: s.planMode,
          error: s.error, contextUsage: s.contextUsage, goal: s.goal,
          plan: s.executionPlan ? { threadId: s.activeConversationId, turnId: s.executionPlan.turnId, kind: 'execution',
            status: s.turns.find(t => t.id === s.executionPlan!.turnId)?.status ?? 'inProgress',
            explanation: s.executionPlan.explanation ?? '', steps: [...s.executionPlan.steps], markdown: s.executionPlan.markdown, updatedAt: s.executionPlan.updatedAt } : null };
      },
    });
  }
}
