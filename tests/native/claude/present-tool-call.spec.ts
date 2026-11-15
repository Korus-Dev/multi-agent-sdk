import { describe, expect, it, vi } from 'vitest';
import type { ClaudeSdkMessage } from '../../../src/providers/claude/protocol';
import { ClaudeHarness } from '../../../src/providers/claude/harness';
import { ClaudeHost } from '../../../src/providers/claude/host';
import { claudeTranscriptToMessages } from '../../../src/providers/claude/transcript-history-adapter';
import type { McpToolCall } from '../../../src';

// The app titles its own MCP tool calls. The hook sees what the tool was called with and what it returned, and a
// string it returns becomes the title the conversation shows for that call.
const session = { kind: 'claude' as const, conversationId: 'present-session', transport: 'stdio' as const };
const call = { type: 'tool_use', id: 't-1', name: 'mcp__notes__add', input: { text: 'Buy milk', extra: { deep: [1, 2] } } };
const result = { type: 'tool_result', tool_use_id: 't-1', content: [{ type: 'text', text: 'added' }] };

const live = async (presentToolCall: (call: McpToolCall) => string | undefined) => {
  let emit!: (message: ClaudeSdkMessage) => void;
  const host = new ClaudeHost({ startTurn: (_params, listener) => { emit = listener; return { done: new Promise(() => {}), interrupt: async () => {} }; }, close: async () => {} },
    async () => ({ providerSession: session, messages: [] }), ClaudeHarness.mapOptions({ client: { name: 'app' }, presentToolCall }).claude?.host);
  const { harnessForHost } = await import('../../../src/internal');
  const harness = harnessForHost('claude', host);
  const opened = harness.restoreSession({ id: 'agent', folder: '/synthetic' }, { provider: 'claude', data: session, role: 'main' });
  await harness.sendPrompt(opened, 'Go');
  const send = (message: object) => emit({ session_id: session.conversationId, ...message } as ClaudeSdkMessage);
  const tool = () => harness.readSession(opened).messages.flatMap(message => message.parts).find(part => part.type === 'tool');
  return { send, tool, close: () => harness.close() };
};

describe('Claude MCP tool calls titled by the app', () => {
  it('titles a running call from the raw input, then again once the result is in', async () => {
    const presentToolCall = vi.fn((c: McpToolCall) => c.state === 'running' ? `Adding ${(c.input as { text: string }).text}` : `Added: ${JSON.stringify(c.result)}`);
    const { send, tool, close } = await live(presentToolCall);
    try {
      send({ type: 'system', subtype: 'init' });
      send({ type: 'assistant', message: { id: 'm-1', content: [call] } });
      expect(tool()?.metadata?.displayTitle).toBe('Adding Buy milk');
      expect(presentToolCall).toHaveBeenLastCalledWith({ server: 'notes', tool: 'add', input: call.input, state: 'running' });
      send({ type: 'user', message: { content: [result] } });
      expect(tool()?.metadata?.displayTitle).toMatch(/^Added: /);
      expect(presentToolCall).toHaveBeenLastCalledWith(expect.objectContaining({ server: 'notes', tool: 'add', input: call.input, state: 'completed', result: expect.anything() }));
    } finally { await close(); }
  });

  it('leaves the call as it was when the hook returns nothing', async () => {
    const { send, tool, close } = await live(() => undefined);
    try {
      send({ type: 'system', subtype: 'init' });
      send({ type: 'assistant', message: { id: 'm-1', content: [call] } });
      send({ type: 'user', message: { content: [result] } });
      expect(tool()?.metadata).not.toHaveProperty('displayTitle');
    } finally { await close(); }
  });

  it('does not ask about calls that are not MCP tools', async () => {
    const presentToolCall = vi.fn(() => 'never');
    const { send, tool, close } = await live(presentToolCall);
    try {
      send({ type: 'system', subtype: 'init' });
      send({ type: 'assistant', message: { id: 'm-1', content: [{ type: 'tool_use', id: 't-2', name: 'Read', input: { file_path: '/a' } }] } });
      expect(tool()?.metadata?.displayTitle).not.toBe('never');
      expect(presentToolCall).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it('titles a failed call as failed', async () => {
    const presentToolCall = vi.fn((c: McpToolCall) => c.state);
    const { send, close } = await live(presentToolCall);
    try {
      send({ type: 'system', subtype: 'init' });
      send({ type: 'assistant', message: { id: 'm-1', content: [call] } });
      send({ type: 'user', message: { content: [{ ...result, is_error: true, content: 'boom' }] } });
      expect(presentToolCall).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'failed' }));
    } finally { await close(); }
  });

  it('titles calls read back from the transcript the same way', () => {
    const presentToolCall = (c: McpToolCall) => `${c.server}.${c.tool} ${c.state}`;
    const rows = [
      { type: 'user', uuid: 'u-1', promptId: 'p-1', message: { content: 'Go' } },
      { type: 'assistant', uuid: 'a-1', message: { id: 'm-1', content: [call] } },
      { type: 'user', uuid: 'r-1', message: { content: [result] } },
    ].map(row => JSON.stringify(row)).join('\n');
    const messages = claudeTranscriptToMessages(rows, 'agent', session.conversationId, undefined, undefined, undefined, undefined, undefined, { presentToolCall });
    const tool = messages.flatMap(message => message.parts).find(part => part.type === 'tool');
    expect(tool?.metadata?.displayTitle).toBe('notes.add completed');
  });
});
