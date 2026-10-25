/**
 * [PND-REDUCETICK] `LiveReduce` emits at the end of each push (after
 * retention and `'evict'`), not on a microtask, so the number and value
 * of its outputs do not depend on where the caller awaits.
 */
import { describe, expect, it } from 'vitest';
import { LiveSeries, Trigger } from '../../src/index.js';

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
