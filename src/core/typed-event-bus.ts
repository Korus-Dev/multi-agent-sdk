export type EventListener<Payload> = (payload: Payload) => void;

export class TypedEventBus<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<EventListener<Events[keyof Events]>>>();

  on<Name extends keyof Events>(name: Name, listener: EventListener<Events[Name]>): () => void {
    const listeners = this.listeners.get(name) ?? new Set();
    const untypedListener = listener as EventListener<Events[keyof Events]>;
    listeners.add(untypedListener);
    this.listeners.set(name, listeners);
    return () => {
      listeners.delete(untypedListener);
      if (listeners.size === 0) {
        this.listeners.delete(name);
      }
    };
  }

  once<Name extends keyof Events>(name: Name, listener: EventListener<Events[Name]>): () => void {
    let unsubscribe: () => void = () => {};
    unsubscribe = this.on(name, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  emit<Name extends keyof Events>(name: Name, payload: Events[Name]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      listener(payload);
    }
  }

  clear<Name extends keyof Events>(name?: Name): void {
    if (name === undefined) {
      this.listeners.clear();
      return;
    }
    this.listeners.delete(name);
  }

  listenerCount<Name extends keyof Events>(name: Name): number {
    return this.listeners.get(name)?.size ?? 0;
  }
}
