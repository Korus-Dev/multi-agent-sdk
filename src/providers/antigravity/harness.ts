import type { ProviderContext } from '../../context';
import type { ProviderDefaults, ProviderSessionData } from '../../contracts';
import type { ProviderDriver, ProviderEvent } from '../../driver';
import type { HarnessOptions } from '../../options';
import { SessionHarness } from '../../session-harness';
import { antigravityHarnessCapabilities } from '../../capabilities';
import { bridgedMcpServers, harnessContext, providerHome, sharedProviderOptions, type SharedProviderOptions } from '../../harness-options';
import { replicaProjection, transcriptState, type HarnessProjection } from '../../harness-projection';
import { createAntigravityConversationReplica } from '../../conversations/antigravity-conversation-replica';
import { AntigravityHost, type AntigravityHostOptions } from './host';
import { antigravityHome, resolveAcpRuntime } from './runtime';

export type AntigravityProviderOptions<Context extends ProviderContext = ProviderContext> = SharedProviderOptions<Context> & { antigravity?: AntigravityHostOptions<Context> };

const permissionOf = (defaults: ProviderDefaults) => 'permissionMode' in defaults ? defaults.permissionMode : undefined;

export class AntigravityHarness extends SessionHarness<'antigravity'> {
  static readonly provider = 'antigravity';
  static readonly capabilities = antigravityHarnessCapabilities;
  /** A fresh session record for a conversation id. */
  static sessionData(id: string, folder: string | null): ProviderSessionData { return { kind: 'antigravity', sessionId: id, folder } as ProviderSessionData; }

  constructor(native: ProviderDriver<ProviderContext, ProviderEvent>) { super('antigravity', native); }

  /** Maps app-facing options onto the Antigravity runtime. */
  static mapOptions(options: HarnessOptions): AntigravityProviderOptions {
    const instructions = options.instructions;
    return {
      ...sharedProviderOptions(options, permissionOf),
      antigravity: {
        client: { ...options.client, ...(options.trustedMcpServerName ? { trustedMcpServerName: options.trustedMcpServerName } : {}) },
        ...(options.isBookkeepingTool ? { isBookkeepingTool: options.isBookkeepingTool } : {}),
        ...(instructions ? { instructions: (native: ProviderContext, { planMode }: { planMode: boolean }) => instructions(harnessContext(native, permissionOf), { planMode }) } : {}),
        ...(options.antigravity?.command || options.antigravity?.harnessPath ? { resolveRuntime: () => resolveAcpRuntime(options.stateDirectory?.(), { command: options.antigravity?.command, harnessPath: options.antigravity?.harnessPath }) } : {}),
      },
    };
  }

  /** Starts the Antigravity runtime without connecting, authenticating or executing a turn. */
  static createHost<Context extends ProviderContext = ProviderContext>(options: AntigravityProviderOptions<Context>): ProviderDriver<Context, ProviderEvent> {
    const home = providerHome(options);
    return new AntigravityHost({ ...options.antigravity,
      ...(home ? { home: () => home } : options.stateDirectory ? { home: () => antigravityHome(options.stateDirectory!()) } : {}),
      stateDirectory: options.stateDirectory ?? options.antigravity?.stateDirectory,
      instructions: options.antigravity?.instructions ?? (options.instructions ? (context: Context) => options.instructions!(context) : undefined),
      formatPrompt: options.formatPrompt ?? options.antigravity?.formatPrompt,
      ...(options.mcpServers ? { mcpServers: bridgedMcpServers(options, 'antigravity', antigravityHarnessCapabilities) } : {}),
      client: { ...options.antigravity?.client, ...options.client },
    });
  }

  protected createProjection(): HarnessProjection {
    return replicaProjection({
      snapshotEvent: 'antigravity.conversationSnapshotChanged', conversationEvent: 'antigravity.conversationEventReceived', label: 'Antigravity',
      create: createAntigravityConversationReplica,
      apply: (replica, event) => replica.apply(event),
      state: replica => transcriptState(replica.getSnapshot()),
    });
  }
}
