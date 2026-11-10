import path from 'node:path';
import { homedir } from 'node:os';

/** Default private state for a host that does not supply its own data directory. */
export const defaultRuntimeDirectory = () => path.join(homedir(), '.multi-agent-sdk');
