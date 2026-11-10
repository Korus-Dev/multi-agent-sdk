
type Message = { role?: string; kind?: string; parts?: readonly WorkPhasePart[] };
export type WorkPhasePart = { type: string; phase?: string; text?: string; content?: string; metadata?: Record<string, unknown> };

/**
 * Gives backends that do not tag work phases (Claude) the Working / Done grouping Codex has:
 * text after the last work tool is the final answer. Completion bookkeeping is not work.
 */
export function withInferredWorkPhases<T extends Message>(message: T, isBookkeepingTool: (part: WorkPhasePart) => boolean = part => part.metadata?.workPhase === 'bookkeeping'): T {
  const parts = message.parts as WorkPhasePart[] | undefined;
  if (message.role !== 'assistant' || !parts?.some(part => part.type === 'tool')) return message;
  if (parts.some(part => part.type === 'reasoning' || part.phase !== undefined)) return message;

  return withInferredTurnWorkPhases([message], isBookkeepingTool)[0]!;
}

/** Classify unphased historical text using only the last work tool in the whole turn. */
export function withInferredTurnWorkPhases<T extends Message>(messages: T[], isBookkeepingTool: (part: WorkPhasePart) => boolean = part => part.metadata?.workPhase === 'bookkeeping'): T[] {
  let position = 0; let lastWork = -1;
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (message.role === 'assistant' && isWorkTool(part, isBookkeepingTool)) lastWork = position;
      position++;
    }
  }
  if (lastWork < 0) return messages;
  position = 0;
  return messages.map(message => {
    const parts = message.parts?.map(part => {
      const index = position++;
      if (message.role !== 'assistant' || part.type !== 'text' || part.phase !== undefined) return part;
      const hasText = (part.text ?? part.content ?? '').trim().length > 0;
      return { ...part, phase: index < lastWork || !hasText ? 'commentary' : 'final_answer' };
    });
    return message.role === 'assistant' && parts ? { ...message, parts } as T : message;
  });
}

function isWorkTool(part: WorkPhasePart, isBookkeepingTool: (part: WorkPhasePart) => boolean): boolean { return part.type === 'tool' && !isBookkeepingTool(part); }
