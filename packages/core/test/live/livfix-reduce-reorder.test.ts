import { describe, expect, it } from 'vitest';

import { LiveSeries } from '../../src/live/live-series.js';

/* -------------------------------------------------------------------------- */
/* [PND-LIVFIX] — `LiveReduce` windowed extrema over a `reorder` source with  */
/* retention. The windowed states (monotone deque, head-removal entries)     */
/* assumed eviction removes the OLDEST-ARRIVED event; a reorder source evicts */
/* the sorted prefix, which can be the NEWEST arrival. Then `min`/`max`/      */
/* `first`/`last` went stale or `undefined`.                                  */
/* -------------------------------------------------------------------------- */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;

function reorderSource(retention: { maxEvents?: number; maxAge?: string }) {
  return new LiveSeries({
    name: 'r',
    schema: SCHEMA,
    ordering: 'reorder',
    // grace must not exceed maxAge (the series validates that)
    graceWindow: retention.maxAge ?? '1h',
    retention,
  });
}

describe('[PND-LIVFIX] LiveReduce windowed reducers on reorder + retention', () => {
  it('min/max survive evicting the newest ARRIVAL (which is the oldest by time)', () => {
    const live = reorderSource({ maxEvents: 2 });
    const r = live.reduce({
      lo: { from: 'value', using: 'min' },
      hi: { from: 'value', using: 'max' },
    });
    live.push([3000, 30]);
    live.push([2000, 20]); // late
    // Buffer (time-sorted): [2000→20, 3000→30]. This is the arrival
    // that is oldest by time but newest by arrival, and maxEvents 2
    // evicts it on its own insert.
    live.push([1000, 10]);
    expect(live.length).toBe(2);
    // Audit: min came back `undefined` (the deque head was the evicted
    // slot) and max stayed stale.
    expect(r.value()).toEqual({ lo: 20, hi: 30 });
  });

  it('min/max track a sorted-prefix eviction that drops a middle arrival', () => {
    const live = reorderSource({ maxEvents: 3 });
    const r = live.reduce({
      lo: { from: 'value', using: 'min' },
      hi: { from: 'value', using: 'max' },
    });
    live.push([5000, 50]);
    live.push([1000, 5]); // late: will be the sorted prefix
    live.push([4000, 40]);
    live.push([3000, 30]); // buffer [1000, 3000, 4000, 5000] → evict 1000 (v=5)
    expect(live.length).toBe(3);
    expect(r.value()).toEqual({ lo: 30, hi: 50 });
    live.push([2000, 1]); // late again, and it is the new sorted prefix → evicted immediately
    expect(live.length).toBe(3);
    expect(r.value()).toEqual({ lo: 30, hi: 50 });
  });

  it('difference tracks a sorted-prefix eviction ([PND-ROLLDIFF])', () => {
    // `difference` uses the min/max deques on arrival-order sources, so it
    // must swap to the any-order sorted array here exactly as min/max do.
    const live = reorderSource({ maxEvents: 3 });
    const r = live.reduce({ d: { from: 'value', using: 'difference' } });
    live.push([5000, 50]);
    live.push([1000, 5]); // late: will be the sorted prefix
    live.push([4000, 40]);
    live.push([3000, 30]); // evicts 1000 (v=5), the second arrival
    expect(r.value()).toEqual({ d: 20 });
    live.push([2000, 1]); // the new sorted prefix → evicted immediately
    expect(r.value()).toEqual({ d: 20 });
  });

  it('first/last (arrival order) never report an evicted value', () => {
    const live = reorderSource({ maxEvents: 2 });
    const r = live.reduce({
      f: { from: 'value', using: 'first' },
      l: { from: 'value', using: 'last' },
    });
    live.push([3000, 30]);
    live.push([2000, 20]);
    live.push([1000, 10]); // evicted on insert: newest arrival gone
    // Retained arrivals in arrival order: 30, 20.
    expect(r.value()).toEqual({ f: 30, l: 20 });
    live.push([4000, 40]); // buffer [2000, 3000, 4000] → evict 2000 (v=20, a middle arrival)
    expect(r.value()).toEqual({ f: 30, l: 40 });
  });

  it('maxAge eviction of a late arrival keeps the extrema exact', () => {
    const live = reorderSource({ maxAge: '5s' });
    const r = live.reduce({
      lo: { from: 'value', using: 'min' },
      hi: { from: 'value', using: 'max' },
    });
    live.push([10_000, 100]);
    live.push([7_000, 7]); // late, inside maxAge of 10s
    expect(r.value()).toEqual({ lo: 7, hi: 100 });
    live.push([13_000, 50]); // cutoff 8s → evicts 7_000 (the second arrival, not the first)
    expect(live.length).toBe(2);
    expect(r.value()).toEqual({ lo: 50, hi: 100 });
  });

  it('the chunked (strict) backing is unchanged: FIFO path still exact', () => {
    const live = new LiveSeries({
      name: 's',
      schema: SCHEMA,
      retention: { maxEvents: 2 },
    });
    const r = live.reduce({
      lo: { from: 'value', using: 'min' },
      hi: { from: 'value', using: 'max' },
    });
    live.pushMany([
      [1000, 10],
      [2000, 30],
      [3000, 20],
    ]);
    expect(r.value()).toEqual({ lo: 20, hi: 30 });
  });
});
