import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  codexSchemaCliVersion,
  type CodexAppServerMethodMap,
  type CodexServerRequestMethodMap,
} from '@korus-dev/codex-sdk/protocol';

describe('generated Codex app-server schema', () => {
  it('records the Codex CLI version used to generate bindings', () => {
    expect(codexSchemaCliVersion).toMatch(/^codex-cli \d+\.\d+\.\d+/);
  });

  it('maps core bidirectional methods to parameter and result types', () => {
    expectTypeOf<CodexAppServerMethodMap['thread/start']['params']>()
      .toHaveProperty('cwd');
    expectTypeOf<CodexAppServerMethodMap['turn/start']['result']>()
      .toHaveProperty('turn');
    expectTypeOf<CodexServerRequestMethodMap['item/tool/requestUserInput']['params']>()
      .toHaveProperty('questions');
  });
});
