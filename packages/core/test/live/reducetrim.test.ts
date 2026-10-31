import { describe, expect, it } from 'vitest';

import { LiveSeries } from '../../src/live/live-series.js';

/* -------------------------------------------------------------------------- */
/* [PND-REDUCETRIM] — `LiveReduce` over a view must track what the view holds. */
/* Codex review of pond-rs (2026-10-29) R01 / R02, both shared with pond-ts:  */
/* a `window` view trims silently, so a reduce on it kept every value it had  */
/* ever taken; and a reduce on a view of a `reorder` series picked the        */
/* arrival-order reducer states, so evicting a late arrival corrupted         */
/* min / max / first / last.                                                  */
/* -------------------------------------------------------------------------- */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

const MAPPING = {
  s: { from: 'v', using: 'sum' },
  n: { from: 'v', using: 'count' },
  lo: { from: 'v', using: 'min' },
} as const;

describe('[PND-REDUCETRIM] reduce on a window view', () => {
  it('removes what a row window and a time window trim', () => {
    const live = new LiveSeries({
      name: 'x',
      schema: SCHEMA,
      retention: { maxEvents: 3 },
    });
    const byRows = live.window(2).reduce(MAPPING);
    const bySpan = live.window('1500ms').reduce(MAPPING);
    live.push([1000, 1]);
    live.push([2000, 2]);
    live.push([3000, 3]);
    expect(byRows.value()).toEqual({ s: 5, n: 2, lo: 2 });
    expect(byRows.stats().bufferSize).toBe(2);
    expect(bySpan.value()).toEqual({ s: 5, n: 2, lo: 2 });
    expect(byRows.at(-1)!.get('s')).toBe(5);
    // Root retention after trims: the windows already trimmed 1000.
    live.pushMany([
      [4000, 4],
      [5000, 5],
    ]);
    expect(byRows.value()).toEqual({ s: 9, n: 2, lo: 4 });
    expect(byRows.stats().bufferSize).toBe(2);
    expect(bySpan.value()).toEqual({ s: 9, n: 2, lo: 4 });
    live.clear();
    live.push([6000, 6]);
    expect(byRows.value()).toEqual({ s: 6, n: 1, lo: 6 });
    expect(bySpan.value()).toEqual({ s: 6, n: 1, lo: 6 });
  });

  it('adds and removes a late event the window trims at once', () => {
    const live = new LiveSeries({
      name: 'x',
      schema: SCHEMA,
      ordering: 'reorder',
    });
    const w = live.window('1s');
    const r = w.reduce({
      s: { from: 'v', using: 'sum' },
      hi: { from: 'v', using: 'max' },
      l: { from: 'v', using: 'last' },
    });
    for (const row of [
      [1000, 1],
      [2000, 2],
      [2500, 3],
      [100, 50],
    ] as const)
      live.push(row);
    expect(w.length).toBe(2);
    expect(r.value()).toEqual({ s: 5, hi: 3, l: 3 });
  });
});

describe('[PND-REDUCETRIM] reduce on a view of a reorder series', () => {
  it('uses states that remove any event, through views of views', () => {
    const live = new LiveSeries({
      name: 'x',
      schema: SCHEMA,
      ordering: 'reorder',
      retention: { maxEvents: 2 },
    });
    const f = live.filter(() => true);
    const g = f.filter(() => true);
    const mapping = {
      hi: { from: 'v', using: 'max' },
      lo: { from: 'v', using: 'min' },
      first: { from: 'v', using: 'first' },
      last: { from: 'v', using: 'last' },
    } as const;
    const onF = f.reduce(mapping);
    const onG = g.reduce(mapping);
    live.push([1000, 10]);
    live.push([2000, 20]);
    live.push([500, 100]); // late; retention evicts it on its own insert
    expect(f.length).toBe(2);
    const want = { hi: 20, lo: 10, first: 10, last: 20 };
    expect(onF.value()).toEqual(want);
    expect(onG.value()).toEqual(want);
  });
});

describe('[PND-REDUCETRIM] other chains', () => {
  it('window built over history, then a reduce, then more pushes', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    for (const t of [1000, 2000, 3000, 4000]) live.push([t, t / 1000]);
    const w = live.window(2);
    const r = w.reduce(MAPPING);
    expect(r.value()).toEqual({ s: 7, n: 2, lo: 3 });
    live.push([5000, 5]);
    expect(r.value()).toEqual({ s: 9, n: 2, lo: 4 });
  });

  it('a filter on a window keeps what the window trims', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    const f = live.window(2).filter(() => true);
    const r = f.reduce({ s: { from: 'v', using: 'sum' } });
    for (const t of [1000, 2000, 3000]) live.push([t, t / 1000]);
    expect(f.length).toBe(3);
    expect(r.value()).toEqual({ s: 6 });
  });

  it('rolling of a reorder series, then a window, then a reduce', () => {
    // The rolling output carries the late event's key, so the window
    // over it trims by key order, not arrival order.
    const live = new LiveSeries({
      name: 'x',
      schema: SCHEMA,
      ordering: 'reorder',
    });
    const ro = live.rolling('10s', { v: 'max' });
    const w = ro.window(2);
    const r = w.reduce({
      hi: { from: 'v', using: 'max' },
      lo: { from: 'v', using: 'min' },
      last: { from: 'v', using: 'last' },
    });
    live.push([1000, 1]);
    live.push([2000, 2]);
    live.push([500, 7]); // late: rolling emits at 500, the window trims it
    expect(w.length).toBe(2);
    const held = [w.at(0)!.get('v'), w.at(1)!.get('v')];
    expect(r.value()).toEqual({
      hi: Math.max(...(held as number[])),
      lo: Math.min(...(held as number[])),
      last: 2,
    });
  });
});
