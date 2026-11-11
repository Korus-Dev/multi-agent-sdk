import type { Harness, HarnessProvider } from './consumer-types';
import type { HarnessOptionsFor } from './options';
import { harnesses } from './harnesses';

/** No provider turn is started until a consumer explicitly sends a prompt. */
export function createHarness<P extends HarnessProvider>(provider: P, options: HarnessOptionsFor<P>): Harness {
  const type = harnesses[provider];
  if (!type) throw new Error(`Unsupported harness: ${provider}`);
  return new type(type.createHost(type.mapOptions(options)));
}
