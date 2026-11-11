import type { RpcMessage, v2 } from '@korus-dev/codex-sdk';
import { CodexAppServerClient } from '@korus-dev/codex-sdk';
import { CodexHost } from '../../../src/providers/codex';
import {
  MockCodexAppServer as StrictMockCodexAppServer,
  type MockCodexAppServerHandlers,
} from './mock-codex-app-server';

export const generatedPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export class MockCodexAppServer extends StrictMockCodexAppServer {
  constructor(overrides: MockCodexAppServerHandlers = {}) {
    super({ ...defaultHandlers, ...overrides });
  }
}

export type StandardMutation = keyof typeof standardMutationHandlers;

export function createHarness(
  ...mutations: StandardMutation[]
): { host: CodexHost; transport: MockCodexAppServer } {
  const transport = new MockCodexAppServer(selectStandardMutations(mutations));
  return {
    transport,
    host: new CodexHost({
      client: new CodexAppServerClient(transport),
      cwd: '/tmp/project',
    }),
  };
}

function selectStandardMutations(methods: StandardMutation[]): MockCodexAppServerHandlers {
  return Object.fromEntries(methods.map((method) => [method, standardMutationHandlers[method]]));
}

const standardMutationHandlers = {
  'thread/start': () => resumeResponse(thread('thread-new', false)),
  'turn/start': () => ({ turn: turn('turn-live', 'inProgress', []) }),
  'turn/steer': () => ({ turnId: 'turn-live' }),
  'turn/interrupt': () => ({}),
  'thread/compact/start': () => ({}),
  'thread/settings/update': () => ({}),
  'thread/name/set': () => ({}),
  'thread/goal/clear': () => ({ cleared: true }),
  'thread/archive': () => ({}),
  'thread/delete': () => ({}),
  'thread/realtime/start': () => ({}),
  'thread/realtime/appendAudio': () => ({}),
  'thread/realtime/appendText': () => ({}),
  'thread/realtime/appendSpeech': () => ({}),
  'thread/realtime/stop': () => ({}),
  'review/start': () => ({
    turn: turn('turn-review', 'inProgress', []),
    reviewThreadId: 'thread-existing',
  }),
  'thread/revert': () => ({ thread: thread('thread-existing', false), turnsBackwardsCursor: null, itemsBackwardsCursor: null }),
} satisfies MockCodexAppServerHandlers;

const defaultHandlers: MockCodexAppServerHandlers = {
  initialize: () => ({
    userAgent: 'test', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos',
  }),
  'account/read': () => ({ workspaceRouting: null,
      account: { type: 'chatgpt', workspaceName: null, email: 'test@example.test', planType: 'pro' },
      requiresOpenaiAuth: true,
    }),
  'model/list': () => ({
      data: [
        { availableAccessPrograms: { cyber: [] },
          id: 'gpt-5', model: 'gpt-5', upgrade: null, upgradeInfo: null, availabilityNux: null,
          displayName: 'GPT-5', description: 'Test model', modelSpecialty: null, hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
          defaultReasoningEffort: 'medium', inputModalities: ['text'], supportsPersonality: true,
          multiAgentVersion: null,
          additionalSpeedTiers: [], serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Fast mode' }], defaultServiceTier: null, isDefault: true,
        },
        { availableAccessPrograms: { cyber: [] },
          id: 'gpt-mini', model: 'gpt-mini-runtime', upgrade: null, upgradeInfo: null, availabilityNux: null,
          displayName: 'GPT Mini', description: 'Fast model', modelSpecialty: null, hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: 'medium', description: 'Balanced' },
            { reasoningEffort: 'high', description: 'Deep' },
          ],
          defaultReasoningEffort: 'medium', inputModalities: ['text'], supportsPersonality: true,
          multiAgentVersion: null,
          additionalSpeedTiers: [], serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Fast mode' }], defaultServiceTier: null, isDefault: false,
        },
      ],
      nextCursor: null,
    }),
  'skills/list': () => ({ data: [{ cwd: '/tmp/project', skills: [], errors: [] }] }),
  'plugin/installed': () => ({ marketplaces: [], marketplaceLoadErrors: [] }),
  'permissionProfile/list': () => ({
      data: [
        { id: ':read-only', description: null, allowed: true },
        { id: ':workspace', description: null, allowed: true },
        { id: ':danger-full-access', description: null, allowed: true },
      ],
      nextCursor: null,
    }),
  'experimentalFeature/list': () => ({
      data: [{
        name: 'compaction_image_budget',
        stage: 'stable',
        displayName: null,
        description: null,
        announcement: null,
        enabled: true,
        defaultEnabled: true,
      }],
      nextCursor: null,
    }),
  'configRequirements/read': () => ({ supportsIndependentSpeedModes: null, requirements: null }),
  'thread/list': () => ({ readStates: null, data: [thread('thread-existing', false)], nextCursor: null, backwardsCursor: null }),
  'thread/turns/list': (params) => ({
        data: thread(params.threadId, true).turns,
        nextCursor: null,
        backwardsCursor: null,
      }),
  'thread/resume': (params) => resumeResponse(thread(params.threadId, true)),
};

