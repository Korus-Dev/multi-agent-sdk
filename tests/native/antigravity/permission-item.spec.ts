import { expect, it } from 'vitest';
import { permissionRequest } from '../../../src/providers/antigravity/permissions';
import { requestFromClientRequest } from '../../../src/conversations/agent-request';

it('names the tool call a confirmation is about, so an app can show the two as one', () => {
  const { request } = permissionRequest({ toolCall: { toolCallId: 'call-7', title: 'Run client_create_file?', kind: 'edit' }, options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }] });
  expect(requestFromClientRequest(request, { conversationId: 'session', turnId: 'turn' })).toMatchObject({ kind: 'toolConfirmation', itemId: 'call-7' });
});
