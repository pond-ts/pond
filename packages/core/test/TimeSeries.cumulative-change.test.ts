/**
 * `cumulative` with `increase` / `decrease` ([PND-SCANDATA]): the running
 * total of rises or falls, optionally ignoring changes under a threshold.
 * The thresholded form is the dead-band climb rule (elevation gain with a
 * 3 m band) written as data, so pond-rs can run it with no callback.
 */
import { describe, expect, it } from 'vitest';
import { LiveSeries, TimeSeries } from '../src/index.js';
import {
  ColumnarStore,
  concatSorted,
  float64ColumnFromArray,
  timeKeyColumnFromArray,
} from '../src/columnar/index.js';
import { cumulativeOp } from '../src/batch/operators/cumulative.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
] as const;

type Row = [number, number | undefined];

function series(values: Array<number | undefined>) {
  return new TimeSeries({
    name: 's',
    schema,
    rows: values.map((v, i): Row => [i * 1000, v]),
  });
}

function cells(s: TimeSeries<any>, name = 'v'): Array<number | undefined> {
  return [...s.column(name).toFloat64Array()].map((v) =>
    Number.isNaN(v) ? undefined : v,
  );
}

/** The dead-band rule as a plain loop: running gain and loss per row. */
function reference(values: Array<number | undefined>, threshold: number) {
  const up: Array<number | undefined> = [];
  const down: Array<number | undefined> = [];
  let ref = NaN;
  let gain = 0;
  let loss = 0;
  for (const v of values) {
    if (v !== undefined) {
      if (Number.isNaN(ref)) ref = v;
      else {
        const d = v - ref;
        if (d >= threshold) {
          gain += d;
          ref = v;
        } else if (d <= -threshold) {
          loss += -d;
          ref = v;
        }
      }
    }
    up.push(Number.isNaN(ref) ? undefined : gain);
    down.push(Number.isNaN(ref) ? undefined : loss);
  }
  return { up, down };
}

