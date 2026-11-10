import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { sourceAliases } from '../source-aliases.ts';
import metadata from './package.json' with { type: 'json' };
const sourceDirectory = path.join(import.meta.dirname, 'src');
const conversationEntries = Object.fromEntries(fs.readdirSync(sourceDirectory, { recursive: true })
  .filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .map(file => [file.slice(0, -3), path.join(sourceDirectory, file)]));
export default defineConfig({
  resolve: { alias: sourceAliases },

  build: { lib: { entry: { ...conversationEntries, ...Object.fromEntries(Object.entries({"index":"src/index.ts","providers/codex/index":"src/providers/codex/index.ts","core/index":"src/core/index.ts","core/surface":"src/core/surface.ts","core/typed-event-bus":"src/core/typed-event-bus.ts","core/surface-bridge":"src/core/surface-bridge.ts","core/conversation-replica":"src/core/conversation-replica.ts","web/index":"src/web/index.ts","web/client":"src/web/client.ts","web/server":"src/web/server.ts","web/protocol":"src/web/protocol.ts"}).map(([name, file]) => [name, path.resolve(import.meta.dirname, file)])) }, formats: ['es'], cssFileName: 'styles' }, sourcemap: true,
    rollupOptions: { external: id => id.startsWith('node:') || ['vue', 'electron', ...Object.keys(metadata.dependencies ?? {})].some(name => id === name || id.startsWith(name + '/')), output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' } } },
});
