import type { v2 } from 'codex-sdk';
import type {
  SurfaceMessage,
  SurfaceMessageMediaPart,
  SurfaceMessageQuestionPart,
  SurfaceMessageReasoningPart,
  SurfaceMessageTextPart,
  SurfaceMessageToolPart,
  SurfaceMessageToolPartUpdate,
} from 'multi-agents-sdk/surface';
import { isRecord } from './codex-surface-prompts';

export function activeTurnId(turns: v2.Turn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.status === 'inProgress') return turn.id;
  }
  return null;
}

export function ensureAssistantTurnMessage(
  messages: readonly SurfaceMessage[],
  threadId: string,
  turnId: string,
  options: { createdAt?: string; forceSegment?: boolean } = {},
): SurfaceMessage[] {
  const next = [...messages];
  const lastTurnIndex = findLastIndex(next, (message) => message.metadata?.turnId === turnId);
  const lastTurnMessage = lastTurnIndex >= 0 ? next[lastTurnIndex] : undefined;
  if (
    lastTurnMessage?.role === 'assistant'
    && lastTurnMessage.kind === undefined
    && lastTurnMessage.status === 'streaming'
  ) {
    return next;
  }

  if (options.forceSegment) {
    const previousAssistantIndex = findLastIndex(next, (message) => (
      message.role === 'assistant'
      && message.kind === undefined
      && message.metadata?.turnId === turnId
    ));
    const previousAssistant = previousAssistantIndex >= 0 ? next[previousAssistantIndex] : undefined;
    if (previousAssistant?.parts.length === 0) {
      next.splice(previousAssistantIndex, 1);
    } else if (previousAssistant) {
      next.splice(previousAssistantIndex, 1, { ...previousAssistant, status: 'complete' });
    }
  } else {
    const existing = next.find((message) => (
      message.role === 'assistant'
      && message.kind === undefined
      && message.metadata?.turnId === turnId
      && message.status === 'streaming'
    ));
    if (existing) return next;
  }

  const segmentCount = next.filter((message) => (
    message.role === 'assistant'
    && message.kind === undefined
    && message.metadata?.turnId === turnId
  )).length;
  const id = segmentCount === 0 ? `assistant-${turnId}` : `assistant-${turnId}-segment-${segmentCount}`;
  next.push({
    id,
    role: 'assistant',
    status: 'streaming',
    turnId,
    parts: [],
    createdAt: options.createdAt ?? new Date().toISOString(),
    metadata: { conversationId: threadId, turnId },
  });
  return next;
}

export function assistantMessageContainingText(
  messages: readonly SurfaceMessage[],
  turnId: string,
  itemId: string,
): SurfaceMessage | undefined {
  return messages[findLastIndex(messages, message => message.role === 'assistant'
    && message.kind === undefined && message.metadata?.turnId === turnId
    && message.parts.some(part => part.type === 'text' && part.itemId === itemId))];
}

export function appendAssistantTextDelta(
  messages: readonly SurfaceMessage[],
  threadId: string,
  turnId: string,
  itemId: string,
  delta: string,
  phase?: SurfaceMessageTextPart['phase'],
): SurfaceMessage[] {
  if (!delta) return [...messages];
  // Steering creates a new segment, but an in-flight item still owns its
  // existing text. Only a new item starts writing after the steering marker.
  const existing = assistantMessageContainingText(messages, turnId, itemId);
  const next = existing ? [...messages] : ensureAssistantTurnMessage(messages, threadId, turnId);
  const messageIndex = existing ? next.indexOf(existing) : findLastIndex(next, (message) => (
    message.role === 'assistant'
    && message.kind === undefined
    && message.metadata?.turnId === turnId
  ));
  const message = messageIndex >= 0 ? next[messageIndex] : undefined;
  if (!message) return next;
  const parts = [...message.parts];
  const lastPart = parts.at(-1);
  if (lastPart?.type === 'text' && lastPart.itemId === itemId) {
    parts.splice(parts.length - 1, 1, {
      ...lastPart,
      text: `${lastPart.text}${delta}`,
      ...(phase ? { phase } : {}),
    });
  } else {
    parts.push({ type: 'text', text: delta, itemId, ...(phase ? { phase } : {}) });
  }
  next.splice(messageIndex, 1, { ...message, status: 'streaming', parts });
  return pruneEmptyAssistantPlaceholders(next, threadId);
}

