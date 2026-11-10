import { afterAll, beforeAll, bench, describe } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServerClient } from '../../../../codex-sdk/src/protocol';
import { CodexSurface } from '../../../src/providers/codex';
import { MockCodexAppServer, resumeResponse, thread, turn } from '../helpers/codex-surface-fixture';

const THREAD_COUNT = 5;
const TURNS_PER_THREAD = 200;
const STREAM_DELTAS = 500;
const threadIds = Array.from({ length: THREAD_COUNT }, (_, index) => `benchmark-thread-${index}`);
let temporaryCodexHome = '';

beforeAll(async () => {
  temporaryCodexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-app-sdk-benchmark-'));
});

afterAll(async () => {
  await rm(temporaryCodexHome, { force: true, recursive: true });
});

describe('five active long conversations', () => {
  bench('cold-loads history and routes interleaved app-server deltas', async () => {
    const histories = new Map(threadIds.map((threadId) => [threadId, longThread(threadId)]));
    const transport = new MockCodexAppServer({
      'thread/list': () => ({ readStates: null, backwardsCursor: null,
        data: threadIds.map((threadId) => thread(threadId, false)),
        nextCursor: null,
      }),
      'thread/resume': (params) => {
        const threadId = (params as { threadId: string }).threadId;
        return resumeResponse(histories.get(threadId)!);
      },
    });
    const surface = new CodexSurface({
      autoSelectFirstConversation: false,
      client: new CodexAppServerClient(transport),
      codexHome: temporaryCodexHome,
    });
    await surface.connect();
    const conversations = threadIds.map((threadId) => surface.conversation(threadId));
    let stateNotifications = 0;
    const unsubscribes = conversations.map((conversation) => conversation.onStateChange(() => {
      stateNotifications += 1;
    }));

    await Promise.all(conversations.map((conversation, index) => conversation.load({
      cwd: path.join(temporaryCodexHome, `workspace-${index}`),
    })));
    for (const threadId of threadIds) {
      transport.emitNotification('turn/started', { threadId, turn: turn(`live-turn-${threadId}`, 'inProgress', []) });
    }
    const notificationsBeforeStreaming = stateNotifications;
    for (let index = 0; index < STREAM_DELTAS; index += 1) {
      const threadId = threadIds[index % threadIds.length]!;
      transport.emitNotification('item/agentMessage/delta', {
          threadId,
          turnId: `live-turn-${threadId}`,
          itemId: `live-message-${threadId}`,
          delta: 'x',
        });
    }

    if (stateNotifications - notificationsBeforeStreaming !== STREAM_DELTAS) {
      throw new Error('The benchmark did not observe every streamed delta');
    }
    for (const unsubscribe of unsubscribes) unsubscribe();
    await surface.close();
  }, {
    iterations: 3,
    time: 0,
    warmupIterations: 1,
    warmupTime: 0,
  });
});

function longThread(threadId: string) {
  return {
    ...thread(threadId, false),
    turns: Array.from({ length: TURNS_PER_THREAD }, (_, index) => turn(
      `${threadId}-turn-${index}`,
      'completed',
      [
        {
          type: 'userMessage',
          id: `${threadId}-user-${index}`,
          clientId: null,
          content: [{ type: 'text', text: `Prompt ${index}`, text_elements: [] }],
        },
        {
          type: 'agentMessage',
          id: `${threadId}-assistant-${index}`,
          text: `Answer ${index}`,
          phase: null,
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
      ],
    )),
  };
}
