import type { ProviderContext } from './context';
import type { HarnessContext } from './consumer-types';
import type { HarnessOptions } from './options';
import type { ProviderOptions } from './provider-factory';
import { resolveAcpRuntime } from './providers/antigravity/runtime';
import { statusFromSnapshot } from './providers/codex/status';
import { resolveClaudeLaunch } from './providers/claude/claude-command';

/** The slice of a native context an app sees. */
export function consumerContext(context: ProviderContext): HarnessContext {
  const d = context.providerDefaults;
  return { id: context.id, folder: context.folder, ...(context.name === undefined ? {} : { name: context.name }),
    ...(d ? { defaults: { model: d.model ?? undefined, reasoningEffort: d.reasoningEffort ?? undefined, serviceTier: d.serviceTier,
      permission: d.kind === 'codex' ? d.approvalPreset : d.permissionMode } } : {}),
  };
}

/** Translates the app-facing options into the provider-specific ones. Provider engines never appear in the public options. */
export function providerOptions(options: HarnessOptions): ProviderOptions {
  const instructions = options.instructions;
  const context = consumerContext;
  const log = options.log;
  return {
    client: options.client,
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
    ...(instructions ? { instructions: (native: ProviderContext) => instructions(context(native), { planMode: false }) } : {}),
    ...(options.mcpServers ? { mcpServers: (native: ProviderContext) => options.mcpServers!(context(native)) } : {}),
    ...(options.formatPrompt ? { formatPrompt: options.formatPrompt } : {}),
    ...(options.trustedMcpServerName ? { trustedMcpServerName: options.trustedMcpServerName } : {}),
    ...(options.codex?.conversationConfig ? { codexConversationConfig: (native, scope) => options.codex!.conversationConfig!(context(native), scope?.mcpServers?.[0]?.url ? { mcpServerUrl: scope.mcpServers[0].url } : undefined) } : {}),
    codex: {
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
        ...(options.statusText ? { runtimeStatusDetail: options.statusText } : {}),
        ...(options.waitingText ? { statusFromSnapshot: snapshot => statusFromSnapshot(snapshot, { awaitingApproval: options.waitingText!.approval ?? 'Waiting for approval', awaitingUserInput: options.waitingText!.input ?? 'Waiting for your answer' }) } : {}),
        ...(options.codex?.imageModel || log ? { images: {
          ...(options.codex?.imageModel ? { selectModel: models => options.codex!.imageModel!(models as never) } : {}),
          ...(log ? { log: (message, details) => log('warn', 'image-generation', message, details) } : {}),
        } } : {}),
      },
    },
    claude: {
      transportOptions: {
        client: { name: options.client.name, ...(options.trustedMcpServerName ? { mcpServerName: options.trustedMcpServerName } : {}), ...(options.client.entrypoint ? { entrypoint: options.client.entrypoint } : {}), ...(options.client.clientApp ? { clientApp: options.client.clientApp } : {}) },
        ...(options.claude?.launch ? { resolveLaunch: (command?: string, env?: NodeJS.ProcessEnv) => resolveClaudeLaunch(command, env, {}, ((found?: string, environment?: NodeJS.ProcessEnv) => options.claude!.launch!(found, environment)) as never) } : {}),
        ...(options.generationMcpServers ? { validateMcpServers: options.generationMcpServers } : {}),
        ...(options.claude?.decideTool ? { permissionResult: (tool: string, input: Record<string, unknown>) => options.claude!.decideTool!(tool, input) } : {}),
        ...(options.claude?.disallowedTools ? { disallowedTools: [...options.claude.disallowedTools] } : {}),
        ...(log ? { log: (level, component, message, details) => log(level, component, message, details) } : {}),
      },
      host: {
        ...(options.trustedMcpServerName === undefined && !options.mcpServerLabel ? {} : { mcpServerLabel: options.mcpServerLabel ?? (() => undefined) }),
        ...(options.statusText ? { statusText: status => options.statusText!(status) } : {}),
        ...(options.claude?.presentMcpInput ? { toolOptions: { presentMcpInput: options.claude.presentMcpInput } } : {}),
        ...(log ? { log: (level, component, message, details) => log(level, component, message, details) } : {}),
      },
    },
    cursor: {
      ...(options.cursor?.command ? { resolveCommand: options.cursor.command } : {}),
      ...(options.cursor?.steeringFallback ? { steeringFallbackEnabled: options.cursor.steeringFallback } : {}),
      ...(options.trustedMcpServerName ? { trustedMcpServerName: options.trustedMcpServerName } : {}),
      sessionOptions: { client: options.client, ...(options.cursor?.command ? { resolveCommand: options.cursor.command } : {}) },
    },
    antigravity: {
      client: { ...options.client, ...(options.trustedMcpServerName ? { trustedMcpServerName: options.trustedMcpServerName } : {}) },
      ...(instructions ? { instructions: (native: ProviderContext, { planMode }: { planMode: boolean }) => instructions(context(native), { planMode }) } : {}),
      ...(options.antigravity?.command || options.antigravity?.harnessPath ? { resolveRuntime: () => resolveAcpRuntime(options.stateDirectory?.(), { command: options.antigravity?.command, harnessPath: options.antigravity?.harnessPath }) } : {}),
    },
  };
}
