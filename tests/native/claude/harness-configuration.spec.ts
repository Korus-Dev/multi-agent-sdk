import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClaudeAgentSdkTransport } from 'multi-agents-sdk/providers/claude/agent-sdk-transport';
import type { ClaudePermissionRequest } from '../../../src/providers/claude/transport';
import { createQueryHarness } from './sdk-query-fixture';

beforeEach(() => vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', undefined));
afterEach(() => vi.unstubAllEnvs());

it('uses the embedding app identity and lets that app handle plan-exit permission', async () => {
  const harness = createQueryHarness();
  const requests: ClaudePermissionRequest[] = [];
  const transport = new ClaudeAgentSdkTransport({ createQuery: harness.createQuery,
    client: { name: 'CPA Assistant', mcpServerName: 'accounting', entrypoint: 'cpa-assistant', clientApp: 'cpa-assistant' },
  });
  try {
    const turn = transport.startTurn({ cwd: '/tmp/project', sessionId: 'cpa-session', prompt: 'Review the return', mcpServerUrl: 'http://127.0.0.1:1234/tools' }, () => {}, request => requests.push(request));
    await vi.waitFor(() => expect(harness.inputs).toHaveLength(1));
    expect(harness.options[0]).toMatchObject({
      mcpServers: { accounting: { type: 'http', url: 'http://127.0.0.1:1234/tools' } },
      env: { CLAUDE_CODE_ENTRYPOINT: 'cpa-assistant', CLAUDE_AGENT_SDK_CLIENT_APP: 'cpa-assistant' },
    });
    const permission = harness.options[0]!.canUseTool!('ExitPlanMode', { plan: '# Filing plan' }, {
      signal: new AbortController().signal, toolUseID: 'plan', requestId: 'approve-plan',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ id: 'approve-plan', toolName: 'ExitPlanMode', kind: 'confirm_tool' });
    await transport.respondToPermissionRequest('approve-plan', { decision: 'allow' });
    await expect(permission).resolves.toMatchObject({ behavior: 'allow', updatedInput: { plan: '# Filing plan' } });
    harness.emit({ type: 'result', subtype: 'success', session_id: 'cpa-session', is_error: false });
    await turn.done;
  } finally { await transport.close(); }
});

it('runs a scoped text request with app-supplied MCP tools', async () => {
  const harness = createQueryHarness();
  const transport = new ClaudeAgentSdkTransport({ createQuery: harness.createQuery });
  try {
    const result = transport.generateText({ cwd: '/tmp/project', prompt: 'Find the applicable tax rule', mcpServers: [
      { name: 'tax_rules', url: 'http://127.0.0.1:1234/rules', approval: 'auto', enabledTools: ['lookup_rules'] },
    ] });
    await vi.waitFor(() => expect(harness.inputs).toHaveLength(1));
    expect(harness.options[0]).toMatchObject({ persistSession: false, tools: [],
      mcpServers: { tax_rules: { type: 'http', url: 'http://127.0.0.1:1234/rules' } },
      allowedTools: ['mcp__tax_rules__lookup_rules'],
    });
    harness.emit({ type: 'result', subtype: 'success', session_id: 'utility', is_error: false, result: 'Rule 42' });
    await expect(result).resolves.toStrictEqual({ text: 'Rule 42' });
  } finally { await transport.close(); }
});

it.each([
  { inherited: 'outer-app', entrypoint: 'cpa-assistant', explicit: undefined, expected: 'cpa-assistant' },
  { inherited: 'outer-app', entrypoint: 'cpa-assistant', explicit: 'auth-runtime', expected: 'cpa-assistant' },
  { inherited: 'outer-app', entrypoint: undefined, explicit: 'sdk-auth-runtime', expected: 'sdk-auth-runtime' },
  { inherited: 'auth-runtime', entrypoint: undefined, explicit: undefined, expected: 'auth-runtime' },
  { inherited: 'cli', entrypoint: undefined, explicit: undefined, expected: 'sdk-multi-agents' },
  { inherited: 'sdk-parent', entrypoint: undefined, explicit: undefined, expected: 'sdk-multi-agents' },
])('attributes entrypoint $expected without depending on the parent shell', async ({ inherited, entrypoint, explicit, expected }) => {
  vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', inherited);
  const harness = createQueryHarness();
  const launchEnvironment = { PATH: '/fixture/runtime', CLAUDE_CODE_ENTRYPOINT: explicit ?? inherited, CLAUDE_CODE_USE_BEDROCK: '1' };
  const before = { ...launchEnvironment };
  const transport = new ClaudeAgentSdkTransport({ createQuery: harness.createQuery, client: { entrypoint },
    env: explicit ? { CLAUDE_CODE_ENTRYPOINT: explicit } : undefined,
    resolveLaunch: () => ({ command: '/fixture/claude', env: launchEnvironment }),
  });
  try {
    const turn = transport.startTurn({ cwd: '/tmp/project', sessionId: 'cpa-session', prompt: 'Review return' }, () => {}, () => {});
    await vi.waitFor(() => expect(harness.inputs).toHaveLength(1));
    expect(harness.options[0]).toMatchObject({ pathToClaudeCodeExecutable: '/fixture/claude',
      env: { PATH: '/fixture/runtime', CLAUDE_CODE_ENTRYPOINT: expected, CLAUDE_CODE_USE_BEDROCK: '1' } });
    expect(launchEnvironment).toEqual(before);
    expect(process.env.CLAUDE_CODE_ENTRYPOINT).toBe(inherited);
    harness.emit({ type: 'result', subtype: 'success', session_id: 'cpa-session', is_error: false });
    await turn.done;
  } finally { await transport.close(); }
});

it.each(['inherit', 'auto'] as const)('keeps utility MCP availability distinct from %s approval', async approval => {
  const harness = createQueryHarness();
  const transport = new ClaudeAgentSdkTransport({ createQuery: harness.createQuery });
  try {
    const result = transport.generateText({ cwd: '/tmp/project', prompt: 'Read ledger', mcpServers: [{ name: 'ledger', url: 'http://127.0.0.1:1234/ledger', enabledTools: ['read'], approval }] });
    await vi.waitFor(() => expect(harness.inputs).toHaveLength(1));
    const options = harness.options[0]!;
    await expect(options.canUseTool!('mcp__ledger__read', {}, { signal: new AbortController().signal, toolUseID: 'read' })).resolves.toMatchObject({ behavior: approval === 'auto' ? 'allow' : 'deny' });
    await expect(options.canUseTool!('mcp__ledger__write', {}, { signal: new AbortController().signal, toolUseID: 'write' })).resolves.toMatchObject({ behavior: 'deny' });
    expect(options.allowedTools ?? []).toEqual(approval === 'auto' ? ['mcp__ledger__read'] : []);
    harness.emit({ type: 'result', subtype: 'success', session_id: 'utility', is_error: false, result: 'Done' });
    await expect(result).resolves.toEqual({ text: 'Done' });
  } finally { await transport.close(); }
});

it('denies unavailable native MCP tools before explicit trust can bypass permissions', async () => {
  const harness = createQueryHarness();
  const requests: ClaudePermissionRequest[] = [];
  const transport = new ClaudeAgentSdkTransport({ createQuery: harness.createQuery });
  try {
    const turn = transport.startTurn({ cwd: '/tmp/project', prompt: 'Read ledger', sessionId: 'ledger', mcpServerUrl: 'http://127.0.0.1:1234/ledger', mcpServerName: 'ledger', enabledMcpTools: { ledger: [] }, allowedTools: ['mcp__ledger__*'] }, () => {}, request => requests.push(request));
    await vi.waitFor(() => expect(harness.inputs).toHaveLength(1));
    await expect(harness.options[0]!.canUseTool!('mcp__ledger__write', {}, { signal: new AbortController().signal, toolUseID: 'write' })).resolves.toMatchObject({ behavior: 'deny' });
    expect(requests).toEqual([]);
    harness.emit({ type: 'result', subtype: 'success', session_id: 'ledger', is_error: false }); await turn.done;
  } finally { await transport.close(); }
});
