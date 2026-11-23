import { randomUUID } from 'node:crypto';
import type { Message, MessagePart, SubagentOperation, ToolPart } from '../../contracts/index';
import type { AntigravityConversationEvent } from '../../contracts/antigravity-conversation';
import { createAntigravityConversationReplica, emptyAntigravitySnapshot } from '../../conversations/antigravity-conversation-replica';
import { record } from '../../acp/acp-connection';
import type { HarnessOptions } from '../../options';
import { directMcpToolName, mcpToolIdentity } from './mcp-tool';
import { projectNativeToolStatus } from './tool-status';

type Change = AntigravityConversationEvent extends infer Event ? Event extends AntigravityConversationEvent ? Omit<Event, 'agentId' | 'sessionId' | 'turnId' | 'occurredAt'> : never : never;

/** Projects only ACP updates; every load builds a fresh replica with its replay IDs. */
export class AcpTranscript {
  readonly replica;
  private message?: Message;
  private turnId = '';
  private replaying = false;
  private replayTurn = 0;
  private replayMessage = 0;

  constructor(readonly agentId: string, readonly sessionId: string, private readonly changed: (event: AntigravityConversationEvent) => void,
    private readonly displayUser: (text: string) => { text: string; parts: MessagePart[]; metadata?: Message['metadata'] } = text => ({ text, parts: [] }),
    private readonly presentToolCall?: HarnessOptions['presentToolCall'],
    private readonly registeredServers: readonly string[] = []) {
    this.replica = createAntigravityConversationReplica(emptyAntigravitySnapshot(agentId, sessionId));
  }

  event(change: Change): AntigravityConversationEvent {
    const event = { ...change, agentId: this.agentId, sessionId: this.sessionId, turnId: this.turnId, occurredAt: this.replaying ? '' : new Date().toISOString() } as AntigravityConversationEvent;
    this.replica.apply(event); this.changed(event);
    return event;
  }

  start(text?: string, parts: MessagePart[] = [], metadata?: Message['metadata']): string {
    if (text !== undefined) this.replaying = false;
    // ACP history has no turn IDs. Scope local display IDs to the same replay prefix across reads.
    this.turnId = this.replaying ? `${this.sessionId}:replay:${++this.replayTurn}` : randomUUID();
    this.replayMessage = 0;
    this.message = undefined;
    this.event({ type: 'turn.started', payload: { turn: { id: this.turnId } } });
    if (text !== undefined) { this.text('user', text); this.attach(parts, metadata); }
    return this.turnId;
  }

  finish(status: 'completed' | 'interrupted' | 'failed', error?: string): void {
    if (!this.replica.getSnapshot().busy) return;
    this.event({ type: 'turn.completed', payload: { turn: { id: this.turnId, status }, ...(error ? { error } : {}) } });
    this.message = undefined;
  }

