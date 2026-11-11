import { expect, it } from 'vitest';
import { createHarness } from '../../src';
import type { HarnessMcpEndpoint } from '../../src';
import { codexSdkFixture, sdkAgent } from './codex/sdk-host-fixture';

for (const provider of ['codex', 'claude', 'cursor', 'antigravity'] as const) it(`${provider} rejects unknown scoped trust policy before native execution`, async () => {
  const driver = createHarness(provider, { client: { name: 'cpa' } });
  const session = driver.open({ id: 'main', folder: '/tmp' });
  try {
    await expect(driver.executeScopedPrompt(session, { cwd: '/tmp', prompt: 'none', scope: { id: 'invalid', mcpServers: [{ name: 'ledger', url: 'http://127.0.0.1:1', approval: 'force-human' as HarnessMcpEndpoint['approval'] }] } })).rejects.toThrow('Unsupported MCP approval policy');
    expect(driver.readSession(session).messages).toEqual([]);
  } finally { await driver.close(); }
});
for (const provider of ['claude', 'cursor', 'antigravity'] as const) it(`${provider} rejects required scoped servers`, async () => {
  const driver = createHarness(provider, { client: { name: 'cpa' } });
  const session = driver.open({ id: 'main', folder: '/tmp' });
  try {
    await expect(driver.executeScopedPrompt(session, { cwd: '/tmp', prompt: 'none', scope: { id: 'invalid', mcpServers: [{ name: 'ledger', url: 'http://127.0.0.1:1', required: true }] } })).rejects.toThrow('does not support required MCP servers');
  } finally { await driver.close(); }
});
for (const provider of ['cursor', 'antigravity'] as const) it(`${provider} rejects unsupported automatic scoped approval`, async () => {
  const driver = createHarness(provider, { client: { name: 'cpa' } });
  const session = driver.open({ id: 'main', folder: '/tmp' });
  try {
    await expect(driver.executeScopedPrompt(session, { cwd: '/tmp', prompt: 'none', scope: { id: 'invalid', mcpServers: [{ name: 'ledger', url: 'http://127.0.0.1:1', approval: 'auto' }] } })).rejects.toThrow('does not support automatic MCP approval');
  } finally { await driver.close(); }
});
it.each(['inherit', 'auto'] as const)('Codex utility preserves explicit %s policy and optional requiredness', async approval => {
  const { adapter, host, driver } = codexSdkFixture();
  host.generateText.mockResolvedValue({ text: 'Done' });
  try {
    await adapter.generateText(sdkAgent(), { cwd: '/tmp', prompt: 'Read', mcpServers: [{ name: 'ledger', url: 'http://127.0.0.1:1234', enabledTools: ['read'], approval }] });
    const server = host.generateText.mock.calls[0]![1]!.mcpServers![0]!;
    expect(server).toMatchObject({ name: 'ledger', enabledTools: ['read'] });
    expect(server.toolApprovalMode).toBe(approval === 'auto' ? 'auto' : undefined);
    expect(server.required).toBeUndefined();
  } finally { await driver.close(); }
});
for (const provider of ['codex', 'claude', 'antigravity'] as const) it(`${provider} utility rejects unknown trust policy before launching`, async () => {
  const driver = createHarness(provider, { client: { name: 'cpa' } });
  const session = driver.open({ id: 'main', folder: '/tmp' });
  try {
    await expect(driver.generateText(session, { cwd: '/tmp', prompt: 'none', mcpServers: [{ name: 'ledger', url: 'http://127.0.0.1:1', enabledTools: [], approval: 'force-human' as HarnessMcpEndpoint['approval'] }] })).rejects.toThrow('Unsupported MCP approval policy');
  } finally { await driver.close(); }
});
for (const provider of ['claude', 'antigravity'] as const) it(`${provider} utility rejects required servers before launching`, async () => {
  const driver = createHarness(provider, { client: { name: 'cpa' } });
  const session = driver.open({ id: 'main', folder: '/tmp' });
  try {
    await expect(driver.generateText(session, { cwd: '/tmp', prompt: 'none', mcpServers: [{ name: 'ledger', url: 'http://127.0.0.1:1', enabledTools: [], required: true }] })).rejects.toThrow('does not support required MCP servers');
  } finally { await driver.close(); }
});
it('Antigravity utility rejects automatic approval rather than silently trusting a tool', async () => {
  const driver = createHarness('antigravity', { client: { name: 'cpa' } });
  const session = driver.open({ id: 'main', folder: '/tmp' });
  try {
    await expect(driver.generateText(session, { cwd: '/tmp', prompt: 'none', mcpServers: [{ name: 'ledger', url: 'http://127.0.0.1:1', enabledTools: [], approval: 'auto' }] })).rejects.toThrow('does not support automatic MCP approval');
  } finally { await driver.close(); }
});
