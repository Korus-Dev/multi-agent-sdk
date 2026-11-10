import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerClient } from '@korus-dev/codex-sdk/protocol';
import { CodexMarkdownImageHydrator, localImagePath } from '../../src/providers/codex/codex-markdown-images';
import { MockCodexAppServer, generatedPngBase64 } from './helpers/codex-surface-fixture';

describe('CodexMarkdownImageHydrator', () => {
  const clients: CodexAppServerClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it('materializes absolute and workspace-relative Markdown images through app-server', async () => {
    const paths: string[] = [];
    const transport = new MockCodexAppServer({
      'fs/readFile': (params) => {
        paths.push((params as { path: string }).path);
        return { dataBase64: generatedPngBase64 };
      },
    });
    const client = new CodexAppServerClient(transport);
    clients.push(client);
    await client.start();

    const result = await new CodexMarkdownImageHydrator(client).hydrate([
      '![absolute](/tmp/generated.png)',
      '![relative](images/chart.png "Chart")',
    ].join('\n'), '/tmp/project');

    const dataUrl = `data:image/png;base64,${generatedPngBase64}`;
    expect(result).toBe([
      `![absolute](${dataUrl})`,
      `![relative](${dataUrl} "Chart")`,
    ].join('\n'));
    expect(paths).toStrictEqual(['/tmp/generated.png', '/tmp/project/images/chart.png']);
  });

  it('leaves remote, unsafe, unsupported, invalid, and fenced image references unchanged', async () => {
    const transport = new MockCodexAppServer({
      'fs/readFile': () => ({ dataBase64: 'not-an-image' }),
    });
    const client = new CodexAppServerClient(transport);
    clients.push(client);
    await client.start();
    const source = [
      '![remote](https://example.com/image.png)',
      '![traversal](../private.png)',
      '![svg](/tmp/vector.svg)',
      '![invalid](/tmp/invalid.png)',
      '```md',
      '![example](/tmp/example.png)',
      '```',
    ].join('\n');

    await expect(new CodexMarkdownImageHydrator(client).hydrate(source, '/tmp/project')).resolves.toBe(source);
    expect(transport.sent.filter((message) => 'method' in message && message.method === 'fs/readFile')).toHaveLength(1);
  });

  it('isolates read failures and invalid image data while hydrating later images', async () => {
    const paths: string[] = [];
    const transport = new MockCodexAppServer({
      'fs/readFile': (params) => {
        const path = (params as { path: string }).path;
        paths.push(path);
        if (path.endsWith('/throws.png')) throw new Error('read failed');
        return { dataBase64: path.endsWith('/invalid.png') ? 'not-an-image' : generatedPngBase64 };
      },
    });
    const client = new CodexAppServerClient(transport);
    clients.push(client);
    await client.start();
    const source = [
      '![throws](/tmp/throws.png)',
      '![invalid](/tmp/invalid.png)',
      '![valid](/tmp/valid.png)',
    ].join('\n');

    await expect(new CodexMarkdownImageHydrator(client).hydrate(source)).resolves.toBe([
      '![throws](/tmp/throws.png)',
      '![invalid](/tmp/invalid.png)',
      `![valid](data:image/png;base64,${generatedPngBase64})`,
    ].join('\n'));
    expect(paths).toStrictEqual(['/tmp/throws.png', '/tmp/invalid.png', '/tmp/valid.png']);
  });

  it('recognizes opening, closing, and unclosed fences without hiding later prose images', async () => {
    const paths: string[] = [];
    const transport = new MockCodexAppServer({
      'fs/readFile': (params) => {
        paths.push((params as { path: string }).path);
        return { dataBase64: generatedPngBase64 };
      },
    });
    const client = new CodexAppServerClient(transport);
    clients.push(client);
    await client.start();
    const source = [
      '```md',
      '![inside-start-fence](/tmp/inside.png)',
      '```![at-closing-boundary](/tmp/boundary.png)',
      '![after-closed-fence](/tmp/after.png)',
      '~~~md',
      '![inside-unclosed-fence](/tmp/unclosed.png)',
    ].join('\n');

    await expect(new CodexMarkdownImageHydrator(client).hydrate(source)).resolves.toBe([
      '```md',
      '![inside-start-fence](/tmp/inside.png)',
      '```![at-closing-boundary](/tmp/boundary.png)',
      `![after-closed-fence](data:image/png;base64,${generatedPngBase64})`,
      '~~~md',
      '![inside-unclosed-fence](/tmp/unclosed.png)',
    ].join('\n'));
    expect(paths).toStrictEqual(['/tmp/after.png']);
  });

  it('hydrates every supported extension and preserves Markdown title spacing', async () => {
    const paths: string[] = [];
    const transport = new MockCodexAppServer({
      'fs/readFile': (params) => {
        paths.push((params as { path: string }).path);
        return { dataBase64: generatedPngBase64 };
      },
    });
    const client = new CodexAppServerClient(transport);
    clients.push(client);
    await client.start();
    const extensions = ['avif', 'gif', 'jpeg', 'jpg', 'png', 'webp'];
    const source = extensions.map((extension) => (
      `![${extension}](/tmp/image.${extension.toUpperCase()}   "${extension} title")`
    )).join('\n');

    const result = await new CodexMarkdownImageHydrator(client).hydrate(source);
    for (const extension of extensions) {
      expect(result).toContain(`![${extension}](data:image/png;base64,${generatedPngBase64}   "${extension} title")`);
    }
    expect(paths).toStrictEqual(extensions.map((extension) => `/tmp/image.${extension.toUpperCase()}`));
  });
});

describe('localImagePath', () => {
  it('normalizes supported file URLs and rejects relative paths without an absolute cwd', () => {
    expect(localImagePath('file:///tmp/preview%20one.png')).toBe('/tmp/preview one.png');
    expect(localImagePath('preview.png')).toBeNull();
  });

  it('trims paths, rejects control characters and malformed encodings, and preserves safe dot-prefixed names', () => {
    expect(localImagePath('  /tmp/preview.PNG  ')).toBe('/tmp/preview.PNG');
    expect(localImagePath('')).toBeNull();
    expect(localImagePath('/tmp/bad\nname.png')).toBeNull();
    expect(localImagePath('file:///%2F.png')).toBeNull();
    expect(localImagePath('%E0%A4%A.png', '/tmp/project')).toBeNull();
    expect(localImagePath('x1:image.png', '/tmp/project')).toBeNull();
    expect(localImagePath('folder/x:http.png', '/tmp/project')).toBe('/tmp/project/folder/x:http.png');
    expect(localImagePath('..safe.png', '/tmp/project')).toBe('/tmp/project/..safe.png');
  });
});
