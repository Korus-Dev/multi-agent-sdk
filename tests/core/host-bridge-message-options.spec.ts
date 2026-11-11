import {
  invokeCodexHostBridgeOperation,
  type CodexHostBridgeAttachmentResolver,
  type CodexHostBridgeTarget,
} from '../../src/core/codex-host-bridge';
import { describe, expect, it, vi } from 'vitest';

function targetWithSend(sendMessage = vi.fn().mockResolvedValue(undefined)) {
  return { sendMessage, target: { sendMessage } as unknown as CodexHostBridgeTarget };
}

async function expectMessageRejected(
  options: unknown,
  message: string,
  resolveAttachment?: CodexHostBridgeAttachmentResolver,
) {
  const { sendMessage, target } = targetWithSend();
  await expect(invokeCodexHostBridgeOperation(
    target,
    'sendMessage',
    ['prompt', options],
    { resolveAttachment },
  )).rejects.toThrow(message);
  expect(sendMessage).not.toHaveBeenCalled();
}

describe('Codex host bridge message options', () => {
  it('accepts empty collections and JSON scalar schemas', async () => {
    const { sendMessage, target } = targetWithSend();
    for (const outputSchema of [null, true, 'value', 42, [1, 'two', false]]) {
      await invokeCodexHostBridgeOperation(target, 'sendMessage', [
        'prompt',
        { attachments: [], skills: [], outputSchema },
      ]);
    }
    expect(sendMessage).toHaveBeenCalledTimes(5);
  });

  it('accepts repeated references and null-prototype objects in JSON schemas', async () => {
    const { sendMessage, target } = targetWithSend();
    const shared = { type: 'string' };
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { type: 'number' });

    await invokeCodexHostBridgeOperation(target, 'sendMessage', [
      'prompt',
      { outputSchema: { alternatives: [shared, shared], nullPrototype } },
    ]);

    expect(sendMessage).toHaveBeenCalledWith('prompt', {
      outputSchema: { alternatives: [shared, shared], nullPrototype },
    });
  });

  it.each([
    [null, 'Message options must be an object'],
    [{ extra: true }, 'Message options contains unsupported property "extra"'],
    [{ attachments: {} }, 'Message attachments must be an array'],
    [{ attachments: [{ type: 'file', reference: 'ref' }] }, 'Message attachment references are not supported by this host'],
    [{ skills: {} }, 'Message skills must be an array'],
    [{ skills: [null] }, 'Message skill must be an object'],
    [{ skills: [{ name: 'skill', path: '/skill', extra: true }] }, 'Message skill contains unsupported property "extra"'],
    [{ skills: [{ name: '', path: '/skill' }] }, 'Message skill name must be a non-empty string'],
    [{ skills: [{ name: 'skill', path: '' }] }, 'Message skill path must be a non-empty string'],
    [{ model: '' }, 'Message model must be a non-empty string'],
    [{ reasoningEffort: 1 }, 'Message reasoning effort must be a non-empty string'],
    [{ serviceTier: false }, 'Message service tier must be a non-empty string'],
    [{ planMode: 'yes' }, 'Message plan mode must be a boolean'],
  ] as const)('rejects malformed message options', async (options, message) => {
    await expectMessageRejected(options, message);
  });

  it.each([
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [1n],
    [Symbol('schema')],
    [new Date()],
  ])('rejects a non-JSON output schema', async (outputSchema) => {
    await expectMessageRejected({ outputSchema }, 'Message output schema must be JSON-serializable');
  });

  it('rejects cyclic, sparse, decorated, symbol-bearing, and accessor JSON structures', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = Array(2);
    sparse[0] = 'only';
    const decorated = ['value'] as unknown[] & { extra?: boolean };
    decorated.extra = true;
    const symbolObject = { value: true } as Record<PropertyKey, unknown>;
    symbolObject[Symbol('secret')] = true;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'hidden', { get: () => true });
    const disguisedArrays = ['x0', '1x'].map((invalidKey) => {
      const array = [true, 'discarded'] as unknown[] & Record<string, unknown>;
      delete array[1];
      array[invalidKey] = true;
      return array;
    });
    const mixedArray = [true, Number.NaN];
    const mixedObject = { valid: true, invalid: Number.NaN };
    const outOfRangeArrayKey = new Proxy([true, true], {
      ownKeys: () => ['0', '2', 'length'],
      getOwnPropertyDescriptor: (target, property) => property === '2'
        ? { configurable: true, enumerable: true, value: true, writable: true }
        : Reflect.getOwnPropertyDescriptor(target, property),
    });

    for (const outputSchema of [
      cyclic, sparse, decorated, symbolObject, accessor, ...disguisedArrays, mixedArray, mixedObject,
      outOfRangeArrayKey,
    ]) {
      await expectMessageRejected({ outputSchema }, 'Message output schema must be JSON-serializable');
    }
  });

  it.each([
    [null, 'Message attachment must be an object'],
    [{ type: 'video', reference: 'ref' }, 'Message attachment type is invalid'],
    [{ type: 'file', reference: 'ref', detail: 'high' }, 'Message attachment contains unsupported property "detail"'],
    [{ type: 'image', reference: 'ref', detail: 'maximum' }, 'Message image detail is invalid'],
    [{ type: 'file', reference: '' }, 'Message attachment reference must be a non-empty string'],
    [{ type: 'image', reference: '' }, 'Message attachment reference must be a non-empty string'],
  ] as const)('rejects malformed attachment references', async (attachment, message) => {
    await expectMessageRejected(
      { attachments: [attachment] },
      message,
      async (input) => ({ type: input.type, path: '/resolved' }),
    );
  });

  it('preserves every supported image detail value', async () => {
    const { sendMessage, target } = targetWithSend();
    for (const detail of ['auto', 'low', 'high', 'original'] as const) {
      await invokeCodexHostBridgeOperation(target, 'sendMessage', [
        'prompt',
        { attachments: [{ type: 'image', reference: `image:${detail}`, detail }] },
      ], {
        resolveAttachment: async () => ({ type: 'image', path: '/resolved.png' }),
      });
    }
    expect(sendMessage).toHaveBeenNthCalledWith(1, 'prompt', {
      attachments: [{ type: 'image', path: '/resolved.png', detail: 'auto' }],
    });
    expect(sendMessage).toHaveBeenNthCalledWith(4, 'prompt', {
      attachments: [{ type: 'image', path: '/resolved.png', detail: 'original' }],
    });
  });

  it('preserves safe host-resolved image previews', async () => {
    const { sendMessage, target } = targetWithSend();
    const resolveAttachment = vi.fn(async (_attachment: Parameters<CodexHostBridgeAttachmentResolver>[0]) => ({
      type: 'image' as const,
      path: '/resolved.png',
      previewUrl: 'data:image/png;base64,cG5n',
    }));
    await invokeCodexHostBridgeOperation(target, 'sendMessage', [
      'prompt',
      { attachments: [{ type: 'image', reference: 'image:pasted' }] },
    ], {
      resolveAttachment,
    });

    expect(sendMessage).toHaveBeenCalledWith('prompt', {
      attachments: [{
        type: 'image',
        path: '/resolved.png',
        previewUrl: 'data:image/png;base64,cG5n',
      }],
    });
    expect(Object.hasOwn(resolveAttachment.mock.calls[0]![0], 'detail')).toBe(false);
    expect(Object.hasOwn(sendMessage.mock.calls[0]![1].attachments[0], 'detail')).toBe(false);
  });

  it('accepts JPG previews and attachment display strings at their limits', async () => {
    const { sendMessage, target } = targetWithSend();
    const boundedName = 'n'.repeat(1_024);
    await invokeCodexHostBridgeOperation(target, 'sendMessage', [
      'prompt',
      { attachments: [{ type: 'image', reference: 'image:jpg' }] },
    ], {
      resolveAttachment: async () => ({
        type: 'image',
        path: '/resolved.jpg',
        name: boundedName,
        previewUrl: 'data:image/jpg;base64,anBn',
      }),
    });

    expect(sendMessage).toHaveBeenCalledWith('prompt', {
      attachments: [{
        type: 'image',
        path: '/resolved.jpg',
        name: boundedName,
        previewUrl: 'data:image/jpg;base64,anBn',
      }],
    });
  });

  it.each([
    [async (): Promise<unknown> => null, 'Resolved message attachment must be an object'],
    [async (): Promise<unknown> => ({ type: 'image', path: '/image.png' }), 'Resolved message attachment type does not match'],
    [async (): Promise<unknown> => ({ type: 'file', path: '' }), 'Resolved message attachment path must be a non-empty string'],
    [async (): Promise<unknown> => ({ type: 'file', path: '/file', name: '' }), 'Resolved message attachment name must be a non-empty string'],
    [async (): Promise<unknown> => ({ type: 'file', path: '/file', name: 'x'.repeat(1_025) }), 'Resolved message attachment name is too long'],
    [async (): Promise<unknown> => ({ type: 'file', path: '/file', mimeType: '' }), 'Resolved message attachment MIME type must be a non-empty string'],
  ] as const)('validates host-resolved attachments', async (resolver, message) => {
    await expectMessageRejected(
      { attachments: [{ type: 'file', reference: 'file:1' }] },
      message,
      resolver as CodexHostBridgeAttachmentResolver,
    );
  });

  it('rejects unsafe host-resolved image previews', async () => {
    for (const previewUrl of [
      123,
      { toString: () => 'data:image/png;base64,cG5n' },
      'https://example.com/image.png',
      'prefix:data:image/png;base64,cG5n',
      'data:image/png;base64,cG5n:suffix',
    ]) {
      await expectMessageRejected(
        { attachments: [{ type: 'image', reference: 'image:1' }] },
        'Resolved message attachment preview must be a bounded image data URL',
        (async () => ({ type: 'image', path: '/image.png', previewUrl })) as CodexHostBridgeAttachmentResolver,
      );
    }
  });

  it('enforces the resolved image preview byte boundary', async () => {
    const prefix = 'data:image/png;base64,';
    const maximum = `${prefix}${'a'.repeat(16 * 1024 * 1024 - prefix.length)}`;
    const { sendMessage, target } = targetWithSend();
    await invokeCodexHostBridgeOperation(target, 'sendMessage', [
      'prompt',
      { attachments: [{ type: 'image', reference: 'image:max' }] },
    ], {
      resolveAttachment: async () => ({ type: 'image', path: '/image.png', previewUrl: maximum }),
    });
    expect(sendMessage).toHaveBeenCalledOnce();

    await expectMessageRejected(
      { attachments: [{ type: 'image', reference: 'image:over' }] },
      'Resolved message attachment preview must be a bounded image data URL',
      async () => ({ type: 'image', path: '/image.png', previewUrl: `${maximum}a` }),
    );
  });
});
