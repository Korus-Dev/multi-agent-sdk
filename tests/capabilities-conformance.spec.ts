import { afterEach, describe, expect, it } from 'vitest';
import { createProviderHost } from '../src/harnesses';
import type { HarnessProvider } from '../src/contracts';

// A capability flag is a promise to consumers: they should never have to learn about support by catching an error.
// Each flag must be true exactly when the provider implements the operation behind it.
const operations: Record<string, string> = {
  conversationArchive: 'archiveAgentConversation',
  conversationResume: 'resumeConversation',
  remoteControl: 'getRemoteControlStatus',
  realtime: 'startRealtime',
  accountUsage: 'getAccountRateLimits',
  plugins: 'listPlugins',
  skills: 'listSkills',
  models: 'listModels',
  goals: 'setGoal',
  conversationFork: 'forkConversation',
  deleteTurn: 'deleteTurn',
  editTurn: 'editTurn',
  retryTurn: 'retryTurn',
  textGeneration: 'generateText',
  imageGeneration: 'generateImage',
  review: 'startReview',
  bankedResets: 'getBankedResets',
  conversationDelete: 'deleteAgentConversation',
  conversationTitle: 'setConversationTitle',
  scopedExecution: 'executeScopedPrompt',
  turnContinuation: 'continueInterruptedTurn',
  conversationContent: 'readConversationContent',
  turnHistory: 'loadTurnHistory',
  conversationStorage: 'setConversationStorage',
};

const providers: HarnessProvider[] = ['codex', 'claude', 'cursor', 'antigravity'];
describe.each(providers)('%s capabilities', provider => {
  const drivers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => { for (const driver of drivers.splice(0)) await driver.close(); });
  it('match the operations the provider implements', () => {
    const driver = createProviderHost(provider, { client: { name: 'conformance' } });
    drivers.push(driver);
    const capabilities = driver.getCapabilities() as Record<string, unknown>;
    const mismatches = Object.entries(operations).flatMap(([flag, method]) => {
      const promised = capabilities[flag] === true;
      const implemented = typeof (driver as unknown as Record<string, unknown>)[method] === 'function';
      return promised === implemented ? [] : [`${flag}: ${promised ? 'promised' : 'not promised'} but ${method} is ${implemented ? 'implemented' : 'missing'}`];
    });
    expect(mismatches).toStrictEqual([]);
  });
});
