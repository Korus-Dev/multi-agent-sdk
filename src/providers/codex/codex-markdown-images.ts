import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodexAppServerClient } from '@korus-dev/codex-sdk';
import { codexImageDataUrl } from './codex-conversation-history';

type CodeBlockRange = { start: number; end: number };
type SourceReplacement = { start: number; end: number; value: string };

const markdownImageRegex = /(?<!\[)!\[([^\]]*)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/g;
const supportedImageExtensions = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp']);

/**
 * Converts filesystem-backed Markdown images into bounded data URLs.
 * The provider owns the filesystem and supplies content through fs/readFile;
 * no local paths exposed.
 */
export class CodexMarkdownImageHydrator {
  constructor(private readonly client: CodexAppServerClient) {}

  async hydrate(content: string, cwd?: string | null): Promise<string> {
    const codeBlocks = findCodeBlocks(content);
    const replacements = await Promise.all(Array.from(content.matchAll(markdownImageRegex), async (match) => {
      const matchStart = match.index ?? 0;
      if (isInsideCodeBlock(matchStart, codeBlocks)) return null;
      const source = match[2]!;
      const path = localImagePath(source, cwd);
      if (!path) return null;

      try {
        const response = await this.client.request('fs/readFile', { path });
        const image = codexImageDataUrl(response.dataBase64);
        if (!image) return null;
        const sourceOffset = match[0].indexOf('](') + 2;
        return {
          start: matchStart + sourceOffset,
          end: matchStart + sourceOffset + source.length,
          value: image.url,
        } satisfies SourceReplacement;
      } catch {
        return null;
      }
    }));

    return applyReplacements(content, replacements.filter((item): item is SourceReplacement => item !== null));
  }
}

export function localImagePath(source: string, cwd?: string | null): string | null {
  const value = source.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;

  let path: string;
  if (value.startsWith('file://')) {
    try {
      path = fileURLToPath(value);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    return null;
  } else {
    try {
      path = decodeURIComponent(value);
    } catch {
      return null;
    }
  }

  if (!supportedImageExtensions.has(extname(path).toLowerCase())) return null;
  if (isAbsolute(path)) return path;
  if (!cwd || !isAbsolute(cwd)) return null;
  const absolutePath = resolve(cwd, path);
  const relativePath = relative(cwd, absolutePath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return null;
  }
  return absolutePath;
}

function applyReplacements(content: string, replacements: SourceReplacement[]): string {
  let hydrated = content;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    hydrated = `${hydrated.slice(0, replacement.start)}${replacement.value}${hydrated.slice(replacement.end)}`;
  }
  return hydrated;
}

function findCodeBlocks(content: string): CodeBlockRange[] {
  const ranges: CodeBlockRange[] = [];
  const fenceRegex = /(^|\n)(```|~~~)/g;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(content)) !== null) {
    const fence = match[2]!;
    const prefix = match[1]!;
    const start = match.index + prefix.length;
    const closeRegex = new RegExp(`(^|\\n)${fence}`, 'g');
    closeRegex.lastIndex = start + fence.length;
    const close = closeRegex.exec(content);
    if (!close) {
      ranges.push({ start, end: content.length });
      break;
    }
    const end = close.index + close[1]!.length + fence.length;
    ranges.push({ start, end });
    fenceRegex.lastIndex = end;
  }

  return ranges;
}

function isInsideCodeBlock(index: number, ranges: CodeBlockRange[]): boolean {
  return ranges.some((range) => index >= range.start && index <= range.end);
}
