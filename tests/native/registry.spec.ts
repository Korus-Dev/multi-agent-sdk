import { expect, it } from 'vitest';
import { createProviderHost } from '../../src/harnesses';
import type { ProviderContext } from '../../src/driver';

it.each(['codex', 'claude', 'cursor', 'antigravity'] as const)('creates the %s adapter through one provider entry point without starting execution', async provider => {
  const driver = createProviderHost(provider, { client: { name: 'cpa-workbench', title: 'CPA workbench' } });
  const context: ProviderContext = { id: 'tax-assistant', folder: null, provider };
  try {
    expect(driver.provider).toBe(provider);
    expect(driver.getCapabilities(context).interrupt).toBe(true);
    expect(driver.getCapabilities(context)).not.toHaveProperty('codeReview');
    expect(driver.sendPrompt).toBeTypeOf('function');
    expect(driver.executeScopedPrompt).toBeTypeOf('function');
  } finally { await driver.close(); }
});
