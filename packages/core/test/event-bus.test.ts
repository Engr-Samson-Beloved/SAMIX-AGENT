import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, RingBuffer, publish } from '../dist/index.js';
import { matchObject, spy } from './helpers.ts';

describe('EventBus', () => {
  it('delivers to type-specific and wildcard subscribers', () => {
    const bus = new EventBus();
    const specific = spy();
    const wildcard = spy();
    bus.on('agent.thinking', specific);
    bus.onAny(wildcard);

    publish(bus, { type: 'agent.thinking' });

    assert.equal(specific.count, 1);
    assert.equal(wildcard.count, 1);
  });

  it('stamps the timestamp so publishers do not have to', () => {
    const bus = new EventBus();
    const handler = spy<[{ at: string }]>();
    bus.onAny(handler);
    publish(bus, { type: 'agent.listening' });
    assert.equal(typeof handler.calls[0]?.[0]?.at, 'string');
  });

  /** The state machine depends on this: observed order must equal causal order. */
  it('dispatches synchronously', () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('agent.thinking', () => order.push('handler'));
    publish(bus, { type: 'agent.thinking' });
    order.push('after-emit');
    assert.deepStrictEqual(order, ['handler', 'after-emit']);
  });

  /** An observer must never be able to fail the thing it observes. */
  it('isolates a throwing handler and reports it', () => {
    const bus = new EventBus();
    const onError = spy();
    bus.setErrorHandler(onError);
    bus.on('agent.thinking', () => {
      throw new Error('boom');
    });
    const survivor = spy();
    bus.on('agent.thinking', survivor);

    assert.doesNotThrow(() => publish(bus, { type: 'agent.thinking' }));
    assert.equal(survivor.count, 1, 'a later handler must still run');
    assert.equal(onError.count, 1);
  });

  it('unsubscribes cleanly and leaks no handlers', () => {
    const bus = new EventBus();
    const handler = spy();
    const off = bus.on('agent.thinking', handler);
    off();
    publish(bus, { type: 'agent.thinking' });
    assert.equal(handler.count, 0);
    assert.equal(bus.stats().handlers, 0);
  });

  it('tolerates a handler unsubscribing during dispatch', () => {
    const bus = new EventBus();
    const second = spy();
    const off = bus.on('agent.thinking', () => off());
    bus.on('agent.thinking', second);
    assert.doesNotThrow(() => publish(bus, { type: 'agent.thinking' }));
    assert.equal(second.count, 1);
  });

  it('fires a once subscription exactly once', () => {
    const bus = new EventBus();
    const handler = spy();
    bus.once('agent.thinking', handler);
    publish(bus, { type: 'agent.thinking' });
    publish(bus, { type: 'agent.thinking' });
    assert.equal(handler.count, 1);
  });

  describe('waitFor', () => {
    it('resolves on the matching event', async () => {
      const bus = new EventBus();
      const pending = bus.waitFor('agent.listening', 1000);
      publish(bus, { type: 'agent.listening' });
      matchObject(await pending, { type: 'agent.listening' });
    });

    /** Development rule 15: nothing in the agent waits forever. */
    it('rejects on timeout rather than hanging', async () => {
      const bus = new EventBus();
      await assert.rejects(() => bus.waitFor('agent.listening', 20), /Timed out/);
    });

    it('rejects when the signal aborts', async () => {
      const bus = new EventBus();
      const controller = new AbortController();
      const pending = bus.waitFor('agent.listening', 5000, controller.signal);
      controller.abort();
      await assert.rejects(() => pending);
    });
  });
});

describe('RingBuffer', () => {
  it('returns entries oldest-first', () => {
    const ring = new RingBuffer<number>(5);
    for (const n of [1, 2, 3]) ring.push(n);
    assert.deepStrictEqual(ring.toArray(), [1, 2, 3]);
  });

  it('overwrites oldest entries once full and keeps a hard ceiling', () => {
    const ring = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) ring.push(n);
    assert.deepStrictEqual(ring.toArray(), [3, 4, 5]);
    assert.equal(ring.size, 3);
  });

  it('tails the most recent n', () => {
    const ring = new RingBuffer<number>(10);
    for (let i = 1; i <= 6; i += 1) ring.push(i);
    assert.deepStrictEqual(ring.tail(2), [5, 6]);
    assert.equal(ring.tail(99).length, 6);
    assert.deepStrictEqual(ring.tail(0), []);
  });

  it('rejects a nonsensical capacity', () => {
    assert.throws(() => new RingBuffer<number>(0), RangeError);
  });
});
