import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createHarnessDriver } from '../../../src/backend';
import { ClaudeAgentSdkTransport } from '../../../src/providers/claude/agent-sdk-transport';
import type { HarnessContext, HarnessDriver, HarnessEvent } from '../../../src/driver';
import { createQueryHarness } from './sdk-query-fixture';

it('keeps CPA instructions and MCP scopes caller-owned through the unified Claude host', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-claude-cpa-'));
  const harness = createQueryHarness();
  const transport = new ClaudeAgentSdkTransport({ createQuery: harness.createQuery, client: { name: 'CPA workbench' } });
  const host: HarnessDriver<HarnessContext, HarnessEvent> = createHarnessDriver('claude', {
    client: { name: 'CPA workbench' }, instructions: () => 'Use the supplied accounting rules.',
    mcpServers: () => [{ name: 'tax_rules', url: 'http://127.0.0.1:1234/tax', enabledTools: ['lookup'] }],
    claude: { transport, host: { homeDir: root } },
  });
  const context: HarnessContext = { id: 'tax-assistant', backend: 'claude', folder: root, name: 'Tax assistant' };
  const events: HarnessEvent[] = [];
  host.onEvent(event => events.push(event));
  const complete = (text: string, index?: number) => {
    harness.emit({ type: 'system', subtype: 'init', session_id: 'cpa-session' }, index);
    harness.emit({ type: 'assistant', uuid: `native-${text}`, session_id: 'cpa-session', message: { content: [{ type: 'text', text }] } }, index);
    harness.emit({ type: 'result', subtype: 'success', session_id: 'cpa-session', is_error: false }, index);
  };
  try {
    const sending = host.sendPrompt(context, 'Reconcile this invoice');
    await vi.waitFor(() => expect(harness.inputs).toHaveLength(1));
    expect(harness.options[0]).toMatchObject({ mcpServers: { tax_rules: { type: 'http', url: 'http://127.0.0.1:1234/tax' } }, systemPrompt: { append: 'Use the supplied accounting rules.' } });
    complete('Invoice reconciled.');
    context.backendSession = (await sending).backendSession;
    await vi.waitFor(() => expect(events.some(event => event.type === 'agent.statusChanged' && event.payload.type === 'idle')).toBe(true));
    const scoped = host.executeScopedPrompt!(context, { cwd: root, prompt: 'Verify ledger totals', session: context.backendSession,
      scope: { id: 'ledger-verification', mcpServers: [{ name: 'ledger', url: 'http://127.0.0.1:1234/ledger', approval: 'auto', enabledTools: ['lookup'] }] },
    });
    await vi.waitFor(() => expect(harness.inputs).toHaveLength(2));
    const index = harness.options.length - 1;
    expect(harness.options[index]).toMatchObject({ mcpServers: { ledger: { type: 'http', url: 'http://127.0.0.1:1234/ledger' } } });
    await expect(harness.options[index]!.canUseTool!('mcp__ledger__lookup', { invoice: 42 }, { signal: new AbortController().signal, toolUseID: 'ledger-lookup', requestId: 'ledger-lookup' })).resolves.toMatchObject({ behavior: 'allow', updatedInput: { invoice: 42 } });
    expect(harness.options[index]!.mcpServers).not.toHaveProperty('tax_rules');
    complete('Ledger verified.', index);
    await expect(scoped).resolves.toMatchObject({ text: 'Ledger verified.', session: { kind: 'claude', sessionId: 'cpa-session' } });
    expect(host.getCapabilities(context)).not.toHaveProperty('codeReview');
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
