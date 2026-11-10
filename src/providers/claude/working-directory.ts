import { homedir } from 'node:os';
const agentFolder = (agent: { folder: string | null }) => agent.folder?.trim() || undefined;
import type { Agent } from '../../contracts/index';

// Claude requires a cwd even for Quick Chats; this is not a project association.
export function claudeWorkingDirectory(agent: Pick<Agent, 'folder'>): string {
  return agentFolder(agent) ?? homedir();
}
