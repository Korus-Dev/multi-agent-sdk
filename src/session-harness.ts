import type { ProviderContext } from './context';
import type { ProviderCapabilities, ProviderConversationRef, ProviderDefaults, ProviderSessionData } from './contracts';
import type { HarnessCapabilities, HarnessProvider } from './consumer-types';
import type { ProviderEvent } from './contracts/events';
import { ProviderHarness } from './harness';

/** A harness whose conversations are named by a session id and whose permissions are native permission modes. */
export abstract class SessionHarness<P extends HarnessProvider = HarnessProvider> extends ProviderHarness<P> {
  protected identityOf(data: Record<string, unknown>): unknown { return data.sessionId; }
  protected conversationRef(data: ProviderSessionData, context: ProviderContext): ProviderConversationRef {
    return { provider: data.kind, sessionId: (data as { sessionId: string }).sessionId, folder: context.folder } as ProviderConversationRef;
  }
  protected override validateRefData(data: Record<string, unknown>): void {
    if (data.folder !== null && typeof data.folder !== 'string') throw new Error('Invalid persisted folder.');
  }
  protected permissionDefaults(id: string): Partial<ProviderDefaults> { return { permissionMode: id } as Partial<ProviderDefaults>; }
  protected permissionOf(defaults: ProviderDefaults): string | undefined { return 'permissionMode' in defaults ? defaults.permissionMode : undefined; }
  protected permissionOptions(capabilities: ProviderCapabilities): HarnessCapabilities['permissions'] {
    return (capabilities.permissionModes ?? []).map(({ id, dangerous }) => ({ id, ...(dangerous ? { dangerous } : {}) }));
  }
  protected permissionFromEvent(event: ProviderEvent): string | null | undefined {
    if (event.type === 'conversation.modeUpdated') return event.payload.permissionMode;
    if (event.type === 'conversation.settingsUpdated') return event.payload.settings.permissionMode;
    return undefined;
  }
  protected async applyPermission(context: ProviderContext, id: string): Promise<string | undefined> {
    if (!this.native.setPermissionMode) throw new Error('Permission updates are unavailable.');
    context.providerDefaults = (await this.native.setPermissionMode(context, id)).providerDefaults;
    return this.permissionOf(context.providerDefaults);
  }
}
