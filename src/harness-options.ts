import { isAbsolute } from 'node:path';
import type { ProviderContext } from './context';
import type { HarnessProvider, ProviderDefaults } from './contracts';
import type { HarnessContext } from './consumer-types';
import type { HarnessMcpEndpoint } from './generation';
import type { HarnessOptions } from './options';
import type { PromptPart } from './core/prompt-content';
import { validateMcpPolicy, type McpPolicySupport } from './mcp-policy';
import { sessionMcpServer } from './acp/mcp-bridge';

/** App ports every harness receives; each harness adds its own block next to these. */
export type SharedProviderOptions<Context extends ProviderContext = ProviderContext> = {
  client: { name: string; title?: string; version?: string; metadataDirectory?: string };
  /** Provider configuration/data home; omitted preserves native standard-home discovery. */
  home?: string;
  stateDirectory?: () => string;
  instructions?: (context: Context) => string | undefined;
  mcpServers?: (context: Context) => readonly HarnessMcpEndpoint[];
  formatPrompt?: (prompt: string, content: readonly PromptPart[] | undefined) => string;
  /** The app's own MCP server; its tools are trusted. */
  trustedMcpServerName?: string;
};

/** Reads which permission option native defaults select. */
export type PermissionReader = (defaults: ProviderDefaults) => string | undefined;

/** The slice of a native context an app sees. */
export function harnessContext(context: ProviderContext, permissionOf: PermissionReader): HarnessContext {
  const d = context.providerDefaults;
  return { id: context.id, folder: context.folder, ...(context.name === undefined ? {} : { name: context.name }),
    ...(d ? { defaults: { model: d.model ?? undefined, reasoningEffort: d.reasoningEffort ?? undefined, serviceTier: d.serviceTier, permission: permissionOf(d) } } : {}),
  };
}

/** The app-facing options every harness maps the same way. */
export function sharedProviderOptions(options: HarnessOptions, permissionOf: PermissionReader): SharedProviderOptions {
  const instructions = options.instructions;
  const context = (native: ProviderContext) => harnessContext(native, permissionOf);
  return {
    client: options.client,
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
    ...(instructions ? { instructions: (native: ProviderContext) => instructions(context(native), { planMode: false }) } : {}),
    ...(options.mcpServers ? { mcpServers: (native: ProviderContext) => options.mcpServers!(context(native)) } : {}),
    ...(options.formatPrompt ? { formatPrompt: options.formatPrompt } : {}),
    ...(options.trustedMcpServerName ? { trustedMcpServerName: options.trustedMcpServerName } : {}),
  };
}

/** The configured provider home, validated; undefined keeps the provider's standard home. */
export function providerHome(options: SharedProviderOptions<never>): string | undefined {
  const home = options.home?.trim();
  if (options.home !== undefined && (!home || !isAbsolute(home))) throw new Error('Runtime home must be a nonempty absolute path.');
  return home || undefined;
}

/** The context's MCP endpoints, checked against what the provider can reach. */
export function mcpEndpoints<Context extends ProviderContext>(options: SharedProviderOptions<Context>, provider: HarnessProvider, support: McpPolicySupport, context: Context): readonly HarnessMcpEndpoint[] {
  const servers = options.mcpServers?.(context) ?? [];
  validateMcpPolicy(servers, provider, support);
  return servers;
}

/** The context's MCP endpoints as bridged session servers, for runtimes that take them per session. */
export function bridgedMcpServers<Context extends ProviderContext>(options: SharedProviderOptions<Context>, provider: HarnessProvider, support: McpPolicySupport) {
  return (context: Context) => mcpEndpoints(options, provider, support, context).map(server => sessionMcpServer(server.url, server.name, server.enabledTools ? [...server.enabledTools] : undefined));
}
