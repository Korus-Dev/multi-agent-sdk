import { describe, expect, it } from 'vitest';
import { toolOutputText } from '../../src/providers/codex/tool-output';

describe('tool output text', () => {
  it('passes through strings and serializes primitive values', () => {
    expect(toolOutputText('plain')).toBe('plain');
    expect(toolOutputText(undefined)).toBeUndefined();
    expect(toolOutputText(null)).toBe('null');
    expect(toolOutputText(4)).toBe('4');
    expect(toolOutputText(true)).toBe('true');
  });

  it('flattens arrays and removes empty entries', () => {
    expect(toolOutputText(['one', undefined, '', { text: 'two' }])).toBe('one\n\ntwo');
    expect(toolOutputText([])).toBeUndefined();
    expect(toolOutputText([undefined, ''])).toBeUndefined();
  });

  it('reads text and content fields', () => {
    expect(toolOutputText({ text: 'text field', content: 'ignored' })).toBe('text field');
    expect(toolOutputText({ content: 'content field' })).toBe('content field');
    expect(toolOutputText({ content: [{ text: 'one' }, { content: 'two' }] })).toBe('one\n\ntwo');
    expect(toolOutputText({ content: 4 })).toBe('{"content":4}');
  });

  it('prefers structured content when the content is only its transport notice', () => {
    expect(toolOutputText({
      content: [{ type: 'text', text: 'Result returned in structuredContent.' }],
      structuredContent: { answer: 42 },
    })).toBe('{"answer":42}');
    expect(toolOutputText({
      content: [{ type: 'text', text: '  Result returned in structuredContent.\n' }],
      structuredContent: { answer: 42 },
    })).toBe('{"answer":42}');
    expect(toolOutputText({ structuredContent: 'structured' })).toBe('structured');
  });

  it('combines meaningful content with structured content', () => {
    expect(toolOutputText({
      content: [{ text: 'Human summary' }],
      structuredContent: { answer: 42 },
    })).toBe('Human summary\n\n{"answer":42}');
    expect(toolOutputText({ structuredContent: undefined, text: 'fallback' })).toBe('fallback');
  });
});
