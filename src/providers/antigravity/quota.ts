import type { AccountRateLimitWindow, AccountRateLimits } from '../../contracts/index';
import { record } from '../../acp/acp-connection';

/**
 * Reads the CLI's answer to its `usage` command: the account's quota, by group of models. Anything unfamiliar
 * yields no windows rather than a guess.
 */
export function parseQuota(output: string): AccountRateLimits | null {
  let reply: unknown;
  try { reply = JSON.parse(output); } catch { return null; }
  const data = record(reply) && record(reply.command) && record(reply.command.data) ? reply.command.data : {};
  const windows: AccountRateLimitWindow[] = [];
  for (const group of Array.isArray(data.groups) ? data.groups.filter(record) : []) {
    for (const bucket of Array.isArray(group.buckets) ? group.buckets.filter(record) : []) {
      if (typeof group.name !== 'string' || typeof bucket.remaining_fraction !== 'number') continue;
      const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : Number.NaN;
      windows.push({
        label: group.name.replace(/\s+models$/iu, ''),
        usedPercent: 100 - Math.min(100, Math.max(0, bucket.remaining_fraction * 100)),
        windowDurationMins: bucket.window === 'weekly' ? 10_080 : bucket.window === 'daily' ? 1_440 : null,
        resetsAt: Number.isFinite(reset) ? reset / 1000 : null,
      });
    }
  }
  if (!windows.length) return null;
  return { limitId: null, limitName: null, primary: windows[0]!, secondary: windows[1] ?? null, credits: null, individualLimit: null, planType: null, rateLimitReachedType: null };
}
