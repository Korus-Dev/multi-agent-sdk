import { expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '@korus-dev/codex-sdk';
import { HarnessUnsupportedError, type HarnessOptions } from '../../src';
import { createInternalHarness } from '../../src/internal';
import { adaptHarness } from '../../src/consumer';
import type { ProviderContext } from '../../src/context';
import type { ProviderDriver, ProviderEvent } from '../../src/driver';
import { MockCodexAppServer, lastRequest, requestsFor, thread } from '../codex/helpers/host-fixture';

it('A recovery tool unarchives a Codex conversation by reference, with a custom home and executable and no session', async () => {
  // The options a headless tool passes: home directory plus the Codex executable to launch.
  const toolOptions = { client: { name: 'recovery' }, home: '/Users/me/.codex-home', codex: { launch: { command: '/opt/codex' } } } satisfies HarnessOptions;
  expect(toolOptions.codex.launch.command).toBe('/opt/codex');

  const transport = new MockCodexAppServer({ 'thread/archive': () => ({}), 'thread/unarchive': params => ({ thread: thread((params as { threadId: string }).threadId, false) }) });
  const host = createInternalHarness('codex', { client: { name: 'recovery' }, codex: { host: { client: new CodexAppServerClient(transport) } } });
  try {
    const ref = host.restoreRef({ provider: 'codex', data: { provider: 'codex', threadId: 'recovered-thread' } });
    await host.setConversationStorage(ref, 'active');
    expect(lastRequest(transport, 'thread/unarchive')).toMatchObject({ params: { threadId: 'recovered-thread' } });
    await host.setConversationStorage(ref, 'archived');
    expect(requestsFor(transport, 'thread/archive')).toHaveLength(1);
  } finally { await host.close(); }
});

it('A provider that cannot change conversation storage rejects with the typed unsupported error', async () => {
  const native = { onEvent: () => () => {}, getCapabilities: () => ({}), close: vi.fn(async () => {}) };
  const host = adaptHarness('cursor', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  const ref = host.restoreRef({ provider: 'cursor', data: { provider: 'cursor', sessionId: 'chat', folder: '/work' } });
  await expect(host.setConversationStorage(ref, 'archived')).rejects.toBeInstanceOf(HarnessUnsupportedError);
});
