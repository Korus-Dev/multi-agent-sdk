import { expect, it } from 'vitest';
import { createHarness } from '../../src';

// Compiled, never run: the options type follows the chosen provider.
const typed = () => {
  createHarness('codex', { client: { name: 'x' }, codex: { readOnly: true } });
  // @ts-expect-error A Codex harness takes no Claude block.
  createHarness('codex', { client: { name: 'x' }, claude: {} });
  const provider = 'claude' as 'codex' | 'claude';
  createHarness(provider, { client: { name: 'x' }, codex: { readOnly: true }, claude: {} });
};

it('types options per provider', () => { expect(typed).toBeTypeOf('function'); });
