import type { HarnessProvider } from './shared';

import type { harnessPermissionIds } from '../capabilities';

type Ids = typeof harnessPermissionIds;
/** Codex approval presets. */
export type CodexPermission = Ids['codex'][number];
/** Claude permission modes. */
export type ClaudePermission = Ids['claude'][number];
/** Cursor permission modes. */
export type CursorPermission = Ids['cursor'][number];
/** Antigravity permission modes. */
export type AntigravityPermission = Ids['antigravity'][number];

type PermissionByProvider = { [P in keyof Ids]: Ids[P][number] };
/**
 * The permission ids a provider accepts. A harness whose provider is known only at runtime takes any id,
 * which it checks against `getCapabilities().permissions`.
 */
export type PermissionFor<P extends HarnessProvider> = [HarnessProvider] extends [P] ? string : PermissionByProvider[P];
