import { expect, it } from 'vitest';
import { CodexAppServerClient } from '@korus-dev/codex-sdk';
import { CodexSurface } from '../../src/providers/codex';
import { MockCodexAppServer, thread, turn } from './helpers/codex-surface-fixture';

it('reads archived history across pages without resuming, selecting or changing archive state', async () => {
  const transport = new MockCodexAppServer({
    'thread/read': () => ({ thread: thread('archived', false), readState: null }),
    'thread/turns/list': params => ({
      data: [turn(params.cursor ? 'second' : 'first', 'completed', [{
        type: 'agentMessage', id: params.cursor ? 'two' : 'one',
        text: params.cursor ? 'Second answer' : 'First answer', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null,
      }])], nextCursor: params.cursor ? null : 'page-2', backwardsCursor: null,
    }),
  });
  const surface = new CodexSurface({ client: new CodexAppServerClient(transport), autoSelectFirstConversation: false });
  try {
    const messages = await surface.readConversationMessages('archived');
    expect(messages.flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : [])))
      .toStrictEqual(['First answer', 'Second answer']);
    const methods = transport.sent.flatMap(frame => 'method' in frame ? [frame.method] : []);
    expect(methods.filter(method => /^thread\/(resume|archive|unarchive|start)$/.test(method))).toStrictEqual([]);
    expect(surface.getSnapshot().activeConversationId).toBeNull();
  } finally { await surface.close(); }
});

it.each(['identity', 'cursor'] as const)('rejects invalid read-only history %s evidence without resuming', async mode => {
  const transport = new MockCodexAppServer({
    'thread/read': () => ({ thread: thread(mode === 'identity' ? 'foreign' : 'archived', false), readState: null }),
    'thread/turns/list': () => ({ data: [], nextCursor: 'repeated', backwardsCursor: null }),
  });
  const surface = new CodexSurface({ client: new CodexAppServerClient(transport), autoSelectFirstConversation: false });
  try {
    await expect(surface.readConversationMessages('archived')).rejects.toThrow(mode === 'identity' ? /identity/ : /cursor/);
    expect(transport.sent.filter(frame => 'method' in frame && frame.method === 'thread/resume')).toStrictEqual([]);
  } finally { await surface.close(); }
});
