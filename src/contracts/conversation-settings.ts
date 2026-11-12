export type ConversationSettings = {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  /** The permission in effect, as one of the ids in `capabilities.permissions`. */
  permission?: string;
};