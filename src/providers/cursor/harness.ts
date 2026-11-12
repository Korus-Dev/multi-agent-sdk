import type { ProviderContext } from '../../context';
import type { ProviderDefaults, ProviderSessionData } from '../../contracts';
import type { ProviderDriver, ProviderEvent } from '../../driver';
import type { HarnessOptions } from '../../options';
import { SessionHarness } from '../../session-harness';
import { cursorHarnessCapabilities } from '../../capabilities';
import { bridgedMcpServers, providerHome, sharedProviderOptions, type SharedProviderOptions } from '../../harness-options';
import { replicaProjection, transcriptState, type HarnessProjection } from '../../harness-projection';
import { createCursorConversationReplica } from '../../conversations/cursor-conversation-replica';
import type { WorkPhaseRules } from '../../conversations/work-phases';
import { CursorHost, type CursorHostOptions } from './host';
import { cursorRuntime } from './runtime';
import { transcriptActivity } from '../../conversations/conversation-activity';

export type CursorProviderOptions<Context extends ProviderContext = ProviderContext> = SharedProviderOptions<Context> & { cursor?: CursorHostOptions<Context> };

const permissionOf = (defaults: ProviderDefaults) => defaults.permission;

export class CursorHarness extends SessionHarness<'cursor'> {
  static readonly provider = 'cursor';
  static readonly capabilities = cursorHarnessCapabilities;
  /** A fresh session record for a conversation id. */
  static sessionData(id: string, folder: string | null): ProviderSessionData { return { kind: 'cursor', conversationId: id, folder } as ProviderSessionData; }

  constructor(native: ProviderDriver<ProviderContext, ProviderEvent>, rules?: WorkPhaseRules) { super('cursor', native, rules); }

  protected override accountOf(native: import('../../contracts/authentication').ProviderAuthentication) {
    if (native.kind !== 'cursor' || !native.state.account) return null;
    const { email } = native.state.account, team = native.state.team;
    return { kind: 'subscription' as const, ...(email ? { email } : {}), ...(typeof team === 'string' && team ? { team } : {}) };
  }

  /** Cursor keeps a session on the conversation it holds unless told which other one to use, so a cleared session lets go of it first. */
  protected override startingOver(context: ProviderContext) { return this.native.releaseConversation?.(context.id); }

  /** Maps app-facing options onto the Cursor runtime. */
  static mapOptions(options: HarnessOptions): CursorProviderOptions {
    return {
      ...sharedProviderOptions(options, permissionOf),
      cursor: {
        ...(options.cursor?.command ? { resolveCommand: options.cursor.command } : {}),
        ...(options.cursor?.steeringFallback ? { steeringFallbackEnabled: options.cursor.steeringFallback } : {}),
        ...(options.trustedMcpServerName ? { trustedMcpServerName: options.trustedMcpServerName } : {}),
        sessionOptions: { client: options.client, ...(options.cursor?.command ? { resolveCommand: options.cursor.command } : {}), ...(options.isBookkeepingTool ? { isBookkeepingTool: options.isBookkeepingTool } : {}) },
      },
    };
  }

  /** Starts the Cursor runtime without connecting, authenticating or executing a turn. */
  static createHost<Context extends ProviderContext = ProviderContext>(options: CursorProviderOptions<Context>): ProviderDriver<Context, ProviderEvent> {
    const home = providerHome(options);
    return new CursorHost({ ...options.cursor,
      ...(home ? { runtime: cursorRuntime({ isolated: true, homePath: home }, options.cursor?.runtime?.environment) } : {}),
      stateDirectory: options.stateDirectory ?? options.cursor?.stateDirectory,
      instructions: options.instructions ?? options.cursor?.instructions,
      formatPrompt: options.formatPrompt ?? options.cursor?.formatPrompt,
      ...(options.mcpServers ? { mcpServers: bridgedMcpServers(options, 'cursor', cursorHarnessCapabilities) } : {}),
      sessionOptions: { ...options.cursor?.sessionOptions, client: options.client },
    });
  }

  protected activityOf(frame: ProviderEvent) { return frame.type === 'cursor.conversationEventReceived' ? transcriptActivity(frame.payload.event, frame.payload.event.sessionId) : []; }
  protected createProjection(): HarnessProjection {
    return replicaProjection({
      snapshotEvent: 'cursor.conversationSnapshotChanged', conversationEvent: 'cursor.conversationEventReceived', label: 'Cursor',
      create: snapshot => createCursorConversationReplica(snapshot, this.phaseRules),
      apply: (replica, event) => replica.apply(event),
      state: replica => transcriptState(replica.getSnapshot()),
    });
  }
}
