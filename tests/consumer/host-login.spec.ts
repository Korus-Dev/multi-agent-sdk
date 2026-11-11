import { expect, it } from 'vitest';
import { CodexAppServerClient } from '@korus-dev/codex-sdk';
import { createInternalHarness } from '../../src/internal';
import { MockCodexAppServer, lastRequest } from '../codex/helpers/host-fixture';

const signedOut = () => ({ workspaceRouting: null, account: null, requiresOpenaiAuth: true });
const codexHost = (transport: MockCodexAppServer) => createInternalHarness('codex', { client: { name: 'login' }, codex: { host: { client: new CodexAppServerClient(transport) } } });

it('Codex login: a browser login starts the managed flow and returns a neutral login handle', async () => {
  const transport = new MockCodexAppServer({
    'account/read': signedOut,
    'account/login/start': () => ({ type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example.test/login' }),
  });
  const host = codexHost(transport);
  try {
    const result = await host.authenticate({ action: 'login' });
    expect(result).toMatchObject({ connected: false, login: { method: 'browser', id: 'login-1', url: 'https://auth.example.test/login' } });
    expect(lastRequest(transport, 'account/login/start')).toMatchObject({ params: { type: 'chatgpt' } });
  } finally { await host.close(); }
});

it('Codex login: a device-code login returns the verification URL and user code', async () => {
  const transport = new MockCodexAppServer({
    'account/read': signedOut,
    'account/login/start': () => ({ type: 'chatgptDeviceCode', loginId: 'device-1', verificationUrl: 'https://auth.example.test/device', userCode: 'ABCD-EFGH' }),
  });
  const host = codexHost(transport);
  try {
    const result = await host.authenticate({ action: 'login', method: 'deviceCode' });
    expect(result).toMatchObject({ connected: false, login: { method: 'deviceCode', id: 'device-1', url: 'https://auth.example.test/device', code: 'ABCD-EFGH' } });
    expect(lastRequest(transport, 'account/login/start')).toMatchObject({ params: { type: 'chatgptDeviceCode' } });
  } finally { await host.close(); }
});

it('Capabilities list the login methods a provider supports, and none when it has no managed login', async () => {
  const host = codexHost(new MockCodexAppServer({ 'account/read': signedOut }));
  try {
    expect(host.getCapabilities(host.open({ id: 'caps', folder: '/work' })).login).toEqual(['browser', 'deviceCode']);
  } finally { await host.close(); }
});
