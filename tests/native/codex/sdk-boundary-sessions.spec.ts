const product = { name: 'CPA workbench' };
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexSdkFixture, sdkAgent, sdkSnapshot, sdkSummary } from './sdk-host-fixture';


describe(`Codex SDK → ${product.name} session policy`, () => {
  const fixtures: ReturnType<typeof codexSdkFixture>[] = [];
  const setup = () => { const fixture = codexSdkFixture(); fixtures.push(fixture); return fixture; };
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(({ driver }) => driver.close())); });

  it('shares a cold bind with hydration instead of loading an unfinished handle again', async () => {
    const { driver, conversation } = setup();
    const agent = sdkAgent();
    const session = conversation('conversation-a');
    let finish!: (snapshot: ReturnType<typeof sdkSnapshot>) => void;
    session.handle.load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const continuation = driver.continueInterruptedTurn(agent);
    await vi.waitFor(() => expect(session.handle.load).toHaveBeenCalledOnce());
    const hydration = driver.loadConversation(agent);
    expect(session.handle.load).toHaveBeenCalledOnce();
    session.setSnapshot({ messages: [{ id: 'saved', role: 'assistant', status: 'complete', parts: [{ type: 'text', text: 'Saved history' }] }] });
    finish(session.handle.getSnapshot());
    await Promise.all([continuation, hydration]);
    expect(session.handle.load).toHaveBeenCalledOnce();
  });

  it('does not detach a newer session when a released cold load finishes', async () => {
    const { driver, conversation } = setup();
    const agent = sdkAgent();
    const old = conversation('conversation-a');
    let finish!: (snapshot: ReturnType<typeof sdkSnapshot>) => void;
    old.handle.load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const loading = driver.loadConversation(agent);
    const failure = expect(loading).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(old.handle.load).toHaveBeenCalledOnce());
    driver.releaseConversation(agent.id);
    const replacement = sdkAgent(agent.id, 'replacement');
    await driver.loadConversation(replacement);
    finish(old.handle.getSnapshot());
    await failure;
    await driver.loadConversation(replacement);
    expect(conversation('replacement').handle.load).toHaveBeenCalledOnce();
  });

  it('lists other active conversations with an explicit workspace filter', async () => {
    const { driver, host } = setup();
    host.listConversations.mockResolvedValueOnce([sdkSummary('conversation-a'), sdkSummary('another-live')])
      .mockResolvedValueOnce([sdkSummary('old', { updatedAt: '2026-09-01T00:00:00Z' }), sdkSummary('recent')]);
    const result = await driver.listConversations(sdkAgent(), { limit: 10, cwd: '/repo', searchTerm: ' query ' });
    expect(result.map(({ id, storageState }) => ({ id, storageState }))).toStrictEqual([
      { id: 'conversation-a', storageState: 'active' }, { id: 'another-live', storageState: 'active' },
    ]);
    expect(host.listConversations.mock.calls).toStrictEqual([
      [{ cwd: '/repo', limit: 10, searchTerm: 'query' }],
    ]);
  });





  it('restores persisted fast mode after cold load and delegates paging without implementing history', async () => {
    const { driver, conversation } = setup();
    const session = conversation('conversation-a');
    session.handle.loadOlderHistory.mockResolvedValue({ conversationId: 'conversation-a', messages: [], hasOlder: true });
    const agent = { ...sdkAgent(), providerDefaults: { kind: 'codex' as const, serviceTier: 'fast' } };
    await driver.loadConversation(agent);
    expect(session.handle.updateSettings).toHaveBeenCalledWith({ serviceTier: 'fast' });
    await expect(driver.loadOlderHistory(agent)).resolves.toStrictEqual({ hasOlder: true });
    expect(session.handle.loadOlderHistory).toHaveBeenCalledOnce();
    await driver.loadTurnHistory(agent, 'older-turn');
    expect(session.handle.loadTurnHistory).toHaveBeenCalledExactlyOnceWith('older-turn');
    session.handle.loadTurnHistory.mockRejectedValueOnce(new Error('details unavailable'));
    await expect(driver.loadTurnHistory(agent, 'older-turn')).rejects.toThrow('details unavailable');
    session.handle.loadOlderHistory.mockRejectedValueOnce(new Error('page unavailable'));
    await expect(driver.loadOlderHistory(agent)).rejects.toThrow('page unavailable');
  });

  it.each(['gpt-6.1-sol', 'gpt-6.1-terra'])('restores saved %s, effort and tier before publishing a cold-loaded conversation', async model => {
    const { driver, conversation, events } = setup();
    const session = conversation('conversation-a');
    session.setSnapshot({ selectedModelId: 'gpt-6.1-sol', selectedReasoningEffort: 'low', selectedServiceTier: 'fast' });
    session.handle.updateSettings.mockImplementation(async settings => {
      session.setSnapshot({
        selectedModelId: settings.modelId ?? session.handle.getSnapshot().selectedModelId,
        selectedReasoningEffort: settings.reasoningEffort ?? session.handle.getSnapshot().selectedReasoningEffort,
        selectedServiceTier: settings.serviceTier === undefined ? session.handle.getSnapshot().selectedServiceTier : settings.serviceTier,
      });
      return session.handle.getSnapshot();
    });
    const agent = {
      ...sdkAgent(),
      providerDefaults: { kind: 'codex' as const, model, reasoningEffort: 'high', serviceTier: null, userSelectedModel: true },
    };

    await driver.loadConversation(agent);

    expect(session.handle.updateSettings).toHaveBeenCalledWith({ modelId: model, reasoningEffort: 'high', serviceTier: null });
    const settings = events.filter(event => event.type === 'conversation.settingsUpdated');
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ payload: { settings: { model, reasoningEffort: 'high', serviceTier: null } } });
  });
});
