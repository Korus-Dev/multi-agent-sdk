import { isAbsolute } from 'node:path';
import { cursorRuntime } from './providers/cursor/runtime';
import type { AgentBackend } from './contracts';
import type { HarnessContext, HarnessDriver, HarnessEvent, HarnessPromptScope } from './driver';
import type { HarnessMcpEndpoint } from './generation';
import type { PromptPart } from './core/surface';
import { createCodexSurface, type CodexSurfaceOptions } from './providers/codex';
import { mcpServerConfig } from './providers/codex/codex-surface-mcp';
import { CodexSurfaceAgentAdapter, type CodexHostOptions } from './providers/codex/host';
import { CodexBackendDriver } from './providers/codex/driver';
import { ClaudeConversationHost, type ClaudeHostOptions } from './providers/claude/host';
import { ClaudeAgentSdkTransport, type ClaudeAgentSdkTransportOptions } from './providers/claude/agent-sdk-transport';
import type { ClaudeTurnTransport } from './providers/claude/transport';
import { CursorHost, type CursorHostOptions } from './providers/cursor/host';
import { AntigravityHost, type AntigravityHostOptions } from './providers/antigravity/host';
import { validateMcpPolicy } from './mcp-policy';
import { sessionMcpServer } from './acp/mcp-bridge';

/** Shared app ports; provider-specific transport configuration stays in the named adapter options. */
export type HarnessOptions<Context extends HarnessContext = HarnessContext> = {
  client: { name: string; title?: string; version?: string; metadataDirectory?: string };
  /** Provider configuration/data home; omitted preserves native standard-home discovery. */
  home?: string;
  stateDirectory?: () => string;
  instructions?: (context: Context) => string | undefined;
  mcpServers?: (context: Context) => readonly HarnessMcpEndpoint[];
  formatPrompt?: (prompt: string, content: readonly PromptPart[] | undefined) => string;
  codex?: { surface?: CodexSurfaceOptions; host?: CodexHostOptions<Context> };
  claude?: { transport?: ClaudeTurnTransport; transportOptions?: ClaudeAgentSdkTransportOptions; host?: ClaudeHostOptions<Context> };
  cursor?: CursorHostOptions<Context>;
  antigravity?: AntigravityHostOptions<Context>;
};
type CodexContext<Context> = { context: Context; scope?: HarnessPromptScope };

/** Creates a native adapter without connecting, authenticating or executing a model turn.
 * @deprecated Prefer createNativeHarnessDriver from /native; the root factory is neutral.
 */
