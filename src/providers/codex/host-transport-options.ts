import { isAbsolute } from 'node:path';
import type { CodexAppServerTransportOptions, CodexHostOptions } from './host-contracts';
import type { CodexAppServerUnixSocketTransportOptions } from '@korus-dev/codex-sdk';

export function isUnixSocketTransportOptions(
  options: CodexAppServerTransportOptions,
): options is CodexAppServerUnixSocketTransportOptions {
  return 'type' in options && options.type === 'unixSocket';
}

export function hostTransportOptions(options: CodexHostOptions): CodexAppServerTransportOptions {
  const topLevelHome = options.codexHome === undefined
    ? undefined
    : absoluteCodexHome(options.codexHome);
  const transportHome = options.transport?.codexHome;
  if (topLevelHome !== undefined && transportHome !== undefined && topLevelHome !== transportHome) {
    throw new Error('Codex host codexHome conflicts with transport.codexHome');
  }
  const transport = options.transport ?? {};
  return {
    ...transport,
    ...(topLevelHome === undefined ? {} : { codexHome: topLevelHome }),
  };
}

export function absoluteCodexHome(value: string): string {
  const codexHome = value.trim();
  if (!codexHome) throw new Error('Codex host codexHome cannot be empty');
  if (!isAbsolute(codexHome)) throw new Error('Codex host codexHome must be an absolute path');
  return codexHome;
}