  update(update: Record<string, unknown>, replay: boolean): SubagentOperation | undefined {
    this.replaying = replay;
    if (!replay && !this.replica.getSnapshot().busy && update.sessionUpdate !== 'usage_update') return;
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        if (!replay) return; // The admitted prompt is already visible locally.
        if (this.message?.role !== 'user') { this.finish('completed'); this.start(); }
        if (record(update.content) && update.content.type === 'text' && typeof update.content.text === 'string') {
          const display = this.displayUser(update.content.text);
          this.text('user', display.text); this.attach(display.parts, display.metadata);
        }
        return;
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        if (!this.replica.getSnapshot().busy && replay) this.start();
        // The CLI streams its thinking as running prose, not as a summary of the work, so it stays out of the transcript.
        if (update.sessionUpdate === 'agent_message_chunk' && record(update.content) && typeof update.content.text === 'string') this.text('assistant', update.content.text);
        return;
      case 'tool_call':
      case 'tool_call_update':
        if (replay && !this.replica.getSnapshot().busy) this.start();
        return this.tool(update);
      case 'usage_update':
        if (typeof update.used === 'number' && typeof update.size === 'number') this.event({ type: 'context.updated', payload: { usage: {
          totalTokens: update.used, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
          lastTotalTokens: update.used, modelContextWindow: update.size, usedPercent: update.size > 0 ? update.used / update.size * 100 : null,
        } } });
    }
  }

  private text(role: 'user' | 'assistant', text: string): void {
    const message = this.current(role);
    const last = message.parts.at(-1);
    if (last?.type === 'text') last.text += text;
    else message.parts.push({ type: 'text', text });
    this.event({ type: 'message.upsert', payload: { message } });
  }

  private attach(parts: MessagePart[], metadata?: Message['metadata']): void {
    if (!parts.length && !metadata) return;
    const message = this.current('user'); message.parts.push(...parts);
    if (metadata) message.metadata = metadata;
    this.event({ type: 'message.upsert', payload: { message } });
  }

  private tool(update: Record<string, unknown>): SubagentOperation | undefined {
    if (typeof update.toolCallId !== 'string') throw new Error('Invalid Antigravity tool identity.');
    const existingMessage = this.replica.getSnapshot().messages.find(message => message.parts.some(part => part.type === 'tool' && part.id === update.toolCallId));
    const message = existingMessage ? structuredClone(existingMessage) : this.current('assistant');
    const previous = message.parts.find((part): part is ToolPart => part.type === 'tool' && part.id === update.toolCallId);
    const wasDelegation = previous?.kind === 'subagent';
    const previousStatus = previous?.status;
    const delegation = update.name === 'invoke_subagent' || (update.name == null && wasDelegation);
    const part: ToolPart = previous ?? { type: 'tool', id: update.toolCallId, kind: 'tool', title: 'Antigravity tool', status: 'running' };
    if (typeof update.title === 'string') part.title = update.title;
    if (typeof update.kind === 'string') part.kind = update.kind === 'execute' ? 'command' : update.kind;
    if (!delegation && wasDelegation && part.kind === 'subagent') part.kind = 'tool';
    if (typeof update.status === 'string') part.status = update.status === 'failed' ? 'failed' : update.status === 'completed' ? 'completed' : 'running';
    if (update.rawInput != null) part.input = update.rawInput;
    if (update.rawOutput != null) { part.output = update.rawOutput; part.body = typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput); }
    if (Array.isArray(update.content)) {
      const text = update.content.map(item => record(item) && item.type === 'content' && record(item.content) && typeof item.content.text === 'string' ? item.content.text : '').filter(Boolean).join('\n');
      if (text) part.body = text;
    }
    this.presentTool(part, update, delegation);
    if (!previous) message.parts.push(part);
    if (this.message?.id === message.id) this.message = message;
    const event = this.event({ type: 'message.upsert', payload: { message } });
    if (this.replaying || !delegation || part.kind !== 'subagent' || (wasDelegation && previousStatus === part.status)) return;
    const { status } = part;
    const running = status === 'running';
    return { id: part.id, turnId: message.turnId, kind: 'spawnAgent', lifecycle: running ? 'started' : 'completed',
      status: running ? 'inProgress' : status, senderConversationId: this.sessionId, receiverConversationIds: [], occurredAt: event.occurredAt };
  }

  private presentTool(part: ToolPart, update: Record<string, unknown>, delegation: boolean): void {
    const metadata = part.metadata ??= {};
    const mcp = mcpToolIdentity(update, this.registeredServers);
    if (mcp) {
      metadata.server = mcp.server;
      metadata.tool = mcp.tool;
    }
    delete metadata.displayTitle;
    delete part.statusText;
    if (typeof metadata.server === 'string' && typeof metadata.tool === 'string') {
      part.kind = 'mcp';
      part.title = `${metadata.server}.${metadata.tool}`;
      let input = part.input;
      if (record(input)) {
        if ('arguments' in input) input = input.arguments;
        else if (input.ServerName === metadata.server && input.ToolName === metadata.tool && 'Arguments' in input) input = input.Arguments;
      }
      const result = part.output ?? part.body;
      const title = this.presentToolCall?.({ server: metadata.server, tool: metadata.tool, input,
        ...(result === undefined ? {} : { result }), state: part.status });
      if (title) metadata.displayTitle = title;
      return;
    }
    const priorMcpName = metadata.unresolvedMcpName;
    const unresolvedMcpName = directMcpToolName(update) ?? (typeof priorMcpName === 'string' ? directMcpToolName({
      ...update, kind: update.kind ?? 'other', title: update.title ?? `Run ${priorMcpName}`, name: update.name ?? priorMcpName,
    }) : undefined);
    if (typeof unresolvedMcpName === 'string') {
      metadata.unresolvedMcpName = unresolvedMcpName;
      part.kind = 'mcp';
      part.title = unresolvedMcpName.slice('mcp_'.length);
      part.statusText = JSON.stringify({ source: 'antigravity', action: 'mcp', phase: part.status });
      return;
    }
    delete metadata.unresolvedMcpName;
    if (delegation) {
      part.kind = 'subagent';
      const role = record(part.input) && typeof part.input.Role === 'string' ? part.input.Role.trim().replace(/\s+/gu, ' ') : '';
      const target = role.length > 80 ? `${role.slice(0, 79).trimEnd()}…` : role || 'a subagent';
      const action = part.status === 'running' ? 'Delegating to' : part.status === 'completed' ? 'Delegated to' : 'Could not delegate to';
      metadata.displayTitle = `${action} ${target}`;
      return;
    }
    const status = projectNativeToolStatus(part, update);
    if (status) part.statusText = status;
    else metadata.displayTitle = part.title;
  }

  private current(role: 'user' | 'assistant'): Message {
    if (this.message?.role !== role) this.message = { id: this.replaying ? `${this.turnId}:message:${++this.replayMessage}` : randomUUID(), agentId: this.agentId, role,
      status: role === 'user' ? 'complete' : 'streaming', turnId: this.turnId, parts: [], createdAt: this.replaying ? '' : new Date().toISOString() };
    return this.message;
  }
}
