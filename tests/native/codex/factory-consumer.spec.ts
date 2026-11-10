import { expect, it } from 'vitest';
import { CodexAppServerClient } from '@korus-dev/codex-sdk';
import { createHarnessDriver } from '../../../src/backend';
import type { HarnessContext } from '../../../src/driver';
import { MockCodexAppServer, lastRequest, resumeResponse, thread, turn } from '../../codex/helpers/codex-surface-fixture';

it('configures a CPA conversation and a separate scoped tool set through the real Codex protocol boundary', async () => {
  let id = 0;
  const transport = new MockCodexAppServer({
    'thread/start': () => resumeResponse(thread('tax-session', false)),
    'thread/resume': params => resumeResponse(thread(params.threadId, false)),
    'thread/name/set': () => ({}),
    'thread/settings/update': () => ({}),
    'turn/start': () => ({ turn: turn(`tax-turn-${++id}`, 'completed', []) }),
  });
  const driver = createHarnessDriver('codex', {
    client: { name: 'cpa-workbench', title: 'CPA workbench' },
    instructions: () => 'Use only verified tax rules.',
    mcpServers: () => [{ name: 'tax_rules', url: 'http://127.0.0.1:1234/tax', enabledTools: ['lookup'] }],
    codex: { surface: { client: new CodexAppServerClient(transport) } },
  });
  const context: HarnessContext = { id: 'tax', name: 'Tax assistant', backend: 'codex', folder: '/accounting' };
  try {
    const started = await driver.sendPrompt(context, 'Reconcile invoices');
    context.backendSession = started.backendSession;
    expect(lastRequest(transport, 'thread/start').params).toMatchObject({ cwd: '/accounting', developerInstructions: 'Use only verified tax rules.', config: { 'mcp_servers.tax_rules': expect.objectContaining({ url: 'http://127.0.0.1:1234/tax' }) } });
    await driver.executeScopedPrompt!(context, { cwd: '/accounting', session: context.backendSession, prompt: 'Verify ledger totals', scope: { id: 'ledger', developerInstructions: 'Use only the supplied ledger.', mcpServers: [{ name: 'ledger', url: 'http://127.0.0.1:1234/ledger', enabledTools: ['lookup'] }] } });
    const resumes = transport.sent.filter(message => 'method' in message && message.method === 'thread/resume');
    expect(resumes).toEqual(expect.arrayContaining([expect.objectContaining({ params: expect.objectContaining({ developerInstructions: 'Use only the supplied ledger.', config: expect.objectContaining({ 'mcp_servers.ledger': expect.objectContaining({ url: 'http://127.0.0.1:1234/ledger' }) }) }) })]));
    expect(lastRequest(transport, 'thread/resume').params).toMatchObject({ developerInstructions: 'Use only verified tax rules.', config: { 'mcp_servers.tax_rules': expect.objectContaining({ url: 'http://127.0.0.1:1234/tax' }) } });
  } finally { await driver.close(); }
});