export function createHarnessDriver<Context extends HarnessContext = HarnessContext>(backend: AgentBackend, options: HarnessOptions<Context>): HarnessDriver<Context, HarnessEvent> {
  const home = options.home?.trim();
  if (options.home !== undefined && (!home || !isAbsolute(home))) throw new Error('Runtime home must be a nonempty absolute path.');
  const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  // One Claude home per application process; close before switching profiles.
  if (home && backend === 'claude') process.env.CLAUDE_CONFIG_DIR = home;
  const endpoints = (context: Context) => {
    const servers = options.mcpServers?.(context) ?? [];
    validateMcpPolicy(servers, backend);
    return servers;
  };
  const bridges = (context: Context) => endpoints(context).map(server => sessionMcpServer(server.url, server.name, server.enabledTools ? [...server.enabledTools] : undefined));
  if (backend === 'cursor') return new CursorHost({ ...options.cursor,
    ...(home ? { runtime: cursorRuntime({ isolated: true, homePath: home, environmentHome: home }, options.cursor?.runtime?.environment) } : {}),
    stateDirectory: options.stateDirectory ?? options.cursor?.stateDirectory,
    instructions: options.instructions ?? options.cursor?.instructions,
    formatPrompt: options.formatPrompt ?? options.cursor?.formatPrompt,
    ...(options.mcpServers ? { mcpServers: bridges } : {}),
    sessionOptions: { ...options.cursor?.sessionOptions, client: options.client },
  });
  if (backend === 'antigravity') return new AntigravityHost({ ...options.antigravity,
    ...(home ? { home: () => home } : {}),
    stateDirectory: options.stateDirectory ?? options.antigravity?.stateDirectory,
    instructions: options.instructions ?? options.antigravity?.instructions,
    formatPrompt: options.formatPrompt ?? options.antigravity?.formatPrompt,
    ...(options.mcpServers ? { mcpServers: bridges } : {}),
    client: { ...options.antigravity?.client, ...options.client },
  });
  if (backend === 'claude') {
    const driver = new ClaudeConversationHost(options.claude?.transport ?? new ClaudeAgentSdkTransport({ ...options.claude?.transportOptions, client: { ...options.claude?.transportOptions?.client, ...options.client } }), undefined, {
    ...options.claude?.host,
    configurePrompt: context => {
      const defaults = options.claude?.host?.configurePrompt?.(context) ?? {};
      const servers = endpoints(context);
      const [primary, ...hosted] = servers;
      return { ...defaults,
        ...(options.instructions ? { appendSystemPrompt: options.instructions(context) } : {}),
        ...(options.formatPrompt ? { formatPrompt: options.formatPrompt } : {}),
        ...(options.mcpServers ? { mcpServerUrl: primary?.url ?? null, mcpServerName: primary?.name,
          hostedMcpServerUrls: Object.fromEntries(hosted.map(server => [server.name, server.url])),
          enabledMcpTools: Object.fromEntries(servers.filter(server => server.enabledTools !== undefined).map(server => [server.name, [...server.enabledTools!]])),
          allowedTools: servers.filter(server => server.approval === 'auto').flatMap(server => (server.enabledTools ?? ['*']).map(tool => `mcp__${server.name}__${tool}`)),
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
      if (home && process.env.CLAUDE_CONFIG_DIR === home) {
        if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
      }
    };
    return driver;
  }
  if (backend !== 'codex') throw new Error(`Unsupported harness: ${backend}`);
  const nativeSurfaceOptions = options.codex?.surface ?? {};
  if (home && nativeSurfaceOptions.codexHome && home !== nativeSurfaceOptions.codexHome) throw new Error('Runtime home conflicts with codex.surface.codexHome.');
  const surfaceOptions = { ...nativeSurfaceOptions, ...(home ? { codexHome: home } : {}) };
  const surface = createCodexSurface({ ...surfaceOptions, autoSelectFirstConversation: false,
    clientInfo: surfaceOptions.clientInfo ?? { name: options.client.name, title: options.client.title ?? options.client.name, version: options.client.version ?? '1' },
    extensions: [...surfaceOptions.extensions ?? [], { configureConversation: ({ extensionContext }) => {
      const binding = extensionContext as CodexContext<Context> | undefined;
      if (!binding?.context) return {};
      const instructions = binding.scope?.developerInstructions ?? options.instructions?.(binding.context);
      return {
        ...(!binding.scope && options.mcpServers ? { config: mcpServerConfig(endpoints(binding.context).map(server => ({ name: server.name, transport: { type: 'http', url: server.url }, ...(server.enabledTools ? { enabledTools: [...server.enabledTools] } : {}), ...(server.approval === 'auto' ? { toolApprovalMode: 'auto' as const } : {}), ...(server.required === undefined ? {} : { required: server.required }) }))) } : {}),
        ...(instructions === undefined ? {} : { developerInstructions: instructions }),
      };
    } }],
  });
  const adapter = new CodexSurfaceAgentAdapter<Context>(surface, () => surface.close(), {
    ...options.codex?.host,
    extensionContext: (context, scope) => ({ context, scope } satisfies CodexContext<Context>),
    formatPrompt: options.formatPrompt ?? options.codex?.host?.formatPrompt,
  });
  return new CodexBackendDriver(adapter);
}
