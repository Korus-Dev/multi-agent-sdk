import { beforeEach, expect, it, vi } from 'vitest';
import { createProviderHost } from '../../src/harnesses';
import type { HarnessMcpEndpoint } from '../../src/generation';
const captured = vi.hoisted(() => ({ claude: null as any, codex: null as any, cursor: null as any, antigravity: null as any }));
vi.mock('../../src/providers/claude/host', () => ({ ClaudeHost: class { constructor(_transport: unknown, _state: unknown, options: unknown) { captured.claude = options; } } }));
vi.mock('../../src/providers/codex/index', () => ({ CodexHost: class {}, createCodexHost: (options: unknown) => { captured.codex = options; return { close() {} }; } }));
vi.mock('../../src/providers/codex/host-adapter', () => ({ CodexHostAdapter: class {} }));
vi.mock('../../src/providers/codex/host-controller', () => ({ CodexHostController: class {} }));
vi.mock('../../src/providers/cursor/host', () => ({ CursorHost: class { constructor(options: unknown) { captured.cursor = options; } } }));
vi.mock('../../src/providers/antigravity/host', () => ({ AntigravityHost: class { constructor(options: unknown) { captured.antigravity = options; } } }));
const context = { id: 'test', provider: 'claude' as const, folder: '/workspace' };
const endpoint = (extra: Partial<HarnessMcpEndpoint> = {}): HarnessMcpEndpoint => ({ name: 'tools', url: 'http://localhost/tools', enabledTools: ['read'], ...extra });
function configure(provider: 'claude'|'codex'|'cursor'|'antigravity', servers: HarnessMcpEndpoint[]) {
  createProviderHost(provider, { client: { name: 'test' }, mcpServers: () => servers, claude: { transport: {} as any } });
  if (provider === 'claude') return captured.claude.configurePrompt(context);
  if (provider === 'codex') return captured.codex.extensions.at(-1).configureConversation({ extensionContext: { context } });
  return captured[provider].mcpServers(context);
}
beforeEach(() => { captured.claude = captured.codex = captured.cursor = captured.antigravity = null; });

it('inherits Claude approval by default while restricting callable tools independently', () => {
  const configuration = configure('claude', [endpoint()]);
  expect(configuration.allowedTools).toEqual([]);
  expect(configuration.enabledMcpTools).toEqual({ tools: ['read'] });
});
it('trusts only explicitly auto-approved Claude tools, preserving an empty availability list', () => {
  const configuration = configure('claude', [endpoint({ approval: 'auto' }), endpoint({ name: 'blocked', enabledTools: [], approval: 'auto' })]);
  expect(configuration.allowedTools).toEqual(['mcp__tools__read']);
  expect(configuration.enabledMcpTools).toEqual({ tools: ['read'], blocked: [] });
});
it('omits native Codex trust and startup policy by default', () => {
  expect(configure('codex', [endpoint()]).config).toMatchObject({ 'mcp_servers.tools': { enabled_tools: ['read'] } });
  const server = configure('codex', [endpoint()]).config['mcp_servers.tools'];
  expect(server).not.toHaveProperty('default_tools_approval_mode');
  expect(server).not.toHaveProperty('required');
});
it('maps explicit Codex auto approval and required independently', () => {
  const server = configure('codex', [endpoint({ approval: 'auto', required: false })]).config['mcp_servers.tools'];
  expect(server).toMatchObject({ default_tools_approval_mode: 'auto', required: false });
});
it.each(['claude','cursor','antigravity'] as const)('rejects required:true for %s', provider => {
  expect(() => configure(provider, [endpoint({ required: true })])).toThrow(/required/);
});
it.each(['cursor','antigravity'] as const)('rejects unsupported auto approval for %s', provider => {
  expect(() => configure(provider, [endpoint({ approval: 'auto' })])).toThrow(/auto/);
});
