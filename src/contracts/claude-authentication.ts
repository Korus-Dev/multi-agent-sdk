export type ClaudeAuthentication = {
  /** Selected executable on the owning host, for user-run login commands. */
  executablePath?: string;
  loggedIn: boolean;
  account?: { type: 'subscription' | 'apiKey'; email?: string; subscription?: string };
  /** Local CLI override; null means leave CLAUDE_CONFIG_DIR unset for the default login. */
  configDirectory?: string | null;
};