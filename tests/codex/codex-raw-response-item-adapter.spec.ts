import { describe, expect, it } from 'vitest';
import type { ResponseItem } from '@korus-dev/codex-sdk/protocol/generated/ResponseItem';
import { rawResponseItemToEvent } from '../../src/providers/codex/codex-raw-response-item-adapter';

const adapt = (item: unknown) => rawResponseItemToEvent(item as ResponseItem);

describe('rawResponseItemToEvent', () => {
  it('ignores unsupported and malformed response items', () => {
    expect(adapt(null)).toBeNull();
    expect(adapt({})).toBeNull();
    expect(adapt({ type: 'message', role: 'assistant', content: [] })).toBeNull();
  });

  it('maps function and custom tool calls plus their outputs', () => {
    expect(adapt({
      type: 'function_call', call_id: 'function-shell', name: 'shell_command',
      arguments: '{"command":"pwd","workdir":"/tmp"}',
    })).toMatchObject({
      type: 'item.started',
      payload: { toolPart: { id: 'function-shell', kind: 'command', title: 'pwd', status: 'running' } },
    });
    expect(adapt({
      type: 'function_call', call_id: 'function-1', namespace: 'files', name: 'read_file', arguments: 'not json',
    })).toMatchObject({
      type: 'item.started',
      payload: { toolPart: { id: 'function-1', kind: 'dynamic', title: 'files.read_file', input: 'not json' } },
    });
    expect(adapt({
      type: 'custom_tool_call', call_id: 'custom-1', name: 'render', input: 'image', status: 'completed',
    })).toMatchObject({
      type: 'item.started', payload: { toolPart: { id: 'custom-1', title: 'render', status: 'completed' } },
    });
    expect(adapt({ type: 'function_call_output', call_id: 'function-1', output: { result: 'done' } })).toMatchObject({
      type: 'item.updated', payload: { itemId: 'function-1', status: 'completed', output: { result: 'done' } },
    });
    expect(adapt({
      type: 'custom_tool_call_output', call_id: 'custom-1', name: 'render', output: [{ type: 'input_text', text: 'done' }],
    })).toMatchObject({
      type: 'item.updated', payload: { itemId: 'custom-1', title: 'render', status: 'completed' },
    });
  });

  it('bounds large raw tool output events before they enter surface state', () => {
    const event = adapt({
      type: 'custom_tool_call_output', call_id: 'large-output', name: 'render',
      output: {
        content: [{ type: 'image', data: 'A'.repeat(2 * 1024 * 1024), mimeType: 'image/png' }],
      },
    });

    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(64 * 1024);
    expect(event).toMatchObject({
      type: 'item.updated',
      payload: { itemId: 'large-output', title: 'render', status: 'completed', body: undefined },
    });
    expect(event?.payload).not.toHaveProperty('output');
  });

  it('maps tool search calls and outputs', () => {
    expect(adapt({
      type: 'tool_search_call', call_id: 'search-call', status: 'inProgress', execution: 'server',
      arguments: { query: 'calendar' },
    })).toMatchObject({
      type: 'item.started',
      payload: { toolPart: { id: 'search-call', title: 'codex.tool_search', status: 'running' } },
    });
    expect(adapt({
      type: 'tool_search_output', call_id: null, status: 'failed', execution: 'server', tools: [{ name: 'calendar' }],
    })).toMatchObject({
      type: 'item.updated', payload: { itemId: 'raw-tool_search_output', status: 'failed' },
    });
  });

  it('maps web search and image generation variants', () => {
    expect(adapt({ type: 'web_search_call', id: 'web-1', action: { type: 'search', query: 'Codex SDK' } })).toMatchObject({
      type: 'item.completed', payload: { toolPart: { id: 'web-1', title: 'Web search', body: 'Codex SDK' } },
    });
    expect(adapt({ type: 'web_search_call', action: { searchTerm: 'app-server' } })).toMatchObject({
      payload: { toolPart: { id: 'raw-web_search_call', body: 'app-server' } },
    });
    expect(adapt({ type: 'web_search_call', action: null })).toMatchObject({
      payload: { toolPart: { body: 'web search' } },
    });
    const imageEvent = adapt({
      type: 'image_generation_call', id: 'image-1', status: 'completed', revised_prompt: 'A polished UI', result: 'png-data',
    });
    expect(imageEvent).toMatchObject({
      type: 'item.completed',
      payload: {
        toolPart: {
          id: 'image-1', title: 'image_generation', status: 'completed', body: undefined,
          input: { revisedPrompt: 'A polished UI' },
          metadata: { namespace: null, tool: 'image_generation', success: true, durationMs: null },
        },
      },
    });
    expect(JSON.stringify(imageEvent)).not.toContain('png-data');
    expect(adapt({
      type: 'image_generation_call', status: 'failed', result: '', revised_prompt: null,
    })).toMatchObject({
      payload: { toolPart: {
        id: 'raw-image_generation_call', status: 'failed', input: { revisedPrompt: null },
        metadata: { namespace: null, tool: 'image_generation', success: false, durationMs: null },
      } },
    });
  });

  it.each([
    ['completed', 'item.completed', 'completed'],
    ['failed', 'item.completed', 'failed'],
    ['error', 'item.completed', 'failed'],
    ['incomplete', 'item.completed', 'failed'],
    ['in_progress', 'item.started', 'running'],
  ] as const)('maps exact local-shell status %s', (status, eventType, toolStatus) => {
    expect(adapt({
      type: 'local_shell_call', call_id: '', id: 'shell-fallback', status,
      action: { command: ['printf', 'two words', 0, false], working_directory: '/workspace' },
    })).toMatchObject({
      type: eventType,
      payload: {
        toolPart: {
          id: 'shell-fallback',
          kind: 'command',
          title: 'printf "two words" 0 false',
          status: toolStatus,
          input: {
            command: 'printf "two words" 0 false',
            cwd: '/workspace',
            commandActions: [],
          },
          metadata: { source: 'agent', processId: null },
        },
      },
    });
  });

  it('maps exact local-shell fallbacks when the action is malformed', () => {
    expect(adapt({
      type: 'local_shell_call', call_id: 'shell-1', status: 'completed',
      action: { command: ['npm', 'run test'], working_directory: '/tmp/project' },
    })).toMatchObject({
      type: 'item.completed',
      payload: { toolPart: { id: 'shell-1', title: 'npm "run test"', status: 'completed' } },
    });
    expect(adapt({ type: 'local_shell_call', action: null })).toMatchObject({
      type: 'item.started',
      payload: {
        toolPart: {
          id: 'raw-local_shell_call', title: 'local shell', status: 'running',
          input: { command: 'local shell', cwd: '', commandActions: [] },
          metadata: { source: 'agent', processId: null },
        },
      },
    });
  });

  it('maps function-call object arguments, shell cwd precedence, and generic defaults', () => {
    expect(adapt({
      type: 'function_call', call_id: null, id: 'ignored-id', name: 'shell_command',
      arguments: { command: 'pwd', workdir: '/preferred', cwd: '/fallback' },
    })).toMatchObject({
      type: 'item.started',
      payload: {
        toolPart: {
          id: 'ignored-id', kind: 'command', title: 'pwd', status: 'running',
          input: { command: 'pwd', cwd: '/preferred', commandActions: [] },
          metadata: { source: 'agent', processId: null },
        },
      },
    });
    expect(adapt({
      type: 'function_call', call_id: '', name: null, arguments: { value: 1 },
    })).toMatchObject({
      type: 'item.started',
      payload: {
        toolPart: {
          id: 'raw-function_call', kind: 'dynamic', title: 'function_call', status: 'running',
          input: { value: 1 },
          metadata: { namespace: null, tool: 'function_call', success: null, durationMs: null },
        },
      },
    });
    expect(adapt({
      type: 'function_call', call_id: 'cwd-fallback', name: 'shell_command',
      arguments: { command: null, workdir: '', cwd: '/cwd' },
    })).toMatchObject({
      payload: { toolPart: { title: 'shell_command', input: { cwd: '/cwd' } } },
    });
    expect(adapt({
      type: 'function_call', call_id: 'cwd-empty', name: 'shell_command',
      arguments: { command: 'pwd' },
    })).toMatchObject({
      payload: { toolPart: { input: { cwd: '' } } },
    });
  });

  it('maps custom and tool-search defaults without losing raw inputs or output titles', () => {
    expect(adapt({
      type: 'custom_tool_call', call_id: null, id: 'custom-id', name: null, input: null,
    })).toMatchObject({
      type: 'item.started',
      payload: {
        toolPart: {
          id: 'custom-id', title: 'custom_tool', status: 'running', input: '',
          metadata: { namespace: null, tool: 'custom_tool', success: null, durationMs: null },
        },
      },
    });
    expect(adapt({
      type: 'tool_search_call', call_id: null, id: 'search-id', arguments: 42,
    })).toMatchObject({
      type: 'item.started',
      payload: {
        toolPart: {
          id: 'search-id', title: 'codex.tool_search', status: 'running', input: 42,
          metadata: { namespace: 'codex', tool: 'tool_search', success: null, durationMs: null },
        },
      },
    });
    expect(adapt({
      type: 'tool_search_call', call_id: 'completed-search', status: 'completed', arguments: {},
    })).toMatchObject({
      type: 'item.started',
      payload: { toolPart: { id: 'completed-search', status: 'completed' } },
    });
    expect(adapt({
      type: 'tool_search_output', call_id: 'search-id', status: 'completed', tools: [],
    })).toMatchObject({
      type: 'item.updated',
      payload: {
        itemId: 'search-id', title: 'tool_search', status: 'completed', output: [],
        fallbackToolPart: { id: 'search-id', title: 'tool_search', status: 'completed' },
      },
    });
    expect(adapt({
      type: 'custom_tool_call_output', call_id: null, name: '', output: 'done',
    })).toMatchObject({
      type: 'item.updated',
      payload: { itemId: 'raw-response-output', title: undefined, status: 'completed', output: 'done' },
    });
  });

});
