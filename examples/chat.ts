import { createHarness, type HarnessProvider } from '@korus-dev/multi-agent-sdk';

const [provider = 'codex', ...words] = process.argv.slice(2);
if (!['codex', 'claude', 'cursor', 'antigravity'].includes(provider)) {
  throw new Error('Choose codex, claude, cursor, or antigravity.');
}
const harness = createHarness(provider as HarnessProvider, { client: { name: 'sdk-example' } });
const session = harness.open({ id: 'chat', folder: process.cwd() });
const run = harness.run(session, words.join(' ') || 'Describe this project in one paragraph.');
const stop = () => { void run.interrupt().catch(() => {}); };
process.once('SIGINT', stop);
try {
  for await (const event of run.events) {
    if (event.type === 'request.created') {
      // This console example never grants a permission silently.
      console.error(`The agent asked for ${event.request.kind}; use a host that can answer requests.`);
      stop();
    }
  }
  const { status, error, messages } = await run.result;
  for (const message of messages) {
    if (message.role === 'assistant') console.log(message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'));
  }
  if (status !== 'completed') { console.error(error?.message ?? `Turn ${status}.`); process.exitCode = 1; }
} finally {
  process.removeListener('SIGINT', stop);
  await harness.close();
}
