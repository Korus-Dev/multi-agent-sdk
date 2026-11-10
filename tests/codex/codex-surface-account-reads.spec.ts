import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, type v2 } from '../../../codex-sdk/src/protocol';
import { CodexSurface } from '../../src/providers/codex';
import type { CodexSurfaceEvent } from 'multi-agents-sdk/surface';
import { deferred, MockCodexAppServer } from './helpers/codex-surface-fixture';

const bucket: v2.RateLimitSnapshot = {
  limitId: 'codex', limitName: null, primary: null, secondary: null,
  credits: null, individualLimit: null, planType: 'pro', rateLimitReachedType: null,
  normalModelSlug: null, spendControlReached: null,
};
const credit: v2.RateLimitResetCredit = {
  id: 'reset-1', resetType: 'codexRateLimits', status: 'available',
  grantedAt: 1, expiresAt: null, title: 'Rate-limit reset', description: null,
};
const normalizedBucket = {
  limitId: 'codex', limitName: null, primary: null, secondary: null,
  credits: null, individualLimit: null, planType: 'pro', rateLimitReachedType: null,
};
const response: v2.GetAccountRateLimitsResponse = {
  ordinaryUsageAllowed: true, rateLimits: bucket, rateLimitsByLimitId: { codex: bucket },
  rateLimitResetCredits: { availableCount: 5n, credits: [credit] },
  accountId: null, rateLimitUpsell: null,
};

describe('CodexSurface account reads', () => {
  it('reads account-wide usage only on demand, preserving nullable metrics and excluding thread estimates', async () => {
    let result: v2.GetAccountTokenUsageResponse = {
      summary: { lifetimeTokens: 9007199254740993n, peakDailyTokens: 42n, longestRunningTurnSec: null, currentStreakDays: 0n, longestStreakDays: 7n },
      dailyUsageBuckets: [{ startDate: '2026-10-10', tokens: 42n }],
      threadUsage: { threadId: 'unrequested-thread', estimatedUsageCreditsMicros: 100n, estimatedUsageUsdMicros: null, groups: [] },
    };
    let fail = false;
    const transport = new MockCodexAppServer({ 'account/usage/read': () => {
      if (fail) throw new Error('Account usage unavailable');
      return result;
    } });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    try {
      await surface.connect();
      await vi.waitFor(() => expect(surface.getSnapshot().pluginCatalogStatus).toBe('loaded'));
      const before = surface.getSnapshot();
      expect(transport.requests('account/usage/read')).toHaveLength(0);
      expect(await surface.readAccountUsage()).toStrictEqual({
        summary: { lifetimeTokens: '9007199254740993', peakDailyTokens: '42', longestRunningTurnSec: null, currentStreakDays: '0', longestStreakDays: '7' },
        dailyUsageBuckets: [{ startDate: '2026-10-10', tokens: '42' }],
      });
      expect(transport.lastRequest('account/usage/read')?.params).toStrictEqual({});
      result = { summary: { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null };
      expect(await surface.readAccountUsage()).toStrictEqual(result);
      fail = true;
      await expect(surface.readAccountUsage()).rejects.toThrow('Account usage unavailable');
      expect(surface.getSnapshot()).toStrictEqual(before);
    } finally { await surface.close(); }
  });

  it('preserves exact counts across JSON representations and rejects rounded or malformed values', async () => {
    let count: unknown = 5n;
    const transport = new MockCodexAppServer({ 'account/rateLimits/read': () => ({
      ...response, rateLimitResetCredits: { availableCount: count as bigint, credits: null },
    }) });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    try {
      await surface.connect();
      for (const [value, expected] of [[0, '0'], [5, '5'], [9007199254740993n, '9007199254740993'], ['9007199254740993', '9007199254740993']] as const) {
        count = value;
        expect((await surface.readRateLimits()).rateLimitResetCredits?.availableCount).toBe(expected);
      }
      const before = surface.getSnapshot().rateLimits;
      for (const invalid of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5, '01', '-1', '1e3']) {
        count = invalid;
        await expect(surface.readRateLimits()).rejects.toThrow('Invalid account count');
        expect(surface.getSnapshot().rateLimits).toStrictEqual(before);
      }
    } finally { await surface.close(); }
  });

  it('reads capped details, retains them on sparse notifications, and replaces them with a count-only read', async () => {
    const transport = new MockCodexAppServer({
      'account/rateLimits/read': (options) => options?.excludeResetCreditDetails
        ? { ...response, rateLimitResetCredits: { availableCount: 4n, credits: null } }
        : response,
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    try {
      await surface.connect();
      const result = await surface.readRateLimits({ excludeResetCreditDetails: false });
      expect(transport.lastRequest('account/rateLimits/read')?.params).toStrictEqual({ excludeResetCreditDetails: false });
      expect(result).toStrictEqual({
        rateLimits: normalizedBucket, rateLimitsByLimitId: { codex: normalizedBucket },
        rateLimitResetCredits: { availableCount: '5', credits: [credit] },
      });
      transport.emitNotification('account/rateLimits/updated', { rateLimits: { ...bucket, planType: null } });
      expect(surface.getSnapshot().rateLimits?.rateLimitResetCredits).toStrictEqual(result.rateLimitResetCredits);
      result.rateLimits.planType = 'changed by consumer';
      expect(surface.getSnapshot().rateLimits?.rateLimits.planType).toBe('pro');
      const countOnly = await surface.readRateLimits({ excludeResetCreditDetails: true });
      expect(countOnly.rateLimitResetCredits).toStrictEqual({ availableCount: '4', credits: null });
      expect(surface.getSnapshot().rateLimits).toStrictEqual(countOnly);
    } finally { await surface.close(); }
  });

  it('propagates read errors without replacing a previously successful snapshot', async () => {
    let fail = false;
    const transport = new MockCodexAppServer({
      'account/rateLimits/read': () => { if (fail) throw new Error('provider unavailable'); return response; },
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    try {
      await surface.connect();
      const before = surface.getSnapshot().rateLimits;
      fail = true;
      await expect(surface.readRateLimits()).rejects.toThrow('provider unavailable');
      expect(surface.getSnapshot().rateLimits).toStrictEqual(before);
    } finally { await surface.close(); }
  });

  it('rejects a deferred response from an earlier account generation before publishing it', async () => {
    const pending = deferred<v2.GetAccountRateLimitsResponse>();
    let delay = false;
    const transport = new MockCodexAppServer({ 'account/rateLimits/read': () => delay ? pending.promise : response });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    const events: CodexSurfaceEvent[] = [];
    surface.onEvent(event => events.push(event));
    try {
      await surface.connect();
      delay = true;
      const read = surface.readRateLimits();
      const rejection = expect(read).rejects.toThrow('Account changed');
      await vi.waitFor(() => expect(transport.requests('account/rateLimits/read')).toHaveLength(2));
      transport.emitNotification('account/updated', { authMode: 'chatgpt', planType: 'pro' });
      events.length = 0;
      pending.resolve({ ...response, rateLimitResetCredits: { availableCount: 99n, credits: [] } });
      await rejection;
      expect(events.filter(event => event.type === 'rateLimits.changed')).toStrictEqual([]);
      expect(surface.getSnapshot().rateLimits?.rateLimitResetCredits?.availableCount).not.toBe('99');
    } finally { await surface.close(); }
  });
});
