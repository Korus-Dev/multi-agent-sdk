import { expect, it, vi } from 'vitest';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk';
import { CodexHost } from '../../src/providers/codex';
import { deferred, MockCodexAppServer } from './helpers/host-fixture';

const method = 'account/rateLimitResetCredit/consume';

it('consumes only on explicit request, preserving keys and all outcomes without refreshing or retrying', async () => {
  let outcome: v2.ConsumeAccountRateLimitResetCreditOutcome = 'reset';
  let fail = false;
  const transport = new MockCodexAppServer({ [method]: () => {
    if (fail) throw new Error('Provider refused reset');
    return { outcome, accountId: 'provider-only-private-field' };
  } });
  const host = new CodexHost({ client: new CodexAppServerClient(transport) });
  try {
    await host.connect();
    await vi.waitFor(() => expect(host.getSnapshot().pluginCatalogStatus).toBe('loaded'));
    const before = host.getSnapshot();
    const reads = transport.requests('account/rateLimits/read').length;
    expect(transport.requests(method)).toHaveLength(0);
    const options = { idempotencyKey: 'same-logical-attempt', creditId: 'opaque-credit-id' };
    for (const value of ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'] as const) {
      outcome = value;
      expect(await host.consumeRateLimitResetCredit(options)).toStrictEqual({ outcome: value });
      expect(transport.lastRequest(method)?.params).toStrictEqual(options);
    }
    expect(await host.consumeRateLimitResetCredit({ idempotencyKey: 'provider-selects-credit' }))
      .toStrictEqual({ outcome: 'noCredit' });
    expect(transport.lastRequest(method)?.params).toStrictEqual({ idempotencyKey: 'provider-selects-credit' });
    fail = true;
    await expect(host.consumeRateLimitResetCredit(options)).rejects.toThrow('Provider refused reset');
    expect(transport.requests(method)).toHaveLength(6);
    fail = false;
    outcome = 'future-unknown-outcome' as v2.ConsumeAccountRateLimitResetCreditOutcome;
    await expect(host.consumeRateLimitResetCredit(options)).rejects.toThrow('Invalid reset-credit outcome');
    expect(transport.requests('account/rateLimits/read')).toHaveLength(reads);
    expect(host.getSnapshot()).toStrictEqual(before);
  } finally { await host.close(); }
});

it('rejects missing or blank identifiers before sending any consume request', async () => {
  const transport = new MockCodexAppServer();
  const host = new CodexHost({ client: new CodexAppServerClient(transport) });
  try {
    for (const input of [undefined, null, {}, { idempotencyKey: '' }, { idempotencyKey: '  ' },
      { idempotencyKey: 7 }, { idempotencyKey: 'key', creditId: '' },
      { idempotencyKey: 'key', creditId: null }, { idempotencyKey: 'key', creditId: 7 }]) {
      await expect(host.consumeRateLimitResetCredit(input as never)).rejects.toThrow('Reset-credit options');
    }
    expect(transport.requests(method)).toHaveLength(0);
    expect(transport.requests('initialize')).toHaveLength(0);
  } finally { await host.close(); }
});

it('rejects a stale-account consume result without retrying', async () => {
  const pending = deferred<v2.ConsumeAccountRateLimitResetCreditResponse>();
  const transport = new MockCodexAppServer({ [method]: () => pending.promise });
  const host = new CodexHost({ client: new CodexAppServerClient(transport) });
  try {
    await host.connect();
    const consume = host.consumeRateLimitResetCredit({ idempotencyKey: 'uncertain-attempt' });
    const rejected = expect(consume).rejects.toThrow('Account changed');
    await vi.waitFor(() => expect(transport.requests(method)).toHaveLength(1));
    transport.emitNotification('account/updated', { authMode: 'chatgpt', planType: 'pro' });
    pending.resolve({ outcome: 'reset' });
    await rejected;
    expect(transport.requests(method)).toHaveLength(1);
  } finally { await host.close(); }
});

it('leaves timeout recovery to the caller using the same logical key', async () => {
  const pending = deferred<v2.ConsumeAccountRateLimitResetCreditResponse>();
  let delayed = true;
  const transport = new MockCodexAppServer({ [method]: () => delayed ? pending.promise : { outcome: 'alreadyRedeemed' } });
  const host = new CodexHost({ client: new CodexAppServerClient(transport, { requestTimeoutMs: 30 }) });
  try {
    await host.connect();
    const options = { idempotencyKey: 'uncertain-attempt', creditId: 'opaque-credit-id' };
    await expect(host.consumeRateLimitResetCredit(options)).rejects.toThrow('timed out');
    expect(transport.requests(method)).toHaveLength(1);
    pending.resolve({ outcome: 'reset' });
    delayed = false;
    expect(await host.consumeRateLimitResetCredit(options)).toStrictEqual({ outcome: 'alreadyRedeemed' });
    expect(transport.requests(method).map(request => request.params)).toStrictEqual([options, options]);
  } finally { await host.close(); }
});
