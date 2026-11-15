import { afterEach, describe, expect, it, vi } from 'vitest';
import { harnessForHost } from '../../../src/internal';
import type { McpToolCall } from '../../../src';
import { codexSdkFixture, sdkAgent } from './sdk-host-fixture';

// The app titles its own MCP tool calls. Codex shows a call's input and output only as far as it understands them; the
// hook is given the call as the harness reported it, and a string it returns becomes the call's title.
const input = { text: 'Buy milk', tags: ['home'], nested: { deep: { deeper: 1 } } };
const output = { content: [{ type: 'text', text: 'added' }], isError: false };
const mcp = (status: 'running' | 'completed' | 'failed') => ({ type: 'tool' as const, id: 'call-1', kind: 'mcp', title: 'notes.add', status, input, output: status === 'running' ? undefined : output, metadata: { server: 'notes', tool: 'add' } });
const command = { type: 'tool' as const, id: 'call-2', kind: 'commandExecution', title: 'ls', status: 'completed' as const, input: { command: 'ls' } };

describe('Codex MCP tool calls titled by the app', () => {
  const fixtures: ReturnType<typeof codexSdkFixture>[] = [];
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(({ driver }) => driver.close())); });
  const open = async (presentToolCall: (call: McpToolCall) => string | undefined, parts: object[]) => {
    const fixture = codexSdkFixture(); fixtures.push(fixture);
    const conversation = fixture.conversation('conversation-a');
    conversation.setSnapshot({ turnIds: ['t'], turns: [{ id: 't', status: 'completed' } as never], messages: [{ id: 'm', role: 'assistant', turnId: 't', status: 'complete', parts: parts as never }] });
    const harness = harnessForHost('codex', fixture.driver as never, { presentToolCall });
    const context = sdkAgent();
    const session = harness.restoreSession({ id: context.id, folder: context.folder }, { provider: 'codex', data: context.providerSession!, role: 'main' });
    await harness.sendPrompt(session, 'Go');
    return () => harness.readSession(session).messages.flatMap(message => message.parts).filter(part => part.type === 'tool');
  };

  it('titles a call from the input and result the tool saw, not the part Codex shows', async () => {
    const present = vi.fn((call: McpToolCall) => `${call.server}:${call.tool}:${call.state}`);
    const tools = await open(present, [mcp('completed')]);
    expect(tools()[0]?.metadata?.displayTitle).toBe('notes:add:completed');
    expect(present).toHaveBeenCalledWith({ server: 'notes', tool: 'add', input, result: output, state: 'completed' });
  });

  it('titles a running call without a result', async () => {
    const present = vi.fn((call: McpToolCall) => call.state);
    const tools = await open(present, [mcp('running')]);
    expect(tools()[0]?.metadata?.displayTitle).toBe('running');
    expect(present.mock.calls[0]![0]).not.toHaveProperty('result');
  });

  it('leaves the call as it was when the hook returns nothing', async () => {
    const tools = await open(() => undefined, [mcp('completed')]);
    expect(tools()[0]?.metadata ?? {}).not.toHaveProperty('displayTitle');
  });

  it('does not ask about calls that are not MCP tools', async () => {
    const present = vi.fn(() => 'never');
    const tools = await open(present, [command]);
    expect(tools()).toHaveLength(1);
    expect(present).not.toHaveBeenCalled();
  });
});
