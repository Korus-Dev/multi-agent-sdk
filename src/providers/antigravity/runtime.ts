import { homedir } from 'node:os';
import path from 'node:path';
import { resolveRuntimeExecutable, withDiscoveredRuntimePath } from '../../runtime/discovery';

/** The first Antigravity CLI whose ACP server offers every model on the account. The CLI updates itself, so no exact version is required. */
export const antigravityMinimumVersion = '1.5.1';

/** A comparable number for a CLI version such as `1.5.6`; null for anything else. */
export function antigravityVersion(value: unknown): number | null {
  const match = typeof value === 'string' ? /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim()) : null;
  return match ? Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3]) : null;
}

/** Where Antigravity keeps conversations and settings: the app's own folder when it has one, else the CLI's. */
export function antigravityHome(dataDirectory?: string): string {
  return dataDirectory ? path.join(dataDirectory, 'antigravity-home') : path.join(homedir(), '.gemini');
}

/** The folder inside a home where the CLI keeps each conversation's files, such as a plan it wrote. */
export function antigravityConversationDirectory(home: string, sessionId: string): string {
  return path.join(home, 'antigravity-cli', 'brain', sessionId);
}

/** An explicit host path overrides PATH discovery. A missing explicit path never falls back. */
export type AcpRuntimeConfiguration = { command?: string };

/** The globally installed Antigravity CLI, started as an ACP server. */
export function resolveAcpRuntime(configuration: AcpRuntimeConfiguration = {}): { command: string; args: string[] } | null {
  const command = resolveRuntimeExecutable(configuration.command?.trim() || (process.platform === 'win32' ? 'agy.exe' : 'agy'));
  return command ? { command, args: ['acp'] } : null;
}

/**
 * The arguments that make the CLI use `home`. It takes the folder relative to the user's home directory, and uses
 * its own `~/.gemini` when none is given. The folder holds conversations and settings; sign-in is the CLI's own and
 * is shared by every home on the machine.
 */
export function acpHomeArguments(home: string): string[] {
  const relative = path.relative(homedir(), path.resolve(home));
  return relative === '.gemini' ? [] : ['--gemini-dir', relative];
}

export function acpEnvironment(temp: string, environment = withDiscoveredRuntimePath(undefined)): NodeJS.ProcessEnv {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_|GOOGLE_GENAI_|AGY_ACP_)/.test(key)) delete env[key];
  }
  return { ...env, TMPDIR: temp };
}
