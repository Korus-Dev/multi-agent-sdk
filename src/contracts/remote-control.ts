export type DevicePairingStatus = {
  status: 'disabled' | 'connecting' | 'connected' | 'errored';
  serverName?: string;
  installationId?: string;
  environmentId?: string | null;
  allowRemoteControl?: boolean | null;
  detail?: string;
};
export type DevicePairingSession = {
  pairingCode: string;
  manualPairingCode?: string | null;
  environmentId: string;
  expiresAt: string;
};
export type PairedDevice = {
  clientId: string;
  displayName?: string | null;
  deviceType?: string | null;
  platform?: string | null;
  osVersion?: string | null;
  deviceModel?: string | null;
  appVersion?: string | null;
  lastSeenAt?: string | null;
};