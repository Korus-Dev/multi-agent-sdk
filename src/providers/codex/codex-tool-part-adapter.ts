import { isAbsolute, resolve } from 'node:path';
import type {
  CodexSurfaceFileActivityAction,
  CodexSurfaceFileActivityStatus,
  SurfaceMessageToolPart as ToolPart,
  SurfaceMessageToolPartUpdate as ToolPartUpdate,
} from '../../core/surface';
import { toolOutputText } from './tool-output';

const structuredToolResultNotice = 'Result returned in structuredContent.';
const MAX_TOOL_PAYLOAD_BYTES = 32 * 1024;

export type CodexToolPartAdapterOptions = {
  includeCommandOutput?: boolean;
  cwd?: string | null;
};

export type CodexFileActivity = {
  action: CodexSurfaceFileActivityAction;
  path: string;
  status: CodexSurfaceFileActivityStatus;
};

export function codexToolPartFileActivities(
  toolPart: ToolPart,
  cwd?: string | null,
): CodexFileActivity[] {
  const status = toolPart.status;
  if (toolPart.kind === 'command') {
    const input = isRecord(toolPart.input) ? toolPart.input : {};
    const commandCwd = typeof input.cwd === 'string' ? input.cwd : cwd ?? undefined;
    const actions = normalizedCommandActions(input.commandActions);
    return actions.flatMap((action) => {
      if (action.type !== 'read') return [];
      const path = fullFilePath(action.path ?? action.name, commandCwd);
      return path ? [{ action: 'read' as const, path, status }] : [];
    });
  }

  if (toolPart.kind !== 'fileChange') return [];
  const input = isRecord(toolPart.input) ? toolPart.input : {};
  const metadata = toolPart.metadata ?? {};
  const changes = Array.isArray(metadata.changes)
    ? metadata.changes
    : Array.isArray(input.changes) ? input.changes : [];
  return changes.flatMap((change) => {
    if (!isRecord(change) || typeof change.path !== 'string') return [];
    const kind = patchChangeKind(change.kind);
    if (kind === 'delete') return [];
    const path = fullFilePath(change.path, cwd ?? undefined);
    return path ? [{ action: kind === 'add' ? 'create' as const : 'edit' as const, path, status }] : [];
  });
}

