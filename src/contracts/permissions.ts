import type { HarnessProvider } from './shared';

/** Codex approval presets. */
export type CodexPermission = 'ask-for-approval' | 'approve-for-me' | 'full-access';
/** Claude permission modes. */
export type ClaudePermission = 'default' | 'acceptEdits' | 'dontAsk' | 'auto' | 'bypassPermissions';
/** Cursor permission modes. */
export type CursorPermission = 'default' | 'full-access';
/** Antigravity permission modes. */
export type AntigravityPermission = 'default' | 'auto_edit';

type PermissionByProvider = { codex: CodexPermission; claude: ClaudePermission; cursor: CursorPermission; antigravity: AntigravityPermission };
/**
 * The permission ids a provider accepts. A harness whose provider is known only at runtime takes any id,
 * which it checks against `getCapabilities().permissions`.
 */
export type PermissionFor<P extends HarnessProvider> = [HarnessProvider] extends [P] ? string : PermissionByProvider[P];
