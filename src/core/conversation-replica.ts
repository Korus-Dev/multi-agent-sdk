import type {
  CodexConversationEvent,
  CodexConversationSnapshot,
  CodexSurfaceTurn,
  SurfaceMessage,
  SurfaceMessageToolPart,
  SurfaceMessageToolPartUpdate,
} from './surface';

/**
 * A renderer-local projection initialized once from a conversation snapshot and
 * advanced with the much smaller semantic event stream.
 */
export type CodexConversationReplica = {
  readonly conversationId: string;
  apply(event: CodexConversationEvent): CodexConversationSnapshot;
  getSnapshot(): CodexConversationSnapshot;
  replace(snapshot: CodexConversationSnapshot): CodexConversationSnapshot;
};

export function createCodexConversationReplica(
  initialSnapshot: CodexConversationSnapshot,
): CodexConversationReplica {
  const conversationId = initialSnapshot.activeConversationId;
  let current = initialSnapshot;
  let lastSequence: number | null = null;

  return {
    conversationId,
    getSnapshot: () => current,
    apply: (event) => {
      assertConversation(conversationId, event.conversationId, 'Event');
      if (lastSequence !== null && event.seq <= lastSequence) return current;
      current = applyConversationEvent(current, event);
      lastSequence = event.seq;
      return current;
    },
    replace: (snapshot) => {
      assertConversation(conversationId, snapshot.activeConversationId, 'Snapshot');
      current = snapshot;
      lastSequence = null;
      return current;
    },
  };
}

