export type TurnGitDiff = {
  agentId: string;
  turnId: string;
  addedLines: number;
  removedLines: number;
  diff?: string;
  updatedAt: string;
};