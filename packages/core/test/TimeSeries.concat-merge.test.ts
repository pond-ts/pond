/**
 * `TimeSeries.concat` as a k-way merge of sorted inputs ([PND-CONCATSORT]).
 * It must give exactly the old stable sort of every input's events by
 * `compareEventKeys` — begin, then end, never the interval label — with
 * ties kept in input order.
 */
import { describe, expect, it } from 'vitest';
import { Event, Interval, Time, TimeSeries } from '../src/index.js';

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

describe('concat of concat results stays one step from the source events', () => {
  it('10,000 chained concats still hand back the first series’ events', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const;
    const base = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, 1],
        [1000, 2],
      ],
    });
    const empty = new TimeSeries({ name: 's', schema, rows: [] });
    let s = base;
    for (let i = 0; i < 10_000; i += 1) s = TimeSeries.concat([s, empty]);
    // Without flattening each concat adds a link, and eventAt recurses
    // through all of them.
    expect(s.at(0)).toBe(base.at(0));
    expect(s.at(1)).toBe(base.at(1));
    expect(s.toJSON().rows).toEqual(base.toJSON().rows);
  });
});

describe('concat paths the random check covered, pinned', () => {
  it('more than 64 inputs with text, boolean and array columns', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 's', kind: 'string', required: false },
      { name: 'b', kind: 'boolean', required: false },
      { name: 'a', kind: 'array', required: false },
    ] as const;
    // 90 one-row inputs in reverse time order, so every row moves.
    const rows = Array.from({ length: 90 }, (_, i) => {
      const t = (89 - i) * 1000;
      return [
        t,
        i % 7 === 0 ? undefined : `s${i % 3}`,
        i % 5 === 0 ? undefined : i % 2 === 0,
        i % 4 === 0 ? undefined : [`t${i}`, i],
      ] as const;
    });
    const inputs = rows.map(
      (r) => new TimeSeries({ name: 's', schema, rows: [r as never] }),
    );
    const out = TimeSeries.concat(inputs);
    const expected = new TimeSeries({
      name: 's',
      schema,
      rows: [...rows].reverse() as never,
    });
    expect(out.toJSON()).toEqual(expected.toJSON());
    expect(out.at(0)).toBe(inputs[89]!.at(0));
  });

  it('inputs from fromEvents keep their events, NaN included', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'x', kind: 'number', required: false },
    ] as const;
    const a = TimeSeries.fromEvents(
      [
        new Event(new Time(0), { x: NaN }),
        new Event(new Time(2000), { x: 2 }),
      ] as never,
      { name: 's', schema },
    );
    const b = TimeSeries.fromEvents(
      [new Event(new Time(1000), { x: 1 })] as never,
      {
        name: 's',
        schema,
      },
    );
    const out = TimeSeries.concat([a, b]);
    expect(out.at(0)).toBe(a.at(0));
    expect(out.at(1)).toBe(b.at(0));
    expect(out.at(2)).toBe(a.at(1));
    const points = out.toPoints();
    expect(Number.isNaN(points[0]!.x)).toBe(true);
    expect(points.map((p) => p.x).slice(1)).toEqual([1, 2]);
  });
});
