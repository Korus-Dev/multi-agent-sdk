import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '../../../codex-sdk/src/protocol';
import { CodexSurface } from '../../src/providers/codex';
import {
  MockCodexAppServer,
  resumeResponse,
  thread,
  turn,
} from './helpers/codex-surface-fixture';

describe('CodexSurface ephemeral generation', () => {
  it('connects on demand and rejects active generation when the app-server disconnects', async () => {
    const transport = new MockCodexAppServer({
      'thread/start': () => resumeResponse({
        ...thread('thread-disconnected', false),
        ephemeral: true,
      }),
      'turn/start': () => ({ turn: turn('turn-disconnected', 'inProgress', []) }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });

    const result = surface.generateText('Generate until disconnected');
    await vi.waitFor(() => expect(transport.sent.some((message) => (
      'method' in message && message.method === 'turn/start'
    ))).toBe(true));
    expect(transport.start).toHaveBeenCalledOnce();
    expect(transport.sent).toContainEqual(expect.objectContaining({ method: 'initialize' }));

    transport.fail(new Error('generation transport lost'));

    await expect(result).rejects.toThrow('generation transport lost');
    await surface.close();
  });

  it.each([{ tools: undefined, images: false }, { tools: 'none', images: true }, { tools: 'read-only', images: true }] as const)('returns isolated structured text with policy=%j and the complete RPC input', async ({ tools, images }) => {
    const transport = new MockCodexAppServer({
      'thread/start': () => resumeResponse({
        ...thread('thread-ephemeral', false),
        ephemeral: true,
      }),
      'turn/start': () => ({ turn: turn('turn-ephemeral', 'inProgress', []) }),
      'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    });
    const surface = new CodexSurface({
      client: new CodexAppServerClient(transport),
      cwd: '/tmp/project',
    });
    await surface.connect();
    await vi.waitFor(() => expect(surface.getSnapshot().pluginCatalogStatus).toBe('loaded'));
    const before = surface.getSnapshot();
    const events: unknown[] = [];
    surface.onEvent((event) => events.push(event));

    const resultPromise = surface.generateText('Write a commit message', {
      ...(tools === undefined ? {} : { tools }),
      ...(images ? {mcpServers:[{name:'icons_job',transport:{type:'http' as const,url:'http://127.0.0.1:1234/icons/token'},enabledTools:['fetch_tech_icon'],toolApprovalMode:'auto' as const}]} : {}),
      ...(images ? { attachments: [
        { type: 'image' as const, path: '/tmp/reference image.png ', detail: 'high' as const },
        { type: 'image' as const, path: '/tmp/other.png' },
      ] } : {}),
      developerInstructions: 'Return JSON only.',
      model: 'gpt-mini',
      reasoningEffort: 'high',
      outputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
        additionalProperties: false,
      },
    });

    await vi.waitFor(() => expect(transport.sent.some((message) => (
      'method' in message && message.method === 'turn/start'
    ))).toBe(true));
    transport.emitNotification('thread/started', {
        thread: { ...thread('thread-ephemeral', false), ephemeral: true },
      });
    transport.emitNotification('item/completed', {
        threadId: 'thread-ephemeral',
        turnId: 'turn-ephemeral',
        completedAtMs: 2,
        item: { delivery: null, questions: null,
          type: 'agentMessage',
          id: 'result',
          text: '{"message":"fix: keep state isolated"}',
          phase: 'final_answer',
          memoryCitation: null,
        },
      });
    transport.emitNotification('turn/completed', {
        threadId: 'thread-ephemeral',
        turn: turn('turn-ephemeral', 'completed', []),
      });

    await expect(resultPromise).resolves.toEqual({
      text: '{"message":"fix: keep state isolated"}',
    });
    expect(transport.sent.find((message) => (
      'method' in message && message.method === 'thread/start'
    ))).toStrictEqual({
      id: expect.any(Number), method: 'thread/start',
      params: {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        cwd: '/tmp/project',
        developerInstructions: 'Return JSON only.',
        dynamicTools: [],
        ...(images ? {config:{'mcp_servers.icons_job':{url:'http://127.0.0.1:1234/icons/token',enabled_tools:['fetch_tech_icon'],default_tools_approval_mode:'auto'}}} : {}),
        ...(tools === 'read-only' ? {} : { environments: [] }),
        ephemeral: true,
        model: 'gpt-mini-runtime',
        permissions: ':read-only',
        serviceName: 'codex_app_sdk',
        serviceTier: null,
        threadSource: 'sdk_ephemeral_generation',
      },
    });
    expect(transport.sent.find((message) => (
      'method' in message && message.method === 'turn/start'
    ))).toStrictEqual({
      id: expect.any(Number), method: 'turn/start',
      params: {
        threadId: 'thread-ephemeral',
        effort: 'high',
        ...(tools === 'read-only' ? {} : { environments: [] }),
        input: [
          { type: 'text', text: 'Write a commit message', text_elements: [] },
          ...(images ? [
            { type: 'localImage', path: '/tmp/reference image.png', detail: 'high' },
            { type: 'localImage', path: '/tmp/other.png' },
          ] : []),
        ],
        model: 'gpt-mini-runtime',
        outputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
          additionalProperties: false,
        },
        permissions: ':read-only',
        serviceTier: null,
      },
    });
    expect(transport.sent).toContainEqual({
      id: expect.any(Number),
      method: 'thread/unsubscribe',
      params: { threadId: 'thread-ephemeral' },
    });
    expect(surface.getSnapshot()).toEqual(before);
    expect(events).toEqual([]);
  });

  it('interrupts and unsubscribes when generation is aborted', async () => {
    const transport = new MockCodexAppServer({
      'thread/start': () => resumeResponse({
        ...thread('thread-aborted', false),
        ephemeral: true,
      }),
      'turn/start': () => ({ turn: turn('turn-aborted', 'inProgress', []) }),
      'turn/interrupt': () => ({}),
      'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();
    const abort = new AbortController();

    const resultPromise = surface.generateText('Generate', { signal: abort.signal, timeoutMs: null });
    await vi.waitFor(() => expect(transport.sent.some((message) => (
      'method' in message && message.method === 'turn/start'
    ))).toBe(true));
    abort.abort();

    await expect(resultPromise).rejects.toThrow('aborted');
    expect(transport.sent).toContainEqual({
      id: expect.any(Number),
      method: 'turn/interrupt',
      params: { threadId: 'thread-aborted', turnId: 'turn-aborted' },
    });
    expect(transport.sent).toContainEqual({
      id: expect.any(Number),
      method: 'thread/unsubscribe',
      params: { threadId: 'thread-aborted' },
    });
  });

  it('rejects an active generation when the owning surface closes', async () => {
    const transport = new MockCodexAppServer({
      'thread/start': () => resumeResponse({
        ...thread('thread-closing', false),
        ephemeral: true,
      }),
      'turn/start': () => ({ turn: turn('turn-closing', 'inProgress', []) }),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();
    const result = surface.generateText('Generate until closed');
    await vi.waitFor(() => expect(transport.sent.some((message) => (
      'method' in message && message.method === 'turn/start'
    ))).toBe(true));

    await surface.close();

    await expect(result).rejects.toThrow();
  });

  it('deletes and rejects a thread when app-server does not honor ephemeral creation', async () => {
    const transport = new MockCodexAppServer({
      'thread/start': () => resumeResponse({
        ...thread('thread-persisted', false),
        ephemeral: false,
      }),
      'thread/delete': () => ({}),
    });
    const surface = new CodexSurface({ client: new CodexAppServerClient(transport) });
    await surface.connect();

    await expect(surface.generateText('Generate')).rejects.toThrow('did not create an ephemeral');
    expect(transport.sent).toContainEqual({
      id: expect.any(Number),
      method: 'thread/delete',
      params: { threadId: 'thread-persisted' },
    });
    expect(transport.sent.some((message) => (
      'method' in message && message.method === 'turn/start'
    ))).toBe(false);
  });
});

it('rejects invalid per-call MCP definitions before connecting', async () => {
 const transport=new MockCodexAppServer();const surface=new CodexSurface({client:new CodexAppServerClient(transport)});
 try {await expect(surface.generateText('Inspect',{mcpServers:[{name:'bad server',transport:{type:'http',url:'file:///private'}}]})).rejects.toThrow(/MCP/);expect(transport.start).not.toHaveBeenCalled();}finally{await surface.close();}
});

it('keeps per-call MCP servers out of later utility calls', async () => {
 const transport=new MockCodexAppServer({
  'thread/start':()=>resumeResponse({...thread('isolated',false),ephemeral:true}),
  'turn/start':()=>({turn:turn('done','completed',[{type:'agentMessage',id:'answer',text:'ok',phase:'final_answer',memoryCitation:null,delivery:null,questions:null}])}),
  'thread/unsubscribe':()=>({status:'unsubscribed'}),
 });
 const surface=new CodexSurface({client:new CodexAppServerClient(transport)});
 try {
  await surface.generateText('first',{mcpServers:[{name:'icons',transport:{type:'http',url:'http://127.0.0.1:1234/job'},enabledTools:['fetch_tech_icon']}]});
  await surface.generateText('second');
  const starts=transport.sent.filter(message=>'method' in message&&message.method==='thread/start');
  expect(starts[0]).toMatchObject({params:{config:{'mcp_servers.icons':{url:'http://127.0.0.1:1234/job',enabled_tools:['fetch_tech_icon']}}}});
  expect(starts[1]).not.toHaveProperty('params.config');
 } finally {await surface.close();}
});
