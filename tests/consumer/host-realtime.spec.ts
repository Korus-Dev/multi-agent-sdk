import { expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '@korus-dev/codex-sdk';
import { HarnessUnsupportedError } from '../../src';
import { createInternalHarness } from '../../src/internal';
import { adaptHarness } from '../../src/consumer';
import type { ProviderContext } from '../../src/context';
import type { ProviderDriver, ProviderEvent } from '../../src/driver';
import { MockCodexAppServer, lastRequest, requestsFor, resumeResponse, thread } from '../codex/helpers/host-fixture';

it('Codex realtime: a Host session starts, receives input, and stops through neutral operations', async () => {
  const transport = new MockCodexAppServer({
    'thread/start': () => resumeResponse(thread('realtime-thread', false)),
    'thread/settings/update': () => ({}),
    'thread/realtime/start': () => ({}),
    'thread/realtime/appendText': () => ({}),
    'thread/realtime/appendAudio': () => ({}),
    'thread/realtime/stop': () => ({}),
  });
  const host = createInternalHarness('codex', { client: { name: 'realtime' }, codex: { host: { client: new CodexAppServerClient(transport) } } });
  const session = host.open({ id: 'voice', folder: '/work' });
  try {
    expect(host.getCapabilities(session).realtime).toBe(true);
    const realtime = await host.startRealtime(session, { outputModality: 'text', version: 'v2' });
    expect(lastRequest(transport, 'thread/realtime/start')).toMatchObject({ params: { threadId: 'realtime-thread', outputModality: 'text', version: 'v2' } });
    await realtime.appendText('Hello');
    expect(lastRequest(transport, 'thread/realtime/appendText')).toMatchObject({ params: { threadId: 'realtime-thread', text: 'Hello' } });
    await realtime.appendAudio({ data: new Uint8Array([1, 2, 3, 4]), sampleRate: 16_000, numChannels: 1 });
    expect(requestsFor(transport, 'thread/realtime/appendAudio')).toHaveLength(1);
    await realtime.stop();
    expect(requestsFor(transport, 'thread/realtime/stop')).toHaveLength(1);
  } finally { await host.close(); }
});

it('A provider without realtime reports it in capabilities and rejects with the typed unsupported error', async () => {
  const native = { onEvent: () => () => {}, getCapabilities: () => ({}), close: vi.fn(async () => {}) };
  const host = adaptHarness('cursor', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  const session = host.open({ id: 'none', folder: '/work' });
  expect(host.getCapabilities(session).realtime).toBe(false);
  await expect(host.startRealtime(session, { outputModality: 'text' })).rejects.toBeInstanceOf(HarnessUnsupportedError);
});
