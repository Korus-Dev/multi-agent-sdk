/** Serializable authored content. Mentions exist only after explicit selection. */
export type PromptMention = {
  type: 'mention';
  kind: 'skill' | 'plugin' | 'file' | 'custom';
  id: string;
  /** Exact visible chip label, without an added $ or @ prefix. */
  label: string;
  /** Selected catalog name/value; never inferred from surrounding text. */
  value: string;
  groupId?: string;
};

export type PromptPart = { type: 'text'; text: string } | PromptMention;
