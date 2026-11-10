import type { HarnessMcpPolicy } from './generation';

/** Reject unsupported policy rather than silently changing the caller's trust intent. */
export function validateMcpPolicy(servers: readonly HarnessMcpPolicy[], provider: 'codex' | 'claude' | 'cursor' | 'antigravity'): void {
  for (const server of servers) {
    if (server.approval !== undefined && server.approval !== 'inherit' && server.approval !== 'auto') throw new Error('Unsupported MCP approval policy.');
    if (server.required !== undefined && typeof server.required !== 'boolean') throw new Error('Invalid MCP required flag.');
    if (provider !== 'codex' && server.required === true) throw new Error(`${provider} does not support required MCP servers.`);
    if ((provider === 'cursor' || provider === 'antigravity') && server.approval === 'auto') throw new Error(`${provider} does not support automatic MCP approval.`);
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
