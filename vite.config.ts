import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { sourceAliases } from './source-aliases.ts';
import metadata from './package.json' with { type: 'json' };
const sourceDirectory = path.join(import.meta.dirname, 'src');
const conversationEntries = Object.fromEntries(fs.readdirSync(sourceDirectory, { recursive: true })
  .filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .map(file => [file.slice(0, -3), path.join(sourceDirectory, file)]));
export default defineConfig({
  resolve: { alias: sourceAliases },

  build: { lib: { entry: conversationEntries, formats: ['es'], cssFileName: 'styles' }, sourcemap: true,
    rollupOptions: { external: id => id.startsWith('node:') || Object.keys(metadata.dependencies ?? {}).some(name => id === name || id.startsWith(name + '/')), output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' } } },
});
