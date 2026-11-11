import type { Admission, HarnessEvent, Run, RunEvent, RunResult, Session, SessionState } from './consumer-types';

/** What a run needs from its harness. */
export type RunSource = {
  session: Session;
  subscribe(listener: (event: HarnessEvent) => void): () => void;
  admit(): Promise<Admission>;
  /** The session's current state; undefined once it is gone. */
  state(): SessionState | undefined;
  steer(prompt: string): Promise<Admission>;
  interrupt(turnId: string | undefined): Promise<Admission>;
};

const ignore = () => {};
const turnOf = (event: RunEvent): string | undefined => 'turnId' in event && typeof event.turnId === 'string' ? event.turnId : undefined;
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

/**
 * Follows one prompt to the end of its turn. Events are held until the prompt is admitted, then those of other turns
 * are dropped. The turn is the one admission names, or else the first that starts. `onEnd` runs once, however the run ends.
 */
export function startRun(source: RunSource, onEnd: () => void): { run: Run; abandon(reason: string): void } {
  const { session } = source;
  const earlier = new Set(source.state()?.messages.map(message => message.id));
  let admitted = false;
  let turnId: string | undefined;
  let ended = false;
  let reading = true;
  let failure: Error | undefined;
  const held: RunEvent[] = [];
  const queue: RunEvent[] = [];
  let wake: (() => void) | undefined;
  const signal = () => { const resolve = wake; wake = undefined; resolve?.(); };

  let settle!: (result: RunResult) => void;
  let fail!: (error: Error) => void;
  const result = new Promise<RunResult>((resolve, reject) => { settle = resolve; fail = reject; });
  // Whoever awaits the result or the events still sees the rejection; nobody awaiting is not a crash.
  void result.catch(ignore);

  const end = (outcome: { result: RunResult } | { error: Error }) => {
    if (ended) return;
    ended = true; off(); onEnd();
    if ('error' in outcome) { failure = outcome.error; fail(outcome.error); } else settle(outcome.result);
    signal();
  };
  const accept = (event: RunEvent) => {
    const id = turnOf(event);
    if (id && !turnId && event.type === 'turn.started') turnId = id;
    if (id && id !== turnId) return;
    if (reading) { queue.push(event); signal(); }
    if (event.type === 'recovery.required') end({ error: new Error(event.reason) });
    else if (event.type === 'turn.completed' && !event.willRetry) {
      const messages = source.state()?.messages ?? [];
      const own = messages.filter(message => message.turnId === event.turnId);
      end({ result: { session, turnId: event.turnId, status: event.status, error: event.error,
        messages: own.length ? own : messages.filter(message => !earlier.has(message.id)) } });
    }
  };
  const off = source.subscribe(event => {
    // Full states are left to readSession: a run nobody reads would otherwise hold one per change.
    if (ended || event.type === 'session.changed' || !('session' in event) || event.session !== session) return;
    if (admitted) accept(event as RunEvent); else held.push(event as RunEvent);
  });

  const admission = source.admit();
  void admission.catch(ignore);
  admission.then(value => {
    if (ended) return;
    admitted = true; turnId = value.turnId;
    for (const event of held.splice(0)) if (!ended) accept(event);
  }, (error: unknown) => end({ error: asError(error) }));

  let thrown = false;
  const events: AsyncIterableIterator<RunEvent> = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      for (;;) {
        const event = queue.shift();
        if (event) return { value: event, done: false };
        if (!reading || ended) {
          if (failure && reading && !thrown) { thrown = true; throw failure; }
          return { value: undefined, done: true };
        }
        await new Promise<void>(resolve => { wake = resolve; });
      }
    },
    async return() { reading = false; queue.length = 0; signal(); return { value: undefined, done: true }; },
  };

  const run: Run = {
    session, admission, events, result,
    steer: prompt => source.steer(prompt),
    interrupt: () => source.interrupt(turnId),
  };
  return { run, abandon: reason => end({ error: new Error(reason) }) };
}
