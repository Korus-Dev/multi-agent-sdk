import type { CodexAuthentication } from './provider';
import type { ClaudeAuthentication } from './claude-authentication';

/** `method` chooses the managed login flow where a provider offers several; omitted means the first supported method. */
export type ProviderAuthenticationAction = { action: 'check' | 'cancel' | 'logout' | 'login'; loginId?: string; method?: AuthenticationLoginMethod };
export type AuthenticationLoginMethod = 'browser' | 'deviceCode';
/** A started managed login: open `url` (and show `code` for device-code flows) until the provider reports completion. */
export type AuthenticationLogin =
  | { method: 'browser'; id: string; url: string }
  | { method: 'deviceCode'; id: string; url: string; code: string };
export type ProviderAuthentication = ProviderAuthenticationState & { login?: AuthenticationLogin };
type ProviderAuthenticationState =
  | { kind: 'codex'; connected: boolean; state: CodexAuthentication }
  | { kind: 'claude'; connected: boolean; state: ClaudeAuthentication }
  | { kind: 'cursor'; connected: boolean; state: { loggedIn: boolean; homePath: string; version?: string; supported?: boolean; error?: string; account?: { type: 'subscription'; email?: string }; team?: string } }
  | { kind: 'antigravity'; connected: boolean; state: { loggedIn: boolean; homePath: string } };
