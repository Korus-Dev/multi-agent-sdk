import { expect, it } from 'vitest';
import { createScriptedHarness } from '../../src/testing';
import { harnessProviders } from '../../src/contracts-entry';

// Each harness lists the slash commands it handles itself; an app offers them without knowing the harness.
it.each(harnessProviders)('lists the %s commands through its capabilities, each named once and owned by it', provider => {
  const { harness } = createScriptedHarness(provider);
  const session = harness.open({ id: 'agent', folder: '/work' });
  const commands = harness.getCapabilities(session).commands ?? [];
  expect(commands.length).toBeGreaterThan(0);
  expect(commands.every(command => command.provider === provider && command.id === `${provider}.${command.name}`)).toBe(true);
  expect(new Set(commands.map(command => command.slashName)).size).toBe(commands.length);
  expect(commands.some(command => command.slashName === 'plan')).toBe(true);
});
