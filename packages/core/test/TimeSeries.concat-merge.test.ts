/**
 * `TimeSeries.concat` as a k-way merge of sorted inputs ([PND-CONCATSORT]).
 * It must give exactly the old stable sort of every input's events by
 * `compareEventKeys` — begin, then end, never the interval label — with
 * ties kept in input order.
 */
import { describe, expect, it } from 'vitest';
import { Interval, TimeSeries } from '../src/index.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rangeSchema = [
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'id', kind: 'string' },
] as const;

describe('concat merge', () => {
  it('matches a stable sort of all rows by begin then end', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const r = rng(seed);
      const inputs = Array.from({ length: 1 + Math.floor(r() * 8) }, (_, k) => {
        const rows: Array<[[number, number], string]> = [];
        let t = Math.floor(r() * 5);
        const n = Math.floor(r() * 12);
        for (let i = 0; i < n; i += 1) {
          t += r() < 0.4 ? 0 : Math.floor(r() * 3);
          rows.push([[t, t + Math.floor(r() * 3)], `${k}:${i}`]);
        }
        return new TimeSeries({
          name: `p${k}`,
          schema: rangeSchema,
          rows,
          ordering: 'reorder',
        });
      });
      const all = inputs.flatMap((s) =>
        s.toArray().map((e) => [e.begin(), e.end(), e.get('id')] as const),
      );
      // Array.prototype.sort is stable.
      const want = [...all].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const got = TimeSeries.concat(inputs)
        .toArray()
        .map((e) => [e.begin(), e.end(), e.get('id')] as const);
      expect(got, `seed ${seed}`).toEqual(want);
    }
  });

  it('ignores interval labels, so a later input keeps its place on a tie', () => {
    const schema = [
      { name: 'interval', kind: 'interval' },
      { name: 'v', kind: 'number' },
    ] as const;
    const a = new TimeSeries({ name: 'a', schema, rows: [[['z', 0, 5], 1]] });
    const b = new TimeSeries({ name: 'b', schema, rows: [[['a', 0, 5], 2]] });
    const out = TimeSeries.concat([a, b]);
    expect(out.toArray().map((e) => (e.key() as Interval).value)).toEqual([
      'z',
      'a',
    ]);
  });

  it('still refuses interval inputs with different label kinds', () => {
    const schema = [
      { name: 'interval', kind: 'interval' },
      { name: 'v', kind: 'number' },
    ] as const;
    const a = new TimeSeries({ name: 'a', schema, rows: [[['x', 0, 5], 1]] });
    const b = new TimeSeries({ name: 'b', schema, rows: [[[7, 1, 5], 2]] });
    expect(() => TimeSeries.concat([a, b])).toThrow(
      /row 1 has interval label of type number but earlier rows had string labels/,
    );
  });

  it('keeps built events, empty inputs and the required rule', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const;
    const optional = [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number', required: false },
    ] as const;
    const a = new TimeSeries({
      name: 'a',
      schema,
      rows: [
        [0, 1],
        [2, 3],
      ],
    });
    const empty = new TimeSeries({ name: 'e', schema, rows: [] });
    const b = new TimeSeries({ name: 'b', schema: optional, rows: [[1, 2]] });
    const held = a.at(1)!;
    const out = TimeSeries.concat([a, empty, b as never]);
    expect(out.toArray().map((e) => e.get('v'))).toEqual([1, 2, 3]);
    expect(out.at(2)).toBe(held);
    expect(out.schema[1]).toEqual({
      name: 'v',
      kind: 'number',
      required: false,
    });
    expect(TimeSeries.concat([empty, empty]).length).toBe(0);
  });
});
