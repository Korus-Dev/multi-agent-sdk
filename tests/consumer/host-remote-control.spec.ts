import { expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '@korus-dev/codex-sdk';
import { HarnessUnsupportedError } from '../../src';
import { createInternalHarness } from '../../src/internal';
import { adaptHarness } from '../../src/consumer';
import type { ProviderContext } from '../../src/context';
import type { ProviderDriver, ProviderEvent } from '../../src/driver';
import { MockCodexAppServer, configRequirements, lastRequest } from '../codex/helpers/host-fixture';

const connected = { status: 'connected' as const, serverName: 'codex-desktop', installationId: 'installation-1', environmentId: 'environment-1' };

it('Codex remote control: status, enable, disable, pairing and paired devices go through the neutral Host', async () => {
  const transport = new MockCodexAppServer({
    'configRequirements/read': () => ({ supportsIndependentSpeedModes: null, requirements: configRequirements({ allowRemoteControl: true }) }),
    'remoteControl/status/read': () => connected,
    'remoteControl/enable': () => ({ ...connected, status: 'connecting' as const }),
    'remoteControl/disable': () => ({ ...connected, status: 'disabled' as const, environmentId: null }),
    'remoteControl/pairing/start': () => ({ pairingCode: 'pairing-code', manualPairingCode: '1234-5678', environmentId: 'environment-1', expiresAt: 1_700_000_000n }),
    'remoteControl/pairing/status': () => ({ claimed: true }),
    'remoteControl/client/list': () => ({ data: [{ clientId: 'client-1', displayName: 'Nicolas phone', deviceType: 'phone', platform: 'ios', osVersion: '18.0', deviceModel: 'iPhone', appVersion: '1.0.0', lastSeenAt: 1_700_000_000n }], nextCursor: null }),
    'remoteControl/client/revoke': () => ({}),
  });
  const host = createInternalHarness('codex', { client: { name: 'remote' }, codex: { host: { client: new CodexAppServerClient(transport) } } });
  try {
    expect(host.getCapabilities(host.open({ id: 'caps', folder: '/work' })).remoteControl).toBe(true);
    await expect(host.getRemoteControl()).resolves.toMatchObject({ status: 'connected', environmentId: 'environment-1', allowRemoteControl: true });
    await expect(host.setRemoteControl(true)).resolves.toMatchObject({ status: 'connecting' });
    await expect(host.setRemoteControl(false)).resolves.toMatchObject({ status: 'disabled', environmentId: null });
    const pairing = await host.startDevicePairing();
    expect(pairing).toMatchObject({ pairingCode: 'pairing-code', manualPairingCode: '1234-5678', environmentId: 'environment-1' });
    await expect(host.checkDevicePairing(pairing)).resolves.toBe(true);
    await expect(host.listPairedDevices('environment-1')).resolves.toMatchObject([{ clientId: 'client-1', displayName: 'Nicolas phone' }]);
    await host.revokePairedDevice('environment-1', 'client-1');
    expect(lastRequest(transport, 'remoteControl/client/revoke')).toMatchObject({ params: { environmentId: 'environment-1', clientId: 'client-1' } });
  } finally { await host.close(); }
});

it('A provider without remote control reports it in capabilities and rejects with a typed unsupported error', async () => {
  const native = { onEvent: () => () => {}, getCapabilities: () => ({}), close: vi.fn(async () => {}) };
  const host = adaptHarness('claude', native as unknown as ProviderDriver<ProviderContext, ProviderEvent>);
  expect(host.getCapabilities(host.open({ id: 'none', folder: '/work' }))).toMatchObject({ remoteControl: false, realtime: false, login: [] });
  const failure = await host.getRemoteControl().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(HarnessUnsupportedError);
  expect(failure).toMatchObject({ code: 'unsupported', operation: 'Remote control' });
  for (const call of [() => host.setRemoteControl(true), () => host.startDevicePairing(), () => host.listPairedDevices('e'), () => host.revokePairedDevice('e', 'c')]) {
    await expect(call()).rejects.toBeInstanceOf(HarnessUnsupportedError);
  }
});
