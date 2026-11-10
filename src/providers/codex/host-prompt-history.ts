import type { CodexAppServerClient, v2 } from '@korus-dev/codex-sdk';
import type { CodexConversationPromptHistory } from '../../core/codex-host';
import { normalizedConversationId } from './host-prompts';

export const CODEX_PROMPT_HISTORY_TURN_LIMIT = 100;

const contextTagRegex = /<context>[\s\S]*?<\/context>\s*/g;
const inAppBrowserContextTagRegex = /<in-app-browser-context(?:\s[^>]*)?>[\s\S]*?<\/in-app-browser-context>\s*/g;
const ambientRequestHeadingRegex = /^[ \t]*## My request for Codex:[ \t]*$/m;

export async function readPromptHistory(
  client: CodexAppServerClient,
  conversationId: string,
): Promise<CodexConversationPromptHistory> {
  const threadId = normalizedConversationId(conversationId);
  const response = await client.request('thread/turns/list', {
    threadId,
    cursor: null,
    limit: CODEX_PROMPT_HISTORY_TURN_LIMIT,
    sortDirection: 'desc',
    itemsView: 'summary',
  });
  return {
    conversationId: threadId,
    prompts: promptsFromSummaryTurns(response.data),
  };
}

/** Extracts only visible user-authored text without retaining the turn payload. */
export function promptsFromSummaryTurns(turns: readonly v2.Turn[]): string[] {
  return [...turns].reverse().flatMap((turn) => turn.items.flatMap((item) => {
    if (item.type !== 'userMessage') return [];
    const text = item.content
      .flatMap((input) => input.type === 'text' ? [input.text] : [])
      .join('');
    const prompt = stripPromptContext(text);
    return prompt && prompt !== '(no user instructions)' ? [prompt] : [];
  }));
}

function stripPromptContext(content: string): string {
  const withoutContext = content.replace(contextTagRegex, '');
  const withoutBrowserContext = withoutContext.replace(inAppBrowserContextTagRegex, '');
  return (withoutBrowserContext === withoutContext
    ? withoutBrowserContext
    : withoutBrowserContext.replace(ambientRequestHeadingRegex, ''))
    .trim();
}
