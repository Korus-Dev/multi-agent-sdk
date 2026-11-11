import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Adding a harness costs exactly what the allowlist below names: its class and modules under providers/<p>/,
// one registry line, its contract-union members, its capability table and its per-provider conversation files.
// Everything else stays provider-neutral, and this test fails on any new leak.
const src = path.join(__dirname, '../../src');
const providers = ['codex', 'claude', 'cursor', 'antigravity'];
const allowed = [
  /^providers\//,
  /^harnesses\.ts$/,
  /^capabilities\.ts$/,
  /^contracts\//,
  /^testing-(codex|claude|cursor|antigravity)\.ts$/,
  /^core\/codex-/,
  /^conversations\/(codex|claude|cursor|antigravity)-/,
];
// The shared harness machinery does not even mention a provider.
const core = ['harness.ts', 'session-harness.ts', 'create-harness.ts', 'harness-options.ts', 'harness-projection.ts', 'testing.ts'];

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? files(full) : entry.name.endsWith('.ts') ? [path.relative(src, full)] : [];
});
const code = (file: string) => readFileSync(path.join(src, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^export (type )?\{[^}]*\} from '\.\/testing-[a-z]+';$/gm, '');
const offending = (file: string, pattern: RegExp) => code(file).split('\n').filter(line => pattern.test(line)).map(line => `${file}: ${line.trim()}`);

describe('harness polymorphism', () => {
  it('keeps provider values out of shared code', () => {
    const literal = new RegExp(`['"](${providers.join('|')})['"]`);
    const leaks = files(src).filter(file => !allowed.some(pattern => pattern.test(file))).flatMap(file => offending(file, literal));
    expect(leaks).toStrictEqual([]);
  });

  it.each(core)('%s never names a provider', file => {
    expect(offending(file, new RegExp(`\\b(${providers.join('|')})`, 'i'))).toStrictEqual([]);
  });

  it('registers every provider in one place', () => {
    const registry = code('harnesses.ts');
    for (const provider of providers) expect(registry).toMatch(new RegExp(`\\b${provider}: `));
  });
});
