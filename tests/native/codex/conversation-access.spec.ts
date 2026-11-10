import { expect, it } from 'vitest';
import { codexSdkFixture, sdkAgent, sdkSummary } from './sdk-surface-fixture';

it('lists normal active chats by default independently of the bound workspace and starts the runtime', async () => {
  const fixture = codexSdkFixture();
  fixture.surface.listConversations.mockImplementation(async options => options?.archived
    ? [sdkSummary('archived')]
    : [sdkSummary('conversation-a'), sdkSummary('other-active')]);
  try {
    const chats = await fixture.driver.listConversations!(sdkAgent(), { limit: 3 });
    expect(chats.map(chat => [chat.id, chat.storageState])).toStrictEqual([
      ['conversation-a', 'active'], ['other-active', 'active'],
    ]);
    expect(fixture.surface.connect).toHaveBeenCalledOnce();
    expect(fixture.surface.listConversations.mock.calls).toStrictEqual([
      [{ limit: 3 }],
    ]);
    expect((await fixture.driver.listConversations!(sdkAgent(), { archived: true })).map(chat => [chat.id, chat.storageState]))
      .toStrictEqual([['archived', 'archived']]);
  } finally { await fixture.driver.close(); }
});

it('resumes another active chat without archiving the previously bound chat', async () => {
  const fixture = codexSdkFixture();
  try {
    const result = await fixture.driver.resumeConversation!(sdkAgent(), {
      ref: { backend: 'codex', threadId: 'other-active' }, storageState: 'active',
    });
    expect(result.backendSession).toStrictEqual({ kind: 'codex', threadId: 'other-active' });
    expect(fixture.surface.archiveConversation).not.toHaveBeenCalled();
    expect(fixture.surface.unarchiveConversation).not.toHaveBeenCalled();
  } finally { await fixture.driver.close(); }
});
