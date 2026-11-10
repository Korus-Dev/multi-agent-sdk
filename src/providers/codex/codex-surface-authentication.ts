import type { v2 } from 'codex-sdk';
import type { CodexSurfaceAuthentication } from 'multi-agents-sdk/surface';

export function initialAuthentication(): CodexSurfaceAuthentication {
  return {
    status: 'notLoaded',
    account: null,
    requiresOpenaiAuth: null,
    error: null,
    login: {
      status: 'idle',
      loginId: null,
      authUrl: null,
      error: null,
    },
  };
}

type CompatibleAccount = Exclude<v2.Account, { type: 'chatgpt' }>
  | (Omit<Extract<v2.Account, { type: 'chatgpt' }>, 'workspaceName'> & { workspaceName?: string | null });

export function surfaceAccount(account: CompatibleAccount): NonNullable<CodexSurfaceAuthentication['account']> {
  if (account.type === 'chatgpt') {
    return { type: 'chatgpt', email: account.email, planType: account.planType,
      ...(typeof account.workspaceName === 'string' ? { workspaceName: account.workspaceName } : {}),
    };
  }
  if (account.type === 'gcp') return { type: 'gcp' };
  if (account.type === 'amazonBedrock') {
    return {
      type: 'amazonBedrock',
      credentialSource: account.usesCodexManagedCredentials ? 'codexManaged' : 'awsManaged',
    };
  }
  return { type: 'apiKey' };
}

export function surfaceAuthenticationKey(authentication: CodexSurfaceAuthentication): string {
  return JSON.stringify({
    account: authentication.account,
    requiresOpenaiAuth: authentication.requiresOpenaiAuth,
  });
}

export function surfaceAuthenticationIdentityKey(authentication: CodexSurfaceAuthentication): string {
  const account = authentication.account;
  if (!account) {
    return JSON.stringify({ type: null, requiresOpenaiAuth: authentication.requiresOpenaiAuth });
  }
  if (account.type === 'chatgpt') return JSON.stringify({ type: account.type, email: account.email,
    ...(account.workspaceName === undefined ? {} : { workspaceName: account.workspaceName }),
  });
  if (account.type === 'amazonBedrock') {
    return JSON.stringify({ type: account.type, credentialSource: account.credentialSource });
  }
  return JSON.stringify({ type: account.type });
}

export function normalizedLoginId(value: string): string {
  const loginId = value.trim();
  if (!loginId) throw new Error('Codex login id cannot be empty');
  return loginId;
}

export function safeLoginUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Codex account/login/start returned an invalid authentication URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Codex account/login/start returned unsupported authentication URL scheme '${url.protocol}'`);
  }
  return url.href;
}
