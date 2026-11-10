import type { v2 } from '@korus-dev/codex-sdk';
import { normalizePromptContent, promptContentText } from '../../core/surface';
import { basename, extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileAttachmentReference } from './codex-file-attachment';
import type {
  CodexSurfaceClientRequest,
  SurfaceMessage,
  SurfaceMessageAttachment,
  SurfaceMessageMediaPart,
  SurfaceMessagePart,
  SurfaceMessageQuestionPart,
} from '../../core/surface';
import { codexThreadItemToToolPart } from './codex-tool-part-adapter';
import {
  extractProposedPlanDocument,
  finalizeTurnToolParts,
} from './codex-surface-message-state';

export { codexThreadItemToToolPart as codexItemToToolPart } from './codex-tool-part-adapter';

const MAX_INLINE_GENERATED_IMAGE_BYTES = 16 * 1024 * 1024;
const supportedGeneratedImageMimeTypes = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function codexThreadToSurfaceMessages(thread: v2.Thread): SurfaceMessage[] {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  return turns.flatMap((turn) => codexTurnToSurfaceMessages(thread.id, turn));
}

/**
 * Keep bounded data previews from optimistic messages when app-server history
 * rematerializes the same user attachment from its local filesystem path.
 * Bounded data previews are used as image sources; no local paths exposed.
 */
export function preserveHistoricalAttachmentPreviews(
  previousMessages: readonly SurfaceMessage[],
  historyMessages: readonly SurfaceMessage[],
): SurfaceMessage[] {
  const previewsByPath = new Map<string, string>();
  for (const message of previousMessages) {
    for (const part of message.parts) {
      if (part.type !== 'attachment' || part.attachment.kind !== 'image' || !part.attachment.path) continue;
      if (isSafeImagePreview(part.attachment.url)) {
        previewsByPath.set(part.attachment.path, part.attachment.url);
      }
    }
  }
  if (previewsByPath.size === 0) return [...historyMessages];

  return historyMessages.map((message) => {
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== 'attachment' || part.attachment.kind !== 'image' || !part.attachment.path) {
        return part;
      }
      const previewUrl = previewsByPath.get(part.attachment.path);
      if (!previewUrl || part.attachment.url === previewUrl) return part;
      changed = true;
      return { ...part, attachment: { ...part.attachment, url: previewUrl } };
    });
    return changed ? { ...message, parts } : message;
  });
}

/** Preserve authored presentation by provider-echoed client identity, never text matching. */
export function preserveHistoricalMessagePresentation(previous: readonly SurfaceMessage[], history: readonly SurfaceMessage[]): SurfaceMessage[] {
  const authored = new Map(previous.filter(message => message.role === 'user' && message.metadata?.promptContent)
    .map(message => [message.id, message.metadata!.promptContent]));
  return preserveHistoricalAttachmentPreviews(previous, history).map(message => {
    const saved = authored.get(message.id);
    if (!saved || message.role !== 'user') return message;
    const content = normalizePromptContent(saved);
    return {
      ...message, metadata: { ...message.metadata, promptContent: content },
      parts: [{ type: 'text', text: promptContentText(content) }, ...message.parts.filter(part => part.type !== 'text')],
    };
  });
}

