import type { ProviderContext } from '../../context';
import type { ProviderDefaults, ProviderSessionData } from '../../contracts';
import type { ProviderDriver, ProviderEvent } from '../../driver';
import type { HarnessOptions } from '../../options';
import { SessionHarness } from '../../session-harness';
import { antigravityHarnessCapabilities } from '../../capabilities';
import { bridgedMcpServers, harnessContext, providerHome, sharedProviderOptions, type SharedProviderOptions } from '../../harness-options';
import { replicaProjection, transcriptState, type HarnessProjection } from '../../harness-projection';
import { createAntigravityConversationReplica } from '../../conversations/antigravity-conversation-replica';
import type { WorkPhaseRules } from '../../conversations/work-phases';
import { AntigravityHost, type AntigravityHostOptions } from './host';
import { antigravityHome, resolveAcpRuntime } from './runtime';
import { transcriptActivity } from '../../conversations/conversation-activity';

export type AntigravityProviderOptions<Context extends ProviderContext = ProviderContext> = SharedProviderOptions<Context> & { antigravity?: AntigravityHostOptions<Context> };

const permissionOf = (defaults: ProviderDefaults) => defaults.permission;

export class AntigravityHarness extends SessionHarness<'antigravity'> {
  static readonly provider = 'antigravity';
  static readonly capabilities = antigravityHarnessCapabilities;
  /** A fresh session record for a conversation id. */
  static sessionData(id: string, folder: string | null): ProviderSessionData { return { kind: 'antigravity', sessionId: id, folder } as ProviderSessionData; }

  /** Antigravity keeps a session on its live conversation unless told which other one to use, so a cleared session lets go of it first. */
  protected override startingOver(context: ProviderContext) { return this.native.releaseConversation?.(context.id); }

  constructor(native: ProviderDriver<ProviderContext, ProviderEvent>, rules?: WorkPhaseRules) { super('antigravity', native, rules); }

  /** Maps app-facing options onto the Antigravity runtime. */
  static mapOptions(options: HarnessOptions): AntigravityProviderOptions {
    const instructions = options.instructions;
    return {
      ...sharedProviderOptions(options, permissionOf),
      antigravity: {
        client: { ...options.client, ...(options.trustedMcpServerName ? { trustedMcpServerName: options.trustedMcpServerName } : {}) },
        ...(options.isBookkeepingTool ? { isBookkeepingTool: options.isBookkeepingTool } : {}),
        ...(instructions ? { instructions: (native: ProviderContext, { planMode }: { planMode: boolean }) => instructions(harnessContext(native, permissionOf), { planMode }) } : {}),
        ...(options.antigravity?.command ? { resolveRuntime: () => resolveAcpRuntime({ command: options.antigravity?.command }) } : {}),
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

  protected activityOf(frame: ProviderEvent) { return frame.type === 'antigravity.conversationEventReceived' ? transcriptActivity(frame.payload.event, frame.payload.event.sessionId) : []; }
  protected createProjection(): HarnessProjection {
    return replicaProjection({
      snapshotEvent: 'antigravity.conversationSnapshotChanged', conversationEvent: 'antigravity.conversationEventReceived', label: 'Antigravity',
      create: snapshot => createAntigravityConversationReplica(snapshot, this.phaseRules),
      apply: (replica, event) => replica.apply(event),
      state: replica => transcriptState(replica.getSnapshot()),
    });
  }
}
