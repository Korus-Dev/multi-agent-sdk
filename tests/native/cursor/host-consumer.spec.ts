import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createHarnessDriver } from '../../../src/backend';
import type { HarnessContext, HarnessDriver, HarnessEvent } from '../../../src/driver';

it('serves a non-Korus consumer through the unified driver and a caller-owned execution scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-host-cpa-'));
  let driver: HarnessDriver<HarnessContext, HarnessEvent> | undefined;
  try {
    await cp(new URL('./fixtures/acp-agent.cjs', import.meta.url), path.join(root, 'acp-agent.cjs'));
    await writeFile(path.join(root, 'version'), '2026.10.22-27dcf5f');
    const command = path.join(root, 'agent');
    await writeFile(command, `#!${process.execPath}\nrequire('./acp-agent.cjs');\n`, { mode: 0o700 });
    const events: HarnessEvent[] = [];
    driver = createHarnessDriver('cursor', { client: { name: 'cpa-workbench', metadataDirectory: 'accounting-sessions' }, stateDirectory: () => root, cursor: {
      runtime: { homePath: path.join(root, 'native-home'), isolated: false, environment: { ...process.env, CURSOR_API_KEY: undefined } },
      resolveCommand: () => command,
      sessionOptions: { client: { name: 'cpa-workbench', metadataDirectory: 'accounting-sessions' }, resolveCommand: () => command },
    } });
    driver.onEvent(event => events.push(event));
    const context: HarnessContext = { id: 'tax-assistant', backend: 'cursor', folder: root, name: 'Tax assistant' };
    const started = await driver.sendPrompt(context, 'Check invoices');
    context.backendSession = started.backendSession;
    // Loading after completion is the public read path; the fixture completes synchronously after its prompt.
    await expect.poll(() => events.some(event => event.type === 'agent.statusChanged' && event.payload.type === 'idle')).toBe(true);
    const messages = await driver.readConversationMessages!({ backend: 'cursor', folder: root, sessionId: started.backendSession.kind === 'cursor' ? started.backendSession.sessionId : '' }, context.id);
    expect(messages.filter(message => message.role === 'user').map(message => message.parts.filter(part => part.type === 'text').map(part => part.text).join(''))).toStrictEqual(['Check invoices']);
    const scoped = await driver.executeScopedPrompt!(context, { cwd: root, prompt: 'Classify invoices', session: context.backendSession, scope: { id: 'tax-rules', mcpServers: [] } });
    expect(scoped.text.trim().length).toBeGreaterThan(0);
    expect(scoped.session.kind).toBe('cursor');
    expect(driver.getCapabilities(context)).not.toHaveProperty('codeReview');
    const wire = (await readFile(path.join(root, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(wire.filter(message => message.method === 'initialize').every(message => message.params.clientInfo.name === 'cpa-workbench')).toBe(true);
    expect(wire.filter(message => message.method === 'session/prompt').map(message => message.params.prompt[0].text)).toStrictEqual(['Check invoices', 'Classify invoices']);
  } finally { await driver?.close(); await rm(root, { recursive: true, force: true }); }
});