function applyConversationEvent(
  snapshot: CodexConversationSnapshot,
  event: CodexConversationEvent,
): CodexConversationSnapshot {
  switch (event.type) {
    case 'conversation.summaryUpserted':
      return {
        ...snapshot,
        conversations: upsertById(snapshot.conversations, event.payload.summary),
      };
    case 'conversation.summaryRemoved':
      return {
        ...snapshot,
        conversations: snapshot.conversations.filter((summary) => summary.id !== event.conversationId),
      };
    case 'conversation.historyReplaced':
      return {
        ...snapshot,
        ...(event.payload.state ?? {}),
        messages: [...event.payload.messages],
        threadStatus: event.payload.threadStatus,
      };
    case 'conversation.historyPrepended':
      return {
        ...snapshot,
        ...(event.payload.state ?? {}),
        messages: prependUniqueMessages(snapshot.messages, event.payload.messages),
      };
    case 'conversation.historyStateChanged':
      return { ...snapshot, ...event.payload };
    case 'conversation.activityChanged':
      return {
        ...snapshot,
        threadStatus: event.payload.threadStatus,
        busy: event.payload.busy,
        activeTurnId: event.payload.busy ? snapshot.activeTurnId : null,
        error: event.payload.error,
      };
    case 'conversation.settingsChanged':
      return { ...snapshot, ...event.payload };
    case 'conversation.goalChanged':
      return { ...snapshot, goal: event.payload.goal };
    case 'conversation.contextUsageChanged':
      return { ...snapshot, contextUsage: event.payload.contextUsage };
    case 'conversation.executionUsageChanged':
      return {
        ...snapshot,
        turns: snapshot.turns.map(turn => turn.id === event.turnId ? { ...turn, executionUsage: event.payload.usage } : turn),
      };
    case 'conversation.skillsChanged':
      return {
        ...snapshot,
        skills: [...event.payload.skills],
        skillCatalogStatus: event.payload.status,
      };
    case 'conversation.permissionsChanged':
      return {
        ...snapshot,
        permissionProfiles: [...event.payload.permissionProfiles],
        approvalPresets: [...event.payload.approvalPresets],
      };
    case 'conversation.diffUpdated':
      return { ...snapshot, turnGitDiff: event.payload.diff };
    case 'conversation.queueChanged':
      return { ...snapshot, queuedPrompts: [...event.payload.queuedPrompts] };
    case 'turn.started':
      return {
        ...snapshot,
        activeTurnId: event.turnId,
        busy: true,
        error: null,
        turnGitDiff: null,
        turnIds: addUnique(snapshot.turnIds, event.turnId),
        turns: upsertTurn(snapshot.turns, {
          id: event.turnId,
          status: 'inProgress',
          error: null,
          willRetry: false,
          startedAt: event.payload.startedAt,
          completedAt: null,
          durationMs: null,
        }),
        messages: ensureAssistantTurnMessage(
          snapshot.messages,
          event.conversationId,
          event.turnId,
          event.payload.startedAt,
        ),
      };
    case 'turn.completed': {
      const messageStatus = event.payload.status === 'failed' ? 'error' : 'complete';
      const messages = snapshot.messages
        .map((message) => messageTurnId(message) === event.turnId
          ? completeMessage(message, messageStatus)
          : message)
        .filter((message) => !isEmptyAssistantForTurn(message, event.turnId));
      return {
        ...snapshot,
        activeTurnId: snapshot.activeTurnId === event.turnId ? null : snapshot.activeTurnId,
        busy: snapshot.activeTurnId !== event.turnId && snapshot.busy,
        error: snapshot.activeTurnId === event.turnId || !snapshot.busy
          ? event.payload.error?.message ?? null : snapshot.error,
        turnIds: addUnique(snapshot.turnIds, event.turnId),
        turns: upsertTurn(snapshot.turns, { id: event.turnId, ...event.payload }),
        messages,
      };
    }
    case 'turn.error': {
      const terminal = !event.payload.willRetry && snapshot.activeTurnId === event.turnId;
      const previous = snapshot.turns.find((turn) => turn.id === event.turnId);
      return {
        ...snapshot,
        activeTurnId: terminal ? null : snapshot.activeTurnId,
        busy: terminal ? false : snapshot.busy,
        error: event.payload.error.message,
        turnIds: addUnique(snapshot.turnIds, event.turnId),
        turns: upsertTurn(snapshot.turns, {
          ...previous,
          id: event.turnId,
          status: event.payload.willRetry ? 'inProgress' : 'failed',
          error: event.payload.error,
          willRetry: event.payload.willRetry,
          startedAt: previous?.startedAt ?? null,
          completedAt: previous?.completedAt ?? null,
          durationMs: previous?.durationMs ?? null,
        }),
      };
    }
    case 'message.appended':
      return {
        ...snapshot,
        messages: event.payload.message.kind === 'steer'
          ? appendSteerMessage(
            snapshot.messages,
            event.payload.message,
            event.conversationId,
            event.turnId,
            event.occurredAt,
          )
          : upsertMessage(snapshot.messages, event.payload.message),
      };
    case 'message.updated':
      return { ...snapshot, messages: upsertMessage(snapshot.messages, event.payload.message) };
    case 'message.delta':
      return {
        ...snapshot,
        messages: appendMessageDelta(snapshot.messages, event),
      };
    case 'tool.started':
    case 'tool.completed':
      return {
        ...snapshot,
        messages: upsertToolPart(
          snapshot.messages,
          event.payload.messageId,
          event.conversationId,
          event.turnId,
          event.payload.toolPart,
        ),
      };
    case 'tool.updated':
      return {
        ...snapshot,
        messages: updateToolPart(
          snapshot.messages,
          event.payload.messageId,
          event.conversationId,
          event.turnId,
          event.payload.update,
        ),
      };
    case 'plan.delta':
      return applyPlan(snapshot, event.conversationId, event.turnId, event.payload.markdown, 'running');
    case 'plan.updated': {
      const next = applyPlan(
        snapshot,
        event.conversationId,
        event.turnId,
        event.payload.markdown,
        event.payload.status === 'completed' ? 'completed' : 'running',
      );
      return {
        ...next,
        executionPlan: {
          turnId: event.turnId,
          explanation: event.payload.explanation,
          steps: event.payload.steps.map((step) => ({ ...step })),
          markdown: event.payload.markdown,
          updatedAt: event.occurredAt,
        },
      };
    }
    case 'plan.completed':
      return applyPlan(snapshot, event.conversationId, event.turnId, event.payload.markdown, 'completed');
    case 'context.compactionStarted':
      return { ...snapshot, messages: startCompaction(snapshot.messages, event) };
    case 'context.compactionCompleted':
      return { ...snapshot, messages: upsertMessage(snapshot.messages, event.payload.message) };
    case 'approval.requested':
      return { ...snapshot, approvals: upsertById(snapshot.approvals, event.payload.approval) };
    case 'approval.resolved':
      return {
        ...snapshot,
        approvals: snapshot.approvals.filter((approval) => approval.id !== event.payload.approval.id),
      };
    case 'clientRequest.requested':
      return { ...snapshot, clientRequests: upsertById(snapshot.clientRequests, event.payload.request) };
    case 'clientRequest.resolved':
      return resolveClientRequest(snapshot, event);
    case 'file.activity':
    case 'turn.modelRerouted':
    case 'subagent.toolCallChanged':
    case 'subagent.activity':
    case 'realtime.started':
    case 'realtime.itemAdded':
    case 'realtime.itemStarted':
    case 'realtime.itemCompleted':
    case 'realtime.itemTranscriptDelta':
    case 'realtime.transcriptDelta':
    case 'realtime.transcriptCompleted':
    case 'realtime.audioDelta':
    case 'realtime.sdp':
    case 'realtime.error':
    case 'realtime.closed':
      return snapshot;
  }
}

