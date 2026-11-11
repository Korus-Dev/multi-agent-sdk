import { adaptHarness } from './consumer';
import type { Harness, HarnessProvider } from './consumer-types';
import type { HarnessOptions } from './options';
import { providerOptions } from './options-map';
import { createProviderDriver } from './provider-factory';

/** No provider turn is started until a consumer explicitly sends a prompt. */
export function createHarness(provider: HarnessProvider, options: HarnessOptions): Harness {
  return adaptHarness(provider, createProviderDriver(provider, providerOptions(options)));
}
