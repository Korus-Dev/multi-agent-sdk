import { isAbsolute } from 'node:path';
import type { CodexSurfaceJsonValue } from 'multi-agents-sdk/surface';

export type CodexMcpServerToolApprovalMode = 'auto' | 'prompt' | 'writes' | 'approve';

export type CodexMcpServerTransport =
  | {
    type: 'stdio';
    command: string;
    args?: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    /** Environment variable names inherited by the app-server-launched process. */
    envVars?: readonly string[];
  }
  | {
    type: 'http';
    url: string;
  };

/** Trusted main-process configuration for an app-owned MCP server. */
export type CodexMcpServerDefinition = {
  name: string;
  transport: CodexMcpServerTransport;
  toolApprovalMode?: CodexMcpServerToolApprovalMode;
  required?: boolean;
  enabledTools?: readonly string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
};

export function normalizeMcpServers(
  definitions: readonly CodexMcpServerDefinition[],
): readonly CodexMcpServerDefinition[] {
  if (!Array.isArray(definitions)) throw new TypeError('Codex MCP servers must be an array');
  const names = new Set<string>();
  return definitions.map((definition, index) => {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new TypeError(`Codex MCP server ${index + 1} must be an object`);
    }
    const name = definition.name?.trim();
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      throw new TypeError(`Codex MCP server ${index + 1} name must match ^[A-Za-z0-9][A-Za-z0-9_-]*$`);
    }
    if (names.has(name)) throw new Error(`Duplicate Codex MCP server '${name}'`);
    names.add(name);
    const transport = normalizeMcpTransport(definition.transport, name);
    const toolApprovalMode = definition.toolApprovalMode;
    if (
      toolApprovalMode !== undefined
      && toolApprovalMode !== 'auto'
      && toolApprovalMode !== 'prompt'
      && toolApprovalMode !== 'writes'
      && toolApprovalMode !== 'approve'
    ) {
      throw new TypeError(`Codex MCP server '${name}' tool approval mode is invalid`);
    }
    if (definition.required !== undefined && typeof definition.required !== 'boolean') {
      throw new TypeError(`Codex MCP server '${name}' required flag must be a boolean`);
    }
    const enabledTools = definition.enabledTools === undefined
      ? undefined
      : normalizedNonEmptyStrings(definition.enabledTools, `Codex MCP server '${name}' enabled tool`);
    const startupTimeoutMs = optionalPositiveMilliseconds(
      definition.startupTimeoutMs,
      `Codex MCP server '${name}' startup timeout`,
    );
    const toolTimeoutMs = optionalPositiveMilliseconds(
      definition.toolTimeoutMs,
      `Codex MCP server '${name}' tool timeout`,
    );
    return {
      name,
      transport,
      ...(toolApprovalMode === undefined ? {} : { toolApprovalMode }),
      ...(definition.required === undefined ? {} : { required: definition.required }),
      ...(enabledTools === undefined ? {} : { enabledTools }),
      ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
      ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
    };
  });
}

function normalizeMcpTransport(
  transport: CodexMcpServerTransport,
  serverName: string,
): CodexMcpServerTransport {
  if (!transport || typeof transport !== 'object' || Array.isArray(transport)) {
    throw new TypeError(`Codex MCP server '${serverName}' transport must be an object`);
  }
  if (transport.type === 'http') {
    const url = transport.url?.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError(`Codex MCP server '${serverName}' URL must be valid`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError(`Codex MCP server '${serverName}' URL must use HTTP or HTTPS`);
    }
    return { type: 'http', url };
  }
  if (transport.type !== 'stdio') {
    throw new TypeError(`Codex MCP server '${serverName}' transport type is invalid`);
  }
  const command = transport.command?.trim();
  if (!command) throw new TypeError(`Codex MCP server '${serverName}' command cannot be empty`);
  const args = transport.args === undefined
    ? undefined
    : normalizedNonEmptyStrings(transport.args, `Codex MCP server '${serverName}' argument`);
  const cwd = transport.cwd?.trim();
  if (cwd !== undefined && (!cwd || !isAbsolute(cwd))) {
    throw new TypeError(`Codex MCP server '${serverName}' cwd must be an absolute path`);
  }
  let env: Record<string, string> | undefined;
  if (transport.env !== undefined) {
    if (!transport.env || typeof transport.env !== 'object' || Array.isArray(transport.env)) {
      throw new TypeError(`Codex MCP server '${serverName}' env must be an object`);
    }
    env = {};
    for (const [key, value] of Object.entries(transport.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') {
        throw new TypeError(`Codex MCP server '${serverName}' env entries must be string environment variables`);
      }
      env[key] = value;
    }
  }
  const envVars = transport.envVars === undefined
    ? undefined
    : normalizedEnvironmentVariableNames(transport.envVars, serverName);
  return {
    type: 'stdio',
    command,
    ...(args === undefined ? {} : { args }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    ...(envVars === undefined ? {} : { envVars }),
  };
}

function normalizedNonEmptyStrings(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) throw new TypeError(`${label}s must be an array`);
  const normalized = values.map((value) => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} cannot be empty`);
    return value.trim();
  });
  return [...new Set(normalized)];
}

function normalizedEnvironmentVariableNames(values: readonly string[], serverName: string): string[] {
  const names = normalizedNonEmptyStrings(values, `Codex MCP server '${serverName}' environment variable`);
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`Codex MCP server '${serverName}' environment variable '${name}' is invalid`);
    }
  }
  return names;
}

function optionalPositiveMilliseconds(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be a positive finite number`);
  return value;
}

export function mcpServerConfig(
  definitions: readonly CodexMcpServerDefinition[],
): Record<string, CodexSurfaceJsonValue> {
  const config: Record<string, CodexSurfaceJsonValue> = {};
  for (const definition of definitions) {
    const server: Record<string, CodexSurfaceJsonValue> = definition.transport.type === 'http'
      ? { url: definition.transport.url }
      : {
        command: definition.transport.command,
        ...(definition.transport.args === undefined ? {} : { args: [...definition.transport.args] }),
        ...(definition.transport.cwd === undefined ? {} : { cwd: definition.transport.cwd }),
        ...(definition.transport.env === undefined ? {} : { env: { ...definition.transport.env } }),
        ...(definition.transport.envVars === undefined ? {} : { env_vars: [...definition.transport.envVars] }),
      };
    if (definition.toolApprovalMode !== undefined) {
      server.default_tools_approval_mode = definition.toolApprovalMode;
    }
    if (definition.required !== undefined) server.required = definition.required;
    if (definition.enabledTools !== undefined) server.enabled_tools = [...definition.enabledTools];
    if (definition.startupTimeoutMs !== undefined) server.startup_timeout_sec = definition.startupTimeoutMs / 1000;
    if (definition.toolTimeoutMs !== undefined) server.tool_timeout_sec = definition.toolTimeoutMs / 1000;
    config[`mcp_servers.${definition.name}`] = server;
  }
  return config;
}

export function assertNoMcpConfigCollision(
  config: Readonly<Record<string, CodexSurfaceJsonValue>>,
  definitions: readonly CodexMcpServerDefinition[],
): void {
  if (definitions.length === 0) return;
  for (const key of Object.keys(config)) {
    if (key === 'mcp_servers') {
      throw new Error('Raw mcp_servers config cannot be combined with typed Codex MCP servers');
    }
    for (const definition of definitions) {
      const path = `mcp_servers.${definition.name}`;
      if (key === path || key.startsWith(`${path}.`)) {
        throw new Error(`Raw config for Codex MCP server '${definition.name}' conflicts with its typed definition`);
      }
    }
  }
}
