const product = { name: 'CPA workbench' };
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexSdkFixture, sdkAgent, sdkSnapshot } from './sdk-host-fixture';

describe(`Codex SDK → ${product.name} backend lifecycle`, () => {
  const fixtures: ReturnType<typeof codexSdkFixture>[] = [];
  const setup = () => { const fixture = codexSdkFixture(); fixtures.push(fixture); return fixture; };
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(({ driver }) => driver.close())); vi.useRealTimers(); });

  it.each([undefined, { kind: 'codex' as const }])('preserves loaded permissions when the caller has no permission preference: %j', async backendDefaults => {
    const { driver, conversation, events } = setup();
    const native = conversation('conversation-a');
    native.setSnapshot({ approvalPresets: ['ask-for-approval', 'approve-for-me', 'full-access'], approvalPreset: 'full-access' });
    const agent = { ...sdkAgent(), backendDefaults };
    await driver.loadConversation(agent);
    expect(native.handle.updateSettings).not.toHaveBeenCalled();
    expect(events.filter(event => event.type === 'codex.conversationSnapshotChanged').at(-1)).toMatchObject({ payload: { snapshot: { approvalPreset: 'full-access' } } });
    await driver.resumeConversation(agent, { ref: { provider: 'codex', threadId: 'conversation-a' }, storageState: 'active' });
    expect(native.handle.updateSettings).not.toHaveBeenCalled();
  });

  it.each(['caller', 'host'] as const)('keeps explicit %s permission policy on load', async policy => {
    const fixture = codexSdkFixture(undefined, policy === 'host' ? { approvalPresetFromDefaults: () => 'ask-for-approval' } : {});
    fixtures.push(fixture);
    const native = fixture.conversation('conversation-a');
    native.setSnapshot({ approvalPresets: ['ask-for-approval', 'approve-for-me', 'full-access'], approvalPreset: 'full-access' });
    await fixture.driver.loadConversation({ ...sdkAgent(), ...(policy === 'caller' ? { providerDefaults: { kind: 'codex', approvalPreset: 'ask-for-approval' } as const } : {}) });
    expect(native.handle.updateSettings).toHaveBeenCalledExactlyOnceWith({ approvalPreset: 'ask-for-approval' });
  });

  it('inherits existing native settings while keeping defaults for new conversations when the host requests it', async () => {
    const fixture = codexSdkFixture(undefined, { inheritNativeSettings: true, approvalPresetFromDefaults: () => 'full-access' });
    fixtures.push(fixture);
    const session = fixture.conversation('conversation-a');
    session.setSnapshot({ approvalPresets: ['ask-for-approval', 'full-access'], approvalPreset: 'ask-for-approval', selectedModelId: 'native-model', selectedReasoningEffort: 'low' });
    const agent = { ...sdkAgent(), providerDefaults: { kind: 'codex', model: 'saved-model', reasoningEffort: 'high', serviceTier: 'fast', userSelectedModel: true } as const };
    await fixture.driver.loadConversation(agent);
    expect(session.handle.updateSettings).not.toHaveBeenCalled();
    expect(fixture.events.filter(event => event.type === 'conversation.settingsUpdated').at(-1)).toMatchObject({ payload: { settings: { model: 'native-model', reasoningEffort: 'low', approvalPreset: 'ask-for-approval' } } });
    fixture.host.createConversation.mockResolvedValue(sdkSnapshot('new'));
    await fixture.driver.sendPrompt({ ...agent, id: 'new-agent', providerSession: undefined }, 'New conversation');
    expect(fixture.host.createConversation).toHaveBeenCalledWith(expect.objectContaining({ model: 'saved-model', reasoningEffort: 'high', serviceTier: 'fast' }), expect.anything());
  });

  it('returns the public canonical user-message binding for a shared submission', async () => {
    const { driver, conversation } = setup();
    const message = { id: 'public-client-message-id', role: 'user' as const, status: 'complete' as const, turnId: 'shared-turn', parts: [{ type: 'text' as const, text: 'Identical prompt' }] };
    conversation('conversation-a').handle.sendMessage.mockResolvedValue(sdkSnapshot('conversation-a', { turnIds: ['shared-turn'], activeTurnId: 'shared-turn', messages: [message] }));
    await expect(driver.sendPrompt(sdkAgent(), 'Identical prompt')).resolves.toMatchObject({ turnId: 'shared-turn', messageId: 'public-client-message-id' });
    // Canonical history may replace rows; the admitted public client ID, not text or position, is the binding.
    conversation('conversation-a').handle.sendMessage.mockResolvedValue(sdkSnapshot('conversation-a', { turnIds: ['shared-turn', 'another-turn'], messages: [{ ...message, id: 'other-client-id', turnId: 'another-turn' }] }));
    await expect(driver.sendPrompt(sdkAgent(), 'Identical prompt')).resolves.toMatchObject({ turnId: 'another-turn', messageId: 'other-client-id' });
  });

  it('creates a user conversation in the assigned folder and sends prepared options to that handle', async () => {
    const { driver, host, conversation } = setup();
    const agent = { ...sdkAgent(), providerSession: undefined };
    host.createConversation.mockResolvedValue(sdkSnapshot());
    conversation('conversation-a').handle.sendMessage.mockResolvedValue(sdkSnapshot('conversation-a', { turnIds: ['accepted'], activeTurnId: 'accepted' }));
    const options = driver.preparePromptOptions(agent, { planMode: true, selection: { model: 'model', reasoningEffort: 'high', serviceTier: 'fast' } });
    await expect(driver.sendPrompt(agent, 'Implement', options)).resolves.toStrictEqual({ providerSession: { kind: 'codex', threadId: 'conversation-a' }, turnId: 'accepted' });
    expect(host.createConversation).toHaveBeenCalledWith({ cwd: '/repo', threadSource: 'user' }, { extensionContext: agent });
    expect(conversation('conversation-a').handle.updateSettings).toHaveBeenCalledWith({ planMode: true });
    expect(conversation('conversation-a').handle.sendMessage).toHaveBeenCalledWith('Implement', { model: 'model', reasoningEffort: 'high', serviceTier: 'fast', planMode: true });
    expect(conversation('conversation-a').handle.rename).toHaveBeenCalledWith('agent-a');
    const skills = [{ name: 'check', path: '/repo/check/SKILL.md' }];
    await driver.sendPrompt(agent, 'Check', driver.preparePromptOptions(agent, { skills }));
    expect(conversation('conversation-a').handle.sendMessage).toHaveBeenLastCalledWith('Check', { skills });
  });

  it('propagates SDK rejection without fabricating a successful turn and permits retry', async () => {
    const { driver, conversation } = setup();
    const handle = conversation('conversation-a').handle;
    handle.sendMessage.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(sdkSnapshot('conversation-a', { turnIds: ['retry'] }));
    await expect(driver.sendPrompt(sdkAgent(), 'hello')).rejects.toThrow('offline');
    await expect(driver.sendPrompt(sdkAgent(), 'hello')).resolves.toMatchObject({ turnId: 'retry' });
    expect(handle.load).toHaveBeenCalledOnce();
  });

  it('shares a fresh agent conversation between overlapping title synchronization and its first prompt', async () => {
    const { driver, host, conversation } = setup();
    const agent = { ...sdkAgent(), providerSession: undefined };
    let finishCreation!: () => void;
    const creation = new Promise<void>((resolve) => { finishCreation = resolve; });
    let created = 0;
    host.createConversation.mockImplementation(async () => {
      const id = `created-${++created}`;
      await creation;
      return sdkSnapshot(id);
    });
    conversation('created-1').handle.sendMessage.mockResolvedValue(sdkSnapshot('created-1', { turnIds: ['accepted'] }));

    const title = driver.setConversationTitle(agent, 'Issue 61');
    const prompt = driver.sendPrompt(agent, 'My custom instructions');
    await vi.waitFor(() => expect(host.createConversation).toHaveBeenCalled());
    finishCreation();
    await title;
    await expect(prompt).resolves.toStrictEqual({ providerSession: { kind: 'codex', threadId: 'created-1' }, turnId: 'accepted' });
    expect(host.createConversation).toHaveBeenCalledOnce();
    expect(host.forgetConversation).not.toHaveBeenCalled();
    expect(conversation('created-1').handle.rename).toHaveBeenCalledWith('Issue 61');
    expect(conversation('created-1').handle.sendMessage).toHaveBeenCalledWith('My custom instructions', {});
  });

  it('allows another agent to start while creation is pending and retries a failed initialization', async () => {
    const { driver, host, conversation } = setup();
    const firstAgent = { ...sdkAgent(), providerSession: undefined };
    const secondAgent = { ...sdkAgent('agent-b'), providerSession: undefined };
    let rejectCreation!: (error: Error) => void;
    host.createConversation.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCreation = reject; }));
    host.createConversation.mockResolvedValue(sdkSnapshot('independent'));
    const first = expect(driver.sendPrompt(firstAgent, 'first')).rejects.toThrow('creation failed');
    await vi.waitFor(() => expect(host.createConversation).toHaveBeenCalledOnce());
    await expect(driver.sendPrompt(secondAgent, 'independent')).resolves.toMatchObject({ providerSession: { threadId: 'independent' } });
    rejectCreation(new Error('creation failed'));
    await first;
    host.createConversation.mockResolvedValue(sdkSnapshot('retry'));
    await expect(driver.sendPrompt(firstAgent, 'retry')).resolves.toMatchObject({ providerSession: { threadId: 'retry' } });
    expect(conversation('retry').handle.sendMessage).toHaveBeenCalledWith('retry', {});
    expect(host.forgetConversation).not.toHaveBeenCalledWith('independent');
  });

  it.each(['release', 'close'] as const)('does not start the first prompt after %s during conversation creation', async (action) => {
    const { driver, host, conversation } = setup();
    let finishCreation!: () => void;
    host.createConversation.mockImplementation(() => new Promise((resolve) => { finishCreation = () => resolve(sdkSnapshot()); }));
    const prompt = expect(driver.sendPrompt({ ...sdkAgent(), providerSession: undefined }, 'cancelled')).rejects.toThrow(/initialization.*cancelled/i);
    await vi.waitFor(() => expect(host.createConversation).toHaveBeenCalledOnce());
    if (action === 'close') await driver.close();
    else driver.releaseConversation('agent-a');
    finishCreation();
    await prompt;
    expect(conversation('conversation-a').handle.sendMessage).not.toHaveBeenCalled();
    expect(conversation('conversation-a').listenerCount()).toBe(0);
  });

  it('restores an archived target without archiving the previous conversation', async () => {
    const { driver, host, conversation } = setup();
    const order: string[] = [];
    host.unarchiveConversation.mockImplementation(async (id) => { order.push(`restore:${id}`); return sdkSnapshot(id); });
    conversation('archived').handle.load.mockImplementation(async () => { order.push('load:archived'); return sdkSnapshot('archived'); });
    host.archiveConversation.mockImplementation(async (id) => { order.push(`archive:${id}`); return sdkSnapshot(id); });
    await expect(driver.resumeConversation(sdkAgent(), { ref: { provider: 'codex', threadId: 'archived' }, storageState: 'archived' })).resolves.toMatchObject({ providerSession: { kind: 'codex', threadId: 'archived' } });
    expect(order).toStrictEqual(['restore:archived', 'load:archived']);
  });

  it('rolls back failed restoration and keeps subsequent prompts on the previous conversation', async () => {
    const { driver, host, conversation } = setup();
    conversation('broken').handle.load.mockRejectedValueOnce(new Error('cannot load'));
    await expect(driver.resumeConversation(sdkAgent(), { ref: { provider: 'codex', threadId: 'broken' }, storageState: 'archived' })).rejects.toThrow('cannot load');
    expect(host.archiveConversation).toHaveBeenCalledExactlyOnceWith('broken');
    await driver.sendPrompt(sdkAgent(), 'continue');
    expect(conversation('conversation-a').handle.sendMessage).toHaveBeenCalledOnce();
    expect(conversation('broken').handle.sendMessage).not.toHaveBeenCalled();
    expect(conversation('broken').listenerCount()).toBe(0);
  });

  it('deletes the attached conversation through the SDK, and does nothing without a thread', async () => {
    const { driver, host } = setup();
    await driver.deleteAgentConversation(sdkAgent());
    expect(host.deleteConversation).toHaveBeenCalledExactlyOnceWith('conversation-a');
    await driver.deleteAgentConversation({ ...sdkAgent(), providerSession: undefined });
    expect(host.deleteConversation).toHaveBeenCalledOnce();
  });

  it('treats a conversation that is already archived as archived, and deletes it out of the archive', async () => {
    const { driver, host } = setup();
    const archived = [{ id: 'conversation-a' }] as never;
    host.listConversations.mockImplementation(async (input?: { archived?: boolean }) => input?.archived ? archived : []);
    // Codex has nothing left to archive: the rollout already moved.
    host.archiveConversation.mockRejectedValueOnce(new Error('no rollout found for thread id conversation-a'));
    await expect(driver.archiveAgentConversation(sdkAgent())).resolves.toBeUndefined();
    host.deleteConversation.mockRejectedValueOnce(new Error('session conversation-a is archived. Run `codex unarchive conversation-a` to unarchive it first.'));
    await expect(driver.deleteAgentConversation(sdkAgent())).resolves.toBeUndefined();
    expect(host.unarchiveConversation).toHaveBeenCalledExactlyOnceWith('conversation-a');
    expect(host.deleteConversation).toHaveBeenCalledTimes(2);
  });

  it('does not detach an attached conversation when archive fails', async () => {
    const { driver, host, conversation } = setup();
    await driver.loadConversation(sdkAgent());
    host.archiveConversation.mockRejectedValueOnce(new Error('archive failed'));
    await expect(driver.archiveAgentConversation(sdkAgent())).rejects.toThrow('archive failed');
    await driver.sendPrompt(sdkAgent(), 'still attached');
    expect(conversation('conversation-a').handle.load).toHaveBeenCalledOnce();
    expect(conversation('conversation-a').handle.sendMessage).toHaveBeenCalledWith('still attached', {});
  });

  it.each([false, true])('cold hydration interrupts orphaned work except an active goal (goal=%s)', async (activeGoal) => {
    const { driver, conversation } = setup();
    const session = conversation('conversation-a');
    session.setSnapshot({ activeTurnId: 'old-turn', busy: true, ...(activeGoal ? { goal: { threadId: 'conversation-a', objective: 'finish', status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 } } : {}) });
    await driver.loadConversation(sdkAgent());
    expect(session.handle.interrupt).toHaveBeenCalledTimes(activeGoal ? 0 : 1);
  });

  it('never takes over or interrupts a conversation another session of this app is running, such as a review in its scope', async () => {
    const { driver, conversation } = setup();
    const session = conversation('conversation-a');
    // A scope loads the conversation and starts a turn in it.
    await driver.loadConversation(sdkAgent('reviewer:scope:1'));
    session.setSnapshot({ activeTurnId: 'review-turn', busy: true });
    // The agent's own session is then asked to load the same conversation, as when its record adopts the scope's.
    await expect(driver.loadConversation(sdkAgent('reviewer'))).rejects.toThrow(/running/i);
    expect(session.handle.interrupt).not.toHaveBeenCalled();
    // Once the turn is over the conversation can change hands.
    session.setSnapshot({ activeTurnId: null, busy: false });
    await expect(driver.loadConversation(sdkAgent('reviewer'))).resolves.toBeDefined();
  });

  it('reuses fresh snapshots, refreshes expired idle history, and retains live history', async () => {
    vi.useFakeTimers();
    const { driver, conversation, events } = setup();
    const session = conversation('conversation-a');
    session.setSnapshot({ messages: [{ id: 'cached', role: 'assistant', status: 'complete', parts: [{ type: 'text', text: 'Cached answer' }], createdAt: '2026-09-16T00:00:00Z' }] });
    await driver.loadConversation(sdkAgent());
    events.length = 0;
    await driver.loadConversation(sdkAgent());
    expect(session.handle.load).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === 'codex.conversationSnapshotChanged')).toMatchObject([{ payload: { snapshot: { messages: session.handle.getSnapshot().messages } } }]);
    vi.advanceTimersByTime(16 * 60_000);
    const savedAgent = { ...sdkAgent(), providerDefaults: { kind: 'codex' as const, model: 'gpt-6.1-sol', reasoningEffort: 'high', userSelectedModel: true } };
    session.setSnapshot({ selectedModelId: 'gpt-6.1-sol', selectedReasoningEffort: 'low' });
    await driver.loadConversation(savedAgent);
    expect(session.handle.load).toHaveBeenCalledTimes(2);
    expect(session.handle.updateSettings).toHaveBeenCalledWith({ modelId: 'gpt-6.1-sol', reasoningEffort: 'high' });
    session.setSnapshot({ activeTurnId: 'live', busy: true });
    vi.advanceTimersByTime(16 * 60_000);
    await driver.loadConversation(sdkAgent());
    expect(session.handle.load).toHaveBeenCalledTimes(2);
  });

  it('drops old subscriptions when the agent changes conversation and on close', async () => {
    const { driver, conversation, events } = setup();
    await driver.loadConversation(sdkAgent());
    await driver.loadConversation(sdkAgent('agent-a', 'replacement'));
    expect(conversation('conversation-a').listenerCount()).toBe(0);
    events.length = 0;
    conversation('conversation-a').emit({ type: 'conversation.activityChanged', seq: 1, origin: 'notification', occurredAt: '2026-09-16T00:00:00Z', conversationId: 'conversation-a', payload: { busy: true, error: null, threadStatus: null } });
    expect(events).toStrictEqual([]);
    await driver.close();
    expect(conversation('replacement').listenerCount()).toBe(0);
  });
});
