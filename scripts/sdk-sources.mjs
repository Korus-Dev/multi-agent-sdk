import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';

const folders = {
  '@korus-dev/codex-sdk': 'codex-sdk',
  '@korus-dev/multi-agent-sdk': 'multi-agent-sdk',
  '@korus-dev/agent-ui-sdk': 'agent-ui-sdk',
};
const dependencies = {
  '@korus-dev/codex-sdk': [],
  '@korus-dev/multi-agent-sdk': ['@korus-dev/codex-sdk'],
  '@korus-dev/agent-ui-sdk': ['@korus-dev/multi-agent-sdk'],
};
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Development tooling only: runtime packages never inspect SDK source settings. */
export function sdkSources(projectRoot, environment = process.env, requested) {
  let dotenv = {};
  try { dotenv = parseEnv(fs.readFileSync(path.join(projectRoot, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const enabled = (environment.SDK_LOCAL_SOURCE ?? dotenv.SDK_LOCAL_SOURCE) === '1';
  const root = path.resolve(projectRoot, environment.SDK_SOURCE_ROOT ?? dotenv.SDK_SOURCE_ROOT ?? '..');
  const own = readJson(path.join(projectRoot, 'package.json')).name;
  const selected = new Map();
  if (folders[own]) selected.set(own, projectRoot);
  const foreign = requested ?? (folders[own] ? dependencies[own] : Object.keys(folders));
  const include = name => {
    if (selected.has(name)) return;
    const folder = path.join(root, folders[name]);
    const file = path.join(folder, 'package.json');
    if (!fs.existsSync(file)) throw new Error(`SDK_LOCAL_SOURCE requires ${name} at ${folder}. Set SDK_SOURCE_ROOT to the directory containing the SDK repositories.`);
    const metadata = readJson(file);
    if (metadata.name !== name) throw new Error(`Expected ${name} at ${folder}, found ${metadata.name}.`);
    selected.set(name, folder);
    for (const dependency of dependencies[name]) include(dependency);
  };
  if (enabled) for (const name of foreign) include(name);
  const aliases = [], paths = {}, typePaths = {};
  for (const [name, directory] of selected) {
    const metadata = readJson(path.join(directory, 'package.json'));
    const entries = [{ specifier: name, target: metadata.main, types: metadata.types }];
    // Optional entries are static published forwarding files, independent of export maps.
    const publicFiles = (metadata.files ?? []).flatMap(entry => {
      if (entry.endsWith('.js') && !entry.includes('*')) return [entry];
      const location = path.join(directory, entry);
      if (!entry.includes('*') && entry !== 'dist' && fs.existsSync(location) && fs.statSync(location).isDirectory()) {
        return fs.readdirSync(location, { recursive: true }).filter(file => file.endsWith('.js')).map(file => path.join(entry, file));
      }
      return [];
    });
    for (const file of publicFiles) {
      const text = fs.readFileSync(path.join(directory, file), 'utf8');
      const match = /export \* from ['"]([^'"]+)['"]/.exec(text);
      if (!match) continue;
      const target = './' + path.relative(directory, path.resolve(directory, path.dirname(file), match[1]));
      entries.push({ specifier: name + '/' + file, target, types: './' + file.replace(/\.js$/, '.d.ts') });
    }
    for (const { specifier, target, types } of entries) {
      if (!target?.startsWith('./dist/')) continue;
      let source = target.replace(/^\.\/dist\//, 'src/').replace(/\.(d\.ts|js)$/, '');
      if (name === '@korus-dev/agent-ui-sdk' && source === 'src/vue/index') source = 'src/vue/entry';
      const base = path.resolve(directory, source);
      const replacement = fs.existsSync(base + '.ts') ? base + '.ts' : fs.existsSync(base + '.vue') ? base + '.vue' : null;
      if (!replacement) throw new Error(`Missing local SDK source for ${specifier}: ${base}`);
      aliases.push({ find: new RegExp('^' + escape(specifier) + '$'), replacement });
      paths[specifier] = [replacement];
      if (types) typePaths[specifier] = [directory === projectRoot ? replacement : path.resolve(directory, types)];
    }
  }
  aliases.sort((a, b) => b.find.source.length - a.find.source.length);
  return { enabled, root, aliases, paths, typePaths };
}

/** Local runtime uses source; compilers use local declaration boundaries. */
export function sourceTypecheck(projectRoot, args, environment = process.env) {
  const config = sdkSources(projectRoot, environment);
  if (!config.enabled) return { args, cleanup() {} };
  const projectArg = args.findIndex(arg => arg === '-p' || arg === '--project');
  const file = path.resolve(projectArg < 0 ? process.cwd() : args[projectArg + 1], projectArg < 0 ? 'tsconfig.json' : '');
  const actual = fs.statSync(file).isDirectory() ? path.join(file, 'tsconfig.json') : file;
  const ts = createRequire(path.join(projectRoot, 'package.json'))('typescript');
  const parsed = ts.getParsedCommandLineOfConfigFile(actual, {}, ts.sys);
  if (!parsed) throw new Error(`Could not read ${actual}`);
  const pathsBase = parsed.options.baseUrl ?? parsed.options.pathsBasePath ?? path.dirname(actual);
  const existing = Object.fromEntries(Object.entries(parsed.options.paths ?? {}).map(([key, values]) => [key, values.map(value => path.resolve(pathsBase, value))]));
  const temporary = fs.mkdtempSync(path.join(projectRoot, '.sdk-typecheck-'));
  const target = path.join(temporary, 'tsconfig.json');
  fs.writeFileSync(target, JSON.stringify({ extends: actual, compilerOptions: { paths: { ...existing, ...config.typePaths } } }));
  const forwarded = [...args];
  if (projectArg < 0) forwarded.push('--project', target); else forwarded[projectArg + 1] = target;
  return { args: forwarded, cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }) };
}
