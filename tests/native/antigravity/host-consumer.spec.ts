import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createProviderHost } from '../../../src/harnesses';
import { AntigravityHost } from '../../../src/providers/antigravity/host';
import { antigravityModels } from '../../../src/providers/antigravity/catalog';
import type { ProviderContext, ProviderDriver, ProviderEvent } from '../../../src/driver';
import { writeAntigravityRuntimeFixture } from './session-fixture';

it('runs a caller-owned Antigravity client and selects utility models without product tiers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-antigravity-cpa-'));
  let host: ProviderDriver<ProviderContext, ProviderEvent> | undefined;
  try {
    await writeAntigravityRuntimeFixture(root);
    await writeFile(path.join(root, 'harness'), '', { mode: 0o700 });
    const runtime = { command: path.join(root, 'runtime'), args: [] };
    const home = path.join(root, 'native-home');
    host = createProviderHost('antigravity', { client: { name: 'cpa-workbench', title: 'Accounting workbench', metadataDirectory: 'accounting-sessions' }, stateDirectory: () => root, antigravity: { home: () => home, resolveRuntime: () => runtime,
      runtimeOptions: () => ({ runtime, home }),
    } });
    const context: ProviderContext = { id: 'tax-assistant', provider: 'antigravity', folder: root, providerDefaults: { kind: 'antigravity', model: 'opaque-oss-id', permission: 'accept-edits' } };
    const events: ProviderEvent[] = [];
    host.onEvent(event => events.push(event));
    const started = await host.sendPrompt(context, 'Check invoices');
    context.providerSession = started.providerSession;
    await expect.poll(() => events.some(event => event.type === 'agent.statusChanged' && event.payload.type === 'idle')).toBe(true);
    // The conversation reports the model and permission it runs with, as every harness does.
    expect(events).toContainEqual(expect.objectContaining({ type: 'conversation.settingsUpdated', agentId: 'tax-assistant', payload: { settings: { model: 'opaque-oss-id', permission: 'accept-edits' } } }));
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
  const runtime = { command: path.join(root, 'runtime'), args: [] };
  const home = path.join(root, 'native-home');
  const host = new AntigravityHost({ home: () => home, stateDirectory: () => root, resolveRuntime: () => runtime, runtimeOptions: () => ({ runtime, home }) });
  try {
    await host.executeScopedPrompt({ id: 'tax', provider: 'antigravity', folder: root }, { cwd: root, prompt: 'Verify totals', scope: { id: 'ledger', mcpServers: [], developerInstructions: 'Use only the supplied ledger.' }, options: { selection: { model: 'opaque-oss-id' } } });
    expect(JSON.parse(await readFile(path.join(root, 'fixture-prompt.json'), 'utf8'))[0].text).toContain('Use only the supplied ledger.');
    expect(JSON.parse(await readFile(path.join(root, 'fixture-model.json'), 'utf8'))).toMatchObject({ configId: 'model', value: 'opaque-oss-id' });
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

it('leaves an active Antigravity turn intact when another scope is requested', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-antigravity-busy-'));
  await writeAntigravityRuntimeFixture(root);
  await writeFile(path.join(root, 'harness'), '');
  const runtime = { command: path.join(root, 'runtime'), args: [] };
  const home = path.join(root, 'native-home');
  const host = new AntigravityHost({ home: () => home, stateDirectory: () => root, resolveRuntime: () => runtime, runtimeOptions: () => ({ runtime, home }) });
  const context: ProviderContext = { id: 'tax', provider: 'antigravity', folder: root };
  try {
    const started = await host.sendPrompt(context, 'wait');
    context.providerSession = started.providerSession;
    const before = await readFile(path.join(root, 'fixture-session.json'), 'utf8');
    await expect(host.executeScopedPrompt(context, { cwd: root, prompt: 'Audit', session: context.providerSession, scope: { id: 'audit', mcpServers: [] } })).rejects.toThrow(/active|busy|running|during a turn/i);
    expect(await readFile(path.join(root, 'fixture-session.json'), 'utf8')).toBe(before);
    await host.interrupt(context, started.turnId);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

it('rejects structured output instead of adding wording of its own to the prompt', async () => {
  const { HarnessUnsupportedError } = await import('../../../src/errors');
  const host = new AntigravityHost({});
  try {
    await expect(host.generateText({ id: 'a', provider: 'antigravity', folder: '/tmp' }, { cwd: '/tmp', prompt: 'x', outputSchema: { type: 'object' } })).rejects.toBeInstanceOf(HarnessUnsupportedError);
  } finally { await host.close(); }
});

it('plans in the CLI\'s own plan mode, hands over the plan it wrote, and leaves the mode on the next turn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'antigravity-plan-'));
  await writeAntigravityRuntimeFixture(root);
  const runtime = { command: path.join(root, 'runtime'), args: [] };
  const home = path.join(root, 'native-home');
  const host = new AntigravityHost({ home: () => home, stateDirectory: () => root, resolveRuntime: () => runtime, runtimeOptions: () => ({ runtime, home }) });
  await writeFile(path.join(root, 'usage-fixture.json'), JSON.stringify({ configuration: {
    models: { currentModelId: 'gemini-3.8-flash-high', availableModels: [{ modelId: 'gemini-3.8-flash-high' }, { modelId: 'gemini-3.8-flash-low' }] },
    configOptions: [{ id: 'model', currentValue: 'gemini-3.8-flash', options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] },
      { id: 'thought_level', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }],
  } }));
  const agent: ProviderContext = { id: 'planner', provider: 'antigravity', folder: root, providerDefaults: { kind: 'antigravity', permission: 'accept-edits', reasoningEffort: 'low' } };
  const events: ProviderEvent[] = [];
  host.onEvent(event => events.push(event));
  try {
    const planned = await host.sendPrompt(agent, 'Plan the change', { planMode: true });
    agent.providerSession = planned.providerSession;
    await expect.poll(() => events.find(event => event.type === 'agentRequest.created')).toBeTruthy();
    const request = (events.find(event => event.type === 'agentRequest.created')!.payload as { request: { id: string } }).request;
    await host.respondToAgentRequest({ id: request.id, agentId: agent.id, outcome: { kind: 'answered', answers: { interaction_plan: { answers: ['Minimal'] } } } });
    await expect.poll(() => events.find(event => event.type === 'plan.readyForReview')?.payload).toEqual({ markdown: '# Native plan\n\n1. Make the scoped change.\n2. Verify it.' });
    // The thinking level reaches the CLI as its own setting.
    expect(JSON.parse(await readFile(path.join(root, 'fixture-model.json'), 'utf8'))).toMatchObject({ configId: 'thought_level', value: 'low' });
    await host.sendPrompt(agent, 'Now do it');
    expect((await readFile(path.join(root, 'fixture-modes'), 'utf8')).trim().split('\n')).toEqual(['plan', 'accept-edits']);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

it('offers each model once, with the thinking levels the CLI lists for it', () => {
  const level = (value: string) => ({ value, name: value[0]!.toUpperCase() + value.slice(1) });
  expect(antigravityModels({
    models: { currentModelId: 'gemini-3.8-flash-high', availableModels: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gpt-oss-120b-medium'].map(modelId => ({ modelId, name: modelId })) },
    configOptions: [
      { id: 'model', currentValue: 'gemini-3.8-flash', options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }] },
      { id: 'thought_level', currentValue: 'high', options: [level('low'), level('medium'), level('high')] },
    ],
  })).toStrictEqual([
    { id: 'gemini-3.8-flash', model: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', isDefault: true, defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }, { reasoningEffort: 'high', description: 'High' }] },
    { id: 'gpt-oss-120b-medium', model: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)', isDefault: false },
  ]);
});

it('applies the thinking level a generation asks for, where the model offers it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'antigravity-generation-'));
  await writeAntigravityRuntimeFixture(root);
  const runtime = { command: path.join(root, 'runtime'), args: [] };
  const home = path.join(root, 'native-home');
  await writeFile(path.join(root, 'usage-fixture.json'), JSON.stringify({ configuration: {
    models: { currentModelId: 'gemini-high', availableModels: [{ modelId: 'gemini-high' }, { modelId: 'gemini-low' }, { modelId: 'plain' }] },
    configOptions: [{ id: 'model', currentValue: 'gemini', options: [{ value: 'gemini', name: 'Gemini' }, { value: 'plain', name: 'Plain' }] },
      { id: 'thought_level', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }],
  } }));
  const host = new AntigravityHost({ home: () => home, stateDirectory: () => root, resolveRuntime: () => runtime, runtimeOptions: () => ({ runtime, home }) });
  const agent: ProviderContext = { id: 'writer', provider: 'antigravity', folder: root };
  const configured = async () => JSON.parse(await readFile(path.join(root, 'fixture-config.jsonl'), 'utf8').then(text => `[${text.trim().split('\n').join(',')}]`, () => '[]')) as Array<{ configId: string; value: string }>;
  try {
    await host.generateText!(agent, { cwd: root, prompt: 'Summarize', selection: { model: 'gemini', reasoningEffort: 'low' } });
    expect((await configured()).map(call => [call.configId, call.value])).toStrictEqual([['model', 'gemini'], ['thought_level', 'low']]);
    // A level the model does not offer cannot be honoured, and saying nothing would hide that.
    await expect(host.generateText!(agent, { cwd: root, prompt: 'Summarize', selection: { model: 'gemini', reasoningEffort: 'max' } })).rejects.toThrow('Antigravity does not offer this thinking level for the selected model.');
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
