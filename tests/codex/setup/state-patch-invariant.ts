import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, expect } from 'vitest';
import { createCodexSurfaceStateMirror, type CodexSurfaceStateMirror } from '../../../src/core/surface-bridge';

// Every surface in the suite doubles as a state-patch consistency check:
// after each state change, a mirror built only from the emitted patches must
// equal the surface's own snapshot. This catches in-place mutations that a
// reference-based diff would silently miss.
type InvariantSurface = {
  getSnapshot(): unknown;
  getVersionedSnapshot(): Parameters<CodexSurfaceStateMirror['reset']>[0];
  onStatePatch(listener: Parameters<CodexSurfaceStateMirror['receive']>[0] extends infer Patch
    ? (patch: Patch) => void
    : never): () => void;
  patch(...args: unknown[]): void;
};

const instrumented = new WeakSet<object>();
const mirrors = new WeakMap<object, CodexSurfaceStateMirror>();
const violations: string[] = [];

// Imported lazily so each test file's module mocks apply to the surface it loads.
beforeEach(async () => {
  const { CodexSurface } = await import('../../../src/providers/codex');
  const prototype = CodexSurface.prototype as unknown as InvariantSurface;
  if (instrumented.has(prototype)) return;
  instrumented.add(prototype);
  const originalPatch = prototype.patch;
  prototype.patch = function patchWithInvariant(this: InvariantSurface, ...args: unknown[]) {
    let mirror = mirrors.get(this);
    if (!mirror) {
      const created = createCodexSurfaceStateMirror();
      created.reset(this.getVersionedSnapshot());
      this.onStatePatch((patch) => { created.receive(patch); });
      mirrors.set(this, created);
      mirror = created;
    }
    originalPatch.apply(this, args);
    const expected = this.getSnapshot() as Record<string, unknown>;
    const actual = (mirror.snapshot ?? {}) as unknown as Record<string, unknown>;
    if (!isDeepStrictEqual(actual, expected)) {
      const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
        .filter((key) => !isDeepStrictEqual(actual[key], expected[key]));
      violations.push(`state patches diverged from the snapshot for: ${keys.join(', ')}`);
    }
  };
});

afterEach(() => {
  const found = violations.splice(0);
  expect(found, 'surface state patches must reproduce getSnapshot()').toStrictEqual([]);
});