export function upsertAssistantReasoningSummaries(
  messages: readonly SurfaceMessage[],
  threadId: string,
  turnId: string,
  itemId: string,
  summaries: readonly string[],
): SurfaceMessage[] {
  const normalized = summaries
    .map((summary, summaryIndex): SurfaceMessageReasoningPart | null => {
      const text = summary.trim();
      return text ? { type: 'reasoning', summary: text, itemId, summaryIndex } : null;
    })
    .filter((part): part is SurfaceMessageReasoningPart => part !== null);
  if (normalized.length === 0) normalized.push({ type: 'reasoning', summary: '', itemId, summaryIndex: 0 });

  const next = ensureAssistantTurnMessage(messages, threadId, turnId);
  const messageIndex = findLastIndex(next, (message) => (
    message.role === 'assistant'
    && message.kind === undefined
    && message.metadata?.turnId === turnId
  ));
  const message = messageIndex >= 0 ? next[messageIndex] : undefined;
  if (!message) return next;

  const firstExistingIndex = message.parts.findIndex((part) => (
    part.type === 'reasoning' && part.itemId === itemId
  ));
  const parts = message.parts.filter((part) => (
    part.type !== 'reasoning' || part.itemId !== itemId
  ));
  parts.splice(firstExistingIndex >= 0 ? firstExistingIndex : parts.length, 0, ...normalized);
  next.splice(messageIndex, 1, { ...message, status: 'streaming', parts });
  return pruneEmptyAssistantPlaceholders(next, threadId);
}

export function upsertAssistantText(
  messages: readonly SurfaceMessage[],
  threadId: string,
  turnId: string,
  itemId: string,
  text: string,
  phase?: SurfaceMessageTextPart['phase'],
): SurfaceMessage[] {
  const next = [...messages];
  for (let messageIndex = next.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = next[messageIndex];
    if (message?.role !== 'assistant' || message.metadata?.turnId !== turnId) continue;
    const partIndex = message.parts.findIndex((part) => part.type === 'text' && part.itemId === itemId);
    if (partIndex < 0) continue;
    const parts = [...message.parts];
    const existingPart = parts[partIndex] as SurfaceMessageTextPart;
    parts.splice(partIndex, 1, {
      ...existingPart,
      text,
      itemId,
      ...(phase ? { phase } : {}),
    });
    next.splice(messageIndex, 1, { ...message, parts });
    return pruneEmptyAssistantPlaceholders(next, threadId);
  }

  const ensured = ensureAssistantTurnMessage(next, threadId, turnId);
  const messageIndex = findLastIndex(ensured, (message) => (
    message.role === 'assistant'
    && message.kind === undefined
    && message.metadata?.turnId === turnId
  ));
  const message = messageIndex >= 0 ? ensured[messageIndex] : undefined;
  if (!message) return ensured;
  const textPart: SurfaceMessageTextPart = {
    type: 'text',
    text,
    itemId,
    ...(phase ? { phase } : {}),
  };
  ensured.splice(messageIndex, 1, {
    ...message,
    parts: [...message.parts, textPart],
  });
  return pruneEmptyAssistantPlaceholders(ensured, threadId);
}

