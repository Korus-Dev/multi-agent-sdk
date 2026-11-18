import { afterEach, describe, expect, it } from 'vitest';
import type { v2 } from '@korus-dev/codex-sdk';
import { harnessForHost } from '../../../src/internal';
import { codexModelToDescriptor } from '../../../src/providers/codex/host-catalog';
import { validateServiceTier } from '../../../src/providers/codex/host-settings';
import { codexSdkFixture, sdkAgent } from './sdk-host-fixture';

// A model's speed options come from Codex's own catalog and are shown as Codex reports them: a model that offers Ultrafast
// next to Fast shows both, selects either, and one it does not offer is refused.
const sol = (overrides: Partial<v2.Model> = {}): v2.Model => ({
  id: 'gpt-6.2-sol', model: 'gpt-6.2-sol', upgrade: null, upgradeInfo: null, availabilityNux: null, displayName: 'GPT-6.2-Sol',
  description: 'Fast, go-to model for coding and everyday work.', modelSpecialty: null, hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' }],
  defaultReasoningEffort: 'low', inputModalities: ['text', 'image'], supportsPersonality: false, multiAgentVersion: null,
  additionalSpeedTiers: ['fast', 'ultrafast'],
  serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }, { id: 'ultrafast', name: 'Ultrafast', description: 'The fastest available responses for latency-sensitive work.' }],
  defaultServiceTier: null, availableAccessPrograms: null, isDefault: true, ...overrides,
} as v2.Model);

describe('Codex model speed options', () => {
  const fixtures: ReturnType<typeof codexSdkFixture>[] = [];
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(({ driver }) => driver.close())); });

  it('lists every speed option the catalog gives a model, Ultrafast included', () => {
    expect(codexModelToDescriptor(sol()).serviceTiers).toEqual([
      { id: 'priority', name: 'Fast', description: '2x speed, increased usage' },
      { id: 'ultrafast', name: 'Ultrafast', description: 'The fastest available responses for latency-sensitive work.' },
    ]);
    expect(codexModelToDescriptor(sol({ serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }] })).serviceTiers?.map(tier => tier.id)).toEqual(['priority']);
  });

  it('accepts Ultrafast on a model that offers it and refuses a speed it does not', () => {
    const model = codexModelToDescriptor(sol());
    expect(() => validateServiceTier(model, 'ultrafast')).not.toThrow();
    expect(() => validateServiceTier(model, 'priority')).not.toThrow();
    expect(() => validateServiceTier(model, 'turbo')).toThrow("not available for 'GPT-6.2-Sol'");
    expect(() => validateServiceTier(codexModelToDescriptor(sol({ serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }] })), 'ultrafast')).toThrow('not available');
  });

  it('shows the speed options of a model in the neutral model list', async () => {
    const fixture = codexSdkFixture(); fixtures.push(fixture);
    fixture.host.listModels.mockResolvedValue([codexModelToDescriptor(sol())]);
    const harness = harnessForHost('codex', fixture.driver as never);
    const context = sdkAgent();
    const session = harness.restoreSession({ id: context.id, folder: context.folder }, { provider: 'codex', data: context.providerSession!, role: 'main' });
    const [model] = await harness.listModels(session);
    expect(model?.serviceTiers?.map(tier => [tier.id, tier.name])).toEqual([['priority', 'Fast'], ['ultrafast', 'Ultrafast']]);
    expect(harness.getProviderCapabilities().serviceTier).toBe(true);
  });

  it('sends the turn at the speed selected for the session', async () => {
    const fixture = codexSdkFixture(); fixtures.push(fixture);
    fixture.host.listModels.mockResolvedValue([codexModelToDescriptor(sol())]);
    const harness = harnessForHost('codex', fixture.driver as never);
    const context = sdkAgent();
    const session = harness.restoreSession({ id: context.id, folder: context.folder }, { provider: 'codex', data: context.providerSession!, role: 'main' });
    harness.updateDefaults(session, { model: 'gpt-6.2-sol', serviceTier: 'ultrafast' });
    await harness.sendPrompt(session, 'Go');
    const sent = fixture.conversation('conversation-a').handle.sendMessage.mock.calls.at(-1);
    expect(sent?.[1]).toMatchObject({ model: 'gpt-6.2-sol', serviceTier: 'ultrafast' });
  });
});
