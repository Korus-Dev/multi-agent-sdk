import { randomUUID } from 'node:crypto';
import type { Message, MessagePart, ToolPart } from '../../contracts/index';
import type { AntigravityConversationEvent } from '../../contracts/antigravity-conversation';
import { createAntigravityConversationReplica, emptyAntigravitySnapshot } from '../../conversations/antigravity-conversation-replica';
import { record } from '../../acp/acp-connection';

type Change = AntigravityConversationEvent extends infer Event ? Event extends AntigravityConversationEvent ? Omit<Event, 'agentId' | 'sessionId' | 'turnId' | 'occurredAt'> : never : never;

/** Projects only ACP updates; every load builds a fresh replica with its replay IDs. */
export class AcpTranscript {
  readonly replica;
  private message?: Message;
  private turnId = '';
  private replaying = false;

  constructor(readonly agentId: string, readonly sessionId: string, private readonly changed: (event: AntigravityConversationEvent) => void,
    private readonly displayUser: (text: string) => { text: string; parts: MessagePart[]; metadata?: Message['metadata'] } = text => ({ text, parts: [] }),
    rules: import('../../conversations/work-phases').WorkPhaseRules = {}) {
    this.replica = createAntigravityConversationReplica(emptyAntigravitySnapshot(agentId, sessionId), rules);
  }

  event(change: Change): void {
    const event = { ...change, agentId: this.agentId, sessionId: this.sessionId, turnId: this.turnId, occurredAt: this.replaying ? '' : new Date().toISOString() } as AntigravityConversationEvent;
    this.replica.apply(event); this.changed(event);
  }

  start(text?: string, parts: MessagePart[] = [], metadata?: Message['metadata']): string {
    if (text !== undefined) this.replaying = false;
    this.turnId = randomUUID(); this.message = undefined;
    this.event({ type: 'turn.started', payload: { turn: { id: this.turnId } } });
    if (text !== undefined) { this.text('user', text); this.attach(parts, metadata); }
    return this.turnId;
  }

  finish(status: 'completed' | 'interrupted' | 'failed', error?: string): void {
    if (!this.replica.getSnapshot().busy) return;
    this.event({ type: 'turn.completed', payload: { turn: { id: this.turnId, status }, ...(error ? { error } : {}) } });
    this.message = undefined;
  }

  update(update: Record<string, unknown>, replay: boolean): void {
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
      case 'tool_call_update': this.tool(update); return;
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

  private tool(update: Record<string, unknown>): void {
    if (typeof update.toolCallId !== 'string') throw new Error('Invalid Antigravity tool identity.');
    const existingMessage = this.replica.getSnapshot().messages.find(message => message.parts.some(part => part.type === 'tool' && part.id === update.toolCallId));
    const message = existingMessage ? structuredClone(existingMessage) : this.current('assistant');
    const previous = message.parts.find((part): part is ToolPart => part.type === 'tool' && part.id === update.toolCallId);
    const part: ToolPart = previous ?? { type: 'tool', id: update.toolCallId, kind: 'tool', title: 'Antigravity tool', status: 'running' };
    if (typeof update.title === 'string') part.title = update.title;
    if (typeof update.kind === 'string') part.kind = update.kind;
    if (typeof update.status === 'string') part.status = update.status === 'failed' ? 'failed' : update.status === 'completed' ? 'completed' : 'running';
    if ('rawInput' in update) part.input = update.rawInput;
    if ('rawOutput' in update) { part.output = update.rawOutput; part.body = typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput); }
    if (Array.isArray(update.content)) {
      const text = update.content.map(item => record(item) && item.type === 'content' && record(item.content) && typeof item.content.text === 'string' ? item.content.text : '').filter(Boolean).join('\n');
      if (text) part.body = text;
    }
    if (!previous) message.parts.push(part);
    if (this.message?.id === message.id) this.message = message;
    this.event({ type: 'message.upsert', payload: { message } });
  }

  private current(role: 'user' | 'assistant'): Message {
    if (this.message?.role !== role) this.message = { id: randomUUID(), agentId: this.agentId, role,
      status: role === 'user' ? 'complete' : 'streaming', turnId: this.turnId, parts: [], createdAt: this.replaying ? '' : new Date().toISOString() };
    return this.message;
  }
}
