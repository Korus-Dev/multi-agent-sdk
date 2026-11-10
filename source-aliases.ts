import { sdkSources } from './scripts/sdk-sources.mjs';
export const sourceAliases = sdkSources(import.meta.dirname).aliases;
