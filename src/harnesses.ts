import type { HarnessProvider, ProviderCapabilities, ProviderSessionData } from './contracts';
import type { ProviderContext } from './context';
import type { ProviderDriver, ProviderEvent } from './driver';
import type { HarnessOptions } from './options';
import type { ProviderHarness } from './harness';
import type { SharedProviderOptions } from './harness-options';
import { CodexHarness, type CodexProviderOptions } from './providers/codex/harness';
import { ClaudeHarness, type ClaudeProviderOptions } from './providers/claude/harness';
import { CursorHarness, type CursorProviderOptions } from './providers/cursor/harness';
import { AntigravityHarness, type AntigravityProviderOptions } from './providers/antigravity/harness';

/** Internal options of every harness, for tests that inject fake runtimes. */
export type ProviderOptions<Context extends ProviderContext = ProviderContext> = SharedProviderOptions<Context>
  & CodexProviderOptions<Context> & ClaudeProviderOptions<Context> & CursorProviderOptions<Context> & AntigravityProviderOptions<Context>;

/** What the registry needs from a harness class. */
export type HarnessClass = {
  readonly capabilities: ProviderCapabilities;
  new (native: ProviderDriver<ProviderContext, ProviderEvent>, rules?: import('./conversations/work-phases').WorkPhaseRules): ProviderHarness;
  mapOptions(options: HarnessOptions): ProviderOptions;
  createHost<Context extends ProviderContext = ProviderContext>(options: ProviderOptions<Context>): ProviderDriver<Context, ProviderEvent>;
  sessionData(id: string, folder: string | null): ProviderSessionData;
};

/** Every harness the SDK offers. Adding one means one class and one line here. */
export const harnesses: Record<HarnessProvider, HarnessClass> = {
  codex: CodexHarness,
  claude: ClaudeHarness,
  cursor: CursorHarness,
  antigravity: AntigravityHarness,
};

/** A provider runtime from internal options, without connecting, authenticating or executing a turn. */
export function createProviderHost<Context extends ProviderContext = ProviderContext>(provider: HarnessProvider, options: ProviderOptions<Context>): ProviderDriver<Context, ProviderEvent> {
  const type = harnesses[provider];
  if (!type) throw new Error(`Unsupported harness: ${provider}`);
  return type.createHost(options);
}
