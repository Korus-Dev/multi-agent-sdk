import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { AcpConnection, record } from '../../acp/acp-connection';
import { acpEnvironment, acpHomeArguments, antigravityHome, antigravityMinimumVersion, antigravityVersion, resolveAcpRuntime } from './runtime';

export class NativeLoginRequired extends Error {
  constructor() { super('Sign in to Antigravity with Google in Settings.'); }
}

/** Owns one qualified runtime and its private temporary files, never its credentials. */
export class AcpRuntime {
  readonly connection: AcpConnection;
  private loginRequired = false;
  private closing?: Promise<void>;

  private constructor(private readonly temp: string, options: Omit<ConstructorParameters<typeof AcpConnection>[0], 'displayName' | 'loginRequiredMarker'>) {
    this.connection = new AcpConnection({
      ...options, displayName: 'Antigravity',
      loginRequiredMarker: 'Open the following link to authenticate the ACP server:',
      onLoginRequired: () => {
        this.loginRequired = true;
        options.onLoginRequired?.();
      },
    });
  }

  static async open(options: {
    runtime?: NonNullable<ReturnType<typeof resolveAcpRuntime>>;
    cwd: string;
    home?: string;
    interactive?: boolean;
    signal?: AbortSignal;
    filesystem?: boolean | 'read-only';
    client?: { name: string; title?: string; version?: string; temporaryDirectory?: string };
    environment?: typeof acpEnvironment;
    onRequest: ConstructorParameters<typeof AcpConnection>[0]['onRequest'];
    onNotification: ConstructorParameters<typeof AcpConnection>[0]['onNotification'];
    onClose: ConstructorParameters<typeof AcpConnection>[0]['onClose'];
  }): Promise<AcpRuntime> {
    const runtime = options.runtime ?? resolveAcpRuntime();
    if (!runtime) throw new Error('Install the Antigravity CLI (agy) to use Antigravity.');
    const home = options.home ?? antigravityHome();
    await mkdir(home, { recursive: true, mode: 0o700 });
    const temporaryRoot = path.join(home, options.client?.temporaryDirectory ?? 'tmp');
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(path.join(temporaryRoot, 'acp-'));
    if (options.signal?.aborted) { await rm(temp, { recursive: true, force: true }); throw new Error('Antigravity authentication cancelled.'); }
    const env = (options.environment ?? acpEnvironment)(temp);
    // Python's native webbrowser honors this command. It receives the URL as an
    // ignored argument and succeeds, preventing fallback to the user's browser.
    if (!options.interactive) env.BROWSER = `${quoteBrowserArgument(process.execPath)} -e 'process.exit(0)' %s`;
    let instance: AcpRuntime;
    instance = new AcpRuntime(temp, { ...options, ...runtime, args: [...runtime.args, ...acpHomeArguments(home)], env,
      onLoginRequired: options.interactive ? undefined : () => { void instance.connection.close(); },
    });
    const abort = () => { void instance.close(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      instance.connection.start();
      const initialization = await instance.connection.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: options.client?.name ?? 'multi-agent-sdk', ...(options.client?.title ? { title: options.client.title } : {}), version: options.client?.version ?? '1' },
        clientCapabilities: { fs: { readTextFile: options.filesystem !== false, writeTextFile: options.filesystem !== false && options.filesystem !== 'read-only' }, terminal: false },
      });
      // The CLI updates itself, so any version from the first supported one on is accepted.
      const version = record(initialization) && record(initialization.agentInfo) ? antigravityVersion(initialization.agentInfo.version) : null;
      if (!record(initialization) || initialization.protocolVersion !== 1 || version === null || version < antigravityVersion(antigravityMinimumVersion)!) {
        throw new Error(`Antigravity requires the Antigravity CLI ${antigravityMinimumVersion} or later. Update it with \`agy update\`.`);
      }
      return instance;
    } catch (error) { await instance.close(); throw error; }
    finally { options.signal?.removeEventListener('abort', abort); }
  }

  async authenticate(): Promise<void> {
    try { await this.connection.request('authenticate', { methodId: 'oauth-personal' }, 330_000); }
    catch (error) { if (this.loginRequired) throw new NativeLoginRequired(); throw error; }
  }

  close(): Promise<void> {
    return this.closing ??= this.connection.close().finally(() => rm(this.temp, { recursive: true, force: true }));
  }
}

function quoteBrowserArgument(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
