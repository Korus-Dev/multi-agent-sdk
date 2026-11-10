import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { sourceAliases } from './source-aliases';
import metadata from './package.json' with { type: 'json' };
const packageMetadata: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> } = metadata;
const externalPackages = Object.keys({ ...packageMetadata.dependencies, ...packageMetadata.peerDependencies });
const sourceDirectory = path.join(import.meta.dirname, 'src');
const conversationEntries = Object.fromEntries(fs.readdirSync(sourceDirectory, { recursive: true, encoding: 'utf8' })
  .filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .map(file => [file.slice(0, -3), path.join(sourceDirectory, file)]));
export default defineConfig({
  resolve: { alias: sourceAliases },

  build: { lib: { entry: conversationEntries, formats: ['es'], cssFileName: 'styles' }, sourcemap: true,
    rollupOptions: { external: id => id.startsWith('node:') || externalPackages.some(name => id === name || id.startsWith(name + '/')), output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' } } },
});