export function codexTurnToSurfaceMessages(threadId: string, turn: v2.Turn): SurfaceMessage[] {
  const messages: SurfaceMessage[] = [];
  const assistantParts: SurfaceMessagePart[] = [];
  const createdAt = timestampToIso(turn.startedAt ?? turn.completedAt);
  let assistantSegmentIndex = 0;
  let sawAssistantActivity = false;
  let sawFinalAnswer = false;
  const initialUserMessageKeys = new Set<string>();

  const flushAssistantMessage = () => {
    if (assistantParts.length === 0) {
      return;
    }

    const segmentSuffix = assistantSegmentIndex === 0 ? '' : `-segment-${assistantSegmentIndex}`;
    messages.push({
      id: `assistant-${turn.id}${segmentSuffix}`,
      role: 'assistant',
      status: surfaceMessageStatus(turn.status),
      turnId: turn.id,
      parts: [...assistantParts],
      createdAt,
      metadata: { conversationId: threadId, turnId: turn.id },
    });
    assistantParts.length = 0;
    assistantSegmentIndex += 1;
  };

  for (const item of Array.isArray(turn.items) ? turn.items : []) {
    if (item.type === 'userMessage') {
      const parts = userMessageParts(item);
      const asyncQuestionRequestIds = asyncQuestionRequestIdsForUserMessage(item);
      if (parts.length > 0) {
        const isSteerMessage = sawAssistantActivity;
        const initialMessageKey = isSteerMessage ? null : JSON.stringify(parts);
        if (initialMessageKey && initialUserMessageKeys.has(initialMessageKey)) continue;
        if (initialMessageKey) initialUserMessageKeys.add(initialMessageKey);
        flushAssistantMessage();
        messages.push({
          id: item.clientId ?? `user-${threadId}-${turn.id}-${item.id ?? messages.length}`,
          ...(isSteerMessage ? { kind: 'steer' as const } : {}),
          role: 'user',
          status: 'complete',
          turnId: turn.id,
          parts,
          createdAt,
          metadata: {
            conversationId: threadId,
            turnId: turn.id,
            ...(asyncQuestionRequestIds.length > 0 ? {
              asyncQuestionRequestIds,
              asyncQuestionAnswers: asyncQuestionAnswersForUserMessage(item),
            } : {}),
          },
        });
      }
      continue;
    }

    if (item.type === 'contextCompaction') {
      sawAssistantActivity = true;
      flushAssistantMessage();
      const markerId = `compaction-${turn.id}`;
      if (!messages.some((message) => message.id === markerId)) {
        messages.push({
          id: markerId,
          kind: 'compaction',
          role: 'assistant',
          status: 'complete',
          turnId: turn.id,
          parts: [],
          createdAt,
          metadata: { conversationId: threadId, turnId: turn.id },
        });
      }
      continue;
    }

    if (item.type === 'agentMessage') {
      const text = typeof item.text === 'string' ? item.text : '';
      if (item.phase === 'final_answer' && text.trim()) sawFinalAnswer = true;
      const questionPart = codexItemToQuestionPart(threadId, turn.id, item, true);
      const proposedPlan = item.phase === 'final_answer'
        ? extractProposedPlanDocument(text)
        : null;
      if (proposedPlan && !questionPart) {
        if (proposedPlan.visibleText) {
          sawAssistantActivity = true;
          assistantParts.push({
            type: 'text',
            text: proposedPlan.visibleText,
            itemId: item.id,
            ...(item.phase ? { phase: item.phase } : {}),
          });
        }
      } else if (text && !questionPart) {
        sawAssistantActivity = true;
        assistantParts.push({
          type: 'text',
          text,
          itemId: item.id,
          ...(item.phase ? { phase: item.phase } : {}),
        });
      }
      if (questionPart) {
        sawAssistantActivity = true;
        assistantParts.push(questionPart);
      }
      continue;
    }

    if (item.type === 'reasoning') {
      const summaries = item.summary
        .map((summary, summaryIndex) => ({ summary: summary.trim(), summaryIndex }))
        .filter(({ summary }) => summary.length > 0);
      if (summaries.length === 0 && sawFinalAnswer) summaries.push({ summary: '', summaryIndex: 0 });
      if (summaries.length > 0) {
        sawAssistantActivity = true;
        assistantParts.push(...summaries.map(({ summary, summaryIndex }) => ({
          type: 'reasoning' as const,
          summary,
          itemId: item.id,
          summaryIndex,
        })));
      }
      continue;
    }

    if (item.type === 'exitedReviewMode') {
      const text = typeof item.review === 'string' ? item.review : '';
      if (text) {
        sawAssistantActivity = true;
        assistantParts.push({ type: 'text', text, itemId: item.id });
      }
      continue;
    }

    const toolPart = codexThreadItemToToolPart(item);
    if (toolPart) {
      sawAssistantActivity = true;
      assistantParts.push(toolPart);
    }
    const mediaParts = codexItemToMediaParts(item);
    if (mediaParts.length) {
      sawAssistantActivity = true;
      assistantParts.push(...mediaParts);
    }
  }

  flushAssistantMessage();
  if ((turn.itemsView === 'summary' || turn.itemsView === 'notLoaded') && !messages.some(m => m.role === 'assistant')) {
    messages.push({ id: `assistant-${turn.id}`, role: 'assistant', status: surfaceMessageStatus(turn.status), turnId: turn.id, parts: [], createdAt, metadata: { conversationId: threadId, turnId: turn.id } });
  }
  return turn.status === 'inProgress'
    ? messages
    : finalizeTurnToolParts(messages, turn.id, turn.status);
}

