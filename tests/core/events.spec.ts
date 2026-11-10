import { describe, expect, it, vi } from 'vitest';
import { TypedEventBus } from '../../src/core/typed-event-bus';

type TestEvents = {
  'message.updated': { id: string; text: string };
  'turn.completed': { turnId: string };
};

describe('TypedEventBus', () => {
  it('publishes typed payloads and removes listeners', () => {
    const bus = new TypedEventBus<TestEvents>();
    const listener = vi.fn();
    const unsubscribe = bus.on('message.updated', listener);

    bus.emit('message.updated', { id: 'message-1', text: 'Hello' });
    unsubscribe();
    bus.emit('message.updated', { id: 'message-1', text: 'Ignored' });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ id: 'message-1', text: 'Hello' });
    expect(bus.listenerCount('message.updated')).toBe(0);
  });

  it('supports one-shot listeners and stable iteration during emission', () => {
    const bus = new TypedEventBus<TestEvents>();
    const once = vi.fn();
    const persistent = vi.fn();
    bus.once('turn.completed', once);
    bus.on('turn.completed', persistent);

    bus.emit('turn.completed', { turnId: 'turn-1' });
    bus.emit('turn.completed', { turnId: 'turn-2' });

    expect(once).toHaveBeenCalledOnce();
    expect(persistent).toHaveBeenCalledTimes(2);
  });

  it('can cancel a one-shot listener before it fires', () => {
    const bus = new TypedEventBus<TestEvents>();
    const listener = vi.fn();
    const unsubscribe = bus.once('turn.completed', listener);

    unsubscribe();
    bus.emit('turn.completed', { turnId: 'turn-1' });

    expect(listener).not.toHaveBeenCalled();
  });

  it('clears one event or the full bus', () => {
    const bus = new TypedEventBus<TestEvents>();
    bus.on('message.updated', vi.fn());
    bus.on('turn.completed', vi.fn());

    bus.clear('message.updated');
    expect(bus.listenerCount('message.updated')).toBe(0);
    expect(bus.listenerCount('turn.completed')).toBe(1);
    bus.clear();
    expect(bus.listenerCount('turn.completed')).toBe(0);
  });
});