export function thread(id: string, includeHistory: boolean): v2.Thread {
  return {
    id,
    environments: null,
    extra: null,
    sessionId: `session-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: id === 'thread-existing' ? 'Existing thread' : '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'paginated',
    modelProvider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    name: null,
    cwd: '/tmp/project',
    status: { type: 'idle' },
    path: null,
    cliVersion: 'test',
    originator: null,
    source: 'appServer',
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    daybreakEnabled: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_001,
    recencyAt: null,
    turns: includeHistory ? [turn('turn-history', 'completed', [
      { type: 'userMessage', id: 'user-history', clientId: null, content: [{ type: 'text', text: 'Hello', text_elements: [] }] },
      { type: 'agentMessage', id: 'agent-history', text: 'Hi there', phase: null, memoryCitation: null, delivery: null, questions: null },
    ])] : [],
  };
}

export function turn(id: string, status: v2.TurnStatus, items: v2.ThreadItem[]): v2.Turn {
  return { rootTurnId: null,
    id, status, items, itemsView: 'full',
    startedAt: 1_700_000_000, completedAt: null, durationMs: null, error: null,
  };
}

export function resumeResponse(value: v2.Thread): v2.ThreadResumeResponse {
  const turns = value.turns;
  return {
    disabledPluginIds: [],
    collaborationMode: null,
    thread: { ...value, turns: [] },
    initialTurnsPage: { data: [...turns].reverse(), nextCursor: null, backwardsCursor: null },
    model: 'gpt-5',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: '/tmp/project',
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: {
      type: 'workspaceWrite', writableRoots: ['/tmp/project'], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    },
    activePermissionProfile: { id: ':workspace', extends: null },
    reasoningEffort: 'medium',
    multiAgentMode: 'explicitRequestOnly',
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
  };
}

export function testGoal(overrides: Partial<v2.ThreadGoal> = {}): v2.ThreadGoal {
  return {
    threadId: 'thread-existing',
    objective: 'Ship it',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function configRequirements(
  overrides: Partial<v2.ConfigRequirements> = {},
): v2.ConfigRequirements {
  return {
    modelProvider: null,
    modelProviders: null,
    allowedLoginMethods: null,
    cliAuthCredentialsStore: null,
    chatgptBaseUrl: null,
    additionalDeveloperInstructions: null,
    allowedApprovalPolicies: null,
    allowedApprovalsReviewers: null,
    allowedSandboxModes: null,
    allowedWindowsSandboxImplementations: null,
    allowedPermissionProfiles: null,
    defaultPermissions: null,
    allowedWebSearchModes: null,
    allowManagedHooksOnly: null,
    allowBrowserAndComputerUse: null,
    allowAppshots: null,
    allowRemoteControl: null,
    computerUse: null,
    browserUse: null,
    inAppBrowser: null,
    featureRequirements: null,
    hooks: null,
    enforceResidency: null,
    network: null,
    application: null,
    autoReview: null,
    models: null,
    sqliteHome: null,
    logDir: null,
    modelCatalogJson: null,
    checkForUpdateOnStartup: null,
    allowLoginShell: null,
    feedback: null,
    otel: null,
    ...overrides,
  };
}

export function testModel(id: string, model: string, isDefault: boolean): v2.Model {
  return { availableAccessPrograms: { cyber: [] },
    id,
    model,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: id,
    description: 'Test model',
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text'],
    supportsPersonality: true,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault,
  };
}

export function pluginSummary(
  id: string,
  name: string,
  pluginInterface: Partial<v2.PluginInterface>,
): v2.PluginSummary {
  return {
    id,
    remotePluginId: null,
    version: null,
    localVersion: null,
    name,
    shareContext: null,
    source: { type: 'local', path: `/tmp/${id}` },
    installed: true,
    installedAt: null,
    enabled: true,
    installPolicy: 'AVAILABLE',
    installPolicySource: null,
    mustShowInstallationInterstitial: null,
    authPolicy: 'ON_USE',
    availability: 'AVAILABLE',
    disabledReason: null,
    eligiblePlanTypes: null,
    keywords: [],
    interface: {
      displayName: null,
      shortDescription: null,
      longDescription: null,
      developerName: null,
      category: null,
      capabilities: [],
      websiteUrl: null,
      privacyPolicyUrl: null,
      termsOfServiceUrl: null,
      defaultPrompt: null,
      brandColor: null,
      composerIcon: null,
      composerIconUrl: null,
      logo: null,
      logoDark: null,
      logoUrl: null,
      logoUrlDark: null,
      screenshots: [],
      screenshotUrls: [],
      ...pluginInterface,
    },
  };
}

export function threadSettings(overrides: Partial<v2.ThreadSettings> = {}): v2.ThreadSettings {
  return {
    disabledPluginIds: [],
    cwd: '/tmp/project',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: {
      type: 'workspaceWrite', writableRoots: ['/tmp/project'], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    },
    activePermissionProfile: { id: ':workspace', extends: null },
    model: 'gpt-5',
    modelProvider: 'openai',
    serviceTier: null,
    effort: 'medium',
    summary: null,
    collaborationMode: {
      mode: 'default',
      settings: { model: 'gpt-5', reasoning_effort: 'medium', developer_instructions: null },
    },
    multiAgentMode: 'explicitRequestOnly',
    personality: null,
    ...overrides,
  };
}

export function lastRequest(transport: MockCodexAppServer, method: string): RpcMessage | undefined {
  for (let index = transport.sent.length - 1; index >= 0; index -= 1) {
    const message = transport.sent[index];
    if (message && 'method' in message && message.method === method) return message;
  }
  return undefined;
}

export function requestsFor(transport: MockCodexAppServer, method: string): RpcMessage[] {
  return transport.sent.filter((message) => 'method' in message && message.method === method);
}

export function lastResponse(transport: MockCodexAppServer, id: string | number): RpcMessage | undefined {
  for (let index = transport.sent.length - 1; index >= 0; index -= 1) {
    const message = transport.sent[index];
    if (message && 'id' in message && message.id === id && !('method' in message)) return message;
  }
  return undefined;
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
