import { expect, it } from 'vitest';
import { parseQuota } from '../../../src/providers/antigravity/quota';

const reply = (groups: unknown) => JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups } } });

it('maps each model group to a labelled usage window', () => {
  expect(parseQuota(reply([
    { name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.75, reset_time: '2026-11-19T00:54:02Z' }] },
    { name: 'Claude and GPT models', buckets: [{ id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-19T14:16:23Z' }] },
  ]))).toStrictEqual({
    limitId: null, limitName: null, credits: null, individualLimit: null, planType: null, rateLimitReachedType: null,
    primary: { label: 'Gemini', usedPercent: 25, windowDurationMins: 10_080, resetsAt: Date.parse('2026-11-19T00:54:02Z') / 1000 },
    secondary: { label: 'Claude and GPT', usedPercent: 0, windowDurationMins: 10_080, resetsAt: Date.parse('2026-11-19T14:16:23Z') / 1000 },
  });
});

it('keeps a window usable when the reset time or period is not stated', () => {
  const limits = parseQuota(reply([{ name: 'Gemini Models', buckets: [{ remaining_fraction: 0.5 }] }]))!;
  expect(limits.primary).toStrictEqual({ label: 'Gemini', usedPercent: 50, windowDurationMins: null, resetsAt: null });
  expect(limits.secondary).toBeNull();
});

it('reports nothing when the CLI has no quota to show', () => {
  for (const output of ['', 'not json', reply([]), reply([{ name: 'Gemini Models', buckets: [{ remaining_fraction: 'soon' }] }]), JSON.stringify({ status: 'SUCCESS', response: 'hello' })]) expect(parseQuota(output)).toBeNull();
});
