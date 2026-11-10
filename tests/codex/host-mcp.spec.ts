import { describe, expect, it } from 'vitest';
import {
  assertNoMcpConfigCollision,
  mcpServerConfig,
  normalizeMcpServers,
  type CodexMcpServerDefinition,
} from '../../src/providers/codex/host-mcp';

describe('Codex host MCP configuration', () => {
  it('normalizes complete HTTP and stdio definitions', () => {
    expect(normalizeMcpServers([
      { name: ' web ', transport: { type: 'http', url: ' https://example.test/mcp ' } },
      {
        name: 'local_server',
        transport: {
          type: 'stdio',
          command: ' node ',
          args: [' server.js ', 'server.js'],
          cwd: ' /tmp/project ',
          env: { TOKEN: 'secret' },
          envVars: ['PATH', 'PATH', '_CUSTOM'],
        },
        toolApprovalMode: 'writes',
        required: true,
        enabledTools: [' read ', 'read', 'write'],
        startupTimeoutMs: 2_000,
        toolTimeoutMs: 5_000,
      },
    ])).toStrictEqual([
      { name: 'web', transport: { type: 'http', url: 'https://example.test/mcp' } },
      {
        name: 'local_server',
        transport: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          cwd: '/tmp/project',
          env: { TOKEN: 'secret' },
          envVars: ['PATH', '_CUSTOM'],
        },
        toolApprovalMode: 'writes',
        required: true,
        enabledTools: ['read', 'write'],
        startupTimeoutMs: 2_000,
        toolTimeoutMs: 5_000,
      },
    ]);
    expect(normalizeMcpServers([{ name: 'minimal', transport: { type: 'stdio', command: 'server' } }]))
      .toStrictEqual([{ name: 'minimal', transport: { type: 'stdio', command: 'server' } }]);
  });

  it('accepts every documented tool approval mode', () => {
    const definitions = (['auto', 'prompt', 'writes', 'approve'] as const).map((toolApprovalMode) => ({
      name: toolApprovalMode,
      transport: { type: 'stdio' as const, command: 'server' },
      toolApprovalMode,
    }));

    expect(normalizeMcpServers(definitions).map((definition) => definition.toolApprovalMode))
      .toStrictEqual(['auto', 'prompt', 'writes', 'approve']);
  });

  it.each([
    [
      [{ name: 'valid', transport: { type: 'stdio', command: 'x' } }, null],
      'Codex MCP server 2 must be an object',
    ],
    [
      [{ name: 'valid', transport: { type: 'stdio', command: 'x' } }, { name: 'bad name' }],
      'Codex MCP server 2 name must match ^[A-Za-z0-9][A-Za-z0-9_-]*$',
    ],
    [['not-an-object'], 'Codex MCP server 1 must be an object'],
    [[{ transport: { type: 'stdio', command: 'x' } }],
      'Codex MCP server 1 name must match ^[A-Za-z0-9][A-Za-z0-9_-]*$'],
    [[{ name: 'x', transport: 3 }], "Codex MCP server 'x' transport must be an object"],
    [[{ name: 'x', transport: { type: 'http' } }], "Codex MCP server 'x' URL must be valid"],
    [[{ name: 'x', transport: { type: 'stdio' } }], "Codex MCP server 'x' command cannot be empty"],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x', env: 'VALUE' } }],
      "Codex MCP server 'x' env must be an object"],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x', env: 3 } }],
      "Codex MCP server 'x' env must be an object"],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x', args: [3] } }],
      "Codex MCP server 'x' argument cannot be empty"],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x', args: ['   '] } }],
      "Codex MCP server 'x' argument cannot be empty"],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x', envVars: [''] } }],
      "Codex MCP server 'x' environment variable cannot be empty"],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x' }, toolTimeoutMs: Infinity }],
      "Codex MCP server 'x' tool timeout must be a positive finite number"],
  ] as Array<[unknown, string]>)('reports the exact invalid boundary for %#', (definitions, message) => {
    expect(() => normalizeMcpServers(definitions as readonly CodexMcpServerDefinition[]))
      .toThrowError(new TypeError(message));
  });

  it.each([
    [null, 'must be an array'],
    [[null], 'must be an object'],
    [[{ name: 'bad name', transport: { type: 'stdio', command: 'x' } }], 'name must match'],
    [[{ name: 'bad.name', transport: { type: 'stdio', command: 'x' } }], 'name must match'],
    [[
      { name: 'same', transport: { type: 'stdio', command: 'x' } },
      { name: 'same', transport: { type: 'stdio', command: 'x' } },
    ], "Duplicate Codex MCP server 'same'"],
    [[{ name: 'x', transport: null }], 'transport must be an object'],
    [[{ name: 'x', transport: { type: 'socket' } }], 'transport type is invalid'],
    [[{ name: 'x', transport: { type: 'http', url: 'not a url' } }], 'URL must be valid'],
    [[{ name: 'x', transport: { type: 'http', url: 'ftp://example.test' } }], 'URL must use HTTP or HTTPS'],
    [[{ name: 'x', transport: { type: 'stdio', command: ' ' } }], 'command cannot be empty'],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x', args: 'bad' } }], 'arguments must be an array'],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x', args: [''] } }], 'argument cannot be empty'],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x', cwd: 'relative' } }], 'cwd must be an absolute path'],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x', env: [] } }], 'env must be an object'],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x', env: { 'BAD-NAME': 'x' } } }], 'env entries'],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x', env: { GOOD: 3 } } }], 'env entries'],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x', envVars: ['BAD-NAME'] } }], 'environment variable'],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x' }, toolApprovalMode: 'invalid' }], 'approval mode'],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x' }, required: 'yes' }], 'required flag'],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x' }, enabledTools: [''] }], 'enabled tool cannot be empty'],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x' }, startupTimeoutMs: 0 }], 'positive finite number'],
    [[{ name: 'x', transport: { type: 'stdio', command: 'x' }, toolTimeoutMs: Infinity }], 'positive finite number'],
  ] as Array<[unknown, string]>)('rejects invalid definition %#', (definitions, message) => {
    expect(() => normalizeMcpServers(definitions as readonly CodexMcpServerDefinition[])).toThrow(message);
  });

  it('builds app-server config without retaining caller-owned arrays or objects', () => {
    const definitions = normalizeMcpServers([{
      name: 'local',
      transport: {
        type: 'stdio', command: 'node', args: ['server.js'], cwd: '/tmp', env: { A: '1' }, envVars: ['PATH'],
      },
      toolApprovalMode: 'approve',
      required: false,
      enabledTools: ['read'],
      startupTimeoutMs: 1_500,
      toolTimeoutMs: 2_500,
    }, {
      name: 'remote', transport: { type: 'http', url: 'https://example.test/mcp' },
    }]);
    expect(mcpServerConfig(definitions)).toStrictEqual({
      'mcp_servers.local': {
        command: 'node',
        args: ['server.js'],
        cwd: '/tmp',
        env: { A: '1' },
        env_vars: ['PATH'],
        default_tools_approval_mode: 'approve',
        required: false,
        enabled_tools: ['read'],
        startup_timeout_sec: 1.5,
        tool_timeout_sec: 2.5,
      },
      'mcp_servers.remote': { url: 'https://example.test/mcp' },
    });
    expect(mcpServerConfig([])).toStrictEqual({});
  });

  it('omits every absent optional stdio field from app-server config', () => {
    expect(mcpServerConfig([{
      name: 'minimal',
      transport: { type: 'stdio', command: 'server' },
    }])).toStrictEqual({
      'mcp_servers.minimal': { command: 'server' },
    });
  });

  it('rejects raw config collisions while allowing unrelated keys', () => {
    const definitions = normalizeMcpServers([{
      name: 'local', transport: { type: 'stdio', command: 'node' },
    }]);
    expect(() => assertNoMcpConfigCollision({ model: 'gpt' }, definitions)).not.toThrow();
    expect(() => assertNoMcpConfigCollision({ mcp_servers: {} }, definitions))
      .toThrow('Raw mcp_servers config cannot be combined');
    expect(() => assertNoMcpConfigCollision({ 'mcp_servers.local': {} }, definitions))
      .toThrow("conflicts with its typed definition");
    expect(() => assertNoMcpConfigCollision({ 'mcp_servers.local.enabled': true }, definitions))
      .toThrow("conflicts with its typed definition");
    expect(() => assertNoMcpConfigCollision({ mcp_servers: {} }, [])).not.toThrow();
  });
});