function assertConversation(expected: string, actual: string, subject: string): void {
  if (actual !== expected) {
    throw new Error(`${subject} belongs to '${actual}', not replica conversation '${expected}'`);
  }
}

function upsertById<Value extends { id: string }>(values: readonly Value[], value: Value): Value[] {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  if (index < 0) return [...values, value];
  const next = [...values];
  next.splice(index, 1, value);
  return next;
}

function addUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function upsertTurn(turns: readonly CodexSurfaceTurn[], turn: CodexSurfaceTurn): CodexSurfaceTurn[] {
  return upsertById(turns, turn);
}

function upsertMessage(messages: readonly SurfaceMessage[], message: SurfaceMessage): SurfaceMessage[] {
  return upsertById(messages, message);
}

function ensureAssistantTurnMessage(
  messages: readonly SurfaceMessage[],
  conversationId: string,
  turnId: string,
  createdAt: string,
): SurfaceMessage[] {
  if (messages.some((message) => (
    message.role === 'assistant'
    && message.kind === undefined
    && message.status === 'streaming'
    && messageTurnId(message) === turnId
  ))) return [...messages];
  const segmentCount = messages.filter((message) => (
    message.role === 'assistant' && message.kind === undefined && messageTurnId(message) === turnId
  )).length;
  return [...messages, {
    id: segmentCount === 0 ? `assistant-${turnId}` : `assistant-${turnId}-segment-${segmentCount}`,
    role: 'assistant',
    status: 'streaming',
    turnId,
    parts: [],
    createdAt,
    metadata: { conversationId, turnId },
  }];
}

function appendSteerMessage(
  messages: readonly SurfaceMessage[],
  steer: SurfaceMessage,
  conversationId: string,
  eventTurnId: string | undefined,
  occurredAt: string,
): SurfaceMessage[] {
  const turnId = eventTurnId ?? messageTurnId(steer);
  const appended = upsertMessage(messages, steer);
  if (!turnId) return appended;
  const previousIndex = findLastIndex(appended, (message) => (
    message.role === 'assistant' && message.kind === undefined && messageTurnId(message) === turnId
  ));
  const next = [...appended];
  const previous = previousIndex >= 0 ? next[previousIndex] : undefined;
  if (previous?.parts.length === 0) next.splice(previousIndex, 1);
  else if (previous) next.splice(previousIndex, 1, { ...previous, status: 'complete' });
  return ensureAssistantTurnMessage(
    next,
    conversationId,
    turnId,
    steer.createdAt ?? occurredAt,
  );
}

function prependUniqueMessages(
  current: readonly SurfaceMessage[],
  prepended: readonly SurfaceMessage[],
): SurfaceMessage[] {
  const incomingIds = new Set(prepended.map((message) => message.id));
  return [...prepended, ...current.filter((message) => !incomingIds.has(message.id))];
}