export function codexThreadItemToToolPart(item: unknown, options: CodexToolPartAdapterOptions = {}): ToolPart | null {
  if (!isRecord(item) || typeof item.id !== 'string') {
    return null;
  }

  if (item.type === 'commandExecution') {
    const command = typeof item.command === 'string' ? item.command : 'command';
    const status = toolStatus(item.status);
    const statusText = commandStatusText(status, item.commandActions, command);
    const body = options.includeCommandOutput && typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : undefined;
    return {
      type: 'tool',
      id: item.id,
      kind: 'command',
      title: command,
      status,
      ...(statusText ? { statusText } : {}),
      ...(body !== undefined ? { body } : {}),
      input: {
        command,
        cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
        commandActions: item.commandActions,
      },
      output: {
        exitCode: typeof item.exitCode === 'number' ? item.exitCode : undefined,
        durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
      },
      metadata: {
        source: item.source,
        processId: item.processId,
      },
    };
  }

  if (item.type === 'mcpToolCall') {
    const server = typeof item.server === 'string' ? item.server : 'mcp';
    const tool = typeof item.tool === 'string' ? item.tool : 'tool';
    const errorMessage = boundedToolText(mcpErrorMessage(item.error));
    const input = boundedToolPayload(item.arguments);
    const output = boundedToolPayload(item.result);
    return {
      type: 'tool',
      id: item.id,
      kind: 'mcp',
      title: `${server}.${tool}`,
      status: toolStatus(item.status),
      body: errorMessage ?? boundedToolText(mcpResultText(output)),
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      metadata: {
        server,
        tool,
        pluginId: item.pluginId,
        mcpAppResourceUri: item.mcpAppResourceUri,
        durationMs: item.durationMs,
      },
    };
  }

  if (item.type === 'dynamicToolCall') {
    const tool = typeof item.tool === 'string' ? item.tool : 'tool';
    const namespace = typeof item.namespace === 'string' ? item.namespace : null;
    const input = boundedToolPayload(item.arguments);
    const output = boundedToolPayload(item.contentItems);
    return {
      type: 'tool',
      id: item.id,
      kind: 'dynamic',
      title: namespace ? `${namespace}.${tool}` : tool,
      status: toolStatus(item.status),
      body: boundedToolText(dynamicToolContentText(output)),
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      metadata: {
        namespace,
        tool,
        success: item.success,
        durationMs: item.durationMs,
      },
    };
  }

  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const status = toolStatus(item.status);
    const statusText = fileChangeStatusText(status, changes);
    return {
      type: 'tool',
      id: item.id,
      kind: 'fileChange',
      title: changes.length === 1 ? '1 file change' : `${changes.length} file changes`,
      status,
      ...(statusText ? { statusText } : {}),
      body: fileChangesText(changes),
      input: { changes },
      metadata: {
        changes,
        ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : options.cwd ? { cwd: options.cwd } : {}),
      },
    };
  }

  if (item.type === 'webSearch') {
    const query = typeof item.query === 'string' && item.query.trim() ? item.query.trim() : 'web search';
    return {
      type: 'tool',
      id: item.id,
      kind: 'webSearch',
      title: 'Web search',
      status: 'completed',
      body: query,
      input: item.action ?? { query },
      metadata: {
        query,
        action: item.action,
      },
    };
  }

  if (item.type === 'imageView' && typeof item.path === 'string') {
    return { type: 'tool', id: item.id, kind: 'dynamic', title: 'view_image',
      status: 'completed', input: { path: item.path } };
  }

  if (item.type === 'imageGeneration') {
    return {
      type: 'tool',
      id: item.id,
      kind: 'dynamic',
      title: 'image_generation',
      status: toolStatus(item.status),
      body: typeof item.revisedPrompt === 'string' ? item.revisedPrompt : undefined,
      input: {
        revisedPrompt: item.revisedPrompt,
      },
      output: item.savedPath,
      metadata: {
        savedPath: item.savedPath,
      },
    };
  }

  return null;
}

export function shouldForwardCommandExecutionOutput(item: unknown): boolean {
  if (!isRecord(item) || item.type !== 'commandExecution' || typeof item.command !== 'string') {
    return false;
  }

  const command = item.command;
  return isApplyPatchCommand(command) || isShellRedirectWriteCommand(command) || isTeeWriteCommand(command);
}

export function commandOutputDeltaToToolPartUpdate(itemId: string, delta: string): ToolPartUpdate {
  return {
    itemId,
    bodyDelta: delta,
    fallbackToolPart: {
      type: 'tool',
      id: itemId,
      kind: 'command',
      title: 'Command',
      status: 'running',
    },
  };
}

export function fileChangePatchToToolPartUpdate(itemId: string, changes: unknown[]): ToolPartUpdate {
  const statusText = fileChangeStatusText('running', changes);
  return {
    itemId,
    body: fileChangesText(changes),
    ...(statusText ? { statusText } : {}),
    input: { changes },
    metadata: { changes },
    fallbackToolPart: {
      type: 'tool',
      id: itemId,
      kind: 'fileChange',
      title: changes.length === 1 ? '1 file change' : `${changes.length} file changes`,
      status: 'running',
      ...(statusText ? { statusText } : {}),
      body: fileChangesText(changes),
      input: { changes },
      metadata: { changes },
    },
  };
}

export function mcpProgressToToolPartUpdate(itemId: string, message: string): ToolPartUpdate {
  return {
    itemId,
    bodyAppend: message,
    fallbackToolPart: {
      type: 'tool',
      id: itemId,
      kind: 'mcp',
      title: 'MCP tool',
      status: 'running',
    },
  };
}

