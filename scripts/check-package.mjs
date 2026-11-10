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
  const publicFiles = manifest.files.filter(file => file.endsWith('.js'));
  for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md', manifest.main.slice(2), manifest.types.slice(2), ...publicFiles, ...publicFiles.map(file => file.replace(/\.js$/, '.d.ts'))]) {
    assert(files.has(file), `Missing package entry: ${file}`);
  }
  const entries = [manifest.name, ...publicFiles.map(file => `${manifest.name}/${file}`)];
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', path.join(temporary, archive.filename)]);
  fs.writeFileSync(path.join(temporary, 'imports.mjs'), entries.map(entry => `await import(${JSON.stringify(entry)});`).join('\n'));
  execFileSync(process.execPath, ['imports.mjs'], { cwd: temporary, stdio: 'inherit' });
  fs.writeFileSync(path.join(temporary, 'consumer.ts'), entries.map((entry, index) => `import type * as Public${index} from '${entry}';`).join('\n') + `
import { createHarnessDriver, TypedEventBus, type HarnessDriver, type Session, type SessionState, type CodexConversationSnapshot, type CodexSurface, type NativeHarnessEvent, type NativeHarnessDriver } from '${manifest.name}';
import { normalizePromptContent } from '${manifest.name}/prompt.js';
import { createCodexSurface } from '${manifest.name}/codex.js';
const driver: HarnessDriver = createHarnessDriver('codex', { client: { name: 'pack-check' } });
const session: Session = driver.open({ id: 'test', folder: null });
const state: SessionState = driver.readSession(session);
const text: string[] = state.messages.flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []));
const bus = new TypedEventBus<{ changed: string }>();
bus.emit('changed', 'ready');
const nativeTypes: [CodexConversationSnapshot?, CodexSurface?, NativeHarnessEvent?, NativeHarnessDriver?] = [];
void [text, nativeTypes, normalizePromptContent, createCodexSurface];
`);
  fs.writeFileSync(path.join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    skipLibCheck: false, types: ['node'], typeRoots: [path.join(root, 'node_modules/@types')],
  }, files: ['consumer.ts'] }));
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(temporary, 'tsconfig.json')], { cwd: temporary, stdio: 'inherit' });
  console.log(`Validated ${files.size} packed files and ${entries.length} public entries: plain Node ESM and strict Bundler types.`);
} catch (error) {
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
