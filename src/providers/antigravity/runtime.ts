import { homedir } from 'node:os';
import path from 'node:path';
import { resolveRuntimeExecutable, withDiscoveredRuntimePath } from '../../runtime/discovery';
import { defaultRuntimeDirectory } from '../../runtime/paths';
import { acpReleaseVersion, resolveAcpReleaseAsset } from './release';

export const acpVersion = acpReleaseVersion;

export function managedRuntimeDirectory(dataDirectory = defaultRuntimeDirectory()): string | null {
  const asset = resolveAcpReleaseAsset();
  return asset ? path.join(dataDirectory, 'antigravity', `${acpVersion}-${process.platform}-${process.arch}-${asset.sha256}`) : null;
}

function runtimeDirectory(dataDirectory: string): string { return path.join(dataDirectory, 'antigravity', acpVersion); }
export function antigravityHome(dataDirectory?: string): string { return process.env.GEMINI_HOME || (dataDirectory ? path.join(dataDirectory, 'antigravity-home') : path.join(homedir(), '.gemini')); }

/** Explicit host paths override managed/PATH discovery. A missing explicit path never falls back. */
export type AcpRuntimeConfiguration = { command?: string; harnessPath?: string };

export function resolveAcpRuntime(dataDirectory = defaultRuntimeDirectory(), configuration: AcpRuntimeConfiguration = {}): { command: string; harness: string; args: string[] } | null {
  const executable = process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par';
  const companion = process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external';
  const command = configuration.command?.trim()
    ? resolveRuntimeExecutable(configuration.command.trim())
    : resolveRuntimeExecutable(path.join(managedRuntimeDirectory(dataDirectory) ?? runtimeDirectory(dataDirectory), executable))
      ?? resolveRuntimeExecutable(executable) ?? resolveRuntimeExecutable(path.join(runtimeDirectory(dataDirectory), executable));
  if (!command) return null;
  const harness = resolveRuntimeExecutable(configuration.harnessPath?.trim() || process.env.ANTIGRAVITY_HARNESS_PATH || path.join(path.dirname(command), companion));
  return harness ? { command, harness, args: process.platform === 'linux' ? ['--uid='] : [] } : null;
}

export function acpEnvironment(home: string, harness: string, temp: string, environment = withDiscoveredRuntimePath(undefined)): NodeJS.ProcessEnv {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_|GOOGLE_GENAI_|AGY_ACP_)/.test(key)) delete env[key];
  }
  return { ...env, GEMINI_HOME: home, ANTIGRAVITY_HARNESS_PATH: harness,
    AGY_ACP_FORCE_FILE_STORAGE: '1', PYTHONUNBUFFERED: '1', TMPDIR: temp };
}
