import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CursorSession } from '../../../src/providers/cursor/session';

it('runs a caller-owned client and journal namespace through a real ACP child', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-cpa-'));
  let session: CursorSession | undefined;
  try {
    await cp(new URL('./fixtures/acp-agent.cjs', import.meta.url), path.join(root, 'acp-agent.cjs'));
    const command = path.join(root, 'agent');
    await writeFile(command, `#!${process.execPath}\nrequire('./acp-agent.cjs');\n`, { mode: 0o700 });
    const options = {
      agentId: 'tax-assistant', cwd: root, signal: new AbortController().signal,
      client: { name: 'cpa-workbench', metadataDirectory: 'accounting-sessions' },
      resolveCommand: () => command,
      runtime: { homePath: path.join(root, 'native-home'), isolated: false, environment: { ...process.env, CURSOR_API_KEY: undefined } },
      changed: () => {}, disconnected: () => {},
    };
    session = await CursorSession.open(options);
    const sessionId = session.sessionId;
    await session.prompt('Check the invoice', 'Check the invoice\n\nPrivate host context').completion;
    await session.close();
    const wire = (await readFile(path.join(root, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(wire.find(message => message.method === 'initialize').params.clientInfo).toStrictEqual({ name: 'cpa-workbench', version: '1' });
    const journal = JSON.parse((await readFile(path.join(options.runtime.homePath, 'accounting-sessions', encodeURIComponent(sessionId), 'prompts.jsonl'), 'utf8')).trim());
    expect(journal).toStrictEqual({ wireText: 'Check the invoice\n\nPrivate host context', text: 'Check the invoice', parts: [] });
  } finally { await session?.close(); await rm(root, { recursive: true, force: true }); }
});
