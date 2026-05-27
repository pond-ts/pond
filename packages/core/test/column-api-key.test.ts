/**
 * Runtime tests for Phase 4.7 step 8d — public `at(i)` and
 * `slice(s, e)` on each KeyColumn variant (`TimeKeyColumn`,
 * `TimeRangeKeyColumn`, `IntervalKeyColumn`), plus the
 * schema-narrowed `series.keyColumn()` return type.
 *
 * `at(i)` mirrors `Column.at(i)`'s shape — returns the row's value
 * in the raw columnar idiom (number / `{ begin, end }` /
 * `{ begin, end, label }`), or `undefined` for out-of-range.
 *
 * `slice(s, e)` is a zero-copy index-range view (subarray on the
 * underlying typed arrays; labels-column sliced for intervals).
 *
 * Type tests pinning the return-type narrowing live in
 * `test-d/column-api-methods.test-d.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  Float64Column,
  IntervalKeyColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  stringColumnFromArray,
  timeKeyColumnFromArray,
  timeRangeKeyColumnFromPairs,
} from '../src/columnar/index.js';
import { TimeSeries } from '../src/index.js';
// Side-effect import — installs the at / slice augmentations.
import '../src/column-api.js';

/* -------------------------------------------------------------------------- */
/* TimeKeyColumn                                                              */
/* -------------------------------------------------------------------------- */

describe('TimeKeyColumn.at', () => {
  it('returns the begin timestamp at a valid index', () => {
    const col = timeKeyColumnFromArray([1000, 2000, 3000]);
    expect(col.at(0)).toBe(1000);
    expect(col.at(1)).toBe(2000);
    expect(col.at(2)).toBe(3000);
  });

  it('returns undefined for out-of-range indices', () => {
    const col = timeKeyColumnFromArray([1000, 2000, 3000]);
    expect(col.at(-1)).toBeUndefined();
    expect(col.at(3)).toBeUndefined();
    expect(col.at(100)).toBeUndefined();
  });

  it('returns undefined on an empty column', () => {
    const col = timeKeyColumnFromArray([]);
    expect(col.at(0)).toBeUndefined();
    expect(col.at(-1)).toBeUndefined();
  });

  it('returns a number (not a Time class instance)', () => {
    // The column-API path stays in the substrate idiom — raw
    // numbers, not the row-API's Time wrapper.
    const col = timeKeyColumnFromArray([1500]);
    const v = col.at(0);
    expect(typeof v).toBe('number');
    expect(v).toBe(1500);
  });
});

describe('TimeKeyColumn.slice', () => {
  it('returns a TimeKeyColumn over the index range [s, e)', () => {
    const col = timeKeyColumnFromArray([1000, 2000, 3000, 4000, 5000]);
    const slice = col.slice(1, 4);
    expect(slice).toBeInstanceOf(TimeKeyColumn);
    expect(slice.length).toBe(3);
    expect(slice.at(0)).toBe(2000);
    expect(slice.at(1)).toBe(3000);
    expect(slice.at(2)).toBe(4000);
    expect(slice.at(3)).toBeUndefined();
  });

  it('is zero-copy (shared buffer)', () => {
    const col = timeKeyColumnFromArray([10, 20, 30, 40]);
    const slice = col.slice(1, 3);
    // `subarray` shares the underlying ArrayBuffer.
    expect(slice.begin.buffer).toBe(col.begin.buffer);
  });

  it('clamps start / end to [0, length]', () => {
    const col = timeKeyColumnFromArray([1, 2, 3]);
    expect(col.slice(-5, 100).length).toBe(3);
    expect(col.slice(1, 100).length).toBe(2);
    expect(col.slice(-100, 2).length).toBe(2);
  });

  it('produces an empty column when start >= end', () => {
    const col = timeKeyColumnFromArray([1, 2, 3]);
    expect(col.slice(2, 2).length).toBe(0);
    expect(col.slice(2, 1).length).toBe(0); // end < start collapses
  });

  it('full-range slice equals the source length', () => {
    const col = timeKeyColumnFromArray([100, 200, 300]);
    const full = col.slice(0, col.length);
    expect(full.length).toBe(col.length);
    expect(full.at(0)).toBe(100);
    expect(full.at(2)).toBe(300);
  });
});

