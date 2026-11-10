/** Serializable authored content. Mentions exist only after explicit selection. */
export type CodexPromptMention = {
  type: 'mention';
  kind: 'skill' | 'plugin' | 'file' | 'custom';
  id: string;
  /** Exact visible chip label, without an added $ or @ prefix. */
  label: string;
  /** Selected catalog name/value; never inferred from surrounding text. */
  value: string;
  groupId?: string;
};

export type CodexPromptPart = { type: 'text'; text: string } | CodexPromptMention;

export function promptContentText(content: readonly CodexPromptPart[]): string {
  return content.map(part => part.type === 'text' ? part.text : part.label).join('');
}

function linkedReference(part: CodexPromptMention): string {
  const name = (part.kind === 'custom' ? part.label : part.value).replace(/[\\[\]]/g, '\\$&');
  const target = part.kind === 'plugin' ? `plugin://${part.id}` : part.id;
  const encodeDelimiter = (char: string) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
  const path = part.kind === 'custom'
    ? `mention://${encodeURIComponent(part.groupId ?? 'custom')}/${encodeURIComponent(part.id)}?value=${encodeURIComponent(part.value)}`
    : encodeURI(target).replace(/[?#]/g, encodeDelimiter);
  return `[${part.kind === 'skill' ? '$' : '@'}${name}](${path.replace(/[()]/g, encodeDelimiter)})`;
}

/** Model-facing references. An optional prompt retains context after its authored prefix. */
export function promptContentDispatchText(content: readonly CodexPromptPart[], prompt?: string): string {
  const text = content.map(part => part.type === 'text' ? part.text
    : part.kind === 'file' ? `@${part.id}` : linkedReference(part)).join('');
  if (prompt === undefined) return text;
  const visible = promptContentText(content);
  if (prompt.startsWith(text) || !prompt.startsWith(visible)) return prompt;
  return text + prompt.slice(visible.length);
}

/** Offsets are UTF-16 visible-text offsets, as in JavaScript strings and DOM selections. */
export function slicePromptContent(content: readonly CodexPromptPart[], start: number, end = promptContentText(content).length): CodexPromptPart[] {
  let offset = 0;
  return normalizePromptContent(content).flatMap((part): CodexPromptPart[] => {
    const text = part.type === 'text' ? part.text : part.label;
    const from = Math.max(0, start - offset);
    const to = Math.min(text.length, end - offset);
    offset += text.length;
    if (from >= to) return [];
    return part.type === 'mention' && from === 0 && to === text.length
      ? [part] : [{ type: 'text', text: text.slice(from, to) }];
  });
}

export function replacePromptContentRange(
  content: readonly CodexPromptPart[], start: number, end: number, replacement: readonly CodexPromptPart[],
): CodexPromptPart[] {
  return normalizePromptContent([...slicePromptContent(content, 0, start), ...normalizePromptContent(replacement), ...slicePromptContent(content, Math.max(start, end))]);
}

/** Validate and copy content at transport and persisted-message boundaries. */
export function normalizePromptContent(content: unknown): CodexPromptPart[] {
  if (!Array.isArray(content)) throw new Error('Prompt content must be an array');
  const parts = content.map((part: unknown): CodexPromptPart => {
    if (!part || typeof part !== 'object') throw new Error('Invalid prompt content part');
    const value = part as Record<string, unknown>;
    if (value.type === 'text' && typeof value.text === 'string') return { type: 'text', text: value.text };
    if (value.type !== 'mention' || !['skill', 'plugin', 'file', 'custom'].includes(value.kind as string)
      || !['id', 'label', 'value'].every(key => typeof value[key] === 'string' && value[key] !== '')
      || (value.groupId !== undefined && typeof value.groupId !== 'string')) {
      throw new Error('Invalid prompt mention');
    }
    return {
      type: 'mention', kind: value.kind as CodexPromptMention['kind'],
      id: value.id as string, label: value.label as string, value: value.value as string,
      ...(value.groupId === undefined ? {} : { groupId: value.groupId as string }),
    };
  });
  const normalized: CodexPromptPart[] = [];
  for (const part of parts) {
    const previous = normalized.at(-1);
    if (part.type === 'text') {
      if (!part.text) continue;
      if (previous?.type === 'text') { previous.text += part.text; continue; }
    }
    normalized.push(part);
  }
  return normalized;
}

export function trimPromptContent(content: readonly CodexPromptPart[]): CodexPromptPart[] {
  const parts = normalizePromptContent(content);
  while (parts[0]?.type === 'text') {
    parts[0].text = parts[0].text.trimStart();
    if (parts[0].text) break;
    parts.shift();
  }
  while (parts.at(-1)?.type === 'text') {
    const last = parts.at(-1) as Extract<CodexPromptPart, { type: 'text' }>;
    last.text = last.text.trimEnd();
    if (last.text) break;
    parts.pop();
  }
  return parts;
}