function appendMessageDelta(
  messages: readonly SurfaceMessage[],
  event: Extract<CodexConversationEvent, { type: 'message.delta' }>,
): SurfaceMessage[] {
  const index = messages.findIndex((message) => message.id === event.payload.messageId);
  const message = index >= 0 ? messages[index]! : {
    id: event.payload.messageId,
    role: 'assistant' as const,
    status: 'streaming' as const,
    turnId: event.turnId,
    parts: [],
    createdAt: event.occurredAt,
    metadata: { conversationId: event.conversationId, turnId: event.turnId },
  };
  const parts = [...message.parts];
  const lastPart = parts.at(-1);
  if (lastPart?.type === 'text' && lastPart.itemId === event.payload.itemId) {
    parts.splice(parts.length - 1, 1, {
      ...lastPart,
      text: `${lastPart.text}${event.payload.delta}`,
      ...(event.payload.phase ? { phase: event.payload.phase } : {}),
    });
  } else if (event.payload.delta) {
    parts.push({
      type: 'text', text: event.payload.delta, itemId: event.payload.itemId,
      ...(event.payload.phase ? { phase: event.payload.phase } : {}),
    });
  }
  const nextMessage: SurfaceMessage = { ...message, status: 'streaming', parts };
  if (index < 0) return [...messages, nextMessage];
  const next = [...messages];
  next.splice(index, 1, nextMessage);
  return next;
}

function completeMessage(
  message: SurfaceMessage,
  status: SurfaceMessage['status'],
): SurfaceMessage {
  let changed = message.status !== status;
  const toolStatus: SurfaceMessageToolPart['status'] = status === 'complete' ? 'completed' : 'failed';
  const parts = message.parts.map((part) => {
    if (part.type !== 'tool' || part.status !== 'running') return part;
    changed = true;
    return {
      ...part,
      status: toolStatus,
      statusText: transitionedToolStatusText(part.statusText, toolStatus),
    };
  });
  return changed ? { ...message, status, parts } : message;
}

function isEmptyAssistantForTurn(message: SurfaceMessage, turnId: string): boolean {
  return message.role === 'assistant'
    && message.kind === undefined
    && messageTurnId(message) === turnId
    && message.parts.length === 0;
}

function messageTurnId(message: SurfaceMessage): string | null {
  return message.turnId
    ?? (typeof message.metadata?.turnId === 'string' ? message.metadata.turnId : null);
}

function findLastIndex<Value>(
  values: readonly Value[],
  predicate: (value: Value) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return index;
  }
  return -1;
}

function upsertToolPart(
  messages: readonly SurfaceMessage[],
  messageId: string,
  conversationId: string,
  turnId: string,
  toolPart: SurfaceMessageToolPart,
): SurfaceMessage[] {
  const index = messages.findIndex((message) => message.id === messageId);
  const message = index >= 0 ? messages[index]! : assistantMessage(messageId, conversationId, turnId);
  const parts = [...message.parts];
  const partIndex = parts.findIndex((part) => part.type === 'tool' && part.id === toolPart.id);
  if (partIndex < 0) parts.push(toolPart);
  else {
    const existing = parts[partIndex] as SurfaceMessageToolPart;
    parts.splice(partIndex, 1, mergeToolPart(existing, toolPart));
  }
  const nextMessage = { ...message, status: 'streaming' as const, parts };
  if (index < 0) return [...messages, nextMessage];
  const next = [...messages];
  next.splice(index, 1, nextMessage);
  return next;
}

