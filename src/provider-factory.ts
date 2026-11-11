import { isAbsolute } from 'node:path';
import { cursorRuntime } from './providers/cursor/runtime';
import type { HarnessProvider } from './contracts';
import type { ProviderContext, ProviderDriver, ProviderEvent, HarnessPromptScope } from './driver';
import type { HarnessMcpEndpoint } from './generation';
import type { PromptPart } from './core/prompt-content';
import { createCodexHost, type CodexHost, type CodexHostOptions } from './providers/codex';
import { mcpServerConfig } from './providers/codex/host-mcp';
import { CodexHostAdapter, type CodexHostAdapterOptions } from './providers/codex/host-adapter';
import { CodexHostController } from './providers/codex/host-controller';
import { ClaudeHost, type ClaudeHostOptions } from './providers/claude/host';
import { ClaudeAgentSdkTransport, type ClaudeAgentSdkTransportOptions } from './providers/claude/agent-sdk-transport';
import type { ClaudeTurnTransport } from './providers/claude/transport';
import { CursorHost, type CursorHostOptions } from './providers/cursor/host';
import { AntigravityHost, type AntigravityHostOptions } from './providers/antigravity/host';
import { antigravityHome } from './providers/antigravity/runtime';
import { validateMcpPolicy } from './mcp-policy';
import { sessionMcpServer } from './acp/mcp-bridge';

/** Shared app ports; provider-specific transport configuration stays in the named adapter options. */
export type ProviderOptions<Context extends ProviderContext = ProviderContext> = {
  client: { name: string; title?: string; version?: string; metadataDirectory?: string };
  /** Provider configuration/data home; omitted preserves native standard-home discovery. */
  home?: string;
  stateDirectory?: () => string;
  instructions?: (context: Context) => string | undefined;
  mcpServers?: (context: Context) => readonly HarnessMcpEndpoint[];
  formatPrompt?: (prompt: string, content: readonly PromptPart[] | undefined) => string;
  /** The app's own MCP server; its tools are trusted. */
  trustedMcpServerName?: string;
  /** Per-conversation Codex configuration the app adds on start or resume. */
  codexConversationConfig?: (context: Context, scope?: HarnessPromptScope) => import('./options').HarnessConversationConfig | Promise<import('./options').HarnessConversationConfig>;
  codex?: { host?: CodexHostOptions; adapter?: CodexHostAdapterOptions<Context>; /** Tests supply a ready host instead of starting one. */ existingHost?: CodexHost };
  claude?: { transport?: ClaudeTurnTransport; transportOptions?: ClaudeAgentSdkTransportOptions; host?: ClaudeHostOptions<Context> };
  cursor?: CursorHostOptions<Context>;
  antigravity?: AntigravityHostOptions<Context>;
};
type CodexContext<Context> = { context: Context; scope?: HarnessPromptScope };

/** Creates a native adapter without connecting, authenticating or executing a model turn.
 * @deprecated Prefer createNativeHarnessDriver from /native; the root factory is neutral.
 */
export function createProviderDriver<Context extends ProviderContext = ProviderContext>(backend: HarnessProvider, options: ProviderOptions<Context>): ProviderDriver<Context, ProviderEvent> {
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
    ...(home ? { runtime: cursorRuntime({ isolated: true, homePath: home }, options.cursor?.runtime?.environment) } : {}),
    stateDirectory: options.stateDirectory ?? options.cursor?.stateDirectory,
    instructions: options.instructions ?? options.cursor?.instructions,
    formatPrompt: options.formatPrompt ?? options.cursor?.formatPrompt,
    ...(options.mcpServers ? { mcpServers: bridges } : {}),
    sessionOptions: { ...options.cursor?.sessionOptions, client: options.client },
  });
  if (backend === 'antigravity') return new AntigravityHost({ ...options.antigravity,
    ...(home ? { home: () => home } : options.stateDirectory ? { home: () => antigravityHome(options.stateDirectory!()) } : {}),
    stateDirectory: options.stateDirectory ?? options.antigravity?.stateDirectory,
    instructions: options.antigravity?.instructions ?? (options.instructions ? (context: Context) => options.instructions!(context) : undefined),
    formatPrompt: options.formatPrompt ?? options.antigravity?.formatPrompt,
    ...(options.mcpServers ? { mcpServers: bridges } : {}),
    client: { ...options.antigravity?.client, ...options.client },
  });
  if (backend === 'claude') {
    const driver = new ClaudeHost(options.claude?.transport ?? new ClaudeAgentSdkTransport({ ...options.claude?.transportOptions, client: { ...options.claude?.transportOptions?.client, ...options.client } }), undefined, {
    contextForConversation: (ref, id) => ({ id, name: id, folder: ref.folder, provider: 'claude', providerSession: { kind: 'claude', sessionId: ref.sessionId, transport: 'stdio' } }) as Context,
    ...options.claude?.host,
    configurePrompt: context => {
      const defaults = options.claude?.host?.configurePrompt?.(context) ?? {};
      const servers = endpoints(context);
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
      if (home && process.env.CLAUDE_CONFIG_DIR === home) {
        if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
      }
    };
    return driver;
  }
  if (backend !== 'codex') throw new Error(`Unsupported harness: ${backend}`);
  const nativeHostOptions = options.codex?.host ?? {};
  if (home && nativeHostOptions.codexHome && home !== nativeHostOptions.codexHome) throw new Error('Runtime home conflicts with codex.host.codexHome.');
  const hostOptions = { ...nativeHostOptions, ...(home ? { codexHome: home } : {}) };
  const host = options.codex?.existingHost ?? createCodexHost({ ...hostOptions, autoSelectFirstConversation: false,
    clientInfo: hostOptions.clientInfo ?? { name: options.client.name, title: options.client.title ?? options.client.name, version: options.client.version ?? '1' },
    extensions: [...hostOptions.extensions ?? [], { configureConversation: ({ extensionContext }) => {
      const binding = extensionContext as CodexContext<Context> | undefined;
      if (!binding?.context) return {};
      const build = (app?: import('./options').HarnessConversationConfig) => {
        const instructions = binding.scope?.developerInstructions ?? app?.developerInstructions ?? options.instructions?.(binding.context);
        return {
          ...(app?.config ? { config: app.config } : {}),
          ...(!binding.scope && options.mcpServers ? { config: { ...app?.config, ...mcpServerConfig(endpoints(binding.context).map(server => ({ name: server.name, transport: { type: 'http', url: server.url }, ...(server.enabledTools ? { enabledTools: [...server.enabledTools] } : {}), ...(server.approval === 'auto' ? { toolApprovalMode: 'auto' as const } : {}), ...(server.required === undefined ? {} : { required: server.required }) }))) } } : {}),
          ...(instructions === undefined ? {} : { developerInstructions: instructions }),
        };
      };
      const app = options.codexConversationConfig?.(binding.context, binding.scope);
      return app instanceof Promise ? app.then(build) : build(app);
    } }],
  });
  const adapter = new CodexHostAdapter<Context>(host, () => host.close(), {
    ...options.codex?.adapter,
    extensionContext: (context, scope) => ({ context, scope } satisfies CodexContext<Context>),
    formatPrompt: options.formatPrompt ?? options.codex?.adapter?.formatPrompt,
  });
  return new CodexHostController(adapter);
}