export function codexItemToSurfaceMessage(
  threadId: string,
  turn: Pick<v2.Turn, 'id' | 'status' | 'startedAt'>,
  item: v2.ThreadItem,
): SurfaceMessage | null {
  const createdAt = timestampToIso(turn.startedAt);
  if (item.type === 'userMessage') {
    const parts = userMessageParts(item);
    const asyncQuestionRequestIds = asyncQuestionRequestIdsForUserMessage(item);
    return parts.length > 0 ? {
      id: item.clientId ?? `user-${threadId}-${turn.id}-${item.id}`,
      role: 'user',
      status: 'complete',
      turnId: turn.id,
      parts,
      createdAt,
      metadata: {
        conversationId: threadId,
        turnId: turn.id,
        itemId: item.id,
        ...(asyncQuestionRequestIds.length > 0 ? {
          asyncQuestionRequestIds,
          asyncQuestionAnswers: asyncQuestionAnswersForUserMessage(item),
        } : {}),
      },
    } : null;
  }

  if (item.type === 'agentMessage' || item.type === 'exitedReviewMode') {
    const text = item.type === 'agentMessage' ? item.text : item.review;
    const proposedPlan = item.type === 'agentMessage' && item.phase === 'final_answer'
      ? extractProposedPlanDocument(text)
      : null;
    const questionPart = item.type === 'agentMessage'
      ? codexItemToQuestionPart(threadId, turn.id, item, true)
      : null;
    const parts: SurfaceMessagePart[] = [
      ...(!questionPart && (proposedPlan?.visibleText || (!proposedPlan && text)) ? [{
        type: 'text' as const,
        text: proposedPlan?.visibleText ?? text,
        itemId: item.id,
        ...(item.type === 'agentMessage' && item.phase ? { phase: item.phase } : {}),
      }] : []),
      ...(questionPart ? [questionPart] : []),
    ];
    return parts.length > 0 ? {
      id: `assistant-${item.id}`,
      role: 'assistant',
      status: surfaceMessageStatus(turn.status),
      turnId: turn.id,
      parts,
      createdAt,
      metadata: { conversationId: threadId, turnId: turn.id, itemId: item.id },
    } : null;
  }

  if (item.type === 'reasoning') {
    const parts = item.summary
      .map((summary, summaryIndex) => ({ summary: summary.trim(), summaryIndex }))
      .filter(({ summary }) => summary.length > 0)
      .map(({ summary, summaryIndex }) => ({
        type: 'reasoning' as const,
        summary,
        itemId: item.id,
        summaryIndex,
      }));
    return parts.length > 0 ? {
      id: `assistant-${item.id}`,
      role: 'assistant',
      status: surfaceMessageStatus(turn.status),
      turnId: turn.id,
      parts,
      createdAt,
      metadata: { conversationId: threadId, turnId: turn.id, itemId: item.id },
    } : null;
  }

  const parts: SurfaceMessagePart[] = [];
  const toolPart = codexThreadItemToToolPart(item);
  if (toolPart) parts.push(toolPart);
  parts.push(...codexItemToMediaParts(item));
  const message: SurfaceMessage | null = parts.length > 0 ? {
    id: `assistant-${item.id}`,
    role: 'assistant',
    status: surfaceMessageStatus(turn.status),
    turnId: turn.id,
    parts,
    createdAt,
    metadata: { conversationId: threadId, turnId: turn.id, itemId: item.id },
  } : null;
  if (!message || turn.status === 'inProgress') return message;
  return finalizeTurnToolParts([message], turn.id, turn.status)[0] ?? null;
}

