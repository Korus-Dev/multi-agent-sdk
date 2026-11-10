import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '@korus-dev/codex-sdk';
import { createHarnessDriver } from '../../src';
import type { HarnessDriver, HarnessEvent, Session } from '../../src';
import { MockCodexAppServer, requestsFor, resumeResponse, thread, turn } from '../codex/helpers/codex-surface-fixture';
import { createQueryHarness } from '../native/claude/sdk-query-fixture';
import { writeAntigravityRuntimeFixture } from '../native/antigravity/session-fixture';

const text = (driver: HarnessDriver, session: Session) => driver.readSession(session).messages.flatMap(m => m.parts.flatMap(p => p.type === 'text' ? [p.text] : [])).join('\n');

it('Codex: CPA consumer observes native messages and completion through neutral state', async () => {
  const transport = new MockCodexAppServer({
    'thread/start': () => resumeResponse(thread('tax-session', false)),
    'thread/name/set': () => ({}),
    'thread/settings/update': () => ({}),
    'turn/start': () => ({ turn: turn('tax-turn', 'completed', [{ type: 'agentMessage', id: 'answer', text: 'Ledger verified.', phase: 'final_answer' }]) }),
  });
  const driver = createHarnessDriver('codex', { client: { name: 'cpa' }, codex: { surface: { client: new CodexAppServerClient(transport) } } });
  const input = { id: 'tax', folder: '/accounting' }; const original = structuredClone(input);
  const session = driver.open(input); const events: HarnessEvent[] = []; driver.onEvent(e => events.push(e));
  try {
    const admission = await driver.sendPrompt(session, 'Reconcile ledger');
    expect(admission).toMatchObject({ session, turnId: 'tax-turn' });
    transport.emitNotification('item/completed', { threadId: 'tax-session', turnId: 'tax-turn', item: { type: 'agentMessage', id: 'answer', text: 'Ledger verified.', phase: 'final_answer' } });
    transport.emitNotification('turn/completed', { threadId: 'tax-session', turn: turn('tax-turn', 'completed', []) });
    await expect.poll(() => text(driver, session)).toContain('Ledger verified.');
    expect(driver.readSession(session).busy).toBe(false);
    expect(events.some(e => e.type === 'session.changed')).toBe(true);
    expect(input).toEqual(original);
  } finally { await driver.close(); }
});

it('Codex: resuming and loading a native full-access chat never writes a default permission policy', async () => {
  const transport = new MockCodexAppServer({
    'thread/resume': () => ({ ...resumeResponse(thread('retained-access', false)), approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } }),
    'thread/settings/update': () => ({}),
  });
  const driver = createHarnessDriver('codex', { client: { name: 'cpa' }, codex: { surface: { client: new CodexAppServerClient(transport) } } });
  const session = driver.open({ id: 'restored', folder: '/accounting' });
  try {
    const ref = driver.restoreRef({ provider: 'codex', data: { backend: 'codex', threadId: 'retained-access' } });
    await driver.resumeConversation(session, { ref, storageState: 'active' });
    await driver.loadConversation(session);
    expect(driver.readSession(session).permission).toBe('full-access');
    const resumes = requestsFor(transport, 'thread/resume');
    expect(resumes.length).toBeGreaterThan(0);
    for (const request of resumes) {
      expect(request).toMatchObject({ params: { threadId: 'retained-access' } });
      expect('params' in request && request.params).not.toHaveProperty('approvalPolicy');
    }
    expect(requestsFor(transport, 'thread/settings/update')).toEqual([]);
  } finally { await driver.close(); }
});

it('Claude: admission precedes completion and neutral requests route to native approval', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neutral-claude-'));
  const fixture = createQueryHarness();
  const driver = createHarnessDriver('claude', { client: { name: 'cpa' }, claude: { transportOptions: { createQuery: fixture.createQuery }, host: { homeDir: root } } });
  const session = driver.open({ id: 'tax', folder: root });
  try {
    const sending = driver.sendPrompt(session, 'Reconcile ledger');
    await vi.waitFor(() => expect(fixture.inputs).toHaveLength(1));
    fixture.emit({ type: 'system', subtype: 'init', session_id: 'tax-session' });
    await sending;
    expect(driver.readSession(session).busy).toBe(true);
    const permission = fixture.options[0]!.canUseTool!('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'call', requestId: 'approval' });
    await vi.waitFor(() => expect(driver.readSession(session).requests).toHaveLength(1));
    await driver.respondToRequest(session, { id: driver.readSession(session).requests[0]!.id, outcome: { kind: 'decision', decision: 'allow' } });
    await expect(permission).resolves.toMatchObject({ behavior: 'allow' });
    fixture.emit({ type: 'assistant', uuid: 'answer', session_id: 'tax-session', message: { content: [{ type: 'text', text: 'Ledger verified.' }] } });
    fixture.emit({ type: 'result', subtype: 'success', session_id: 'tax-session', is_error: false });
    await expect.poll(() => driver.readSession(session).busy).toBe(false);
    expect(text(driver, session)).toContain('Ledger verified.');
  } finally { await driver.close(); await rm(root, { recursive: true, force: true }); }
});

