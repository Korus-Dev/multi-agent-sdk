import { expect, it, vi } from 'vitest';
import type { HarnessDiagnostic } from '../../../src/diagnostics';
import { codexSdkFixture, sdkAgent } from './sdk-host-fixture';

it('reports native bind, projection and cache measurements through the caller sink only', async () => {
  const diagnostics: HarnessDiagnostic[] = [];
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubEnv('CODEX_APP_SDK_TRACE_CONVERSATION_LOAD', '1');
  const { driver } = codexSdkFixture(undefined, { onDiagnostic: record => diagnostics.push(record) });
  try {
    await driver.loadConversation(sdkAgent());
    await driver.loadConversation(sdkAgent());
    expect(diagnostics.map(record => record.stage)).toEqual(expect.arrayContaining([
      'load.begin', 'bind.driver-connected', 'bind.runtime-bound', 'bind.sdk-ready',
      'bind.settings-restored', 'frame.projected-and-emitted', 'bind.published', 'load.cold-ready', 'load.ttl-cache',
    ]));
    for (const record of diagnostics) {
      expect(record).toMatchObject({ layer: 'harness-adapter', agentId: 'agent-a', threadId: 'conversation-a', at: expect.any(Number) });
      expect(record.at).toBeGreaterThan(1_000_000_000_000);
      if (record.stageMs !== undefined) expect(record.stageMs).toBeGreaterThanOrEqual(0);
      if (record.elapsedMs !== undefined) expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(diagnostics).toContainEqual(expect.objectContaining({
      stage: 'frame.projected-and-emitted', revision: expect.any(Number), messages: 0,
      startAt: expect.any(Number), projectMs: expect.any(Number), emitMs: expect.any(Number),
    }));
    expect(warning).not.toHaveBeenCalled();
  } finally { await driver.close(); warning.mockRestore(); vi.unstubAllEnvs(); }
});

it('keeps native bind failure authoritative when diagnostic and error sinks throw', async () => {
  const observerError = new Error('observer failed');
  const diagnostics: HarnessDiagnostic[] = [];
  const onListenerError = vi.fn(() => { throw new Error('error observer failed'); });
  const { driver, conversation } = codexSdkFixture(undefined, {
    onDiagnostic: record => { diagnostics.push(record); throw observerError; }, onListenerError,
  });
  const failure = new Error('native load failed');
  conversation('conversation-a').handle.load.mockRejectedValueOnce(failure);
  try {
    await expect(driver.loadConversation(sdkAgent())).rejects.toBe(failure);
    expect(diagnostics.some(record => record.stage === 'bind.failed')).toBe(true);
    expect(onListenerError).toHaveBeenCalledWith(observerError);
    await expect(driver.loadConversation(sdkAgent())).resolves.toEqual({ kind: 'codex', threadId: 'conversation-a' });
    expect(diagnostics.some(record => record.stage === 'frame.projected-and-emitted')).toBe(true);
  } finally { await driver.close(); }
});
