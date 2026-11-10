import path from 'node:path';
/** Repository-local source resolution; package builds do not depend on the workspace alias file. */
const local = (file: string) => path.resolve(import.meta.dirname, file);
export const sourceAliases = [
  { find: /^codex-sdk\/protocol\/(.*)$/, replacement: local('../codex-sdk/src/protocol') + '/$1' },
  { find: /^codex-sdk$/, replacement: local('../codex-sdk/src/index.ts') },
  { find: /^multi-agents-sdk\/(contracts|conversations|providers|acp|tools)\/(.*)$/, replacement: local('src') + '/$1/$2' },
  ...Object.entries({ '': 'index', contracts: 'contracts/index', codex: 'providers/codex/index', core: 'core/index', surface: 'core/surface', events: 'core/typed-event-bus', 'surface-bridge': 'core/surface-bridge', 'conversation-replica': 'core/conversation-replica', runtime: 'runtime/discovery' })
    .map(([entry, file]) => ({ find: new RegExp('^multi-agents-sdk' + (entry ? '/' + entry : '') + '$'), replacement: local('src/' + file + '.ts') })),
  { find: /^multi-agents-sdk\/(.*)$/, replacement: local('src') + '/$1' },
];