function updateToolPart(
  messages: readonly SurfaceMessage[],
  messageId: string,
  conversationId: string,
  turnId: string,
  update: SurfaceMessageToolPartUpdate,
): SurfaceMessage[] {
  let next = [...messages];
  let messageIndex = next.findIndex((message) => message.id === messageId);
  if (messageIndex < 0 && update.fallbackToolPart) {
    next = upsertToolPart(next, messageId, conversationId, turnId, update.fallbackToolPart);
    messageIndex = next.findIndex((message) => message.id === messageId);
  }
  const message = messageIndex >= 0 ? next[messageIndex] : undefined;
  if (!message) return next;
  const parts = [...message.parts];
  const partIndex = parts.findIndex((part) => part.type === 'tool' && part.id === update.itemId);
  if (partIndex < 0) return next;
  const existing = parts[partIndex] as SurfaceMessageToolPart;
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

function mergeToolPart(
  existing: SurfaceMessageToolPart,
  incoming: SurfaceMessageToolPart,
): SurfaceMessageToolPart {
  return {
    ...existing,
    ...incoming,
    body: incoming.body ?? existing.body,
    input: incoming.input ?? existing.input,
    output: incoming.output ?? existing.output,
    statusText: incoming.statusText ?? transitionedToolStatusText(existing.statusText, incoming.status),
    metadata: { ...(existing.metadata ?? {}), ...(incoming.metadata ?? {}) },
  };
}

function assistantMessage(messageId: string, conversationId: string, turnId: string): SurfaceMessage {
  return {
    id: messageId,
    role: 'assistant',
    status: 'streaming',
    turnId,
    parts: [],
    metadata: { ...(conversationId ? { conversationId } : {}), turnId },
  };
}

function applyPlan(
  snapshot: CodexConversationSnapshot,
  conversationId: string,
  turnId: string,
  markdown: string,
  status: SurfaceMessageToolPart['status'],
): CodexConversationSnapshot {
  const message = [...snapshot.messages].reverse().find((candidate) => (
    candidate.role === 'assistant' && messageTurnId(candidate) === turnId
  ));
  const messageId = message?.id ?? `assistant-${turnId}`;
  return {
    ...snapshot,
    messages: upsertToolPart(snapshot.messages, messageId, conversationId, turnId, {
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
    }),
  };
}

function startCompaction(
  messages: readonly SurfaceMessage[],
  event: Extract<CodexConversationEvent, { type: 'context.compactionStarted' }>,
): SurfaceMessage[] {
  if (messages.some((message) => message.kind === 'compaction' && messageTurnId(message) === event.turnId)) {
    return [...messages];
  }
  const next = [...messages];
  const activeAssistantIndex = findLastIndex(next, (message) => (
    message.role === 'assistant'
    && message.kind === undefined
    && messageTurnId(message) === event.turnId
  ));
  const activeAssistant = activeAssistantIndex >= 0 ? next[activeAssistantIndex] : undefined;
  if (activeAssistant?.parts.length === 0) next.splice(activeAssistantIndex, 1);
  else if (activeAssistant) next.splice(activeAssistantIndex, 1, { ...activeAssistant, status: 'complete' });
  return [...next, {
    id: `compaction-${event.turnId}`,
    kind: 'compaction',
    role: 'assistant',
    status: 'streaming',
    turnId: event.turnId,
    parts: [],
    createdAt: event.occurredAt,
    metadata: { conversationId: event.conversationId, turnId: event.turnId },
  }];
}

function transitionedToolStatusText(
  statusText: string | undefined,
  status: SurfaceMessageToolPart['status'],
): string | undefined {
  if (status === 'running' || !statusText) return statusText;
  try {
    const parsed: unknown = JSON.parse(statusText);
    if (!isRecord(parsed)) return statusText;
    return JSON.stringify({ ...parsed, phase: status });
  } catch {
    return statusText;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolveClientRequest(
  snapshot: CodexConversationSnapshot,
  event: Extract<CodexConversationEvent, { type: 'clientRequest.resolved' }>,
): CodexConversationSnapshot {
  const response = event.payload.response;
  const output = event.payload.request.kind === 'ask_user'
    ? { answers: response?.payload?.answers ?? {} }
    : { decision: response?.payload?.decision ?? null };
  const request = event.payload.request;
  const turnId = event.turnId ?? request.turnId ?? '';
  const message = snapshot.messages.find((candidate) => (
    messageTurnId(candidate) === turnId
    && candidate.parts.some((part) => part.type === 'tool' && part.id === request.itemId)
  ));
  return {
    ...snapshot,
    answeredClientRequestIds: addUnique(snapshot.answeredClientRequestIds, request.id),
    clientRequests: snapshot.clientRequests.filter((candidate) => candidate.id !== request.id),
    messages: message
      ? updateToolPart(
        snapshot.messages,
        message.id,
        event.conversationId,
        turnId,
        { itemId: request.itemId, output },
      )
      : snapshot.messages,
  };
}