describe('cumulative increase / decrease', () => {
  it('totals every rise and every fall with no threshold', () => {
    const s = series([10, 12, 11, 14, 14, 9]);
    expect(cells(s.cumulative({ v: 'increase' }))).toEqual([0, 2, 2, 5, 5, 5]);
    expect(cells(s.cumulative({ v: 'decrease' }))).toEqual([0, 0, 1, 1, 1, 6]);
  });

  it('ignores changes under the threshold, but counts drift that adds up', () => {
    // 100 → 102 (under 3, ignored) → 103.5 (3.5 above 100: counts) →
    // 101 (2.5 down, ignored) → 100 (3.5 down from 103.5: counts).
    const s = series([100, 102, 103.5, 101, 100]);
    const spec = { using: 'increase', threshold: 3 } as const;
    expect(cells(s.cumulative({ v: spec }))).toEqual([0, 0, 3.5, 3.5, 3.5]);
    expect(
      cells(s.cumulative({ v: { using: 'decrease', threshold: 3 } })),
    ).toEqual([0, 0, 0, 0, 3.5]);
  });

  it('counts a change exactly at the threshold', () => {
    const s = series([1, 2, 1]);
    expect(
      cells(s.cumulative({ v: { using: 'increase', threshold: 1 } })),
    ).toEqual([0, 1, 1]);
    expect(
      cells(s.cumulative({ v: { using: 'decrease', threshold: 1 } })),
    ).toEqual([0, 0, 1]);
  });

  it('is missing before the first value and carries over gaps', () => {
    const s = series([undefined, undefined, 5, undefined, 8, undefined, 2]);
    expect(cells(s.cumulative({ v: 'increase' }))).toEqual([
      undefined,
      undefined,
      0,
      0,
      3,
      3,
      3,
    ]);
    const out = s.cumulative({ v: 'decrease' });
    expect(cells(out)).toEqual([undefined, undefined, 0, 0, 0, 0, 6]);
    expect(out.schema[1]).toMatchObject({ kind: 'number', required: false });
  });

  it('matches the plain loop on random data, both directions', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const threshold of [0, 0.5, 3, 10]) {
      let e = 500;
      const values = Array.from({ length: 2000 }, () => {
        e += (rnd() - 0.5) * 4;
        return rnd() < 0.05 ? undefined : e;
      });
      const want = reference(values, threshold);
      const s = series(values);
      const up = s.cumulative({ v: { using: 'increase', threshold } });
      const down = s.cumulative({ v: { using: 'decrease', threshold } });
      // Same operations in the same order, so the same bits.
      cells(up).forEach((v, i) => expect(Object.is(v, want.up[i])).toBe(true));
      cells(down).forEach((v, i) =>
        expect(Object.is(v, want.down[i])).toBe(true),
      );
    }
  });

  it('mixes with the other accumulators in one call', () => {
    const s = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'a', kind: 'number' },
        { name: 'b', kind: 'number' },
      ] as const,
      rows: [
        [0, 1, 1],
        [1000, 3, 2],
        [2000, 2, 3],
      ],
    });
    const out = s.cumulative({ a: 'increase', b: 'sum' });
    expect(cells(out, 'a')).toEqual([0, 2, 2]);
    expect(cells(out, 'b')).toEqual([1, 3, 6]);
  });

  it('works on a chunked column', () => {
    const numStore = (times: number[], values: Array<number | undefined>) =>
      ColumnarStore.fromTrustedStore(
        [
          { name: 'time', kind: 'time' },
          { name: 'v', kind: 'number' },
        ] as const,
        timeKeyColumnFromArray(times),
        new Map([['v', float64ColumnFromArray(values)]]),
      );
    const chunked = concatSorted([
      numStore([1000, 2000], [10, undefined]),
      numStore([3000, 4000], [14, 11]),
    ]);
    expect(chunked.columns.get('v')!.storage).toBe('chunked'); // guard
    const { store } = cumulativeOp(chunked, chunked.schema, {
      v: { using: 'increase', threshold: 3 },
    });
    expect([0, 1, 2, 3].map((i) => store.valueAt(i, 'v'))).toEqual([
      0, 0, 4, 4,
    ]);
  });

  it('runs per partition', () => {
    const s = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
        { name: 'g', kind: 'string' },
      ] as const,
      rows: [
        [0, 10, 'a'],
        [1000, 100, 'b'],
        [2000, 12, 'a'],
        [3000, 90, 'b'],
        [4000, 15, 'a'],
      ],
    });
    const out = s.partitionBy('g').cumulative({ v: 'decrease' }).collect();
    expect(cells(out)).toEqual([0, 0, 0, 10, 0]);
  });

  it('gives the same values live as in batch', () => {
    const values = [5, 7, undefined, 4, 4.5, 9, 1];
    const live = new LiveSeries({ name: 's', schema });
    const view = live.cumulative({
      v: { using: 'increase', threshold: 2 },
    });
    values.forEach((v, i) => live.push([i * 1000, v]));
    const batch = series(values).cumulative({
      v: { using: 'increase', threshold: 2 },
    });
    expect(cells(view.toTimeSeries())).toEqual(cells(batch));
  });

  it('refuses a bad threshold or an unknown direction', () => {
    const s = series([1, 2]);
    expect(() =>
      s.cumulative({ v: { using: 'increase', threshold: -1 } }),
    ).toThrow(/threshold must be a finite number >= 0/);
    expect(() =>
      s.cumulative({ v: { using: 'increase', threshold: Infinity } }),
    ).toThrow(/threshold/);
    expect(() => s.cumulative({ v: { using: 'sideways' } as any })).toThrow(
      /'increase' or 'decrease'/,
    );
    expect(() => s.cumulative({ v: 'nope' as any })).toThrow(
      /unknown accumulator/,
    );
  });
});
