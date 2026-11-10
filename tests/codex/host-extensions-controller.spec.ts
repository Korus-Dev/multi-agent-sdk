import { describe, expect, it, vi } from 'vitest';
import { CodexHostExtensionsController } from '../../src/providers/codex/host-extensions-controller';

describe('CodexHostExtensionsController', () => {
  it('validates and exposes normalized dynamic tool definitions', () => {
    expect(() => controller([tool('  ')]))
      .toThrow('Dynamic tool names cannot be empty');
    expect(() => new CodexHostExtensionsController([{
      dynamicTools: [tool('duplicate'), tool(' duplicate ')],
    }], [], () => undefined)).toThrow("Duplicate dynamic tool 'duplicate'");

    const subject = controller([tool(' inspect ', true)]);
    expect(subject.hasDynamicTools()).toBe(true);
    expect(subject.dynamicToolSpecs()).toStrictEqual([{
      type: 'function', name: 'inspect', description: 'Inspect', inputSchema: { type: 'object' }, deferLoading: true,
    }]);
    expect(controller([]).hasDynamicTools()).toBe(false);
    expect(controller([tool('plain')]).dynamicToolSpecs()).toStrictEqual([{
      type: 'function', name: 'plain', description: 'Inspect', inputSchema: { type: 'object' },
    }]);
  });

  it('merges extension and per-conversation instructions in declaration order', async () => {
    const subject = new CodexHostExtensionsController([{
      configureConversation: vi.fn(async () => ({
        baseInstructions: 'extension base',
        config: { extension: true },
        developerInstructions: ' extension developer ',
      })),
    }], [], () => undefined);

    await expect(subject.conversationExtension({ operation: 'start', conversationId: null }, {
      baseInstructions: 'conversation base',
      config: { conversation: true },
      developerInstructions: ' conversation developer ',
    })).resolves.toStrictEqual({
      baseInstructions: 'conversation base',
      config: { extension: true, conversation: true },
      developerInstructions: 'extension developer\n\nconversation developer',
    });
  });

  it('preserves defined extension output across empty and non-configuring extensions', async () => {
    const subject = new CodexHostExtensionsController([{}, {
      configureConversation: vi.fn(async () => ({
        baseInstructions: 'extension base',
        developerInstructions: ' first ',
      })),
    }, {
      configureConversation: vi.fn(async () => ({})),
    }, {
      configureConversation: vi.fn(async () => ({ developerInstructions: '   ' })),
    }], [{ name: 'local', transport: { type: 'stdio', command: 'server' } }], () => undefined);

    await expect(subject.conversationExtension({ operation: 'start', conversationId: null }, {
      developerInstructions: '   ',
    })).resolves.toStrictEqual({
      baseInstructions: 'extension base',
      config: { 'mcp_servers.local': { command: 'server' } },
      developerInstructions: 'first',
    });
  });

  it('omits every absent extension field', async () => {
    const subject = new CodexHostExtensionsController([{
      configureConversation: vi.fn(async () => ({})),
    }], [], () => undefined);

    await expect(subject.conversationExtension({ operation: 'resume', conversationId: 'thread-1' }))
      .resolves.toStrictEqual({});
  });

  it('rejects extension config that collides with a typed MCP server', async () => {
    const subject = new CodexHostExtensionsController([{
      configureConversation: vi.fn(async () => ({
        config: { 'mcp_servers.local.enabled': true },
      })),
    }], [{ name: 'local', transport: { type: 'stdio', command: 'server' } }], () => undefined);

    await expect(subject.conversationExtension({ operation: 'start', conversationId: null }))
      .rejects.toThrow("Raw config for Codex MCP server 'local' conflicts with its typed definition");
  });

  it('handles unknown, successful, image, and failed dynamic tool calls', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce('done')
      .mockResolvedValueOnce({ content: [{ type: 'image', imageUrl: 'data:image/png;base64,AA==' }], success: false })
      .mockRejectedValueOnce(new Error('tool failed'));
    const subject = controller([{ ...tool('inspect'), execute }], { extensionContext: { source: 'host' } });
    const responder = { resolve: vi.fn(), reject: vi.fn() };

    await subject.handleDynamicToolCall(request({ namespace: 'remote' }), responder as never);
    expect(responder.reject).toHaveBeenLastCalledWith({
      code: -32601,
      message: "Dynamic tool namespace 'remote' is not configured",
    });
    await subject.handleDynamicToolCall(request({ tool: 'missing' }), responder as never);
    expect(responder.reject).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining('Unknown') }));

    await subject.handleDynamicToolCall(request(), responder as never);
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ extensionContext: { source: 'host' } }));
    expect(responder.resolve).toHaveBeenLastCalledWith({
      success: true, contentItems: [{ type: 'inputText', text: 'done' }],
    });
    await subject.handleDynamicToolCall(request(), responder as never);
    expect(responder.resolve).toHaveBeenLastCalledWith({
      success: false, contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,AA==' }],
    });
    await subject.handleDynamicToolCall(request(), responder as never);
    expect(responder.resolve).toHaveBeenLastCalledWith({
      success: false, contentItems: [{ type: 'inputText', text: 'tool failed' }],
    });
  });

  it('defaults object tool results to success and tolerates absent host options', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'done' }],
    }));
    const subject = new CodexHostExtensionsController([{
      dynamicTools: [{ ...tool('inspect'), execute }],
    }], [], () => undefined);
    const responder = { resolve: vi.fn(), reject: vi.fn() };

    await subject.handleDynamicToolCall(request(), responder as never);

    expect(execute).toHaveBeenCalledWith({
      callId: 'call-1',
      conversationId: 'thread-1',
      turnId: 'turn-1',
      arguments: { value: 1 },
      extensionContext: undefined,
    });
    expect(responder.resolve).toHaveBeenCalledWith({
      success: true,
      contentItems: [{ type: 'inputText', text: 'done' }],
    });
    expect(responder.reject).not.toHaveBeenCalled();
  });
});

function controller(dynamicTools: ReturnType<typeof tool>[], hostOptions?: { extensionContext: unknown }) {
  return new CodexHostExtensionsController([{ dynamicTools }], [], () => hostOptions);
}

function tool(name: string, deferLoading?: boolean) {
  return {
    name, description: 'Inspect', inputSchema: { type: 'object' }, deferLoading,
    execute: vi.fn(async () => 'done'),
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-1', method: 'item/tool/call',
    params: {
      threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1',
      namespace: null, tool: 'inspect', arguments: { value: 1 }, ...overrides,
    },
  } as never;
}
