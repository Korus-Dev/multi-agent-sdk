/** Engine types for the SDK's own tests and examples. Not part of the package exports. */
export type * from './core/codex-host';
export type * from './providers/codex';
export type * from './core/host-bridge';
export type { ProviderEvent, ProviderDriver, ProviderContext } from './driver';
export type { ProviderOptions } from './harnesses';
export type { ProviderEvent as NativeHarnessEvent, ProviderDriver as NativeHarnessDriver, ProviderContext as NativeHarnessContext } from './driver';
export type { ProviderOptions as NativeHarnessOptions } from './harnesses';
import { harnesses, type ProviderOptions } from './harnesses';
import type { ProviderContext } from './context';
import type { ProviderDriver, ProviderEvent } from './driver';
import type { Harness, HarnessProvider } from './consumer-types';
/** A Harness over a provider built from internal options, for tests that inject fake clients, runtimes and transports. */
export function createInternalHarness(provider: HarnessProvider, options: ProviderOptions): Harness { const type = harnesses[provider]; return new type(type.createHost(options)); }
/** A Harness over an already-built native runtime, for tests that script one. */
export function harnessForHost(provider: HarnessProvider, native: ProviderDriver<ProviderContext, ProviderEvent>): Harness { return new harnesses[provider](native); }
