import { describe, expect, it, vi } from 'vitest';
import { createCodexConversationReplica } from '../../src/core/index';
import { CodexAppServerClient, type v2 } from '@korus-dev/codex-sdk';
import { CodexHost } from '../../src/providers/codex';
import { MockCodexAppServer, lastRequest } from './helpers/host-fixture';

const profiles = [
  { version: '0.164', account: { type: 'chatgpt', email: 'person@example.test', planType: 'pro' } },
  { version: '0.165', account: { type: 'gcp' } },
  { version: '0.166', account: { type: 'chatgpt', email: 'person@example.test', planType: 'pro', workspaceName: 'Research' } },
  { version: '0.167', account: { type: 'chatgpt', email: 'person@example.test', planType: 'pro', workspaceName: 'Research' } },
];

describe('Codex CLI wire compatibility', () => {
  it.each(profiles)('loads $version account payloads and resolves withdrawn approvals without replying', async ({ version, account }) => {
    const transport = new MockCodexAppServer({
      // The 0.164 payload intentionally omits workspaceName: preserve older wire coverage.
      'account/read': () => ({ workspaceRouting: null, account: account as v2.Account, requiresOpenaiAuth: false }),
    });
    const human = version === '0.167';
    const host = new CodexHost({ client: new CodexAppServerClient(transport), requiredHumanApproval: human });
    try {
      await host.connect();
      const replica = createCodexConversationReplica(host.getConversationSnapshot('thread-existing'));
      host.onConversationEvent('thread-existing', event => replica.apply(event));
      expect(host.getSnapshot().authentication.account).toStrictEqual(account);
      expect(lastRequest(transport, 'initialize')).toMatchObject({ params: {
        capabilities: { experimentalApi: true, requestAttestation: false, ...(human ? { requiredHumanApproval: true } : {}) },
      } });
      const request = (id: string) => transport.emitServerRequestFrame({ id, method: 'item/commandExecution/requestApproval', params: {
        kind: human ? 'humanCommand' : 'command', threadId: 'thread-existing', turnId: 'turn', itemId: 'command',
        startedAtMs: 1, environmentId: null, command: 'check', availableDecisions: ['accept', 'decline', 'cancel'],
      } });
      request('first');
      await vi.waitFor(() => expect(host.getSnapshot().approvals).toHaveLength(1));
      if (human) {
        expect(host.getSnapshot().approvals[0]).toMatchObject({ requiresHumanApproval: true, allowedScopes: ['once'] });
        expect(replica.getSnapshot().approvals[0]).toMatchObject({ requiresHumanApproval: true, allowedScopes: ['once'] });
      }
      await host.resolveApproval('first', 'approve', 'once');
      expect(transport.sent).toContainEqual({ id: 'first', result: { decision: 'accept' } });
      // A second callback for the same command needs another decision; no remembered grant.
      request('second');
      await vi.waitFor(() => expect(host.getSnapshot().approvals).toHaveLength(1));
      transport.emitNotification('serverRequest/resolved', { threadId: 'thread-existing', requestId: 'second' });
      expect(host.getSnapshot().approvals).toHaveLength(0);
      expect(replica.getSnapshot().approvals).toHaveLength(0);
      await expect(host.resolveApproval('second', 'approve', 'once')).rejects.toThrow('Unknown approval');
      expect(transport.sent.filter(message => 'id' in message && message.id === 'second')).toHaveLength(0);
    } finally { await host.close(); }
  });
});
