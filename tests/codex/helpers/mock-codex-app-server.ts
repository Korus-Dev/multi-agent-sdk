import { vi } from 'vitest';
import type {
  CodexAppServerMethodMap,
  RpcId,
  RpcMessage,
  RpcTransport,
  ServerNotification,
  ServerRequest,
} from '../../../../codex-sdk/src/protocol';
import { codexSchemaCliVersion } from '../../../../codex-sdk/src/protocol/schema-version';

export type MockCodexAppServerMethod = keyof CodexAppServerMethodMap & string;
type Method = MockCodexAppServerMethod;
type Params<Selected extends Method> = CodexAppServerMethodMap[Selected]['params'];
type Result<Selected extends Method> = CodexAppServerMethodMap[Selected]['result'];
type Handler<Selected extends Method> = (params: Params<Selected>) => Result<Selected> | Promise<Result<Selected>>;
type NotificationMethod = ServerNotification['method'];
type Notification<Selected extends NotificationMethod> = Extract<ServerNotification, { method: Selected }>;
type ServerRequestMethod = ServerRequest['method'];
type AppServerRequest<Selected extends ServerRequestMethod> = Extract<ServerRequest, { method: Selected }>;

export type MockCodexAppServerHandlers = {
  [Selected in Method]?: Handler<Selected>;
};

export type MockCodexAppServerRequest<Selected extends Method> = {
  id: RpcId;
  params: Params<Selected>;
};

/**
 * Strict in-memory implementation of the app-server side of the JSON-RPC seam.
 *
 * Every public operation is derived from the generated protocol. Regenerating
 * that protocol therefore type-checks both test scenarios and this mock.
 */
export class MockCodexAppServer implements RpcTransport {
  static readonly schemaVersion = codexSchemaCliVersion;

  readonly sent: RpcMessage[] = [];
  readonly close = vi.fn(async () => undefined);
  readonly start = vi.fn(async () => undefined);
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  constructor(private readonly handlers: MockCodexAppServerHandlers = {}) {}

  send(message: RpcMessage): void {
    this.sent.push(message);
    if (!('id' in message) || !('method' in message)) return;

    const method = message.method as Method;
    const handler = this.handlers[method] as Handler<typeof method> | undefined;
    try {
      let response: unknown;
      if (handler) {
        response = handler(message.params as Params<typeof method>);
      } else {
        throw new Error(`Unexpected app-server request: ${message.method}`);
      }
      void Promise.resolve(response).then(
        (result) => this.emitResponse({ id: message.id, result }),
        (error: unknown) => this.emitResponse({ id: message.id, error: rpcTestError(error) }),
      );
    } catch (error) {
      queueMicrotask(() => this.emitResponse({ id: message.id, error: rpcTestError(error) }));
    }
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  emitNotification<Selected extends NotificationMethod>(
    method: Selected,
    params: Notification<Selected>['params'],
  ): void {
    this.emitResponse({ method, params });
  }

  emitNotificationFrame(notification: ServerNotification): void {
    this.emitResponse(notification);
  }

  emitServerRequest<Selected extends ServerRequestMethod>(
    id: RpcId,
    method: Selected,
    params: AppServerRequest<Selected>['params'],
  ): void {
    this.emitResponse({ id, method, params });
  }

  emitServerRequestFrame(request: ServerRequest): void {
    this.emitResponse(request);
  }

  emitResult<Selected extends Method>(
    request: MockCodexAppServerRequest<Selected>,
    result: Result<Selected>,
  ): void {
    this.emitResponse({ id: request.id, result });
  }

  /** Escape hatch for client protocol validation and deliberately legacy frames. */
  emitRaw(message: unknown): void {
    this.emitResponse(message);
  }

  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  requests<Selected extends Method>(method: Selected): MockCodexAppServerRequest<Selected>[] {
    return this.sent.flatMap((message) => {
      if (!('id' in message) || !('method' in message) || message.method !== method) return [];
      return [{ id: message.id, params: message.params as Params<Selected> }];
    });
  }

  lastRequest<Selected extends Method>(method: Selected): MockCodexAppServerRequest<Selected> | undefined {
    return this.requests(method).at(-1);
  }

  response(id: RpcId): RpcMessage | undefined {
    return this.sent.find((message) => 'id' in message && message.id === id && !('method' in message));
  }

  private emitResponse(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

function rpcTestError(error: unknown): { code: number; message: string } {
  return {
    code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number'
      ? error.code
      : -1,
    message: error instanceof Error ? error.message : String(error),
  };
}
