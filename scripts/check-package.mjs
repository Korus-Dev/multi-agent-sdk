import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-agent-package-'));
const npm = args => execFileSync('npm', args, { cwd: temporary, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const [archive] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: root, encoding: 'utf8' }));
  const files = new Set(archive.files.map(file => file.path));
  const allowed = new Set(['package.json', ...manifest.files.filter(file => file !== 'dist')]);
  for (const file of files) {
    assert(file.startsWith('dist/') || allowed.has(file), `Unexpected package file: ${file}`);
    assert(!/(^|\/)(\.env[^/]*|node_modules|src|tests)(\/|$)|\.tgz$/.test(file), `Private package file: ${file}`);
  }
  const exported = Object.entries(manifest.exports);
  const targets = exported.flatMap(([, value]) => typeof value === 'string' ? [value] : Object.values(value));
  for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md', manifest.main, manifest.types, ...targets].map(file => file.replace(/^\.\//, ''))) {
    assert(files.has(file), `Missing package entry: ${file}`);
  }
  const entries = exported.filter(([, value]) => typeof value !== 'string' && value.default?.endsWith('.js'))
    .map(([entry]) => manifest.name + (entry === '.' ? '' : entry.slice(1)));
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', path.join(temporary, archive.filename)]);
  fs.writeFileSync(path.join(temporary, 'imports.mjs'), entries.map(entry => `await import(${JSON.stringify(entry)});`).join('\n'));
  execFileSync(process.execPath, ['imports.mjs'], { cwd: temporary, stdio: 'inherit' });
  execFileSync(process.execPath, ['--input-type=commonjs', '-e', entries.map(entry => `require(${JSON.stringify(entry)});`).join('\n')], { cwd: temporary, stdio: 'inherit' });
  fs.writeFileSync(path.join(temporary, 'consumer.ts'), entries.map((entry, index) => `import type * as Public${index} from '${entry}';`).join('\n') + `
import { createHarness, TypedEventBus, TtlCache, type Harness, type HarnessOptions, type Session, type SessionState, type ConversationMessage, type ModelDescriptor } from '${manifest.name}';
import { normalizePromptContent } from '${manifest.name}/prompt';
import { codexHarnessCapabilities, claudeHarnessCapabilities, cursorHarnessCapabilities, antigravityHarnessCapabilities, withInferredWorkPhases, withInferredTurnWorkPhases, createCodexConversationReplica, harnessProviders, isHarnessProvider, isProviderConversationRef } from '${manifest.name}/contracts';
const driver: Harness = createHarness('codex', { client: { name: 'pack-check' } });
const session: Session = driver.open({ id: 'test', folder: null });
const state: SessionState = driver.readSession(session);
const text: string[] = state.messages.flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []));
const bus = new TypedEventBus<{ changed: string }>();
bus.emit('changed', 'ready');
const options: HarnessOptions = { client: { name: 'pack-check' } };
const sharedTypes: [ConversationMessage?, ModelDescriptor?] = []; void [options, sharedTypes, TtlCache];
void [text, normalizePromptContent, harnessProviders, isHarnessProvider, isProviderConversationRef];
void [codexHarnessCapabilities, claudeHarnessCapabilities, cursorHarnessCapabilities, antigravityHarnessCapabilities, withInferredWorkPhases, withInferredTurnWorkPhases, createCodexConversationReplica];
`);
  fs.writeFileSync(path.join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    skipLibCheck: false, types: ['node'], typeRoots: [path.join(root, 'node_modules/@types')],
  }, files: ['consumer.ts'] }));
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(temporary, 'tsconfig.json')], { cwd: temporary, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(root, 'scripts/check-public-api.mjs')], { cwd: root, stdio: 'inherit' });
  console.log(`Validated ${files.size} packed files and ${entries.length} public entries: plain Node ESM and strict Bundler types.`);
} catch (error) {
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
