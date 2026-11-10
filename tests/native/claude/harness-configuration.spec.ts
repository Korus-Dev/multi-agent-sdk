import { expect, it, vi } from 'vitest';
import { ClaudeAgentSdkTransport } from 'multi-agents-sdk/providers/claude/agent-sdk-transport';
import type { ClaudePermissionRequest } from '../../../src/providers/claude/transport';
import { createQueryHarness } from './sdk-query-fixture';

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
      { name: 'tax_rules', url: 'http://127.0.0.1:1234/rules', enabledTools: ['lookup_rules'] },
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
