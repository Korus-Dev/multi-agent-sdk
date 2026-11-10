/** Native compatibility seam. These contracts preserve provider wire semantics. */
export { createHarnessDriver as createNativeHarnessDriver } from './backend';
export type { HarnessOptions as NativeHarnessOptions } from './backend';
export type * from './driver';
export type * from './context';
export * from './contracts';
export * from './providers/claude';
export * from './providers/cursor';
export * from './providers/antigravity';
export * from './runtime/discovery';
export { sessionMcpServer } from './acp/mcp-bridge';
