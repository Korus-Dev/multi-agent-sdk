import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk';
import { CodexHost } from '../../src/providers/codex';
import { promptsFromSummaryTurns } from '../../src/providers/codex/host-prompt-history';
import { MockCodexAppServer, turn } from './helpers/host-fixture';

describe('CodexHost prompt history', () => {
  it('reads one bounded summary page and retains only chronological visible user prompts', async () => {
    const transport = new MockCodexAppServer({
      'thread/turns/list': (params) => {
        expect(params).toStrictEqual({
          threadId: 'thread-prompts',
          cursor: null,
          limit: 100,
          sortDirection: 'desc',
          itemsView: 'summary',
        });
        return {
          data: [
            turn('turn-new', 'completed', [
              { type: 'userMessage', id: 'user-empty', clientId: null, content: [
                { type: 'text', text: '(no user instructions)', text_elements: [] },
              ] },
              { type: 'agentMessage', id: 'assistant-new', text: 'Ignored', phase: null, memoryCitation: null, delivery: null, questions: null },
              { type: 'userMessage', id: 'user-new', clientId: null, content: [
                { type: 'text', text: '$cp', text_elements: [] },
                { type: 'skill', name: 'Commit-Push', path: '/skills/cp/SKILL.md' },
              ] },
            ]),
            turn('turn-old', 'completed', [
              { type: 'userMessage', id: 'user-old', clientId: null, content: [
                { type: 'text', text: '<context>hidden</context> First prompt ', text_elements: [] },
                { type: 'image', url: 'data:image/png;base64,abc' },
              ] },
              { type: 'agentMessage', id: 'assistant-old', text: 'Ignored', phase: null, memoryCitation: null, delivery: null, questions: null },
            ]),
          ],
          nextCursor: 'older',
          backwardsCursor: null,
        };
      },
    });
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      cwd: '/tmp/project',
      autoSelectFirstConversation: false,
    });
    await host.connect();
    await vi.waitFor(() => expect(host.getSnapshot().pluginCatalogStatus).toBe('loaded'));
    const before = host.getSnapshot();
    const stateChanged = vi.fn();
    const unsubscribe = host.onStateChange(stateChanged);

    await expect(host.conversation(' thread-prompts ').readPromptHistory()).resolves.toStrictEqual({
      conversationId: 'thread-prompts',
      prompts: ['First prompt', '$cp'],
    });
    expect(host.getSnapshot()).toStrictEqual(before);
    expect(stateChanged).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('rejects an absent active conversation before requesting turns', async () => {
    const transport = new MockCodexAppServer();
    const host = new CodexHost({
      client: new CodexAppServerClient(transport),
      autoSelectFirstConversation: false,
    });
    await host.connect();

    await expect(host.readConversationPromptHistory()).rejects.toThrow('Conversation id cannot be empty');
  });

  it('joins adjacent text inputs without separators and ignores non-text inputs', () => {
    expect(promptsFromSummaryTurns([promptTurn([
      { type: 'text', text: 'first', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,abc' },
      { type: 'text', text: ' second', text_elements: [] },
    ])])).toStrictEqual(['first second']);
  });

  it('strips multiline context tags without requiring surrounding whitespace', () => {
    expect(promptsFromSummaryTurns([promptTurn([{
      type: 'text',
      text: '<context>hidden line one\nhidden line two</context>Visible prompt',
      text_elements: [],
    }])])).toStrictEqual(['Visible prompt']);
  });

  it('strips browser context with or without attributes and then removes its ambient heading', () => {
    expect(promptsFromSummaryTurns([promptTurn([{
      type: 'text',
      text: '<in-app-browser-context>hidden\ncontext</in-app-browser-context>## My request for Codex:\nVisible',
      text_elements: [],
    }])])).toStrictEqual(['Visible']);

    expect(promptsFromSummaryTurns([promptTurn([{
      type: 'text',
      text: '<in-app-browser-context   data-url="https://example.test">browser</in-app-browser-context>\n  ## My request for Codex:  \nVisible',
      text_elements: [],
    }])])).toStrictEqual(['Visible']);
  });

  it('preserves ambient-looking headings when no browser context was removed', () => {
    expect(promptsFromSummaryTurns([promptTurn([{
      type: 'text',
      text: '## My request for Codex:\nVisible',
      text_elements: [],
    }])])).toStrictEqual(['## My request for Codex:\nVisible']);
    expect(promptsFromSummaryTurns([promptTurn([{
      type: 'text',
      text: '<in-app-browser-context>browser</in-app-browser-context>Prefix ## My request for Codex:\nVisible',
      text_elements: [],
    }])])).toStrictEqual(['Prefix ## My request for Codex:\nVisible']);
  });

  it('removes an indented ambient heading when browser context appears later', () => {
    expect(promptsFromSummaryTurns([promptTurn([{
      type: 'text',
      text: '  ## My request for Codex:\nVisible\n<in-app-browser-context>browser</in-app-browser-context>',
      text_elements: [],
    }])])).toStrictEqual(['Visible']);
  });

  it('preserves an ambient heading that has inline request text', () => {
    expect(promptsFromSummaryTurns([promptTurn([{
      type: 'text',
      text: '<in-app-browser-context>browser</in-app-browser-context>## My request for Codex: keep this inline',
      text_elements: [],
    }])])).toStrictEqual(['## My request for Codex: keep this inline']);
  });

  it('filters a browser-generated ambient heading with no following newline', () => {
    expect(promptsFromSummaryTurns([promptTurn([{
      type: 'text',
      text: '<in-app-browser-context>browser</in-app-browser-context>## My request for Codex:',
      text_elements: [],
    }])])).toStrictEqual([]);
  });
});

function promptTurn(content: v2.UserInput[]): v2.Turn {
  return turn('turn', 'completed', [
    { type: 'userMessage', id: 'user', clientId: null, content },
  ]);
}
