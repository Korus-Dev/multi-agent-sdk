import type { CodexAuthentication } from './backend';
import type { ClaudeAuthentication } from './claude-authentication';

export type ProviderAuthenticationAction = { action: 'check' | 'cancel' | 'logout' | 'login'; loginId?: string };
export type ProviderAuthentication =
  | { kind: 'codex'; connected: boolean; state: CodexAuthentication }
  | { kind: 'claude'; connected: boolean; state: ClaudeAuthentication }
  | { kind: 'cursor'; connected: boolean; state: { loggedIn: boolean; homePath: string; version?: string; supported?: boolean; error?: string; account?: { type: 'subscription'; email?: string }; team?: string } }
  | { kind: 'antigravity'; connected: boolean; state: { loggedIn: boolean; homePath: string } };
