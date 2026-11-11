import { expect, it } from 'vitest';
import { createScriptedHarness } from '../../src/testing';
import { HarnessUnsupportedError } from '../../src';

it('runs a harness without any provider: prompts are recorded and admitted', async () => {
  const { harness, script } = createScriptedHarness('claude');
  const session = harness.open({ id: 'chat', folder: '/work' });
  const admission = await harness.sendPrompt(session, 'hello');
  expect(admission.turnId).toBeDefined();
  expect(script.calls('sendPrompt')).toHaveLength(1);
  expect(script.calls('sendPrompt')[0]!.args.slice(0, 2)).toEqual([expect.objectContaining({ id: 'chat' }), 'hello']);
  expect(harness.getSessionData(session).data).toMatchObject({ kind: 'claude' });
});

it('lets a test script an operation result and see the harness react', async () => {
  const { harness, script } = createScriptedHarness('cursor');
  const session = harness.open({ id: 'chat', folder: '/work' });
  script.on('sendPrompt', async () => { throw new Error('rate limited'); });
  await expect(harness.sendPrompt(session, 'x')).rejects.toThrow('rate limited');
});

it('pushes provider events to a session by id, as the provider would', async () => {
  const { harness, script } = createScriptedHarness('cursor');
  const session = harness.open({ id: 'chat', folder: '/work' });
  const seen: string[] = [];
  harness.onEvent(event => { if (event.type === 'provider.event') seen.push(event.event.type); });
  script.emit({ type: 'provider.statusChanged', provider: 'cursor', payload: { provider: 'cursor', status: 'running' } } as never);
  expect(seen).toEqual(['provider.statusChanged']);
  void session;
});

it('rejects operations a test has not enabled with the typed unsupported error', async () => {
  const { harness } = createScriptedHarness('antigravity', { unsupported: ['setGoal'] });
  const session = harness.open({ id: 'chat', folder: '/work' });
  await expect(harness.setGoal(session, 'x')).rejects.toBeInstanceOf(HarnessUnsupportedError);
});

it('scripts the native review like any other operation', async () => {
  const { harness, script } = createScriptedHarness('codex');
  const session = harness.open({ id: 'review', folder: '/tmp' });
  expect(harness.getCapabilities(session).review).toBe(true);
  expect((await harness.startReview(session)).turnId).toBeDefined();
  expect(script.calls('startReview')).toHaveLength(1);
  script.on('startReview', async () => { throw new Error('review refused'); });
  await expect(harness.startReview(session, { type: 'baseBranch', branch: 'main' })).rejects.toThrow('review refused');
});