for (const provider of ['cursor', 'antigravity'] as const) it(`${provider}: fixture-backed neutral CPA history, cancellation and scoped execution`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), `neutral-${provider}-`));
  let driver: HarnessDriver | undefined;
  try {
    if (provider === 'cursor') {
      await cp(new URL('../native/cursor/fixtures/acp-agent.cjs', import.meta.url), path.join(root, 'acp-agent.cjs'));
      await writeFile(path.join(root, 'version'), '2026.10.22-27dcf5f');
      const command = path.join(root, 'agent'); await writeFile(command, `#!${process.execPath}\nrequire('./acp-agent.cjs');\n`, { mode: 0o700 });
      driver = createHarnessDriver(provider, { client: { name: 'cpa' }, stateDirectory: () => root, cursor: { runtime: { homePath: path.join(root, 'home'), isolated: false, environment: { ...process.env, CURSOR_API_KEY: undefined } }, resolveCommand: () => command, sessionOptions: { resolveCommand: () => command } } });
    } else {
      await writeAntigravityRuntimeFixture(root); await writeFile(path.join(root, 'harness'), '', { mode: 0o700 });
      const runtime = { command: path.join(root, 'runtime'), harness: path.join(root, 'harness'), args: [] }; const home = path.join(root, 'home');
      driver = createHarnessDriver(provider, { client: { name: 'cpa' }, stateDirectory: () => root, antigravity: { home: () => home, resolveRuntime: () => runtime, runtimeOptions: () => ({ runtime, home }) } });
    }
    const host = driver; const session = host.open({ id: 'tax', folder: root });
    await host.sendPrompt(session, 'Check invoices');
    await expect.poll(() => host.readSession(session).busy).toBe(false);
    expect(text(host, session)).toContain('Check invoices');
    expect(host.readSession(session).messages.some(m => m.role === 'assistant')).toBe(true);
    const models = await host.listModels(session);
    expect(models.length).toBeGreaterThan(0);
    expect(host.getRuntimeStatus().status).toBe('running');
    if (provider === 'cursor') expect((await host.authenticate({ action: 'check' })).connected).toBe(true);
    if (provider === 'antigravity') {
      const generated = await host.generateText(session, { cwd: root, prompt: 'Summarize invoice categories', selectModel: options => ({ model: options[0]!.model }) });
      expect(generated.text.length).toBeGreaterThan(0);
    }
    const saved = host.getSessionData(session);
    expect(Object.keys(session)).toEqual([]);
    await host.release(session);
    const recovered = host.restoreSession({ id: 'tax', folder: root }, saved);
    expect(await host.loadConversation(recovered)).toBe(true);
    expect(text(host, recovered)).toContain('Check invoices');
    const summaries = await host.listConversations(recovered);
    expect(summaries.length).toBeGreaterThan(0);
    const ref = host.restoreRef(host.getRefData(summaries[0]!.ref));
    expect(Object.keys(ref)).toEqual([]);
    await host.resumeConversation(recovered, { ref, storageState: summaries[0]!.storageState });
    const scoped = await host.executeScopedPrompt(recovered, { cwd: root, prompt: 'Verify totals', scope: { id: 'ledger', mcpServers: [] } });
    expect(scoped.text.trim().length).toBeGreaterThan(0);
    if (provider === 'antigravity') {
      await host.sendPrompt(recovered, 'question');
      await expect.poll(() => host.readSession(recovered).requests.length).toBe(1);
      const request = host.readSession(recovered).requests[0]!;
      const foreign = host.open({ id: 'other', folder: root });
      await expect(host.respondToRequest(foreign, { id: request.id, outcome: { kind: 'cancelled' } })).rejects.toThrow('does not belong');
      if (request.kind !== 'question') throw new Error('Expected a neutral question.');
      const question = request.question.questions[0]!;
      await host.respondToRequest(recovered, { id: request.id, outcome: { kind: 'answered', answers: { [question.id]: { answers: [question.options![0]!.label] } } } });
      await expect.poll(() => host.readSession(recovered).busy).toBe(false);
      expect(host.readSession(recovered).requests).toEqual([]);
    }
    const abort = new AbortController();
    let privateScopeBusy = false;
    const off = host.onEvent(event => { if (event.type === 'session.changed' && event.session !== recovered && event.state.busy) privateScopeBusy = true; });
    const waiting = host.executeScopedPrompt(recovered, { cwd: root, prompt: 'wait', scope: { id: 'cancellable' }, signal: abort.signal });
    const cancelled = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect.poll(() => privateScopeBusy).toBe(true);
    abort.abort();
    await cancelled; off();
    expect(host.readSession(recovered).busy).toBe(false);
    const running = await host.sendPrompt(recovered, 'wait');
    await host.interrupt(recovered, running.turnId);
    await expect.poll(() => host.readSession(recovered).busy).toBe(false);
    expect(host.readSession(recovered).turns.at(-1)?.status).toBe('interrupted');
  } finally { await driver?.close(); await rm(root, { recursive: true, force: true }); }
});
