import { expect, it } from 'vitest';
import { createScriptedHarness } from '../../src/testing';

// An app reads who is signed in from one neutral shape, never from a harness's own sign-in state.
it.each([
  ['codex', { account: { type: 'chatgpt', email: 'a@b.c', planType: 'pro' } }, { kind: 'subscription', email: 'a@b.c', plan: 'pro' }],
  ['codex', { account: { type: 'apiKey' } }, { kind: 'apiKey' }],
  ['codex', { account: { type: 'amazonBedrock', credentialSource: 'awsManaged' } }, { kind: 'cloud' }],
  ['claude', { loggedIn: true, account: { type: 'subscription', email: 'a@b.c', subscription: 'max' } }, { kind: 'subscription', email: 'a@b.c', plan: 'max' }],
  ['claude', { loggedIn: true, account: { type: 'apiKey' } }, { kind: 'apiKey' }],
  ['cursor', { loggedIn: true, homePath: '/h', account: { type: 'subscription', email: 'a@b.c' }, team: 'Acme' }, { kind: 'subscription', email: 'a@b.c', team: 'Acme' }],
  ['antigravity', { loggedIn: true, homePath: '/h' }, null],
] as const)('reports the %s account %j as %j', async (provider, state, account) => {
  const { harness, script } = createScriptedHarness(provider);
  script.on('authenticate', (async () => ({ kind: provider, connected: true, state })) as never);
  const result = await harness.authenticate({ action: 'check' });
  expect(result.account).toStrictEqual(account);
  // Apps that pass the native state along find the same account on it.
  expect(result.native).toMatchObject({ account });
});

it('reports no account when nobody is signed in, and on sign-in changes as well', async () => {
  const { harness, script } = createScriptedHarness('codex');
  script.on('authenticate', (async () => ({ kind: 'codex', connected: false, state: { account: { type: 'apiKey' } } })) as never);
  expect((await harness.authenticate({ action: 'check' })).account).toBeNull();
  const seen: unknown[] = [];
  harness.onEvent(event => { if (event.type === 'provider.authenticationChanged') seen.push(event.payload); });
  script.emit({ type: 'provider.authenticationChanged', provider: 'codex', payload: { kind: 'codex', connected: true, state: { account: { type: 'chatgpt', email: null, planType: 'plus' } } } } as never);
  expect(seen).toMatchObject([{ account: { kind: 'subscription', plan: 'plus' } }]);
});
