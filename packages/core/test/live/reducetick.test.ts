/**
 * [PND-REDUCETICK] `LiveReduce` emits at the end of each push (after
 * retention and `'evict'`), not on a microtask, so the number and value
 * of its outputs do not depend on where the caller awaits.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiveSeries, Trigger } from '../../src/index.js';
import { LiveReduce } from '../../src/live/live-reduce.js';
import { LiveView } from '../../src/live/live-view.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

const make = (opts: Record<string, unknown> = {}) =>
  new LiveSeries({ name: 'x', schema, ...opts });

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('LiveReduce emits at the end of each push', () => {
  it('three pushes with no await give three outputs, synchronously', () => {
    const live = make();
    const out: number[] = [];
    live
      .reduce({ v: 'sum' })
      .on('event', (e) => out.push(e.get('v') as number));
    live.push([1000, 1, 'a']);
    expect(out).toEqual([1]);
    live.push([2000, 2, 'a']);
    live.push([3000, 3, 'a']);
    expect(out).toEqual([1, 3, 6]);
  });

  it('awaiting between pushes gives the same outputs', async () => {
    const run = async (awaitBetween: boolean) => {
      const live = make();
      const out: number[] = [];
      live
        .reduce({ v: 'sum' })
        .on('event', (e) => out.push(e.get('v') as number));
      for (const [t, v] of [
        [1, 1],
        [2, 2],
        [3, 3],
      ] as const) {
        live.push([t * 1000, v, 'a']);
        if (awaitBetween) await flush();
      }
      await flush();
      return out;
    };
    expect(await run(false)).toEqual(await run(true));
  });

  it('count(2) over four separate pushes emits at pushes 2 and 4', () => {
    const live = make();
    const out: number[] = [];
    live
      .reduce({ v: 'sum' }, { trigger: Trigger.count(2) })
      .on('event', (e) => out.push(e.get('v') as number));
    for (const [t, v] of [
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ] as const) {
      live.push([t * 1000, v, 'a']);
    }
    expect(out).toEqual([3, 10]);
  });

  it('a pushMany still emits once, after retention', () => {
    const live = make({ retention: { maxEvents: 2 } });
    const log: string[] = [];
    live.on('event', (e) => log.push(`event ${e.get('v')}`));
    live.on('evict', (ev) => log.push(`evict ${ev.map((e) => e.get('v'))}`));
    live
      .reduce({ v: 'sum' })
      .on('event', (e) => log.push(`reduce ${e.get('v')}`));
    live.pushMany([
      [1000, 1, 'a'],
      [2000, 2, 'a'],
      [3000, 3, 'a'],
    ]);
    // Post-retention value: only 2 and 3 remain.
    expect(log).toEqual([
      'event 1',
      'event 2',
      'event 3',
      'evict 1',
      'reduce 5',
    ]);
  });

  it('reduce over a filter view emits at the end of the root push', () => {
    const live = make({ retention: { maxEvents: 3 } });
    const out: number[] = [];
    live
      .filter((e) => e.get('host') === 'a')
      .reduce({ v: 'sum' })
      .on('event', (e) => out.push(e.get('v') as number));
    live.push([1000, 1, 'a']);
    live.push([2000, 2, 'b']);
    live.push([3000, 3, 'a']);
    live.push([4000, 4, 'a']); // evicts t=1000 from root and view
    expect(out).toEqual([1, 4, 7]);
  });

  it('a push made from a reduce listener is queued and emits on its own', () => {
    const live = make();
    const out: number[] = [];
    live.reduce({ v: 'sum' }).on('event', (e) => {
      out.push(e.get('v') as number);
      if (out.length === 1) live.push([9000, 10, 'a']);
    });
    live.push([1000, 1, 'a']);
    expect(out).toEqual([1, 11]);
  });

  it('construction replay still emits once, after a microtask', async () => {
    const live = make();
    live.pushMany([
      [1000, 1, 'a'],
      [2000, 2, 'a'],
    ]);
    const r = live.reduce({ v: 'sum' });
    const out: number[] = [];
    r.on('event', (e) => out.push(e.get('v') as number));
    expect(out).toEqual([]);
    await flush();
    expect(out).toEqual([3]);
    live.push([3000, 3, 'a']);
    expect(out).toEqual([3, 6]);
  });

  it('dispose stops end-of-push emission', () => {
    const live = make();
    const r = live.reduce({ v: 'sum' });
    const out: number[] = [];
    r.on('event', (e) => out.push(e.get('v') as number));
    live.push([1000, 1, 'a']);
    r.dispose();
    live.push([2000, 2, 'a']);
    expect(out).toEqual([1]);
  });
});

describe('LiveReduce outside a push and on errors', () => {
  it('a reduce over a replaying reduce emits the replay value', async () => {
    const live = make();
    live.pushMany([
      [1000, 1, 'a'],
      [2000, 2, 'a'],
    ]);
    const r1 = live.reduce({ v: 'sum' });
    const viaView = new LiveView(r1 as never, (e: unknown) => e as never);
    const out: number[] = [];
    const outView: number[] = [];
    // LiveReduce over a LiveReduce, directly and through a view.
    new LiveReduce(r1 as never, { v: 'max' } as never).on('event', (e) =>
      out.push((e as { get(k: string): number }).get('v')),
    );
    (viaView as never as LiveSeries<typeof schema>)
      .reduce({ v: 'max' })
      .on('event', (e) => outView.push(e.get('v') as number));
    await flush();
    await flush();
    expect(out).toEqual([3]);
    expect(outView).toEqual([3]);
    live.push([3000, 3, 'a']);
    expect(out).toEqual([3, 6]);
    expect(outView).toEqual([3, 6]);
  });

  it('a source without the end-of-push hook falls back to a microtask', async () => {
    const live = make();
    const listeners: Array<(e: unknown) => void> = [];
    // Minimal custom LiveSource: no `_onSettle`.
    const custom = {
      name: 'custom',
      schema: live.schema,
      get length() {
        return live.length;
      },
      at: (i: number) => live.at(i),
      on: (_type: string, fn: (e: unknown) => void) => {
        listeners.push(fn);
        return () => {};
      },
    };
    live.on('event', (e) => listeners.forEach((fn) => fn(e)));
    const out: number[] = [];
    new LiveReduce(custom as never, { v: 'sum' } as never).on('event', (e) =>
      out.push((e as { get(k: string): number }).get('v')),
    );
    live.push([1000, 1, 'a']);
    live.push([2000, 2, 'a']);
    expect(out).toEqual([]);
    await flush();
    expect(out).toEqual([3]);
  });

  it('a throwing reduce listener is rethrown from push; state stays in step', () => {
    const live = make();
    const r = live.reduce({ v: 'sum' });
    let calls = 0;
    r.on('event', () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });
    expect(() => live.push([1000, 1, 'a'])).toThrow('boom');
    expect(live.length).toBe(1);
    live.push([2000, 2, 'a']);
    expect(calls).toBe(2);
    expect(r.value().v).toBe(3);
  });

  it('[PND-REDUCEMICRO] a synchronous loop of pushes queues one backstop microtask', async () => {
    const live = make();
    const r = live.reduce({ v: 'sum' });
    await flush(); // the construction replay's microtask
    const spy = vi.spyOn(globalThis, 'queueMicrotask');
    try {
      for (let i = 1; i <= 100; i++) live.push([i * 1000, i, 'a']);
      expect(spy).toHaveBeenCalledTimes(1);
      await flush();
      expect(r.length).toBe(100); // one per push
      live.push([101_000, 1, 'a']); // the microtask cleared the flag: queues again
      expect(spy).toHaveBeenCalledTimes(3); // + the test's own flush()
    } finally {
      spy.mockRestore();
    }
  });
});
