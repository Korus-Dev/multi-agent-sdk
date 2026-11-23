import { record } from '../../acp/acp-connection';
import type { ToolPart } from '../../contracts/index';

type Action = 'run' | 'read' | 'create' | 'edit' | 'delete' | 'move' | 'list' | 'search'
  | 'fetch' | 'manage_agents' | 'message' | 'switch_mode' | 'think';

const namedActions = new Map<string, Action>([
  ['run_command', 'run'],
  ['read_file', 'read'], ['view_file', 'read'], ['client_view_file', 'read'],
  ['create_file', 'create'],
  ['edit_file', 'edit'], ['write_file', 'edit'], ['replace_file_content', 'edit'], ['multi_replace_file_content', 'edit'],
  ['delete_file', 'delete'], ['move_file', 'move'], ['rename_file', 'move'],
  ['list_directory', 'list'], ['list_dir', 'list'],
  ['search_directory', 'search'], ['find_file', 'search'], ['grep_search', 'search'], ['search_web', 'search'],
  ['read_url_content', 'fetch'], ['fetch_url', 'fetch'],
  ['manage_subagents', 'manage_agents'], ['send_message', 'message'],
]);

const kindActions = new Map<string, Action>([
  ['command', 'run'], ['read', 'read'], ['edit', 'edit'], ['delete', 'delete'], ['move', 'move'],
  ['search', 'search'], ['fetch', 'fetch'], ['switch_mode', 'switch_mode'], ['think', 'think'],
]);

const fileActions = new Set<Action>(['read', 'create', 'edit', 'delete']);

/** Preserve native operation details across partial updates and project UI-neutral status. */
export function projectNativeToolStatus(part: ToolPart, update: Record<string, unknown>): string | undefined {
  const input = record(part.input) ? part.input : {};
  const nativeName = typeof update.name === 'string' ? update.name : part.metadata?.nativeToolName;
  const name = typeof nativeName === 'string' ? nativeName
    : part.kind === 'command' ? undefined : /^Run ([a-z_]+)\??$/.exec(part.title)?.[1];
  const fileTitle = /^File (.+)$/.exec(part.title)?.[1];
  const unlabelledRead = !name && fileTitle !== undefined && (part.kind === 'other' || part.kind === 'tool');
  const namedAction = name ? namedActions.get(name) : undefined;
  const action = namedAction ?? kindActions.get(part.kind ?? '') ?? (unlabelledRead ? 'read' : undefined);
  if (!action) return;
  if (namedAction && part.metadata) part.metadata.nativeToolName = name;

  const genericTitle = part.title === 'Antigravity tool' || (name && (part.title === `Run ${name}` || part.title === `Run ${name}?`));
  const displayTitle = genericTitle ? '' : part.title;
  const location = Array.isArray(update.locations) ? update.locations.find(entry => record(entry) && typeof entry.path === 'string')?.path : undefined;
  let target: string | undefined;
  if (fileActions.has(action)) {
    target = firstText(input.Path, input.TargetFile, location, input.path, fileTitle, displayTitle.replace(/^(?:Read|Edit|Create|Write|Delete)\s+/i, ''));
    if (target) part.input = { ...input, path: target };
    if (action === 'read') part.kind = 'read';
  } else {
    switch (action) {
      case 'run': target = firstText(input.CommandLine, input.command, displayTitle); break;
      case 'list':
        target = firstText(input.Path, input.Directory, location, input.path, displayTitle.replace(/^List\s+/i, ''));
        if (target) part.input = { ...input, path: target };
        break;
      case 'search':
        target = firstText(input.Query, input.Pattern, input.query, input.pattern, displayTitle.replace(/^Search\s+/i, ''));
        if (name === 'search_web') part.kind = 'webSearch';
        break;
      case 'fetch': target = firstText(input.Url, input.URL, input.url, displayTitle.replace(/^Fetch\s+/i, '')); break;
      case 'move': {
        const from = firstText(input.Source, input.From, input.source, input.path, location);
        const to = firstText(input.Destination, input.To, input.destination);
        target = from && to ? `${from} → ${to}` : from ?? to ?? firstText(displayTitle.replace(/^(?:Move|Rename)\s+/i, ''));
        break;
      }
      case 'switch_mode': target = firstText(input.Mode, input.ModeId, input.mode, input.modeId, displayTitle.replace(/^Switch(?: to)?\s+/i, '')); break;
    }
  }
  return JSON.stringify({ source: 'antigravity', action, phase: part.status, params: { target: target ?? '' } });
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}
