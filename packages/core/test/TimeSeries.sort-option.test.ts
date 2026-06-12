import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* TimeSeries({ sort: true }) — sort unsorted rows on construction.            */
/*                                                                             */
/* Audit v2 §5 F3: pond requires rows in non-decreasing key order and threw    */
/* otherwise, with no opt-in to sort (despite `fromEvents` sorting). `sort`    */
/* closes that for messy-ingest callers; the throw now names the option.       */
/* -------------------------------------------------------------------------- */

const timeSchema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
  { name: 'tag', kind: 'string' },
] as const;

describe('TimeSeries({ sort: true })', () => {
  it('sorts unsorted rows by key on construction', () => {
    const s = new TimeSeries({
      name: 's',
      schema: timeSchema,
      rows: [
        [3000, 30, 'c'],
        [1000, 10, 'a'],
        [2000, 20, 'b'],
      ] as any,
      sort: true,
    });
    expect(Array.from(s.keyColumn().begin)).toEqual([1000, 2000, 3000]);
    expect([0, 1, 2].map((i) => s.at(i)!.get('v'))).toEqual([10, 20, 30]);
  });

  it('throws on unsorted rows by default, naming { sort: true }', () => {
    const make = () =>
      new TimeSeries({
        name: 's',
        schema: timeSchema,
        rows: [
          [3000, 30, 'c'],
          [1000, 10, 'a'],
        ] as any,
      });
    expect(make).toThrow(/out of order/);
    expect(make).toThrow(/sort: true/);
  });

  it('is stable — rows with equal keys keep their input order', () => {
    const s = new TimeSeries({
      name: 's',
      schema: timeSchema,
      rows: [
        [1000, 1, 'first'],
        [1000, 2, 'second'],
        [500, 0, 'early'],
      ] as any,
      sort: true,
    });
    expect(Array.from(s.keyColumn().begin)).toEqual([500, 1000, 1000]);
    // the two equal-key rows stay in input order (first before second)
    expect([s.at(1)!.get('tag'), s.at(2)!.get('tag')]).toEqual([
      'first',
      'second',
    ]);
  });

  it('does not mutate the caller rows array', () => {
    const rows: any[] = [
      [3000, 30, 'c'],
      [1000, 10, 'a'],
    ];
    const before = rows.map((r) => [...r]);
    new TimeSeries({ name: 's', schema: timeSchema, rows, sort: true });
    expect(rows).toEqual(before);
  });

  it('sorts timeRange-keyed rows by begin', () => {
    const rangeSchema = [
      { name: 'span', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const;
    const s = new TimeSeries({
      name: 'r',
      schema: rangeSchema,
      rows: [
        [[2000, 2100], 20],
        [[0, 100], 10],
        [[1000, 1100], 15],
      ] as any,
      sort: true,
    });
    expect(Array.from(s.keyColumn().begin)).toEqual([0, 1000, 2000]);
  });

  it('leaves already-sorted rows unchanged', () => {
    const rows: any = [
      [1000, 10, 'a'],
      [2000, 20, 'b'],
    ];
    const a = new TimeSeries({
      name: 's',
      schema: timeSchema,
      rows,
      sort: true,
    });
    const b = new TimeSeries({ name: 's', schema: timeSchema, rows });
    expect(Array.from(a.keyColumn().begin)).toEqual(
      Array.from(b.keyColumn().begin),
    );
  });
});
