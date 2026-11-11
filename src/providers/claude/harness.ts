import type { ProviderContext } from '../../context';
import type { ProviderSessionData } from '../../contracts';
import type { ProviderDriver, ProviderEvent } from '../../driver';
import type { SessionSelection } from '../../consumer-types';
import type { HarnessOptions } from '../../options';
import { SessionHarness } from '../../session-harness';
import { claudeHarnessCapabilities } from '../../capabilities';
import { mcpEndpoints, providerHome, sharedProviderOptions, type SharedProviderOptions } from '../../harness-options';
import { replicaProjection, transcriptState, type HarnessProjection } from '../../harness-projection';
import { createClaudeConversationReplica } from '../../conversations/claude-conversation-replica';
import type { WorkPhaseRules } from '../../conversations/work-phases';
import { ClaudeHost, type ClaudeHostOptions } from './host';
import { ClaudeAgentSdkTransport, type ClaudeAgentSdkTransportOptions } from './agent-sdk-transport';
import type { ClaudeTurnTransport } from './transport';
import { resolveClaudeLaunch } from './claude-command';
import { claudeActivity } from './activity';

export type ClaudeProviderOptions<Context extends ProviderContext = ProviderContext> = SharedProviderOptions<Context> & {
  claude?: { transport?: ClaudeTurnTransport; transportOptions?: ClaudeAgentSdkTransportOptions; host?: ClaudeHostOptions<Context> };
};

const permissionOf = (defaults: import('../../contracts').ProviderDefaults) => 'permissionMode' in defaults ? defaults.permissionMode : undefined;

export class ClaudeHarness extends SessionHarness<'claude'> {
  static readonly provider = 'claude';
  static readonly capabilities = claudeHarnessCapabilities;
  /** A fresh session record for a conversation id. */
  static sessionData(id: string): ProviderSessionData { return { kind: 'claude', sessionId: id, transport: 'stdio' }; }

  constructor(native: ProviderDriver<ProviderContext, ProviderEvent>, rules?: WorkPhaseRules) { super('claude', native, rules); }

  /** Maps app-facing options onto the Claude runtime. */
  static mapOptions(options: HarnessOptions): ClaudeProviderOptions {
    const log = options.log;
    return {
      ...sharedProviderOptions(options, permissionOf),
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
          ...(options.isBookkeepingTool ? { isBookkeepingTool: options.isBookkeepingTool } : {}),
          ...(log ? { log: (level, component, message, details) => log(level, component, message, details) } : {}),
        },
      },
    };
  }

  /** Starts the Claude runtime without connecting, authenticating or executing a turn. */
  static createHost<Context extends ProviderContext = ProviderContext>(options: ClaudeProviderOptions<Context>): ProviderDriver<Context, ProviderEvent> {
    const home = providerHome(options);
    const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
    // One Claude home per application process; close before switching profiles.
    if (home) process.env.CLAUDE_CONFIG_DIR = home;
    const driver = new ClaudeHost(options.claude?.transport ?? new ClaudeAgentSdkTransport({ ...options.claude?.transportOptions, client: { ...options.claude?.transportOptions?.client, ...options.client } }), undefined, {
      contextForConversation: (ref, id) => ({ id, name: id, folder: ref.folder, provider: 'claude', providerSession: { kind: 'claude', sessionId: ref.sessionId, transport: 'stdio' } }) as Context,
      ...options.claude?.host,
      configurePrompt: context => {
        const defaults = options.claude?.host?.configurePrompt?.(context) ?? {};
        const servers = mcpEndpoints(options, 'claude', claudeHarnessCapabilities, context);
        const [primary, ...hosted] = servers;
        return { title: context.name ?? context.id, ...defaults,
          ...(options.instructions ? { appendSystemPrompt: options.instructions(context) } : {}),
          ...(options.formatPrompt ? { formatPrompt: options.formatPrompt } : {}),
          ...(options.mcpServers ? { mcpServerUrl: primary?.url ?? null, mcpServerName: primary?.name,
            hostedMcpServerUrls: Object.fromEntries(hosted.map(server => [server.name, server.url])),
            enabledMcpTools: Object.fromEntries(servers.filter(server => server.enabledTools !== undefined).map(server => [server.name, [...server.enabledTools!]])),
            allowedTools: servers.filter(server => server.approval === 'auto' || server.name === options.trustedMcpServerName).flatMap(server => (server.enabledTools ?? ['*']).map(tool => `mcp__${server.name}__${tool}`)),
          } : {}),
        };
      },
    });
    if (!home) return driver;
    const close = driver.close.bind(driver);
    let closed = false;
    driver.close = async () => {
      if (closed) return;
      await close();
      closed = true;
      if (process.env.CLAUDE_CONFIG_DIR === home) {
        if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
      }
    };
    return driver;
  }

  protected override validateSessionData(data: Record<string, unknown>): void {
    if (!['stdio', 'websocket'].includes(String(data.transport))) throw new Error('Invalid Claude transport.');
  }
  /** Claude records the model and effort it ran with in its session data. */
  protected override selectionFromSession(data: ProviderSessionData, previous: ProviderSessionData | undefined, current: SessionSelection | undefined, preserveRuntime: boolean): SessionSelection | undefined {
    if (data.kind !== 'claude') return undefined;
    const runtime = preserveRuntime && previous?.kind === 'claude' && previous.sessionId === data.sessionId ? current : undefined;
    return {
      ...runtime,
      ...(data.model !== undefined && data.model !== runtime?.model ? { reasoningEffort: undefined, serviceTier: undefined } : {}),
      ...(data.model === undefined ? {} : { model: data.model }),
      ...(data.reasoningEffort === undefined ? {} : { reasoningEffort: data.reasoningEffort }),
    };
  }
  protected activityOf(frame: ProviderEvent) { return claudeActivity(frame); }
  protected createProjection(): HarnessProjection {
    return replicaProjection({
      snapshotEvent: 'claude.conversationSnapshotChanged', conversationEvent: 'claude.conversationEventReceived', label: 'Claude',
      create: snapshot => createClaudeConversationReplica(snapshot, this.phaseRules),
      apply: (replica, event) => replica.apply(event),
      state: replica => transcriptState(replica.getSnapshot()),
    });
  }
}
