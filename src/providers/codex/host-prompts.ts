import { normalizePromptContent, type PromptPart } from '../../core/prompt-content';
import type { v2 } from '@korus-dev/codex-sdk';
import type {
  CodexReviewTarget,
  Skill,
  SkillInput,
  ConversationMessage,
  ConversationMessageToolPart,
} from '../../core/codex-host';

export type GoalSlashCommand =
  | { action: 'clear' }
  | { action: 'edit' }
  | { action: 'set'; objective: string }
  | { action: 'show' }
  | { action: 'unsupported' };

export function mcpElicitationResponse(
  decision: 'allow' | 'allow_conversation' | 'always_allow' | 'deny',
): v2.McpServerElicitationRequestResponse {
  switch (decision) {
    case 'allow':
      return { action: 'accept', content: null, _meta: null };
    case 'allow_conversation':
      return { action: 'accept', content: null, _meta: { persist: 'session' } };
    case 'always_allow':
      return { action: 'accept', content: null, _meta: { persist: 'always' } };
    case 'deny':
      return { action: 'decline', content: null, _meta: null };
  }
}

export function parsePlanSlashCommand(prompt: string): { prompt: string | null } | null {
  const match = /^\/plan(?:\s(.*))?$/s.exec(prompt.trim());
  if (!match) return null;
  const planPrompt = match[1]?.trim() ?? '';
  return { prompt: planPrompt || null };
}

export function parseGoalSlashCommand(prompt: string): GoalSlashCommand | null {
  const match = /^\/goal(?:\s(.*))?$/s.exec(prompt.trim());
  if (!match) return null;
  const rest = match[1]?.trim() ?? '';
  if (!rest) return { action: 'show' };
  if (rest.toLowerCase() === 'clear') return { action: 'clear' };
  if (rest.toLowerCase() === 'edit') return { action: 'edit' };
  if (rest.toLowerCase() === 'pause' || rest.toLowerCase() === 'resume') return { action: 'unsupported' };
  return { action: 'set', objective: rest };
}

export function parseReviewSlashCommand(prompt: string): CodexReviewTarget | null {
  const match = /^\/review(?:\s(.*))?$/s.exec(prompt.trim());
  if (!match) return null;
  const instructions = match[1]?.trim() ?? '';
  return instructions ? { type: 'custom', instructions } : { type: 'uncommittedChanges' };
}

export function normalizeReviewTarget(target: CodexReviewTarget): v2.ReviewTarget {
  if (target.type === 'commit') return { ...target, title: target.title ?? null };
  return { ...target };
}

export function authoredPromptContent(content?: readonly PromptPart[]): PromptPart[] | undefined {
  if (content === undefined) return undefined;
  const normalized = normalizePromptContent(content);
  return normalized;
}

export function promptSkillInputsFromContent(content: readonly PromptPart[] = []): SkillInput[] {
  return content.flatMap(part => part.type === 'mention' && part.kind === 'skill'
    ? [{ name: part.value, path: part.id }] : []);
}

/** The mentions Codex receives as inputs of their own: files, and the plugins Codex knows (not the app's own). */
export function promptMentionInputs(content: readonly PromptPart[] = [], isAppPlugin?: (pluginId: string) => boolean): Extract<v2.UserInput, { type: 'mention' }>[] {
  return content.flatMap(part => part.type === 'mention' && (part.kind === 'file' || part.kind === 'plugin' && !isAppPlugin?.(part.id))
    ? [{ type: 'mention' as const, name: part.label, path: part.kind === 'plugin' ? `plugin://${part.id}` : part.id }] : []);
}

export function validateSkillInputs(
  inputs: readonly SkillInput[],
  catalog: readonly Skill[],
): SkillInput[] {
  return inputs.map((input) => {
    const match = catalog.find((skill) => (
      skill.enabled
      && skill.name === input.name
      && skill.path === input.path
    ));
    if (!match) {
      throw new Error(`Skill '${input.name}' is not an enabled skill in the Codex catalog`);
    }
    return { name: match.name, path: match.path };
  });
}

export function mergeSkillInputs(
  ...groups: readonly (readonly SkillInput[])[]
): SkillInput[] {
  const seen = new Set<string>();
  return groups.flatMap((group) => group.filter((skill) => {
    const key = `${skill.name}\u0000${skill.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

export function findPendingMcpToolPart(
  messages: readonly ConversationMessage[],
  turnId: string,
  server: string,
  tool: string,
): ConversationMessageToolPart | null {
  const running = messages
    .filter((message) => message.metadata?.turnId === turnId)
    .flatMap((message) => message.parts)
    .filter((part): part is ConversationMessageToolPart => (
      part.type === 'tool' && part.kind === 'mcp' && part.status === 'running'
    ));
  const exact = running.find((part) => {
    const metadataServer = stringValue(part.metadata?.server);
    const metadataTool = stringValue(part.metadata?.tool);
    return (
      (metadataServer === server && metadataTool === tool)
      || part.title.endsWith(`.${tool}`)
    );
  });
  return exact ?? (running.length === 1 ? running[0] ?? null : null);
}

export function argumentsPreview(meta: Record<string, unknown>): string {
  if (Array.isArray(meta.tool_params_display)) {
    const lines = meta.tool_params_display.map((entry) => {
      if (!isRecord(entry) || typeof entry.name !== 'string') return '';
      const label = stringValue(entry.display_name) ?? entry.name;
      const value = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
      return `${label}: ${value}`;
    }).filter(Boolean);
    if (lines.length > 0) return lines.join('\n');
  }
  return meta.tool_params === undefined ? '' : JSON.stringify(meta.tool_params, null, 2);
}

export function persistSupports(value: unknown, mode: 'always' | 'session'): boolean {
  return value === mode || (Array.isArray(value) && value.includes(mode));
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizedConversationId(value: string): string {
  const conversationId = value.trim();
  if (!conversationId) throw new Error('Conversation id cannot be empty');
  return conversationId;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
