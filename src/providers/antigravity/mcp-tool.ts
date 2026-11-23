import { record } from '../../acp/acp-connection';

type McpIdentity = { server: string; tool: string };

export function mcpToolIdentity(call: Record<string, unknown>, registeredServers: readonly string[]): McpIdentity | undefined {
  const meta = call._meta;
  const mcp = record(meta) && meta.mcp;
  if (record(mcp) || (record(meta) && meta.is_mcp_tool_call === true)) {
    return record(meta) && meta.is_mcp_tool_call === true && record(mcp) &&
      typeof mcp.server === 'string' && mcp.server.trim() && typeof mcp.tool === 'string' && mcp.tool.trim()
      ? { server: mcp.server, tool: mcp.tool } : undefined;
  }

  const input = call.rawInput;
  if (call.kind === 'execute' && call.name === 'call_mcp_tool') {
    return record(input) && typeof input.ServerName === 'string' && input.ServerName.trim() && typeof input.ToolName === 'string' && input.ToolName.trim()
      ? { server: input.ServerName, tool: input.ToolName } : undefined;
  }

  const name = directMcpToolName(call);
  if (!name) return;
  // Eager calls flatten the server and tool names. Require a unique match
  // against the session registrations before giving the call a server identity.
  const matches = registeredServers.filter(server => {
    const prefix = `mcp_${server}_`;
    return name.startsWith(prefix) && name.length > prefix.length;
  });
  if (matches.length !== 1) return;
  const server = matches[0]!;
  return { server, tool: name.slice(`mcp_${server}_`.length) };
}

/** The native call name can be shown without inferring which server owns it. */
export function directMcpToolName(call: Record<string, unknown>): string | undefined {
  if (call.kind !== 'other' && call.kind !== 'execute') return;
  const input = call.rawInput;
  if (record(input) && ['CommandLine', 'command', 'executable', 'ServerName', 'ToolName'].some(key => key in input)) return;
  const name = typeof call.title === 'string' ? /^Run (mcp_[A-Za-z0-9_.-]+)\??$/.exec(call.title)?.[1] : undefined;
  if (!name || (call.name != null && call.name !== name)) return;
  if (call.name !== name && (!record(input) || typeof input.toolSummary !== 'string')) return;
  return name;
}