export function codexItemToQuestionPart(
  threadId: string,
  turnId: string,
  item: Extract<v2.ThreadItem, { type: 'agentMessage' }>,
  historical = false,
): SurfaceMessageQuestionPart | null {
  if (item.delivery !== 'async') return null;
  const structuredQuestions = item.questions ?? [];
  const questions = structuredQuestions.length > 0
    ? structuredQuestions.map((question, index) => ({
        id: JSON.stringify(['request_user_input_async', item.id, index]),
        header: question.title,
        question: question.title,
        isOther: true,
        isSecret: false,
        options: question.options?.map((label) => ({ label, description: '' })) ?? null,
      }))
    : item.text.trim()
      ? [{
          id: item.id,
          header: 'Question',
          question: item.text,
          isOther: true,
          isSecret: false,
          options: null,
        }]
      : [];
  if (questions.length === 0) return null;
  const request: Extract<CodexSurfaceClientRequest, { kind: 'ask_user' }> = {
    id: `async-question:${item.id}`,
    kind: 'ask_user',
    conversationId: threadId,
    turnId,
    itemId: item.id,
    payload: {
      request: {
        itemId: item.id,
        delivery: 'async',
        blocking: false,
        questions,
      },
    },
  };
  return { type: 'question', request, ...(historical ? { historical: true } : {}) };
}

export function codexItemToMediaPart(item: v2.ThreadItem): SurfaceMessageMediaPart | null {
  if (item.type !== 'imageGeneration') return null;
  const toolPart = codexThreadItemToToolPart(item);
  if (toolPart?.status !== 'completed') return null;

  const candidatePath = typeof item.savedPath === 'string' && isAbsolute(item.savedPath)
    ? item.savedPath
    : null;
  const savedPathMimeType = candidatePath ? mimeTypeForSource(candidatePath) : undefined;
  const savedPath = savedPathMimeType && supportedGeneratedImageMimeTypes.has(savedPathMimeType)
    ? candidatePath
    : null;
  const result = 'result' in item && typeof item.result === 'string' ? item.result.trim() : '';
  const inlineImage = codexImageDataUrl(result);
  const url = inlineImage?.url ?? (savedPath ? pathToFileURL(savedPath).href : undefined);
  if (!url) return null;

  const prompt = typeof item.revisedPrompt === 'string' ? item.revisedPrompt.trim() : '';
  return {
    type: 'media',
    itemId: item.id,
    media: {
      url,
      alt: 'Generated image',
      title: 'Generated image',
      mimeType: inlineImage?.mimeType ?? savedPathMimeType ?? 'image/png',
      ...(prompt ? { prompt } : {}),
    },
  };
}

/** Tool result images are media, independently of the small text/JSON tool-output budget. */
export function codexItemToMediaParts(item: v2.ThreadItem): SurfaceMessageMediaPart[] {
  if (item.type === 'imageView') {
    if (typeof item.path !== 'string') return [];
    const mimeType = mimeTypeForSource(item.path);
    return isAbsolute(item.path) && mimeType && supportedGeneratedImageMimeTypes.has(mimeType)
      ? [{ type: 'media', phase: 'commentary', itemId: item.id, media: { url: pathToFileURL(item.path).href, mimeType, alt: 'Viewed image', title: 'Viewed image' } }]
      : [];
  }
  const generated = codexItemToMediaPart(item);
  if (generated) return [generated];
  const content = item.type === 'mcpToolCall' && item.status === 'completed' ? item.result?.content
    : item.type === 'dynamicToolCall' && item.status === 'completed' ? item.contentItems : undefined;
  if (!Array.isArray(content)) return [];
  const parts: SurfaceMessageMediaPart[] = [];
  let remaining = 20 * 1024 * 1024;
  let parseBudget = 32 * 1024 * 1024;
  let entries = 256;
  // Only unwrap the provider's content/text JSON envelopes, never arbitrary
  // result properties. Cumulative limits bound both parsing work and images.
  const visit = (blocks: unknown[], depth: number): void => {
    for (const entry of blocks) {
      if (--entries < 0 || parts.length >= 8) return;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const value = entry as Record<string, unknown>;
      if (value.type === 'text' || value.type === 'inputText') {
        if (depth >= 4 || typeof value.text !== 'string') continue;
        const byteLength = Buffer.byteLength(value.text);
        if (byteLength > parseBudget) continue;
        parseBudget -= byteLength;
        try {
          const envelope: unknown = JSON.parse(value.text);
          if (isRecord(envelope) && Array.isArray(envelope.content)) visit(envelope.content, depth + 1);
        } catch { /* Ordinary text and malformed envelopes are not media. */ }
        continue;
      }
      const source = value.type === 'image' && typeof value.data === 'string' ? value.data
        : value.type === 'inputImage' && typeof value.imageUrl === 'string' ? value.imageUrl : '';
      if (source.length > remaining) continue;
      const image = codexImageDataUrl(source);
      if (!image) continue;
      remaining -= image.url.length;
      parts.push({ type: 'media', phase: 'commentary', itemId: parts.length ? `${item.id}:image:${parts.length}` : item.id,
        media: { url: image.url, mimeType: image.mimeType, alt: 'Tool image', title: 'Tool image' } });
    }
  };
  visit(content, 0);
  return parts;
}

