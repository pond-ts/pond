/**
 * Column-native `smooth` (movingAverage / loess), `baseline` and `outliers`
 * ([PND-SMOOTHSLOW]). The results are checked against hand-built answers,
 * plus the cases that keep the old event path (a non-number or unknown
 * target column, whose results are [PND-SMOOTHCHECK]).
 */
import { describe, expect, it } from 'vitest';
import { Event, Time, TimeSeries } from '../src/index.js';

const schema = [
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'v', kind: 'number', required: false },
  { name: 'tag', kind: 'string', required: false },
] as const;

// A long range before short ones: midpoints run backwards.
const ranged = new TimeSeries({
  name: 's',
  schema,
  rows: [
    [[0, 100], 10, 'a'],
    [[10, 12], 2, 'b'],
    [[20, 21], undefined, 'c'],
    [[30, 34], 6, 'd'],
  ],
});

describe('smooth on columns', () => {
  it('anchors range keys at their midpoints', () => {
    // Midpoints 50, 11, 20.5, 32 → order 11, 20.5, 32, 50.
    const out = ranged.smooth('v', 'movingAverage', { window: 15 });
    expect(out.toArray().map((e) => e.get('v'))).toEqual([
      // 50: window (35, 50] holds only itself.
      10,
      // 11: (−4, 11] → 2.
      2,
      // 20.5: (5.5, 20.5] → 2 (its own cell is missing, bridged).
      2,
      // 32: (17, 32] → 6.
      6,
    ]);
    expect(out.toArray().map((e) => e.get('tag'))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    const skip = ranged.smooth('v', 'movingAverage', {
      window: 15,
      missing: 'skip',
      output: 'avg',
    });
    expect(skip.toArray().map((e) => [e.get('v'), e.get('avg')])).toEqual([
      [10, 10],
      [2, 2],
      [undefined, undefined],
      [6, 6],
    ]);
  });

  it('keeps the event path for a text or unknown target', () => {
    const text = ranged.smooth('tag' as never, 'movingAverage', {
      window: 15,
    });
    expect(text.schema[2]).toEqual({
      name: 'tag',
      kind: 'number',
      required: false,
    });
    expect(text.toArray().map((e) => e.get('tag' as never))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const unknown = ranged.smooth('nope' as never, 'movingAverage', {
      window: 15,
    });
    expect(unknown.toArray().map((e) => e.get('v'))).toEqual([
      10,
      2,
      undefined,
      6,
    ]);
  });
});

describe('baseline and outliers on columns', () => {
  const flat = new TimeSeries({
    name: 's',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number', required: false },
    ] as const,
    rows: [
      [0, 5],
      [1, 5],
      [2, 9],
      [3, undefined],
      [4, 1],
    ],
  });

  it('gives no bands on a flat window and computes them elsewhere', () => {
    const out = flat.baseline('v', { window: 3, sigma: 1 });
    const rows = out
      .toArray()
      .map((e) => [e.get('avg'), e.get('sd'), e.get('upper'), e.get('lower')]);
    expect(rows[0]).toEqual([5, 0, undefined, undefined]);
    expect(rows[1]).toEqual([5, 0, undefined, undefined]);
    const [avg, sd, upper, lower] = rows[2] as number[];
    expect(upper).toBe(avg + sd);
    expect(lower).toBe(avg - sd);
  });

  it('outliers keeps already-built events as the same objects', () => {
    const all = flat.events;
    const out = flat.outliers('v', { window: 3, sigma: 0.5 });
    expect(out.length).toBeGreaterThan(0);
    out.events.forEach((e) => expect(all).toContain(e));
  });
});

describe('smooth / baseline keep the row path where columns and events can differ', () => {
  // `fromEvents` keeps the given events, which may hold a value the column
  // stores as a gap (NaN) or a value row intake would refuse (a string in a
  // number column). Output and errors must stay what the row path gave.
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'x', kind: 'number', required: false },
  ] as const;
  const fromEvents = (values: unknown[]) =>
    TimeSeries.fromEvents(
      values.map((x, i) => new Event(new Time(i * 1000), { x })) as never,
      { name: 'c', schema },
    );

  it('loess over an event holding NaN gives all gaps, as before', () => {
    const out = fromEvents([1, NaN, 3, 4]).smooth('x', 'loess', { span: 1 });
    expect(out.toJSON().rows).toEqual([
      [0, null],
      [1000, null],
      [2000, null],
      [3000, null],
    ]);
  });

  it('movingAverage skip reads the event value, as before', () => {
    const out = fromEvents([1, NaN, 3, 4]).smooth('x', 'movingAverage', {
      window: '2s',
      missing: 'skip',
    });
    expect(out.toJSON().rows).toEqual([
      [0, 1],
      [1000, 1],
      [2000, 3],
      [3000, 3.5],
    ]);
  });

  it('a string in a number column still fails validation', () => {
    const s = fromEvents([1, 'a', 3, 4]);
    expect(() =>
      s.smooth('x', 'movingAverage', { window: '2s', output: 'y' }),
    ).toThrow('row 1 col 1: expected finite number');
    expect(() => s.baseline('x', { window: '2s', sigma: 2 })).toThrow(
      'row 1 col 1: expected finite number',
    );
  });

  it('an output named like the key column keeps the intake error', () => {
    const s = new TimeSeries({
      name: 'c',
      schema,
      rows: [
        [0, 1],
        [1000, 2],
      ],
    });
    expect(() =>
      s.smooth('x', 'movingAverage', { window: '2s', output: 'time' as never }),
    ).toThrow("ColumnarStore: duplicate schema column name 'time'");
  });
});
