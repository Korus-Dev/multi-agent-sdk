import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-agent-package-'));
const npm = (args, cwd = temporary) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const [archive] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root));
  const files = new Set(archive.files.map(file => file.path));
  for (const file of files) {
    assert(!/^(web(?:\.|\/)|dist\/web\/)/.test(file), `Removed web support is still packaged: ${file}`);
    assert(!file.endsWith('.tgz') && !file.includes('.env') && !file.includes('node_modules/'), `Private file: ${file}`);
    assert(['README.md', 'LICENSE', 'package.json'].includes(file) || /^(dist|docs|examples)\//.test(file) || /^[\w-]+\.(js|d\.ts)$/.test(file), `Unexpected file: ${file}`);
    assert(!file.startsWith('docs/.vitepress/'), `Generated docs/config in package: ${file}`);
  }
  for (const file of ['README.md', 'LICENSE', 'docs/consumer-contract.md', 'examples/chat.ts']) assert(files.has(file), `Missing ${file}`);
  assert(!manifest.exports, 'Package uses main/types without an exports map');
  assert(files.has(manifest.main.replace(/^\.\//, '')), 'Missing main entry');
  assert(files.has(manifest.types.replace(/^\.\//, '')), 'Missing types entry');
  const entries = ['.'];
  for (const file of files) {
    if (file.endsWith('.js') && !file.startsWith('dist/')) {
      assert(files.has(file.replace(/\.js$/, '.d.ts')), `Missing declaration for ${file}`);
      entries.push('./' + file);
    }
  }
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const dependency = process.env.SDK_CODEX_TARBALL;
  if (dependency) {
    assert(path.isAbsolute(dependency), 'SDK_CODEX_TARBALL must be absolute');
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', dependency]);
    console.log('Using explicitly supplied local Codex tarball; this does not prove registry availability.');
  }
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', path.join(temporary, archive.filename)]);
  // Every public runtime entry must load in plain Node without Vite aliases or a provider process.
  fs.writeFileSync(path.join(temporary, 'imports.mjs'), entries.map(entry => `await import(${JSON.stringify(manifest.name + (entry === '.' ? '' : entry.slice(1)))});`).join('\n'));
  execFileSync(process.execPath, ['imports.mjs'], { cwd: temporary, stdio: 'inherit' });
  const publicTypes = entries.map((entry, index) => `import type * as Public${index} from '${manifest.name + (entry === '.' ? '' : entry.slice(1))}';`).join('\n');
  fs.writeFileSync(path.join(temporary, 'consumer.ts'), publicTypes + `
import { createHarnessDriver, type HarnessDriver, type Session, type SessionState, type CodexConversationSnapshot, type CodexSurface, type NativeHarnessEvent, type NativeHarnessDriver, TypedEventBus } from '${manifest.name}';
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
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
  // Resolve Node types from this repository, never from the consumer's ancestors.
  fs.writeFileSync(path.join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    skipLibCheck: false, types: ['node'], typeRoots: [path.join(root, 'node_modules/@types')],
  }, files: ['consumer.ts'] }));
  execFileSync(process.execPath, [tsc, '-p', path.join(temporary, 'tsconfig.json')], { cwd: temporary, stdio: 'inherit' });
  console.log(`Validated ${files.size} packed files and ${entries.length} public entry points in an isolated ESNext/Bundler consumer.`);
} catch (error) {
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
