import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createHarnessDriver } from '../../../src/backend';
import { AntigravityHost } from '../../../src/providers/antigravity/host';
import type { HarnessContext, HarnessDriver, HarnessEvent } from '../../../src/driver';
import { writeAntigravityRuntimeFixture } from './session-fixture';

it('runs a caller-owned Antigravity client and selects utility models without product tiers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-antigravity-cpa-'));
  let host: HarnessDriver<HarnessContext, HarnessEvent> | undefined;
  try {
    await writeAntigravityRuntimeFixture(root);
    await writeFile(path.join(root, 'harness'), '', { mode: 0o700 });
    const runtime = { command: path.join(root, 'runtime'), harness: path.join(root, 'harness'), args: [] };
    const home = path.join(root, 'native-home');
    host = createHarnessDriver('antigravity', { client: { name: 'cpa-workbench', title: 'Accounting workbench', metadataDirectory: 'accounting-sessions' }, stateDirectory: () => root, antigravity: { home: () => home, resolveRuntime: () => runtime,
      runtimeOptions: () => ({ runtime, home }),
    } });
    const context: HarnessContext = { id: 'tax-assistant', backend: 'antigravity', folder: root };
    const events: HarnessEvent[] = [];
    host.onEvent(event => events.push(event));
    const started = await host.sendPrompt(context, 'Check invoices');
    context.backendSession = started.backendSession;
    await expect.poll(() => events.some(event => event.type === 'agent.statusChanged' && event.payload.type === 'idle')).toBe(true);
    const initialization = JSON.parse(await readFile(path.join(root, 'fixture-initialize.json'), 'utf8'));
    expect(initialization.clientInfo).toStrictEqual({ name: 'cpa-workbench', title: 'Accounting workbench', version: '1' });
    const attached = events.filter(event => event.type === 'antigravity.conversationSnapshotChanged').length;
    const result = await host.generateText!(context, { cwd: root, prompt: 'Summarize invoice categories', selectModel: models => ({ model: models.find(model => model.model === 'opaque-oss-id')!.model }) });
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(events.filter(event => event.type === 'antigravity.conversationSnapshotChanged')).toHaveLength(attached);
    expect(host.getCapabilities(context)).not.toHaveProperty('codeReview');
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

it('applies caller instructions and execution selection to a scoped Antigravity turn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-antigravity-scope-'));
  await writeAntigravityRuntimeFixture(root);
  await writeFile(path.join(root, 'harness'), '');
  const runtime = { command: path.join(root, 'runtime'), harness: path.join(root, 'harness'), args: [] };
  const home = path.join(root, 'native-home');
  const host = new AntigravityHost({ home: () => home, stateDirectory: () => root, resolveRuntime: () => runtime, runtimeOptions: () => ({ runtime, home }) });
  try {
    await host.executeScopedPrompt({ id: 'tax', backend: 'antigravity', folder: root }, { cwd: root, prompt: 'Verify totals', scope: { id: 'ledger', mcpServers: [], developerInstructions: 'Use only the supplied ledger.' }, options: { selection: { model: 'opaque-oss-id' } } });
    expect(JSON.parse(await readFile(path.join(root, 'fixture-prompt.json'), 'utf8'))[0].text).toContain('Use only the supplied ledger.');
    expect(JSON.parse(await readFile(path.join(root, 'fixture-model.json'), 'utf8'))).toMatchObject({ configId: 'model', value: 'opaque-oss-id' });
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

it('leaves an active Antigravity turn intact when another scope is requested', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-antigravity-busy-'));
  await writeAntigravityRuntimeFixture(root);
  await writeFile(path.join(root, 'harness'), '');
  const runtime = { command: path.join(root, 'runtime'), harness: path.join(root, 'harness'), args: [] };
  const home = path.join(root, 'native-home');
  const host = new AntigravityHost({ home: () => home, stateDirectory: () => root, resolveRuntime: () => runtime, runtimeOptions: () => ({ runtime, home }) });
  const context: HarnessContext = { id: 'tax', backend: 'antigravity', folder: root };
  try {
    const started = await host.sendPrompt(context, 'wait');
    context.backendSession = started.backendSession;
    const before = await readFile(path.join(root, 'fixture-session.json'), 'utf8');
    await expect(host.executeScopedPrompt(context, { cwd: root, prompt: 'Audit', session: context.backendSession, scope: { id: 'audit', mcpServers: [] } })).rejects.toThrow(/active|busy|running|during a turn/i);
    expect(await readFile(path.join(root, 'fixture-session.json'), 'utf8')).toBe(before);
    await host.interrupt(context, started.turnId);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