export function rawOutputToToolPartUpdate(itemId: string, output: unknown, title?: string, status: unknown = 'completed'): ToolPartUpdate {
  const boundedOutput = boundedToolPayload(output);
  const body = boundedToolText(toolOutputText(boundedOutput));
  return {
    itemId,
    title: title && title.trim() ? title : undefined,
    status: toolStatus(status),
    body,
    ...(boundedOutput !== undefined ? { output: boundedOutput } : {}),
    fallbackToolPart: {
      type: 'tool',
      id: itemId,
      kind: 'generic',
      title: title && title.trim() ? title : 'Tool output',
      status: toolStatus(status),
      body,
      ...(boundedOutput !== undefined ? { output: boundedOutput } : {}),
    },
  };
}

function toolStatus(status: unknown): ToolPart['status'] {
  if (status === 'completed' || status === 'succeeded' || status === 'success') {
    return 'completed';
  }

  if (status === 'failed' || status === 'error' || status === 'declined' || status === 'incomplete' || status === 'canceled' || status === 'cancelled') {
    return 'failed';
  }

  return 'running';
}

function commandStatusText(status: ToolPart['status'], commandActions: unknown, command: string): string | undefined {
  const descriptor = commandStatusDescriptor(status, commandActions, command);
  return descriptor ? JSON.stringify(descriptor) : undefined;
}

function commandStatusDescriptor(status: ToolPart['status'], commandActions: unknown, command: string): {
  action: 'edit' | 'explore' | 'list' | 'read' | 'run' | 'search';
  phase: ToolPart['status'];
  params: Record<string, unknown>;
  source: 'codex';
} | undefined {
  const actions = normalizedCommandActions(commandActions);
  const actionTypes = new Set(actions.map((action) => action.type));
  if (actions.length === 0) {
    return {
      action: 'run',
      phase: status,
      params: { target: command },
      source: 'codex',
    };
  }

  if (actionTypes.size === 1 && actionTypes.has('read')) {
    const names = uniqueNonEmpty(actions.map((action) => action.name ?? action.path));
    return {
      action: 'read',
      phase: status,
      params: {
        names,
        target: formatReadTargetList(names, command),
      },
      source: 'codex',
    };
  }

  if (actionTypes.size === 1 && actionTypes.has('listFiles')) {
    const targets = uniqueNonEmpty(actions.map((action) => action.path ?? action.command));
    return {
      action: 'list',
      phase: status,
      params: {
        targets,
        target: formatTargetList(targets, command),
      },
      source: 'codex',
    };
  }

  if (actionTypes.size === 1 && actionTypes.has('search')) {
    const searches = actions.map((action) => {
      if (action.query && action.path) {
        return `"${action.query}" in ${action.path}`;
      }

      return action.query ?? action.path ?? action.command;
    });
    const targets = uniqueNonEmpty(searches);
    return {
      action: 'search',
      phase: status,
      params: {
        targets,
        target: formatTargetList(targets, command),
      },
      source: 'codex',
    };
  }

  return {
    action: 'explore',
    phase: status,
    params: {
      actions: actions.map((action) => action.type),
      target: formatTargetList(uniqueNonEmpty(actions.map(commandActionTarget)), command),
    },
    source: 'codex',
  };
}

function commandActionTarget(action: NormalizedCommandAction): string | undefined {
  return action.path ?? action.name ?? action.query ?? action.command;
}

type NormalizedCommandAction = {
  command?: string;
  name?: string;
  path?: string;
  query?: string;
  type: 'listFiles' | 'read' | 'search';
};

function normalizedCommandActions(value: unknown): NormalizedCommandAction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    if (entry.type !== 'read' && entry.type !== 'listFiles' && entry.type !== 'search') {
      return [];
    }

    return [{
      command: typeof entry.command === 'string' ? entry.command : undefined,
      name: typeof entry.name === 'string' ? entry.name : undefined,
      path: typeof entry.path === 'string' ? entry.path : undefined,
      query: typeof entry.query === 'string' ? entry.query : undefined,
      type: entry.type,
    }];
  });
}

