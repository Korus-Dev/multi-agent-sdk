import type { HarnessMcpPolicy } from './generation';
import type { HarnessProvider, ProviderCapabilities } from './contracts';

/** The MCP policy a harness supports, from its capabilities. */
export type McpPolicySupport = Pick<ProviderCapabilities, 'mcpRequiredServers' | 'mcpAutoApproval'>;

/** Reject unsupported policy rather than silently changing the caller's trust intent. */
export function validateMcpPolicy(servers: readonly HarnessMcpPolicy[], provider: HarnessProvider, support: McpPolicySupport): void {
  for (const server of servers) {
    if (server.approval !== undefined && server.approval !== 'inherit' && server.approval !== 'auto') throw new Error('Unsupported MCP approval policy.');
    if (server.required !== undefined && typeof server.required !== 'boolean') throw new Error('Invalid MCP required flag.');
    if (!support.mcpRequiredServers && server.required === true) throw new Error(`${provider} does not support required MCP servers.`);
    if (!support.mcpAutoApproval && server.approval === 'auto') throw new Error(`${provider} does not support automatic MCP approval.`);
  }
}

/** Availability is checked independently of native permission/trust decisions. */
export function mcpToolEnabled(tool: string, enabled?: Readonly<Record<string, readonly string[]>>): boolean {
  for (const [server, tools] of Object.entries(enabled ?? {})) {
    const prefix = `mcp__${server}__`;
    if (tool.startsWith(prefix)) return tools.includes('*') || tools.includes(tool.slice(prefix.length));
  }
  return true;
}
