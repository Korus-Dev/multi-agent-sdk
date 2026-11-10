import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createHarnessDriver } from '../../src';
import { createQueryHarness } from '../native/claude/sdk-query-fixture';

afterEach(() => vi.unstubAllEnvs());

it('switches Claude home A to B to native default after fully closing each driver', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'harness-homes-')));
  const cwd = path.join(root, 'workspace');
  const standard = path.join(root, 'standard');
  vi.stubEnv('CLAUDE_CONFIG_DIR', standard);
  try {
    await mkdir(cwd);
    for (const [index, home] of [path.join(root, 'A'), path.join(root, 'B'), undefined].entries()) {
      const effective = home ?? standard;
      const id = randomUUID();
      const transcript = path.join(effective, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
      await mkdir(path.dirname(transcript), { recursive: true });
      await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: id, uuid: randomUUID(), cwd, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: `Home ${index}` } }) + '\n');
      const fixture = createQueryHarness();
      const driver = createHarnessDriver('claude', { client: { name: 'home-test' }, home, claude: { transportOptions: { createQuery: fixture.createQuery } } });
      const session = driver.open({ id: 'chat', folder: cwd });
      try {
        const listed = await driver.listConversations(session);
        expect(listed.map(chat => chat.id)).toContain(id);
        const sending = driver.sendPrompt(session, 'Hello');
        void sending.catch(() => {});
        await vi.waitFor(() => expect(fixture.inputs).toHaveLength(1));
        fixture.emit({ type: 'system', subtype: 'init', session_id: id });
        await sending;
        expect(fixture.options[0]!.env?.CLAUDE_CONFIG_DIR).toBe(effective);
      } finally { await driver.close(); }
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(standard);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects ambiguous home configuration before creating a provider runtime', () => {
  expect(() => createHarnessDriver('codex', { client: { name: 'home-test' }, home: 'relative' })).toThrow(/absolute/);
  expect(() => createHarnessDriver('codex', { client: { name: 'home-test' }, home: '/one', codex: { surface: { codexHome: '/two' } } })).toThrow(/conflict/);
});
