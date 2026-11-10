import { isAbsolute } from 'node:path';
import type { CodexAppServerTransportOptions, CodexSurfaceOptions } from './codex-surface-contracts';
import type { CodexAppServerUnixSocketTransportOptions } from 'codex-sdk';

export function isUnixSocketTransportOptions(
  options: CodexAppServerTransportOptions,
): options is CodexAppServerUnixSocketTransportOptions {
  return 'type' in options && options.type === 'unixSocket';
}

export function surfaceTransportOptions(options: CodexSurfaceOptions): CodexAppServerTransportOptions {
  const topLevelHome = options.codexHome === undefined
    ? undefined
    : absoluteCodexHome(options.codexHome);
  const transportHome = options.transport?.codexHome;
  if (topLevelHome !== undefined && transportHome !== undefined && topLevelHome !== transportHome) {
    throw new Error('Codex surface codexHome conflicts with transport.codexHome');
  }
  const transport = options.transport ?? {};
  return {
    ...transport,
    ...(topLevelHome === undefined ? {} : { codexHome: topLevelHome }),
  };
}

export function absoluteCodexHome(value: string): string {
  const codexHome = value.trim();
  if (!codexHome) throw new Error('Codex surface codexHome cannot be empty');
  if (!isAbsolute(codexHome)) throw new Error('Codex surface codexHome must be an absolute path');
  return codexHome;
}
