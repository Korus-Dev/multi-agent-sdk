import { describe, expect, it } from 'vitest';
import type { ClaudeSdkMessage } from '../../../src/providers/claude/protocol';
import type { ClaudePermissionRequest, ClaudeTurnTransport } from '../../../src/providers/claude/transport';
import { harnessForHost } from '../../../src/internal';
import { ClaudeHost } from '../../../src/providers/claude/host';
import { claudeTranscriptToMessages } from '../../../src/providers/claude/transcript-history-adapter';

// A question the person answered shows what they answered after the card is shown again, in a later session or from
// history: the answers are on the question's tool call, keyed by question.
const session = { kind: 'claude' as const, conversationId: 'ask-session', transport: 'stdio' as const };
const questions = [
  { question: 'Which version?', header: 'Version', multiSelect: false, options: [{ label: '0.57.2', description: '' }, { label: '0.58.0', description: '' }] },
  { question: 'Which channels?', header: 'Channel', multiSelect: true, options: [{ label: 'stable', description: '' }, { label: 'beta', description: '' }] },
];
const ask = { type: 'tool_use', id: 'q-1', name: 'AskUserQuestion', input: { questions } };
const result = { type: 'tool_result', tool_use_id: 'q-1', content: 'The user answered: "Which version?"="0.57.2".' };
const toolUseResult = { questions, answers: { 'Which version?': '0.57.2', 'Which channels?': 'stable, beta' } };
const answers = { 'Which version?': { answers: ['0.57.2'] }, 'Which channels?': { answers: ['stable', 'beta'] } };

describe('Claude questions the person answered', () => {
  it('carries the answers on the question when a conversation is read from its transcript', () => {
    const rows = [
      { type: 'user', uuid: 'u-1', promptId: 'p-1', message: { content: 'Release' } },
      { type: 'assistant', uuid: 'a-1', message: { id: 'm-1', content: [ask] } },
      { type: 'user', uuid: 'r-1', message: { content: [result] }, toolUseResult },
    ].map(row => JSON.stringify(row)).join('\n');
    const tool = claudeTranscriptToMessages(rows, 'agent', session.conversationId).flatMap(message => message.parts).find(part => part.type === 'tool');
    expect(tool?.type === 'tool' && tool.output).toStrictEqual({ answers });
  });

  it('carries the answers on the question while the turn runs', async () => {
    let emit!: (message: ClaudeSdkMessage) => void;
    const host = new ClaudeHost({ startTurn: (_params, listener) => { emit = listener; return { done: new Promise(() => {}), interrupt: async () => {} }; }, close: async () => {} },
      async () => ({ providerSession: session, messages: [] }));
    const harness = harnessForHost('claude', host);
    const opened = harness.restoreSession({ id: 'agent', folder: '/synthetic' }, { provider: 'claude', data: session, role: 'main' });
    await harness.sendPrompt(opened, 'Go');
    try {
      const send = (message: object) => emit({ session_id: session.conversationId, ...message } as ClaudeSdkMessage);
      send({ type: 'system', subtype: 'init' });
      send({ type: 'assistant', message: { id: 'm-1', content: [ask] } });
      send({ type: 'user', message: { content: [result] }, tool_use_result: toolUseResult });
      const tool = harness.readSession(opened).messages.flatMap(message => message.parts).find(part => part.type === 'tool');
      expect(tool?.type === 'tool' && tool.output).toStrictEqual({ answers });
    } finally { await harness.close(); }
  });

  it('shows the answers on the question card once the person has answered, and ends its call', async () => {
    let raise!: (request: ClaudePermissionRequest) => void;
    let emit!: (message: ClaudeSdkMessage) => void;
    const transport: ClaudeTurnTransport = {
      startTurn: (_params, onMessage, onPermissionRequest) => { emit = onMessage; raise = onPermissionRequest!; return { done: new Promise(() => {}), interrupt: async () => {} }; },
      respondToPermissionRequest: async () => {}, close: async () => {},
    };
    const host = new ClaudeHost(transport, async () => ({ providerSession: session, messages: [] }));
    const harness = harnessForHost('claude', host);
    const opened = harness.restoreSession({ id: 'agent', folder: '/synthetic' }, { provider: 'claude', data: session, role: 'main' });
    await harness.sendPrompt(opened, 'Go');
    try {
      emit({ type: 'system', subtype: 'init', session_id: session.conversationId } as ClaudeSdkMessage);
      raise({ kind: 'ask_user', id: 'request-1', toolName: 'AskUserQuestion', input: { questions }, allowConversation: false, allowAlways: false,
        questions: questions.map(question => ({ id: question.question, header: question.header, question: question.question, isOther: true, isSecret: false, multiSelect: question.multiSelect, options: question.options })) });
      const card = () => harness.readSession(opened).messages.flatMap(message => message.parts).find(part => part.type === 'tool' && part.id === 'request-1');
      expect(card()).toMatchObject({ status: 'running' });
      await harness.respondToRequest(opened, { id: 'request-1', outcome: { kind: 'answered', answers } });
      expect(card()).toMatchObject({ status: 'completed', output: { answers } });
    } finally { await harness.close(); }
  });
});