function isApplyPatchCommand(command: string): boolean {
  return /(?:^|[\s;"'(|&])apply_patch(?:\s|$)/u.test(command);
}

function isShellRedirectWriteCommand(command: string): boolean {
  return /(?:^|[\s;"'(|&])(?:cat|printf|echo)\b[\s\S]*>>?\s*(?:"[^"]+"|'[^']+'|[^\s;"'&|]+)(?=$|[\s;&|])/u.test(command);
}

function isTeeWriteCommand(command: string): boolean {
  return /(?:^|[\s;"'(|&])tee(?:\s+-a)?\s+(?!-)(?:"[^"]+"|'[^']+'|[^\s;"'&|]+)(?=$|[\s;&|])/u.test(command);
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function formatTargetList(values: string[], fallback: string): string {
  if (values.length === 0) {
    return fallback;
  }

  if (values.length <= 3) {
    return values.join(', ');
  }

  return `${values.slice(0, 3).join(', ')} and ${values.length - 3} more`;
}

function formatReadTargetList(values: string[], fallback: string): string {
  return formatFileTargetList(values, fallback);
}

function formatFileTargetList(values: string[], fallback: string): string {
  const names = uniqueNonEmpty(values.map(fileName));
  return formatTargetList(names, fallback);
}

function fileChangeStatusText(status: ToolPart['status'], changes: unknown[]): string | undefined {
  const descriptor = fileChangeStatusDescriptor(status, changes);
  return descriptor ? JSON.stringify(descriptor) : undefined;
}

function fileChangeStatusDescriptor(status: ToolPart['status'], changes: unknown[]): {
  action: 'create' | 'delete' | 'edit';
  phase: ToolPart['status'];
  params: Record<string, unknown>;
  source: 'codex';
} | undefined {
  const normalizedChanges = changes.flatMap((change) => {
    if (!isRecord(change)) {
      return [];
    }

    const path = typeof change.path === 'string' ? change.path : undefined;
    const kind = patchChangeKind(change.kind);
    const lineDiff = lineDiffFromFileChange(change);
    return [{
      addedLines: lineDiff.addedLines,
      kind,
      path,
      removedLines: lineDiff.removedLines,
    }];
  });

  if (!normalizedChanges.length) {
    return undefined;
  }

  const addedLines = normalizedChanges.reduce((total, change) => total + change.addedLines, 0);
  const removedLines = normalizedChanges.reduce((total, change) => total + change.removedLines, 0);
  const paths = uniqueNonEmpty(normalizedChanges.map((change) => change.path));
  const target = formatFileTargetList(paths, `${normalizedChanges.length} files`);
  return {
    action: fileChangeAction(normalizedChanges.map((change) => change.kind)),
    phase: status,
    params: {
      addedLines,
      path: paths.length === 1 ? paths[0] : undefined,
      removedLines,
      target,
    },
    source: 'codex',
  };
}

function fileChangeAction(kinds: Array<'add' | 'delete' | undefined>): 'create' | 'delete' | 'edit' {
  if (kinds.every((kind) => kind === 'add')) {
    return 'create';
  }

  if (kinds.every((kind) => kind === 'delete')) {
    return 'delete';
  }

  return 'edit';
}

function lineDiffFromFileChange(change: Record<string, unknown>): { addedLines: number; removedLines: number } {
  const diff = typeof change.diff === 'string' ? change.diff : undefined;
  const kind = patchChangeKind(change.kind);
  if (kind === 'add') {
    return { addedLines: rawContentLineCount(diff), removedLines: 0 };
  }
  if (kind === 'delete') {
    return { addedLines: 0, removedLines: rawContentLineCount(diff) };
  }

  return lineDiffFromUnifiedDiff(diff);
}

export function lineDiffFromUnifiedDiff(diff: string | undefined): { addedLines: number; removedLines: number } {
  if (!diff) {
    return { addedLines: 0, removedLines: 0 };
  }

  let addedLines = 0;
  let removedLines = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }

    if (line.startsWith('+')) {
      addedLines += 1;
    } else if (line.startsWith('-')) {
      removedLines += 1;
    }
  }

  return { addedLines, removedLines };
}

function patchChangeKind(kind: unknown): 'add' | 'delete' | undefined {
  if (kind === 'add' || kind === 'delete') {
    return kind;
  }

  if (isRecord(kind) && typeof kind.type === 'string') {
    return patchChangeKind(kind.type);
  }

  return undefined;
}

function fullFilePath(value: string | undefined, cwd: string | undefined): string | undefined {
  const path = value?.trim();
  if (!path) return undefined;
  if (isAbsolute(path)) return path;
  if (!cwd || !isAbsolute(cwd)) return undefined;
  return resolve(cwd, path);
}

function rawContentLineCount(content: string | undefined): number {
  if (!content) {
    return 0;
  }

  const lines = content.split(/\r\n|\r|\n/);
  while (lines.at(-1) === '') {
    lines.pop();
  }
  return lines.length;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function mcpErrorMessage(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.message === 'string' ? error.message : undefined;
}

function mcpResultText(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const contentText = mcpContentText(result.content);
  const structuredText = 'structuredContent' in result ? toolOutputText(result.structuredContent) : undefined;
  if (!structuredText) {
    return contentText;
  }

  if (!contentText || contentText.trim() === structuredToolResultNotice) {
    return structuredText;
  }

  return `${contentText}\n\n${structuredText}`;
}

function mcpContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  return content
    .map((entry) => {
      if (!isRecord(entry)) {
        return '';
      }

      if (typeof entry.text === 'string') {
        return entry.text;
      }

      return JSON.stringify(entry);
    })
    .filter(Boolean)
    .join('\n\n') || undefined;
}

function dynamicToolContentText(contentItems: unknown): string | undefined {
  if (!Array.isArray(contentItems)) {
    return undefined;
  }

  return contentItems
    .map((entry) => {
      if (isRecord(entry) && typeof entry.text === 'string') {
        return entry.text;
      }

      return JSON.stringify(entry);
    })
    .filter(Boolean)
    .join('\n\n') || undefined;
}

function fileChangesText(changes: unknown[]): string | undefined {
  return changes
    .map((change) => {
      if (!isRecord(change)) {
        return JSON.stringify(change);
      }

      const kind = patchChangeKind(change.kind) ?? 'update';
      const path = typeof change.path === 'string' ? change.path : 'unknown';
      return `${kind} ${path}`;
    })
    .join('\n') || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedToolText(value: string | undefined): string | undefined {
  return value !== undefined && Buffer.byteLength(value) <= MAX_TOOL_PAYLOAD_BYTES ? value : undefined;
}

function boundedToolPayload(value: unknown): unknown {
  if (value === undefined || !jsonValueFitsByteBudget(value, MAX_TOOL_PAYLOAD_BYTES)) {
    return undefined;
  }
  return value;
}

function jsonValueFitsByteBudget(value: unknown, maxBytes: number): boolean {
  if (jsonValueContainsOversizedStringOrCycle(value, maxBytes, new Set<object>())) {
    return false;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && Buffer.byteLength(serialized) <= maxBytes;
  } catch {
    return false;
  }
}

function jsonValueContainsOversizedStringOrCycle(
  value: unknown,
  maxBytes: number,
  ancestors: Set<object>,
): boolean {
  if (typeof value === 'string') return Buffer.byteLength(value) > maxBytes;
  if (value === null || typeof value !== 'object') return false;
  if (ancestors.has(value)) return true;

  ancestors.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value);
  const oversized = entries.some((entry) => jsonValueContainsOversizedStringOrCycle(entry, maxBytes, ancestors));
  ancestors.delete(value);
  return oversized;
}
