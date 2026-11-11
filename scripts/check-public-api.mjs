// Fails when the public type surface reaches a provider engine: hosts, adapters, controllers, drivers, transports or "Native" names.
// Walks every declaration file reachable from the exports map, because a type leaks through any signature that mentions it.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const forbidden = /(Host|Native|Transport|Driver|Adapter|Controller)/;
const entries = Object.entries(manifest.exports).flatMap(([entry, value]) => typeof value === 'object' && value.types ? [[entry, path.join(root, value.types)]] : []);

assert(entries.length, 'No public type entries found.');
function assert(condition, message) { if (!condition) { console.error(message); process.exit(1); } }

const seen = new Map(); // file -> entries that reach it
const visit = (file, entry) => {
  if (!fs.existsSync(file)) return;
  const reached = seen.get(file) ?? new Set();
  if (reached.has(entry)) return;
  reached.add(entry); seen.set(file, reached);
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = path.resolve(path.dirname(file), match[1]).replace(/\.js$/, '');
    for (const candidate of [`${base}.d.ts`, path.join(base, 'index.d.ts')]) if (fs.existsSync(candidate)) { visit(candidate, entry); break; }
  }
};
for (const [entry, file] of entries) visit(file, entry);

const exportedNames = text => {
  const names = new Set();
  for (const match of text.matchAll(/export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|interface|type|enum)\s+([A-Za-z0-9_$]+)/g)) names.add(match[1]);
  for (const match of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) for (const part of match[1].split(',')) { const name = part.trim().split(/\s+as\s+/).pop(); if (name) names.add(name.replace(/^type\s+/, '')); }
  return names;
};
const leaks = [];
for (const [file] of seen) for (const name of exportedNames(fs.readFileSync(file, 'utf8'))) {
  if (forbidden.test(name)) leaks.push(`${name}  (${path.relative(root, file)})`);
}
// The SDK is a harness interface: display belongs to the app or a UI library, so no Electron or presentation wording either.
const display = /(Renderer|Electron|Presentation)/;
const wording = [...entries.map(([entry]) => entry).filter(entry => /renderer|electron|presentation/i.test(entry)).map(entry => `${entry}  (package entry)`),
  ...[...seen.keys()].flatMap(file => [...exportedNames(fs.readFileSync(file, 'utf8'))].filter(name => display.test(name)).map(name => `${name}  (${path.relative(root, file)})`))];
assert(!wording.length, `Public API uses display wording (${new Set(wording).size}):\n${[...new Set(wording)].sort().map(line => `  ${line}`).join('\n')}\nName it for what it is to a harness, or keep it in the app.`);
const unique = [...new Set(leaks)].sort();
if (unique.length) {
  console.error(`Public API reaches provider engine names (${unique.length}):\n${unique.map(line => `  ${line}`).join('\n')}\nExpose a neutral type instead, or keep the engine type out of public signatures.`);
  process.exit(1);
}
// The root entry is provider-neutral; provider-specific types live on types-only provider entries, so createHarness stays the only way in.
const ts = (await import('typescript')).default;
const providers = ['codex', 'claude', 'cursor', 'antigravity'];
const providerNamed = /^(Codex|Claude|Cursor|Antigravity)[A-Z]/;
const program = ts.createProgram(entries.map(([, file]) => file), { skipLibCheck: true });
const checker = program.getTypeChecker();
const exportsOf = file => { const source = program.getSourceFile(file); const module = source && checker.getSymbolAtLocation(source); return module ? checker.getExportsOfModule(module) : []; };
const rootFile = entries.find(([entry]) => entry === '.')?.[1];
const named = exportsOf(rootFile).map(symbol => symbol.name).filter(name => providerNamed.test(name));
assert(!named.length, `The root entry exports provider-named types (${named.length}); move them to their provider entry:\n${named.map(name => `  ${name}`).join('\n')}`);
for (const provider of providers) {
  const file = entries.find(([entry]) => entry === `./${provider}`)?.[1];
  assert(file, `Missing the ./${provider} types entry.`);
  const values = exportsOf(file).filter(symbol => {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return target.flags & ts.SymbolFlags.Value;
  }).map(symbol => symbol.name);
  assert(!values.length, `./${provider} must export types only; it exports values: ${values.join(', ')}`);
}
console.log(`Public API: ${seen.size} declaration files reachable from ${entries.length} entries, no provider engine names, a neutral root and types-only provider entries.`);
