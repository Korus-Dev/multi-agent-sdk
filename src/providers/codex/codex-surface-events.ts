import type { v2 } from '@korus-dev/codex-sdk';
import type {
  CodexSurfaceEvent,
  CodexSurfaceJsonValue,
  CodexSurfaceTurn,
  CodexSurfaceTurnError,
} from '../../core/surface';

export type SurfaceEventInput = CodexSurfaceEvent extends infer Event
  ? Event extends CodexSurfaceEvent
    ? Omit<Event, 'seq' | 'occurredAt' | 'origin'>
    : never
  : never;

export function threadItemKey(threadId: string, itemId: string): string {
  return `${threadId}\u0000${itemId}`;
}

export function timestampToIso(timestamp: number | null | undefined): string {
  return typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? new Date(timestamp * 1000).toISOString()
    : new Date().toISOString();
}

export function timestampToIsoOrNull(timestamp: number | null | undefined): string | null {
  return typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? new Date(timestamp * 1000).toISOString()
    : null;
}

export function surfaceTurnError(error: v2.TurnError | null): CodexSurfaceTurnError | null {
  if (!error) return null;
  return {
    message: error.message,
    additionalDetails: error.additionalDetails,
    codexErrorInfo: error.codexErrorInfo as CodexSurfaceJsonValue | null,
    ...(error.misalignment ? { misalignment: { ...error.misalignment, steer: error.misalignment.steer ? { ...error.misalignment.steer } : null } } : {}),
  };
}

export function surfaceTurn(turn: v2.Turn, willRetry = false): CodexSurfaceTurn {
  return {
    id: turn.id,
    ...(turn.itemsView === 'summary' || turn.itemsView === 'notLoaded' ? { itemsView: 'summary' as const } : {}),
    status: turn.status,
    error: surfaceTurnError(turn.error),
    willRetry,
    startedAt: timestampToIsoOrNull(turn.startedAt),
    completedAt: timestampToIsoOrNull(turn.completedAt),
    durationMs: turn.durationMs ?? null,
  };
}

export function upsertSurfaceTurn(
  turns: readonly CodexSurfaceTurn[],
  turn: CodexSurfaceTurn,
): CodexSurfaceTurn[] {
  const index = turns.findIndex((candidate) => candidate.id === turn.id);
  if (index < 0) return [...turns, turn];
  const next = [...turns];
  next.splice(index, 1, { ...turn, startedAt: turn.startedAt ?? turns[index]!.startedAt });
  return next;
}

export function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createMessageId(): string {
  return `user-${globalThis.crypto.randomUUID()}`;
}

export function createQueuedPromptId(): string {
  return `queued-prompt-${globalThis.crypto.randomUUID()}`;
}
