import { describe, expect, it } from 'vitest';
import {
  codexImageDataUrl,
  codexItemToMediaPart,
  codexItemToMediaParts,
  codexItemToSurfaceMessage,
  codexThreadToSurfaceMessages,
  codexTurnToSurfaceMessages,
  preserveHistoricalAttachmentPreviews,
} from '../../src/providers/codex/codex-conversation-history';
import type { v2 } from '@korus-dev/codex-sdk';
import type { SurfaceMessage } from '../../src/index';

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('codexThreadToSurfaceMessages', () => {
  it('does not repeat structured skills or plugins already present in prompt text', () => {
    const text = '[$cp](/skills/commit-push/SKILL.md) then [@computer-use](plugin://computer-use@openai-bundled)';
    const [message] = codexTurnToSurfaceMessages('thread-skill', {
      id: 'turn-skill', status: 'completed', startedAt: 1, completedAt: 2,
      items: [{
        type: 'userMessage', id: 'user-skill', clientId: null,
        content: [
          { type: 'text', text, text_elements: [] },
          {
            type: 'skill',
            name: 'Commit-Push (cp)',
            path: '/skills/commit-push/SKILL.md',
          },
          { type: 'mention', name: 'Computer Use', path: 'plugin://computer-use@openai-bundled' },
        ],
      }],
    } as unknown as v2.Turn);

    expect(message?.parts).toStrictEqual([{ type: 'text', text }]);
  });

  it('does not replay a tagged Plan-mode document as assistant text', () => {
    const markdown = '# Proposed plan\n\n- Build it';
    const messages = codexTurnToSurfaceMessages('thread-plan', {
      id: 'turn-plan', status: 'completed', startedAt: 1, completedAt: 2,
      items: [
        {
          type: 'agentMessage', id: 'agent-plan',
          text: `<proposed_plan>\n${markdown}\n</proposed_plan>`,
          phase: 'final_answer', memoryCitation: null,
        },
      ],
    } as unknown as v2.Turn);

    expect(messages).toStrictEqual([]);
    expect(codexItemToSurfaceMessage('thread-plan', {
      id: 'turn-plan', status: 'completed', startedAt: 1,
    }, {
      type: 'agentMessage', id: 'agent-plan',
      text: `<proposed_plan>\n${markdown}\n</proposed_plan>`,
      phase: 'final_answer', memoryCitation: null, delivery: null, questions: null,
    })).toBeNull();
  });

  it('normalizes incomplete history and every persisted user input type', () => {
    expect(codexThreadToSurfaceMessages({ id: 'empty', turns: null } as unknown as v2.Thread)).toStrictEqual([]);
    const messages = codexTurnToSurfaceMessages('thread-inputs', {
      id: 'turn-inputs',
      status: 'failed',
      startedAt: null,
      completedAt: 1_780_000_010,
      items: [
        {
          type: 'userMessage', id: 'user-inputs', clientId: 'client-inputs',
          content: [
            null,
            { type: 'text', text: 'Hello' },
            { type: 'skill', name: 'review' },
            { type: 'mention', name: 'README.md', path: '/tmp/README.md' },
            { type: 'image', url: 'https://example.com/image.png' },
            { type: 'localImage', path: '/tmp/image.png' },
            { type: 'unknown', value: 'ignored' },
          ],
        },
        { type: 'userMessage', id: 'empty-user', clientId: null, content: null },
        { type: 'agentMessage', id: 'empty-agent', text: '' },
        { type: 'exitedReviewMode', id: 'empty-review', review: '' },
        { type: 'unknown', id: 'unknown' },
      ],
    } as unknown as v2.Turn);
    expect(messages).toStrictEqual([expect.objectContaining({
      id: 'client-inputs',
      status: 'complete',
      parts: [
        { type: 'text', text: 'Hello' },
        {
          type: 'attachment',
          attachment: {
            kind: 'file', name: 'README.md', path: '/tmp/README.md',
          },
        },
        {
          type: 'attachment',
          attachment: {
            kind: 'image', name: 'image.png', url: 'https://example.com/image.png', mimeType: 'image/png',
          },
        },
        {
          type: 'attachment',
          attachment: {
            kind: 'image', name: 'image.png', path: '/tmp/image.png', mimeType: 'image/png',
          },
        },
      ],
    })]);
  });

  it('preserves context compaction between assistant history segments', () => {
    const messages = codexTurnToSurfaceMessages('thread-compaction', {
      id: 'turn-compaction',
      status: 'inProgress',
      startedAt: 1,
      completedAt: null,
      items: [
        {
          type: 'userMessage', id: 'user-before-compaction', clientId: null,
          content: [{ type: 'text', text: 'Finish the release.' }],
        },
        {
          type: 'agentMessage', id: 'agent-before-compaction',
          text: 'I am checking the package.',
        },
        { type: 'contextCompaction', id: 'context-compaction' },
        {
          type: 'agentMessage', id: 'agent-after-compaction',
          text: 'The compacted turn is continuing.',
        },
      ],
    } as unknown as v2.Turn);

    expect(messages).toMatchObject([
      {
        id: 'user-thread-compaction-turn-compaction-user-before-compaction',
        role: 'user',
      },
      {
        id: 'assistant-turn-compaction',
        role: 'assistant',
        parts: [{ type: 'text', text: 'I am checking the package.' }],
      },
      {
        id: 'compaction-turn-compaction',
        kind: 'compaction',
        role: 'assistant',
        status: 'complete',
        parts: [],
      },
      {
        id: 'assistant-turn-compaction-segment-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'The compacted turn is continuing.' }],
      },
    ]);
  });

  it('displays and deduplicates structured skills when no prompt text is available', () => {
    const [message] = codexTurnToSurfaceMessages('thread-skill-only', {
      id: 'turn-skill-only', status: 'completed', startedAt: 1, completedAt: 2,
      items: [{
        type: 'userMessage', id: 'user-skill-only', clientId: null,
        content: [
          { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
          { type: 'skill', name: 'REVIEW', path: '/skills/review/SKILL.md' },
        ],
      }],
    } as unknown as v2.Turn);

    expect(message?.parts).toStrictEqual([{ type: 'text', text: '$review' }]);
  });

  it('maps individual history items and all turn statuses', () => {
    const baseTurn = { id: 'turn', startedAt: Number.NaN } as Pick<v2.Turn, 'id' | 'status' | 'startedAt'>;
    expect(codexItemToSurfaceMessage('thread', { ...baseTurn, status: 'inProgress' }, {
      type: 'agentMessage', id: 'agent', text: 'Streaming', phase: 'commentary', memoryCitation: null,
      delivery: null, questions: null,
    })).toMatchObject({
      status: 'streaming',
      createdAt: '1970-01-01T00:00:00.000Z',
      parts: [{ type: 'text', text: 'Streaming', phase: 'commentary' }],
    });
    expect(codexItemToSurfaceMessage('thread', { ...baseTurn, status: 'failed' }, {
      type: 'exitedReviewMode', id: 'review', review: 'Failed review',
    })).toMatchObject({ status: 'error', parts: [{ text: 'Failed review' }] });
    expect(codexItemToSurfaceMessage('thread', { ...baseTurn, status: 'completed' }, {
      type: 'reasoning', id: 'reasoning', summary: ['Checked the event flow'], content: ['raw chain of thought'],
    })).toMatchObject({
      status: 'complete',
      parts: [{
        type: 'reasoning',
        summary: 'Checked the event flow',
        itemId: 'reasoning',
        summaryIndex: 0,
      }],
    });
    expect(codexItemToSurfaceMessage('thread', { ...baseTurn, status: 'interrupted' }, {
      type: 'agentMessage', id: 'interrupted', text: 'Partial response', phase: null,
      memoryCitation: null, delivery: null, questions: null,
    })).toMatchObject({ status: 'complete', parts: [{ text: 'Partial response' }] });
    expect(codexItemToSurfaceMessage('thread', { ...baseTurn, status: 'completed' }, {
      type: 'userMessage', id: 'user', clientId: null, content: [],
    })).toBeNull();
    expect(codexItemToSurfaceMessage('thread', { ...baseTurn, status: 'completed' }, {
      type: 'userMessage', id: 'image-only', clientId: null,
      content: [{ type: 'localImage', path: '/tmp/resumed.png' }],
    })).toMatchObject({
      parts: [{
        type: 'attachment',
        attachment: {
          kind: 'image',
          name: 'resumed.png',
          path: '/tmp/resumed.png',
          mimeType: 'image/png',
        },
      }],
    });
    expect(codexItemToSurfaceMessage('thread', { ...baseTurn, status: 'completed' }, {
      type: 'webSearch', id: 'search', query: '', action: null, results: null,
    })).toMatchObject({
      status: 'complete', parts: [{ type: 'tool', id: 'search', body: 'web search' }],
    });
    expect(codexItemToSurfaceMessage('thread', { ...baseTurn, status: 'completed' }, {
      type: 'enteredReviewMode', id: 'entered', review: 'changes',
    })).toBeNull();
  });

  it('projects durable asynchronous questions and hides their response envelope', () => {
    const turn = {
      id: 'turn-question', status: 'completed', startedAt: 2,
    } as Pick<v2.Turn, 'id' | 'status' | 'startedAt'>;
    const questionItem: Extract<v2.ThreadItem, { type: 'agentMessage' }> = {
      type: 'agentMessage',
      id: 'agent-question',
      text: 'Which framework should I use?\n- Vue\n- React',
      phase: 'final_answer',
      memoryCitation: null,
      delivery: 'async',
      questions: [{ title: 'Which framework should I use?', options: ['Vue', 'React'] }],
    };
    const question = codexItemToSurfaceMessage('thread-question', turn, questionItem);
    expect(question).toMatchObject({
      parts: [
        {
          type: 'question',
          request: {
            id: 'async-question:agent-question',
            payload: {
              request: {
                delivery: 'async',
                blocking: false,
                questions: [{ id: '["request_user_input_async","agent-question",0]', question: 'Which framework should I use?' }],
              },
            },
          },
        },
      ],
    });

    const [history] = codexTurnToSurfaceMessages('thread-question', {
      ...turn, completedAt: 3, items: [
        { type: 'agentMessage', id: 'intro', text: 'I have one decision.', phase: 'commentary',
          memoryCitation: null, delivery: null, questions: null },
        questionItem,
      ],
    } as v2.Turn);
    expect(history?.parts).toMatchObject([
      { type: 'text', text: 'I have one decision.' },
      { type: 'question', request: { id: 'async-question:agent-question' } },
    ]);

    const answer = codexItemToSurfaceMessage('thread-question', turn, {
      type: 'userMessage',
      id: 'question-answer',
      clientId: null,
      content: [{
        type: 'text',
        text: '<send_user_message_question_reply>\n'
          + '[{"questionItemId":"[\\"request_user_input_async\\",\\"agent-question\\",0]","question":"Framework?","answer":"Vue"}]\n'
          + '</send_user_message_question_reply>',
        text_elements: [],
      }],
    });
    expect(answer).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: 'Vue' }],
      metadata: {
        asyncQuestionRequestIds: ['async-question:agent-question'],
        asyncQuestionAnswers: { '["request_user_input_async","agent-question",0]': { answers: ['Vue'] } },
      },
    });
    expect(JSON.stringify(answer)).not.toContain('send_user_message_question_reply');
  });

  it('projects every non-empty reasoning summary with stable source indices', () => {
    const turn = {
      id: 'turn-reasoning', status: 'completed', startedAt: 2, completedAt: 3,
    } as Pick<v2.Turn, 'id' | 'status' | 'startedAt' | 'completedAt'>;
    expect(codexItemToSurfaceMessage('thread-reasoning', turn, {
      type: 'reasoning',
      id: 'reasoning-item',
      summary: ['  Inspecting  ', '', '   ', 'Testing'],
      content: ['private chain of thought'],
    })).toStrictEqual({
      id: 'assistant-reasoning-item',
      role: 'assistant',
      status: 'complete',
      turnId: 'turn-reasoning',
      parts: [
        { type: 'reasoning', summary: 'Inspecting', itemId: 'reasoning-item', summaryIndex: 0 },
        { type: 'reasoning', summary: 'Testing', itemId: 'reasoning-item', summaryIndex: 3 },
      ],
      createdAt: '1970-01-01T00:00:02.000Z',
      metadata: {
        conversationId: 'thread-reasoning', turnId: 'turn-reasoning', itemId: 'reasoning-item',
      },
    });
    expect(codexItemToSurfaceMessage('thread-reasoning', turn, {
      type: 'reasoning', id: 'empty-reasoning', summary: ['', '   '], content: ['private'],
    })).toBeNull();
  });

  it('preserves ordered reasoning summaries inside complete turn history', () => {
    const messages = codexTurnToSurfaceMessages('thread-reasoning', {
      id: 'turn-reasoning',
      status: 'completed',
      startedAt: 2,
      completedAt: 3,
      items: [
        { type: 'reasoning', id: 'empty', summary: ['   '], content: ['hidden'] },
        {
          type: 'reasoning', id: 'reasoning-1',
          summary: ['  Inspecting the renderer ', '', 'Checking events'],
          content: ['hidden'],
        },
        {
          type: 'reasoning', id: 'reasoning-2', summary: ['Finishing'], content: ['also hidden'],
        },
        { type: 'agentMessage', id: 'first-summary', text: 'Summary', phase: 'final_answer' },
        { type: 'reasoning', id: 'resumed-empty', summary: [], content: ['private'] },
      ],
    } as unknown as v2.Turn);

    expect(messages).toStrictEqual([{
      id: 'assistant-turn-reasoning',
      role: 'assistant',
      status: 'complete',
      turnId: 'turn-reasoning',
      parts: [
        {
          type: 'reasoning', summary: 'Inspecting the renderer', itemId: 'reasoning-1', summaryIndex: 0,
        },
        { type: 'reasoning', summary: 'Checking events', itemId: 'reasoning-1', summaryIndex: 2 },
        { type: 'reasoning', summary: 'Finishing', itemId: 'reasoning-2', summaryIndex: 0 },
        { type: 'text', text: 'Summary', itemId: 'first-summary', phase: 'final_answer' },
        { type: 'reasoning', summary: '', itemId: 'resumed-empty', summaryIndex: 0 },
      ],
      createdAt: '1970-01-01T00:00:02.000Z',
      metadata: { conversationId: 'thread-reasoning', turnId: 'turn-reasoning' },
    }]);
    expect(JSON.stringify(messages)).not.toContain('hidden');
  });

  it('uses visible reasoning—not empty reasoning—to classify later user input as steering', () => {
    const base = {
      status: 'completed', startedAt: 2, completedAt: 3,
    } as const;
    const userMessage = {
      type: 'userMessage', id: 'user-after-reasoning', clientId: null,
      content: [{ type: 'text', text: 'Continue', text_elements: [] }],
    } as const;
    const empty = codexTurnToSurfaceMessages('thread-reasoning', {
      ...base,
      id: 'turn-empty-reasoning',
      items: [
        { type: 'reasoning', id: 'reasoning-empty', summary: ['   '], content: ['hidden'] },
        userMessage,
      ],
    } as unknown as v2.Turn);
    const visible = codexTurnToSurfaceMessages('thread-reasoning', {
      ...base,
      id: 'turn-visible-reasoning',
      items: [
        { type: 'reasoning', id: 'reasoning-visible', summary: ['Visible'], content: ['hidden'] },
        userMessage,
      ],
    } as unknown as v2.Turn);

    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ role: 'user' });
    expect(empty[0]).not.toHaveProperty('kind');
    expect(visible.map(({ role, kind }) => ({ role, kind }))).toStrictEqual([
      { role: 'assistant', kind: undefined },
      { role: 'user', kind: 'steer' },
    ]);
  });

  it('settles stale running tool items in terminal history messages', () => {
    const runningCommand = {
      type: 'commandExecution',
      id: 'command-interrupted',
      command: 'npm test',
      cwd: '/tmp/project',
      status: 'inProgress',
      commandActions: [{ type: 'run', command: 'npm test' }],
      aggregatedOutput: '',
      exitCode: null,
      durationMs: null,
    } as unknown as v2.ThreadItem;

    expect(codexItemToSurfaceMessage('thread', {
      id: 'turn-interrupted', status: 'interrupted', startedAt: 1,
    }, runningCommand)).toMatchObject({
      status: 'complete',
      parts: [{ type: 'tool', status: 'failed' }],
    });

    const [message] = codexTurnToSurfaceMessages('thread', {
      id: 'turn-interrupted',
      status: 'interrupted',
      startedAt: 1,
      completedAt: 2,
      items: [runningCommand],
    } as unknown as v2.Turn);
    expect(message).toMatchObject({
      status: 'complete',
      parts: [{ type: 'tool', status: 'failed' }],
    });
  });

  it('preserves bounded data previews while rematerializing local image history', () => {
    const turn = {
      id: 'turn', status: 'completed', startedAt: 1, completedAt: 2,
      items: [{
        type: 'userMessage', id: 'user', clientId: 'client-user',
        content: [{ type: 'localImage', path: '/tmp/resumed.png' }],
      }],
    } as unknown as v2.Turn;
    const previous = codexTurnToSurfaceMessages('thread', turn).map((message) => ({
      ...message,
      parts: message.parts.map((part) => part.type === 'attachment'
        ? { ...part, attachment: { ...part.attachment, url: 'data:image/png;base64,cG5n' } }
        : part),
    }));
    const history = codexTurnToSurfaceMessages('thread', turn);

    expect(preserveHistoricalAttachmentPreviews(previous, history)[0]?.parts).toContainEqual({
      type: 'attachment',
      attachment: {
        kind: 'image',
        name: 'resumed.png',
        path: '/tmp/resumed.png',
        mimeType: 'image/png',
        url: 'data:image/png;base64,cG5n',
      },
    });
  });

  it('projects completed generated images as first-class media for restored history', () => {
    const completed = {
      type: 'imageGeneration',
      id: 'generated-image',
      status: 'completed',
      revisedPrompt: 'A friendly logistics map',
      result: pngBase64,
      savedPath: '/tmp/generated image.png',
    } as unknown as v2.ThreadItem;

    expect(codexItemToMediaPart(completed)).toStrictEqual({
      type: 'media',
      itemId: 'generated-image',
      media: {
        url: `data:image/png;base64,${pngBase64}`,
        alt: 'Generated image',
        title: 'Generated image',
        mimeType: 'image/png',
        prompt: 'A friendly logistics map',
      },
    });
    expect(codexItemToSurfaceMessage('thread', {
      id: 'turn', status: 'completed', startedAt: 1,
    }, completed)).toMatchObject({
      parts: [
        { type: 'tool', id: 'generated-image', status: 'completed' },
        {
          type: 'media', itemId: 'generated-image',
          media: { url: `data:image/png;base64,${pngBase64}`, prompt: 'A friendly logistics map' },
        },
      ],
    });
    expect(codexTurnToSurfaceMessages('thread', {
      id: 'turn', status: 'completed', startedAt: 1, completedAt: 2,
      items: [
        completed,
        { type: 'agentMessage', id: 'agent-after-image', text: 'Here it is.' },
      ],
    } as unknown as v2.Turn)[0]?.parts.map((part) => part.type)).toStrictEqual([
      'tool', 'media', 'text',
    ]);

    expect(codexItemToMediaPart({
      ...completed, savedPath: undefined, revisedPrompt: null,
    } as unknown as v2.ThreadItem)).toMatchObject({
      media: { url: `data:image/png;base64,${pngBase64}`, mimeType: 'image/png' },
    });
    expect(codexItemToMediaPart({
      ...completed, status: 'inProgress', savedPath: undefined,
    } as unknown as v2.ThreadItem)).toBeNull();
    expect(codexItemToMediaPart({
      ...completed, status: 'failed', savedPath: undefined,
    } as unknown as v2.ThreadItem)).toBeNull();
    expect(codexItemToMediaPart({
      ...completed, result: 'not base64', savedPath: undefined,
    } as unknown as v2.ThreadItem)).toBeNull();
    expect(codexItemToMediaPart({
      ...completed, result: 'aW1hZ2U=', savedPath: undefined,
    } as unknown as v2.ThreadItem)).toBeNull();
    expect(codexItemToMediaPart({
      ...completed, result: '',
    } as unknown as v2.ThreadItem)).toMatchObject({
      media: { url: 'file:///tmp/generated%20image.png', mimeType: 'image/png' },
    });
    expect(codexItemToMediaPart({
      ...completed, savedPath: '/tmp/generated.svg',
    } as unknown as v2.ThreadItem)).toMatchObject({
      media: { url: `data:image/png;base64,${pngBase64}` },
    });
  });

  it('only restores bounded image envelopes and authorized raster path candidates', () => {
    const image = { type: 'image', data: pngBase64, mimeType: 'image/svg+xml' };
    const wrap = (content: unknown[]) => [{ type: 'text', text: JSON.stringify({ content }) }];
    const extract = (content: unknown[]) => codexItemToMediaParts({
      type: 'mcpToolCall', id: 'bounded', status: 'completed', result: { content },
    } as unknown as v2.ThreadItem);
    expect(extract(wrap([image]))[0]?.phase).toBe('commentary');
    expect(codexItemToMediaParts({ type: 'imageView', id: 'view', path: '/tmp/screenshot.png' })[0]?.phase).toBe('commentary');
    expect(extract(wrap([image]))[0]?.media.mimeType).toBe('image/png'); // Sniff bytes, not the claimed MIME.
    for (const content of [
      [{ type: 'text', text: '{broken JSON' }],
      [{ type: 'text', text: JSON.stringify({ unrelated: [image] }) }],
      wrap([{ type: 'image', data: 'not an image' }]),
      wrap([{ type: 'image', data: pngBase64.slice(0, 40) + '…' + pngBase64.slice(-12) }]),
      Array.from({ length: 5 }).reduce<unknown[]>(value => wrap(value), [image]),
      [...Array.from({ length: 256 }, () => ({ type: 'text', text: '' })), image],
      [{ type: 'text', text: ' '.repeat(32 * 1024 * 1024) + JSON.stringify({ content: [image] }) }],
    ]) expect(extract(content)).toEqual([]);
    expect(extract(Array.from({ length: 10 }, () => image))).toHaveLength(8);
    for (const path of ['relative.png', 'https://example.com/shot.png', '/tmp/vector.svg', '/tmp/file.txt']) {
      expect(codexItemToMediaParts({ type: 'imageView', id: 'unsafe', path })).toEqual([]);
    }
  });

  it('bounds historical tool payloads without dropping visible generated images', () => {
    const largeImagePayload = 'A'.repeat(2 * 1024 * 1024);
    const messages = codexThreadToSurfaceMessages({
      id: 'thread-large-tool-output',
      turns: [{
        id: 'turn-large-tool-output', status: 'completed', startedAt: 1, completedAt: 2,
        items: [
          { mcpAppUi: null,
            type: 'mcpToolCall', id: 'large-tool', server: 'images', tool: 'inspect', status: 'completed',
            arguments: { path: '/tmp/input.png' }, error: null, appContext: null, pluginId: null,
            readOnlyHint: true, durationMs: 1, result: {
              content: [{ type: 'image', data: largeImagePayload, mimeType: 'image/png' }],
              structuredContent: { image: largeImagePayload },
            },
          },
          {
            type: 'imageGeneration', id: 'generated-image', status: 'completed', revisedPrompt: 'Visible image',
            result: pngBase64, savedPath: null,
          },
        ],
      }],
    } as unknown as v2.Thread);

    expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(64 * 1024);
    const largeTool = messages[0]?.parts.find((part) => part.type === 'tool' && part.id === 'large-tool');
    expect(largeTool).toMatchObject({ type: 'tool', id: 'large-tool', body: undefined });
    expect(largeTool).not.toHaveProperty('output');
    expect(messages[0]?.parts).toContainEqual(expect.objectContaining({
      type: 'media', itemId: 'generated-image',
      media: expect.objectContaining({ url: `data:image/png;base64,${pngBase64}` }),
    }));
  });

  it('translates resumed Codex turns into renderer messages in item order', () => {
    const thread = {
      id: 'thread-resumed',
      cwd: '/Users/nbonamy/src/project',
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          startedAt: 1_780_000_000,
          completedAt: 1_780_000_010,
          items: [
            {
              type: 'userMessage',
              id: 'user-1',
              content: [
                {
                  type: 'text',
                  text: 'read README.md',
                  text_elements: [],
                },
              ],
            },
            {
              type: 'agentMessage',
              id: 'msg-1',
              text: 'I will read it.',
            },
            {
              type: 'commandExecution',
              id: 'cmd-read',
              command: 'sed -n "1,120p" README.md',
              cwd: '/Users/nbonamy/src/project',
              status: 'completed',
              commandActions: [
                {
                  type: 'read',
                  name: 'README.md',
                  cmd: 'sed -n "1,120p" README.md',
                },
              ],
              aggregatedOutput: '# Project',
              exitCode: 0,
              durationMs: 42,
            },
            {
              type: 'agentMessage',
              id: 'msg-2',
              text: 'Read README.md.',
            },
          ],
        },
      ],
    };

    expect(codexThreadToSurfaceMessages(thread as unknown as v2.Thread)).toStrictEqual([
      {
        id: 'user-thread-resumed-turn-1-user-1',
        role: 'user',
        status: 'complete',
        turnId: 'turn-1',
        createdAt: '2026-05-28T20:26:40.000Z',
        metadata: { conversationId: 'thread-resumed', turnId: 'turn-1' },
        parts: [{ type: 'text', text: 'read README.md' }],
      },
      {
        id: 'assistant-turn-1',
        role: 'assistant',
        status: 'complete',
        turnId: 'turn-1',
        createdAt: '2026-05-28T20:26:40.000Z',
        metadata: { conversationId: 'thread-resumed', turnId: 'turn-1' },
        parts: [
          { type: 'text', text: 'I will read it.', itemId: 'msg-1' },
          {
            type: 'tool',
            id: 'cmd-read',
            kind: 'command',
            title: 'sed -n "1,120p" README.md',
            status: 'completed',
            statusText: '{"action":"read","phase":"completed","params":{"names":["README.md"],"target":"README.md"},"source":"codex"}',
            input: {
              command: 'sed -n "1,120p" README.md',
              cwd: '/Users/nbonamy/src/project',
              commandActions: [
                {
                  type: 'read',
                  name: 'README.md',
                  cmd: 'sed -n "1,120p" README.md',
                },
              ],
            },
            output: {
              exitCode: 0,
              durationMs: 42,
            },
            metadata: {
              source: undefined,
              processId: undefined,
            },
          },
          { type: 'text', text: 'Read README.md.', itemId: 'msg-2' },
        ],
      },
    ]);
  });

  it('does not replay Codex plan items as normal assistant text', () => {
    const thread = {
      id: 'thread-resumed',
      cwd: '/Users/nbonamy/src/project',
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          startedAt: 1_780_000_000,
          completedAt: 1_780_000_010,
          items: [
            {
              type: 'userMessage',
              id: 'user-1',
              content: [
                {
                  type: 'text',
                  text: 'write a dummy false plan this is a test',
                  text_elements: [],
                },
              ],
            },
            {
              type: 'plan',
              id: 'turn-1-plan',
              text: '# Dummy False Plan\n\n- [ ] Do not implement\n',
            },
          ],
        },
      ],
    };

    expect(codexThreadToSurfaceMessages(thread as unknown as v2.Thread)).toStrictEqual([
      {
        id: 'user-thread-resumed-turn-1-user-1',
        role: 'user',
        status: 'complete',
        turnId: 'turn-1',
        createdAt: '2026-05-28T20:26:40.000Z',
        metadata: { conversationId: 'thread-resumed', turnId: 'turn-1' },
        parts: [{ type: 'text', text: 'write a dummy false plan this is a test' }],
      },
    ]);
  });

  it('preserves mid-turn steering as a visible marker between assistant segments', () => {
    const thread = {
      id: 'thread-steered',
      cwd: '/Users/nbonamy/src/project',
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          startedAt: 1_780_000_000,
          completedAt: 1_780_000_010,
          items: [
            {
              type: 'userMessage',
              id: 'user-1',
              content: [
                {
                  type: 'text',
                  text: 'read all markdown files',
                  text_elements: [],
                },
              ],
            },
            {
              type: 'agentMessage',
              id: 'msg-1',
              text: 'I will inventory the Markdown files.',
            },
            {
              type: 'userMessage',
              id: 'steer-1',
              content: [
                {
                  type: 'text',
                  text: 'actually read them too',
                  text_elements: [],
                },
              ],
            },
            {
              type: 'agentMessage',
              id: 'msg-2',
              text: 'Reading them now.',
            },
          ],
        },
      ],
    };

    expect(codexThreadToSurfaceMessages(thread as unknown as v2.Thread)).toStrictEqual([
      {
        id: 'user-thread-steered-turn-1-user-1',
        role: 'user',
        status: 'complete',
        turnId: 'turn-1',
        createdAt: '2026-05-28T20:26:40.000Z',
        metadata: { conversationId: 'thread-steered', turnId: 'turn-1' },
        parts: [{ type: 'text', text: 'read all markdown files' }],
      },
      {
        id: 'assistant-turn-1',
        role: 'assistant',
        status: 'complete',
        turnId: 'turn-1',
        createdAt: '2026-05-28T20:26:40.000Z',
        metadata: { conversationId: 'thread-steered', turnId: 'turn-1' },
        parts: [
          { type: 'text', text: 'I will inventory the Markdown files.', itemId: 'msg-1' },
        ],
      },
      {
        id: 'user-thread-steered-turn-1-steer-1',
        kind: 'steer',
        role: 'user',
        status: 'complete',
        turnId: 'turn-1',
        createdAt: '2026-05-28T20:26:40.000Z',
        metadata: { conversationId: 'thread-steered', turnId: 'turn-1' },
        parts: [{ type: 'text', text: 'actually read them too' }],
      },
      {
        id: 'assistant-turn-1-segment-1',
        role: 'assistant',
        status: 'complete',
        turnId: 'turn-1',
        createdAt: '2026-05-28T20:26:40.000Z',
        metadata: { conversationId: 'thread-steered', turnId: 'turn-1' },
        parts: [
          { type: 'text', text: 'Reading them now.', itemId: 'msg-2' },
        ],
      },
    ]);
  });

  it('hydrates completed review output as assistant text instead of hidden tool output', () => {
    const thread = {
      id: 'thread-review',
      cwd: '/Users/nbonamy/src/project',
      turns: [
        {
          id: 'turn-review',
          status: 'completed',
          startedAt: 1_780_000_000,
          completedAt: 1_780_000_010,
          items: [
            {
              type: 'userMessage',
              id: 'user-review',
              content: [
                {
                  type: 'text',
                  text: 'current changes',
                  text_elements: [],
                },
              ],
            },
            {
              type: 'enteredReviewMode',
              id: 'review-1',
              review: 'current changes',
            },
            {
              type: 'exitedReviewMode',
              id: 'review-1',
              review: 'Found one issue.',
            },
          ],
        },
      ],
    };

    expect(codexThreadToSurfaceMessages(thread as unknown as v2.Thread)).toStrictEqual([
      {
        id: 'user-thread-review-turn-review-user-review',
        role: 'user',
        status: 'complete',
        turnId: 'turn-review',
        createdAt: '2026-05-28T20:26:40.000Z',
        metadata: { conversationId: 'thread-review', turnId: 'turn-review' },
        parts: [{ type: 'text', text: 'current changes' }],
      },
      {
        id: 'assistant-turn-review',
        role: 'assistant',
        status: 'complete',
        turnId: 'turn-review',
        createdAt: '2026-05-28T20:26:40.000Z',
        metadata: { conversationId: 'thread-review', turnId: 'turn-review' },
        parts: [{ type: 'text', text: 'Found one issue.', itemId: 'review-1' }],
      },
    ]);
  });

  it('materializes the canonical review-mode items returned by app-server history', () => {
    const text = 'The review found one issue.';
    const messages = codexTurnToSurfaceMessages('thread-review', {
      id: 'turn-review',
      status: 'completed',
      startedAt: 1_780_000_000,
      completedAt: 1_780_000_010,
      items: [
        { type: 'enteredReviewMode', id: 'review-start', review: 'current changes' },
        { type: 'exitedReviewMode', id: 'review-1', review: text },
      ],
    } as unknown as v2.Turn);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts).toStrictEqual([
      { type: 'text', text, itemId: 'review-1' },
    ]);
  });

  it('collapses duplicated initial user items materialized by an app-server review turn', () => {
    const prompt = 'Review the current code changes and provide prioritized findings.';
    const messages = codexTurnToSurfaceMessages('thread-review', {
      id: 'turn-review-worker',
      status: 'completed',
      startedAt: 1_780_000_000,
      completedAt: 1_780_000_010,
      items: [
        { type: 'userMessage', id: 'user-1', clientId: null, content: [{ type: 'text', text: prompt }] },
        { type: 'userMessage', id: 'user-2', clientId: null, content: [{ type: 'text', text: prompt }] },
        { type: 'agentMessage', id: 'result', text: 'No findings.', phase: null },
      ],
    } as unknown as v2.Turn);

    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(messages[0]?.parts).toStrictEqual([{ type: 'text', text: prompt }]);
  });

  it('preserves only safe exact-path previews across mixed history parts', () => {
    const safe = 'data:image/png;base64,cG5n';
    const previous: SurfaceMessage[] = [{
      id: 'previous', role: 'user', status: 'complete', parts: [
        { type: 'text', text: 'ignore' },
        { type: 'attachment', attachment: { kind: 'file', name: 'file', path: '/file.png', url: safe } },
        { type: 'attachment', attachment: { kind: 'image', name: 'pathless', url: safe } },
        { type: 'attachment', attachment: {
          kind: 'image', name: 'unsafe', path: '/unsafe.svg', url: 'data:image/svg+xml;base64,PHN2Zz4=',
        } },
        { type: 'attachment', attachment: { kind: 'image', name: 'safe', path: '/same.png', url: safe } },
      ],
    }];
    const same = historyImage('same', '/same.png', safe);
    const other = historyImage('other', '/other.png', 'file:///other.png');
    const target = historyImage('target', '/same.png', 'file:///same.png');
    const text: SurfaceMessage = {
      id: 'text', role: 'assistant', status: 'complete', parts: [{ type: 'text', text: 'unchanged' }],
    };

    const result = preserveHistoricalAttachmentPreviews(previous, [text, same, other, target]);

    expect(result.slice(0, 3)).toStrictEqual([text, same, other]);
    expect(result[3]?.parts[0]).toMatchObject({ attachment: { url: safe } });
    expect(target.parts[0]).toMatchObject({ attachment: { url: 'file:///same.png' } });
  });

  it('normalizes attachment names and MIME fallbacks in one user-input contract', () => {
    const message = codexItemToSurfaceMessage('thread', {
      id: 'turn', status: 'completed', startedAt: 1,
    }, {
      type: 'userMessage', id: 'inputs', clientId: null, content: [
        { type: 'mention', name: ' Named ', path: '/tmp/file.pdf' },
        { type: 'mention', name: ' ', path: '/tmp/fallback.txt' },
        { type: 'image', url: 'data:image/PNG;base64,AAAA' },
        { type: 'image', url: 'https://example.com/' },
        { type: 'image', url: 'http://[.png' },
        { type: 'localImage', path: '/tmp/local.HEIC' },
        { type: 'localImage', path: '' },
      ],
    } as unknown as v2.ThreadItem);

    expect(message?.parts).toStrictEqual([
      { type: 'attachment', attachment: {
        kind: 'file', name: 'Named', path: '/tmp/file.pdf', mimeType: 'application/pdf',
      } },
      { type: 'attachment', attachment: { kind: 'file', name: 'fallback.txt', path: '/tmp/fallback.txt' } },
      { type: 'attachment', attachment: {
        kind: 'image', name: 'PNG;base64,AAAA', url: 'data:image/PNG;base64,AAAA', mimeType: 'image/png',
      } },
      { type: 'attachment', attachment: { kind: 'image', name: 'Image', url: 'https://example.com/' } },
      { type: 'attachment', attachment: {
        kind: 'image', name: '[.png', url: 'http://[.png', mimeType: 'image/png',
      } },
      { type: 'attachment', attachment: {
        kind: 'image', name: 'local.HEIC', path: '/tmp/local.HEIC', mimeType: 'image/heic',
      } },
      { type: 'attachment', attachment: { kind: 'image', name: 'Image', path: '' } },
    ]);
  });

  it('recognizes every generated-image signature and enforces the decoded byte limit', () => {
    const images = [
      ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
      ['image/jpeg', [0xff, 0xd8, 0xff, 0x00]],
      ['image/gif', [...Buffer.from('GIF87a')]],
      ['image/gif', [...Buffer.from('GIF89a')]],
      ['image/webp', [...Buffer.from('RIFF0000WEBP')]],
      ['image/avif', [...Buffer.from('0000ftypavif')]],
    ] as const;
    for (const [mimeType, bytes] of images) {
      const base64 = Buffer.from(bytes).toString('base64');
      expect(codexImageDataUrl(base64)).toStrictEqual({
        url: `data:${mimeType};base64,${base64}`, mimeType,
      });
    }
    const exact = Buffer.alloc(16 * 1024 * 1024);
    exact.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const over = Buffer.alloc(exact.byteLength + 1);
    exact.copy(over);
    expect(codexImageDataUrl(exact.toString('base64'))).toMatchObject({ mimeType: 'image/png' });
    expect(codexImageDataUrl(over.toString('base64'))).toBeNull();
  });

});

function historyImage(id: string, path: string, url: string): SurfaceMessage {
  return {
    id, role: 'user', status: 'complete', parts: [{
      type: 'attachment', attachment: { kind: 'image', name: id, path, url },
    }],
  };
}