export function removeAssistantText(
  messages: readonly SurfaceMessage[],
  threadId: string,
  turnId: string,
  itemId: string,
): SurfaceMessage[] {
  const next = messages.map((message) => {
    if (message.role !== 'assistant' || message.metadata?.turnId !== turnId) return message;
    const parts = message.parts.filter((part) => part.type !== 'text' || part.itemId !== itemId);
    return parts.length === message.parts.length ? message : { ...message, parts };
  });
  return pruneEmptyAssistantPlaceholders(next, threadId);
}

export function extractProposedPlanDocument(text: string): { markdown: string; visibleText: string } | null {
  const match = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/iu.exec(text);
  const markdown = match?.[1]?.trim() ?? '';
  if (!match || !markdown) return null;
  return {
    markdown,
    visibleText: `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.trim(),
  };
}

export function upsertAssistantToolPart(
  messages: readonly SurfaceMessage[],
  threadId: string,
  turnId: string,
  toolPart: SurfaceMessageToolPart,
): SurfaceMessage[] {
  let next = [...messages];
  let messageIndex = next.findIndex((message) => (
    message.role === 'assistant'
    && message.metadata?.turnId === turnId
    && message.parts.some((part) => part.type === 'tool' && part.id === toolPart.id)
  ));
  if (messageIndex < 0) {
    next = ensureAssistantTurnMessage(next, threadId, turnId);
    messageIndex = findLastIndex(next, (message) => (
      message.role === 'assistant'
      && message.kind === undefined
      && message.metadata?.turnId === turnId
    ));
  }
  const message = messageIndex >= 0 ? next[messageIndex] : undefined;
  if (!message) return next;
  const parts = [...message.parts];
  const partIndex = parts.findIndex((part) => part.type === 'tool' && part.id === toolPart.id);
  if (partIndex >= 0) {
    const existing = parts[partIndex] as SurfaceMessageToolPart;
    parts.splice(partIndex, 1, {
      ...existing,
      ...toolPart,
      body: toolPart.body ?? existing.body,
      input: toolPart.input ?? existing.input,
      output: toolPart.output ?? existing.output,
      statusText: toolPart.statusText ?? transitionedToolStatusText(existing.statusText, toolPart.status),
      metadata: { ...(existing.metadata ?? {}), ...(toolPart.metadata ?? {}) },
    });
  } else {
    parts.push(toolPart);
  }
  // A late tool result must not reopen a segment closed by compaction or steer.
  next.splice(messageIndex, 1, { ...message, parts });
  return pruneEmptyAssistantPlaceholders(next, threadId);
}

export function upsertAssistantMediaPart(
  messages: readonly SurfaceMessage[],
  threadId: string,
  turnId: string,
  mediaPart: SurfaceMessageMediaPart,
  sourceItemId = mediaPart.itemId,
): SurfaceMessage[] {
  let next = [...messages];
  let messageIndex = next.findIndex((message) => (
    message.role === 'assistant'
    && message.metadata?.turnId === turnId
    && message.parts.some((part) => part.type === 'media' && part.itemId === mediaPart.itemId)
  ));
  if (messageIndex < 0 && mediaPart.itemId) {
    messageIndex = next.findIndex((message) => (
      message.role === 'assistant'
      && message.metadata?.turnId === turnId
      && message.parts.some((part) => part.type === 'tool' && part.id === sourceItemId)
    ));
  }
  if (messageIndex < 0) {
    next = ensureAssistantTurnMessage(next, threadId, turnId);
    messageIndex = findLastIndex(next, (message) => (
      message.role === 'assistant'
      && message.kind === undefined
      && message.metadata?.turnId === turnId
    ));
  }
  const message = messageIndex >= 0 ? next[messageIndex] : undefined;
  if (!message) return next;
  const parts = [...message.parts];
  const partIndex = parts.findIndex((part) => (
    part.type === 'media' && part.itemId === mediaPart.itemId
  ));
  if (partIndex >= 0) parts.splice(partIndex, 1, mediaPart);
  else parts.push(mediaPart);
  next.splice(messageIndex, 1, { ...message, status: 'streaming', parts });
  return pruneEmptyAssistantPlaceholders(next, threadId);
}

export function upsertAssistantQuestionPart(
  messages: readonly SurfaceMessage[],
  threadId: string,
  turnId: string,
  questionPart: SurfaceMessageQuestionPart,
): SurfaceMessage[] {
  let next = [...messages];
  let messageIndex = next.findIndex((message) => (
    message.role === 'assistant'
    && message.metadata?.turnId === turnId
    && message.parts.some((part) => (
      part.type === 'question' && part.request.id === questionPart.request.id
    ))
  ));
  if (messageIndex < 0) {
    next = ensureAssistantTurnMessage(next, threadId, turnId);
    messageIndex = findLastIndex(next, (message) => (
      message.role === 'assistant'
      && message.kind === undefined
      && message.metadata?.turnId === turnId
    ));
  }
  const message = messageIndex >= 0 ? next[messageIndex] : undefined;
  if (!message) return next;
  const parts = [...message.parts];
  const partIndex = parts.findIndex((part) => (
    part.type === 'question' && part.request.id === questionPart.request.id
  ));
  if (partIndex >= 0) parts.splice(partIndex, 1, questionPart);
  else parts.push(questionPart);
  next.splice(messageIndex, 1, { ...message, parts });
  return pruneEmptyAssistantPlaceholders(next, threadId);
}

export function surfaceMediaPartsEqual(
  left: SurfaceMessageMediaPart,
  right: SurfaceMessageMediaPart,
): boolean {
  return left.itemId === right.itemId
    && left.media.url === right.media.url
    && left.media.alt === right.media.alt
    && left.media.mimeType === right.media.mimeType
    && left.media.prompt === right.media.prompt
    && left.media.title === right.media.title;
}

export function updateAssistantToolPart(
  messages: readonly SurfaceMessage[],
  threadId: string,
  turnId: string,
  update: SurfaceMessageToolPartUpdate,
): SurfaceMessage[] {
  const next = [...messages];
  const messageIndex = next.findIndex((message) => (
    message.role === 'assistant'
    && message.metadata?.turnId === turnId
    && message.parts.some((part) => part.type === 'tool' && part.id === update.itemId)
  ));
  if (messageIndex < 0) {
    if (!update.fallbackToolPart) return next;
    const inserted = upsertAssistantToolPart(next, threadId, turnId, update.fallbackToolPart);
    return updateAssistantToolPart(inserted, threadId, turnId, {
      ...update,
      fallbackToolPart: undefined,
    });
  }
  const message = next[messageIndex];
  if (!message) return next;
  const parts = [...message.parts];
  const partIndex = parts.findIndex((part) => part.type === 'tool' && part.id === update.itemId);
  const existing = parts[partIndex] as SurfaceMessageToolPart | undefined;
  if (!existing) return next;
  parts.splice(partIndex, 1, {
    ...existing,
    ...(update.title !== undefined ? { title: update.title } : {}),
    ...(update.status !== undefined ? { status: update.status } : {}),
    ...(update.statusText !== undefined ? { statusText: update.statusText ?? undefined } : {}),
    ...(update.body !== undefined ? { body: update.body } : {}),
    ...(update.bodyDelta !== undefined ? { body: `${existing.body ?? ''}${update.bodyDelta}` } : {}),
    ...(update.bodyAppend !== undefined
      ? { body: [existing.body, update.bodyAppend].filter(Boolean).join('\n') }
      : {}),
    ...(update.input !== undefined ? { input: update.input } : {}),
    ...(update.output !== undefined ? { output: update.output } : {}),
    ...(update.metadata !== undefined
      ? { metadata: { ...(existing.metadata ?? {}), ...update.metadata } }
      : {}),
  });
  next.splice(messageIndex, 1, { ...message, parts });
  return next;
}

export function appendCompactionMarker(
  messages: readonly SurfaceMessage[],
  threadId: string,
  turnId: string,
  status: 'streaming' | 'complete' = 'streaming',
): SurfaceMessage[] {
  if (messages.some((message) => message.kind === 'compaction' && message.metadata?.turnId === turnId)) {
    return messages.map((message) => (
      status === 'complete' && message.kind === 'compaction' && message.metadata?.turnId === turnId
        ? { ...message, status }
        : message
    ));
  }
  const next = [...messages];
  const activeAssistantIndex = findLastIndex(next, (message) => (
    message.role === 'assistant'
    && message.kind === undefined
    && message.metadata?.turnId === turnId
  ));
  const activeAssistant = activeAssistantIndex >= 0 ? next[activeAssistantIndex] : undefined;
  if (activeAssistant?.parts.length === 0) {
    next.splice(activeAssistantIndex, 1);
  } else if (activeAssistant) {
    next.splice(activeAssistantIndex, 1, { ...activeAssistant, status: 'complete' });
  }
  next.push({
    id: `compaction-${turnId}`,
    kind: 'compaction',
    role: 'assistant',
    status,
    turnId,
    parts: [],
    createdAt: new Date().toISOString(),
    metadata: { conversationId: threadId, turnId },
  });
  return pruneEmptyAssistantPlaceholders(next, threadId);
}

export function finalizeTurnToolParts(
  messages: SurfaceMessage[],
  turnId: string,
  turnStatus: v2.TurnStatus,
): SurfaceMessage[] {
  const toolStatus: SurfaceMessageToolPart['status'] = turnStatus === 'completed' ? 'completed' : 'failed';
  return messages.map((message) => {
    if (message.metadata?.turnId !== turnId) return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== 'tool' || part.status !== 'running') return part;
      changed = true;
      return {
        ...part,
        status: toolStatus,
        statusText: transitionedToolStatusText(part.statusText, toolStatus),
      };
    });
    return changed ? { ...message, parts } : message;
  });
}

function transitionedToolStatusText(
  statusText: string | undefined,
  phase: SurfaceMessageToolPart['status'],
): string | undefined {
  if (phase === 'running') return statusText;
  if (!statusText) return statusText;
  try {
    const parsed: unknown = JSON.parse(statusText);
    if (!isRecord(parsed)) return statusText;
    return JSON.stringify({ ...parsed, phase });
  } catch {
    return statusText;
  }
}

export function pruneEmptyAssistantPlaceholders(messages: SurfaceMessage[], threadId: string): SurfaceMessage[] {
  const relevantIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.metadata?.conversationId === threadId);
  const lastIndex = relevantIndexes.at(-1)?.index ?? -1;
  return messages.filter((message, index) => (
    message.metadata?.conversationId !== threadId
    || index === lastIndex
    || message.role !== 'assistant'
    || message.kind !== undefined
    || message.parts.length > 0
  ));
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return index;
  }
  return -1;
}

export function addUnique<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? [...values] : [...values, value];
}

export function formatPlanMarkdown(
  explanation: string | null,
  plan: readonly { step: string; status: string }[],
): string {
  return [
    explanation?.trim() ?? '',
    ...plan.map((entry) => `${entry.status === 'completed' ? '- [x]' : '- [ ]'} ${entry.step}`),
  ].filter(Boolean).join('\n');
}

export function planProgressToolPart(
  turnId: string,
  markdown: string,
  status: SurfaceMessageToolPart['status'],
): SurfaceMessageToolPart {
  return {
    type: 'tool',
    id: `plan-progress-${turnId}`,
    kind: 'generic',
    title: 'plan',
    status,
    body: markdown,
    statusText: JSON.stringify({
      source: 'codex',
      action: 'plan',
      phase: status,
      params: {
        addedLines: markdown.split('\n').filter((line) => line.trim()).length,
        operation: 'write',
        target: 'plan',
      },
    }),
    metadata: { planProgress: true },
  };
}
