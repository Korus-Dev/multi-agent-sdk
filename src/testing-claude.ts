import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Harness } from './consumer-types';
import { adaptHarness } from './consumer';
import type { HarnessOptions } from './options';
import { providerOptions } from './options-map';
import { createProviderDriver } from './provider-factory';

class Queue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  push(value: T): void { const waiter = this.waiters.shift(); if (waiter) waiter({ value, done: false }); else this.values.push(value); }
  close(): void { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => {
      const value = this.values.shift();
      if (value !== undefined) return Promise.resolve({ value, done: false });
      if (this.closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise(resolve => this.waiters.push(resolve));
    } };
  }
}

export type ScriptedClaude = {
  harness: Harness;
  /** Delivers a Claude Agent SDK message to a running query (the latest one by default). */
  emit(message: Record<string, unknown>, queryIndex?: number): void;
  /** Ends a running query's message stream, as if the connection dropped (the latest one by default). */
  closeQuery(queryIndex?: number): void;
  /** Messages the harness sent to Claude, in order. */
  inputs: unknown[];
  /** The options each query was started with. */
  queryOptions: Record<string, unknown>[];
  /** Calls made on the running queries (`interrupt`, `setModel`, ...), per query. */
  controlCalls(queryIndex?: number): { method: string; args: unknown[] }[];
};

/** A Claude Harness whose agent connection is scripted by the test; the SDK's own host turns the messages into session state. */
export function createScriptedClaudeHarness(options: HarnessOptions = { client: { name: 'scripted' } }, initializationModels: Array<Record<string, unknown>> = []): ScriptedClaude {
  const inputs: unknown[] = []; const queryOptions: Record<string, unknown>[] = []; const outputs: Queue<SDKMessage>[] = []; const controls: { method: string; args: unknown[] }[][] = [];
  const createQuery = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
    queryOptions.push(input.options);
    void (async () => { for await (const message of input.prompt) inputs.push(message); })();
    const output = new Queue<SDKMessage>(); outputs.push(output); const calls: { method: string; args: unknown[] }[] = []; controls.push(calls);
    const control = (method: string, result: unknown = undefined) => async (...args: unknown[]) => { calls.push({ method, args }); return result; };
    return {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      interrupt: control('interrupt'), setModel: control('setModel'), setPermissionMode: control('setPermissionMode'), applyFlagSettings: control('applyFlagSettings'),
      supportedModels: control('supportedModels', []), initializationResult: control('initializationResult', { models: initializationModels }),
      getContextUsage: control('getContextUsage', { categories: [], totalTokens: 0, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 0, gridRows: [], model: 'sonnet', memoryFiles: [], mcpTools: [], agents: [] }),
      close: () => output.close(),
    };
  };
  const native = providerOptions(options);
  const driver = createProviderDriver('claude', { ...native, claude: { ...native.claude, transportOptions: { ...native.claude?.transportOptions, createQuery: createQuery as never } } });
  return {
    harness: adaptHarness('claude', driver), inputs, queryOptions,
    emit: (message, queryIndex) => (queryIndex === undefined ? outputs.at(-1)! : outputs[queryIndex]!).push(message as unknown as SDKMessage),
    closeQuery: queryIndex => (queryIndex === undefined ? outputs.at(-1)! : outputs[queryIndex]!).close(),
    controlCalls: queryIndex => controls[queryIndex ?? controls.length - 1] ?? [],
  };
}
