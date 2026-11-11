import { expect, it } from 'vitest';
import { createProviderHost } from '../../../src/harnesses';

// A harness that asks questions or approvals reports what the person is asked for, then returns to work once answered.
it('reports Antigravity waiting on an approval or an answer, then working once nothing is pending', async () => {
  const host = createProviderHost('antigravity', { client: { name: 'test' } });
  const statuses: unknown[] = [];
  host.onEvent(event => { if (event.type === 'agent.statusChanged') statuses.push(event.payload); });
  const event = (type: string, payload: unknown) => (host as unknown as { conversationEvent(event: unknown): void })
    .conversationEvent({ type, agentId: 'agent', sessionId: 'session', turnId: 'turn', occurredAt: '', payload });
  event('request.created', { request: { id: 'r1', kind: 'confirm_tool', payload: { confirmation: { integrationId: 'antigravity', integrationName: 'antigravity', toolName: 'edit', summary: 'Edit', argumentsPreview: '{}' } } } });
  event('request.created', { request: { id: 'r2', kind: 'ask_user', payload: { request: { itemId: 'r2', questions: [] } } } });
  (host as unknown as { sessions: Map<string, unknown> }).sessions.set('agent', { snapshot: { busy: true, clientRequests: [] } });
  event('request.resolved', { id: 'r2', outcome: { kind: 'answered' } });
  expect(statuses).toStrictEqual([{ type: 'awaitingInput', reason: 'approval' }, { type: 'awaitingInput', reason: 'input' }, { type: 'working' }]);
  (host as unknown as { sessions: Map<string, unknown> }).sessions.delete('agent');
  await host.close();
});

it('keeps reporting the reason of a request still pending when another one resolves', async () => {
  const host = createProviderHost('antigravity', { client: { name: 'test' } });
  const statuses: unknown[] = [];
  host.onEvent(event => { if (event.type === 'agent.statusChanged') statuses.push(event.payload); });
  const sessions = (host as unknown as { sessions: Map<string, unknown> }).sessions;
  const question = { id: 'r2', kind: 'ask_user', payload: { request: { itemId: 'r2', questions: [] } } };
  sessions.set('agent', { snapshot: { busy: true, clientRequests: [question] } });
  (host as unknown as { conversationEvent(event: unknown): void })
    .conversationEvent({ type: 'request.resolved', agentId: 'agent', sessionId: 'session', turnId: 'turn', occurredAt: '', payload: { id: 'r1', outcome: { kind: 'decision' } } });
  expect(statuses).toStrictEqual([{ type: 'awaitingInput', reason: 'input' }]);
  sessions.delete('agent');
  await host.close();
});
