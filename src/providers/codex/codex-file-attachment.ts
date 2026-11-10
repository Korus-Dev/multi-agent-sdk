import type { v2 } from 'codex-sdk';

const prefix = '<attached_file>\n';
const suffix = '\n</attached_file>';

// Generic mentions are not forwarded to the model by app-server. Keep file
// references in text, with an exact envelope we can restore as a history chip.
export function fileAttachmentInput(name: string, path: string): v2.UserInput {
  const reference = JSON.stringify({ name, path }).replaceAll('<', '\\u003c');
  return { type: 'text', text: `${prefix}${reference}${suffix}`, text_elements: [] };
}

export function fileAttachmentReference(text: string): { name: string; path: string } | null {
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return null;
  try {
    const value: unknown = JSON.parse(text.slice(prefix.length, -suffix.length));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const reference = value as Record<string, unknown>;
    return typeof reference.name === 'string' && typeof reference.path === 'string' && reference.path.length > 0
      ? { name: reference.name, path: reference.path }
      : null;
  } catch {
    return null;
  }
}
