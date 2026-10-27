/**
 * [PND-BATCHATOM] A `push` / `pushMany` with one bad row is refused whole in
 * every ordering mode and key kind: nothing is committed, no listener
 * fires, and stats do not move. Before the fix the per-row backing
 * (`drop`, `reorder`, and non-time keys under `strict`) committed the rows
 * before the bad one and then threw, skipping retention, `'batch'` and
 * `'evict'` (a `maxEvents: 2` series ended up holding 4 rows).
 */
import { describe, expect, it } from 'vitest';
import { LiveSeries } from '../../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

const intervalSchema = [
  { name: 'interval', kind: 'interval' },
  { name: 'v', kind: 'number' },
] as const;

function watch(live: { on: (t: any, fn: any) => unknown }) {
  const seen: string[] = [];
  for (const type of ['event', 'batch', 'evict']) {
    live.on(type, () => seen.push(type));
  }
  return seen;
}

describe('pushMany refuses a bad batch whole', () => {
  for (const ordering of ['strict', 'drop', 'reorder'] as const) {
    it(`a bad cell under ${ordering}`, () => {
      const live = new LiveSeries({
        name: 'x',
        schema,
        ordering,
        retention: { maxEvents: 2 },
      });
      live.pushMany([
        [0, 1],
        [1000, 2],
      ]);
      const seen = watch(live);
      const before = live.stats();
      expect(() =>
        live.pushMany([
          [2000, 3],
          [3000, 4],
          [4000, 'bad' as never],
        ]),
      ).toThrow(/expected finite number/);
      expect(seen).toEqual([]);
      expect(live.stats()).toEqual(before);
      expect(live.toRows().map((r) => r[1])).toEqual([1, 2]);
    });
  }

  it('a wrong row width under drop', () => {
    const live = new LiveSeries({ name: 'x', schema, ordering: 'drop' });
    expect(() => live.pushMany([[0, 1], [1000] as never])).toThrow(
      /expected 2 values, got 1/,
    );
    expect(live.length).toBe(0);
  });

  it('a late row outside the grace window under reorder', () => {
    const live = new LiveSeries({
      name: 'x',
      schema,
      ordering: 'reorder',
      graceWindow: '1s',
    });
    live.push([5000, 1]);
    const seen = watch(live);
    expect(() =>
      live.pushMany([
        [6000, 2],
        [5200, 3], // within grace of 6000
        [4000, 4], // 2s behind 6000: outside grace
      ]),
    ).toThrow(
      'event at 4000 is outside grace window (latest: 6000, grace: 1000ms)',
    );
    expect(seen).toEqual([]);
    expect(live.length).toBe(1);
    // The same rows without the bad one are accepted and sorted.
    live.pushMany([
      [6000, 2],
      [5200, 3],
    ]);
    expect(live.toRows().map((r) => r[1])).toEqual([1, 3, 2]);
  });

  it('the grace check uses the latest key the batch itself reached', () => {
    const live = new LiveSeries({
      name: 'x',
      schema,
      ordering: 'reorder',
      graceWindow: '1s',
    });
    live.push([1000, 1]);
    // 1500 is fine against 1000, but the batch has already moved the
    // latest key to 3000, so it is 1.5s late.
    expect(() =>
      live.pushMany([
        [3000, 2],
        [1500, 3],
      ]),
    ).toThrow('event at 1500 is outside grace window (latest: 3000');
    expect(live.length).toBe(1);
  });

  it('drop mode still drops late rows and keeps the rest', () => {
    const live = new LiveSeries({ name: 'x', schema, ordering: 'drop' });
    live.push([5000, 1]);
    live.pushMany([
      [4000, 2],
      [6000, 3],
      [5500, 4],
    ]);
    expect(live.toRows().map((r) => r[1])).toEqual([1, 3]);
    expect(live.stats().rejected).toBe(2);
  });

  it('an out-of-order row on a strict interval-keyed series', () => {
    const live = new LiveSeries({ name: 'x', schema: intervalSchema });
    live.push([['a', 0, 1000], 1]);
    const seen = watch(live);
    expect(() =>
      live.pushMany([
        [['b', 1000, 2000], 2],
        [['c', 500, 600], 3],
      ]),
    ).toThrow('out-of-order event: timestamp 500 is before latest 1000');
    expect(seen).toEqual([]);
    expect(live.length).toBe(1);
  });
});