function userMessageParts(item: Extract<v2.ThreadItem, { type: 'userMessage' }>): SurfaceMessagePart[] {
  const content = Array.isArray(item.content) ? item.content : [];
  const hasTextInput = content.some((input) => (
    isRecord(input) && input.type === 'text' && typeof input.text === 'string' && input.text.length > 0
  ));
  const parts: SurfaceMessagePart[] = [];
  let text: string[] = [];
  const renderedSkills = new Set<string>();
  const flushText = () => {
    if (text.length > 0) parts.push({ type: 'text', text: text.join('\n') });
    text = [];
  };

  for (const input of content) {
    if (isRecord(input) && input.type === 'skill' && typeof input.name === 'string') {
      // app-server persists selected skills alongside the original prompt text.
      // The text is the canonical user-authored display value; rendering the
      // structured execution metadata too repeats the skill mention.
      if (hasTextInput) continue;
      const normalizedName = input.name.toLowerCase();
      if (renderedSkills.has(normalizedName)) continue;
      renderedSkills.add(normalizedName);
    }
    const inputText = userInputText(input);
    const file = fileAttachmentReference(inputText);
    if (file) {
      flushText();
      parts.push({ type: 'attachment', attachment: { kind: 'file', ...file } });
      continue;
    }
    if (inputText) {
      text.push(inputText);
      continue;
    }
    const attachment = userInputAttachment(input);
    if (!attachment) continue;
    flushText();
    parts.push({ type: 'attachment', attachment });
  }
  flushText();
  return parts;
}

function userInputText(input: unknown): string {
  if (!isRecord(input) || typeof input.type !== 'string') {
    return '';
  }
  if (input.type === 'text' && typeof input.text === 'string') {
    return asyncQuestionReply(input.text)?.displayText ?? input.text;
  }
  if (input.type === 'skill' && typeof input.name === 'string') return `$${input.name}`;
  return '';
}

function asyncQuestionRequestIdsForUserMessage(
  item: Extract<v2.ThreadItem, { type: 'userMessage' }>,
): string[] {
  const ids = new Set<string>();
  for (const input of Array.isArray(item.content) ? item.content : []) {
    if (!isRecord(input) || input.type !== 'text' || typeof input.text !== 'string') continue;
    for (const requestId of asyncQuestionReply(input.text)?.requestIds ?? []) ids.add(requestId);
  }
  return [...ids];
}

function asyncQuestionAnswersForUserMessage(item: Extract<v2.ThreadItem, { type: 'userMessage' }>): Record<string, { answers: string[] }> {
  const answers: Record<string, { answers: string[] }> = {};
  for (const input of Array.isArray(item.content) ? item.content : []) {
    if (!isRecord(input) || input.type !== 'text' || typeof input.text !== 'string') continue;
    Object.assign(answers, asyncQuestionReply(input.text)?.answers);
  }
  return answers;
}

function asyncQuestionReply(text: string): { displayText: string; requestIds: string[]; answers: Record<string, { answers: string[] }> } | null {
  const match = text.match(
    /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/,
  );
  if (!match?.[1]) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (!Array.isArray(value)) return null;
    const replies = value.filter((entry): entry is {
      questionItemId: string;
      question: string;
      answer: string;
    } => (
      isRecord(entry)
      && typeof entry.questionItemId === 'string'
      && typeof entry.question === 'string'
      && typeof entry.answer === 'string'
    ));
    if (replies.length === 0) return null;
    const requestIds = replies.flatMap((reply) => {
      try {
        const questionId: unknown = JSON.parse(reply.questionItemId);
        if (
          Array.isArray(questionId)
          && questionId[0] === 'request_user_input_async'
          && typeof questionId[1] === 'string'
        ) return [`async-question:${questionId[1]}`];
      } catch {
        // Open-ended asynchronous questions use their item id directly.
      }
      return [`async-question:${reply.questionItemId}`];
    });
    return {
      displayText: replies.length === 1
        ? replies[0]!.answer
        : replies.map((reply) => `${reply.question}: ${reply.answer}`).join('\n'),
      requestIds,
      answers: Object.fromEntries(replies.map((reply) => [reply.questionItemId, { answers: [reply.answer] }])),
    };
  } catch {
    return null;
  }
}

