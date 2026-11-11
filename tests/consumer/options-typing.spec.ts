import { expect, it } from 'vitest';
import { createHarness } from '../../src';

// Compiled, never run: the options type follows the chosen provider.
const typed = () => {
  createHarness('codex', { client: { name: 'x' }, codex: { readOnly: true } });
  // @ts-expect-error A Codex harness takes no Claude block.
  createHarness('codex', { client: { name: 'x' }, claude: {} });
  const provider = 'claude' as 'codex' | 'claude';
  createHarness(provider, { client: { name: 'x' }, codex: { readOnly: true }, claude: {} });
  const codex = createHarness('codex', { client: { name: 'x' } });
  const session = codex.open({ id: 'a', folder: null });
  void codex.setPermission(session, 'full-access');
  // @ts-expect-error Claude permission modes are not Codex approval presets.
  void codex.setPermission(session, 'acceptEdits');
  const claude: import('../../src/claude').ClaudePermission = 'bypassPermissions';
  void claude;
  // A harness whose provider is only known at runtime takes any id and checks it against its capabilities.
  const any = createHarness('cursor' as import('../../src').HarnessProvider, { client: { name: 'x' } });
  void any.setPermission(session, 'whatever' as string);
  // A harness for one provider is still a Harness.
  const general: import('../../src').Harness = codex;
  void general;
};

it('types options per provider', () => { expect(typed).toBeTypeOf('function'); });