/* -------------------------------------------------------------------------- */
/* TimeRangeKeyColumn                                                         */
/* -------------------------------------------------------------------------- */

describe('TimeRangeKeyColumn.at', () => {
  it('returns { begin, end } at a valid index', () => {
    const col = timeRangeKeyColumnFromPairs([
      [1000, 2000],
      [2500, 3500],
    ]);
    expect(col.at(0)).toEqual({ begin: 1000, end: 2000 });
    expect(col.at(1)).toEqual({ begin: 2500, end: 3500 });
  });

  it('returns undefined for out-of-range', () => {
    const col = timeRangeKeyColumnFromPairs([[100, 200]]);
    expect(col.at(-1)).toBeUndefined();
    expect(col.at(1)).toBeUndefined();
  });

  it('preserves begin <= end per row in the returned POJO', () => {
    const col = timeRangeKeyColumnFromPairs([[10, 100]]);
    const row = col.at(0)!;
    expect(row.begin).toBeLessThanOrEqual(row.end);
  });
});

describe('TimeRangeKeyColumn.slice', () => {
  it('returns a TimeRangeKeyColumn over [s, e)', () => {
    const col = timeRangeKeyColumnFromPairs([
      [1000, 1500],
      [2000, 2500],
      [3000, 3500],
      [4000, 4500],
    ]);
    const slice = col.slice(1, 3);
    expect(slice).toBeInstanceOf(TimeRangeKeyColumn);
    expect(slice.length).toBe(2);
    expect(slice.at(0)).toEqual({ begin: 2000, end: 2500 });
    expect(slice.at(1)).toEqual({ begin: 3000, end: 3500 });
  });

  it('is zero-copy on both begin and end buffers', () => {
    const col = timeRangeKeyColumnFromPairs([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    const slice = col.slice(0, 2);
    expect(slice.begin.buffer).toBe(col.begin.buffer);
    expect(slice.end.buffer).toBe(col.end.buffer);
  });

  it('preserves the begin > end-of-slice caveat documented in JSDoc', () => {
    // A long early row can extend past later rows' ends. Slicing
    // does NOT recompute max-end across the slice (that's deferred
    // per RFC §4); it just preserves per-row begin <= end.
    const col = timeRangeKeyColumnFromPairs([
      [0, 1000],
      [100, 200],
      [300, 400],
    ]);
    const slice = col.slice(1, 3);
    // The "real" max end over [1, 3) is 400, NOT 1000 — but the
    // slice doesn't know that the source row 0 also ended at 1000.
    // Slice just trims the buffers.
    expect(slice.at(0)).toEqual({ begin: 100, end: 200 });
    expect(slice.at(1)).toEqual({ begin: 300, end: 400 });
  });
});

/* -------------------------------------------------------------------------- */
/* IntervalKeyColumn — string labels                                          */
/* -------------------------------------------------------------------------- */

describe('IntervalKeyColumn.at — string labels', () => {
  const labels = stringColumnFromArray(['warn', 'error', 'warn']);
  const col = new IntervalKeyColumn(
    new Float64Array([100, 200, 300]),
    new Float64Array([150, 250, 350]),
    labels,
    3,
  );

  it('returns { begin, end, label } with string label', () => {
    expect(col.at(0)).toEqual({ begin: 100, end: 150, label: 'warn' });
    expect(col.at(1)).toEqual({ begin: 200, end: 250, label: 'error' });
    expect(col.at(2)).toEqual({ begin: 300, end: 350, label: 'warn' });
  });

  it('returns undefined for out-of-range', () => {
    expect(col.at(-1)).toBeUndefined();
    expect(col.at(3)).toBeUndefined();
  });
});

describe('IntervalKeyColumn.slice — string labels', () => {
  it('slices begin, end, AND labels in lockstep', () => {
    const labels = stringColumnFromArray(['a', 'b', 'c', 'd']);
    const col = new IntervalKeyColumn(
      new Float64Array([1, 2, 3, 4]),
      new Float64Array([10, 20, 30, 40]),
      labels,
      4,
    );
    const slice = col.slice(1, 3);
    expect(slice).toBeInstanceOf(IntervalKeyColumn);
    expect(slice.length).toBe(2);
    expect(slice.at(0)).toEqual({ begin: 2, end: 20, label: 'b' });
    expect(slice.at(1)).toEqual({ begin: 3, end: 30, label: 'c' });
  });

  it('preserves labelKind on the sliced column', () => {
    const labels = stringColumnFromArray(['x', 'y']);
    const col = new IntervalKeyColumn(
      new Float64Array([1, 2]),
      new Float64Array([10, 20]),
      labels,
      2,
    );
    expect(col.slice(0, 1).labelKind).toBe('string');
  });
});

/* -------------------------------------------------------------------------- */
/* IntervalKeyColumn — numeric labels                                         */
/* -------------------------------------------------------------------------- */

describe('IntervalKeyColumn.at — numeric labels', () => {
  it('returns { begin, end, label } with number label', () => {
    const labels = new Float64Column(new Float64Array([1.5, 2.5, 3.5]), 3);
    const col = new IntervalKeyColumn(
      new Float64Array([100, 200, 300]),
      new Float64Array([150, 250, 350]),
      labels,
      3,
    );
    expect(col.at(0)).toEqual({ begin: 100, end: 150, label: 1.5 });
    expect(col.at(2)).toEqual({ begin: 300, end: 350, label: 3.5 });
  });
});

describe('IntervalKeyColumn.slice — numeric labels', () => {
  it('slices the numeric label column too', () => {
    const labels = new Float64Column(new Float64Array([1.1, 2.2, 3.3, 4.4]), 4);
    const col = new IntervalKeyColumn(
      new Float64Array([1, 2, 3, 4]),
      new Float64Array([10, 20, 30, 40]),
      labels,
      4,
    );
    const slice = col.slice(1, 3);
    expect(slice.length).toBe(2);
    expect(slice.at(0)).toEqual({ begin: 2, end: 20, label: 2.2 });
    expect(slice.at(1)).toEqual({ begin: 3, end: 30, label: 3.3 });
    expect(slice.labelKind).toBe('number');
  });
});

/* -------------------------------------------------------------------------- */
/* Cross-call: series.keyColumn().at / .slice                                 */
/* -------------------------------------------------------------------------- */

describe('series.keyColumn() — column-API access', () => {
  it('time-keyed: .at(i) returns the begin timestamp', () => {
    const s = new TimeSeries({
      name: 't',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [1000, 10],
        [2000, 20],
        [3000, 30],
      ],
    });
    const keys = s.keyColumn();
    expect(keys.at(0)).toBe(1000);
    expect(keys.at(2)).toBe(3000);
    expect(keys.at(3)).toBeUndefined();
  });

  it('time-keyed: .slice(s, e) returns a TimeKeyColumn view', () => {
    const s = new TimeSeries({
      name: 't',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: Array.from({ length: 10 }, (_, i) => [1000 + i * 100, i]),
    });
    const slice = s.keyColumn().slice(2, 5);
    expect(slice).toBeInstanceOf(TimeKeyColumn);
    expect(slice.length).toBe(3);
    expect(slice.at(0)).toBe(1200);
    expect(slice.at(2)).toBe(1400);
  });

  it('time-keyed: chains .slice().at() — exercises hover/tooltip pattern', () => {
    const s = new TimeSeries({
      name: 't',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: Array.from({ length: 100 }, (_, i) => [i * 1000, i]),
    });
    // Mirrors the chart-experiment's NF4 flow:
    //   const time = series.keyColumn().slice(s, e).at(localIdx);
    const window = s.keyColumn().slice(10, 20);
    expect(window.at(0)).toBe(10_000);
    expect(window.at(5)).toBe(15_000);
    expect(window.length).toBe(10);
  });
});
