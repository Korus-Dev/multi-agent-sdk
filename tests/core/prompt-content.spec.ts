import { describe, expect, it } from 'vitest';
import { normalizePromptContent, promptContentText, promptContentDispatchText, trimPromptContent, slicePromptContent, replacePromptContentRange, type PromptPart } from '../../src/core/codex-host';

const mention = { type: 'mention' as const, kind: 'skill' as const, id: '/skills/cp/SKILL.md', label: 'Commit-Push', value: 'cp' };

describe('authored prompt content', () => {
  it('normalizes fragmented draft text into a stable representation around mentions', () => {
    expect(normalizePromptContent([
      { type: 'text', text: '' }, { type: 'text', text: 'Run' }, { type: 'text', text: ' ' },
      mention, { type: 'text', text: ' now' }, { type: 'text', text: '' },
    ])).toStrictEqual([{ type: 'text', text: 'Run ' }, mention, { type: 'text', text: ' now' }]);
  });
  it('keeps visible labels separate from selected execution targets and literal triggers', () => {
    const parts: PromptPart[] = [
      { type: 'text', text: '$cp then ' }, mention,
      { type: 'mention', kind: 'plugin', id: 'gmail@remote', label: 'Gmail', value: 'gmail' },
      { type: 'mention', kind: 'file', id: 'src/file.ts', label: 'file.ts', value: 'src/file.ts' },
      { type: 'mention', kind: 'custom', id: 'agent-1', label: 'Alex', value: 'agent:1', groupId: 'agents' },
    ];
    expect(promptContentText(parts)).toBe('$cp then Commit-PushGmailfile.tsAlex');
    expect(promptContentDispatchText(parts)).toBe('$cp then [$cp](/skills/cp/SKILL.md)[@gmail](plugin://gmail@remote)@src/file.ts[@Alex](mention://agents/agent-1?value=agent%3A1)');
    const copied = normalizePromptContent(parts);
    expect(copied).toStrictEqual(parts);
    copied[1] = { type: 'text', text: 'replacement' };
    expect(parts[1]).toStrictEqual(mention);
  });

  it('serializes canonical references with Markdown-safe names and targets', () => {
    const parts: PromptPart[] = [{ type: 'text', text: '$cp and ' }, {
      ...mention, label: 'Commit and push', value: 'Commit-Push [cp]', id: '/skills/Commit Push (cp)#1/SKILL.md',
    }];
    expect(promptContentText(parts)).toBe('$cp and Commit and push');
    expect(promptContentDispatchText(parts)).toBe('$cp and [$Commit-Push \\[cp\\]](/skills/Commit%20Push%20%28cp%29%231/SKILL.md)');
    expect(promptContentDispatchText([{ type: 'text', text: '@gmail then ' }, {
      type: 'mention', kind: 'plugin', label: 'Gmail', value: 'mail [work]', id: 'mail@remote (work)#1',
    }])).toBe('@gmail then [@mail \\[work\\]](plugin://mail@remote%20%28work%29%231)');
    expect(promptContentDispatchText([{
      type: 'mention', kind: 'custom', label: 'A [team]', id: 'id/a?b#c', value: 'agent:a?b#c', groupId: 'People / X',
    }])).toBe('[@A \\[team\\]](mention://People%20%2F%20X/id%2Fa%3Fb%23c?value=agent%3Aa%3Fb%23c)');
    expect(promptContentDispatchText([{
      type: 'mention', kind: 'custom', label: 'Fallback', id: 'id', value: 'plain',
    }])).toBe('[@Fallback](mention://custom/id?value=plain)');
  });

  it('projects an authored prompt prefix once and preserves host context verbatim', () => {
    const parts: PromptPart[] = [{ type: 'text', text: '$cp then ' }, mention];
    const context = '\n\n<context>Commit-Push and $cp stay untouched here.</context>';
    const expected = '$cp then [$cp](/skills/cp/SKILL.md)' + context;
    expect(promptContentDispatchText(parts, promptContentText(parts) + context)).toBe(expected);
    expect(promptContentDispatchText(parts, expected)).toBe(expected);
    expect(promptContentDispatchText(parts, 'Custom host prompt' + context)).toBe('Custom host prompt' + context);
  });

  it('slices by visible UTF-16 offsets and makes partial mentions literal', () => {
    const parts: PromptPart[] = [{ type: 'text', text: '😀 ' }, mention, { type: 'text', text: ' end' }];
    expect(slicePromptContent(parts, 3, 14)).toStrictEqual([mention]);
    expect(slicePromptContent(parts, 5, 9)).toStrictEqual([{ type: 'text', text: 'mmit' }]);
    expect(slicePromptContent(parts, 14)).toStrictEqual([{ type: 'text', text: ' end' }]);
    expect(slicePromptContent(parts, 100)).toStrictEqual([]);
    expect(promptContentText(replacePromptContentRange(parts, 3, 14, [{ type: 'text', text: '$cp' }]))).toBe('😀 $cp end');
    expect(replacePromptContentRange([mention], 0, 0, [{ type: 'text', text: 'Run ' }])).toStrictEqual([
      { type: 'text', text: 'Run ' }, mention,
    ]);
  });

  it('trims surrounding text without rewriting selected labels or mutating drafts', () => {
    const parts: PromptPart[] = [{ type: 'text', text: ' ' }, { type: 'text', text: '\nRun ' }, mention, { type: 'text', text: '\t' }];
    expect(trimPromptContent(parts)).toStrictEqual([{ type: 'text', text: 'Run ' }, mention]);
    expect(parts[0]).toStrictEqual({ type: 'text', text: ' ' });
    expect(trimPromptContent([{ type: 'text', text: ' ' }])).toStrictEqual([]);
    expect(trimPromptContent([{ type: 'text', text: ' x ' }])).toStrictEqual([{ type: 'text', text: 'x' }]);
    expect(trimPromptContent([mention, { type: 'text', text: ' end ' }])).toStrictEqual([mention, { type: 'text', text: ' end' }]);
  });

  it.each([null, {}, [null], [{ type: 'other' }], [{ type: 'text', text: 1 }],
    [{ ...mention, kind: 'unknown' }], [{ ...mention, id: '' }], [{ ...mention, value: 1 }], [{ ...mention, groupId: 1 }],
  ])('rejects malformed transport content: %j', input => {
    expect(() => normalizePromptContent(input)).toThrow();
  });
});
