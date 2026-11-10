import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolveRuntimeExecutable, resolveRuntimeLaunch, type RuntimeDiscoveryDependencies } from '../../runtime/discovery';

/** Keep queries, authentication and version inspection on the same runtime.
 * The host supplies packaged/custom paths explicitly. Otherwise discover the CLI on
 * the native runtime PATH, then try the vendor optional native package.
 */
export function resolveClaudeLaunch(
  configuredPath?: string,
  overrides?: NodeJS.ProcessEnv,
  dependencies: RuntimeDiscoveryDependencies = {},
  discoverLaunch = resolveRuntimeLaunch,
): ReturnType<typeof resolveRuntimeLaunch> {
  const configured = configuredPath?.trim();
  const launch = discoverLaunch(configured || 'claude', overrides, dependencies);
  if (configured || launch.command !== 'claude') return launch;
  const executable = bundledClaudeExecutable();
  return executable ? { ...launch, command: executable } : launch;
}

export function resolveClaudeExecutable(): string | null {
  return resolveRuntimeExecutable(resolveClaudeLaunch().command);
}

function bundledClaudeExecutable(): string | null {
  const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
  // Neutral fallback: the vendor optional native package, resolved by Node.
  try {
    const native = createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${executable}`);
    return existsSync(native) ? native : null;
  } catch { return null; } // Optional dependencies may be omitted on CLI-only hosts.
}
