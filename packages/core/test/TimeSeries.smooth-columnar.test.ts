/**
 * Column-native `smooth` (movingAverage / loess), `baseline` and `outliers`
 * ([PND-SMOOTHSLOW]). The results are checked against hand-built answers,
 * plus the cases that keep the old event path (a non-number or unknown
 * target column, whose results are [PND-SMOOTHCHECK]).
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

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
