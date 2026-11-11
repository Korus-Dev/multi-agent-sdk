/** Engine types for the SDK's own tests and examples. Not part of the package exports. */
export type * from './core/codex-host';
export type * from './providers/codex';
export type * from './core/host-bridge';
export type { ProviderEvent, ProviderDriver, ProviderContext } from './driver';
export type { ProviderOptions } from './provider-factory';
export type { ProviderEvent as NativeHarnessEvent, ProviderDriver as NativeHarnessDriver, ProviderContext as NativeHarnessContext } from './driver';
export type { ProviderOptions as NativeHarnessOptions } from './provider-factory';
import { adaptHarness } from './consumer';
import { createProviderDriver } from './provider-factory';
import type { ProviderOptions } from './provider-factory';
import type { Harness, HarnessProvider } from './consumer-types';
/** A Harness over a provider built from internal options, for tests that inject fake clients, runtimes and transports. */
export function createInternalHarness(provider: HarnessProvider, options: ProviderOptions): Harness { return adaptHarness(provider, createProviderDriver(provider, options)); }
