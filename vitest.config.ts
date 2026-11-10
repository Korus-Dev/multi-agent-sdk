import { defineConfig } from 'vitest/config';
import { sourceAliases } from './source-aliases.ts';
export default defineConfig({ root: import.meta.dirname, resolve: { alias: sourceAliases },  test: { maxWorkers: 2, testTimeout: 2_500, hookTimeout: 2_500, environment: 'node', include: ['tests/**/*.spec.ts'], setupFiles: ['tests/codex/setup/state-patch-invariant.ts'], coverage: { provider: 'v8', reporter: ['text-summary', 'json', 'html'], include: ['src/**/*.ts'], thresholds: { statements: 85 } } } });
