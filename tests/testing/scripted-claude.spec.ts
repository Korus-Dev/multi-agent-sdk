import { expect, it } from 'vitest';
import { createScriptedClaudeHarness } from '../../src/testing';

it('turns scripted Claude messages into session state through the SDK host', async () => {
  const { harness, emit, inputs } = createScriptedClaudeHarness();
  const session = harness.open({ id: 'chat', folder: '/tmp' });
  const sending = harness.sendPrompt(session, 'hello');
  await new Promise(resolve => setTimeout(resolve, 10));
  emit({ type: 'system', subtype: 'init', session_id: 'claude-1' });
  await sending;
  expect(inputs).toHaveLength(1);
  expect(harness.getSessionData(session).data).toMatchObject({ kind: 'claude', conversationId: 'claude-1' });
});
