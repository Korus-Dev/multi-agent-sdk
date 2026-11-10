import type {
  CodexSurfaceBridgeOperation,
  CodexSurfaceBridgeOperationResult,
} from 'multi-agents-sdk/surface-bridge';
import type {
  CodexSurfaceEvent,
  CodexSurfaceSnapshot,
  CodexSurfaceStatePatch,
} from 'multi-agents-sdk/surface';

export const codexWebSocketProtocolVersion = 1 as const;

export type CodexWebSocketRequest = {
  version: typeof codexWebSocketProtocolVersion;
  type: 'request';
  id: string;
  operation: CodexSurfaceBridgeOperation;
  args: unknown[];
};

export type CodexWebSocketReady = {
  version: typeof codexWebSocketProtocolVersion;
  type: 'ready';
  snapshot: CodexSurfaceSnapshot;
  /**
   * Present when the server can stream state patches. A client that supports
   * them answers with `enableStatePatches`; others ignore it and keep
   * receiving `snapshot` messages.
   */
  stateVersion?: number;
};

export type CodexWebSocketSuccess<Name extends CodexSurfaceBridgeOperation = CodexSurfaceBridgeOperation> = {
  version: typeof codexWebSocketProtocolVersion;
  type: 'response';
  id: string;
  ok: true;
  result: CodexSurfaceBridgeOperationResult<Name>;
};

export type CodexWebSocketErrorPayload = {
  code: 'invalid_request' | 'operation_failed' | 'request_timeout' | 'transport_closed';
  message: string;
};

export type CodexWebSocketFailure = {
  version: typeof codexWebSocketProtocolVersion;
  type: 'response';
  id: string;
  ok: false;
  error: CodexWebSocketErrorPayload;
};

export type CodexWebSocketSnapshot = {
  version: typeof codexWebSocketProtocolVersion;
  type: 'snapshot';
  snapshot: CodexSurfaceSnapshot;
  /** Present on the base snapshot that starts a patch stream; patches continue from it. */
  stateVersion?: number;
};

export type CodexWebSocketEvent = {
  version: typeof codexWebSocketProtocolVersion;
  type: 'event';
  event: CodexSurfaceEvent;
};

/** Client opt-in, sent only after a `ready` that carries `stateVersion`. */
export type CodexWebSocketEnableStatePatches = {
  version: typeof codexWebSocketProtocolVersion;
  type: 'enableStatePatches';
};

/** Sent instead of `snapshot` once a client has enabled state patches. */
export type CodexWebSocketStatePatch = {
  version: typeof codexWebSocketProtocolVersion;
  type: 'statePatch';
  patch: CodexSurfaceStatePatch;
};

export type CodexWebSocketClientMessage = CodexWebSocketRequest;
export type CodexWebSocketServerMessage =
  | CodexWebSocketReady
  | CodexWebSocketSuccess
  | CodexWebSocketFailure
  | CodexWebSocketSnapshot
  | CodexWebSocketEvent;

export function encodeCodexWebSocketMessage(
  message:
    | CodexWebSocketClientMessage
    | CodexWebSocketServerMessage
    | CodexWebSocketEnableStatePatches
    | CodexWebSocketStatePatch,
): string {
  return JSON.stringify(message);
}
