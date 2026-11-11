import { createHarness, type HarnessProvider, type Session } from '@korus-dev/multi-agent-sdk';

const provider = process.argv[2] ?? 'codex';
if (!['codex', 'claude', 'cursor', 'antigravity'].includes(provider)) {
  throw new Error('Choose codex, claude, cursor, or antigravity.');
}
const driver = createHarness(provider as HarnessProvider, { client: { name: 'sdk-example' } });
const session = driver.open({ id: 'chat', folder: process.cwd() });
const prompt = process.argv.slice(3).join(' ') || 'Describe this project in one paragraph.';

// Subscribe before sending: a fast native turn may finish before admission resolves.
let admissionKnown = false;
let turnId: string | undefined;
let resolveCompletion!: () => void;
let rejectCompletion!: (error: Error) => void;
const completed = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
// Attach a handler immediately, even if a provider reports failure during admission.
void completed.catch(() => {});
function observe(current: Session) {
  const state = driver.readSession(current);
  if (!admissionKnown) return;
  const turn = turnId ? state.turns.find(turn => turn.id === turnId) : state.turns.at(-1);
  if (turn?.status === 'completed') resolveCompletion();
  else if (turn?.status === 'failed' || turn?.status === 'interrupted') rejectCompletion(new Error(`Turn ${turn.status}`));
}
const off = driver.onEvent(event => {
  if (event.type === 'session.changed' && event.session === session) observe(session);
  if (event.type === 'recovery.required' && event.session === session) rejectCompletion(new Error(event.reason));
  if (event.type === 'request.created' && event.session === session) {
    // This console example never grants a permission silently.
    rejectCompletion(new Error(`Interactive ${event.request.kind} requested; use a host with request controls.`));
  }
});
const timeout = setTimeout(() => rejectCompletion(new Error('Timed out waiting for completion')), 120_000);
const stop = () => rejectCompletion(new Error('Interrupted'));
process.once('SIGINT', stop);
try {
  const admission = await driver.sendPrompt(session, prompt);
  turnId = admission.turnId;
  admissionKnown = true;
  observe(session);
  await completed;
  for (const message of driver.readSession(session).messages) {
    if (message.role === 'assistant') {
      console.log(message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'));
    }
  }
} finally {
  clearTimeout(timeout);
  process.removeListener('SIGINT', stop);
  off();
  await driver.close();
}