function userInputAttachment(input: unknown): SurfaceMessageAttachment | null {
  if (!isRecord(input) || typeof input.type !== 'string') return null;
  if (input.type === 'mention' && typeof input.path === 'string' && !input.path.startsWith('plugin://')) {
    const name = typeof input.name === 'string' && input.name.trim()
      ? input.name.trim()
      : attachmentName(input.path, 'File');
    const mimeType = mimeTypeForSource(input.path);
    return {
      kind: 'file',
      name,
      path: input.path,
      ...(mimeType ? { mimeType } : {}),
    };
  }
  if (input.type === 'image' && typeof input.url === 'string') {
    const mimeType = mimeTypeForSource(input.url);
    return {
      kind: 'image',
      name: attachmentName(input.url, 'Image'),
      url: input.url,
      ...(mimeType ? { mimeType } : {}),
    };
  }
  if (input.type === 'localImage' && typeof input.path === 'string') {
    const mimeType = mimeTypeForSource(input.path);
    return {
      kind: 'image',
      name: attachmentName(input.path, 'Image'),
      path: input.path,
      ...(mimeType ? { mimeType } : {}),
    };
  }
  return null;
}

function attachmentName(source: string, fallback: string): string {
  try {
    const path = /^[a-z][a-z\d+.-]*:/i.test(source) ? new URL(source).pathname : source;
    const name = basename(decodeURIComponent(path)).trim();
    return name || fallback;
  } catch {
    return basename(source).trim() || fallback;
  }
}

function mimeTypeForSource(source: string): string | undefined {
  const dataMimeType = /^data:([^;,]+)/i.exec(source)?.[1]?.toLowerCase();
  if (dataMimeType) return dataMimeType;
  let extension = '';
  try {
    const path = /^[a-z][a-z\d+.-]*:/i.test(source) ? new URL(source).pathname : source;
    extension = extname(path).slice(1).toLowerCase();
  } catch {
    extension = extname(source).slice(1).toLowerCase();
  }
  return ({
    avif: 'image/avif',
    gif: 'image/gif',
    heic: 'image/heic',
    heif: 'image/heif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    pdf: 'application/pdf',
    png: 'image/png',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  } as Record<string, string>)[extension];
}

export function codexImageDataUrl(result: string): { url: string; mimeType: string } | null {
  if (!result) return null;
  const dataUrlMatch = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(result);
  const compact = (dataUrlMatch?.[1] ?? result).replace(/\s+/g, '');
  const maxEncodedLength = Math.ceil(MAX_INLINE_GENERATED_IMAGE_BYTES / 3) * 4 + 4;
  if (
    !compact
    || compact.length > maxEncodedLength
    || compact.length % 4 !== 0
    || !/^[a-z0-9+/]+={0,2}$/i.test(compact)
  ) {
    return null;
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_GENERATED_IMAGE_BYTES) return null;
  const mimeType = generatedImageMimeType(bytes);
  if (!mimeType) return null;
  return { url: `data:${mimeType};base64,${compact}`, mimeType };
}

function isSafeImagePreview(value: string | undefined): value is string {
  return Boolean(
    value
    && value.length <= 16 * 1024 * 1024
    && /^data:image\/(?:avif|bmp|gif|heic|heif|jpe?g|png|webp);base64,[a-z\d+/]+={0,2}$/i.test(value),
  );
}

function generatedImageMimeType(bytes: Uint8Array): string | null {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  const header = Buffer.from(bytes.subarray(0, 12)).toString('ascii');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.byteLength >= 12 && header.slice(4, 12) === 'ftypavif') return 'image/avif';
  return null;
}

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function surfaceMessageStatus(status: v2.Turn['status']): SurfaceMessage['status'] {
  if (status === 'inProgress') return 'streaming';
  if (status === 'failed') return 'error';
  return 'complete';
}

function timestampToIso(timestamp: number | null | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return new Date(0).toISOString();
  }
  return new Date(timestamp * 1000).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
